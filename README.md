# equi-agent

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent (Claude Code, Claude Desktop, ...) see **US stocks and on-chain crypto as one portfolio**, measure how far it drifted from your target allocation, and plan the trades to get back on target. Broker orders run only after you approve.

- **US stocks:** [Alpaca](https://alpaca.markets), **paper trading only** (simulated money)
- **Crypto:** Solana (SOL + every priced SPL / Token-2022 token), Ethereum, Base, Arbitrum (native coin + configured ERC-20s)
- **Cash:** broker cash + stablecoins (USDC, USDT, PYUSD, DAI, ...)
- **Prices:** DefiLlama. **Solana swap quotes:** Jupiter (read-only)

## Quick start

```bash
claude mcp add equi -- npx -y equi-agent
```

Then ask Claude: *"How far is my portfolio from target? Plan a rebalance."*

It starts in **demo mode** with a sample $14,000 portfolio, so you can try the whole flow before connecting anything.

## Web app (dashboard + terminal)

```bash
npx -y equi-agent web            # http://127.0.0.1:5540  (from source: npm run web)
```

- **Dashboard**: total value, drift per bucket, holdings, target form, plan and execute (type `EXECUTE`).
- **Terminal** (`/#terminal`): `portfolio`, `drift`, `targets`, `set targets 50 30 20 [tol]`, `plan`, `execute <id> EXECUTE`.
- Same functions as the MCP tools, same caps and 15-minute plan expiry.
- Listens on `127.0.0.1` only. `--host 0.0.0.0` (or `HOST`) refuses to start unless `EQUI_WEB_TOKEN`
  (16+ characters) is set; the app then asks for that token. API calls need the app's own origin and an
  `X-Equi` header, so other websites in your browser cannot use it. `--port` / `PORT` change the port.

## Connect your accounts

```bash
npx -y equi-agent init
```

This creates `~/.equi/config.json`. Edit it:

- `targets`: percent per bucket (`equities`, `crypto`, `cash`), must sum to 100
- `tolerancePct`: rebalance only past this many points of drift
- `solana.wallets` / `evm.wallets`: your **public** addresses
- `limits`: `maxOrderUsd` (bigger orders are split), `maxDailyUsd` (hard stop per UTC day)
- `"demo": false` to read real accounts

Alpaca paper keys (optional) go in `~/.equi/.env`:

```bash
ALPACA_KEY_ID="..."
ALPACA_SECRET_KEY="..."
```

## Tools

| Tool | What it does | Moves money? |
|---|---|---|
| `get_portfolio` | All accounts in one table, grouped into equities / crypto / cash | No |
| `get_targets` | Target %, tolerance, limits, today's spend, config path | No |
| `set_targets` | Change targets and tolerance | No |
| `check_drift` | Current vs target weights; says if a rebalance is needed | No |
| `plan_rebalance` | Trade list: Alpaca orders, Solana swaps with live quotes, manual steps | No |
| `execute_rebalance` | Places the plan's Alpaca **paper** orders after you confirm | Paper only |

## Safety model

- **No private keys, ever.** On-chain legs are quotes you sign in your own wallet.
- **Paper broker only.** Orders go to `paper-api.alpaca.markets`.
- **Two steps.** `plan_rebalance` → you approve → `execute_rebalance(plan_id, confirm: "EXECUTE")`. Plans expire after 15 minutes.
- **Dollar caps** per order and per day.
- Moving money between the broker and a blockchain is always a **manual** step.

This is software that follows the target allocation **you** set. It does not pick assets and is not investment advice.

## Configuration paths

| What | Default | Override |
|---|---|---|
| Settings | `~/.equi/config.json` | `EQUI_CONFIG` |
| Keys | `~/.equi/.env` or `./.env` | real environment variables |
| Daily spend ledger | `~/.equi/state/` | `EQUI_HOME` |
| Force demo mode | | `EQUI_DEMO=1` |

## Develop

```bash
git clone https://github.com/equi-agent/equi-agent.git && cd equi-agent
npm install
npm run smoke       # runs every tool once in demo mode
npm run typecheck
npm run build       # bundles to dist/index.js
```

## Roadmap

1. Wallet-sign legs: build the unsigned Jupiter / LI.FI transaction and hand it to the wallet
2. EVM swap quotes via LI.FI
3. Scheduled drift checks with a notification

## License

MIT
