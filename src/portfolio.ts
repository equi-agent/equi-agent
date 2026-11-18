import type { Bucket, Config } from "./config.ts";
import type { Holding } from "./holdings.ts";
import { alpacaConfigured, alpacaHoldings } from "./alpaca.ts";
import { solanaHoldings } from "./solana.ts";
import { evmHoldings } from "./evm.ts";

export interface Portfolio {
  holdings: Holding[];
  totals: Record<Bucket, number>;
  totalUsd: number;
  warnings: string[];
  demo: boolean;
}

/** Sample book used in demo mode: a stock-heavy investor with a little crypto. */
function demoHoldings(): Holding[] {
  return [
    { venue: "alpaca", account: "demo", symbol: "NVDA", amount: 34, usd: 6200, bucket: "equities", meta: { price: 182.35 } },
    { venue: "alpaca", account: "demo", symbol: "SPY", amount: 4.6, usd: 3100, bucket: "equities", meta: { price: 673.9 } },
    { venue: "alpaca", account: "demo", symbol: "USD", amount: 700, usd: 700, bucket: "cash" },
    { venue: "solana", account: "demo-wallet", symbol: "SOL", amount: 14, usd: 2100, bucket: "crypto", meta: { mint: "So11111111111111111111111111111111111111112", decimals: 9 } },
    { venue: "solana", account: "demo-wallet", symbol: "USDC", amount: 400, usd: 400, bucket: "cash", meta: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 } },
    { venue: "base", account: "demo-wallet", symbol: "ETH", amount: 0.4, usd: 1500, bucket: "crypto" },
  ];
}

export async function loadPortfolio(cfg: Config): Promise<Portfolio> {
  const warnings: string[] = [];
  let holdings: Holding[] = [];

  if (cfg.demo) {
    holdings = demoHoldings();
    warnings.push("DEMO MODE: sample holdings, no real account was read. Set \"demo\": false in config.json to use your accounts.");
  } else {
    const jobs: Promise<void>[] = [];
    if (alpacaConfigured()) {
      jobs.push(alpacaHoldings().then((h) => { holdings.push(...h); }).catch((e) => { warnings.push(`Alpaca: ${e.message}`); }));
    } else {
      warnings.push("Alpaca not configured (ALPACA_KEY_ID / ALPACA_SECRET_KEY): US stocks are missing from this view.");
    }
    for (const w of cfg.solana.wallets) {
      jobs.push(
        solanaHoldings(cfg.solana.rpc, w, cfg.stablecoins)
          .then(({ holdings: h, unpriced }) => {
            holdings.push(...h);
            if (unpriced.length) warnings.push(`Solana ${w.slice(0, 4)}…: ${unpriced.length} token(s) without a USD price were left out.`);
          })
          .catch((e) => { warnings.push(`Solana ${w}: ${e.message}`); }),
      );
    }
    for (const w of cfg.evm.wallets)
      for (const [name, chain] of Object.entries(cfg.evm.chains))
        jobs.push(evmHoldings(name, chain, w, cfg.stablecoins).then((h) => { holdings.push(...h); }).catch((e) => { warnings.push(`${name} ${w}: ${e.message}`); }));
    await Promise.all(jobs);
    if (!cfg.solana.wallets.length && !cfg.evm.wallets.length) warnings.push("No wallets configured: add addresses under solana.wallets / evm.wallets.");
  }

  holdings = holdings.filter((h) => h.usd >= 0.01).sort((a, b) => b.usd - a.usd);
  const totals: Record<Bucket, number> = { equities: 0, crypto: 0, cash: 0 };
  for (const h of holdings) totals[h.bucket] += h.usd;
  return { holdings, totals, totalUsd: totals.equities + totals.crypto + totals.cash, warnings, demo: cfg.demo };
}
