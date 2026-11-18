import { rpc } from "./http.ts";
import { getPrices } from "./prices.ts";
import type { EvmChain } from "./config.ts";
import type { Holding } from "./holdings.ts";

const balanceOfData = (owner: string) => "0x70a08231" + owner.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** Native coin + configured ERC-20s on one EVM chain. */
export async function evmHoldings(chainName: string, chain: EvmChain, wallet: string, stablecoins: string[]): Promise<Holding[]> {
  const [nativeHex, ...tokenHex] = await Promise.all([
    rpc<string>(chain.rpc, "eth_getBalance", [wallet, "latest"]),
    ...chain.tokens.map((t) => rpc<string>(chain.rpc, "eth_call", [{ to: t.address, data: balanceOfData(wallet) }, "latest"])),
  ]);
  const prices = await getPrices([chain.nativePriceId, ...chain.tokens.map((t) => `${chainName}:${t.address}`)]);

  const out: Holding[] = [];
  const native = Number(BigInt(nativeHex)) / 1e18;
  if (native > 0) {
    out.push({
      venue: chainName, account: wallet, symbol: chain.nativeSymbol, amount: native,
      usd: native * (prices[chain.nativePriceId]?.price || 0), bucket: "crypto",
    });
  }
  chain.tokens.forEach((t, i) => {
    const raw = tokenHex[i] && tokenHex[i] !== "0x" ? BigInt(tokenHex[i]) : 0n;
    if (raw === 0n) return;
    const amount = Number(raw) / 10 ** t.decimals;
    const price = prices[`${chainName}:${t.address}`]?.price ?? (t.stable ? 1 : 0);
    out.push({
      venue: chainName, account: wallet, symbol: t.symbol, amount, usd: amount * price,
      bucket: t.stable || stablecoins.includes(t.symbol) ? "cash" : "crypto",
      meta: { address: t.address, decimals: t.decimals },
    });
  });
  return out;
}
