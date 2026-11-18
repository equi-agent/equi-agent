import { getJson, rpc } from "./http.ts";
import { getPrices } from "./prices.ts";
import type { Holding } from "./holdings.ts";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

interface ParsedTokenAccount {
  account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number; decimals: number } } } } };
}

/** SOL plus every SPL / Token-2022 balance that has a USD price. Unpriced tokens are reported, not valued. */
export async function solanaHoldings(rpcUrl: string, wallet: string, stablecoins: string[]) {
  const [lamports, ...tokenLists] = await Promise.all([
    rpc<{ value: number }>(rpcUrl, "getBalance", [wallet]),
    ...TOKEN_PROGRAMS.map((programId) =>
      rpc<{ value: ParsedTokenAccount[] }>(rpcUrl, "getTokenAccountsByOwner", [wallet, { programId }, { encoding: "jsonParsed" }]),
    ),
  ]);

  const balances = new Map<string, { amount: number; decimals: number }>();
  for (const list of tokenLists)
    for (const a of list.value) {
      const { mint, tokenAmount } = a.account.data.parsed.info;
      if (!tokenAmount.uiAmount) continue;
      const prev = balances.get(mint);
      balances.set(mint, { amount: (prev?.amount || 0) + tokenAmount.uiAmount, decimals: tokenAmount.decimals });
    }

  const prices = await getPrices(["coingecko:solana", ...[...balances.keys()].map((m) => `solana:${m}`)]);
  const holdings: Holding[] = [];
  const unpriced: string[] = [];

  const sol = lamports.value / 1e9;
  if (sol > 0) {
    holdings.push({
      venue: "solana", account: wallet, symbol: "SOL", amount: sol,
      usd: sol * (prices["coingecko:solana"]?.price || 0), bucket: "crypto",
      meta: { mint: SOL_MINT, decimals: 9 },
    });
  }
  for (const [mint, b] of balances) {
    const p = prices[`solana:${mint}`];
    if (!p) { unpriced.push(mint); continue; }
    const symbol = (p.symbol || mint.slice(0, 6)).toUpperCase();
    holdings.push({
      venue: "solana", account: wallet, symbol, amount: b.amount, usd: b.amount * p.price,
      bucket: stablecoins.includes(symbol) ? "cash" : "crypto",
      meta: { mint, decimals: b.decimals },
    });
  }
  return { holdings, unpriced };
}

export interface JupQuote { inAmount: string; outAmount: string; priceImpactPct: string; routePlan: { swapInfo: { label: string } }[] }

/** Read-only Jupiter quote. Nothing is signed or sent. */
export async function jupiterQuote(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps = 50): Promise<JupQuote> {
  const q = new URLSearchParams({ inputMint, outputMint, amount: amountRaw.toString(), slippageBps: String(slippageBps) });
  return getJson<JupQuote>(`https://lite-api.jup.ag/swap/v1/quote?${q}`);
}
