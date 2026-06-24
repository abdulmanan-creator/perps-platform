import type { ChartAnnotation, EligibilityMode, MarketSnapshot, OrderDraft } from "./types";

export type TicketSource = "manual" | "agent";

export const AGENT_PANEL_HEADING = "Ask Agent.trade";

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
  return { ...draft, ...patch, fromAgent: false };
}

export function getConfirmationAckCopy(source: TicketSource): string {
  if (source === "agent") {
    return "I understand this is a leveraged perpetual order. The agent drafted, but I am confirming.";
  }

  return "I understand this is a leveraged perpetual order. I am confirming this paper order.";
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

export const TERMINAL_CHART_INTERVALS = ["1m", "5m", "15m", "1h", "4h"] as const;
export type TerminalChartInterval = (typeof TERMINAL_CHART_INTERVALS)[number];

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
    case "5m":
      return 5 * 60;
    case "1h":
      return 60 * 60;
    case "4h":
      return 4 * 60 * 60;
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
    const ageSeconds = Math.max(0, Math.floor((now - data.fetchedAt) / 1000));
    return `Hyperliquid candles · ${data.interval} · updated ${ageSeconds}s ago`;
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
