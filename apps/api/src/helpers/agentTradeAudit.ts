import { createHash } from "node:crypto";

import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

import type { Action } from "@alchemy-hl/shared";

import type { Config } from "../config.js";
import { ApiException } from "../errors.js";
import { actionNotionalUsd, type EligibilityState } from "./agentTradeSafety.js";
import { resolveCountry } from "./geo.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface AuditDb {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

export interface ExchangeSubmissionAuditInput {
  req: FastifyRequest;
  cfg: Config;
  phase: "build" | "send";
  route: string;
  status: "started" | "built" | "forwarded" | "failed";
  action?: Action;
  user?: `0x${string}`;
  signer?: `0x${string}`;
  nonce?: number;
  signature?: { r: `0x${string}`; s: `0x${string}`; v: number };
  builderFeeBps?: number;
  error?: unknown;
  redactedPayload?: unknown;
}

export interface ExchangeResponseAuditInput {
  req: FastifyRequest;
  cfg: Config;
  exchangeSubmissionId?: string | null;
  walletAddress?: string | null;
  success: boolean;
  responsePayload?: unknown;
  error?: unknown;
  latencyMs?: number | null;
}

let pool: Pool | null | undefined;
let auditDbOverride: AuditDb | null | undefined;

export function setAuditDbForTests(db: AuditDb | null | undefined): void {
  auditDbOverride = db;
}

export function resetAuditDbForTests(): void {
  auditDbOverride = undefined;
  if (pool) {
    void pool.end().catch(() => undefined);
  }
  pool = undefined;
}

export function isAuditEnabled(cfg: Pick<Config, "DATABASE_URL">): boolean {
  return Boolean(cfg.DATABASE_URL) || auditDbOverride !== undefined;
}

export async function recordAuditEvent(input: {
  req?: FastifyRequest;
  cfg: Config;
  actorType?: string;
  actorId?: string | null;
  walletAddress?: string | null;
  route?: string | null;
  eventType: string;
  severity?: "info" | "warn" | "error";
  eligibilityState?: EligibilityState | null;
  countryCode?: string | null;
  payload?: unknown;
}): Promise<void> {
  await failSoft(input.cfg, input.req?.log, "audit_event_write_failed", async (db) => {
    const payload = redactForAudit(input.payload ?? {});
    const payloadHash = hashJson(payload);
    const previous = await latestAuditHash(db);
    const eventHash = hashJson({
      previousEventHash: previous,
      requestId: requestId(input.req),
      eventType: input.eventType,
      payloadHash,
    });

    await db.query(
      `insert into audit_events (
        request_id, actor_type, actor_id, wallet_address, route, event_type,
        severity, eligibility_state, country_code, payload, payload_hash,
        previous_event_hash, event_hash
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
      [
        requestId(input.req),
        input.actorType ?? "system",
        input.actorId ?? null,
        normalizeAddress(input.walletAddress),
        input.route ?? input.req?.routeOptions?.url ?? input.req?.url ?? null,
        input.eventType,
        input.severity ?? "info",
        input.eligibilityState ?? null,
        input.countryCode ?? null,
        JSON.stringify(payload),
        payloadHash,
        previous,
        eventHash,
      ],
    );
  });
}

export async function recordEligibilityCheck(input: {
  req: FastifyRequest;
  cfg: Config;
  eligibilityState: EligibilityState;
  walletAddress?: string | null;
  decisionReason?: string | null;
}): Promise<void> {
  const countryCode = resolveCountry(input.req, input.cfg);
  const countrySource = input.cfg.GEO_COUNTRY_HEADER;
  await failSoft(input.cfg, input.req.log, "eligibility_check_write_failed", async (db) => {
    await db.query(
      `insert into eligibility_checks (
        request_id, wallet_address, eligibility_state, country_code,
        country_source, geo_fail_closed, require_geo_eligibility,
        kill_switch_enabled, mainnet_execution_enabled, execution_venue,
        decision_reason, raw_context_redacted
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [
        requestId(input.req),
        normalizeAddress(input.walletAddress),
        input.eligibilityState,
        countryCode,
        countrySource,
        input.cfg.GEO_FAIL_CLOSED,
        input.cfg.AGENT_TRADE_REQUIRE_GEO_ELIGIBILITY,
        input.cfg.AGENT_TRADE_LIVE_TRADING_KILL_SWITCH,
        input.cfg.AGENT_TRADE_MAINNET_EXECUTION_ENABLED,
        input.cfg.isTestnet ? "hyperliquid-testnet" : "hyperliquid-mainnet",
        input.decisionReason ?? eligibilityDecisionReason(input.eligibilityState),
        JSON.stringify(redactForAudit({
          route: input.req.routeOptions?.url ?? input.req.url,
          method: input.req.method,
          countrySource,
          countryCode,
        })),
      ],
    );
  });
}

export async function recordExchangeSubmission(
  input: ExchangeSubmissionAuditInput,
): Promise<string | null> {
  let insertedId: string | null = null;
  await failSoft(input.cfg, input.req.log, "exchange_submission_write_failed", async (db) => {
    const actionHash = input.action ? hashJson(input.action) : null;
    const signatureHash = input.signature ? hashJson(input.signature) : null;
    const replayKeyHash = input.signature && input.nonce != null
      ? hashString(`${input.signature.r}:${input.signature.s}:${input.signature.v}:${input.nonce}`)
      : null;
    const error = errorParts(input.error);
    const payload = redactForAudit(input.redactedPayload ?? {
      action: summarizeAction(input.action),
      user: normalizeAddress(input.user),
      signer: normalizeAddress(input.signer),
      nonce: input.nonce,
    });

    const result = await db.query<{ id: string }>(
      `insert into exchange_submissions (
        request_id, wallet_address, phase, route, action_type, action_hash,
        nonce, signer_wallet_address, signature_hash, replay_key_hash,
        builder_address, builder_fee_bps, is_mainnet, status, error_code,
        error_message, redacted_payload
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
      returning id`,
      [
        requestId(input.req),
        normalizeAddress(input.signer ?? input.user),
        input.phase,
        input.route,
        input.action?.type ?? null,
        actionHash,
        input.nonce == null ? null : String(input.nonce),
        normalizeAddress(input.signer),
        signatureHash,
        replayKeyHash,
        input.cfg.ALCHEMY_BUILDER_ADDRESS.toLowerCase(),
        input.builderFeeBps ?? builderFeeFromAction(input.action),
        !input.cfg.isTestnet,
        input.status,
        error.code,
        error.message,
        JSON.stringify(payload),
      ],
    );
    insertedId = result.rows[0]?.id ?? null;
  });
  return insertedId;
}

export async function recordExchangeResponse(input: ExchangeResponseAuditInput): Promise<void> {
  await failSoft(input.cfg, input.req.log, "exchange_response_write_failed", async (db) => {
    const parts = errorParts(input.error);
    const response = summarizeExchangeResponse(input.responsePayload);
    await db.query(
      `insert into exchange_responses (
        exchange_submission_id, request_id, wallet_address, provider,
        http_status, success, response_status, response_payload, error_code,
        error_message, error_guidance, hl_oid, hl_cloid, latency_ms
      ) values ($1,$2,$3,'hyperliquid',$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)`,
      [
        input.exchangeSubmissionId ?? null,
        requestId(input.req),
        normalizeAddress(input.walletAddress),
        response.httpStatus,
        input.success,
        response.status,
        input.responsePayload == null ? null : JSON.stringify(redactForAudit(input.responsePayload)),
        parts.code,
        parts.message,
        parts.guidance,
        response.hlOid,
        response.hlCloid,
        input.latencyMs ?? null,
      ],
    );
  });
}

export function redactForAudit(value: unknown): JsonValue {
  return redactValue(value, 0);
}

export function hashJson(value: unknown): string {
  return hashString(stableStringify(redactForAudit(value)));
}

export function requestId(req: FastifyRequest | undefined): string | null {
  if (!req) return null;
  return typeof req.id === "string" ? req.id : String(req.id);
}

function getAuditDb(cfg: Config): AuditDb | null {
  if (auditDbOverride !== undefined) {
    return auditDbOverride;
  }
  if (!cfg.DATABASE_URL) {
    return null;
  }
  if (pool === undefined) {
    pool = new Pool({
      connectionString: cfg.DATABASE_URL,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
    });
  }
  return pool;
}

async function failSoft(
  cfg: Config,
  logger: FastifyBaseLogger | undefined,
  logMessage: string,
  fn: (db: AuditDb) => Promise<void>,
): Promise<void> {
  const db = getAuditDb(cfg);
  if (!db) {
    return;
  }
  try {
    await fn(db);
  } catch (err) {
    logger?.warn({ err }, logMessage);
  }
}

async function latestAuditHash(db: AuditDb): Promise<string | null> {
  const result = await db.query<{ event_hash: string }>(
    "select event_hash from audit_events order by occurred_at desc, created_at desc limit 1",
  );
  return result.rows[0]?.event_hash ?? null;
}

function redactValue(value: unknown, depth: number): JsonValue {
  if (depth > 8) {
    return "[max-depth]";
  }
  if (value == null) {
    return null;
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return typeof value === "string" && looksSensitiveString(value) ? "[redacted]" : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (typeof value !== "object") {
    return String(value);
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactValue(nested, depth + 1);
  }
  return out;
}

function isSensitiveKey(key: string): boolean {
  return /authorization|cookie|token|jwt|secret|private.?key|seed|signature|bearer/iu.test(key);
}

function looksSensitiveString(value: string): boolean {
  return /^Bearer\s+/iu.test(value) || /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./u.test(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeAddress(address?: string | null): string | null {
  if (!address || !/^0x[0-9a-fA-F]{40}$/u.test(address)) {
    return null;
  }
  return address.toLowerCase();
}

function summarizeAction(action: Action | undefined): JsonValue {
  if (!action) {
    return {};
  }
  if (action.type === "order") {
    return {
      type: action.type,
      grouping: action.grouping,
      orderCount: action.orders.length,
      notionalUsd: actionNotionalUsd(action),
      assets: action.orders.map((order) => order.a),
      reduceOnly: action.orders.some((order) => order.r),
      builder: action.builder ? { b: normalizeAddress(action.builder.b), f: action.builder.f } : null,
    };
  }
  return { type: action.type };
}

function builderFeeFromAction(action: Action | undefined): number | null {
  if (!action || action.type !== "order") {
    return null;
  }
  return action.builder?.f ?? null;
}

function errorParts(error: unknown): {
  code: string | null;
  message: string | null;
  guidance: string | null;
} {
  if (!error) {
    return { code: null, message: null, guidance: null };
  }
  if (error instanceof ApiException) {
    return { code: error.code, message: error.message, guidance: error.guidance };
  }
  if (error instanceof Error) {
    return { code: null, message: error.message, guidance: null };
  }
  return { code: null, message: String(error), guidance: null };
}

function summarizeExchangeResponse(payload: unknown): {
  httpStatus: number | null;
  status: string | null;
  hlOid: string | null;
  hlCloid: string | null;
} {
  const found = findHlIds(payload);
  const status = typeof payload === "object" && payload !== null && "status" in payload
    ? String((payload as { status?: unknown }).status)
    : null;
  return {
    httpStatus: null,
    status,
    hlOid: found.oid,
    hlCloid: found.cloid,
  };
}

function findHlIds(value: unknown): { oid: string | null; cloid: string | null } {
  if (value == null || typeof value !== "object") {
    return { oid: null, cloid: null };
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHlIds(item);
      if (found.oid || found.cloid) return found;
    }
    return { oid: null, cloid: null };
  }
  const obj = value as Record<string, unknown>;
  const oid = obj.oid == null ? null : String(obj.oid);
  const cloid = obj.cloid == null ? null : String(obj.cloid);
  if (oid || cloid) {
    return { oid, cloid };
  }
  for (const nested of Object.values(obj)) {
    const found = findHlIds(nested);
    if (found.oid || found.cloid) return found;
  }
  return { oid: null, cloid: null };
}

function eligibilityDecisionReason(state: EligibilityState): string {
  switch (state) {
    case "liveEligible":
      return "eligible";
    case "restricted":
      return "restricted_country";
    case "unknown":
      return "country_unknown_or_unverified";
    case "paper":
      return "paper_mode";
    case "killSwitchDisabled":
      return "kill_switch";
    default:
      return "unknown";
  }
}
