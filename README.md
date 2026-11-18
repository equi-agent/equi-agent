# omni-rebalancer-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent (Claude Code, Claude Desktop, ...) see **US stocks and on-chain crypto as one portfolio**, measure how far it drifted from your target allocation, and plan the trades to get back on target. Broker orders run only after you approve.

- **US stocks:** [Alpaca](https://alpaca.markets), **paper trading only** (simulated money)
- **Crypto:** Solana (SOL + every priced SPL / Token-2022 token), Ethereum, Base, Arbitrum (native coin + configured ERC-20s)
- **Cash:** broker cash + stablecoins (USDC, USDT, PYUSD, DAI, ...)
- **Prices:** DefiLlama. **Solana swap quotes:** Jupiter (read-only)

## Quick start

```bash
claude mcp add omni-rebalancer -- npx -y omni-rebalancer-mcp
```

Then ask Claude: *"How far is my portfolio from target? Plan a rebalance."*

It starts in **demo mode** with a sample $14,000 portfolio, so you can try the whole flow before connecting anything.

## Connect your accounts

```bash
npx -y omni-rebalancer-mcp init
```

This creates `~/.omni-rebalancer/config.json`. Edit it:

- `targets`: percent per bucket (`equities`, `crypto`, `cash`), must sum to 100
- `tolerancePct`: rebalance only past this many points of drift
- `solana.wallets` / `evm.wallets`: your **public** addresses
- `limits`: `maxOrderUsd` (bigger orders are split), `maxDailyUsd` (hard stop per UTC day)
- `"demo": false` to read real accounts

Alpaca paper keys (optional) go in `~/.omni-rebalancer/.env`:

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
| Settings | `~/.omni-rebalancer/config.json` | `REBALANCER_CONFIG` |
| Keys | `~/.omni-rebalancer/.env` or `./.env` | real environment variables |
| Daily spend ledger | `~/.omni-rebalancer/state/` | `REBALANCER_HOME` |
| Force demo mode | | `REBALANCER_DEMO=1` |

## Develop

```bash
git clone https://github.com/Dhkrmynti/omni-rebalancer-mcp.git && cd omni-rebalancer-mcp
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
