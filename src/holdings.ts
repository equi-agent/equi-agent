import type { Bucket } from "./config.ts";

/** One line of the unified portfolio. */
export interface Holding {
  venue: string; // "alpaca", "solana", "base", ...
  account: string; // wallet address or "paper"
  symbol: string;
  amount: number;
  usd: number;
  bucket: Bucket;
  /** Extra data a planner needs to trade this holding (mint, decimals, ...). */
  meta?: Record<string, string | number>;
}

export const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
export const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
