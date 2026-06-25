# Agent.trade Connectors Audit And Plan

Last audited: 2026-06-25

## Product Position

Agent.trade connectors should launch as assistant research and draft handoff surfaces.

The assistant can:

- Read public market data and user-authorized account context.
- Explain a setup with sourced context.
- Draft a paper or live trade proposal.
- Deep-link the user back to Agent.trade for review.

The assistant must not:

- Place a live trade directly in the current MVP.
- Bypass Agent.trade eligibility, caps, risk acknowledgement, wallet signature, or explicit confirmation.
- Request broad unattended execution permissions as part of the safe launch.

Future permissioned execution can exist, but it needs explicit scopes, caps, revocation, auditability, eligibility checks, and kill switches before it is product-live.

## Current Connector State

### Web Routes

| Route | Current state | Notes |
|---|---|---|
| `/connectors` | Safe current-product copy | Frames Claude and ChatGPT as market context, draft proposal, and terminal confirmation. States that connectors do not bypass eligibility, caps, acknowledgements, or confirmation. |
| `/connect/claude` | Safe current-product copy | Shows the MCP URL and Claude setup steps, but repeatedly states research/draft only and that orders return to Agent.trade. |
| `/connect/chatgpt` | Safe current-product copy | Same framing as Claude: research, sourced context, draft handoff, and Agent.trade confirmation. |
| `/oauth/authorize` | Fail-closed by default | Returns the compatibility-disabled screen unless `NEXT_PUBLIC_AGENT_TRADE_ENABLE_OAUTH_COMPAT_APPROVALS=true`. When enabled, it can request legacy `approveBuilderFee` and `approveAgent` signatures through generic `/exchange`. |
| `/approve` | Fail-closed by default | Returns the legacy-disabled screen unless `NEXT_PUBLIC_AGENT_TRADE_ENABLE_LEGACY_APPROVALS=true`. When enabled and live-eligible, it can build/sign/send `approveBuilderFee` through generic `/exchange`; Bridge2 deposit is separately gated. |

### Public Copy Gap

`apps/web/public/llms.txt` still describes the previous hosted MCP product as execution-capable: OAuth plus `approveAgent`, `place_market_order`, `place_limit_order`, `cancel_order`, `set_leverage`, and `approve_builder`. That conflicts with the current Agent.trade stance. It should be revised before any safe connector launch so external assistants do not ingest stale execution claims.

### Feature Flags

| Flag | Current default | Effect |
|---|---:|---|
| `NEXT_PUBLIC_AGENT_TRADE_ENABLE_LEGACY_APPROVALS` | `false` | Hides `/approve` legacy builder-fee approval flow. |
| `NEXT_PUBLIC_AGENT_TRADE_ENABLE_OAUTH_COMPAT_APPROVALS` | `false` | Hides `/oauth/authorize` compatibility approval flow and prevents OAuth route UI from requesting `approveBuilderFee` or `approveAgent`. |
| `NEXT_PUBLIC_AGENT_TRADE_ENABLE_HL_BRIDGE_DEPOSIT` | `false` | Hides Bridge2 deposit compatibility UI even when `/approve` is enabled. |
| `AGENT_TRADE_REQUIRE_GEO_ELIGIBILITY` | `true` | Unknown/missing country fail-closes Agent.trade live trading. |
| `AGENT_TRADE_REQUIRE_RISK_ACK` | `true` | `/agent-trade/exchange` and guarded `/agent/exchange` actions require explicit risk and terms headers. |
| `AGENT_TRADE_MAINNET_EXECUTION_ENABLED` | `false` | Blocks Agent.trade mainnet execution unless explicitly enabled. |
| `AGENT_TRADE_LIVE_TRADING_KILL_SWITCH` | `false` | Emergency switch; when true, live Agent.trade trading is blocked. |

Do not loosen these flags for the research/draft launch.

## Current Backend Mechanics

The connector backend is inherited from the earlier Alchemy Hyperliquid builder-code product.

### Generic `/exchange`

`POST /exchange` is a generic build/sign/send relay for SDK, dashboard, MCP, and legacy callers. It:

- Builds EIP-712 typed data for `order`, `cancel`, `cancelByCloid`, `updateLeverage`, `approveBuilderFee`, and `approveAgent`.
- Injects the configured builder fee for order actions.
- Recovers the user signer on send.
- Forwards the signed payload to Hyperliquid.
- Intentionally remains backward-compatible and is not the Agent.trade confirmation surface.

Do not change `/agent-trade/exchange` semantics as part of connector planning.

### Agent.trade `/agent-trade/exchange`

`POST /agent-trade/exchange` wraps the generic exchange machinery with Agent.trade controls:

- Geo eligibility fail-closed behavior.
- Kill switch.
- Mainnet execution flag.
- Minimum order notional.
- Per-order and daily notional caps.
- Risk and terms acknowledgement headers.
- Audit logging through the Agent.trade audit helpers.

This is the correct live order confirmation endpoint for Agent.trade terminal flows after the user confirms inside Agent.trade.

### Legacy `/agent` And `/agent/exchange`

`GET /agent` returns a deterministic per-user agent address derived from `AGENT_MASTER_SEED`.

`POST /agent/exchange` is the inherited unattended connector path. It:

- Verifies a Privy or OAuth bearer token.
- Derives the user's agent key from `AGENT_MASTER_SEED`.
- Server-signs agent-signable actions.
- Forwards to Hyperliquid.
- Refuses `approveBuilderFee` and `approveAgent` because those require the user's primary wallet.
- Applies the Agent.trade safety helper to guarded actions (`order`, `updateLeverage`, `approveAgent`, `approveBuilderFee`).
- Uses idempotency keys to avoid duplicate agent-path submissions.

This path exists and can execute when the environment is configured and the user has compatible approval. It should not be exposed as the Agent.trade MVP connector behavior.

### OAuth

The backend OAuth flow is split across API, MCP, and web:

- MCP server exposes OAuth metadata, dynamic client registration, `/authorize`, and `/oauth/token`.
- `/authorize` redirects to web `/oauth/authorize`.
- Web `/oauth/authorize` is default-disabled by `NEXT_PUBLIC_AGENT_TRADE_ENABLE_OAUTH_COMPAT_APPROVALS`.
- API `/oauth/issue-code` verifies Privy auth and issues a short-lived signed auth-code JWT.
- API `/oauth/exchange-code` verifies the auth code, redirect URI, client id, optional PKCE, and returns a 24-hour access-token JWT.
- MCP verifies access tokens against `OAUTH_SIGNING_SECRET` and passes the token to SDK agent mode.

Current OAuth gaps for permissioned execution:

- Auth codes are stateless JWTs, not single-use records.
- Access tokens have no server-side revocation list.
- Scopes are advertised as `read` and `trade`, but tool-level enforcement is not scoped for a safe Agent.trade permission model.
- Dynamic client registration is deterministic by redirect URI and does not persist client policy.

## Current MCP Mechanics

`packages/mcp-server` supports:

- `stdio` transport with optional `ALCHEMY_HL_TRADE_KEY` hot-key signing.
- `http` transport with OAuth bearer tokens.
- Read tools for markets, prices, balances, positions, open orders, fills, approval, and prediction markets.
- Write tools for market orders, limit orders, trigger orders, prediction trades, close position, cancel order, set leverage, and approve builder.

For Agent.trade safe launch, the existing MCP write tools are not acceptable as-is. They should be removed, hidden, or replaced with draft/deep-link tools before launch.

## Safe Launch Scope

### 7A: Research/Draft Connector

Launch with read and draft tools only.

Allowed tools:

- `get_markets`
- `get_market_price`
- `get_market_stats`
- `get_l2_book`
- `get_prediction_markets`
- `get_prediction_odds`
- `get_balance` when authenticated or when the user supplies an address
- `get_positions` when authenticated or when the user supplies an address
- `get_open_orders` when authenticated or when the user supplies an address
- `get_fills` when authenticated or when the user supplies an address
- `draft_trade_proposal`
- `draft_risk_summary`

Disallowed for 7A:

- `place_market_order`
- `place_limit_order`
- `place_trigger_order`
- `trade_prediction_market`
- `close_position`
- `cancel_order`
- `set_leverage`
- `approve_builder`
- Any tool that calls `/agent/exchange`, `/exchange` send phase, or `/agent-trade/exchange`.

The draft tool should return a structured proposal, not an executable action:

- Symbol/market.
- Direction.
- Entry idea.
- Size or notional suggestion.
- Leverage suggestion.
- Reduce-only flag.
- TP/SL.
- Rationale.
- Risks and invalidation.
- Deep link payload id or encoded draft.

### 7B: Deep-Link/Order Handoff To Agent.trade Confirmation

Add a backend draft endpoint and a web handoff route.

Required endpoints:

- `POST /agent-trade/connector-drafts`
  - Auth: OAuth bearer token for user-bound drafts, or anonymous session for public/paper drafts.
  - Body: normalized draft proposal, source connector, source conversation id if available, client id, optional idempotency key.
  - Response: `{ draftId, expiresAt, reviewUrl }`.
  - No Hyperliquid action is built or signed.

- `GET /agent-trade/connector-drafts/:draftId`
  - Auth: same user/session as creator for private account-linked drafts.
  - Returns the normalized draft and source metadata.

- Web route `/terminal?draftId=...` or `/review/:draftId`
  - Loads the draft.
  - Re-runs current market/account/eligibility checks.
  - Shows risk acknowledgement.
  - Requires wallet signature and explicit confirmation for live.
  - Uses existing `/agent-trade/exchange` only after confirmation.
  - Uses paper endpoints only after paper confirmation.

Draft storage requirements:

- TTL, for example 30 minutes.
- Immutable proposal body once created.
- Explicit status: `created`, `opened`, `confirmed`, `expired`, `cancelled`.
- Audit events for draft creation, open, confirmation, and expiration.
- No secret material.

### 7C: Permissioned Execution Design

Future only. Do not ship as current MVP.

Permissioned execution should be a separate product mode with explicit enrollment:

- User opens Agent.trade permission settings, not a generic connector setup page.
- User chooses scopes:
  - Read account.
  - Draft only.
  - Paper execution.
  - Cancel resting orders.
  - Reduce-only close.
  - Live order placement.
  - Leverage changes.
  - Prediction-market trading.
- User chooses caps:
  - Per-order notional cap.
  - Daily notional cap.
  - Per-market cap.
  - Max leverage.
  - Allowed symbols.
  - Reduce-only only.
  - Time window and expiry.
- User signs an explicit permission object and, only then, any venue-required authorization such as Hyperliquid `approveAgent`.
- Connector tokens carry permission ids, not broad implicit `trade` authority.
- Every execution validates the permission record at request time.

The execution endpoint should not be the current generic `/agent/exchange` directly. Add an Agent.trade permissioned endpoint that wraps agent signing with first-class policy:

- `POST /agent-trade/connector-execute`
  - Requires OAuth token.
  - Requires active permission grant.
  - Requires idempotency key.
  - Enforces scopes/caps/revocation/eligibility/kill switch.
  - Records audit events before and after forwarding.
  - May call an internal signing primitive, but should not expose raw `/agent/exchange` semantics.

### 7D: Audit, Scopes, Revocation, Caps

Required data model:

- `connector_clients`
  - `client_id`, platform, redirect URIs, display name, status, created_at.
- `connector_tokens`
  - token id/jti, user wallet, client id, scopes, issued_at, expires_at, revoked_at.
- `connector_permission_grants`
  - user wallet, client id, scopes, caps, allowed symbols, expiry, status, signed payload hash, created_at, revoked_at.
- `connector_drafts`
  - draft id, user wallet/session, platform, client id, source metadata, proposal, status, expires_at.
- `connector_execution_attempts`
  - grant id, draft id, idempotency key, action summary, policy decision, rejection reason, Hyperliquid response, timestamps.

Revocation requirements:

- User can revoke a connector token.
- User can revoke a permission grant.
- User can revoke Hyperliquid agent approval when applicable.
- Revocation is effective server-side immediately; do not rely only on JWT expiry.
- Revoked grants must block any cached token or MCP session.

Security requirements:

- Fail closed on unknown eligibility.
- Fail closed on missing permission grant.
- Fail closed on stale/expired grant.
- Server-side caps are authoritative; MCP descriptions are advisory.
- Separate read scopes from draft scopes from execution scopes.
- Enforce tool allowlists server-side, not only in prompt/tool descriptions.
- Require idempotency keys for any execution path.
- Store token ids or hashes for revocation; avoid logging bearer tokens.
- Add OAuth `state`, PKCE, exact redirect URI matching, client id binding, and single-use auth-code records.
- Add platform allowlist before production DCR, or persist DCR clients with review status.
- Add audit log coverage for draft and permission events, not just exchange forwarding.

## Claude UX Flow

Safe launch:

1. User opens `/connect/claude`.
2. User copies the MCP URL into Claude custom connectors.
3. Claude connects and can call read/draft tools.
4. User asks for a market read or proposal.
5. Connector creates a draft and returns a review link.
6. User opens Agent.trade.
7. Agent.trade revalidates eligibility, account state, market data, risk, caps, and confirmation.
8. User signs and confirms in Agent.trade if live execution is available; otherwise uses paper mode.

Copy rule:

- Claude can "draft" or "prepare for review."
- Claude must not say it "placed," "submitted," "executed," or "confirmed" a live order.

## ChatGPT UX Flow

Safe launch:

1. User opens `/connect/chatgpt`.
2. User registers the MCP server as a ChatGPT app.
3. ChatGPT connects and can call read/draft tools.
4. User asks `@Agent.trade` for context or a proposed setup.
5. Connector returns sourced reasoning and an Agent.trade review link.
6. All order review and confirmation happens inside Agent.trade.

Copy rule:

- ChatGPT can "send a proposal to Agent.trade."
- ChatGPT must not claim direct live trading in the current MVP.

## Required Backend Work Before Safe Launch

1. Add a research/draft MCP mode that exposes no write tools.
2. Remove or hide existing MCP write tools from the hosted Agent.trade connector.
3. Add connector draft creation and fetch endpoints.
4. Add draft audit events.
5. Add review-link loading in Agent.trade terminal or a dedicated review route.
6. Update `llms.txt` and MCP README to match the research/draft stance.
7. Add tests that assert hosted Agent.trade MCP tool list excludes execution tools.
8. Add tests that `/oauth/authorize` and `/approve` stay disabled by default.
9. Add tests that connector drafts never call `/exchange`, `/agent/exchange`, or `/agent-trade/exchange`.

## Non-Goals For This Phase

- Do not enable autonomous execution.
- Do not set `NEXT_PUBLIC_AGENT_TRADE_ENABLE_LEGACY_APPROVALS=true`.
- Do not set `NEXT_PUBLIC_AGENT_TRADE_ENABLE_OAUTH_COMPAT_APPROVALS=true`.
- Do not expose `approveAgent` as safe-launch onboarding.
- Do not expose `/agent/exchange` through Claude or ChatGPT for Agent.trade MVP.
- Do not change `/agent-trade/exchange` semantics.
- Do not change terminal or websocket files.
- Do not modify deployed `alchemy-hl-*` service config.

