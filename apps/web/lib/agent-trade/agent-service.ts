import { fmtCompactUsd, fmtPct, fmtUsd } from "./format";
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
    const sizeBtc = Number(Math.min(0.05, account.availableUsd * 0.08 / market.markPrice).toFixed(4));
    const stopLoss = Number((market.markPrice * 0.972).toFixed(1));
    const takeProfit = Number((market.markPrice * 1.054).toFixed(1));
    const liquidation = Number((market.markPrice * 0.766).toFixed(1));

    return {
      id: "btc-continuation-long",
      state: "tradeProposal",
      question: "Should I long BTC here for the next 4-8 hours?",
      thesis:
        `BTC is holding the upper range while OI is expanding and funding is still modest at ${fmtPct(market.fundingRatePct)}. ` +
        `That is constructive, but not euphoric. I would only draft this as a controlled ${mode} trade with a defined invalidation.`,
      receipts: [
        receipt("Mark", fmtUsd(market.markPrice, 1), snapshot),
        receipt("Funding", fmtPct(market.fundingRatePct), snapshot),
        receipt("Open interest", fmtCompactUsd(market.openInterestUsd), snapshot),
        receipt("24h volume", fmtCompactUsd(market.volume24hUsd), snapshot),
      ],
      riskNote:
        `The risk is a failed breakout back through ${fmtUsd(stopLoss, 1)}. Keep leverage modest and let the stop define the trade.`,
      whyWrong:
        "If OI keeps rising while price loses the range high, this becomes crowded long positioning rather than confirmation.",
      orderDraft: {
        symbol: market.symbol,
        side: "long",
        orderType: "market",
        sizeBtc,
        leverage: 3,
        marginMode: "isolated",
        reduceOnly: false,
        takeProfit,
        stopLoss,
        fromAgent: true,
        scenarioId: "btc-continuation-long",
      },
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
      id: "btc-funding-oi-read",
      state: "answered",
      question: "Explain current funding + OI.",
      thesis:
        `${market.base} funding is positive but controlled at ${fmtPct(market.fundingRatePct)}, while open interest is ` +
        `${fmtCompactUsd(market.openInterestUsd)}. That means traders are adding exposure, but longs are not paying extreme carry yet.`,
      receipts: [
        receipt("Funding", fmtPct(market.fundingRatePct), snapshot),
        receipt("OI", fmtCompactUsd(market.openInterestUsd), snapshot),
        receipt("OI change", fmtPct(market.openInterestChangePct, 1), snapshot),
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
    const { market } = snapshot;
    return {
      id: "btc-no-clean-setup",
      state: "noTrade",
      question: "Find a cleaner BTC setup.",
      thesis:
        "No clean setup right now. Price is between actionable levels and the order book does not offer a good asymmetric entry.",
      receipts: [
        receipt("Upper liquidity", fmtUsd(market.markPrice * 1.052, 1), snapshot),
        receipt("Lower liquidity", fmtUsd(market.markPrice * 0.971, 1), snapshot),
        receipt("Spread", fmtUsd(Math.abs(snapshot.orderBook.asks[0].price - snapshot.orderBook.bids[0].price), 1), snapshot),
      ],
      riskNote: "Chasing the middle of the range gives poor invalidation and makes sizing arbitrary.",
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
      followUps: ["Set alert", "Watch BTC", "Ask again after sweep"],
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
