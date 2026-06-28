# Agent.trade Funding And Onboarding Audit

Date: 2026-06-25

This audit records what Agent.trade can safely claim from the current repo and
installed SDKs. It does not enable provider-funded deposits, set env vars,
loosen geo/live-trading rules, or change `/agent-trade/exchange`.

## Package And Wiring

- Web manifest requests `@privy-io/react-auth@^1.92.0` and
  `@privy-io/wagmi@^0.2.13`; the lockfile installs
  `@privy-io/react-auth@1.99.1` and `@privy-io/wagmi@0.2.13`.
- API manifest requests `@privy-io/server-auth@^1.18.0`; the lockfile installs
  `@privy-io/server-auth@1.32.5`. The package is marked deprecated in favor of
  `@privy-io/node`, but the current server auth path still verifies Privy JWTs
  with `PrivyClient`.
- `apps/web/app/providers.tsx` wraps the app in `PrivyProvider` only when
  `NEXT_PUBLIC_PRIVY_APP_ID` is set. It configures
  `loginMethods: ["email", "google", "wallet"]`, auto-creates embedded wallets
  for users without wallets, and pins Privy/wagmi to Arbitrum.
- `apps/web/components/agent-trade/OnboardingClient.tsx` imports
  `useFundWallet`, but the funding CTA only opens when Privy env, wallet,
  live eligibility, `NEXT_PUBLIC_AGENT_TRADE_ENABLE_PRIVY_FIAT_ONRAMP=true`,
  `NEXT_PUBLIC_AGENT_TRADE_PRIVY_FIAT_ONRAMP_CONFIGURED=true`, and a callable
  SDK hook are all present. The older
  `NEXT_PUBLIC_AGENT_TRADE_ENABLE_PRIVY_FUNDING=true` is treated as a legacy
  alias for the product flag, but dashboard/config approval is still required.
- `apps/api/src/helpers/privyAuth.ts` verifies Privy JWTs with
  `PRIVY_APP_ID` and `PRIVY_APP_SECRET`, then prefers a Privy embedded wallet
  address over external linked wallets.
- Hyperliquid's official exchange docs define `approveAgent` as the action
  that approves an API Wallet, also called an Agent Wallet. The related
  Hyperliquid API wallet docs say API wallets sign on behalf of the master
  account, while reads must still use the master account address.

## Current Support Matrix

| Capability | Repo wiring | Installed SDK support | Dashboard-configured per brief | Exposed today | Safe claim |
| --- | --- | --- | --- | --- | --- |
| Google/social login | `loginMethods` includes `google` | Yes, via Privy auth | Yes, if Google OAuth is enabled | Yes when `NEXT_PUBLIC_PRIVY_APP_ID` is set | Supported when configured |
| Email login | `loginMethods` includes `email` | Yes, via Privy auth | Yes, if email auth is enabled | Yes when `NEXT_PUBLIC_PRIVY_APP_ID` is set | Supported when configured |
| Wallet login | `loginMethods` includes `wallet` | Yes, via Privy auth | Yes, if wallet auth is enabled | Yes when `NEXT_PUBLIC_PRIVY_APP_ID` is set | Supported when configured |
| Embedded wallets | `embeddedWallets.createOnLogin = "users-without-wallets"` | Yes | Yes, if embedded wallets are enabled | Yes when Privy is configured | Supported when configured |
| Fiat onramp | `useFundWallet` imported and gated | Generic funding hook exists; types mention external wallets, MoonPay, and Coinbase onramp | MoonPay/Stripe reportedly configured | No, product flag default-off/absent | Future, provider-dependent |
| Bank deposit / ACH | No explicit app flow | MoonPay type includes ACH-like payment methods, but no Agent.trade wiring | Unknown beyond provider config | No | Not supported today |
| Apple Pay / Google Pay | No explicit app flow | SDK UI/assets mention mobile wallets/payment request, but no Agent.trade wiring or QA | Unknown beyond provider config | No | Not supported today |
| Crypto deposit address via Relay | No app API, hook, route, or UI flow found | No Relay/deposit-address API found in installed Privy package search | Deposit Address/Relay reportedly enabled | No | Future only |
| Hyperliquid Bridge2 deposit | Legacy compatibility path in `/approve` | Via app-owned USDC transfer, not Privy funding | Not a Privy dashboard capability | Default-off behind `NEXT_PUBLIC_AGENT_TRADE_ENABLE_HL_BRIDGE_DEPOSIT` plus legacy approval gate | Internal compatibility only |
| One-tap trading / API wallet approval | Shared/API schemas support `approveAgent`; UI shows future status only | Current SDK exports the action type but no high-level `approveAgent` helper method | Requires future key custody/ops design | No | Coming soon only |

## Builder Approval Vs API Wallet Approval

Agent.trade has two different Hyperliquid permissions that should not be
collapsed in copy or readiness checks:

- **Builder approval (`approveBuilderFee`)** lets Hyperliquid apply the
  configured Agent.trade builder address and fee ceiling to user-signed orders.
  It does not remove current MVP confirmation or wallet-signing requirements.
- **API wallet approval (`approveAgent`)** authorizes a dedicated Hyperliquid
  API Wallet, also called an Agent Wallet, to sign trading actions on behalf of
  the user's master account. This is the primitive needed for future one-tap
  trading where the user confirms inside Agent.trade without repeated wallet
  popups.

Current onboarding/settings copy should therefore say:

- "You confirm orders in Agent.trade."
- "Current MVP may still ask for wallet signatures until one-tap trading is
  enabled."
- "One-tap trading: coming soon."

It should not promise that users will review and sign every order forever.

### Repo Support Today

- `packages/shared/src/action.ts` defines `ApproveAgentAction` with
  `agentAddress`, optional `agentName`, matching nonce fields, and revocation
  semantics.
- `apps/api/src/routes/exchange.ts` can build `approveAgent` typed data and
  derive a per-user agent address from `AGENT_MASTER_SEED` when configured.
- `apps/api/src/helpers/verify.ts` verifies `approveAgent` signatures.
- `apps/api/src/routes/agent.ts` explicitly rejects `approveAgent` on the
  agent-signed route because it must be signed by the user's primary wallet.
- `packages/sdk/src/client.ts` supports agent-JWT mode after a user has signed
  `approveAgent`, but the SDK currently exposes no high-level
  `approveAgent(...)` helper analogous to `approveBuilder(...)`.

### What Remains For True One-Tap Trading

- Decide API wallet custody: HSM, encrypted per-user keys, sharded derivation,
  or another non-plaintext production model. Do not store API wallet private
  keys in this pass.
- Add an explicit user-facing API wallet approval flow with clear revocation
  semantics and no implication that builder approval alone enables one-tap.
- Add server-side caps, per-order and daily limits, kill switch integration,
  audit logging, idempotency, nonce management, and replay protection on the
  agent-signed path.
- Add a readiness/readback model for API wallet status, including approved,
  missing, revoked, expired/pruned, and unavailable states.
- Keep restricted users paper-only and keep `/agent-trade/exchange` semantics
  unchanged until the one-tap path is separately designed and reviewed.

## Env Flag State

- `.env.example` documents `NEXT_PUBLIC_AGENT_TRADE_ENABLE_PRIVY_FUNDING=false`
  and `NEXT_PUBLIC_AGENT_TRADE_ENABLE_HL_BRIDGE_DEPOSIT=false`.
- Local `.env` has `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_ID`, and
  `PRIVY_APP_SECRET` set, but does not define
  `NEXT_PUBLIC_AGENT_TRADE_ENABLE_PRIVY_FUNDING` or
  `NEXT_PUBLIC_AGENT_TRADE_ENABLE_HL_BRIDGE_DEPOSIT`; both therefore evaluate
  false in current app wiring.
- `render.yaml` defines/syncs Privy app IDs/secrets but does not define the
  Agent.trade funding or Bridge2 public flags.

## Copy Audit

Current user-facing copy is mostly conservative:

- FAQ says Privy supports configured email, Google, existing-wallet login, and
  embedded wallet creation, while funding and deposit paths are environment
  gated and not enabled by default.
- `llms.txt` says funding and deposit paths are default-off and require explicit
  flags, live eligibility, and compliance review.
- `/onboarding` and `/settings` present funding as paper-first unless every
  gate passes. MoonPay, Stripe, and deposit address copy is explicitly future
  or SDK-validation gated.
- `docs/product/agent-trade-prd.md` contains aspirational onramp language such
  as "credit card/on-ramp if feasible"; it is acceptable as PRD roadmap copy,
  but should not be copied into public launch copy as current support.

## Steps To Expose Funding Later

### MoonPay / Generic Fiat Onramp

1. Confirm Privy dashboard has the intended provider enabled for the target
   app and environment.
2. Confirm provider-supported regions, KYC requirements, assets, chains,
   payment methods, fee disclosure, and test/sandbox behavior.
3. Decide exact supported destination: wallet balance only, not Hyperliquid
   account deposit.
4. Add product copy that says "fund wallet" rather than "deposit to
   Hyperliquid".
5. QA `useFundWallet(address, config)` with explicit chain/asset/amount config
   where needed; verify Arbitrum USDC behavior if that is the intended asset.
6. Keep geo eligibility, kill switch, wallet readiness, and confirmation rules
   unchanged.
7. Set `NEXT_PUBLIC_AGENT_TRADE_ENABLE_PRIVY_FUNDING=true` only in an approved
   environment after legal/compliance signoff and end-to-end QA.

### Stripe

1. Do not claim Stripe until installed SDK/package support is verified. Current
   installed declarations did not expose a Stripe-specific funding API.
2. Confirm whether Stripe is only dashboard/provider routing behind Privy's
   generic funding modal or requires a newer SDK/package/API.
3. Add a package smoke test for the exact API surface before adding copy or CTA
   labels that name Stripe.
4. Run the same compliance, region, payment-method, and end-to-end checks as
   MoonPay.

### Deposit Address / Relay

1. Do not expose deposit-address copy from current repo state. No installed
   Privy Relay/deposit-address API was found in the app package search.
2. Confirm whether Deposit Address/Relay is dashboard-only, a newer Privy SDK
   API, or a separate backend integration.
3. Define destination semantics: deposit to embedded wallet, bridge/route to a
   chain asset, or deposit/credit into Hyperliquid. These are separate user
   promises.
4. Add server-side observability and failure states before launch: pending,
   detected, credited, failed, unsupported asset/network, and delayed provider
   settlement.
5. Only then add a feature flag separate from fiat onramp if deposit-address
   support has materially different risk or compliance requirements.

### ACH / Bank, Apple Pay, Google Pay

1. Treat these as provider payment methods, not Agent.trade support, until a
   tested provider flow proves they are available for target regions/devices.
2. Name these methods in UI only after provider docs/dashboard, SDK config,
   device/browser support, and compliance review are complete.

## Risks And Compliance Notes

- Funding a Privy wallet is not the same as depositing into Hyperliquid; copy
  must preserve that distinction.
- Dashboard configuration alone is not enough. Claims require installed SDK
  support, app feature flag enablement, legal/compliance approval, and
  end-to-end QA.
- Restricted or unknown eligibility must continue to disable live funding,
  live trading, legacy approval, and deposit compatibility actions.
- Provider flows may fail by region, KYC status, payment method, asset, chain,
  amount, or user cancellation; the app must show non-trading fallback states.
- `@privy-io/server-auth` is installed but deprecated. Plan a low-risk migration
  to `@privy-io/node` before expanding sensitive auth/funding surfaces.

## Recommended Milestones

### 6A Login / Readiness Polish

- Keep current supported claims to email, Google, existing wallet, and embedded
  wallet when Privy is configured.
- Add/maintain smoke tests for `PrivyProvider`, `usePrivy`, `useWallets`,
  `useFundWallet`, and `@privy-io/wagmi`.
- Tighten readiness copy and public docs around wallet-funded versus
  Hyperliquid-funded state.
- Show a single readiness overview across onboarding and settings that names:
  sign-in methods available, embedded wallet state, eligibility, paper/live
  mode, and funding gate state.
- Use provider-neutral funding copy in the app until a provider-specific SDK
  path, product flag, dashboard setting, compliance approval, and end-to-end QA
  are all verified.
- Treat dashboard-configured provider rails and deposit-address setup as
  "configured, not exposed" rather than supported user actions.

### 6B Crypto Deposit Address

- Verify current or upgraded Privy/Relay API surface before any UI.
- Add a separate deposit-address flag and status model if supported.
- Launch internally with wallet-credit semantics first unless Hyperliquid
  account-credit semantics are proven.

### 6C Fiat Onramp

- Enable generic Privy funding only after provider, region, KYC, asset, and
  Arbitrum/USDC configuration are tested.
- Start with provider-neutral copy unless MoonPay or another provider is
  explicitly verified in the installed SDK and dashboard.

### 6D ACH / Bank If Supported

- Treat as a later payment-method expansion, not part of the initial funding
  CTA.
- Add method-specific QA by region/device/provider before naming ACH, bank
  deposit, Apple Pay, or Google Pay in UI.
