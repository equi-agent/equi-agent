/**
 * equi-agent: one MCP server that sees US stocks (Alpaca, paper trading) and on-chain crypto
 * (Solana + EVM wallets) as a single portfolio, measures drift from your target allocation, plans the
 * trades to get back on target, and executes only after you confirm.
 *
 * Safety model:
 *  - never holds private keys; on-chain legs are quotes for you to sign in your own wallet
 *  - broker legs go to Alpaca PAPER only (simulated money)
 *  - two-step flow: plan_rebalance -> execute_rebalance(plan_id, confirm: "EXECUTE")
 *  - per-order and per-day dollar caps from config.json
 *
 * Usage:
 *   npx -y equi-agent          start the MCP server on stdio (what Claude runs)
 *   npx -y equi-agent init     create ~/.equi/config.json to edit
 *   npx -y equi-agent web      open the web app (dashboard + terminal) on http://127.0.0.1:5540
 */
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { configPath, ensureConfigFile, HOME_DIR, loadConfig, loadEnvFile, saveConfig, validateTargets } from "./config.ts";
import { loadPortfolio } from "./portfolio.ts";
import { BUCKETS, buildPlan, computeDrift, type Plan } from "./rebalance.ts";
import { alpacaConfigured } from "./alpaca.ts";
import { spentToday } from "./guard.ts";
import { executePlan } from "./execute.ts";
import { short, usd } from "./holdings.ts";

const VERSION = "0.1.0";

// Keys can come from the environment, ~/.equi/.env, or a .env in the current folder.
loadEnvFile(path.join(HOME_DIR, ".env"));
loadEnvFile(path.join(process.cwd(), ".env"));

const cmd = process.argv[2];
if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
  process.exit(0);
}
if (cmd === "--help" || cmd === "-h") {
  console.log(`equi-agent ${VERSION}

  npx -y equi-agent          start the MCP server (stdio)
  npx -y equi-agent init     create ${configPath()}
  npx -y equi-agent web      web app on http://127.0.0.1:5540 (--port N, --host H)

Add to Claude Code:
  claude mcp add equi -- npx -y equi-agent

Alpaca paper keys: set ALPACA_KEY_ID / ALPACA_SECRET_KEY, or put them in ${path.join(HOME_DIR, ".env")}`);
  process.exit(0);
}
if (cmd === "web") {
  const { startWeb } = await import("./web.ts");
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  await startWeb({
    port: Number(arg("port") || process.env.PORT || 5540),
    host: arg("host") || process.env.HOST || "127.0.0.1",
    version: VERSION,
  });
} else if (cmd === "init") {
  const existed = fs.existsSync(configPath());
  const file = ensureConfigFile();
  console.log(`${existed ? "Config already exists" : "Created"}: ${file}

Next:
  1. Edit targets, wallets and limits in that file, then set "demo": false
  2. Optional: put Alpaca PAPER keys in ${path.join(HOME_DIR, ".env")}
       ALPACA_KEY_ID="..."
       ALPACA_SECRET_KEY="..."
  3. claude mcp add equi -- npx -y equi-agent`);
  process.exit(0);
}

if (cmd !== "web") {
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const pct = (n: number) => `${n.toFixed(1)}%`;

const server = new McpServer({ name: "equi", version: VERSION });

server.registerTool(
  "get_portfolio",
  {
    title: "Unified portfolio",
    description: "Read every configured account (Alpaca paper broker, Solana and EVM wallets) and return one portfolio grouped into equities, crypto and cash, in USD. Read-only.",
    inputSchema: {},
  },
  async () => {
    const cfg = loadConfig();
    const p = await loadPortfolio(cfg);
    const lines = [
      `Total: ${usd(p.totalUsd)}${p.demo ? "  (DEMO)" : ""}`,
      "",
      "| Bucket | Value | Weight |",
      "|---|---|---|",
      ...BUCKETS.map((b) => `| ${b} | ${usd(p.totals[b])} | ${pct(p.totalUsd ? (p.totals[b] / p.totalUsd) * 100 : 0)} |`),
      "",
      "| Venue | Account | Asset | Amount | Value | Bucket |",
      "|---|---|---|---|---|---|",
      ...p.holdings.map((h) => `| ${h.venue} | ${short(h.account)} | ${h.symbol} | ${h.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} | ${usd(h.usd)} | ${h.bucket} |`),
      ...(p.warnings.length ? ["", ...p.warnings.map((w) => `⚠ ${w}`)] : []),
    ];
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "get_targets",
  {
    title: "Target allocation",
    description: "Show the target allocation, drift tolerance and safety limits.",
    inputSchema: {},
  },
  async () => {
    const c = loadConfig();
    return text(
      [
        `Targets: equities ${c.targets.equities}% · crypto ${c.targets.crypto}% · cash ${c.targets.cash}%`,
        `Tolerance: ±${c.tolerancePct} pts`,
        `Limits: max ${usd(c.limits.maxOrderUsd)} per order, ${usd(c.limits.maxDailyUsd)} per day (spent today: ${usd(spentToday())})`,
        `Mode: ${c.demo ? "DEMO (sample holdings)" : "live accounts"} · broker: Alpaca paper ${alpacaConfigured() ? "(connected)" : "(not configured)"}`,
        fs.existsSync(configPath()) ? `Config: ${configPath()}` : `Config: built-in demo defaults (run \`npx -y equi-agent init\` to create ${configPath()})`,
      ].join("\n"),
    );
  },
);

server.registerTool(
  "set_targets",
  {
    title: "Set target allocation",
    description: "Change the target allocation (percent per bucket, must sum to 100) and optionally the drift tolerance. Saved to config.json.",
    inputSchema: {
      equities: z.number().min(0).max(100),
      crypto: z.number().min(0).max(100),
      cash: z.number().min(0).max(100),
      tolerancePct: z.number().min(0.5).max(50).optional(),
    },
  },
  async ({ equities, crypto, cash, tolerancePct }) => {
    const err = validateTargets({ equities, crypto, cash });
    if (err) return { ...text(err), isError: true };
    const c = loadConfig();
    c.targets = { equities, crypto, cash };
    if (tolerancePct !== undefined) c.tolerancePct = tolerancePct;
    saveConfig(c);
    return text(`Saved. Targets: equities ${equities}% · crypto ${crypto}% · cash ${cash}% · tolerance ±${c.tolerancePct} pts`);
  },
);

server.registerTool(
  "check_drift",
  {
    title: "Check drift",
    description: "Compare current weights with the targets and say whether a rebalance is needed. Read-only.",
    inputSchema: {},
  },
  async () => {
    const cfg = loadConfig();
    const p = await loadPortfolio(cfg);
    const { drift, maxDrift, needsRebalance } = computeDrift(p, cfg);
    return text(
      [
        `Portfolio ${usd(p.totalUsd)}${p.demo ? " (DEMO)" : ""} · tolerance ±${cfg.tolerancePct} pts`,
        "",
        "| Bucket | Now | Target | Drift | To target |",
        "|---|---|---|---|---|",
        ...drift.map((d) => `| ${d.bucket} | ${pct(d.currentPct)} | ${pct(d.targetPct)} | ${d.driftPts >= 0 ? "+" : ""}${d.driftPts.toFixed(1)} pts | ${d.diffUsd >= 0 ? "buy " : "sell "}${usd(Math.abs(d.diffUsd))} |`),
        "",
        needsRebalance ? `Rebalance needed: largest drift ${maxDrift.toFixed(1)} pts. Run plan_rebalance to see the trades.` : "Within tolerance. No rebalance needed.",
        ...p.warnings.map((w) => `⚠ ${w}`),
      ].join("\n"),
    );
  },
);

function renderPlan(plan: Plan) {
  const modeLabel = { alpaca: "auto (Alpaca paper)", "wallet-sign": "you sign in wallet", manual: "manual" } as const;
  return [
    `Plan ${plan.id}${plan.demo ? " (DEMO)" : ""} · portfolio ${usd(plan.totalUsd)} · valid 15 min`,
    "",
    ...(plan.legs.length
      ? [
          "| # | Venue | Action | Amount | Who does it | Notes |",
          "|---|---|---|---|---|---|",
          ...plan.legs.map((l) => {
            const q = l.quote ? `quote: ${l.quote.route}, impact ${(Number(l.quote.priceImpactPct) * 100).toFixed(2)}%` : "";
            return `| ${l.id} | ${l.venue} | ${l.detail} | ${usd(l.usd)} | ${modeLabel[l.mode]} | ${[l.blocked ? `BLOCKED: ${l.blocked}` : "", q].filter(Boolean).join(" · ")} |`;
          }),
        ]
      : ["No trades."]),
    "",
    ...plan.notes,
    ...(plan.legs.some((l) => l.mode === "alpaca" && !l.blocked)
      ? ["", `To place the Alpaca legs, the user must confirm, then call execute_rebalance with plan_id "${plan.id}" and confirm "EXECUTE".`]
      : []),
  ].join("\n");
}

server.registerTool(
  "plan_rebalance",
  {
    title: "Plan a rebalance",
    description:
      "Build the list of trades that brings the portfolio back to target: Alpaca stock orders, Solana swaps (with live Jupiter quotes) and manual steps. Nothing is executed. Show the plan to the user and ask for approval before calling execute_rebalance.",
    inputSchema: {},
  },
  async () => {
    const cfg = loadConfig();
    const p = await loadPortfolio(cfg);
    const plan = await buildPlan(p, cfg);
    return text([renderPlan(plan), ...p.warnings.map((w) => `⚠ ${w}`)].join("\n"));
  },
);

server.registerTool(
  "execute_rebalance",
  {
    title: "Execute a confirmed plan",
    description:
      "Place the Alpaca (paper) orders of a plan from plan_rebalance. Only call this after the user explicitly approved that exact plan. Wallet and manual legs are returned as instructions; this server never signs blockchain transactions.",
    inputSchema: {
      plan_id: z.string().describe("id returned by plan_rebalance"),
      confirm: z.literal("EXECUTE").describe('must be the exact string "EXECUTE", typed after the user approved'),
    },
  },
  async ({ plan_id }) => {
    const r = await executePlan(plan_id);
    if (!r.ok) return { ...text(r.error ?? "Execution failed."), isError: true };
    return text(
      [
        r.demo ? "DEMO: no real orders were sent." : "Alpaca paper orders (simulated money):",
        ...(r.results.length ? r.results : ["(no broker legs)"]),
        ...(r.pending.length ? ["", "Still to do yourself:", ...r.pending] : []),
      ].join("\n"),
    );
  },
);

await server.connect(new StdioServerTransport());
}
