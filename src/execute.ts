import { alpacaConfigured, placeNotionalOrder } from "./alpaca.ts";
import { loadConfig } from "./config.ts";
import { recordSpend, spentToday } from "./guard.ts";
import { usd } from "./holdings.ts";
import { getPlan, PLAN_TTL_MS } from "./rebalance.ts";

export interface ExecuteResult {
  ok: boolean;
  error?: string;
  demo?: boolean;
  /** One line per broker leg that was placed, simulated or failed. */
  results: string[];
  /** Legs the user still has to do (wallet-sign, manual, blocked). */
  pending: string[];
}

/**
 * Place the Alpaca (paper) legs of a plan. Shared by the MCP tool and the web app, so both enforce the
 * same rules: known plan, not expired, daily cap, keys present. Callers must check the user typed "EXECUTE".
 */
export async function executePlan(planId: string): Promise<ExecuteResult> {
  const fail = (error: string): ExecuteResult => ({ ok: false, error, results: [], pending: [] });
  const plan = getPlan(planId);
  if (!plan) return fail(`Unknown plan "${planId}". Run plan_rebalance again.`);
  if (Date.now() - plan.createdAt > PLAN_TTL_MS) return fail("This plan expired (prices move). Run plan_rebalance again.");

  const cfg = loadConfig();
  const autoLegs = plan.legs
    .filter((l) => l.mode === "alpaca" && !l.blocked)
    .sort((a, b) => (a.side === "sell" ? -1 : 1) - (b.side === "sell" ? -1 : 1));
  const total = autoLegs.reduce((s, l) => s + l.usd, 0);
  const room = cfg.limits.maxDailyUsd - spentToday();
  if (total > room)
    return fail(`Daily cap: this plan trades ${usd(total)} but only ${usd(Math.max(room, 0))} is left today (maxDailyUsd ${usd(cfg.limits.maxDailyUsd)}).`);
  if (!plan.demo && autoLegs.length && !alpacaConfigured()) return fail("Alpaca keys are not set, so broker legs cannot be placed.");

  const results: string[] = [];
  for (const l of autoLegs) {
    const symbol = l.side === "sell" ? l.from : l.to;
    if (plan.demo) {
      results.push(`#${l.id} SIMULATED ${l.side} ${usd(l.usd)} ${symbol}`);
      continue;
    }
    try {
      const o = await placeNotionalOrder(symbol, l.side as "buy" | "sell", l.usd, `rebal-${plan.id}-${l.id}`);
      recordSpend(l.usd);
      results.push(`#${l.id} ${o.side} ${usd(Number(o.notional))} ${o.symbol} → order ${o.id.slice(0, 8)} (${o.status})`);
    } catch (e) {
      results.push(`#${l.id} FAILED ${l.side} ${symbol}: ${(e as Error).message}`);
    }
  }
  const pending = plan.legs
    .filter((l) => l.mode !== "alpaca" || l.blocked)
    .map((l) => `#${l.id} ${l.detail}${l.blocked ? ` (blocked: ${l.blocked})` : ""}`);
  return { ok: true, demo: plan.demo, results, pending };
}
