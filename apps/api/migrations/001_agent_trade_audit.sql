-- DB-1: Agent.trade behavior-preserving audit logging.
-- Apply manually in the configured Postgres database before setting DATABASE_URL.

create extension if not exists pgcrypto;

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  request_id text null,
  actor_type text not null default 'system',
  actor_id text null,
  wallet_address text null,
  route text null,
  event_type text not null,
  severity text not null default 'info',
  eligibility_state text null,
  country_code text null,
  payload jsonb not null default '{}',
  payload_hash text not null,
  previous_event_hash text null,
  event_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_occurred_idx
  on audit_events (occurred_at desc);
create index if not exists audit_events_request_idx
  on audit_events (request_id);
create index if not exists audit_events_wallet_idx
  on audit_events (wallet_address, occurred_at desc);
create index if not exists audit_events_type_idx
  on audit_events (event_type, occurred_at desc);
create unique index if not exists audit_events_hash_idx
  on audit_events (event_hash);

create table if not exists eligibility_checks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  request_id text null,
  wallet_address text null,
  eligibility_state text not null,
  country_code text null,
  country_source text null,
  geo_fail_closed boolean null,
  require_geo_eligibility boolean null,
  kill_switch_enabled boolean null,
  mainnet_execution_enabled boolean null,
  execution_venue text null,
  decision_reason text null,
  raw_context_redacted jsonb not null default '{}'
);

create index if not exists eligibility_checks_created_idx
  on eligibility_checks (created_at desc);
create index if not exists eligibility_checks_wallet_idx
  on eligibility_checks (wallet_address, created_at desc);
create index if not exists eligibility_checks_state_idx
  on eligibility_checks (eligibility_state, created_at desc);

create table if not exists exchange_submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  request_id text null,
  wallet_address text null,
  phase text not null,
  route text not null default '/agent-trade/exchange',
  action_type text null,
  action_hash text null,
  nonce text null,
  signer_wallet_address text null,
  signature_hash text null,
  replay_key_hash text null,
  builder_address text null,
  builder_fee_bps int null,
  is_mainnet boolean null,
  status text not null,
  error_code text null,
  error_message text null,
  redacted_payload jsonb not null default '{}'
);

create index if not exists exchange_submissions_created_idx
  on exchange_submissions (created_at desc);
create index if not exists exchange_submissions_wallet_idx
  on exchange_submissions (wallet_address, created_at desc);
create index if not exists exchange_submissions_action_hash_idx
  on exchange_submissions (action_hash);
create index if not exists exchange_submissions_status_idx
  on exchange_submissions (status, created_at desc);
create index if not exists exchange_submissions_replay_idx
  on exchange_submissions (replay_key_hash)
  where replay_key_hash is not null;

create table if not exists exchange_responses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  exchange_submission_id uuid null references exchange_submissions(id),
  request_id text null,
  wallet_address text null,
  provider text not null default 'hyperliquid',
  http_status int null,
  success boolean not null,
  response_status text null,
  response_payload jsonb null,
  error_code text null,
  error_message text null,
  error_guidance text null,
  hl_oid text null,
  hl_cloid text null,
  latency_ms int null
);

create index if not exists exchange_responses_created_idx
  on exchange_responses (created_at desc);
create index if not exists exchange_responses_submission_idx
  on exchange_responses (exchange_submission_id);
create index if not exists exchange_responses_wallet_idx
  on exchange_responses (wallet_address, created_at desc);
create index if not exists exchange_responses_hl_oid_idx
  on exchange_responses (hl_oid)
  where hl_oid is not null;
