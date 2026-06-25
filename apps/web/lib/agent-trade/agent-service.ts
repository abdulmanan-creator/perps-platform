import { fmtCompactUsd, fmtMarketUsd, fmtPct, fmtUsd } from "./format";
import {
  calculateDraftImpact,
  calculatePortfolioExposure,
  classifyPortfolioRisk,
} from "./portfolio";
import type { AgentResponse, SharedTradingSnapshot } from "./types";

export type AgentScenario = "long" | "short" | "explain" | "noTrade" | "marketRead" | "capability";

export interface AgentService {
  run(args: {
    scenario: AgentScenario;
    snapshot: SharedTradingSnapshot;
    isStale: boolean;
    accountFreshnessWarning?: string;
    mode: "paper" | "live";
  }): Promise<AgentResponse>;
  runPrompt(args: {
    prompt: string;
    snapshot: SharedTradingSnapshot;
    isStale: boolean;
    accountFreshnessWarning?: string;
    mode: "paper" | "live";
  }): Promise<AgentResponse>;
}

function receipt(label: string, value: string, snapshot: SharedTradingSnapshot) {
  return { label, value, timestamp: snapshot.asOf };
}

function fmtSnapshotMarketUsd(snapshot: SharedTradingSnapshot, price: number): string {
  return fmtMarketUsd({ price, market: snapshot.market });
}

export class DeterministicAgentService implements AgentService {
  classifyPrompt(prompt: string): AgentScenario {
    const normalized = prompt.toLowerCase();

    if (/^\s*(hi|hello|hey|yo|gm|good morning|good afternoon|good evening)[!.?\s]*$/u.test(normalized)) {
      return "capability";
    }
    if (/\b(short|sell|bearish)\b/u.test(normalized)) {
      return "short";
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
    if (/\b(should i trade|clean setup|wait|no trade|stand aside)\b/u.test(normalized)) {
      return "noTrade";
    }

    return "marketRead";
  }

  async run(args: {
    scenario: AgentScenario;
    snapshot: SharedTradingSnapshot;
    isStale: boolean;
    accountFreshnessWarning?: string;
    mode: "paper" | "live";
  }): Promise<AgentResponse> {
    await new Promise((resolve) => setTimeout(resolve, 700));

    if ((args.scenario === "long" || args.scenario === "short") && !hasUsablePrice(args.snapshot)) {
      return this.noUsablePrice(args.snapshot);
    }

    const marketFreshnessWarning = args.isStale
      ? "Market data may be delayed; confirm price in the ticket before submitting."
      : undefined;

    if (args.scenario === "long") {
      return this.withDraftWarnings(this.long(args.snapshot, args.mode), [
        marketFreshnessWarning,
        args.accountFreshnessWarning,
      ]);
    }
    if (args.scenario === "short") {
      return this.withDraftWarnings(this.short(args.snapshot, args.mode), [
        marketFreshnessWarning,
        args.accountFreshnessWarning,
      ]);
    }
    if (args.scenario === "explain") {
      return this.explain(args.snapshot);
    }
    if (args.scenario === "noTrade") {
      return this.noTrade(args.snapshot);
    }
    if (args.scenario === "marketRead") {
      return this.marketRead(args.snapshot, args.mode);
    }
    if (args.scenario === "capability") {
      return this.capability(args.snapshot);
    }

    throw new Error(`Unsupported agent scenario: ${args.scenario}`);
  }

  async runPrompt(args: {
    prompt: string;
    snapshot: SharedTradingSnapshot;
    isStale: boolean;
    accountFreshnessWarning?: string;
    mode: "paper" | "live";
  }): Promise<AgentResponse> {
    const scenario = this.classifyPrompt(args.prompt);
    const response = await this.run({
      scenario,
      snapshot: args.snapshot,
      isStale: args.isStale,
      accountFreshnessWarning: args.accountFreshnessWarning,
      mode: args.mode,
    });

    return {
      ...response,
      question: args.prompt,
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
}

function hasUsablePrice(snapshot: SharedTradingSnapshot): boolean {
  return Number.isFinite(snapshot.market.markPrice) && snapshot.market.markPrice > 0;
}
