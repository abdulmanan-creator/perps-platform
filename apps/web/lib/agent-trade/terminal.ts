import { marketSearchAliases, normalizeSymbol } from "./markets";
import type { ChartAnnotation, EligibilityMode, MarketSnapshot, OrderDraft, Position } from "./types";

export type TicketSource = "manual" | "agent";

export interface JsonSafeSignature {
  r: `0x${string}`;
  s: `0x${string}`;
  v: number;
}

export interface HyperliquidTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  primaryType: string;
  message: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
}

export interface SubmitState {
  message: string;
  scannerUrl?: string;
  detail?: string;
}

export const AGENT_PANEL_HEADING = "Ask Agent.trade";

export function normalizeHexSignature(hex: `0x${string}`): JsonSafeSignature {
  const stripped = hex.replace(/^0x/u, "");
  if (stripped.length !== 130) {
    throw new Error(`Unexpected signature length ${stripped.length}; expected 130 hex chars (65 bytes).`);
  }

  let v = Number.parseInt(stripped.slice(128, 130), 16);
  if (v < 27) {
    v += 27;
  }

  return {
    r: `0x${stripped.slice(0, 64)}`,
    s: `0x${stripped.slice(64, 128)}`,
    v,
  };
}

export function withExplicitEip712Domain(typedData: HyperliquidTypedData): HyperliquidTypedData {
  return {
    domain: typedData.domain,
    primaryType: typedData.primaryType,
    message: typedData.message,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...typedData.types,
    },
  };
}

export interface TerminalEligibilityStatus {
  visible: boolean;
  tone: "amber" | "red" | "blue";
  label: string;
  message: string;
}

export function getTicketSource(draft: Pick<OrderDraft, "fromAgent">): TicketSource {
  return draft.fromAgent ? "agent" : "manual";
}

export function applyManualDraftPatch(draft: OrderDraft, patch: Partial<OrderDraft>): OrderDraft {
  return { ...draft, ...patch, fromAgent: false, editedAfterAgent: draft.fromAgent || draft.editedAfterAgent };
}

export function getConfirmationAckCopy(
  source: TicketSource,
  mode: "paper" | "live" = "paper",
  intent: "order" | "close" = "order",
): string {
  if (intent === "close") {
    return mode === "paper"
      ? "I understand this close is simulated. I am confirming this paper close."
      : "I understand this submits a reduce-only live perpetual order. I am confirming this live close.";
  }

  if (source === "agent") {
    return "I understand this is a leveraged perpetual order. The agent drafted, but I am confirming.";
  }

  return mode === "paper"
    ? "I understand this is a leveraged perpetual order. I am confirming this paper order."
    : "I understand this is a leveraged perpetual order. I am confirming this live order.";
}

export function liveOrderSubmitState(args: {
  scannerUrl: string | null;
  market: string;
  side: string;
  notionalUsd: number;
  resultSummary?: string;
}): SubmitState {
  return {
    message: `Live order submitted: ${args.market} ${args.side} ${formatSubmitUsd(args.notionalUsd)} notional.`,
    detail: args.resultSummary ?? "Refreshing live Hyperliquid account state.",
    scannerUrl: args.scannerUrl ?? undefined,
  };
}

export function closePositionDraft(position: Position): OrderDraft {
  return {
    symbol: position.symbol,
    side: position.side === "long" ? "short" : "long",
    orderType: "market",
    sizeBtc: position.size,
    leverage: position.leverage,
    marginMode: position.marginMode,
    reduceOnly: true,
    fromAgent: false,
  };
}

export function closePositionSubmitState(args: {
  mode: "paper" | "live";
  scannerUrl?: string | null;
  market: string;
  side: string;
  notionalUsd: number;
  resultSummary?: string;
}): SubmitState {
  return {
    message: `${args.mode === "paper" ? "Paper" : "Live"} close submitted: ${args.market} ${args.side} ${formatSubmitUsd(args.notionalUsd)} notional.`,
    detail: args.resultSummary ?? (args.mode === "paper" ? "Paper fill recorded. Position updated." : "Refreshing live Hyperliquid account state."),
    scannerUrl: args.scannerUrl ?? undefined,
  };
}

export function paperOrderSubmitState(message: string): SubmitState {
  return { message };
}

export function liveOrderErrorMessage(error: {
  message?: string;
  guidance?: string;
  code?: string;
}): string {
  const raw = [error.code, error.guidance, error.message].filter(Boolean).join(" ");
  const normalized = raw.toLowerCase();

  if (/must deposit|needs_deposit|deposit before performing actions/u.test(normalized)) {
    return liveError("Hyperliquid account needs a deposit before live orders can be placed.", raw);
  }
  if (/insufficient.*margin|margin.*insufficient|not enough margin|insufficient.*balance/u.test(normalized)) {
    return liveError("Insufficient margin for this live order. Reduce size/leverage or add collateral.", raw);
  }
  if (/builder.*approval|builder.*fee|approvebuilderfee|maxbuilderfee/u.test(normalized)) {
    return liveError("Builder fee approval appears incomplete. Refresh wallet readiness before retrying.", raw);
  }
  if (/(min|minimum).*(notional|order)|below.*\$?10|less than.*\$?10/u.test(normalized)) {
    return liveError("Order is below Hyperliquid's $10 minimum notional.", raw);
  }
  if (/account.*unavailable|account state.*unavailable/u.test(normalized)) {
    return liveError("Hyperliquid account state is unavailable. Refresh before live trading.", raw);
  }
  if (/wallet required|wallet disconnected|no connected wallet/u.test(normalized)) {
    return liveError("Wallet disconnected. Reconnect before live trading.", raw);
  }
  if (/restricted|eligibility|jurisdiction|unknown/u.test(normalized)) {
    return liveError("Live trading is unavailable until eligibility is confirmed.", raw);
  }
  if (/rejected|hl_exchange_rejected|hyperliquid/u.test(normalized)) {
    return liveError("Hyperliquid rejected the live order.", raw);
  }

  return raw || "Live order failed. Check wallet, account readiness, and Hyperliquid response.";
}

function liveError(summary: string, raw: string): string {
  return raw ? `${summary} Detail: ${raw}` : summary;
}

function formatSubmitUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return "$--";
  }
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const PROMPT_SYMBOL_STOP_WORDS = new Set([
  "ABOUT",
  "AGAIN",
  "AGENT",
  "AND",
  "ASK",
  "BEARISH",
  "BTCUSD",
  "BULLISH",
  "BUY",
  "CAN",
  "CLEAN",
  "DO",
  "EXPLAIN",
  "FIND",
  "FOR",
  "FROM",
  "FUNDING",
  "HERE",
  "HOW",
  "INTEREST",
  "LONG",
  "MARKET",
  "ME",
  "OI",
  "OPEN",
  "ON",
  "OR",
  "ORDER",
  "PLEASE",
  "READ",
  "RISK",
  "SELL",
  "SETUP",
  "SHORT",
  "SHOULD",
  "THE",
  "THIS",
  "THOUGHTS",
  "TO",
  "TRADE",
  "TERM",
  "WITH",
  "USD",
  "USDC",
  "WHAT",
  "WE",
  "YOU",
]);

const PROMPT_TRADE_INTENT_WORDS = new Set(["buy", "long", "sell", "short"]);

const PROMPT_MARKET_ALIASES = new Map(
  ["BTC", "ETH", "HYPE", "SOL"].flatMap((symbol) => marketSearchAliases(symbol).map((alias) => [alias, symbol] as const)),
);

interface PromptToken {
  raw: string;
  lower: string;
  normalized?: string;
}

export interface TypedPromptMarketResolution {
  mentionedSymbol?: string;
  resolvedSymbol?: string;
  unsupported: boolean;
  isCurrentMarket: boolean;
}

export function resolveTypedPromptMarket(args: {
  prompt: string;
  currentSymbol: string;
  supportedSymbols: string[];
}): TypedPromptMarketResolution {
  const currentSymbol = normalizeSymbol(args.currentSymbol);
  const supportedSymbols = new Set(args.supportedSymbols.map((symbol) => normalizeSymbol(symbol)));
  const tokens = tokenizePrompt(args.prompt);

  for (const token of tokens) {
    if (token.normalized && supportedSymbols.has(token.normalized)) {
      return {
        mentionedSymbol: token.normalized,
        resolvedSymbol: token.normalized,
        unsupported: false,
        isCurrentMarket: token.normalized === currentSymbol,
      };
    }
  }

  const mentionedSymbol = extractUnsupportedTradeIntentSymbol(tokens);

  if (!mentionedSymbol) {
    return { unsupported: false, isCurrentMarket: true };
  }

  return {
    mentionedSymbol,
    unsupported: true,
    isCurrentMarket: false,
  };
}

export function extractPromptMarketSymbol(prompt: string): string | undefined {
  return tokenizePrompt(prompt).find((token) => token.normalized)?.normalized;
}

function tokenizePrompt(prompt: string): PromptToken[] {
  const matches = prompt.match(/\b[A-Z][A-Z0-9]*(?:[-/](?:USD|USDC|PERP))?\b/giu) ?? [];
  return matches.map((raw) => {
    const lower = raw.toLowerCase();
    return {
      raw,
      lower,
      normalized: normalizePromptToken(raw),
    };
  });
}

function extractUnsupportedTradeIntentSymbol(tokens: PromptToken[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!PROMPT_TRADE_INTENT_WORDS.has(token.lower)) {
      continue;
    }

    for (let offset = 1; offset <= 3; offset += 1) {
      const candidate = tokens[index + offset];
      if (!candidate?.normalized || isPromptSymbolStopWord(candidate.normalized)) {
        continue;
      }
      return candidate.normalized;
    }
  }

  return undefined;
}

function normalizePromptToken(token: string): string | undefined {
  const compact = token.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const alias = PROMPT_MARKET_ALIASES.get(compact);
  if (alias) {
    return alias;
  }

  const normalized = normalizeSymbol(token)
    .replace(/(?:USDC|USD|PERP)$/u, "")
    .trim();
  if (!normalized || isPromptSymbolStopWord(normalized)) {
    return undefined;
  }
  return normalized;
}

function isPromptSymbolStopWord(symbol: string): boolean {
  return PROMPT_SYMBOL_STOP_WORDS.has(symbol);
}

export function getTerminalEligibilityStatus(state: EligibilityMode): TerminalEligibilityStatus {
  switch (state) {
    case "unknown":
    case "loading":
      return {
        visible: true,
        tone: "amber",
        label: "Paper mode only",
        message: "Paper mode only. Live eligibility has not been confirmed.",
      };
    case "restricted":
      return {
        visible: true,
        tone: "red",
        label: "Live unavailable",
        message: "Live trading unavailable in your region. Paper trading remains available.",
      };
    case "killSwitchDisabled":
      return {
        visible: true,
        tone: "red",
        label: "Live disabled",
        message: "Live trading is disabled by the Agent.trade kill switch. Paper trading remains available.",
      };
    case "paper":
      return {
        visible: true,
        tone: "blue",
        label: "Paper mode",
        message: "Paper mode is active. Live trading is disabled until account readiness is complete.",
      };
    case "liveEligible":
    default:
      return {
        visible: false,
        tone: "blue",
        label: "Live eligible",
        message: "Live trading can be enabled after confirmation.",
      };
  }
}

export function getTerminalModeLabel(state: EligibilityMode, mode: "paper" | "live"): string {
  if (mode === "paper") {
    if (state === "liveEligible") {
      return "Paper mode active";
    }
    if (state === "restricted") {
      return "Paper mode only";
    }
    if (state === "killSwitchDisabled") {
      return "Live disabled";
    }
    return "Paper mode only";
  }

  return "Live mode";
}

export function getLiveDisabledReason(state: EligibilityMode): string {
  switch (state) {
    case "restricted":
      return "Live trading unavailable in your region.";
    case "killSwitchDisabled":
      return "Live trading is disabled by the Agent.trade kill switch.";
    case "unknown":
    case "loading":
      return "Live eligibility has not been confirmed.";
    case "paper":
      return "Live trading is disabled while account readiness is incomplete.";
    case "liveEligible":
    default:
      return "Live trading is available after confirmation.";
  }
}

export function getTerminalHeaderStatusText(state: EligibilityMode, mode: "paper" | "live"): string {
  if (mode === "paper") {
    if (state === "restricted") {
      return "Paper mode active. Live unavailable in your region.";
    }
    if (state === "killSwitchDisabled") {
      return "Paper mode active. Live disabled.";
    }
    if (state === "liveEligible") {
      return "Paper mode active. Live trading available after confirmation.";
    }
    return "Paper mode active. Live eligibility not confirmed.";
  }

  return "Live mode. Orders still require confirmation.";
}

export function paperOrderEndpoint(apiBaseUrl: string): string {
  return `${apiBaseUrl}/agent-trade/paper-orders`;
}

export function paperOrderFailureMessage(error: unknown, endpoint: string): string {
  if (error instanceof TypeError) {
    return `Paper order failed: API unavailable at ${endpoint}`;
  }
  if (error instanceof Error && error.message) {
    return `Paper order failed: ${error.message}`;
  }
  return `Paper order failed: API unavailable at ${endpoint}`;
}

export interface TerminalCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const TERMINAL_CHART_INTERVALS = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
] as const;
export type TerminalChartInterval = (typeof TERMINAL_CHART_INTERVALS)[number];
export const TERMINAL_QUICK_CHART_INTERVALS: TerminalChartInterval[] = ["1m", "5m", "15m", "1h", "4h"];
export const TERMINAL_CHART_INTERVAL_GROUPS: Array<{ label: string; intervals: TerminalChartInterval[] }> = [
  { label: "Minutes", intervals: ["1m", "3m", "5m", "15m", "30m"] },
  { label: "Hours", intervals: ["1h", "2h", "4h", "8h", "12h"] },
  { label: "Days", intervals: ["1d", "3d", "1w", "1M"] },
];

export function isTerminalChartInterval(input: string): input is TerminalChartInterval {
  return (TERMINAL_CHART_INTERVALS as readonly string[]).includes(input);
}

export const TERMINAL_MARKET_STALE_MS = 60_000;
export const TERMINAL_CANDLES_STALE_MS = 120_000;
export const TERMINAL_ACCOUNT_STALE_MS = 120_000;

export interface TerminalCandlesWireResponse {
  symbol: string;
  interval: TerminalChartInterval;
  candles: TerminalCandle[];
  source: "hyperliquid";
  fetchedAt: number;
  error?: string;
}

export interface TerminalChartData {
  interval: TerminalChartInterval;
  candles: TerminalCandle[];
  source: "hyperliquid" | "synthetic";
  fetchedAt: number;
  isFallback: boolean;
  error?: string;
  livePriceAt?: number;
}

export type TerminalFreshnessState = "fresh" | "warming" | "degraded" | "apiUnavailable";
export type TerminalAccountFreshnessState = "fresh" | "stale" | "unavailable";

export interface TerminalFreshnessInput {
  now?: number;
  marketAsOf: number;
  marketDataAgeSeconds?: number;
  candlesFetchedAt?: number;
  candlesFallback?: boolean;
  candlesError?: string;
  accountUpdatedAt?: number;
  accountUnavailable?: boolean;
  isLoadingMarket?: boolean;
  isLoadingCandles?: boolean;
  apiStatus: "checking" | "ok" | "unavailable";
}

export interface TerminalFreshness {
  state: TerminalFreshnessState;
  label: string;
  detail: string;
  isDraftSafe: boolean;
  marketAgeSeconds: number;
  candleAgeSeconds?: number;
  accountAgeSeconds?: number;
  marketFreshness: {
    state: TerminalFreshnessState;
    label: string;
    detail: string;
    isDraftSafe: boolean;
    marketAgeSeconds: number;
    candleAgeSeconds?: number;
  };
  accountFreshness: {
    state: TerminalAccountFreshnessState;
    label: string;
    detail: string;
    warning?: string;
    accountAgeSeconds?: number;
  };
}

export function getTerminalFreshness(input: TerminalFreshnessInput): TerminalFreshness {
  const now = input.now ?? Date.now();
  const marketAgeSeconds = Math.max(
    0,
    input.marketDataAgeSeconds ?? Math.floor((now - input.marketAsOf) / 1000),
  );
  const candleAgeSeconds = input.candlesFetchedAt == null
    ? undefined
    : Math.max(0, Math.floor((now - input.candlesFetchedAt) / 1000));
  const accountAgeSeconds = input.accountUpdatedAt == null
    ? undefined
    : Math.max(0, Math.floor((now - input.accountUpdatedAt) / 1000));
  const accountFreshness = getTerminalAccountFreshness({
    accountAgeSeconds,
    accountUnavailable: input.accountUnavailable,
  });

  if (input.apiStatus === "unavailable") {
    return combineTerminalFreshness({
      state: "apiUnavailable",
      label: "API unavailable",
      detail: "API unavailable",
      isDraftSafe: true,
      marketAgeSeconds,
      candleAgeSeconds,
      accountFreshness,
    });
  }

  if (input.apiStatus === "checking" || input.isLoadingMarket || input.isLoadingCandles || input.candlesFetchedAt == null) {
    return combineTerminalFreshness({
      state: "warming",
      label: "Refreshing...",
      detail: "Refreshing market data",
      isDraftSafe: true,
      marketAgeSeconds,
      candleAgeSeconds,
      accountFreshness,
    });
  }

  if (input.candlesFallback || input.candlesError) {
    return combineTerminalFreshness({
      state: "degraded",
      label: "Candles stale",
      detail: input.candlesError ?? "Candle data is using a degraded fallback",
      isDraftSafe: true,
      marketAgeSeconds,
      candleAgeSeconds,
      accountFreshness,
    });
  }

  if (marketAgeSeconds * 1000 > TERMINAL_MARKET_STALE_MS) {
    return combineTerminalFreshness({
      state: "degraded",
      label: "Market data stale",
      detail: `Market data is ${formatFreshnessAge(marketAgeSeconds)} old`,
      isDraftSafe: true,
      marketAgeSeconds,
      candleAgeSeconds,
      accountFreshness,
    });
  }

  if (candleAgeSeconds != null && candleAgeSeconds * 1000 > TERMINAL_CANDLES_STALE_MS) {
    return combineTerminalFreshness({
      state: "degraded",
      label: "Candles stale",
      detail: `Candle data is ${formatFreshnessAge(candleAgeSeconds)} old`,
      isDraftSafe: true,
      marketAgeSeconds,
      candleAgeSeconds,
      accountFreshness,
    });
  }

  return combineTerminalFreshness({
    state: "fresh",
    label: "Live market data",
    detail: "Live market data is fresh",
    isDraftSafe: true,
    marketAgeSeconds,
    candleAgeSeconds,
    accountFreshness,
  });
}

function getTerminalAccountFreshness({
  accountAgeSeconds,
  accountUnavailable,
}: {
  accountAgeSeconds?: number;
  accountUnavailable?: boolean;
}): TerminalFreshness["accountFreshness"] {
  if (accountUnavailable) {
    return {
      state: "unavailable",
      label: "Account unavailable",
      detail: "Read-only account data is unavailable; paper mode remains available.",
      warning: "Portfolio impact uses the last paper/account snapshot.",
      accountAgeSeconds,
    };
  }

  if (accountAgeSeconds != null && accountAgeSeconds * 1000 > TERMINAL_ACCOUNT_STALE_MS) {
    return {
      state: "stale",
      label: "Account values may be stale",
      detail: `Portfolio impact uses account values from ${formatFreshnessAge(accountAgeSeconds)} ago.`,
      warning: "Portfolio impact may use stale account values.",
      accountAgeSeconds,
    };
  }

  return {
    state: "fresh",
    label: "Account values current",
    detail: "Paper/account values are current.",
    accountAgeSeconds,
  };
}

function combineTerminalFreshness(input: {
  state: TerminalFreshnessState;
  label: string;
  detail: string;
  isDraftSafe: boolean;
  marketAgeSeconds: number;
  candleAgeSeconds?: number;
  accountFreshness: TerminalFreshness["accountFreshness"];
}): TerminalFreshness {
  return {
    state: input.state,
    label: input.label,
    detail: input.detail,
    isDraftSafe: input.isDraftSafe,
    marketAgeSeconds: input.marketAgeSeconds,
    candleAgeSeconds: input.candleAgeSeconds,
    accountAgeSeconds: input.accountFreshness.accountAgeSeconds,
    marketFreshness: {
      state: input.state,
      label: input.label,
      detail: input.detail,
      isDraftSafe: input.isDraftSafe,
      marketAgeSeconds: input.marketAgeSeconds,
      candleAgeSeconds: input.candleAgeSeconds,
    },
    accountFreshness: input.accountFreshness,
  };
}

export function formatFreshnessAge(ageSeconds: number): string {
  if (ageSeconds < 60) {
    return `${ageSeconds}s`;
  }
  const minutes = Math.floor(ageSeconds / 60);
  return `${minutes}m`;
}

export function buildSyntheticTerminalCandles(market: MarketSnapshot, count = 72, interval: TerminalChartInterval = "15m"): TerminalCandle[] {
  const stepSeconds = terminalIntervalSeconds(interval);
  const now = Math.floor(Date.now() / 1000 / stepSeconds) * stepSeconds;
  const start = market.markPrice - market.change24hAbs;
  const safeStart = start > 0 ? start : market.markPrice * (1 - market.change24hPct / 100);
  const candles: TerminalCandle[] = [];
  let previousClose = safeStart || market.markPrice;

  for (let index = 0; index < count; index += 1) {
    const progress = count <= 1 ? 1 : index / (count - 1);
    const trend = safeStart + (market.markPrice - safeStart) * progress;
    const wave = Math.sin(index * 0.72) * market.markPrice * 0.0019;
    const micro = Math.cos(index * 1.37) * market.markPrice * 0.0009;
    const close = index === count - 1 ? market.markPrice : Math.max(0.01, trend + wave + micro);
    const open = index === 0 ? previousClose : previousClose;
    const wick = market.markPrice * (0.0018 + (index % 5) * 0.00024);
    const high = Math.max(open, close) + wick;
    const low = Math.max(0.01, Math.min(open, close) - wick * 0.82);
    const volumeBias = 0.72 + Math.abs(Math.sin(index * 0.51)) * 0.64;
    candles.push({
      time: now - (count - index - 1) * stepSeconds,
      open,
      high,
      low,
      close,
      volume: Math.max(1, (market.volume24hUsd / count / market.markPrice) * volumeBias),
    });
    previousClose = close;
  }

  return candles;
}

export function terminalIntervalSeconds(interval: TerminalChartInterval): number {
  switch (interval) {
    case "1m":
      return 60;
    case "3m":
      return 3 * 60;
    case "5m":
      return 5 * 60;
    case "30m":
      return 30 * 60;
    case "1h":
      return 60 * 60;
    case "2h":
      return 2 * 60 * 60;
    case "4h":
      return 4 * 60 * 60;
    case "8h":
      return 8 * 60 * 60;
    case "12h":
      return 12 * 60 * 60;
    case "1d":
      return 24 * 60 * 60;
    case "3d":
      return 3 * 24 * 60 * 60;
    case "1w":
      return 7 * 24 * 60 * 60;
    case "1M":
      return 30 * 24 * 60 * 60;
    case "15m":
    default:
      return 15 * 60;
  }
}

export function buildFallbackTerminalChartData(
  market: MarketSnapshot,
  interval: TerminalChartInterval,
  error?: string,
): TerminalChartData {
  return {
    interval,
    candles: buildSyntheticTerminalCandles(market, 72, interval),
    source: "synthetic",
    fetchedAt: Date.now(),
    isFallback: true,
    error,
  };
}

export function normalizeTerminalCandlesResponse(
  response: TerminalCandlesWireResponse,
  market: MarketSnapshot,
  interval: TerminalChartInterval,
): TerminalChartData {
  const validCandles = response.candles.filter(isValidTerminalCandle);
  if (response.source !== "hyperliquid" || response.interval !== interval || validCandles.length === 0) {
    return buildFallbackTerminalChartData(market, interval, "Hyperliquid candle response was empty or invalid.");
  }

  return {
    interval,
    candles: validCandles,
    source: "hyperliquid",
    fetchedAt: response.fetchedAt,
    isFallback: false,
  };
}

export function terminalChartLabel(data: TerminalChartData, now = Date.now()): string {
  if (data.source === "hyperliquid") {
    const updatedAt = data.livePriceAt ?? data.fetchedAt;
    const ageSeconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
    const source = data.livePriceAt == null ? "updated" : "live price";
    return `Hyperliquid candles · ${data.interval} · ${source} ${ageSeconds}s ago`;
  }

  return `Synthetic fallback · ${data.interval} · chart data degraded`;
}

function isValidTerminalCandle(candle: TerminalCandle): boolean {
  return (
    Number.isFinite(candle.time) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    Number.isFinite(candle.volume) &&
    candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= Math.min(candle.open, candle.close)
  );
}

export function annotationPriceLineTitle(annotation: ChartAnnotation): string {
  return `${annotation.label}`;
}
