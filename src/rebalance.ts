import crypto from "node:crypto";
import type { Bucket, Config } from "./config.ts";
import type { Holding } from "./holdings.ts";
import type { Portfolio } from "./portfolio.ts";
import { jupiterQuote, SOL_MINT, USDC_MINT } from "./solana.ts";

export const BUCKETS: Bucket[] = ["equities", "crypto", "cash"];

export interface Drift {
  bucket: Bucket;
  currentUsd: number;
  currentPct: number;
  targetPct: number;
  targetUsd: number;
  driftPts: number; // current% - target%
  diffUsd: number; // target$ - current$ (positive = buy more)
}

export function computeDrift(p: Portfolio, cfg: Config) {
  const drift: Drift[] = BUCKETS.map((b) => {
    const currentPct = p.totalUsd ? (p.totals[b] / p.totalUsd) * 100 : 0;
    const targetUsd = (p.totalUsd * cfg.targets[b]) / 100;
    return {
      bucket: b,
      currentUsd: p.totals[b],
      currentPct,
      targetPct: cfg.targets[b],
      targetUsd,
      driftPts: currentPct - cfg.targets[b],
      diffUsd: targetUsd - p.totals[b],
    };
  });
  const maxDrift = Math.max(...drift.map((d) => Math.abs(d.driftPts)));
  return { drift, maxDrift, needsRebalance: p.totalUsd > 0 && maxDrift > cfg.tolerancePct };
}

/** How a leg gets done. Only "alpaca" legs are executed by this server. */
export type LegMode = "alpaca" | "wallet-sign" | "manual";

export interface Leg {
  id: number;
  mode: LegMode;
  venue: string;
  side: "buy" | "sell" | "swap" | "transfer";
  from: string;
  to: string;
  usd: number;
  detail: string;
  blocked?: string;
  quote?: { outAmount: string; priceImpactPct: string; route: string };
}

export interface Plan {
  id: string;
  createdAt: number;
  demo: boolean;
  totalUsd: number;
  drift: Drift[];
  legs: Leg[];
  notes: string[];
}

const plans = new Map<string, Plan>();
export const PLAN_TTL_MS = 15 * 60_000;
export const getPlan = (id: string) => plans.get(id);

/** Split `total` across holdings in proportion to their size. */
function proRata(items: Holding[], total: number) {
  const sum = items.reduce((s, h) => s + h.usd, 0);
  return items.map((h) => ({ h, usd: sum ? (total * h.usd) / sum : 0 }));
}

export async function buildPlan(p: Portfolio, cfg: Config): Promise<Plan> {
  const { drift, needsRebalance } = computeDrift(p, cfg);
  const legs: Leg[] = [];
  const notes: string[] = [];
  const min = cfg.limits.minLegUsd;
  const add = (l: Omit<Leg, "id">) => {
    if (l.usd < min) return;
    // Broker orders above the per-order cap are split into equal slices under the cap.
    const slices = l.mode === "alpaca" ? Math.ceil(l.usd / cfg.limits.maxOrderUsd) : 1;
    for (let i = 0; i < slices; i++) {
      const part = Math.round((l.usd / slices) * 100) / 100;
      const detail = slices > 1 ? `${l.detail.replace(/\$[\d.]+/, `$${part.toFixed(2)}`)} (slice ${i + 1}/${slices})` : l.detail;
      legs.push({ ...l, detail, id: legs.length + 1, usd: part });
    }
  };

  if (!needsRebalance) {
    notes.push(`Every bucket is within ±${cfg.tolerancePct} pts of target. Nothing to do.`);
  } else {
    const d = Object.fromEntries(drift.map((x) => [x.bucket, x.diffUsd])) as Record<Bucket, number>;
    const brokerEquities = p.holdings.filter((h) => h.venue === "alpaca" && h.bucket === "equities");
    let brokerCash = p.holdings.filter((h) => h.venue === "alpaca" && h.bucket === "cash").reduce((s, h) => s + h.usd, 0);

    // 1. Equities
    if (d.equities < 0) {
      for (const { h, usd } of proRata(brokerEquities, -d.equities))
        add({ mode: "alpaca", venue: "alpaca", side: "sell", from: h.symbol, to: "USD", usd, detail: `Sell $${usd.toFixed(2)} of ${h.symbol} (pro-rata to position size)` });
      brokerCash += -d.equities;
    } else if (d.equities > 0) {
      const buy = Math.min(d.equities, brokerCash);
      const targets = brokerEquities.length ? brokerEquities : [];
      if (buy >= min) {
        if (targets.length)
          for (const { h, usd } of proRata(targets, buy))
            add({ mode: "alpaca", venue: "alpaca", side: "buy", from: "USD", to: h.symbol, usd, detail: `Buy $${usd.toFixed(2)} of ${h.symbol}` });
        else add({ mode: "alpaca", venue: "alpaca", side: "buy", from: "USD", to: cfg.equityDefaultBuy, usd: buy, detail: `Buy $${buy.toFixed(2)} of ${cfg.equityDefaultBuy} (default)` });
        brokerCash -= buy;
      }
      const gap = d.equities - buy;
      if (gap >= min)
        add({ mode: "manual", venue: "bank → alpaca", side: "transfer", from: "stablecoins/bank", to: "Alpaca USD", usd: gap, detail: `Not enough broker cash. Move $${gap.toFixed(2)} into Alpaca (off-ramp stablecoins → bank → broker), then buy stocks.` });
    }

    // 2. Crypto
    const onchain = (bucket: Bucket) => p.holdings.filter((h) => h.venue !== "alpaca" && h.bucket === bucket);
    if (d.crypto < 0) {
      let left = -d.crypto;
      for (const h of onchain("crypto")) {
        if (left < min) break;
        const usd = Math.min(left, h.usd);
        left -= usd;
        if (h.venue === "solana" && h.meta?.mint) {
          const raw = BigInt(Math.floor((usd / h.usd) * h.amount * 10 ** Number(h.meta.decimals)));
          add({ mode: "wallet-sign", venue: "solana", side: "swap", from: h.symbol, to: "USDC", usd, detail: `Swap ~$${usd.toFixed(2)} of ${h.symbol} → USDC on Jupiter`, quote: await quote(String(h.meta.mint), USDC_MINT, raw) });
        } else {
          add({ mode: "manual", venue: h.venue, side: "swap", from: h.symbol, to: "USDC", usd, detail: `Swap ~$${usd.toFixed(2)} of ${h.symbol} → USDC on ${h.venue} (e.g. LI.FI / Uniswap) from your wallet` });
        }
      }
      for (const h of p.holdings.filter((x) => x.venue === "alpaca" && x.bucket === "crypto")) {
        if (left < min) break;
        const usd = Math.min(left, h.usd);
        left -= usd;
        add({ mode: "alpaca", venue: "alpaca", side: "sell", from: h.symbol, to: "USD", usd, detail: `Sell $${usd.toFixed(2)} of ${h.symbol} on Alpaca` });
      }
    } else if (d.crypto > 0) {
      let left = d.crypto;
      for (const h of onchain("cash")) {
        if (left < min) break;
        const usd = Math.min(left, h.usd);
        left -= usd;
        if (h.venue === "solana" && h.meta?.mint) {
          const raw = BigInt(Math.floor((usd / Math.max(h.usd, 1e-9)) * h.amount * 10 ** Number(h.meta.decimals)));
          add({ mode: "wallet-sign", venue: "solana", side: "swap", from: h.symbol, to: "SOL", usd, detail: `Swap $${usd.toFixed(2)} ${h.symbol} → SOL on Jupiter`, quote: await quote(String(h.meta.mint), SOL_MINT, raw) });
        } else {
          add({ mode: "manual", venue: h.venue, side: "swap", from: h.symbol, to: "ETH", usd, detail: `Swap $${usd.toFixed(2)} ${h.symbol} → native coin on ${h.venue} from your wallet` });
        }
      }
      if (left >= min)
        add({ mode: "manual", venue: "alpaca → wallet", side: "transfer", from: "Alpaca USD", to: "USDC on-chain", usd: left, detail: `Not enough stablecoins on-chain. Withdraw $${left.toFixed(2)} from the broker and on-ramp to USDC, then buy crypto.` });
    }
    notes.push("Cash is the balancing bucket: it ends near target once the equity and crypto legs are done.");
    if (legs.some((l) => l.mode === "manual")) notes.push("Manual legs cross between the broker and the blockchain. No API can move money there for you; do them yourself.");
  }

  const plan: Plan = { id: crypto.randomUUID().slice(0, 8), createdAt: Date.now(), demo: p.demo, totalUsd: p.totalUsd, drift, legs, notes };
  plans.set(plan.id, plan);
  return plan;
}

async function quote(inMint: string, outMint: string, raw: bigint): Promise<Leg["quote"]> {
  if (raw <= 0n) return undefined;
  try {
    const q = await jupiterQuote(inMint, outMint, raw);
    return { outAmount: q.outAmount, priceImpactPct: q.priceImpactPct, route: q.routePlan.map((r) => r.swapInfo.label).join(" → ") };
  } catch {
    return undefined;
  }
}
