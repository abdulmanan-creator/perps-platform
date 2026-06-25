# Agent.trade QA Gate

This gate verifies the current MVP safety loop: paper trading, restricted/default live-disabled state, agent-to-ticket handoff, paper ledger reflection, session isolation, and default-off legacy approval surfaces.

## Local Dev

Use API `8080` and web `3000` by default.
Run these commands from the repo root.

```bash
PORT=8080 WEB_ORIGIN=http://localhost:3000 npm run dev -w @alchemy-hl/api
NEXT_PUBLIC_API_URL=http://localhost:8080 npm run dev -w @alchemy-hl/web
```

If port `3000` or `8080` is occupied, stop the stale process first. The QA gate accepts overrides:

```bash
WEB_URL=http://localhost:3000 API_URL=http://localhost:8080 npm run test:agent-trade:e2e -w @alchemy-hl/web
```

The script launches a temporary headless Chrome session through the Chrome DevTools Protocol. Set `CHROME_BIN` if Chrome is not in a standard location.

## What It Checks

- Route render health for `/`, `/terminal`, `/terminal?symbol=ETH`, `/markets`, `/portfolio`, `/onboarding`, `/connectors`, `/connect/claude`, `/connect/chatgpt`, `/approve`, `/oauth/authorize`, and `/restricted`.
- Terminal default safety state: paper mode visible, live disabled under unknown/default eligibility, paper/simulated account values labelled clearly, compact freshness labelled from market/candle/account timestamps, agent panel visible, manual ticket source by default, and chart candle source labelled as Hyperliquid or degraded fallback.
- Manual paper market order: modal copy does not claim an agent draft, paper copy says orders never call `/exchange`, fills and positions update.
- Repeat paper orders: same-side paper orders increase the netted position, opposite-side paper orders reduce/close/flip using the simplified ledger.
- Agent-drafted paper orders: deterministic long and short fixture responses appear, Send to ticket works, confirmation copy states the agent drafted and the user confirms.
- Portfolio reflection: paper positions/fills are visible and labelled as simulated, not live Hyperliquid exposure. Disconnected/local sessions must not present demo balances as real funds.
- Session isolation: a second browser context gets a separate local paper ledger.
- Legacy fail-closed behavior: `/approve` and `/oauth/authorize` do not expose approval, Bridge2 deposit, Get USDC, or `/exchange` compatibility calls by default.
- Privy truth-in-copy: public copy claims only configured email, Google, existing-wallet login, and embedded-wallet creation; funding/on-ramp and Hyperliquid deposit copy stays disabled, legacy, planned, or provider-dependent. Privy dashboard providers may be configured, but Agent.trade funding CTAs remain disabled unless app feature flags and provider compatibility are enabled.
- Privy readiness for 9A: `/onboarding`, `/settings`, and `/terminal` expose whether Privy is configured, the user is signed in, a wallet exists, the wallet address/type is known, eligibility is live eligible, execution is testnet/default-safe, and the kill switch is clear. The terminal testnet toggle remains disabled until all readiness gates pass.
- API safety checks for guarded live actions and session-scoped paper ledger endpoints.

## Privy Readiness Checklist For 9A

Local paper-only development:

```bash
NEXT_PUBLIC_PRIVY_APP_ID=
PRIVY_APP_ID=
PRIVY_APP_SECRET=
NEXT_PUBLIC_AGENT_TRADE_ENABLE_PRIVY_FUNDING=false
NEXT_PUBLIC_AGENT_TRADE_ENABLE_HL_BRIDGE_DEPOSIT=false
```

Configured Privy testnet readiness:

```bash
NEXT_PUBLIC_PRIVY_APP_ID=<privy-app-id>
PRIVY_APP_ID=<same-privy-app-id>
PRIVY_APP_SECRET=<privy-secret>
HYPERLIQUID_API_URL=https://api.hyperliquid-testnet.xyz
AGENT_TRADE_MAINNET_EXECUTION_ENABLED=false
AGENT_TRADE_LIVE_TRADING_KILL_SWITCH=false
AGENT_TRADE_REQUIRE_GEO_ELIGIBILITY=true
NEXT_PUBLIC_AGENT_TRADE_ENABLE_PRIVY_FUNDING=false
NEXT_PUBLIC_AGENT_TRADE_ENABLE_HL_BRIDGE_DEPOSIT=false
NEXT_PUBLIC_AGENT_TRADE_ENABLE_LEGACY_APPROVALS=false
NEXT_PUBLIC_AGENT_TRADE_ENABLE_OAUTH_COMPAT_APPROVALS=false
```

Manual 9A readiness checks:

- No Privy env: app renders, onboarding/settings show local-dev paper-only readiness, terminal testnet toggle is disabled.
- Privy configured but signed out: onboarding/settings invite sign-in, terminal says sign-in is required.
- Signed in without a usable wallet: onboarding/settings show wallet missing, terminal stays paper-only.
- Signed in with wallet and unknown/restricted eligibility: paper remains available, testnet trading is disabled with the specific eligibility or restricted-region reason.
- Signed in with wallet, `liveEligible`, Hyperliquid testnet API, and kill switch clear: terminal testnet mode can be selected, but orders still require user confirmation and server `/agent-trade/exchange` guards.
- Kill switch active: terminal returns to paper-only and the disabled reason mentions the safety switch.
- Privy auth/wallet readiness is required for 9A testnet trading. Funding readiness is separate: testnet trading can proceed with separately funded testnet wallets while app funding remains product-gated.

Funding provider notes:

- MoonPay and fiat onramp can be configured in the Privy dashboard, but Agent.trade should treat them as future/product-gated until `NEXT_PUBLIC_AGENT_TRADE_ENABLE_PRIVY_FUNDING=true`, eligibility, wallet readiness, compliance review, and end-to-end QA are complete.
- Deposit Address/Relay can be configured in the Privy dashboard, but generic deposit-address funding remains product-gated and must not be presented as normal MVP funding.
- Stripe requires SDK compatibility validation in the installed Privy package before any in-app claim or CTA is exposed.
- Hyperliquid Bridge2 remains a separate legacy/default-off compatibility path controlled by `NEXT_PUBLIC_AGENT_TRADE_ENABLE_HL_BRIDGE_DEPOSIT=false`.

Intentionally not supported in the app yet unless separately configured, legally approved, and verified end-to-end: debit cards, credit cards, ACH, Apple Pay, Google Pay, bank deposits, generic crypto deposit addresses, Coinbase/Meld/Stripe-style claims, and Hyperliquid Bridge2 as a generally available deposit flow.

Screenshots are written to `/tmp` by default:

- `/tmp/agent-trade-e2e-terminal.png`
- `/tmp/agent-trade-e2e-portfolio.png`
- `/tmp/agent-trade-e2e-private-terminal.png`

Use `AGENT_TRADE_E2E_ARTIFACT_DIR=/path` to change the output directory.

## Known Dev Notes

- The web build currently prints the MetaMask SDK optional dependency warning for `@react-native-async-storage/async-storage`; this is expected if the build still succeeds.
- If Next throws a missing chunk or fallback chunk `500`, stop dev servers, delete `apps/web/.next`, and restart dev.
- Do not run `next dev` and `next build` concurrently. Both write `apps/web/.next`.
- Terminal candles use `GET /agent-trade/candles?symbol=BTC-USD&interval=15m` backed by Hyperliquid `candleSnapshot`. During manual QA, check BTC and ETH labels, interval switching, and the synthetic fallback label by temporarily stopping the API or forcing the candle route to fail.

## Manual Geo / Trading Mode Controls

Agent.trade should normally be reachable by restricted or unknown users in paper-only mode. Geo controls must block live trading and guarded mutation APIs, not ordinary app access.

Service ownership:

- `agent-trade-web`: frontend route access, eligibility display, paper/live copy, and public feature flags.
- `agent-trade-api`: eligibility source of truth, paper order endpoints, live trading eligibility, mainnet/testnet execution venue, kill switch, and min/max notional policy.
- Paper trading availability: web UI plus API `/agent-trade/paper-orders` and `/agent-trade/paper-account`.
- Live trading eligibility: API `/agent-trade/exchange` guard. Frontend state is advisory only.
- Mainnet execution: API env and `/agent-trade/exchange`; never controlled solely by the browser.
- Kill switch and min/max notional caps: API env.

Env controls:

- `GEO_BLOCK_ENABLED`: API geo guard for live/legacy mutation surfaces. Keep `true` in production.
- `GEO_FAIL_CLOSED`: when `true`, API treats missing/unknown country as ineligible for live trading.
- `GEO_COUNTRY_HEADER`: edge country header, usually `cf-ipcountry`.
- `RESTRICTED_COUNTRIES`: comma-separated restricted ISO country list.
- `AGENT_TRADE_REQUIRE_GEO_ELIGIBILITY`: when `true`, missing/unknown country becomes unknown eligibility for Agent.trade live trading.
- `AGENT_TRADE_MAINNET_EXECUTION_ENABLED`: enables Agent.trade mainnet forwarding for eligible users only.
- `AGENT_TRADE_LIVE_TRADING_KILL_SWITCH`: emergency stop for all Agent.trade live trading.
- `AGENT_TRADE_MIN_ORDER_NOTIONAL_USD`: minimum live order notional enforced before forwarding.
- `AGENT_TRADE_ORDER_NOTIONAL_CAP_USD`: optional per-order product cap; `0` disables this app-level max.
- `AGENT_TRADE_DAILY_NOTIONAL_CAP_USD`: optional daily app-level cap; `0` disables this app-level max.
- `NEXT_PUBLIC_API_URL`: web-to-API base URL.
- `AGENT_TRADE_HARD_BLOCK_RESTRICTED_UI`: web-only hard-block mode. Default `false`; set `true` only if legal requires hiding app routes entirely.

Common Render changes:

- Allow restricted users to access UI but paper-only trade:
  - Edit `agent-trade-web`: keep `AGENT_TRADE_HARD_BLOCK_RESTRICTED_UI=false`.
  - Edit `agent-trade-api`: keep `GEO_BLOCK_ENABLED=true`, `GEO_FAIL_CLOSED=true`, and `AGENT_TRADE_REQUIRE_GEO_ELIGIBILITY=true`.
  - Redeploy/restart both services if env changed.
  - Smoke: `/terminal`, `/markets`, `/portfolio`, `/onboarding`, `/settings`.
  - Expected US result: app loads, live disabled, paper orders work.
  - Expected Singapore result: if edge country resolves `SG` and account readiness passes, live can be enabled.

- Fully block restricted regions if legal requires it:
  - Edit `agent-trade-web`: set `AGENT_TRADE_HARD_BLOCK_RESTRICTED_UI=true`.
  - Keep `agent-trade-api` geo vars enabled.
  - Redeploy/restart `agent-trade-web`.
  - Smoke: `/terminal` from a restricted country should show `/restricted`.
  - Expected US result: app routes hard-blocked.
  - Expected Singapore result: app routes load normally.

- Enable live mainnet for eligible regions:
  - Edit `agent-trade-api`: set `HYPERLIQUID_API_URL=https://api.hyperliquid.xyz`, `AGENT_TRADE_MAINNET_EXECUTION_ENABLED=true`, `GEO_BLOCK_ENABLED=true`, `GEO_FAIL_CLOSED=true`, `AGENT_TRADE_REQUIRE_GEO_ELIGIBILITY=true`, and `AGENT_TRADE_LIVE_TRADING_KILL_SWITCH=false`.
  - Redeploy/restart `agent-trade-api`.
  - Smoke: `/agent-trade/eligibility`, `/terminal`, `/settings`.
  - Expected US result: restricted/paper-only.
  - Expected Singapore result: `liveEligible` when the edge country header resolves `SG`; wallet/account/risk checks still apply.

- Emergency disable all live trading:
  - Edit `agent-trade-api`: set `AGENT_TRADE_LIVE_TRADING_KILL_SWITCH=true`.
  - Redeploy/restart `agent-trade-api`.
  - Smoke: `/agent-trade/eligibility` and `/terminal`.
  - Expected US result: paper-only.
  - Expected Singapore result: paper-only with kill-switch copy.

- Switch API from mainnet to testnet:
  - Edit `agent-trade-api`: set `HYPERLIQUID_API_URL=https://api.hyperliquid-testnet.xyz` and `AGENT_TRADE_MAINNET_EXECUTION_ENABLED=false`.
  - Redeploy/restart `agent-trade-api`.
  - Smoke: `/agent-trade/eligibility`, `/terminal`, and a tiny testnet order only after wallet/account readiness passes.
  - Expected US result: restricted/paper-only.
  - Expected Singapore result: testnet live path available after readiness checks.

- Change min/max notional caps:
  - Edit `agent-trade-api`: set `AGENT_TRADE_MIN_ORDER_NOTIONAL_USD`, `AGENT_TRADE_ORDER_NOTIONAL_CAP_USD`, and `AGENT_TRADE_DAILY_NOTIONAL_CAP_USD`.
  - Redeploy/restart `agent-trade-api`.
  - Smoke: `/agent-trade/eligibility` to confirm policy values, then `/terminal`.
  - Expected US result: paper-only regardless of caps.
  - Expected Singapore result: eligible live orders respect the configured minimum and any nonzero app-level caps.

Warning: never use `GEO_BLOCK_ENABLED=false` as the normal way to allow paper trading. The correct production default is UI accessible plus server-enforced live execution blocking. Direct live order APIs must remain server-enforced regardless of frontend state.
