import { fmtMarketUsd, fmtPct, fmtUsd } from "./format";
import type { AgentResponse, EligibilityMode, OrderDraft, SharedTradingSnapshot } from "./types";

export type AgentProviderDisplayState = "deterministic" | "liveModel" | "fallback";
export type TicketSourceDisplayState = "manual" | "agent" | "connector" | "editedAfterAgent";

export interface AgentProviderDisplay {
  state: AgentProviderDisplayState;
  label: string;
  detail: string;
}

export interface AgentDataReadItem {
  label: string;
  value: string;
}

export const PHASE_4B_AGENT_VALIDATION_CHECKLIST = [
  "deterministic mode",
  "OpenAI disabled mode",
  "Anthropic disabled mode",
  "DeepSeek disabled mode",
  "Qwen disabled mode",
  "OpenAI enabled with mock/fake key failure",
  "live provider enabled with valid key if available",
  "malformed model output",
  "timeout/provider error",
  "no usable price",
  "restricted/paper user",
  "eligible/live user",
] as const;

export function agentProviderDisplay(agent?: Pick<AgentResponse, "provider">): AgentProviderDisplay {
  const provider = agent?.provider;
  if (!provider) {
    return {
      state: "deterministic",
      label: "Deterministic",
      detail: "Local deterministic fallback",
    };
  }

  if (provider.fallbackReason) {
    return {
      state: "fallback",
      label: "Fallback",
      detail: provider.fallbackReason,
    };
  }

  if (!provider.deterministic) {
    return {
      state: "liveModel",
      label: provider.model ? `${providerLabel(provider.name)} ${provider.model}` : `${providerLabel(provider.name)} model`,
      detail: provider.latencyMs != null
        ? `Validated model response · ${Math.round(provider.latencyMs)}ms`
        : "Validated model response",
    };
  }

  return {
    state: "deterministic",
    label: "Deterministic",
    detail: "Local deterministic analysis",
  };
}

function providerLabel(providerName: NonNullable<AgentResponse["provider"]>["name"]): string {
  if (providerName === "openai") {
    return "OpenAI";
  }
  if (providerName === "anthropic") {
    return "Anthropic";
  }
  if (providerName === "deepseek") {
    return "DeepSeek";
  }
  if (providerName === "qwen") {
    return "Qwen";
  }
  if (providerName === "openrouter") {
    return "OpenRouter";
  }
  return "Deterministic";
}

export function agentDataReadSummary(args: {
  snapshot: SharedTradingSnapshot;
  agent?: AgentResponse;
  eligibility: EligibilityMode;
}): AgentDataReadItem[] {
  const { market, orderBook, recentTrades, account } = args.snapshot;
  const bestBid = orderBook.bids[0];
  const bestAsk = orderBook.asks[0];
  const selectedPosition = account.positions.find((position) => position.symbol === market.symbol);
  const items: AgentDataReadItem[] = [
    { label: "Market", value: `${market.symbol} (${market.source})` },
    { label: "Mark", value: fmtMarketUsd({ price: market.markPrice, market }) },
    {
      label: "Book",
      value: bestBid && bestAsk
        ? `${orderBook.bids.length}x${orderBook.asks.length} top ${fmtMarketUsd({ price: bestBid.price, market })} / ${fmtMarketUsd({ price: bestAsk.price, market })}`
        : "No top book",
    },
    { label: "Funding", value: fmtPct(market.fundingRatePct) },
    { label: "Open interest", value: fmtUsd(market.openInterestUsd, 0) },
    {
      label: "Trades/candles",
      value: `${recentTrades.length} recent trades; candles summarized when loaded`,
    },
    {
      label: "Account",
      value: selectedPosition
        ? `${selectedPosition.side} ${selectedPosition.base} position`
        : `${fmtUsd(account.availableUsd, 0)} available`,
    },
  ];

  if (args.eligibility !== "liveEligible") {
    items.push({ label: "Mode", value: "Paper draft only" });
  }
  if (args.agent?.warnings?.length) {
    items.push({ label: "Warning", value: args.agent.warnings[0] });
  }

  return items;
}

export function ticketSourceDisplay(draft: Pick<OrderDraft, "fromAgent" | "source"> & { editedAfterAgent?: boolean }): {
  state: TicketSourceDisplayState;
  label: string;
  summary: string;
} {
  if (draft.editedAfterAgent) {
    return {
      state: "editedAfterAgent",
      label: "Edited after agent",
      summary: "Imported draft was manually changed; review every field.",
    };
  }
  if (draft.source === "connector") {
    return {
      state: "connector",
      label: "From Connector",
      summary: "Connector draft imported; you confirm in Agent.trade.",
    };
  }
  if (draft.fromAgent) {
    return {
      state: "agent",
      label: "From Agent",
      summary: "Agent drafts; you confirm.",
    };
  }
  return {
    state: "manual",
    label: "Manual",
    summary: "Manual input; you confirm.",
  };
}
