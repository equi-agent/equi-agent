import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package root (holds config.example.json). Works from src/ (dev) and dist/ (published). */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Where your settings live. Outside the package, so npx/npm updates never touch them. */
export const HOME_DIR = process.env.REBALANCER_HOME || path.join(os.homedir(), ".omni-rebalancer");
const CONFIG_PATH = process.env.REBALANCER_CONFIG || path.join(HOME_DIR, "config.json");
const EXAMPLE_PATH = path.join(PKG_ROOT, "config.example.json");
export const STATE_DIR = path.join(HOME_DIR, "state");

export type Bucket = "equities" | "crypto" | "cash";

export interface EvmToken { symbol: string; address: string; decimals: number; stable?: boolean }
export interface EvmChain { rpc: string; nativeSymbol: string; nativePriceId: string; tokens: EvmToken[] }

export interface Config {
  /** Target weight per bucket, in percent. Must add up to 100. */
  targets: Record<Bucket, number>;
  /** Rebalance only when a bucket drifts more than this many percentage points. */
  tolerancePct: number;
  /** Symbol bought when equities are underweight and you hold no stocks yet. */
  equityDefaultBuy: string;
  stablecoins: string[];
  solana: { rpc: string; wallets: string[] };
  evm: { wallets: string[]; chains: Record<string, EvmChain> };
  limits: { maxOrderUsd: number; maxDailyUsd: number; minLegUsd: number };
  /** Use sample holdings instead of real accounts, to try the flow safely. */
  demo: boolean;
}

export const configPath = () => CONFIG_PATH;

/** Your config if it exists, otherwise the bundled example (demo mode). */
export function loadConfig(): Config {
  const file = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_PATH;
  const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as Config;
  if (process.env.REBALANCER_DEMO === "1") cfg.demo = true;
  return cfg;
}

export function saveConfig(cfg: Config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

/** Creates ~/.omni-rebalancer/config.json from the example if it is missing. Returns its path. */
export function ensureConfigFile(): string {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
  }
  return CONFIG_PATH;
}

/** Load KEY=value lines from a .env file without overriding variables that are already set. */
export function loadEnvFile(file: string) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* no file */
  }
}

export function validateTargets(t: Record<string, number>): string | null {
  const keys: Bucket[] = ["equities", "crypto", "cash"];
  for (const k of keys) if (typeof t[k] !== "number" || t[k] < 0) return `Target for "${k}" must be a number >= 0`;
  const sum = keys.reduce((s, k) => s + t[k], 0);
  if (Math.abs(sum - 100) > 0.01) return `Targets must add up to 100 (got ${sum})`;
  return null;
}
