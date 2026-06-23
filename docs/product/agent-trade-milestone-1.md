# Agent.trade Milestone 1 Notes

## Scope

Milestone 1 is limited to the core trading loop:

- Clean app shell and routes.
- Shared market/account data layer.
- Dense terminal UI.
- Embedded deterministic `AgentService`.
- Agent-driven chart annotations.
- Agent-to-ticket prefill.
- Eligibility and mode model.
- Confirmation modal.
- Paper trading path.
- Guarded Hyperliquid `/exchange` path.

Markets, portfolio, onboarding, landing, connector, rewards, and final polish are intentionally deferred.

## Run Commands

```bash
npm install
npm run dev
```

The web app runs on `http://localhost:3000` and the API runs on `http://localhost:8080`.

Useful checks:

```bash
npm run typecheck
npm run test
npm run build
```

## Required Env Vars

Start from `.env.example`.

For a local demo that uses live/read-only market data and paper trading:

```bash
ALCHEMY_BUILDER_ADDRESS=0x0000000000000000000000000000000000000000
HYPERLIQUID_API_URL=https://api.hyperliquid.xyz
NEXT_PUBLIC_API_URL=http://localhost:8080
GEO_BLOCK_ENABLED=false
```

For testnet execution smoke testing:

```bash
HYPERLIQUID_API_URL=https://api.hyperliquid-testnet.xyz
ALCHEMY_BUILDER_ADDRESS=<funded builder/testnet address>
NEXT_PUBLIC_PRIVY_APP_ID=<privy app id>
PRIVY_APP_ID=<privy app id>
PRIVY_APP_SECRET=<privy secret>
GEO_BLOCK_ENABLED=false
AGENT_TRADE_LIVE_TRADING_KILL_SWITCH=false
AGENT_TRADE_ORDER_NOTIONAL_CAP_USD=250
AGENT_TRADE_DAILY_NOTIONAL_CAP_USD=1000
```

Mainnet execution must remain disabled unless explicitly approved:

```bash
AGENT_TRADE_MAINNET_EXECUTION_ENABLED=false
AGENT_TRADE_INTERNAL_ALLOWLIST=
```

## Live vs Mocked

- Market stats and order book try to read from the existing API, which can point at Hyperliquid mainnet for read-only credibility.
- If the API is unavailable, the frontend uses the deterministic snapshot in `apps/web/lib/agent-trade/mock-data.ts`.
- Account, positions, open orders, fills, and agent scenarios are mocked for Milestone 1.
- Paper orders use `POST /agent-trade/paper-orders` and never call `/exchange`.
- Agent.trade live orders use `POST /agent-trade/exchange` after confirmation.
- Generic `POST /exchange` remains backward-compatible for SDK, MCP, dashboard, and legacy callers. Agent.trade-specific eligibility, acknowledgement, kill-switch, mainnet, and notional-cap checks are scoped to `/agent-trade/exchange` and `/agent/exchange` order actions.

## Safety Contract

- Unknown eligibility does not default to live trading.
- Restricted or unknown requests are blocked server-side for `/agent-trade/exchange` and `/agent/exchange` order actions.
- Agent.trade eligibility fail-closes independently of generic `GEO_BLOCK_ENABLED` when `AGENT_TRADE_REQUIRE_GEO_ELIGIBILITY=true`.
- A global kill switch blocks live orders.
- Mainnet execution is disabled by default and requires an explicit env flag plus allowlist.
- Server-side per-order and daily notional caps are enforced.
- Live orders require risk and terms acknowledgement headers, set only after the confirmation modal.
- The agent can draft a ticket but cannot submit it.
- Stale data refuses live trade drafting.
