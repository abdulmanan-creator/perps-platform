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
- Privy truth-in-copy: public copy claims only configured email, Google, existing-wallet login, and embedded-wallet creation; funding/on-ramp and Hyperliquid deposit copy stays disabled, legacy, planned, or provider-dependent.
- API safety checks for guarded live actions and session-scoped paper ledger endpoints.

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
