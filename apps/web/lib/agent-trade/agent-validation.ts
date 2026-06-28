import type { AgentAnalysis, AgentInput, AgentProviderName, AgentResponseType } from "./agent-provider";
import type { BookLevel, RecentTrade } from "./types";
import type { AgentResponse, ChartAnnotation, OrderDraft, TradeSide } from "./types";

const RESPONSE_TYPES: AgentResponseType[] = ["greeting", "market_read", "trade_proposal", "no_trade", "refusal"];
const SIDES: Array<TradeSide | "none"> = ["long", "short", "none"];

export function parseAgentInput(input: unknown): AgentInput | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const market = isRecord(input.market) ? input.market : undefined;
  const orderBook = isRecord(input.orderBook) ? input.orderBook : undefined;
  const account = isRecord(input.account) ? input.account : undefined;
  const eligibility = isRecord(input.eligibility) ? input.eligibility : undefined;
  const freshness = isRecord(input.freshness) ? input.freshness : undefined;
  const candleSummary = isRecord(input.candleSummary) ? input.candleSummary : undefined;
  if (!market || !orderBook || !account || !eligibility || !freshness || !candleSummary) {
    return undefined;
  }
  if (
    typeof input.requestedPrompt !== "string" ||
    typeof market.symbol !== "string" ||
    typeof market.base !== "string" ||
    !isFiniteNumber(market.markPrice) ||
    !isFiniteNumber(market.oraclePrice) ||
    !isFiniteNumber(market.fundingRatePct) ||
    !isFiniteNumber(market.openInterestUsd) ||
    !Array.isArray(orderBook.bids) ||
    !Array.isArray(orderBook.asks) ||
    !Array.isArray(input.recentTrades) ||
    !isAccountSummary(account) ||
    !isEligibilityInput(eligibility) ||
    !isFiniteNumber(freshness.now) ||
    !isFiniteNumber(freshness.marketAsOf) ||
    !isFiniteNumber(freshness.marketAgeSeconds) ||
    !isFiniteNumber(input.timestamp)
  ) {
    return undefined;
  }

  const bids = orderBook.bids.filter(isBookLevel);
  const asks = orderBook.asks.filter(isBookLevel);
  const recentTrades = input.recentTrades.filter(isRecentTrade);
  if (
    bids.length !== orderBook.bids.length ||
    asks.length !== orderBook.asks.length ||
    recentTrades.length !== input.recentTrades.length
  ) {
    return undefined;
  }

  return input as unknown as AgentInput;
}

export function parseAgentAnalysis(output: unknown): AgentAnalysis | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  if (!isAgentResponseType(output.responseType) || !SIDES.includes(output.side as TradeSide | "none")) {
    return undefined;
  }
  if (
    typeof output.summary !== "string" ||
    typeof output.thesis !== "string" ||
    typeof output.riskNote !== "string" ||
    typeof output.whyWrong !== "string" ||
    !isFiniteNumber(output.confidence) ||
    output.confidence < 0 ||
    output.confidence > 1 ||
    !Array.isArray(output.receipts) ||
    !Array.isArray(output.warnings) ||
    !isRecord(output.provider) ||
    !isAgentProviderMetadata(output.provider)
  ) {
    return undefined;
  }
  const providerName = parseProviderName(output.provider.name);
  if (!providerName) {
    return undefined;
  }

  const orderDraft = output.orderDraft === undefined ? undefined : parseOrderDraft(output.orderDraft);
  if (output.responseType === "trade_proposal" && !orderDraft) {
    return undefined;
  }
  if (output.responseType !== "trade_proposal" && output.orderDraft !== undefined) {
    return undefined;
  }

  const receipts = output.receipts.filter(isAgentReceipt);
  if (receipts.length !== output.receipts.length) {
    return undefined;
  }

  const annotations = output.annotations === undefined ? undefined : parseAnnotations(output.annotations);
  if (output.annotations !== undefined && annotations === undefined) {
    return undefined;
  }

  const followUps = output.followUps === undefined ? undefined : parseStringArray(output.followUps);
  if (output.followUps !== undefined && followUps === undefined) {
    return undefined;
  }

  return {
    responseType: output.responseType,
    summary: output.summary,
    thesis: output.thesis,
    side: output.side as TradeSide | "none",
    confidence: output.confidence,
    receipts,
    riskNote: output.riskNote,
    whyWrong: output.whyWrong,
    orderDraft,
    warnings: output.warnings.filter((warning): warning is string => typeof warning === "string"),
    provider: {
      name: providerName,
      model: typeof output.provider.model === "string" ? output.provider.model : undefined,
      deterministic: output.provider.deterministic === true,
      generatedAt: Number(output.provider.generatedAt),
      latencyMs: isFiniteNumber(output.provider.latencyMs) ? output.provider.latencyMs : undefined,
      fallbackReason: typeof output.provider.fallbackReason === "string" ? output.provider.fallbackReason : undefined,
    },
    id: typeof output.id === "string" ? output.id : undefined,
    question: typeof output.question === "string" ? output.question : undefined,
    annotations,
    followUps,
  };
}

export function invalidAgentOutputRefusal(input: AgentInput, reason = "Provider returned invalid analysis."): AgentAnalysis {
  return {
    responseType: "refusal",
    summary: "No trade drafted.",
    thesis:
      "I could not validate the agent provider output, so I will not create or prefill an order ticket.",
    side: "none",
    confidence: 0,
    receipts: [
      { label: "Market", value: input.market.symbol, timestamp: input.freshness.marketAsOf },
      { label: "Provider output", value: "Rejected by schema", timestamp: input.timestamp },
    ],
    riskNote: "Malformed analysis must fail closed because an invalid ticket could misstate size, side, or price.",
    whyWrong: "The market setup may still be valid, but the provider response needs to pass schema validation first.",
    warnings: [reason],
    provider: {
      name: "deterministic",
      deterministic: true,
      generatedAt: input.timestamp,
      fallbackReason: reason,
    },
    id: "invalid-provider-output-refusal",
    question: input.requestedPrompt,
    annotations: [],
  };
}

export function agentAnalysisToResponse(analysis: AgentAnalysis, input: AgentInput): AgentResponse {
  const riskNote = analysis.warnings.length > 0
    ? `${analysis.riskNote} ${analysis.warnings.join(" ")}`
    : analysis.riskNote;
  return {
    id: analysis.id ?? `${input.market.base.toLowerCase()}-${analysis.responseType}`,
    state: responseTypeToState(analysis.responseType),
    responseType: analysis.responseType,
    question: analysis.question ?? input.requestedPrompt,
    summary: analysis.summary,
    thesis: analysis.thesis,
    confidence: analysis.confidence,
    receipts: analysis.receipts,
    riskNote,
    whyWrong: analysis.whyWrong,
    orderDraft: analysis.responseType === "trade_proposal" ? analysis.orderDraft : undefined,
    annotations: analysis.annotations ?? [],
    followUps: analysis.followUps,
    warnings: analysis.warnings,
    provider: analysis.provider,
  };
}

function responseTypeToState(responseType: AgentResponseType): AgentResponse["state"] {
  switch (responseType) {
    case "trade_proposal":
      return "tradeProposal";
    case "no_trade":
      return "noTrade";
    case "refusal":
      return "staleRefusal";
    case "greeting":
    case "market_read":
      return "answered";
    default:
      throw new Error(`Unsupported agent response type: ${responseType}`);
  }
}

function parseOrderDraft(input: unknown): OrderDraft | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  if (
    typeof input.symbol !== "string" ||
    !isTradeSide(input.side) ||
    (input.orderType !== "market" && input.orderType !== "limit") ||
    !isFiniteNumber(input.sizeBtc) ||
    input.sizeBtc <= 0 ||
    !isFiniteNumber(input.leverage) ||
    input.leverage <= 0 ||
    (input.marginMode !== "isolated" && input.marginMode !== "cross") ||
    typeof input.reduceOnly !== "boolean" ||
    typeof input.fromAgent !== "boolean"
  ) {
    return undefined;
  }
  const limitPrice = input.limitPrice;
  const takeProfit = input.takeProfit;
  const stopLoss = input.stopLoss;
  if (limitPrice !== undefined && (!isFiniteNumber(limitPrice) || limitPrice <= 0)) {
    return undefined;
  }
  if (takeProfit !== undefined && (!isFiniteNumber(takeProfit) || takeProfit <= 0)) {
    return undefined;
  }
  if (stopLoss !== undefined && (!isFiniteNumber(stopLoss) || stopLoss <= 0)) {
    return undefined;
  }

  return {
    symbol: input.symbol,
    side: input.side,
    orderType: input.orderType,
    sizeBtc: input.sizeBtc,
    leverage: input.leverage,
    marginMode: input.marginMode,
    reduceOnly: input.reduceOnly,
    limitPrice,
    takeProfit,
    stopLoss,
    fromAgent: input.fromAgent,
    scenarioId: typeof input.scenarioId === "string" ? input.scenarioId : undefined,
  };
}

function parseAnnotations(input: unknown): ChartAnnotation[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const annotations = input.filter(isAnnotation);
  return annotations.length === input.length ? annotations : undefined;
}

function parseStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const strings = input.filter((value): value is string => typeof value === "string");
  return strings.length === input.length ? strings : undefined;
}

function isAgentResponseType(input: unknown): input is AgentResponseType {
  return typeof input === "string" && RESPONSE_TYPES.includes(input as AgentResponseType);
}

function isAgentProviderMetadata(input: Record<string, unknown>) {
  return (
    typeof input.name === "string" &&
    typeof input.deterministic === "boolean" &&
    Number.isFinite(input.generatedAt)
  );
}

export function parseProviderName(input: unknown): AgentProviderName | undefined {
  if (
    input === "deterministic" ||
    input === "openai" ||
    input === "anthropic" ||
    input === "deepseek" ||
    input === "qwen" ||
    input === "openrouter"
  ) {
    return input;
  }
  return undefined;
}

function isAgentReceipt(input: unknown) {
  return (
    isRecord(input) &&
    typeof input.label === "string" &&
    typeof input.value === "string" &&
    Number.isFinite(input.timestamp)
  );
}

function isBookLevel(input: unknown): input is BookLevel {
  return isRecord(input) && isFiniteNumber(input.price) && isFiniteNumber(input.size);
}

function isRecentTrade(input: unknown): input is RecentTrade {
  return (
    isRecord(input) &&
    (input.side === "buy" || input.side === "sell") &&
    isFiniteNumber(input.price) &&
    isFiniteNumber(input.size) &&
    isFiniteNumber(input.timestamp)
  );
}

function isAccountSummary(input: Record<string, unknown>) {
  return (
    typeof input.address === "string" &&
    isFiniteNumber(input.equityUsd) &&
    isFiniteNumber(input.availableUsd) &&
    isFiniteNumber(input.marginUsedUsd) &&
    isFiniteNumber(input.unrealizedPnlUsd) &&
    isFiniteNumber(input.dailyLiveNotionalUsedUsd) &&
    isFiniteNumber(input.simulatedBalanceUsd) &&
    Array.isArray(input.positions)
  );
}

function isEligibilityInput(input: Record<string, unknown>) {
  return (
    typeof input.state === "string" &&
    (input.mode === "paper" || input.mode === "live") &&
    typeof input.liveAllowed === "boolean" &&
    typeof input.paperAllowed === "boolean"
  );
}

function isAnnotation(input: unknown): input is ChartAnnotation {
  return (
    isRecord(input) &&
    typeof input.id === "string" &&
    ["liquidationCluster", "invalidation", "target", "support", "resistance"].includes(String(input.kind)) &&
    Number.isFinite(input.price) &&
    typeof input.label === "string" &&
    ["green", "red", "amber", "blue"].includes(String(input.tone))
  );
}

function isTradeSide(input: unknown): input is TradeSide {
  return input === "long" || input === "short";
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function isFiniteNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input);
}
