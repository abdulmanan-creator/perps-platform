import type {
  OrderAction,
  PredictionBalanceState,
  PredictionLiveOrderRequest,
  PredictionPaperAccount,
  PredictionPaperFill,
  PredictionPaperOrderRequest,
  PredictionPaperPosition,
  PredictionOutcome,
  PredictionOutcomeOdds,
  PredictionOutcomeSide,
  PredictionQuestion,
  PredictionQuestionOdds,
  PredictionSideOdds,
  PredictionUsdcTransferBuildResponse,
  PredictionUsdcTransferSendResponse,
  Signature,
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

export type PredictionStreamStatus = "idle" | "connecting" | "live" | "rest_fallback" | "disconnected";

export interface PredictionL2BookUpdate {
  coin: string;
  receivedAt: number;
  bids: Array<{ px: string; sz: string }>;
  asks: Array<{ px: string; sz: string }>;
}

export const PREDICTION_LIVE_EXCHANGE_PATH = "/prediction/exchange";
export const PREDICTION_BALANCE_PATH = "/prediction/balance";
export const PREDICTION_USDC_TRANSFER_PATH = "/prediction/usdc-transfer";
export const PREDICTION_ODDS_TIMEOUT_MS = 4_500;
export const PREDICTION_ODDS_CONCURRENCY = 2;
const WORLD_CUP_QUESTION_ID = 32;
const WORLD_CUP_PRIORITY_OUTCOMES = [189, 173, 178, 188, 205, 212, 200, 217, 190, 202];

interface PredictionFetchOptions {
  timeoutMs?: number;
}

export function isPredictionLiveTradingEnabled(
  value = process.env.NEXT_PUBLIC_AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING,
): boolean {
  return value === "true";
}

export function getPredictionHip4MinOrderCostUsd(
  value = process.env.NEXT_PUBLIC_AGENT_TRADE_HIP4_MIN_ORDER_COST_USD,
): number {
  const parsed = Number(value ?? "10");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

export function getPredictionHip4EffectiveMinOrderCostUsd(
  value = process.env.NEXT_PUBLIC_AGENT_TRADE_HIP4_EFFECTIVE_MIN_ORDER_COST_USD,
  minCostUsd = getPredictionHip4MinOrderCostUsd(),
): number {
  const parsed = Number(value ?? "11");
  const effectiveMin = Number.isFinite(parsed) && parsed > 0 ? parsed : 11;
  return Math.max(minCostUsd, effectiveMin);
}

export function isPredictionWorldCupStreamEnabled(questionId: number): boolean {
  return questionId === WORLD_CUP_QUESTION_ID;
}

export function predictionHip4Encoding(outcome: number, side: 0 | 1): number {
  return 10 * outcome + side;
}

export function predictionHip4Coin(outcome: number, side: 0 | 1): string {
  return `#${predictionHip4Encoding(outcome, side)}`;
}

export function predictionHyperliquidWsUrl(): string {
  return process.env.NEXT_PUBLIC_HYPERLIQUID_WS_URL ?? "wss://api.hyperliquid.xyz/ws";
}

export function predictionL2BookSubscription(coin: string) {
  return {
    method: "subscribe",
    subscription: {
      type: "l2Book",
      coin,
      nSigFigs: 5,
      fast: true,
    },
  };
}

export function predictionL2BookUnsubscribe(coin: string) {
  return {
    ...predictionL2BookSubscription(coin),
    method: "unsubscribe",
  };
}

export function predictionStreamStatusLabel(status: PredictionStreamStatus): string {
  switch (status) {
    case "idle":
      return "REST fallback";
    case "connecting":
      return "REST fallback";
    case "live":
      return "Live World Cup book";
    case "rest_fallback":
      return "REST fallback";
    case "disconnected":
      return "Stream disconnected";
    default:
      return assertNeverPredictionStreamStatus(status);
  }
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

export async function loadPredictionQuestionOdds(
  questionId: number,
  options: PredictionFetchOptions = {},
): Promise<PredictionQuestionOdds> {
  return fetchJsonWithTimeout<PredictionQuestionOdds>(
    `${API_BASE_URL}/prediction/questions/${questionId}/odds`,
    options.timeoutMs ?? PREDICTION_ODDS_TIMEOUT_MS,
    `prediction question odds request failed for ${questionId}`,
  );
}

export async function loadPredictionDiscoveryOddsSummaries(args: {
  questionIds: number[];
  timeoutMs?: number;
  concurrency?: number;
}): Promise<PredictionDiscoveryOddsSummary[]> {
  const summaries: PredictionDiscoveryOddsSummary[] = [];
  await mapWithConcurrency(
    args.questionIds,
    args.concurrency ?? PREDICTION_ODDS_CONCURRENCY,
    async (questionId) => {
      try {
        const summary = summarizeQuestionOdds(
          await loadPredictionQuestionOdds(questionId, { timeoutMs: args.timeoutMs }),
        );
        summaries.push(summary);
      } catch {
        // Discovery cards must stay usable when odds are slow or rate-limited.
      }
    },
  );
  return summaries;
}

export async function loadPredictionOutcomeOdds(
  outcomeId: number,
  options: PredictionFetchOptions = {},
): Promise<PredictionOutcomeOdds> {
  return fetchJsonWithTimeout<PredictionOutcomeOdds>(
    `${API_BASE_URL}/prediction/outcomes/${outcomeId}/odds`,
    options.timeoutMs ?? PREDICTION_ODDS_TIMEOUT_MS,
    `prediction outcome odds request failed for ${outcomeId}`,
  );
}

export async function loadPredictionQuestionOddsProgressive(args: {
  question: PredictionQuestion;
  selectedOutcomeId?: number;
  limit?: number;
  timeoutMs?: number;
  concurrency?: number;
  onOutcome?: (outcome: PredictionOutcomeOdds) => void;
}): Promise<PredictionQuestionOdds> {
  const orderedOutcomeIds = prioritizePredictionOutcomeIds(args.question, args.selectedOutcomeId)
    .slice(0, args.limit ?? 10);
  const outcomes = await mapWithConcurrency(
    orderedOutcomeIds,
    args.concurrency ?? PREDICTION_ODDS_CONCURRENCY,
    async (outcomeId) => {
      const outcomeOdds = await loadPredictionOutcomeOdds(outcomeId, { timeoutMs: args.timeoutMs });
      args.onOutcome?.(outcomeOdds);
      return outcomeOdds;
    },
  );
  return {
    questionId: args.question.questionId,
    name: args.question.name,
    fetchedAt: Date.now(),
    outcomes,
  };
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

export async function loadPredictionBalance(user: string): Promise<PredictionBalanceState> {
  const url = new URL(`${API_BASE_URL}${PREDICTION_BALANCE_PATH}`);
  url.searchParams.set("user", user);
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`prediction balance request failed: ${res.status}`);
  }
  return (await res.json()) as PredictionBalanceState;
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

export function predictionUsdcTransferEndpoint(apiBaseUrl = API_BASE_URL): string {
  return `${apiBaseUrl}${PREDICTION_USDC_TRANSFER_PATH}`;
}

export async function buildPredictionUsdcTransfer(args: {
  user: string;
  amount: string;
  apiBaseUrl?: string;
}): Promise<PredictionUsdcTransferBuildResponse> {
  const res = await fetch(predictionUsdcTransferEndpoint(args.apiBaseUrl), {
    method: "POST",
    cache: "no-store",
    headers: predictionLiveRiskHeaders(),
    body: JSON.stringify({ user: args.user, amount: args.amount }),
  });
  if (!res.ok) {
    throw new Error(await predictionApiErrorMessage(res, "Prediction USDC transfer build failed"));
  }
  return (await res.json()) as PredictionUsdcTransferBuildResponse;
}

export async function sendPredictionUsdcTransfer(args: {
  user?: string;
  action: PredictionUsdcTransferBuildResponse["action"];
  nonce: number;
  signature: Signature;
  apiBaseUrl?: string;
}): Promise<PredictionUsdcTransferSendResponse> {
  const res = await fetch(predictionUsdcTransferEndpoint(args.apiBaseUrl), {
    method: "POST",
    cache: "no-store",
    headers: predictionLiveRiskHeaders(),
    body: JSON.stringify({ user: args.user, action: args.action, nonce: args.nonce, signature: args.signature }),
  });
  if (!res.ok) {
    throw new Error(await predictionApiErrorMessage(res, "Prediction USDC transfer send failed"));
  }
  return (await res.json()) as PredictionUsdcTransferSendResponse;
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
        p: formatPredictionLivePriceWire(args.order.limitProbability),
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

export function mergePredictionOutcomeOdds(
  current: PredictionQuestionOdds | undefined,
  question: PredictionQuestion,
  nextOutcome: PredictionOutcomeOdds,
): PredictionQuestionOdds {
  const currentOutcomes = current?.outcomes ?? [];
  const merged = [
    ...currentOutcomes.filter((outcome) => outcome.outcome !== nextOutcome.outcome),
    nextOutcome,
  ];
  const order = new Map(question.namedOutcomes.map((outcome, index) => [outcome.outcome, index]));
  if (question.fallbackOutcome) order.set(question.fallbackOutcome.outcome, -1);
  return {
    questionId: question.questionId,
    name: question.name,
    fetchedAt: Date.now(),
    outcomes: merged.sort((a, b) => (order.get(a.outcome) ?? 9999) - (order.get(b.outcome) ?? 9999)),
  };
}

export function clearPredictionStreamOutcomeOdds(
  current: PredictionQuestionOdds | undefined,
  outcomeId: number | undefined,
): PredictionQuestionOdds | undefined {
  if (!current || outcomeId === undefined) {
    return current;
  }
  return {
    ...current,
    outcomes: current.outcomes.filter((outcome) => outcome.outcome !== outcomeId),
    fetchedAt: Date.now(),
  };
}

export function normalizePredictionL2BookMessage(args: {
  message: unknown;
  selectedCoin: string;
  now?: number;
}): PredictionL2BookUpdate | undefined {
  const record = objectRecord(args.message);
  if (!record || record.channel === "subscriptionResponse" || record.channel === "pong") {
    return undefined;
  }
  if (record.channel !== "l2Book") {
    return undefined;
  }

  const data = objectRecord(record.data);
  const coin = typeof data?.coin === "string" ? data.coin : undefined;
  if (coin !== args.selectedCoin) {
    return undefined;
  }

  const levels = Array.isArray(data?.levels) ? data.levels : [];
  const bids = parsePredictionBookLevels(levels[0]);
  const asks = parsePredictionBookLevels(levels[1]);
  return {
    coin,
    receivedAt: args.now ?? Date.now(),
    bids,
    asks,
  };
}

export function mergePredictionL2BookUpdate(args: {
  current: PredictionQuestionOdds | undefined;
  question: PredictionQuestion;
  outcomeId: number;
  sideIndex: 0 | 1;
  update: PredictionL2BookUpdate;
}): PredictionQuestionOdds {
  const outcome = predictionQuestionOutcome(args.question, args.outcomeId);
  if (!outcome) {
    return args.current ?? {
      questionId: args.question.questionId,
      name: args.question.name,
      fetchedAt: args.update.receivedAt,
      outcomes: [],
    };
  }

  const existingOutcome = selectedOutcomeOdds(args.current, args.outcomeId);
  const existingSides = existingOutcome?.sides ?? [
    emptyPredictionSideOdds(outcome.sides[0], args.update.receivedAt),
    emptyPredictionSideOdds(outcome.sides[1], args.update.receivedAt),
  ];
  const nextSides = [...existingSides] as [PredictionSideOdds, PredictionSideOdds];
  nextSides[args.sideIndex] = predictionSideOddsFromBook({
    side: outcome.sides[args.sideIndex],
    update: args.update,
  });

  return mergePredictionOutcomeOdds(args.current, args.question, {
    outcome: outcome.outcome,
    name: outcome.name,
    description: outcome.description,
    quoteToken: outcome.quoteToken,
    sides: nextSides,
  });
}

export function prioritizePredictionOutcomeIds(
  question: PredictionQuestion,
  selectedOutcomeId?: number,
): number[] {
  const allIds = question.namedOutcomes.map((outcome) => outcome.outcome);
  const priority = question.questionId === WORLD_CUP_QUESTION_ID
    ? WORLD_CUP_PRIORITY_OUTCOMES.filter((outcomeId) => allIds.includes(outcomeId))
    : allIds.slice(0, 8);
  return uniqueNumbers([
    selectedOutcomeId,
    ...priority,
    ...allIds,
  ]);
}

export function hasValidPredictionTopOfBook(side: PredictionSideOdds | undefined): boolean {
  return Boolean(side?.bestBid && side.bestAsk && !side.emptyBook);
}

export function hasSufficientPredictionSpotBalance(
  balance: PredictionBalanceState | undefined,
  requiredCostUsd: number,
): boolean {
  if (!balance || !Number.isFinite(requiredCostUsd)) return false;
  const available = Number(balance.spotUsdcAvailable);
  return Number.isFinite(available) && available + 1e-9 >= requiredCostUsd;
}

export function shouldShowPredictionUsdcTransferCard(input: {
  mode: "paper" | "live";
  liveAllowed: boolean;
  balance: PredictionBalanceState | undefined;
  requiredCostUsd: number;
}): boolean {
  if (input.mode !== "live" || !input.liveAllowed || !input.balance) return false;
  if (hasSufficientPredictionSpotBalance(input.balance, input.requiredCostUsd)) return false;
  const perpWithdrawable = Number(maxTransferablePredictionUsdc(input.balance) ?? 0);
  return Number.isFinite(perpWithdrawable) && perpWithdrawable > 0;
}

export function suggestPredictionUsdcTransferAmount(input: {
  requiredCostUsd: number;
  spotUsdcAvailable: number | string;
  perpWithdrawable?: number | string | null;
  maxTransferableUsdc?: number | string | null;
}): string {
  const required = Number.isFinite(input.requiredCostUsd) ? input.requiredCostUsd : 0;
  const spot = Number(input.spotUsdcAvailable);
  const max = normalizePredictionUsdcAmount(input.maxTransferableUsdc ?? input.perpWithdrawable ?? null);
  const perp = Number(max ?? 0);
  const shortfall = Math.max(0, required - spot);
  if (shortfall <= 0 || perp <= 0) return "";
  const buffer = Math.min(1, Math.max(0.25, required * 0.02));
  const suggested = Math.min(perp, shortfall + buffer);
  const rounded = formatTransferAmount(Math.ceil(suggested * 100) / 100);
  return comparePredictionUsdcAmounts(rounded, max) === 1 ? max ?? "" : rounded;
}

export function maxTransferablePredictionUsdc(balance: PredictionBalanceState | undefined): string | null {
  if (!balance) return null;
  return normalizePredictionUsdcAmount(balance.maxTransferableUsdc ?? balance.perpWithdrawable ?? null);
}

export function formatUsdcExact(value: string | number | null | undefined): string {
  const normalized = normalizePredictionUsdcAmount(value);
  return normalized ? `${normalized} USDC` : "--";
}

export function isPredictionUsdcTransferAmountValid(input: {
  amount: string;
  maxTransferableUsdc: string | null;
}): boolean {
  const amount = normalizePredictionUsdcAmount(input.amount);
  const max = normalizePredictionUsdcAmount(input.maxTransferableUsdc);
  if (!amount || !max) return false;
  const amountUnits = parsePredictionUsdcUnits(amount);
  const maxUnits = parsePredictionUsdcUnits(max);
  return amountUnits !== undefined && amountUnits > 0n && maxUnits !== undefined && amountUnits <= maxUnits;
}

export function predictionUsdcTransferValidationMessage(input: {
  amount: string;
  maxTransferableUsdc: string | null;
}): string | undefined {
  const max = normalizePredictionUsdcAmount(input.maxTransferableUsdc);
  const amount = normalizePredictionUsdcAmount(input.amount);
  if (!amount) return "Enter an amount above 0 with up to 6 decimals.";
  if (!max || parsePredictionUsdcUnits(max) === 0n) return "No perp withdrawable USDC is available to move.";
  if (comparePredictionUsdcAmounts(amount, max) === 1) {
    return `Available transfer amount is ${max} USDC. Use max.`;
  }
  return undefined;
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

export function minimumPredictionContractsForCost(probability: number, minCostUsd: number): number {
  const wirePrice = Number(formatPredictionLivePriceWire(probability));
  if (!Number.isFinite(wirePrice) || wirePrice <= 0 || !Number.isFinite(minCostUsd) || minCostUsd <= 0) {
    return 0;
  }
  const minimum = Math.max(1, Math.ceil(minCostUsd / wirePrice));
  const cost = round(minimum * wirePrice);
  return cost <= minCostUsd + 1e-9 ? minimum + 1 : minimum;
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

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number, message: string): Promise<T> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error(`${message}: ${res.status}`);
    return (await res.json()) as T;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function predictionLiveRiskHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    "x-agent-trade-risk-accepted": "true",
    "x-agent-trade-terms-accepted": "true",
  };
}

async function predictionApiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string; message?: string; guidance?: string; state?: string };
    return [body.state, body.error, body.guidance, body.message].filter(Boolean).join(" ") || `${fallback}: ${response.status}`;
  } catch {
    return `${fallback}: ${response.status}`;
  }
}

function formatTransferAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

function normalizePredictionUsdcAmount(input: string | number | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const units = parsePredictionUsdcUnits(String(input));
  return units === undefined ? null : formatPredictionUsdcUnits(units);
}

function comparePredictionUsdcAmounts(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
): -1 | 0 | 1 | undefined {
  const leftUnits = parsePredictionUsdcUnits(String(left ?? ""));
  const rightUnits = parsePredictionUsdcUnits(String(right ?? ""));
  if (leftUnits === undefined || rightUnits === undefined) return undefined;
  if (leftUnits < rightUnits) return -1;
  if (leftUnits > rightUnits) return 1;
  return 0;
}

function parsePredictionUsdcUnits(input: string): bigint | undefined {
  const trimmed = input.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(trimmed)) return undefined;
  const [whole, fraction = ""] = trimmed.split(".");
  return BigInt(whole ?? "0") * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function formatPredictionUsdcUnits(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item === undefined) continue;
      out.push(await worker(item));
    }
  }));
  return out;
}

function uniqueNumbers(values: Array<number | undefined>): number[] {
  return Array.from(new Set(values.filter((value): value is number => typeof value === "number")));
}

function predictionQuestionOutcome(
  question: PredictionQuestion,
  outcomeId: number,
): PredictionOutcome | undefined {
  return question.namedOutcomes.find((outcome) => outcome.outcome === outcomeId) ??
    (question.fallbackOutcome?.outcome === outcomeId ? question.fallbackOutcome ?? undefined : undefined);
}

function predictionSideOddsFromBook(args: {
  side: PredictionOutcomeSide;
  update: PredictionL2BookUpdate;
}): PredictionSideOdds {
  const bid = args.update.bids[0]?.px ?? null;
  const ask = args.update.asks[0]?.px ?? null;
  const bidNumber = bid === null ? null : Number(bid);
  const askNumber = ask === null ? null : Number(ask);
  const midpointProbability = bidNumber !== null &&
    askNumber !== null &&
    Number.isFinite(bidNumber) &&
    Number.isFinite(askNumber)
    ? round((bidNumber + askNumber) / 2)
    : null;
  const spread = bidNumber !== null &&
    askNumber !== null &&
    Number.isFinite(bidNumber) &&
    Number.isFinite(askNumber)
    ? round(askNumber - bidNumber)
    : null;

  return {
    ...args.side,
    bestBid: bid,
    bestAsk: ask,
    midpointProbability,
    spread,
    depth: predictionDepthSummary(args.update.bids, args.update.asks),
    emptyBook: args.update.bids.length === 0 && args.update.asks.length === 0,
    fetchedAt: args.update.receivedAt,
  };
}

function emptyPredictionSideOdds(
  side: PredictionOutcomeSide,
  fetchedAt: number,
): PredictionSideOdds {
  return {
    ...side,
    bestBid: null,
    bestAsk: null,
    midpointProbability: null,
    spread: null,
    depth: { bidLevels: 0, askLevels: 0, bidSize: 0, askSize: 0, bidNotional: 0, askNotional: 0 },
    emptyBook: true,
    fetchedAt,
  };
}

function predictionDepthSummary(
  bids: Array<{ px: string; sz: string }>,
  asks: Array<{ px: string; sz: string }>,
) {
  return {
    bidLevels: bids.length,
    askLevels: asks.length,
    bidSize: round(sumPredictionBookSize(bids)),
    askSize: round(sumPredictionBookSize(asks)),
    bidNotional: round(sumPredictionBookNotional(bids)),
    askNotional: round(sumPredictionBookNotional(asks)),
  };
}

function sumPredictionBookSize(levels: Array<{ px: string; sz: string }>): number {
  return levels.reduce((sum, level) => sum + (finitePositiveNumber(level.sz) ?? 0), 0);
}

function sumPredictionBookNotional(levels: Array<{ px: string; sz: string }>): number {
  return levels.reduce((sum, level) => {
    const px = finitePositiveNumber(level.px) ?? 0;
    const sz = finitePositiveNumber(level.sz) ?? 0;
    return sum + px * sz;
  }, 0);
}

function parsePredictionBookLevels(input: unknown): Array<{ px: string; sz: string }> {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.flatMap((item) => {
    const record = objectRecord(item);
    const px = typeof record?.px === "string" ? record.px : undefined;
    const sz = typeof record?.sz === "string" ? record.sz : undefined;
    if (px === undefined || sz === undefined) {
      return [];
    }
    if (finitePositiveNumber(px) === null || finitePositiveNumber(sz) === null) {
      return [];
    }
    return [{ px, sz }];
  });
}

function finitePositiveNumber(input: string | undefined): number | null {
  if (input === undefined) {
    return null;
  }
  const parsed = Number(input);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function objectRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
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

export function formatPredictionLivePriceWire(value: number): string {
  return formatHip4PredictionPrice(value);
}

function formatHip4PredictionPrice(price: string | number): string {
  const parsed = typeof price === "number" ? price : Number(price);
  if (!Number.isFinite(parsed)) return "0";
  if (parsed === 0) return "0";
  return (Math.round(parsed * 10_000) / 10_000)
    .toFixed(4)
    .replace(/0+$/u, "")
    .replace(/\.$/u, "");
}

function round(value: number, decimals = 6): number {
  return Number(value.toFixed(decimals));
}

function assertNeverPredictionStreamStatus(status: never): string {
  return status;
}

export type {
  PredictionBalanceState,
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
