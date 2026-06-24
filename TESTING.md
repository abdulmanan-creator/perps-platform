# Acceptance test plan — phases 1–5

Run top to bottom after all three Render services are serving the latest commit.
Each item lists the step and the expected result. Items marked **[$]** move real
mainnet money (keep sizes ~$10–15).

## 0. Deploy + config sanity (5 min)

- [ ] `curl https://alchemy-hl-api.onrender.com/healthz` → `{ok:true, builder:0x0cBA…}`
- [ ] `curl https://alchemy-hl-mcp.onrender.com/healthz` → `hasOauth:true, hasHotSigner:false`
- [ ] `curl https://alchemy-hl-web.onrender.com/dashboard` → HTTP 200
- [ ] `curl "https://alchemy-hl-api.onrender.com/positions?user=0x0cBACa5767bb23B47d7337B41E6aeADa7Da2C6B6"` → JSON with `positions` array
- [ ] `curl https://alchemy-hl-api.onrender.com/metrics` → Prometheus text.
      Then set `METRICS_TOKEN` on the api service (`openssl rand -hex 16`),
      redeploy, and confirm the same curl now returns 403 and works again
      with `-H "Authorization: Bearer <token>"`.
- [ ] Confirm `OAUTH_SIGNING_SECRET` is byte-identical on api, web, and mcp
      services — the MCP now *verifies* tokens, so a mismatch = every
      connector call 401s.

## 1. Public site (10 min)

- [ ] Landing page: every footer link works — Discord, llms.txt
      (renders the 14-tool text file), Support. Nav Discord icon works.
- [ ] Hero code block: 4 tabs. TypeScript imports `@alchemy-hl/sdk`;
      Python/Rust/Go show REST build→sign→send (no fictional packages).
      Pill reads "TypeScript SDK + REST".
- [ ] `/connect/claude` + `/connect/chatgpt`: no hardcoded tool count,
      troubleshooting links point at /healthz.
- [ ] Mobile width (devtools, ~390px): landing, /approve, /dashboard all
      render without horizontal scroll. (Known soft spot — flag anything ugly.)

## 2. Onboarding — fresh user / default Agent.trade gates (15 min)

Use an email you've never signed in with (catches regressions your existing
account can't).

- [ ] `/onboarding` with `NEXT_PUBLIC_PRIVY_APP_ID` configured → Privy sign-in
      is available for the methods enabled in the dashboard and wired in the
      app today: email, Google, and existing wallet.
- [ ] Fresh email sign-in can create a Privy embedded wallet for a user with no
      wallet, when embedded wallets are enabled in the Privy app.
- [ ] `/onboarding` with no Privy env → paper mode remains available and copy
      does not imply live funding.
- [ ] Funding/on-ramp CTAs remain disabled unless
      `NEXT_PUBLIC_AGENT_TRADE_ENABLE_PRIVY_FUNDING=true`, Privy is configured,
      a wallet is connected, live eligibility is confirmed, and the Privy
      funding hook is available.
- [ ] `/approve` default state → legacy approval and Hyperliquid deposit
      compatibility screens are hidden unless their explicit flags are enabled.

### Legacy approval/deposit compatibility, env-gated only [$]

Run this subsection only after explicit internal approval and after enabling
`NEXT_PUBLIC_AGENT_TRADE_ENABLE_LEGACY_APPROVALS=true` and, for deposit
compatibility, `NEXT_PUBLIC_AGENT_TRADE_ENABLE_HL_BRIDGE_DEPOSIT=true`.

- [ ] `/approve` → sign in with a new email → embedded wallet created, address
      chip shown.
- [ ] Builder-fee approval/revoke copy is clearly presented as a legacy
      compatibility flow, not normal Agent.trade onboarding.
- [ ] Any Hyperliquid Bridge2 deposit surface is shown only when the deposit
      flag, live eligibility, and legal/compliance prerequisites are satisfied.

## 3. Dashboard (15 min)

Explorer mode (logged out / incognito):

- [ ] `/dashboard` shows the address prompt. Paste the builder address
      → account summary, positions, orders, fills render. No cancel buttons
      (not your wallet).
- [ ] Shareable URL: `/dashboard?user=0x…` deep-links straight to that
      account.

Owner mode (signed in):

- [ ] `/dashboard` auto-loads your wallet, "● your wallet" badge shows.
- [ ] Account status cards: builder approval state correct; agent card shows
      delegated=Yes (if you've connected a connector) + agent address.
- [ ] Place a resting limit order via the Claude connector (next section),
      watch it appear in Open orders within ~10s without refreshing.
- [ ] **One-click cancel**: hit Cancel on that order → completes with NO
      wallet popup (agent path), row disappears. Double-click fast — the
      idempotency key should make the second click harmless.
- [ ] Wallet-signed cancel fallback: revoke the agent (or use a wallet that
      never delegated), place an order via /approve test card or SDK, cancel
      from dashboard → Privy/wallet popup appears, cancel lands.

## 4. AI connectors — Claude AND ChatGPT (20 min) [$]

Run the full list in Claude, then spot-check 2–3 items in ChatGPT (same
agent, same tools).

Reads:
- [ ] "What's the BTC price on Hyperliquid?" → get_market_price
- [ ] "Show my balance and positions" → get_balance + get_positions
      (positions show side, size, entry, live PnL, liq price)
- [ ] "What did I trade recently?" → get_fills (fees + closed PnL visible)

Writes:
- [ ] "Buy $12 of BTC" → place_market_order fills; note the avg price
- [ ] "Set a stop-loss 5% below my entry" → place_trigger_order kind=sl,
      reduce-only, returns a restingOid
- [ ] "Show my open orders" → the stop shows up
- [ ] "Cancel that stop-loss" → cancel_order by oid
- [ ] "Close my BTC position" → close_position, full size, reduce-only
- [ ] "Set my BTC leverage to 60x" → clean refusal citing the agent cap
      (default 10x), not a raw error dump

Cross-connector:
- [ ] ChatGPT works without a second approveAgent signature (shared agent).

Revenue:
- [ ] After the buys/closes above:
      `curl -H "Authorization: Bearer <METRICS_TOKEN>" .../metrics | grep alchemy_builder_fee_usd_total`
      → nonzero, roughly notional × 0.0004. Cross-check `builderFee` fields
      in get_fills output.

## 5. SDK (10 min) [$ optional]

- [ ] `npx tsx scripts/sdk-smoke.ts` (hot key) — reads pass.
- [ ] Quick REPL check of the new surface against your funded wallet:
      `sdk.positions()`, `sdk.takeProfit("BTC", { triggerPrice: … })`,
      `sdk.closePosition("BTC")`. Each should behave per packages/sdk/README.md.
- [ ] Testnet integration suite: fund a testnet wallet at
      https://app.hyperliquid-testnet.xyz/drip, then
      `cd apps/api && HL_TESTNET_PRIVATE_KEY=0x… npm run test:integration`
      → signed tier runs: approve → resting order → openOrders → cancel.
      (Builder address must also have a funded testnet account.)

## 6. Hardening behaviors (10 min)

- [ ] Replay guard: place an order via the API (build→sign→send), then POST
      the identical signed payload again → 409 DUPLICATE_REQUEST, and the
      order did NOT double-place (check fills).
- [ ] Rate limit: `for i in $(seq 1 40); do curl -s -o /dev/null -w "%{http_code} " https://alchemy-hl-api.onrender.com/markets; done`
      → mostly 200s with some 429s past ~30/s.
- [ ] Markets cache: two back-to-back `/markets` calls — second one
      noticeably faster (~ms).
- [ ] Bad token: `curl -H "Authorization: Bearer garbage" https://alchemy-hl-mcp.onrender.com/` (POST an MCP frame)
      → 401 with `error="invalid_token"` in WWW-Authenticate.

## 7. Prediction markets — HIP-4 (10 min) [$ small]

- [ ] `curl https://alchemy-hl-api.onrender.com/outcomes` → live outcome
      markets (Fed decisions, sports, …) with sides + assetIds.
- [ ] `curl "https://alchemy-hl-api.onrender.com/outcomeOdds?outcome=<id>"`
      → per-side bestBid/bestAsk + probability (book midpoint).
- [ ] In Claude: "What prediction markets are live on Hyperliquid?" →
      get_prediction_markets. Then "What are the odds on the Fed market?"
      → get_prediction_odds with resolution criteria.
- [ ] "Buy 10 contracts of <side> at <near the book price>" →
      trade_prediction_market; order rests or fills; cost = contracts × price.
- [ ] "Cancel that prediction order" → cancel_order with assetId (no symbol).
- [ ] SDK: `sdk.outcomes()`, `sdk.outcomeOdds(id)`, and an
      `sdk.outcomeOrder(…)` at a far-from-book price, then
      `sdk.cancel({ assetId, oid })`.
- [ ] Note: outcome positions live in HL's *spot* balances (not
      /positions). Verifying holdings requires HL's UI/API for now —
      dashboard surfacing is future work.

## 8. Token expiry (passive, day 2)

- [ ] ~24h after connecting, use the Claude connector again → it should
      silently re-run OAuth (one redirect) rather than erroring. This
      exercises the new verified-token 401 path.

---

**When something fails:** note the section number + paste the response/log.
API errors carry `{error, message, guidance}` — the `message` is usually
Hyperliquid's literal reason and the fastest path to root cause.
