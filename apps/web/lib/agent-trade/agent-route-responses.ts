import type { AgentAnalysis, AgentInput } from "./agent-provider";

export function authRequiredAgentRefusal(input: AgentInput, reason: string): AgentAnalysis {
  return refusal({
    input,
    id: "agent-analysis-auth-required",
    summary: "Live model analysis is unavailable.",
    thesis:
      "Live model analysis requires a verified Privy session. I did not call the model, and no order ticket was drafted.",
    riskNote: "Agent.trade can draft only after validated market data and provider output. You still review and confirm any future ticket.",
    whyWrong: "A deterministic local read may still be available, but the live model path cannot run without server-side session verification.",
    reason,
  });
}

export function rateLimitedAgentRefusal(input: AgentInput, retryAfterSeconds: number): AgentAnalysis {
  return refusal({
    input,
    id: "agent-analysis-rate-limited",
    summary: "Agent analysis is temporarily rate limited.",
    thesis:
      `Too many agent-analysis requests arrived for this session. Try again in about ${retryAfterSeconds} seconds.`,
    riskNote: "No live model call was made and no order ticket was drafted.",
    whyWrong: "The market may move while the rate limit window resets. Recheck the ticket and market data before acting.",
    reason: `Rate limited for ${retryAfterSeconds} seconds.`,
  });
}

function refusal(args: {
  input: AgentInput;
  id: string;
  summary: string;
  thesis: string;
  riskNote: string;
  whyWrong: string;
  reason: string;
}): AgentAnalysis {
  return {
    responseType: "refusal",
    summary: args.summary,
    thesis: args.thesis,
    side: "none",
    confidence: 0,
    receipts: [
      { label: "Market", value: args.input.market.symbol, timestamp: args.input.freshness.marketAsOf },
      { label: "Model call", value: "Not sent", timestamp: args.input.timestamp },
    ],
    riskNote: args.riskNote,
    whyWrong: args.whyWrong,
    warnings: [args.reason],
    provider: {
      name: "deterministic",
      deterministic: true,
      generatedAt: args.input.timestamp,
      fallbackReason: args.reason,
    },
    id: args.id,
    question: args.input.requestedPrompt,
    annotations: [],
  };
}
