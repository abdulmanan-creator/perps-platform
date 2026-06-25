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
2. Add secret env var `DATABASE_URL`.
3. Use the Render Postgres internal URL if the database is in the same Render account and region.
4. Do not change trading policy env vars in this step.
5. Redeploy `agent-trade-api`.

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
