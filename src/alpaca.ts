import { getJson } from "./http.ts";
import type { Holding } from "./holdings.ts";

/**
 * Alpaca broker, paper trading only. The live endpoint is deliberately not supported in this MVP:
 * every order here moves simulated money.
 */
const BASE = "https://paper-api.alpaca.markets";

export const alpacaConfigured = () => Boolean(process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY);

function headers() {
  return {
    "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID || "",
    "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY || "",
    "content-type": "application/json",
  };
}

interface Account { cash: string; equity: string; buying_power: string; status: string; trading_blocked: boolean }
interface Position { symbol: string; qty: string; market_value: string; asset_class: string; current_price: string }

export async function alpacaHoldings(): Promise<Holding[]> {
  const [acct, positions] = await Promise.all([
    getJson<Account>(`${BASE}/v2/account`, { headers: headers() }),
    getJson<Position[]>(`${BASE}/v2/positions`, { headers: headers() }),
  ]);
  const out: Holding[] = positions.map((p) => ({
    venue: "alpaca",
    account: "paper",
    symbol: p.symbol,
    amount: Number(p.qty),
    usd: Number(p.market_value),
    bucket: p.asset_class === "crypto" ? "crypto" : "equities",
    meta: { price: Number(p.current_price), assetClass: p.asset_class },
  }));
  out.push({ venue: "alpaca", account: "paper", symbol: "USD", amount: Number(acct.cash), usd: Number(acct.cash), bucket: "cash" });
  return out;
}

export interface PlacedOrder { id: string; symbol: string; side: string; notional: string; status: string }

/** Market order sized in dollars (fractional shares). */
export async function placeNotionalOrder(symbol: string, side: "buy" | "sell", notionalUsd: number, clientOrderId: string): Promise<PlacedOrder> {
  return getJson<PlacedOrder>(`${BASE}/v2/orders`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      symbol,
      side,
      type: "market",
      time_in_force: "day",
      notional: notionalUsd.toFixed(2),
      client_order_id: clientOrderId,
    }),
  });
}

export async function marketClock(): Promise<{ is_open: boolean; next_open: string }> {
  return getJson(`${BASE}/v2/clock`, { headers: headers() });
}
