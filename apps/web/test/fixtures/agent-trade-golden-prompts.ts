import type { EligibilityMode } from "../../lib/agent-trade/types";
import type { AgentResponseType } from "../../lib/agent-trade/agent-provider";

export interface AgentTradeGoldenPromptFixture {
  name: string;
  prompt: string;
  responseType: AgentResponseType;
  side: "long" | "short" | "none";
  expectsDraft: boolean;
  mode: "paper" | "live";
  eligibilityState: EligibilityMode;
  liveAllowed: boolean;
}

export const AGENT_TRADE_GOLDEN_PROMPT_FIXTURES: AgentTradeGoldenPromptFixture[] = [
  {
    name: "long-btc",
    prompt: "Should I long BTC?",
    responseType: "trade_proposal",
    side: "long",
    expectsDraft: true,
    mode: "paper",
    eligibilityState: "restricted",
    liveAllowed: false,
  },
  {
    name: "sell-eth",
    prompt: "sell ETH",
    responseType: "trade_proposal",
    side: "short",
    expectsDraft: true,
    mode: "paper",
    eligibilityState: "restricted",
    liveAllowed: false,
  },
  {
    name: "explain-funding-oi",
    prompt: "Explain funding + OI",
    responseType: "market_read",
    side: "none",
    expectsDraft: false,
    mode: "paper",
    eligibilityState: "restricted",
    liveAllowed: false,
  },
  {
    name: "cleaner-setup",
    prompt: "Find cleaner setup",
    responseType: "no_trade",
    side: "none",
    expectsDraft: false,
    mode: "paper",
    eligibilityState: "restricted",
    liveAllowed: false,
  },
  {
    name: "restricted-paper-only",
    prompt: "Should I long BTC?",
    responseType: "trade_proposal",
    side: "long",
    expectsDraft: true,
    mode: "paper",
    eligibilityState: "restricted",
    liveAllowed: false,
  },
];
