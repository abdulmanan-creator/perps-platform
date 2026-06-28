import { fmtCompactUsd, fmtMarketUsd, fmtPct, fmtUsd } from "./format";
import {
  calculateDraftImpact,
  calculatePortfolioExposure,
  classifyPortfolioRisk,
} from "./portfolio";
import {
  buildAgentInput,
  snapshotFromAgentInput,
  type AgentAnalysis,
  type AgentInput,
  type AgentProvider,
  type AgentProviderSelection,
  type AgentResponseType,
} from "./agent-provider";
import {
  agentAnalysisToResponse,
  invalidAgentOutputRefusal,
  parseAgentAnalysis,
} from "./agent-validation";
import type { AgentResponse, SharedTradingSnapshot } from "./types";
import type { TerminalChartData, TerminalFreshness } from "./terminal";

export type AgentScenario = "long" | "short" | "explain" | "noTrade" | "marketRead" | "capability";
export type AgentAccessTokenGetter = () => Promise<string | null | undefined>;

export interface AgentServiceOptions {
  getAccessToken?: AgentAccessTokenGetter;
}

export interface AgentService {
  run(args: {
    scenario: AgentScenario;
    snapshot: SharedTradingSnapshot;
    chartData?: TerminalChartData;
    freshness?: TerminalFreshness;
    isStale: boolean;
    accountFreshnessWarning?: string;
    marketDataWarning?: string;
    mode: "paper" | "live";
    eligibilityState?: AgentInput["eligibility"]["state"];
    liveAllowed?: boolean;
    paperAllowed?: boolean;
    mainnetExecutionEnabled?: boolean;
    killSwitchEnabled?: boolean;
    executionVenue?: string;
    providerPreference?: AgentProviderSelection;
  }): Promise<AgentResponse>;
  runPrompt(args: {
    prompt: string;
    snapshot: SharedTradingSnapshot;
    chartData?: TerminalChartData;
    freshness?: TerminalFreshness;
    isStale: boolean;
    accountFreshnessWarning?: string;
    marketDataWarning?: string;
    mode: "paper" | "live";
    eligibilityState?: AgentInput["eligibility"]["state"];
    liveAllowed?: boolean;
    paperAllowed?: boolean;
    mainnetExecutionEnabled?: boolean;
    killSwitchEnabled?: boolean;
    executionVenue?: string;
    providerPreference?: AgentProviderSelection;
  }): Promise<AgentResponse>;
}

function receipt(label: string, value: string, snapshot: SharedTradingSnapshot) {
  return { label, value, timestamp: snapshot.asOf };
}

function fmtSnapshotMarketUsd(snapshot: SharedTradingSnapshot, price: number): string {
  return fmtMarketUsd({ price, market: snapshot.market });
}

export function createAgentService(options: AgentServiceOptions = {}): AgentService {
  const provider = typeof window === "undefined"
    ? new DeterministicAgentService()
    : new AgentAnalysisRouteProvider(options.getAccessToken);
  return new DeterministicAgentService(provider);
}

export class DeterministicAgentService implements AgentService, AgentProvider {
  readonly name = "deterministic" as const;

  constructor(private readonly provider?: AgentProvider) {}

  classifyPrompt(prompt: string): AgentScenario {
    const normalized = prompt.toLowerCase();

    if (/^\s*(hi|hello|hey|yo|gm|good morning|good afternoon|good evening)[!.?\s]*$/u.test(normalized)) {
      return "capability";
    }
    if (/\b(short|sell|bearish)\b/u.test(normalized)) {
      return "short";
    }
    if (/\b(should i trade|clean setup|cleaner setup|wait|no trade|stand aside)\b/u.test(normalized)) {
      return "noTrade";
    }
    if (/\b(long|setup|buy|bullish)\b/u.test(normalized)) {
      return "long";
    }
    if (/\b(funding|oi|open interest|order book|book|liquidation|liq)\b/u.test(normalized)) {
      return "explain";
    }
    if (/\b(risk|portfolio|size|sizing|balance|exposure)\b/u.test(normalized)) {
      return "marketRead";
    }

    return "marketRead";
  }

  async run(args: {
    scenario: AgentScenario;
    snapshot: SharedTradingSnapshot;
    chartData?: TerminalChartData;
    freshness?: TerminalFreshness;
    isStale: boolean;
    accountFreshnessWarning?: string;
    marketDataWarning?: string;
    mode: "paper" | "live";
    eligibilityState?: AgentInput["eligibility"]["state"];
    liveAllowed?: boolean;
    paperAllowed?: boolean;
    mainnetExecutionEnabled?: boolean;
    killSwitchEnabled?: boolean;
    executionVenue?: string;
    providerPreference?: AgentProviderSelection;
  }): Promise<AgentResponse> {
    const input = buildAgentInput({
      prompt: scenarioPrompt(args.scenario, args.snapshot),
      scenario: args.scenario,
      snapshot: args.snapshot,
      chartData: args.chartData,
      freshness: args.freshness,
      accountFreshnessWarning: args.accountFreshnessWarning,
      marketDataWarning: args.marketDataWarning ?? staleMarketWarning(args.isStale),
      mode: args.mode,
      eligibilityState: args.eligibilityState,
      liveAllowed: args.liveAllowed,
      paperAllowed: args.paperAllowed,
      mainnetExecutionEnabled: args.mainnetExecutionEnabled,
      killSwitchEnabled: args.killSwitchEnabled,
      executionVenue: args.executionVenue,
      providerPreference: args.providerPreference,
    });
    return await this.runProvider(input);
  }

  async runPrompt(args: {
    prompt: string;
    snapshot: SharedTradingSnapshot;
    chartData?: TerminalChartData;
    freshness?: TerminalFreshness;
    isStale: boolean;
    accountFreshnessWarning?: string;
    marketDataWarning?: string;
    mode: "paper" | "live";
    eligibilityState?: AgentInput["eligibility"]["state"];
    liveAllowed?: boolean;
    paperAllowed?: boolean;
    mainnetExecutionEnabled?: boolean;
    killSwitchEnabled?: boolean;
    executionVenue?: string;
    providerPreference?: AgentProviderSelection;
  }): Promise<AgentResponse> {
    const scenario = this.classifyPrompt(args.prompt);
    const input = buildAgentInput({
      prompt: args.prompt,
      scenario,
      snapshot: args.snapshot,
      chartData: args.chartData,
      freshness: args.freshness,
      accountFreshnessWarning: args.accountFreshnessWarning,
      marketDataWarning: args.marketDataWarning ?? staleMarketWarning(args.isStale),
      mode: args.mode,
      eligibilityState: args.eligibilityState,
      liveAllowed: args.liveAllowed,
      paperAllowed: args.paperAllowed,
      mainnetExecutionEnabled: args.mainnetExecutionEnabled,
      killSwitchEnabled: args.killSwitchEnabled,
      executionVenue: args.executionVenue,
      providerPreference: args.providerPreference,
    });
    return await this.runProvider(input);
  }

  async analyzeMarket(input: AgentInput): Promise<AgentAnalysis> {
    await new Promise((resolve) => setTimeout(resolve, 700));

    if (input.prediction) {
      return this.predictionAnalysis(input);
    }

    const snapshot = snapshotFromAgentInput(input);
    const scenario = this.toScenario(input);
    if ((scenario === "long" || scenario === "short") && !hasUsablePrice(snapshot)) {
      return this.toAnalysis(this.noUsablePrice(snapshot), input, "refusal", "none", 0.05);
    }
    if ((scenario === "long" || scenario === "short") && input.eligibility.mode === "live" && !input.eligibility.liveAllowed) {
      return this.toAnalysis(this.liveNotAllowed(input), input, "refusal", "none", 0.05);
    }

    const draftWarnings = this.draftWarnings(input);
    if (scenario === "long") {
      return this.toAnalysis(this.withDraftWarnings(this.long(snapshot, input.eligibility.mode), draftWarnings), input, "trade_proposal", "long", 0.64, draftWarnings);
    }
    if (scenario === "short") {
      return this.toAnalysis(this.withDraftWarnings(this.short(snapshot, input.eligibility.mode), draftWarnings), input, "trade_proposal", "short", 0.62, draftWarnings);
    }
    if (scenario === "explain") {
      return this.toAnalysis(this.explain(snapshot), input, "market_read", "none", 0.78);
    }
    if (scenario === "noTrade") {
      return this.toAnalysis(this.noTrade(snapshot), input, "no_trade", "none", 0.7);
    }
    if (scenario === "marketRead") {
      return this.toAnalysis(this.marketRead(snapshot, input.eligibility.mode), input, "market_read", "none", 0.72);
    }
    if (scenario === "capability") {
      return this.toAnalysis(this.capability(snapshot), input, "greeting", "none", 0.85);
    }

    throw new Error(`Unsupported agent scenario: ${scenario}`);
  }

  private async runProvider(input: AgentInput): Promise<AgentResponse> {
    const provider = this.provider ?? this;
    const raw = await provider.analyzeMarket(input);
    const parsed = parseAgentAnalysis(raw) ?? invalidAgentOutputRefusal(input);
    return agentAnalysisToResponse(parsed, input);
  }

  private toScenario(input: AgentInput): AgentScenario {
    if (isAgentScenario(input.scenario)) {
      return input.scenario;
    }
    return this.classifyPrompt(input.requestedPrompt);
  }

  private draftWarnings(input: AgentInput): Array<string | undefined> {
    const marketFreshnessWarning = input.freshness.marketWarning ??
      (input.freshness.marketAgeSeconds > 60
        ? "Market data may be delayed; confirm price in the ticket before submitting."
        : undefined);
    return [marketFreshnessWarning, input.freshness.accountWarning];
  }

  private toAnalysis(
    response: AgentResponse,
    input: AgentInput,
    responseType: AgentResponseType,
    side: AgentAnalysis["side"],
    confidence: number,
    warnings: Array<string | undefined> = [],
  ): AgentAnalysis {
    return {
      responseType,
      summary: firstSentence(response.thesis),
      thesis: response.thesis,
      side,
      confidence,
      receipts: response.receipts,
      riskNote: response.riskNote,
      whyWrong: response.whyWrong,
      orderDraft: responseType === "trade_proposal" ? response.orderDraft : undefined,
      predictionDraft: responseType === "trade_proposal" ? response.predictionDraft : undefined,
      warnings: warnings.filter((warning): warning is string => Boolean(warning)),
      provider: {
        name: this.name,
        deterministic: true,
        generatedAt: input.timestamp,
      },
      id: response.id,
      question: input.requestedPrompt,
      annotations: response.annotations,
      followUps: response.followUps,
    };
  }

  private withDraftWarnings(response: AgentResponse, warnings: Array<string | undefined>): AgentResponse {
    const nextWarnings = warnings.filter((warning): warning is string => Boolean(warning));
    if (nextWarnings.length === 0 || !response.orderDraft) {
      return response;
    }

    return {
      ...response,
      riskNote: `${response.riskNote} ${nextWarnings.join(" ")}`,
    };
  }

  private predictionAnalysis(input: AgentInput): AgentAnalysis {
    const prediction = input.prediction;
    if (!prediction) {
      throw new Error("Prediction context missing.");
    }
    const prompt = input.requestedPrompt.toLowerCase();
    const wantsDraft = /\b(draft|buy|order|ticket|marketable)\b/u.test(prompt);
    const wantsWrong = /\b(wrong|risk|bear|against|could make)\b/u.test(prompt);
    const selectedPrice = prediction.selectedSide.midpointProbability ?? Number(prediction.selectedSide.bestAsk ?? prediction.ticket.limitProbability);
    const hasUsablePrice = Number.isFinite(selectedPrice) && selectedPrice > 0 && selectedPrice <= 1;
    const paperOnly = input.eligibility.mode !== "live" || !input.eligibility.liveAllowed;
    const receipts = [
      { label: "Question", value: prediction.questionName, timestamp: input.timestamp },
      { label: "Outcome", value: `${prediction.selectedOutcome.name} ${prediction.selectedSide.name}`, timestamp: input.timestamp },
      { label: "Best bid/ask", value: `${prediction.selectedSide.bestBid ?? "--"} / ${prediction.selectedSide.bestAsk ?? "--"}`, timestamp: input.timestamp },
      { label: "Spread", value: prediction.selectedSide.spread === null ? "--" : `${(prediction.selectedSide.spread * 100).toFixed(1)} pts`, timestamp: input.timestamp },
      { label: "Book", value: `${prediction.selectedSide.bidDepth} bid / ${prediction.selectedSide.askDepth} ask contracts`, timestamp: input.timestamp },
      { label: "Mode", value: paperOnly ? "Paper draft only" : "Live eligible; confirmation required", timestamp: input.timestamp },
    ];
    const riskNote =
      `This is a HIP-4 binary event contract. You can lose the full premium paid, settlement depends on the listed criteria, and the ${prediction.stream.freshnessLabel.toLowerCase()} may differ by the time you confirm.`;
    const whyWrong =
      "The odds can be wrong if the market is thin, the selected side has stale depth, news changes team probabilities, or resolution criteria differ from the expected interpretation.";

    if (wantsDraft && hasUsablePrice) {
      const contracts = Math.max(1, Math.floor(prediction.ticket.contracts));
      const limitProbability = Number(Math.min(1, Math.max(0.0001, prediction.ticket.limitProbability || selectedPrice)).toFixed(4));
      return {
        responseType: "trade_proposal",
        summary: `${prediction.selectedOutcome.name} ${prediction.selectedSide.name} prediction draft prepared.`,
        thesis:
          `${prediction.selectedOutcome.name} ${prediction.selectedSide.name} is trading around ${(selectedPrice * 100).toFixed(1)}% with ` +
          `${prediction.selectedSide.bidDepth + prediction.selectedSide.askDepth} visible contracts on the selected book side. ` +
          `I can draft a ${paperOnly ? "paper" : "review-only"} buy ticket, but Agent.trade still requires confirmation.`,
        side: "none",
        confidence: prediction.selectedSide.emptyBook ? 0.35 : 0.58,
        receipts,
        riskNote,
        whyWrong,
        predictionDraft: {
          kind: "prediction_order",
          questionId: prediction.questionId,
          questionName: prediction.questionName,
          outcome: prediction.selectedOutcome.outcome,
          outcomeName: prediction.selectedOutcome.name,
          side: prediction.selectedSide.side,
          sideName: prediction.selectedSide.name,
          action: "buy",
          contracts,
          limitProbability,
          tif: prediction.ticket.tif,
          paperOnly,
          fromAgent: true,
        },
        warnings: paperOnly ? ["Restricted or non-live mode: prediction draft is paper-only."] : [],
        provider: {
          name: this.name,
          deterministic: true,
          generatedAt: input.timestamp,
        },
        id: `prediction-${prediction.questionId}-${prediction.selectedOutcome.outcome}-${prediction.selectedSide.side}-draft`,
        question: input.requestedPrompt,
        annotations: [],
        followUps: ["Explain this odds move", "What could make this wrong?"],
      };
    }

    return {
      responseType: wantsWrong ? "no_trade" : "market_read",
      summary: `${prediction.selectedOutcome.name} ${prediction.selectedSide.name} market read.`,
      thesis:
        `${prediction.questionName}: ${prediction.selectedOutcome.name} ${prediction.selectedSide.name} has ` +
        `best bid ${prediction.selectedSide.bestBid ?? "--"} and best ask ${prediction.selectedSide.bestAsk ?? "--"}. ` +
        `The selected book shows ${prediction.selectedSide.bidDepth} bid contracts and ${prediction.selectedSide.askDepth} ask contracts. ` +
        "No order is drafted unless you explicitly ask for a prediction ticket.",
      side: "none",
      confidence: prediction.selectedSide.emptyBook ? 0.42 : 0.66,
      receipts,
      riskNote,
      whyWrong,
      warnings: paperOnly ? ["Live prediction trading is unavailable here; paper mode remains available."] : [],
      provider: {
        name: this.name,
        deterministic: true,
        generatedAt: input.timestamp,
      },
      id: `prediction-${prediction.questionId}-${prediction.selectedOutcome.outcome}-${prediction.selectedSide.side}-read`,
      question: input.requestedPrompt,
      annotations: [],
      followUps: wantsWrong ? ["Find the cleanest World Cup setup"] : ["Draft a marketable order", "What could make this wrong?"],
    };
  }

  private long(snapshot: SharedTradingSnapshot, mode: "paper" | "live"): AgentResponse {
    const { market, account } = snapshot;
    const sizeBtc = Number(
      Math.max(1 / 10 ** market.szDecimals, Math.min(0.05, account.availableUsd * 0.08 / market.markPrice))
        .toFixed(market.szDecimals),
    );
    const stopLoss = Number((market.markPrice * 0.972).toFixed(1));
    const takeProfit = Number((market.markPrice * 1.054).toFixed(1));
    const liquidation = Number((market.markPrice * 0.766).toFixed(1));
    const draft = {
      symbol: market.symbol,
      side: "long" as const,
      orderType: "market" as const,
      sizeBtc,
      leverage: 3,
      marginMode: "isolated" as const,
      reduceOnly: false,
      takeProfit,
      stopLoss,
      fromAgent: true,
      scenarioId: `${market.base.toLowerCase()}-continuation-long`,
    };
    const impact = calculateDraftImpact({ account, market, draft });
    const exposure = calculatePortfolioExposure(account, market.symbol);
    const riskLabels = classifyPortfolioRisk({ account, exposure, selectedSymbol: market.symbol, mode });
    const existingExposure = exposure.selectedMarketNotionalUsd > 0
      ? `${fmtCompactUsd(exposure.selectedMarketNotionalUsd)} current ${market.base} exposure`
      : `no current ${market.base} exposure`;
    const concentrationNote = impact.selectedMarketConcentrationPct >= 55
      ? `This would concentrate ${fmtPct(impact.selectedMarketConcentrationPct, 1)} of gross exposure in ${market.base}.`
      : `Post-trade ${market.base} concentration stays near ${fmtPct(impact.selectedMarketConcentrationPct, 1)}.`;

    return {
      id: `${market.base.toLowerCase()}-continuation-long`,
      state: "tradeProposal",
      question: `Should I long ${market.base} here for the next 4-8 hours?`,
      thesis:
        `${market.base} is holding the upper range while OI is expanding and funding is still modest at ${fmtPct(market.fundingRatePct)}. ` +
        `Available balance is ${fmtUsd(account.availableUsd, 0)} with ${existingExposure}. ` +
        `I would only draft this as a controlled ${mode} trade with a defined invalidation.`,
      receipts: [
        receipt("Mark", fmtSnapshotMarketUsd(snapshot, market.markPrice), snapshot),
        receipt("Funding", fmtPct(market.fundingRatePct), snapshot),
        receipt("Open interest", fmtCompactUsd(market.openInterestUsd), snapshot),
        receipt("24h volume", fmtCompactUsd(market.volume24hUsd), snapshot),
        receipt("Margin impact", fmtUsd(impact.marginRequiredUsd, 2), snapshot),
      ],
      riskNote:
        `The risk is a failed breakout back through ${fmtSnapshotMarketUsd(snapshot, stopLoss)}. ${concentrationNote} Current labels: ${riskLabels.join(", ")}.`,
      whyWrong:
        "If OI keeps rising while price loses the range high, this becomes crowded long positioning rather than confirmation.",
      orderDraft: draft,
      annotations: [
        {
          id: "liq-cluster",
          kind: "liquidationCluster",
          price: Number((market.markPrice * 0.986).toFixed(1)),
          label: "Liq cluster",
          tone: "amber",
        },
        {
          id: "invalidation",
          kind: "invalidation",
          price: stopLoss,
          label: "Invalidation",
          tone: "red",
        },
        {
          id: "target",
          kind: "target",
          price: takeProfit,
          label: "Target",
          tone: "green",
        },
        {
          id: "est-liq",
          kind: "liquidationCluster",
          price: liquidation,
          label: "Est. liq",
          tone: "blue",
        },
      ],
    };
  }

  private short(snapshot: SharedTradingSnapshot, mode: "paper" | "live"): AgentResponse {
    const { market, account } = snapshot;
    const sizeBtc = Number(
      Math.max(1 / 10 ** market.szDecimals, Math.min(0.05, account.availableUsd * 0.07 / market.markPrice))
        .toFixed(market.szDecimals),
    );
    const stopLoss = Number((market.markPrice * 1.028).toFixed(1));
    const takeProfit = Number((market.markPrice * 0.948).toFixed(1));
    const liquidation = Number((market.markPrice * 1.236).toFixed(1));
    const draft = {
      symbol: market.symbol,
      side: "short" as const,
      orderType: "market" as const,
      sizeBtc,
      leverage: 3,
      marginMode: "isolated" as const,
      reduceOnly: false,
      takeProfit,
      stopLoss,
      fromAgent: true,
      scenarioId: `${market.base.toLowerCase()}-rejection-short`,
    };
    const impact = calculateDraftImpact({ account, market, draft });
    const exposure = calculatePortfolioExposure(account, market.symbol);
    const riskLabels = classifyPortfolioRisk({ account, exposure, selectedSymbol: market.symbol, mode });
    const existingExposure = exposure.selectedMarketNotionalUsd > 0
      ? `${fmtCompactUsd(exposure.selectedMarketNotionalUsd)} current ${market.base} exposure`
      : `no current ${market.base} exposure`;
    const concentrationNote = impact.selectedMarketConcentrationPct >= 55
      ? `This would concentrate ${fmtPct(impact.selectedMarketConcentrationPct, 1)} of gross exposure in ${market.base}.`
      : `Post-trade ${market.base} concentration stays near ${fmtPct(impact.selectedMarketConcentrationPct, 1)}.`;

    return {
      id: `${market.base.toLowerCase()}-rejection-short`,
      state: "tradeProposal",
      question: `Should I short ${market.base} here for the next 4-8 hours?`,
      thesis:
        `${market.base} is trading below the intraday reference while OI remains elevated and funding is not deeply negative at ${fmtPct(market.fundingRatePct)}. ` +
        `Available balance is ${fmtUsd(account.availableUsd, 0)} with ${existingExposure}. ` +
        `I would only draft this as a controlled ${mode} short with a defined invalidation above the rejection level.`,
      receipts: [
        receipt("Mark", fmtSnapshotMarketUsd(snapshot, market.markPrice), snapshot),
        receipt("Funding", fmtPct(market.fundingRatePct), snapshot),
        receipt("Open interest", fmtCompactUsd(market.openInterestUsd), snapshot),
        receipt("24h volume", fmtCompactUsd(market.volume24hUsd), snapshot),
        receipt("Margin impact", fmtUsd(impact.marginRequiredUsd, 2), snapshot),
      ],
      riskNote:
        `The risk is a squeeze back through ${fmtSnapshotMarketUsd(snapshot, stopLoss)}. ${concentrationNote} Current labels: ${riskLabels.join(", ")}.`,
      whyWrong:
        "If price reclaims the rejection level while OI stays elevated, trapped shorts can fuel a squeeze instead of continuation lower.",
      orderDraft: draft,
      annotations: [
        {
          id: "short-invalidation",
          kind: "invalidation",
          price: stopLoss,
          label: "Short invalidation",
          tone: "red",
        },
        {
          id: "short-target",
          kind: "target",
          price: takeProfit,
          label: "Short target",
          tone: "green",
        },
        {
          id: "short-liq",
          kind: "liquidationCluster",
          price: liquidation,
          label: "Est. liq",
          tone: "blue",
        },
      ],
    };
  }

  private explain(snapshot: SharedTradingSnapshot): AgentResponse {
    const { market } = snapshot;
    return {
      id: `${market.base.toLowerCase()}-funding-oi-read`,
      state: "answered",
      question: "Explain current funding + OI.",
      thesis:
        `${market.base} funding is positive but controlled at ${fmtPct(market.fundingRatePct)}, while open interest is ` +
        `${fmtCompactUsd(market.openInterestUsd)}. That means traders are adding exposure, but longs are not paying extreme carry yet.`,
      receipts: [
        receipt("Funding", fmtPct(market.fundingRatePct), snapshot),
        receipt("OI", fmtCompactUsd(market.openInterestUsd), snapshot),
        receipt("OI change", market.openInterestChangePct === null ? "--" : fmtPct(market.openInterestChangePct, 1), snapshot),
      ],
      riskNote: "OI expansion is useful only while price confirms. If price stalls, the same OI can become liquidation fuel.",
      whyWrong: "Funding and OI do not identify forced flow by themselves; order book and liquidation data must confirm.",
      annotations: [
        {
          id: "support",
          kind: "support",
          price: Number((market.markPrice * 0.989).toFixed(1)),
          label: "Range support",
          tone: "blue",
        },
      ],
    };
  }

  private noTrade(snapshot: SharedTradingSnapshot): AgentResponse {
    const { market, account } = snapshot;
    const exposure = calculatePortfolioExposure(account, market.symbol);
    const riskLabels = classifyPortfolioRisk({ account, exposure, selectedSymbol: market.symbol, mode: "paper" });
    const selectedExposure = exposure.selectedMarketNotionalUsd > 0
      ? `${fmtCompactUsd(exposure.selectedMarketNotionalUsd)} already on ${market.base}`
      : `no existing ${market.base} position`;
    return {
      id: `${market.base.toLowerCase()}-no-clean-setup`,
      state: "noTrade",
      question: `Find a cleaner ${market.base} setup.`,
      thesis:
        `No clean setup right now. Price is between actionable levels and the book already has ${selectedExposure}, so adding risk here is not justified.`,
      receipts: [
        receipt("Upper liquidity", fmtSnapshotMarketUsd(snapshot, market.markPrice * 1.052), snapshot),
        receipt("Lower liquidity", fmtSnapshotMarketUsd(snapshot, market.markPrice * 0.971), snapshot),
        receipt("Spread", fmtSnapshotMarketUsd(snapshot, Math.abs(snapshot.orderBook.asks[0].price - snapshot.orderBook.bids[0].price)), snapshot),
        receipt("Portfolio labels", riskLabels.join(", "), snapshot),
      ],
      riskNote: `Chasing the middle of the range gives poor invalidation. Portfolio state: ${riskLabels.join(", ")}.`,
      whyWrong: "A fast sweep through either liquidity zone could produce a valid entry later, but it has not happened yet.",
      annotations: [
        {
          id: "upper-risk",
          kind: "resistance",
          price: Number((market.markPrice * 1.052).toFixed(1)),
          label: "Upper liq risk",
          tone: "red",
        },
        {
          id: "lower-risk",
          kind: "support",
          price: Number((market.markPrice * 0.971).toFixed(1)),
          label: "Lower liq risk",
          tone: "red",
        },
      ],
      followUps: ["Set alert", `Watch ${market.base}`, "Ask again after sweep"],
    };
  }

  private marketRead(snapshot: SharedTradingSnapshot, mode: "paper" | "live"): AgentResponse {
    const { market, account } = snapshot;
    const exposure = calculatePortfolioExposure(account, market.symbol);
    const riskLabels = classifyPortfolioRisk({ account, exposure, selectedSymbol: market.symbol, mode });
    const oiChange = market.openInterestChangePct === null ? "--" : fmtPct(market.openInterestChangePct, 1);
    const selectedExposure = exposure.selectedMarketNotionalUsd > 0
      ? `${fmtCompactUsd(exposure.selectedMarketNotionalUsd)} current ${market.base} exposure`
      : `no current ${market.base} exposure`;
    return {
      id: `${market.base.toLowerCase()}-typed-market-read`,
      state: "answered",
      question: `Give me a ${market.base} market read.`,
      thesis:
        `${market.base} is trading at ${fmtSnapshotMarketUsd(snapshot, market.markPrice)} with funding at ${fmtPct(market.fundingRatePct)} and ` +
        `${fmtCompactUsd(market.openInterestUsd)} open interest. Account context shows ${selectedExposure} and ` +
        `${fmtUsd(account.availableUsd, 0)} available balance. I would treat this as a market read, not an executable instruction.`,
      receipts: [
        receipt("Mark", fmtSnapshotMarketUsd(snapshot, market.markPrice), snapshot),
        receipt("Funding", fmtPct(market.fundingRatePct), snapshot),
        receipt("Open interest", fmtCompactUsd(market.openInterestUsd), snapshot),
        receipt("OI change", oiChange, snapshot),
        receipt("24h volume", fmtCompactUsd(market.volume24hUsd), snapshot),
        receipt("Portfolio labels", riskLabels.join(", "), snapshot),
      ],
      riskNote:
        `Current mode is ${mode}. If live eligibility is unavailable, any draft must stay paper-only and still requires terminal confirmation.`,
      whyWrong:
        "This deterministic read does not include live news, hidden liquidity, or a full execution model; confirm with fresh data before acting.",
      annotations: [
        {
          id: "typed-read-support",
          kind: "support",
          price: Number((market.markPrice * 0.989).toFixed(1)),
          label: "Support to watch",
          tone: "blue",
        },
        {
          id: "typed-read-resistance",
          kind: "resistance",
          price: Number((market.markPrice * 1.018).toFixed(1)),
          label: "Resistance",
          tone: "amber",
        },
      ],
      followUps: [
        `Should I long ${market.base}?`,
        `Should I short ${market.base}?`,
        "Explain funding + OI",
      ],
    };
  }

  private capability(snapshot: SharedTradingSnapshot): AgentResponse {
    const { market } = snapshot;
    return {
      id: `${market.base.toLowerCase()}-agent-capabilities`,
      state: "answered",
      question: "What can Agent.trade help with?",
      thesis:
        "Ask me about funding, open interest, liquidation levels, portfolio risk, or a trade setup. I use the current terminal snapshot and can draft a paper proposal for your review when the setup is clean.",
      receipts: [
        receipt("Market", market.symbol, snapshot),
        receipt("Mark", fmtSnapshotMarketUsd(snapshot, market.markPrice), snapshot),
        receipt("Data age", `${market.dataAgeSeconds}s`, snapshot),
      ],
      riskNote:
        "Today this is deterministic MVP guidance. Orders still return to Agent.trade for ticket review, risk acknowledgement, and confirmation.",
      whyWrong:
        "A greeting does not contain a trading intent, so I will not infer a buy or sell direction from it.",
      annotations: [],
      followUps: [
        `Should I long ${market.base}?`,
        "Explain funding + OI",
        "Find cleaner setup",
      ],
    };
  }

  private noUsablePrice(snapshot: SharedTradingSnapshot): AgentResponse {
    return {
      id: "no-usable-price-refusal",
      state: "staleRefusal",
      question: "Should I trade this?",
      thesis:
        "I won’t draft a trade without a usable market price. Refresh market data before drafting an order.",
      receipts: [receipt("Mark", fmtSnapshotMarketUsd(snapshot, snapshot.market.markPrice), snapshot)],
      riskNote: "A missing or invalid price makes entries, liquidation estimates, and stops unreliable.",
      whyWrong: "The setup could still be valid after a price refresh, but the current snapshot cannot produce a safe ticket.",
      annotations: [],
    };
  }

  private liveNotAllowed(input: AgentInput): AgentResponse {
    return {
      id: "live-not-allowed-refusal",
      state: "staleRefusal",
      question: input.requestedPrompt,
      thesis:
        "I will not draft a live order because live trading is not allowed for the current eligibility state. Switch to paper mode for simulated drafts.",
      receipts: [
        { label: "Eligibility", value: input.eligibility.state, timestamp: input.timestamp },
        { label: "Mode", value: input.eligibility.mode, timestamp: input.timestamp },
      ],
      riskNote: "Live order tickets require eligible state, live account readiness, acknowledgement, and user confirmation.",
      whyWrong: "Eligibility could change after a server refresh, but this snapshot cannot safely create a live draft.",
      annotations: [],
      followUps: ["Switch to paper", `Ask for a ${input.market.base} market read`],
    };
  }
}

function hasUsablePrice(snapshot: SharedTradingSnapshot): boolean {
  return Number.isFinite(snapshot.market.markPrice) && snapshot.market.markPrice > 0;
}

function scenarioPrompt(scenario: AgentScenario, snapshot: SharedTradingSnapshot): string {
  switch (scenario) {
    case "long":
      return `Should I long ${snapshot.market.base} here for the next 4-8 hours?`;
    case "short":
      return `Should I short ${snapshot.market.base} here for the next 4-8 hours?`;
    case "explain":
      return "Explain current funding + OI.";
    case "noTrade":
      return `Find a cleaner ${snapshot.market.base} setup.`;
    case "marketRead":
      return `Give me a ${snapshot.market.base} market read.`;
    case "capability":
      return "What can Agent.trade help with?";
    default:
      throw new Error(`Unsupported agent scenario: ${scenario}`);
  }
}

function isAgentScenario(input: unknown): input is AgentScenario {
  return (
    input === "long" ||
    input === "short" ||
    input === "explain" ||
    input === "noTrade" ||
    input === "marketRead" ||
    input === "capability"
  );
}

function firstSentence(input: string): string {
  const sentence = input.match(/^.*?[.!?](?:\s|$)/u)?.[0]?.trim();
  return sentence ?? input;
}

function staleMarketWarning(isStale: boolean): string | undefined {
  return isStale
    ? "Market data may be delayed; confirm price in the ticket before submitting."
    : undefined;
}

class AgentAnalysisRouteProvider implements AgentProvider {
  readonly name = "deterministic" as const;
  private readonly deterministic = new DeterministicAgentService();

  constructor(private readonly getAccessToken?: AgentAccessTokenGetter) {}

  async analyzeMarket(input: AgentInput): Promise<AgentAnalysis> {
    try {
      const response = await fetchAgentAnalysisRoute({
        input,
        getAccessToken: this.getAccessToken,
      });
      if (!response.ok) {
        return await this.fallback(input, `Agent analysis route returned HTTP ${response.status}.`);
      }
      const parsed = parseAgentAnalysis(await response.json());
      if (!parsed) {
        return await this.fallback(input, "Agent analysis route returned invalid AgentAnalysis.");
      }
      return parsed;
    } catch {
      return await this.fallback(input, "Agent analysis route unavailable; using deterministic fallback.");
    }
  }

  private async fallback(input: AgentInput, reason: string): Promise<AgentAnalysis> {
    const analysis = await this.deterministic.analyzeMarket(input);
    return {
      ...analysis,
      warnings: [...analysis.warnings, reason],
      provider: {
        ...analysis.provider,
        fallbackReason: reason,
      },
    };
  }
}

export async function fetchAgentAnalysisRoute(args: {
  input: AgentInput;
  provider?: AgentProviderSelection;
  getAccessToken?: AgentAccessTokenGetter;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<Response> {
  const fetchImpl = args.fetchImpl ?? fetch;
  return await fetchImpl("/api/agent-trade/agent-analysis", {
    method: "POST",
    headers: await agentAnalysisRouteHeaders({ getAccessToken: args.getAccessToken }),
    body: JSON.stringify({
      input: args.input,
      provider: args.provider ?? args.input.providerPreference ?? "auto",
    }),
  });
}

export async function agentAnalysisRouteHeaders(args: {
  getAccessToken?: AgentAccessTokenGetter;
} = {}): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = await readAgentAnalysisAccessToken(args.getAccessToken);
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function readAgentAnalysisAccessToken(
  getAccessToken: AgentAccessTokenGetter | undefined,
): Promise<string | undefined> {
  if (!getAccessToken) {
    return undefined;
  }
  try {
    const token = await getAccessToken();
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}
