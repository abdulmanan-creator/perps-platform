# Agent.trade HIP4-C QA Readiness And Operator Test Plan

Date: 2026-06-26

This checklist is for the HIP4-C live prediction-market rollout. It is a
readiness plan and evidence template only; it does not enable flags, change geo
policy, or deploy.

## Scope

- Surfaces: `/predictions`, `/predictions/:questionId`, `/settings`,
  `/onboarding`, and guarded API route `/prediction/exchange`.
- Out of scope: loosening US geo restrictions, changing
  `/agent-trade/exchange`, changing gasless deposit policy, enabling legacy
  `/approve`, and broad HIP-4 sell/exit support unless separately implemented.
- Live HIP-4 must remain opt-in behind both API and web flags.

## Readiness Gates

Do not start live tester QA until every gate is true.

- API live flag: `AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING=true`.
- Web live flag: `NEXT_PUBLIC_AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING=true`.
- Normal Agent.trade live safeguards remain enabled:
  `GEO_BLOCK_ENABLED=true`, `GEO_FAIL_CLOSED=true`,
  `AGENT_TRADE_REQUIRE_GEO_ELIGIBILITY=true`, mainnet execution policy set as
  intended, and kill switch clear.
- US/restricted or unknown users remain paper-only and cannot build or send a
  live HIP-4 order.
- Singapore tester resolves `liveEligible` from API eligibility and has a
  connected Privy wallet matching the signer.
- Hyperliquid account is funded with USDC before live order QA.
- Builder approval is complete for the same wallet:
  `/approval?user=<wallet>` returns `canTradePerps=true` for perps readiness
  and the HIP-4 live route uses the configured spot builder fee. If UI requires
  separate readiness copy, it must show the builder address, current max fee,
  and configured fee.
- Prediction question and odds endpoints return current metadata for the test
  market and selected outcome/side.
- The selected side has a real top of book for fill QA, or the test is
  explicitly an illiquid/empty-book rejection/resting-order test.

## Behavior Matrix

| Scenario | Expected result |
| --- | --- |
| US restricted user, flags off | `/predictions` loads read/paper surfaces only; no active live HIP-4 CTA; `/prediction/exchange` rejects. |
| US restricted user, flags on | UI remains paper-only; live HIP-4 CTA disabled or hidden; direct `/prediction/exchange` rejects before build/send. |
| Unknown eligibility | Paper/read-only only; live CTA disabled or hidden; direct live route fails closed. |
| Singapore live eligible, flags off | Prediction read/paper surfaces work; live CTA disabled with flag-gated copy; direct route rejects as disabled. |
| Singapore live eligible, flags on, unfunded | Live CTA must not imply readiness; guide user to fund/deposit first. |
| Singapore live eligible, funded existing account, builder approved | Live HIP-4 buy can build, sign, send, then show filled/resting/rejected result from nested exchange status. |
| Singapore live eligible, funded new account, builder not approved | Settings/onboarding must show builder approval CTA; terminal/prediction live order must block before wallet signing. |
| Singapore live eligible, funded new account, builder approved | Same as existing funded account; collect proof before and after the first live order. |
| Order notional below $10 | Client should block when possible; API must reject or Hyperliquid rejection must be surfaced clearly. |
| Illiquid/empty book | UI labels empty/one-sided book; IOC should reject or no-fill clearly; GTC may rest only if accepted by Hyperliquid. |
| Hyperliquid nested rejection | HTTP 200 with `response.data.statuses[].error` must display `Rejected: <reason>` and not look successful. |

## Operator Test Plan

### 1. Restricted US Smoke

Use a US environment or a verified restricted-country edge header. Do not use a
VPN result as final proof unless the API logs confirm the country.

1. Open `/predictions` and a known question detail page.
2. Confirm read-only metadata, odds, empty-book labels, and paper ticket UI
   remain usable.
3. Confirm there is no active live HIP-4 order CTA.
4. Attempt a paper prediction order and confirm the paper ledger updates.
5. Attempt direct `/prediction/exchange` build if tooling is available.

Expected: UI is paper-only, paper order is accepted, direct live route rejects
with restricted/unknown/disabled policy. No wallet signature prompt should open
for live HIP-4.

### 2. Singapore Existing Funded Account

Use the existing known-good Singapore wallet that already has Hyperliquid USDC
and builder approval.

1. Confirm `/agent-trade/eligibility` returns `liveEligible`.
2. Confirm `/approval?user=<wallet>` returns the expected builder address and
   approval state.
3. Confirm `/predictions/:questionId` shows live order controls only when both
   HIP-4 flags are on.
4. Select a liquid outcome side with visible bid/ask.
5. Submit a small live buy with notional at or above `$10`.
6. Record whether the result is filled, resting, or rejected.
7. Refresh fills, open orders, order status, and the question detail page.

Expected: build and send phases complete only after explicit user
acknowledgement and wallet signature. UI result matches Hyperliquid nested
status and observed account state.

### 3. Singapore New Funded Account

Use a newly funded Singapore wallet with Hyperliquid account value greater than
zero. This account should start without builder approval.

1. Confirm wallet address in Privy, settings, onboarding, and API proof all
   match.
2. Confirm Hyperliquid balance is nonzero.
3. Confirm `/approval?user=<wallet>` reports current max fee below the required
   configured fee.
4. Confirm settings/onboarding show `Approve Agent.trade builder fee`.
5. Confirm live HIP-4 order submission is blocked before signing while builder
   approval is missing.
6. Complete builder approval from the Agent.trade-native approval surface.
7. Re-check `/approval?user=<wallet>`.
8. Submit the same live HIP-4 order test as the existing funded account.

Expected: builder approval is available even if balance is below a typical
order size, but live order submission stays blocked until approval is complete.

### 4. Gasless Deposit Assumptions

HIP4-C live order QA may use wallets funded by the gasless Hyperliquid deposit
flow, but HIP-4 trading readiness must not assume a deposit succeeded merely
because the Privy wallet has USDC.

Check:

- Wallet USDC and Hyperliquid account value are shown as separate concepts.
- Gasless deposit remains allowlisted and gated by its own flags.
- Failed or pending gasless deposit does not unlock live HIP-4 order submit.
- If Hyperliquid account value is below the amount needed for the intended
  order, the operator tops up or reduces order size before live QA.

### 5. Minimum Notional

Run both blocked and accepted cases.

- Below minimum: choose contracts and probability with notional below `$10`.
  Expected copy: order is below `$10` minimum notional, no wallet signature
  prompt, no `/prediction/exchange` send.
- At or above minimum: choose contracts and probability with notional at least
  `$10`. Expected: build/sign/send can proceed only if all other live gates are
  satisfied.

### 6. Illiquid / Empty Book

Use one outcome side with `emptyBook=true` or missing bid/ask.

- UI must label `Empty book` or `One-sided book`.
- The ticket must not promise an immediate fill.
- IOC live order may return a no-fill/rejection-like result; show it clearly.
- GTC live order may rest if accepted; show `Resting open order` and collect
  open-order proof.
- Do not count an empty-book order as a successful fill unless `userFills`
  confirms it.

### 7. Rejection Handling

Force or observe at least one safe rejection:

- Builder fee not approved.
- Below minimum notional.
- Insufficient margin.
- Bad tick/size/probability.
- Empty/illiquid IOC no-fill, if Hyperliquid reports it as an error.

Expected: any `response.data.statuses[].error` is shown as
`Rejected: <reason>`. The UI must not show silent success just because the HTTP
status is 200.

## Proof Collection Template

For every live attempt, save the following.

```text
Operator:
Date/time UTC:
Environment:
Wallet:
Country/eligibility proof:
Question ID:
Outcome / side / assetId:
Action:
Contracts:
Limit probability:
Computed notional:
TIF:
Builder address:
Configured builder fee:
Approval response:
Gasless deposit status, if used:
```

Exchange proof:

```text
Build response:
Send response:
Nested exchange result:
Error/rejection reason, if any:
```

Hyperliquid proof:

```text
userFills before:
userFills after:
openOrders before:
openOrders after:
orderStatus:
account value before:
account value after:
Hypurrscan wallet link:
Hypurrscan order/tx/fill link, if available:
```

Acceptance criteria:

- Filled order: `userFills` includes the expected HIP-4 asset and size.
- Resting order: `openOrders` or `orderStatus` shows the expected oid, asset,
  side, price, and size.
- Rejected order: exchange response contains a safe reason and no fill/order
  proof is present.

## Env Checklist

API service (`agent-trade-api`):

```bash
AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING=true
GEO_BLOCK_ENABLED=true
GEO_FAIL_CLOSED=true
AGENT_TRADE_REQUIRE_GEO_ELIGIBILITY=true
AGENT_TRADE_LIVE_TRADING_KILL_SWITCH=false
```

Web service (`agent-trade-web`):

```bash
NEXT_PUBLIC_AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING=true
```

Do not infer live support from web flag alone. The API flag and server-side geo,
risk acknowledgement, signer, notional, builder, and Hyperliquid response
checks are authoritative.

## Rollback Plan

1. Set API flag `AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING=false`.
2. Set web flag `NEXT_PUBLIC_AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING=false`.
3. Redeploy `agent-trade-api`.
4. Redeploy `agent-trade-web`.
5. Smoke:
   - `/predictions` loads.
   - `/predictions/:questionId` shows read/paper behavior only.
   - Direct `/prediction/exchange` rejects as disabled.
   - `/agent-trade/exchange` behavior is unchanged.
   - US restricted users remain paper-only.
6. Preserve all proof from the failed rollout attempt before retrying.

## Pre-Ship Verification

Run from repo root:

```bash
git diff --check
npm run test -w @alchemy-hl/web -- agent-trade-predictions
```

If only this document changed, the prediction test run is optional but useful
before a HIP4-C release candidate.
