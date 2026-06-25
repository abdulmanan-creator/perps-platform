import { normalizeSymbol } from "./markets";
import type { MarginMode, OrderDraft, OrderType, TradeSide } from "./types";

export type ConnectorDraftPlatform = "claude" | "chatgpt" | "mcp" | "unknown";

export interface ConnectorDraftPayload {
  v: 1;
  source?: ConnectorDraftPlatform;
  symbol: string;
  side: TradeSide;
  orderType: OrderType;
  sizeBtc: number;
  leverage: number;
  marginMode: MarginMode;
  reduceOnly?: boolean;
  limitPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  note?: string;
}

export type ConnectorDraftParseResult =
  | { status: "empty" }
  | { status: "invalid"; message: string }
  | { status: "valid"; payload: ConnectorDraftPayload; draft: OrderDraft };

const MAX_DRAFT_PARAM_CHARS = 2_500;
const MAX_LEVERAGE = 50;

export function encodeConnectorDraftParam(payload: ConnectorDraftPayload): string {
  return encodeURIComponent(JSON.stringify(normalizeConnectorDraftPayload(payload)));
}

export function connectorDraftReviewPath(payload: ConnectorDraftPayload): string {
  const normalized = normalizeConnectorDraftPayload(payload);
  const symbol = normalized.symbol.replace(/-USD$/u, "");
  return `/terminal?symbol=${encodeURIComponent(symbol)}&draft=${encodeConnectorDraftParam(normalized)}`;
}

export function parseConnectorDraftParam(raw: string | null | undefined): ConnectorDraftParseResult {
  if (!raw) {
    return { status: "empty" };
  }
  if (raw.length > MAX_DRAFT_PARAM_CHARS) {
    return { status: "invalid", message: "Connector draft is too large." };
  }

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { status: "invalid", message: "Connector draft is not URL encoded correctly." };
  }

  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return { status: "invalid", message: "Connector draft is not valid JSON." };
  }

  const validation = validateConnectorDraftPayload(value);
  if (!validation.ok) {
    return { status: "invalid", message: validation.message };
  }

  const payload = normalizeConnectorDraftPayload(validation.payload);
  return {
    status: "valid",
    payload,
    draft: {
      symbol: payload.symbol,
      side: payload.side,
      orderType: payload.orderType,
      sizeBtc: payload.sizeBtc,
      leverage: payload.leverage,
      marginMode: payload.marginMode,
      reduceOnly: payload.reduceOnly ?? false,
      limitPrice: payload.limitPrice,
      takeProfit: payload.takeProfit,
      stopLoss: payload.stopLoss,
      fromAgent: true,
      source: "connector",
      editedAfterAgent: false,
    },
  };
}

function normalizeConnectorDraftPayload(payload: ConnectorDraftPayload): ConnectorDraftPayload {
  const normalized: ConnectorDraftPayload = {
    v: 1,
    source: payload.source ?? "unknown",
    symbol: normalizeConnectorSymbol(payload.symbol),
    side: payload.side,
    orderType: payload.orderType,
    sizeBtc: payload.sizeBtc,
    leverage: payload.leverage,
    marginMode: payload.marginMode,
    reduceOnly: payload.reduceOnly ?? false,
    takeProfit: payload.takeProfit,
    stopLoss: payload.stopLoss,
    note: payload.note,
  };
  if (payload.orderType === "limit") {
    normalized.limitPrice = payload.limitPrice;
  }
  return normalized;
}

function validateConnectorDraftPayload(value: unknown):
  | { ok: true; payload: ConnectorDraftPayload }
  | { ok: false; message: string } {
  if (!value || typeof value !== "object") {
    return { ok: false, message: "Connector draft must be an object." };
  }

  const payload = value as Partial<ConnectorDraftPayload>;
  if (payload.v !== 1) {
    return { ok: false, message: "Connector draft version is unsupported." };
  }
  if (typeof payload.symbol !== "string" || !payload.symbol.trim()) {
    return { ok: false, message: "Connector draft is missing a market symbol." };
  }
  if (payload.side !== "long" && payload.side !== "short") {
    return { ok: false, message: "Connector draft side must be long or short." };
  }
  if (payload.orderType !== "market" && payload.orderType !== "limit") {
    return { ok: false, message: "Connector draft order type must be market or limit." };
  }
  const sizeBtc = payload.sizeBtc;
  const leverage = payload.leverage;

  if (!isPositiveFinite(sizeBtc)) {
    return { ok: false, message: "Connector draft size must be positive." };
  }
  if (typeof leverage !== "number" || !Number.isInteger(leverage) || leverage < 1 || leverage > MAX_LEVERAGE) {
    return { ok: false, message: "Connector draft leverage must be an integer from 1 to 50." };
  }
  if (payload.marginMode !== "isolated" && payload.marginMode !== "cross") {
    return { ok: false, message: "Connector draft margin mode must be isolated or cross." };
  }
  if (payload.orderType === "limit" && !isPositiveFinite(payload.limitPrice)) {
    return { ok: false, message: "Connector limit drafts require a positive limit price." };
  }
  if (payload.takeProfit !== undefined && !isPositiveFinite(payload.takeProfit)) {
    return { ok: false, message: "Connector take-profit must be positive when provided." };
  }
  if (payload.stopLoss !== undefined && !isPositiveFinite(payload.stopLoss)) {
    return { ok: false, message: "Connector stop-loss must be positive when provided." };
  }
  if (
    payload.source !== undefined &&
    payload.source !== "claude" &&
    payload.source !== "chatgpt" &&
    payload.source !== "mcp" &&
    payload.source !== "unknown"
  ) {
    return { ok: false, message: "Connector draft source is unsupported." };
  }

  return {
    ok: true,
    payload: {
      v: 1,
      source: payload.source,
      symbol: payload.symbol,
      side: payload.side,
      orderType: payload.orderType,
      sizeBtc,
      leverage,
      marginMode: payload.marginMode,
      reduceOnly: payload.reduceOnly,
      limitPrice: payload.limitPrice,
      takeProfit: payload.takeProfit,
      stopLoss: payload.stopLoss,
      note: payload.note,
    },
  };
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeConnectorSymbol(input: string): string {
  return `${normalizeSymbol(input)}-USD`;
}
