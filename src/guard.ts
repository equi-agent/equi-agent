import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.ts";

/** Persistent record of how many dollars this server has traded per UTC day (daily cap). */
const LEDGER = path.join(STATE_DIR, "ledger.json");
const today = () => new Date().toISOString().slice(0, 10);

function read(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(LEDGER, "utf8"));
  } catch {
    return {};
  }
}

export const spentToday = () => read()[today()] || 0;

export function recordSpend(usd: number) {
  const l = read();
  l[today()] = (l[today()] || 0) + usd;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
}
