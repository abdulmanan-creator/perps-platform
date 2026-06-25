import { describe, expect, it, vi } from "vitest";

import { createServerAgentProvider } from "../lib/agent-trade/agent-provider-factory";
import { buildAgentInput, type AgentAnalysis } from "../lib/agent-trade/agent-provider";
import { OpenAIAgentProvider } from "../lib/agent-trade/openai-agent-provider";
import { MOCK_TRADING_SNAPSHOT } from "../lib/agent-trade/mock-data";

describe("Agent.trade real agent provider wiring", () => {
  it("defaults to deterministic when provider env is not set", () => {
    const provider = createServerAgentProvider({ env: {} });

    expect(provider.name).toBe("deterministic");
  });

  it("falls back to deterministic when OpenAI is requested without full env enablement", () => {
    const missingKey = createServerAgentProvider({
      env: {
        AGENT_TRADE_AGENT_PROVIDER: "openai",
        AGENT_TRADE_ENABLE_LIVE_LLM: "true",
      },
    });
    const disabled = createServerAgentProvider({
      env: {
        AGENT_TRADE_AGENT_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test",
      },
    });

    expect(missingKey.name).toBe("deterministic");
    expect(disabled.name).toBe("deterministic");
  });

  it("selects OpenAI only when provider, enable flag, and API key are present", () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const provider = createServerAgentProvider({
      env: {
        AGENT_TRADE_AGENT_PROVIDER: "openai",
        AGENT_TRADE_ENABLE_LIVE_LLM: "true",
        AGENT_TRADE_AGENT_MODEL: "test-agent-model",
        OPENAI_API_KEY: "sk-test",
      },
      fetchImpl,
    });

    expect(provider.name).toBe("openai");
  });

  it("returns validated OpenAI model output with provider metadata", async () => {
    const input = buildTestAgentInput();
    const modelAnalysis = validModelAnalysis(input);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(modelAnalysis) } }],
    }), { status: 200 }));
    const provider = new OpenAIAgentProvider({
      apiKey: "sk-test",
      model: "test-agent-model",
      fetchImpl,
    });

    const analysis = await provider.analyzeMarket(input);

    expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/chat/completions", expect.objectContaining({
      method: "POST",
    }));
    expect(analysis.responseType).toBe("market_read");
    expect(analysis.provider).toMatchObject({
      name: "openai",
      model: "test-agent-model",
      deterministic: false,
    });
    expect(analysis.orderDraft).toBeUndefined();
  });

  it("rejects malformed OpenAI model output without a draft", async () => {
    const input = buildTestAgentInput();
    const malformed = {
      responseType: "trade_proposal",
      summary: "Bad draft",
      thesis: "Missing orderDraft should fail validation.",
      side: "long",
      confidence: 0.7,
      receipts: [],
      riskNote: "bad",
      whyWrong: "bad",
      warnings: [],
      provider: { name: "openai", deterministic: false, generatedAt: Date.now() },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(malformed) } }],
    }), { status: 200 }));
    const provider = new OpenAIAgentProvider({
      apiKey: "sk-test",
      model: "test-agent-model",
      fetchImpl,
    });

    const analysis = await provider.analyzeMarket(input);

    expect(analysis.responseType).toBe("refusal");
    expect(analysis.orderDraft).toBeUndefined();
    expect(analysis.provider).toMatchObject({
      name: "openai",
      model: "test-agent-model",
      deterministic: false,
    });
    expect(analysis.provider.fallbackReason).toContain("malformed");
  });

  it("handles OpenAI HTTP errors safely without a draft", async () => {
    const input = buildTestAgentInput();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }));
    const provider = new OpenAIAgentProvider({
      apiKey: "sk-fake",
      model: "test-agent-model",
      fetchImpl,
    });

    const analysis = await provider.analyzeMarket(input);

    expect(analysis.responseType).toBe("refusal");
    expect(analysis.orderDraft).toBeUndefined();
    expect(analysis.provider).toMatchObject({
      name: "openai",
      model: "test-agent-model",
      fallbackReason: "OpenAI provider returned HTTP 401.",
    });
  });

  it("handles OpenAI timeouts safely without a draft", async () => {
    const input = buildTestAgentInput();
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }));
    const provider = new OpenAIAgentProvider({
      apiKey: "sk-test",
      model: "test-agent-model",
      timeoutMs: 1,
      fetchImpl,
    });

    const analysis = await provider.analyzeMarket(input);

    expect(analysis.responseType).toBe("refusal");
    expect(analysis.orderDraft).toBeUndefined();
    expect(analysis.provider.fallbackReason).toContain("timed out");
  });
});

function buildTestAgentInput() {
  return buildAgentInput({
    prompt: "Give me a BTC market read",
    scenario: "marketRead",
    snapshot: MOCK_TRADING_SNAPSHOT,
    mode: "paper",
    eligibilityState: "restricted",
    liveAllowed: false,
    paperAllowed: true,
    now: 1_710_000_000_000,
  });
}

function validModelAnalysis(input: ReturnType<typeof buildTestAgentInput>): AgentAnalysis {
  return {
    responseType: "market_read",
    summary: "BTC is in a monitored market-read state.",
    thesis: "BTC has usable mark, oracle, funding, order book, and account context. This is a read only, not execution.",
    side: "none",
    confidence: 0.61,
    receipts: [
      { label: "Mark", value: String(input.market.markPrice), timestamp: input.freshness.marketAsOf },
      { label: "Funding", value: String(input.market.fundingRatePct), timestamp: input.freshness.marketAsOf },
    ],
    riskNote: "No order is being placed. Any future draft requires user confirmation.",
    whyWrong: "The read could miss news, hidden liquidity, or flow not present in the terminal snapshot.",
    warnings: [],
    provider: {
      name: "openai",
      model: "test-agent-model",
      deterministic: false,
      generatedAt: input.timestamp,
    },
    id: "btc-openai-market-read",
    question: input.requestedPrompt,
    annotations: [],
  };
}
