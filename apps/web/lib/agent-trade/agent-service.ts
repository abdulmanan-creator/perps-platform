import { fmtCompactUsd, fmtPct, fmtUsd } from "./format";
import {
  calculateDraftImpact,
  calculatePortfolioExposure,
  classifyPortfolioRisk,
} from "./portfolio";
import type { AgentResponse, SharedTradingSnapshot } from "./types";

export type AgentScenario = "long" | "explain" | "noTrade";

export interface AgentService {
  run(args: {
    scenario: AgentScenario;
    snapshot: SharedTradingSnapshot;
    isStale: boolean;
    mode: "paper" | "live";
  }): Promise<AgentResponse>;
}

function receipt(label: string, value: string, snapshot: SharedTradingSnapshot) {
  return { label, value, timestamp: snapshot.asOf };
}

export class DeterministicAgentService implements AgentService {
  async run(args: {
    scenario: AgentScenario;
    snapshot: SharedTradingSnapshot;
    isStale: boolean;
    mode: "paper" | "live";
  }): Promise<AgentResponse> {
    await new Promise((resolve) => setTimeout(resolve, 700));

    if (args.isStale) {
      return this.stale(args.snapshot);
    }

    if (args.scenario === "long") {
      return this.long(args.snapshot, args.mode);
    }
    if (args.scenario === "explain") {
      return this.explain(args.snapshot);
    }
    if (args.scenario === "noTrade") {
      return this.noTrade(args.snapshot);
    }

    throw new Error(`Unsupported agent scenario: ${args.scenario}`);
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
        receipt("Mark", fmtUsd(market.markPrice, 1), snapshot),
        receipt("Funding", fmtPct(market.fundingRatePct), snapshot),
        receipt("Open interest", fmtCompactUsd(market.openInterestUsd), snapshot),
        receipt("24h volume", fmtCompactUsd(market.volume24hUsd), snapshot),
        receipt("Margin impact", fmtUsd(impact.marginRequiredUsd, 2), snapshot),
      ],
      riskNote:
        `The risk is a failed breakout back through ${fmtUsd(stopLoss, 1)}. ${concentrationNote} Current labels: ${riskLabels.join(", ")}.`,
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
        receipt("Upper liquidity", fmtUsd(market.markPrice * 1.052, 1), snapshot),
        receipt("Lower liquidity", fmtUsd(market.markPrice * 0.971, 1), snapshot),
        receipt("Spread", fmtUsd(Math.abs(snapshot.orderBook.asks[0].price - snapshot.orderBook.bids[0].price), 1), snapshot),
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

  private stale(snapshot: SharedTradingSnapshot): AgentResponse {
    return {
      id: "stale-refusal",
      state: "staleRefusal",
      question: "Should I trade this?",
      thesis:
        `I will not draft a live trade because market data is ${snapshot.market.dataAgeSeconds}s old. Refresh the stream or switch to paper mode.`,
      receipts: [receipt("Data age", `${snapshot.market.dataAgeSeconds}s`, snapshot)],
      riskNote: "Stale prices can make entries, liquidation estimates, and stops materially wrong.",
      whyWrong: "The setup could still be valid after refresh, but the current snapshot is not safe enough to draft from.",
      annotations: [],
    };
  }
}
