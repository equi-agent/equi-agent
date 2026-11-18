/**
 * Web app for omni-rebalancer: a small JSON API over the same functions the MCP tools use, plus the static
 * dashboard / terminal in web/. Started with `omni-rebalancer-mcp web`.
 *
 * Safety:
 *  - binds to 127.0.0.1 by default. Any other host needs REBALANCER_WEB_TOKEN (sent as a Bearer token).
 *  - API calls must come from the app's own origin and carry the X-Rebalancer header, so another website
 *    open in your browser cannot drive the API (no CORS headers are ever sent).
 *  - on loopback the Host header must be localhost / 127.0.0.1 (blocks DNS rebinding).
 *  - execute still needs the exact word "EXECUTE" and goes through the same caps as the MCP tool.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { configPath, HOME_DIR, loadConfig, PKG_ROOT, saveConfig, validateTargets } from "./config.ts";
import { loadPortfolio } from "./portfolio.ts";
import { buildPlan, computeDrift, PLAN_TTL_MS } from "./rebalance.ts";
import { alpacaConfigured, checkAlpacaKeys } from "./alpaca.ts";
import { spentToday } from "./guard.ts";
import { executePlan } from "./execute.ts";

const WEB_DIR = path.join(PKG_ROOT, "web");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const ENV_FILE = path.join(HOME_DIR, ".env");
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Reject anything that looks like a secret before it gets anywhere near the config file. */
function walletList(value: unknown, kind: "solana" | "evm"): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${kind} wallets must be a list.`);
  const out: string[] = [];
  for (const raw of value) {
    const a = String(raw).trim();
    if (!a) continue;
    if (/\s/.test(a) || /^(0x)?[0-9a-fA-F]{64}$/.test(a) || a.length > 60)
      throw new HttpError(400, "That looks like a private key or seed phrase. Only paste PUBLIC wallet addresses, and never share your keys.");
    if (kind === "solana" ? !SOL_ADDR.test(a) : !EVM_ADDR.test(a)) throw new HttpError(400, `Not a valid ${kind === "solana" ? "Solana" : "EVM (0x…)"} address: ${a}`);
    if (!out.includes(a)) out.push(a);
  }
  if (out.length > 20) throw new HttpError(400, "Up to 20 wallets per chain family.");
  return out;
}

/** Write or clear the Alpaca lines of ~/.omni-rebalancer/.env (owner-only), keeping any other lines. */
function writeAlpacaEnv(keyId: string | null, secret: string | null) {
  let lines: string[] = [];
  try { lines = fs.readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => l && !/^\s*ALPACA_(KEY_ID|SECRET_KEY)\s*=/.test(l)); } catch { /* new file */ }
  if (keyId && secret) lines.push(`ALPACA_KEY_ID="${keyId}"`, `ALPACA_SECRET_KEY="${secret}"`);
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(ENV_FILE, lines.join("\n") + (lines.length ? "\n" : ""), { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600);
  if (keyId && secret) { process.env.ALPACA_KEY_ID = keyId; process.env.ALPACA_SECRET_KEY = secret; }
  else { delete process.env.ALPACA_KEY_ID; delete process.env.ALPACA_SECRET_KEY; }
}

function settings() {
  const c = loadConfig();
  const id = process.env.ALPACA_KEY_ID || "";
  return {
    demo: c.demo,
    forcedDemo: process.env.REBALANCER_DEMO === "1",
    solanaWallets: c.solana.wallets,
    evmWallets: c.evm.wallets,
    evmChains: Object.keys(c.evm.chains),
    alpaca: { configured: alpacaConfigured(), keyHint: id ? `…${id.slice(-4)}` : null },
    configPath: configPath(),
    configExists: fs.existsSync(configPath()),
    envPath: ENV_FILE,
  };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw new HttpError(415, "Send JSON.");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new HttpError(413, "Request too large.");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}

function status(version: string) {
  const c = loadConfig();
  return {
    version,
    demo: c.demo,
    alpaca: alpacaConfigured(),
    configPath: fs.existsSync(configPath()) ? configPath() : null,
    targets: c.targets,
    tolerancePct: c.tolerancePct,
    limits: c.limits,
    spentToday: spentToday(),
    planTtlMs: PLAN_TTL_MS,
  };
}

async function api(method: string, route: string, req: http.IncomingMessage, version: string) {
  if (method === "GET" && route === "/api/status") return status(version);

  if (method === "GET" && route === "/api/portfolio") {
    const cfg = loadConfig();
    const p = await loadPortfolio(cfg);
    return { ...p, ...computeDrift(p, cfg), tolerancePct: cfg.tolerancePct };
  }

  if (method === "POST" && route === "/api/targets") {
    const b = await readJson(req);
    const num = (k: string) => (typeof b[k] === "number" && Number.isFinite(b[k]) ? (b[k] as number) : NaN);
    const t = { equities: num("equities"), crypto: num("crypto"), cash: num("cash") };
    if (Object.values(t).some((v) => Number.isNaN(v) || v < 0 || v > 100)) throw new HttpError(400, "Targets must be numbers from 0 to 100.");
    const err = validateTargets(t);
    if (err) throw new HttpError(400, err);
    const c = loadConfig();
    c.targets = t;
    if (b.tolerancePct !== undefined) {
      const tol = num("tolerancePct");
      if (Number.isNaN(tol) || tol < 0.5 || tol > 50) throw new HttpError(400, "Tolerance must be between 0.5 and 50 points.");
      c.tolerancePct = tol;
    }
    saveConfig(c);
    return status(version);
  }

  if (method === "POST" && route === "/api/plan") {
    await readJson(req);
    const cfg = loadConfig();
    const p = await loadPortfolio(cfg);
    const plan = await buildPlan(p, cfg);
    return { plan, warnings: p.warnings, expiresAt: plan.createdAt + PLAN_TTL_MS };
  }

  if (method === "POST" && route === "/api/execute") {
    const b = await readJson(req);
    if (b.confirm !== "EXECUTE") throw new HttpError(400, 'Type the exact word "EXECUTE" to confirm.');
    if (typeof b.plan_id !== "string" || !/^[a-f0-9-]{1,36}$/.test(b.plan_id)) throw new HttpError(400, "Missing plan id.");
    const r = await executePlan(b.plan_id);
    if (!r.ok) throw new HttpError(409, r.error ?? "Execution failed.");
    return r;
  }

  if (method === "GET" && route === "/api/settings") return settings();

  if (method === "POST" && route === "/api/settings") {
    const b = await readJson(req);
    const c = loadConfig(); // your config, or the bundled example until the first successful save
    if (b.solanaWallets !== undefined) c.solana.wallets = walletList(b.solanaWallets, "solana");
    if (b.evmWallets !== undefined) c.evm.wallets = walletList(b.evmWallets, "evm");
    if (b.demo !== undefined) {
      if (typeof b.demo !== "boolean") throw new HttpError(400, "demo must be true or false.");
      if (!b.demo && !c.solana.wallets.length && !c.evm.wallets.length && !alpacaConfigured())
        throw new HttpError(400, "Add at least one wallet or Alpaca paper keys before going live.");
      c.demo = b.demo;
    }
    saveConfig(c);
    return settings();
  }

  if (method === "POST" && route === "/api/alpaca") {
    const b = await readJson(req);
    if (b.clear === true) {
      writeAlpacaEnv(null, null);
      return settings();
    }
    const keyId = typeof b.keyId === "string" ? b.keyId.trim() : "";
    const secret = typeof b.secret === "string" ? b.secret.trim() : "";
    if (!/^[A-Z0-9]{16,40}$/.test(keyId)) throw new HttpError(400, "The Key ID looks wrong. Alpaca paper key IDs are 16-40 capital letters and digits, usually starting with PK.");
    if (!/^[A-Za-z0-9/+=]{20,80}$/.test(secret)) throw new HttpError(400, "The secret key looks wrong.");
    let acct;
    try {
      acct = await checkAlpacaKeys(keyId, secret);
    } catch (e) {
      throw new HttpError(400, `Alpaca paper rejected these keys. Make sure they are PAPER keys. (${(e as Error).message.replace(/HTTP \d+: /, "")})`);
    }
    writeAlpacaEnv(keyId, secret);
    return { ...settings(), account: acct };
  }

  throw new HttpError(404, "Unknown endpoint.");
}

function serveStatic(route: string, res: http.ServerResponse) {
  const rel = route === "/" ? "app.html" : decodeURIComponent(route).replace(/^\/+/, "");
  const file = path.resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file)] || "application/octet-stream",
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  fs.createReadStream(file).pipe(res);
}

export async function startWeb({ port, host, version }: { port: number; host: string; version: string }) {
  const token = process.env.REBALANCER_WEB_TOKEN || "";
  const loopback = LOOPBACK.has(host);
  if (!loopback && token.length < 16) {
    console.error(`Refusing to listen on ${host} without REBALANCER_WEB_TOKEN (16+ characters). Anyone on the network could reach the API.`);
    process.exit(1);
  }
  const safeEq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const route = url.pathname;
    try {
      if (loopback) {
        const h = String(req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
        if (!LOOPBACK.has(h)) throw new HttpError(421, "Use http://127.0.0.1 or http://localhost.");
      }
      if (!route.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
        return serveStatic(route, res);
      }
      if (req.headers["x-rebalancer"] !== "1") throw new HttpError(403, "Missing X-Rebalancer header.");
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new HttpError(403, "Cross-origin request blocked.");
      if (token) {
        const auth = String(req.headers.authorization || "");
        if (!safeEq(auth, `Bearer ${token}`)) throw new HttpError(401, "Missing or wrong token.");
      }
      send(res, 200, await api(req.method || "GET", route, req, version));
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, (e as Error).message || "Server error.");
      if (route.startsWith("/api/") || err.status !== 500) send(res, err.status, { error: err.message });
      else send(res, 500, { error: "Server error." });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const shown = host.includes(":") ? `[${host}]` : host;
  console.log(`omni-rebalancer web ${version}

  App:       http://${shown}:${port}/
  Terminal:  http://${shown}:${port}/#terminal
  Mode:      ${loadConfig().demo ? "DEMO (sample $14,000 portfolio)" : "live accounts"} · broker: Alpaca paper ${alpacaConfigured() ? "(connected)" : "(not configured)"}
${token ? "  Auth:      Bearer token required\n" : ""}
Ctrl+C to stop.`);
}
