import type {
  OrderAction,
  PredictionLiveOrderRequest,
  PredictionPaperAccount,
  PredictionPaperFill,
  PredictionPaperOrderRequest,
  PredictionPaperPosition,
  PredictionOutcome,
  PredictionOutcomeOdds,
  PredictionQuestion,
  PredictionQuestionOdds,
  PredictionSideOdds,
} from "@alchemy-hl/shared";

import { API_BASE_URL } from "../api";
import { getPaperSessionId, paperSessionHeaders } from "./paper";

export type PredictionFilterKey =
  | "all"
  | "open"
  | "soon"
  | "resolved"
  | "sports"
  | "economics"
  | "crypto"
  | "thin";

export type PredictionSortKey = "default" | "liquidity" | "outcomes" | "name";

export interface PredictionQuestionsResponse {
  questions: PredictionQuestion[];
}

export interface PredictionDiscoveryOddsSummary {
  questionId: number;
  fetchedAt: number;
  outcomeCount: number;
  visibleOutcomes: Array<{
    outcome: number;
    name: string;
    midpointProbability: number | null;
    bestBid: string | null;
    bestAsk: string | null;
    emptyBook: boolean;
  }>;
  nonEmptySideCount: number;
  totalDepth: number;
  widestSpread: number | null;
  hasThinLiquidity: boolean;
}

export interface PredictionDiscoveryQuestion extends PredictionQuestion {
  oddsSummary?: PredictionDiscoveryOddsSummary;
}

export interface PredictionTicketMath {
  contracts: number;
  probability: number;
  estimatedCost: number;
  maxPayout: number;
  maxProfit: number;
  maxLoss: number;
  breakEvenProbability: number;
}

export interface PredictionPortfolioExposure {
  positionCount: number;
  totalContracts: number;
  totalCost: number;
  currentValue: number;
  maxPayout: number;
  unrealizedPnl: number;
}

export interface PredictionLiveExchangeResult {
  status: "filled" | "resting" | "rejected" | "accepted";
  label: string;
  reason?: string;
  oid?: number;
}

export const PREDICTION_LIVE_EXCHANGE_PATH = "/prediction/exchange";

export function isPredictionLiveTradingEnabled(
  value = process.env.NEXT_PUBLIC_AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING,
): boolean {
  return value === "true";
}

export async function loadPredictionQuestions(): Promise<PredictionQuestion[]> {
  const res = await fetch(`${API_BASE_URL}/prediction/questions`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`prediction questions request failed: ${res.status}`);
  }
  const body = (await res.json()) as PredictionQuestionsResponse;
  return body.questions ?? [];
}

export async function loadPredictionQuestion(questionId: number): Promise<PredictionQuestion> {
  const res = await fetch(`${API_BASE_URL}/prediction/questions/${questionId}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`prediction question request failed: ${res.status}`);
  }
  const body = (await res.json()) as { question: PredictionQuestion };
  return body.question;
}

export async function loadPredictionQuestionOdds(questionId: number): Promise<PredictionQuestionOdds> {
  const res = await fetch(`${API_BASE_URL}/prediction/questions/${questionId}/odds`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`prediction question odds request failed: ${res.status}`);
  }
  return (await res.json()) as PredictionQuestionOdds;
}

export async function loadPredictionPaperAccount(
  sessionId = getPaperSessionId(),
): Promise<PredictionPaperAccount | undefined> {
  try {
    const res = await fetch(`${API_BASE_URL}/prediction/paper-account`, {
      cache: "no-store",
      headers: paperSessionHeaders(sessionId),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as PredictionPaperAccount;
  } catch {
    return undefined;
  }
}

export async function submitPredictionPaperOrder(
  order: PredictionPaperOrderRequest,
  sessionId = getPaperSessionId(),
): Promise<{ id: string; status: "accepted"; mode: "paper"; account: PredictionPaperAccount }> {
  const res = await fetch(`${API_BASE_URL}/prediction/paper-orders`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...paperSessionHeaders(sessionId),
    },
    body: JSON.stringify(order),
  });
  if (!res.ok) {
    throw new Error(`prediction paper order failed: ${res.status}`);
  }
  return (await res.json()) as { id: string; status: "accepted"; mode: "paper"; account: PredictionPaperAccount };
}

export function predictionLiveExchangeEndpoint(apiBaseUrl = API_BASE_URL): string {
  return `${apiBaseUrl}${PREDICTION_LIVE_EXCHANGE_PATH}`;
}

export function buildPredictionLiveOrderAction(args: {
  order: PredictionLiveOrderRequest;
  assetId: number;
}): OrderAction {
  return {
    type: "order",
    grouping: "na",
    orders: [
      {
        a: args.assetId,
        b: args.order.action === "buy",
        p: formatProbabilityWire(args.order.limitProbability),
        s: String(Math.floor(args.order.contracts)),
        r: false,
        t: { limit: { tif: args.order.tif } },
      },
    ],
  };
}

export function summarizePredictionLiveExchangeResult(response: unknown): PredictionLiveExchangeResult {
  const direct = response && typeof response === "object"
    ? (response as { exchangeResult?: PredictionLiveExchangeResult }).exchangeResult
    : undefined;
  if (direct?.status) return direct;

  const exchangeResponse = response && typeof response === "object"
    ? (response as { exchangeResponse?: unknown }).exchangeResponse
    : response;
  const inner = exchangeResponse && typeof exchangeResponse === "object"
    ? (exchangeResponse as { response?: unknown }).response
    : undefined;
  const data = inner && typeof inner === "object" ? (inner as { data?: unknown }).data : undefined;
  const statuses = data && typeof data === "object" ? (data as { statuses?: unknown }).statuses : undefined;
  if (!Array.isArray(statuses)) return { status: "accepted", label: "Accepted" };

  for (const status of statuses) {
    const error = status && typeof status === "object" ? (status as { error?: unknown }).error : undefined;
    if (typeof error === "string" && error.trim()) {
      return { status: "rejected", label: "Rejected", reason: error.trim() };
    }
  }
  for (const status of statuses) {
    const filled = status && typeof status === "object" ? (status as { filled?: { oid?: number } }).filled : undefined;
    if (filled) return { status: "filled", label: "Filled", oid: filled.oid };
  }
  for (const status of statuses) {
    const resting = status && typeof status === "object" ? (status as { resting?: { oid?: number } }).resting : undefined;
    if (resting) return { status: "resting", label: "Resting open order", oid: resting.oid };
  }
  return { status: "accepted", label: "Accepted" };
}

export function summarizeQuestionOdds(odds: PredictionQuestionOdds): PredictionDiscoveryOddsSummary {
  const sideOdds = odds.outcomes.flatMap((outcome) => outcome.sides);
  const nonEmptySideCount = sideOdds.filter((side) => !side.emptyBook).length;
  const totalDepth = sideOdds.reduce((sum, side) => sum + side.depth.bidSize + side.depth.askSize, 0);
  const spreads = sideOdds
    .map((side) => side.spread)
    .filter((spread): spread is number => spread !== null);
  const widestSpread = spreads.length > 0 ? Math.max(...spreads) : null;
  const visibleOutcomes = odds.outcomes.slice(0, 4).map((outcome) => {
    const side = mostLiquidSide(outcome);
    return {
      outcome: outcome.outcome,
      name: outcome.name,
      midpointProbability: side?.midpointProbability ?? null,
      bestBid: side?.bestBid ?? null,
      bestAsk: side?.bestAsk ?? null,
      emptyBook: side?.emptyBook ?? true,
    };
  });

  return {
    questionId: odds.questionId,
    fetchedAt: odds.fetchedAt,
    outcomeCount: odds.outcomes.length,
    visibleOutcomes,
    nonEmptySideCount,
    totalDepth,
    widestSpread,
    hasThinLiquidity: nonEmptySideCount === 0 || totalDepth < 100 || (widestSpread !== null && widestSpread >= 0.2),
  };
}

export function filterAndSortPredictionQuestions(args: {
  questions: PredictionDiscoveryQuestion[];
  query: string;
  filter: PredictionFilterKey;
  sort: PredictionSortKey;
  now?: Date;
}): PredictionDiscoveryQuestion[] {
  const query = args.query.trim().toLowerCase();
  const now = args.now ?? new Date();
  return args.questions
    .filter((question) => matchesPredictionQuery(question, query))
    .filter((question) => matchesPredictionFilter(question, args.filter, now))
    .sort((a, b) => comparePredictionQuestions(a, b, args.sort));
}

export function formatProbability(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${(value * 100).toFixed(value >= 0.1 ? 1 : 2)}%`;
}

export function formatProbabilityPrice(value: string | null | undefined): string {
  if (!value) return "--";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "--";
  return parsed.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

export function formatUsdc(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${value.toFixed(2)} USDC`;
}

export function formatSpread(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${(value * 100).toFixed(1)} pts`;
}

export function formatEmptyBook(side: Pick<PredictionSideOdds, "emptyBook" | "bestBid" | "bestAsk">): string {
  if (side.emptyBook) return "Empty book";
  if (!side.bestBid || !side.bestAsk) return "One-sided book";
  return "Two-sided book";
}

export function predictionStatusLabel(question: PredictionQuestion): string {
  if (question.settlement.state === "settled") return "Resolved";
  if (question.settlement.state === "partiallySettled") return "Partially resolved";
  return "Open";
}

export function predictionCategoryLabel(question: PredictionQuestion): string {
  const category = question.metadata?.category;
  const subCategory = question.metadata?.subCategory;
  if (category && subCategory && subCategory !== "N/A") return `${titleCase(category)} / ${titleCase(subCategory)}`;
  if (category) return titleCase(category);
  return "Uncategorized";
}

export function marketResolutionDate(question: PredictionQuestion): Date | null {
  const text = `${question.criteria} ${question.description}`;
  const iso = text.match(/\b20\d{2}-\d{2}-\d{2}\b/u)?.[0];
  if (iso) return validDate(new Date(`${iso}T00:00:00Z`));

  const longDate = text.match(
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+20\d{2}\b/iu,
  )?.[0];
  return longDate ? validDate(new Date(`${longDate} UTC`)) : null;
}

export function isResolvingSoon(question: PredictionQuestion, now = new Date()): boolean {
  const date = marketResolutionDate(question);
  if (!date) return false;
  const delta = date.getTime() - now.getTime();
  return delta >= 0 && delta <= 14 * 24 * 60 * 60 * 1000;
}

export function selectedOutcomeOdds(
  odds: PredictionQuestionOdds | undefined,
  outcomeId: number,
): PredictionOutcomeOdds | undefined {
  return odds?.outcomes.find((outcome) => outcome.outcome === outcomeId);
}

export function probabilityFromSide(side: PredictionSideOdds | undefined): number | null {
  if (!side) return null;
  if (side.midpointProbability !== null) return side.midpointProbability;
  const fallback = Number(side.bestAsk ?? side.bestBid);
  return Number.isFinite(fallback) ? fallback : null;
}

export function calculatePredictionTicketMath(contracts: number, probability: number): PredictionTicketMath {
  const normalizedContracts = Number.isFinite(contracts) ? Math.max(0, Math.floor(contracts)) : 0;
  const normalizedProbability = clampProbability(probability);
  const estimatedCost = round(normalizedContracts * normalizedProbability);
  const maxPayout = normalizedContracts;
  return {
    contracts: normalizedContracts,
    probability: normalizedProbability,
    estimatedCost,
    maxPayout,
    maxProfit: round(maxPayout - estimatedCost),
    maxLoss: estimatedCost,
    breakEvenProbability: normalizedProbability,
  };
}

export function enrichPredictionPaperPositions(
  account: PredictionPaperAccount | undefined,
  question: PredictionQuestion,
  odds: PredictionQuestionOdds | undefined,
): PredictionPaperPosition[] {
  if (!account) return [];
  return account.positions
    .filter((position) => position.questionId === question.questionId)
    .map((position) => {
      const outcomeOdds = selectedOutcomeOdds(odds, position.outcome);
      const currentProbability = probabilityFromSide(outcomeOdds?.sides[position.side]) ?? position.currentProbability;
      const currentValue = currentProbability === null ? null : round(position.contracts * currentProbability);
      return {
        ...position,
        currentProbability,
        currentValue,
        unrealizedPnl: currentValue === null ? null : round(currentValue - position.totalCost),
        resolutionStatus: question.settlement.state,
      };
    });
}

export function predictionPaperPositionsForQuestion(
  account: PredictionPaperAccount | undefined,
  questionId: number,
): PredictionPaperPosition[] {
  return (account?.positions ?? []).filter((position) => position.questionId === questionId);
}

export function predictionPaperFillsForQuestion(
  account: PredictionPaperAccount | undefined,
  questionId: number,
): PredictionPaperFill[] {
  return (account?.fills ?? []).filter((fill) => fill.questionId === questionId);
}

export function summarizePredictionPortfolioExposure(
  positions: PredictionPaperPosition[],
): PredictionPortfolioExposure {
  return positions.reduce<PredictionPortfolioExposure>(
    (summary, position) => ({
      positionCount: summary.positionCount + 1,
      totalContracts: round(summary.totalContracts + position.contracts),
      totalCost: round(summary.totalCost + position.totalCost),
      currentValue: round(summary.currentValue + (position.currentValue ?? 0)),
      maxPayout: round(summary.maxPayout + position.maxPayout),
      unrealizedPnl: round(summary.unrealizedPnl + (position.unrealizedPnl ?? 0)),
    }),
    { positionCount: 0, totalContracts: 0, totalCost: 0, currentValue: 0, maxPayout: 0, unrealizedPnl: 0 },
  );
}

function mostLiquidSide(outcome: PredictionOutcomeOdds): PredictionSideOdds | undefined {
  return [...outcome.sides].sort((a, b) => {
    const depthA = a.depth.bidSize + a.depth.askSize;
    const depthB = b.depth.bidSize + b.depth.askSize;
    return depthB - depthA;
  })[0];
}

function matchesPredictionQuery(question: PredictionDiscoveryQuestion, query: string): boolean {
  if (!query) return true;
  const haystack = [
    question.name,
    question.criteria,
    question.metadata?.category,
    question.metadata?.subCategory,
    ...question.namedOutcomes.map((outcome) => outcome.name),
    question.fallbackOutcome?.name,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function matchesPredictionFilter(
  question: PredictionDiscoveryQuestion,
  filter: PredictionFilterKey,
  now: Date,
): boolean {
  if (filter === "all") return true;
  if (filter === "open") return question.settlement.state === "open";
  if (filter === "soon") return isResolvingSoon(question, now);
  if (filter === "resolved") return question.settlement.state !== "open";
  if (filter === "thin") return question.oddsSummary?.hasThinLiquidity ?? false;
  const category = question.metadata?.category?.toLowerCase();
  if (filter === "sports") return category === "sports";
  if (filter === "economics") return category === "economics";
  if (filter === "crypto") return category === "crypto";
  return true;
}

function comparePredictionQuestions(
  a: PredictionDiscoveryQuestion,
  b: PredictionDiscoveryQuestion,
  sort: PredictionSortKey,
): number {
  if (sort === "name") return a.name.localeCompare(b.name);
  if (sort === "outcomes") return b.namedOutcomes.length - a.namedOutcomes.length || a.name.localeCompare(b.name);
  if (sort === "liquidity") {
    const depthA = a.oddsSummary?.totalDepth ?? -1;
    const depthB = b.oddsSummary?.totalDepth ?? -1;
    return depthB - depthA || a.name.localeCompare(b.name);
  }
  return a.questionId - b.questionId;
}

function titleCase(input: string): string {
  return input
    .split(/[\s_-]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function validDate(date: Date): Date | null {
  return Number.isNaN(date.getTime()) ? null : date;
}

export function maxPayoutForContracts(contracts: number): number {
  return Math.max(0, Math.floor(contracts));
}

export function premiumForContracts(contracts: number, probability: number | null | undefined): number | null {
  if (probability === null || probability === undefined || !Number.isFinite(probability)) return null;
  return Math.max(0, Math.floor(contracts)) * probability;
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function formatProbabilityWire(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(8).replace(/0+$/u, "").replace(/\.$/u, "");
}

function round(value: number, decimals = 6): number {
  return Number(value.toFixed(decimals));
}

export type {
  PredictionLiveOrderRequest,
  PredictionOutcome,
  PredictionOutcomeOdds,
  PredictionPaperAccount,
  PredictionPaperFill,
  PredictionPaperOrderRequest,
  PredictionPaperPosition,
  PredictionQuestion,
  PredictionQuestionOdds,
};
