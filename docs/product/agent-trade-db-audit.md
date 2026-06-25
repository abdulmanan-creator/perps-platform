# Agent.trade DB-1 Audit Logging Enablement

DB-1 is behavior-preserving audit durability for Agent.trade eligibility and live exchange flow. It does not add users, wallets, paper ledger persistence, admin UI, durable caps, or any product-facing behavior.

## Current Implementation

- Migration: `apps/api/migrations/001_agent_trade_audit.sql`
- Runtime helper: `apps/api/src/helpers/agentTradeAudit.ts`
- Config: `DATABASE_URL` is optional in `apps/api/src/config.ts`
- Dependency: API uses `pg` with a lazy pool only when `DATABASE_URL` is set

Fail-soft contract:

- If `DATABASE_URL` is absent, all audit helpers no-op.
- If a DB write fails, the helper logs a warning and does not throw to the caller.
- `/agent-trade/exchange` response semantics, geo policy, kill switch, risk acknowledgement, min notional, and Hyperliquid forwarding behavior must remain unchanged.

Privacy contract:

- Do not store bearer tokens, Privy JWTs, secrets, private keys, raw signatures, replay keys, raw IPs, or full raw headers.
- Store wallet addresses and country codes only as operational audit fields.
- Store hashes for payload/signature/replay integrity where sensitive source material is involved.

## Provider Recommendation

Use Render Postgres for the first MVP enablement if `agent-trade-api` remains on Render.

Reasoning:

- Same-vendor setup is simpler for a small audit store.
- Render Postgres provides an internal URL for services in the same account and region; use that for lower-latency private-network access.
- Paid Render Postgres includes point-in-time recovery and logical exports.
- DB-1 write volume is low and synchronous audit failures are fail-soft, so advanced serverless branching is not required yet.

Neon is a good alternative if the team wants provider-neutral Postgres, serverless autoscaling, database branching for preview workflows, or lower idle compute exposure. If Neon is selected, use the normal Neon connection string with SSL enabled and validate latency from Render before production enablement.

References:

- Render Postgres create/connect: https://render.com/docs/postgresql-creating-connecting
- Render Postgres recovery/backups: https://render.com/docs/postgresql-backups
- Neon serverless overview: https://neon.com/docs/introduction/serverless
- Neon with Render guide: https://neon.com/docs/guides/render

## Manual Enablement Plan

Do not enable `DATABASE_URL` on production until the migration has been applied and a rollback owner is present.

### 1. Create The Database

Render Postgres path:

1. In Render, create a new Postgres database.
2. Name it clearly, for example `agent-trade-audit-prod`.
3. Put it in the same region as `agent-trade-api`.
4. Use a paid plan for production so backup/recovery is available.
5. Prefer the internal database URL for `agent-trade-api`.

Neon path:

1. Create a Neon project, for example `agent-trade-audit-prod`.
2. Use the default Postgres database or create a dedicated database name.
3. Copy the application connection string without printing it in logs.
4. Keep SSL enabled in the connection string.
5. If using pooled connections, test that migration and runtime inserts both work.

### 2. Apply The Migration

From a trusted operator machine with `psql` installed:

```bash
read -s DATABASE_URL
export DATABASE_URL
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/migrations/001_agent_trade_audit.sql
unset DATABASE_URL
```

If using Render Postgres, the migration can also be applied from a Render shell or one-off job that has temporary DB access. Do not paste the connection string into chat, tickets, shell history, or logs.

Schema verification:

```bash
read -s DATABASE_URL
export DATABASE_URL
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\dt"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\d audit_events"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\d eligibility_checks"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\d exchange_submissions"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\d exchange_responses"
unset DATABASE_URL
```

Expected tables:

- `audit_events`
- `eligibility_checks`
- `exchange_submissions`
- `exchange_responses`

### 3. Set Render Env

After migration is applied:

1. Open Render service `agent-trade-api`.
2. Click `Environment` in the left pane.
3. Under `Environment Variables`, add `DATABASE_URL`.
4. Paste the Render Postgres internal URL if the database is in the same Render account and region.
5. Save with `Save and deploy` or `Save, rebuild, and deploy`.
6. Confirm the deploy succeeds before running audit-write smoke tests.

Do not change:

- `GEO_BLOCK_ENABLED`
- `GEO_FAIL_CLOSED`
- `AGENT_TRADE_REQUIRE_GEO_ELIGIBILITY`
- `AGENT_TRADE_MAINNET_EXECUTION_ENABLED`
- `AGENT_TRADE_LIVE_TRADING_KILL_SWITCH`
- `AGENT_TRADE_MIN_ORDER_NOTIONAL_USD`
- `AGENT_TRADE_ORDER_NOTIONAL_CAP_USD`
- `AGENT_TRADE_DAILY_NOTIONAL_CAP_USD`

### 4. Smoke Test

No-product-behavior smoke:

```bash
curl -sS "$API_URL/healthz"
curl -sS "$API_URL/agent-trade/eligibility"
```

Expected:

- API remains healthy.
- Eligibility response shape is unchanged.
- Restricted or unknown users remain paper-only.
- No live policy changes occur.

Audit-write smoke:

```bash
read -s DATABASE_URL
export DATABASE_URL
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "select count(*) from eligibility_checks;"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "select event_type, count(*) from audit_events group by event_type order by event_type;"
unset DATABASE_URL
```

Expected after one `/agent-trade/eligibility` request:

- `eligibility_checks` count increases.
- `audit_events` includes `agent_trade.eligibility_checked`.

Exchange audit smoke should use the normal internal tester flow and the smallest safe action that already passed live/testnet policy. Do not create special bypasses for audit validation.

Expected exchange audit rows:

- Phase A build success: `exchange_submissions.phase='build'` and `status='started'/'built'`
- Phase B send success: `exchange_submissions.phase='send'` and `status='started'/'forwarded'`
- Hyperliquid response summary: row in `exchange_responses`

### 5. Logs To Watch

Search API logs for:

- `audit_event_write_failed`
- `eligibility_check_write_failed`
- `exchange_submission_write_failed`
- `exchange_response_write_failed`

Any of those warnings means audit durability is degraded, but request behavior should remain unchanged by design.

## Operator Verification

Use these checks after the `agent-trade-api` redeploy. Do not print or paste the connection string in logs.

### Confirm Audit Logging Is Enabled

1. Confirm `agent-trade-api` has a `DATABASE_URL` env var in Render.
2. Confirm the latest `agent-trade-api` deploy finished successfully.
3. Call `/agent-trade/eligibility` once through the production API.
4. Check the database for a new `eligibility_checks` row and an `agent_trade.eligibility_checked` audit event.
5. Check API logs for absence of audit write warnings.

Schema and enabled-state queries:

```bash
read -s DATABASE_URL
export DATABASE_URL
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "select to_regclass('public.audit_events') as audit_events, to_regclass('public.eligibility_checks') as eligibility_checks, to_regclass('public.exchange_submissions') as exchange_submissions, to_regclass('public.exchange_responses') as exchange_responses;"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "select count(*) as eligibility_check_count from eligibility_checks;"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "select event_type, count(*) from audit_events group by event_type order by event_type;"
unset DATABASE_URL
```

Recent eligibility checks:

```sql
select
  created_at,
  request_id,
  eligibility_state,
  country_code,
  country_source,
  geo_fail_closed,
  require_geo_eligibility,
  kill_switch_enabled,
  mainnet_execution_enabled,
  execution_venue,
  decision_reason
from eligibility_checks
order by created_at desc
limit 20;
```

Recent exchange submissions:

```sql
select
  created_at,
  request_id,
  wallet_address,
  phase,
  status,
  action_type,
  nonce,
  signer_wallet_address,
  builder_fee_bps,
  is_mainnet,
  error_code,
  error_message
from exchange_submissions
order by created_at desc
limit 20;
```

Recent Hyperliquid response summaries:

```sql
select
  created_at,
  request_id,
  wallet_address,
  success,
  response_status,
  error_code,
  error_message,
  error_guidance,
  hl_oid,
  hl_cloid,
  latency_ms
from exchange_responses
order by created_at desc
limit 20;
```

Audit integrity spot check:

```sql
select
  occurred_at,
  request_id,
  event_type,
  severity,
  payload_hash,
  previous_event_hash,
  event_hash
from audit_events
order by occurred_at desc
limit 20;
```

Expected results:

- `eligibility_checks` increments after `/agent-trade/eligibility`.
- `audit_events` includes `agent_trade.eligibility_checked`.
- Live exchange attempts create `exchange_submissions` rows only through the existing guarded `/agent-trade/exchange` flow.
- Successful forwarded exchange sends create `exchange_responses` rows.
- API responses remain unchanged.
- No `audit_event_write_failed`, `eligibility_check_write_failed`, `exchange_submission_write_failed`, or `exchange_response_write_failed` warnings appear in logs.

### Roll Back Audit Logging

1. Open Render service `agent-trade-api`.
2. Click `Environment`.
3. Remove or unset `DATABASE_URL`.
4. Save with `Save and deploy`.
5. Confirm `/healthz` and `/agent-trade/eligibility` still return the same response shape.
6. Confirm no new audit rows are written after rollback.

Rollback does not require dropping tables. Leave the DB intact unless the incident owner explicitly decides otherwise.

## Rollback / No-op Plan

Fast rollback:

1. Remove or unset `DATABASE_URL` from `agent-trade-api`.
2. Redeploy `agent-trade-api`.
3. Smoke `/healthz` and `/agent-trade/eligibility`.

Expected rollback behavior:

- Audit helpers no-op again.
- Existing DB tables remain untouched.
- Product behavior remains unchanged.

DB rollback:

- Do not drop audit tables during an incident unless storage or DB health requires it.
- If data removal is required, export first according to the incident owner/legal retention decision.

## Local Verification

No local DB required:

```bash
git diff --check
npm run typecheck
npm run test
npm run build
```

Optional local DB smoke:

```bash
createdb agent_trade_audit_local
export DATABASE_URL=postgres://localhost/agent_trade_audit_local
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/migrations/001_agent_trade_audit.sql
npm run test -w @alchemy-hl/api -- agentTradeAudit
unset DATABASE_URL
```

Keep local DB credentials out of committed files and shell transcripts.
