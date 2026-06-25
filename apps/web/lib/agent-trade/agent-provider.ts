import type {
  AccountSnapshot,
  AgentReceipt,
  ChartAnnotation,
  EligibilityMode,
  MarketSnapshot,
  OrderDraft,
  RecentTrade,
  SharedTradingSnapshot,
  TradeSide,
} from "./types";
import { calculatePortfolioExposure, type PortfolioExposure } from "./portfolio";
import type { TerminalChartData, TerminalCandle, TerminalFreshness } from "./terminal";

export type AgentProviderName =
  | "deterministic"
  | "openai"
  | "anthropic"
  | "openrouter";

export type AgentResponseType =
  | "greeting"
  | "market_read"
  | "trade_proposal"
  | "no_trade"
  | "refusal";

export type AgentAnalysisSide = TradeSide | "none";

export interface AgentProvider {
  name: AgentProviderName;
  analyzeMarket(input: AgentInput): Promise<AgentAnalysis>;
}

export interface AgentMarketInput {
  symbol: string;
  base: string;
  venue: string;
  assetIndex: number;
  szDecimals: number;
  maxLeverage: number;
  markPrice: number;
  oraclePrice: number;
  change24hPct: number;
  change24hAbs: number;
  fundingRatePct: number;
  openInterestUsd: number;
  openInterestChangePct: number | null;
  volume24hUsd: number;
  liquidityUsd: number;
  nextFundingMinutes: number;
  dataAgeSeconds: number;
  source: MarketSnapshot["source"];
}

export interface AgentCandleSummary {
  interval?: string;
  source: "hyperliquid" | "synthetic" | "unavailable";
  fetchedAt?: number;
  isFallback: boolean;
  count: number;
  latest?: TerminalCandle;
  high?: number;
  low?: number;
  volume?: number;
  trendPct?: number;
  warning?: string;
}

export interface AgentAccountSummary {
  address: AccountSnapshot["address"];
  valueKind: AccountSnapshot["valueKind"];
  sourceLabel?: string;
  liveAccountDataLoaded?: boolean;
  liveAccountDataUnavailable?: boolean;
  updatedAt?: number;
  equityUsd: number;
  availableUsd: number;
  marginUsedUsd: number;
  unrealizedPnlUsd: number;
  dailyLiveNotionalUsedUsd: number;
  simulatedBalanceUsd: number;
  positionCount: number;
  openOrderCount: number;
  fillCount: number;
  positions: AccountSnapshot["positions"];
}

export interface AgentEligibilityInput {
  state: EligibilityMode;
  mode: "paper" | "live";
  liveAllowed: boolean;
  paperAllowed: boolean;
  mainnetExecutionEnabled?: boolean;
  killSwitchEnabled?: boolean;
  executionVenue?: string;
}

export interface AgentFreshnessInput {
  now: number;
  marketAsOf: number;
  marketAgeSeconds: number;
  candlesFetchedAt?: number;
  candleAgeSeconds?: number;
  accountUpdatedAt?: number;
  accountAgeSeconds?: number;
  marketWarning?: string;
  accountWarning?: string;
}

export interface AgentInput {
  requestedPrompt: string;
  scenario?: string;
  market: AgentMarketInput;
  orderBook: SharedTradingSnapshot["orderBook"];
  recentTrades: RecentTrade[];
  candleSummary: AgentCandleSummary;
  account: AgentAccountSummary;
  selectedPosition?: AccountSnapshot["positions"][number];
  exposure: PortfolioExposure;
  eligibility: AgentEligibilityInput;
  freshness: AgentFreshnessInput;
  timestamp: number;
}

export interface AgentProviderMetadata {
  name: AgentProviderName;
  model?: string;
  deterministic: boolean;
  generatedAt: number;
  fallbackReason?: string;
}

export interface AgentAnalysis {
  responseType: AgentResponseType;
  summary: string;
  thesis: string;
  side: AgentAnalysisSide;
  confidence: number;
  receipts: AgentReceipt[];
  riskNote: string;
  whyWrong: string;
  orderDraft?: OrderDraft;
  warnings: string[];
  provider: AgentProviderMetadata;
  id?: string;
  question?: string;
  annotations?: ChartAnnotation[];
  followUps?: string[];
}

export function buildAgentInput(args: {
  prompt: string;
  scenario?: string;
  snapshot: SharedTradingSnapshot;
  chartData?: TerminalChartData;
  freshness?: TerminalFreshness;
  accountFreshnessWarning?: string;
  marketDataWarning?: string;
  mode: "paper" | "live";
  eligibilityState?: EligibilityMode;
  liveAllowed?: boolean;
  paperAllowed?: boolean;
  mainnetExecutionEnabled?: boolean;
  killSwitchEnabled?: boolean;
  executionVenue?: string;
  now?: number;
}): AgentInput {
  const now = args.now ?? Date.now();
  const selectedPosition = args.snapshot.account.positions.find(
    (position) => position.symbol === args.snapshot.market.symbol,
  );
  const candles = args.chartData?.candles ?? [];
  const latest = candles.at(-1);
  const first = candles[0];
  const high = maxFinite(candles.map((candle) => candle.high));
  const low = minFinite(candles.map((candle) => candle.low));
  const volume = candles.reduce((sum, candle) => Number.isFinite(candle.volume) ? sum + candle.volume : sum, 0);
  const trendPct =
    first && latest && first.open > 0
      ? (latest.close - first.open) / first.open * 100
      : undefined;

  return {
    requestedPrompt: args.prompt,
    scenario: args.scenario,
    market: { ...args.snapshot.market },
    orderBook: {
      bids: args.snapshot.orderBook.bids.slice(0, 10),
      asks: args.snapshot.orderBook.asks.slice(0, 10),
    },
    recentTrades: args.snapshot.recentTrades.slice(0, 20),
    candleSummary: {
      interval: args.chartData?.interval,
      source: args.chartData?.source ?? "unavailable",
      fetchedAt: args.chartData?.fetchedAt,
      isFallback: Boolean(args.chartData?.isFallback),
      count: candles.length,
      latest,
      high,
      low,
      volume: volume > 0 ? volume : undefined,
      trendPct,
      warning: args.chartData?.error,
    },
    account: {
      address: args.snapshot.account.address,
      valueKind: args.snapshot.account.valueKind,
      sourceLabel: args.snapshot.account.sourceLabel,
      liveAccountDataLoaded: args.snapshot.account.liveAccountDataLoaded,
      liveAccountDataUnavailable: args.snapshot.account.liveAccountDataUnavailable,
      updatedAt: args.snapshot.account.updatedAt,
      equityUsd: args.snapshot.account.equityUsd,
      availableUsd: args.snapshot.account.availableUsd,
      marginUsedUsd: args.snapshot.account.marginUsedUsd,
      unrealizedPnlUsd: args.snapshot.account.unrealizedPnlUsd,
      dailyLiveNotionalUsedUsd: args.snapshot.account.dailyLiveNotionalUsedUsd,
      simulatedBalanceUsd: args.snapshot.account.simulatedBalanceUsd,
      positionCount: args.snapshot.account.positions.length,
      openOrderCount: args.snapshot.account.openOrders.length,
      fillCount: args.snapshot.account.fills.length,
      positions: args.snapshot.account.positions,
    },
    selectedPosition,
    exposure: calculatePortfolioExposure(args.snapshot.account, args.snapshot.market.symbol),
    eligibility: {
      state: args.eligibilityState ?? (args.mode === "live" ? "liveEligible" : "paper"),
      mode: args.mode,
      liveAllowed: Boolean(args.liveAllowed),
      paperAllowed: args.paperAllowed ?? true,
      mainnetExecutionEnabled: args.mainnetExecutionEnabled,
      killSwitchEnabled: args.killSwitchEnabled,
      executionVenue: args.executionVenue,
    },
    freshness: {
      now,
      marketAsOf: args.snapshot.asOf,
      marketAgeSeconds: args.freshness?.marketAgeSeconds ?? args.snapshot.market.dataAgeSeconds,
      candlesFetchedAt: args.chartData?.fetchedAt,
      candleAgeSeconds: args.freshness?.candleAgeSeconds,
      accountUpdatedAt: args.snapshot.account.updatedAt,
      accountAgeSeconds: args.freshness?.accountAgeSeconds,
      marketWarning: args.marketDataWarning,
      accountWarning: args.accountFreshnessWarning ?? args.freshness?.accountFreshness.warning,
    },
    timestamp: now,
  };
}

export function snapshotFromAgentInput(input: AgentInput): SharedTradingSnapshot {
  return {
    asOf: input.freshness.marketAsOf,
    market: input.market,
    orderBook: input.orderBook,
    recentTrades: input.recentTrades,
    account: {
      address: input.account.address,
      valueKind: input.account.valueKind,
      sourceLabel: input.account.sourceLabel,
      liveAccountDataLoaded: input.account.liveAccountDataLoaded,
      liveAccountDataUnavailable: input.account.liveAccountDataUnavailable,
      updatedAt: input.account.updatedAt,
      equityUsd: input.account.equityUsd,
      availableUsd: input.account.availableUsd,
      marginUsedUsd: input.account.marginUsedUsd,
      unrealizedPnlUsd: input.account.unrealizedPnlUsd,
      dailyLiveNotionalUsedUsd: input.account.dailyLiveNotionalUsedUsd,
      simulatedBalanceUsd: input.account.simulatedBalanceUsd,
      positions: input.account.positions,
      openOrders: [],
      fills: [],
    },
  };
}

function maxFinite(values: number[]): number | undefined {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.max(...finite) : undefined;
}

function minFinite(values: number[]): number | undefined {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.min(...finite) : undefined;
}
