import { describe, expect, it, vi } from "vitest";

import { handleAgentAnalysisPost } from "../lib/agent-trade/agent-analysis-route";
import {
  createServerAgentProvider,
  resolveServerAgentProviderConfig,
} from "../lib/agent-trade/agent-provider-factory";
import { buildAgentInput, type AgentAnalysis, type AgentProvider } from "../lib/agent-trade/agent-provider";
import type { AgentRouteAuthFailureReason, AgentRouteAuthResult } from "../lib/agent-trade/agent-route-auth";
import type { AgentRouteRateLimitDecision } from "../lib/agent-trade/agent-route-rate-limit";
import type { AgentRouteTelemetryEvent } from "../lib/agent-trade/agent-route-telemetry";
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

  it("documents deterministic default and server-only OpenAI env gates", () => {
    expect(resolveServerAgentProviderConfig({})).toMatchObject({
      requested: "deterministic",
      isLiveModelEnabled: false,
    });
    expect(resolveServerAgentProviderConfig({
      AGENT_TRADE_AGENT_PROVIDER: "openai",
      AGENT_TRADE_ENABLE_LIVE_LLM: "true",
      OPENAI_API_KEY: "sk-test",
      AGENT_TRADE_AGENT_MODEL: "test-agent-model",
    })).toMatchObject({
      requested: "openai",
      isLiveModelEnabled: true,
      model: "test-agent-model",
    });
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

  it("does not call OpenAI from the route when Privy auth is missing", async () => {
    const input = buildTestAgentInput();
    const fetchImpl = vi.fn();
    const telemetry: AgentRouteTelemetryEvent[] = [];

    const response = await handleAgentAnalysisPost(agentRequest(input), {
      env: openAiEnabledEnv(),
      fetchImpl,
      authVerifier: async () => unauthenticated("missing_auth"),
      rateLimiter: allowAllLimiter(),
      telemetry: (event) => telemetry.push(event),
      now: () => 1_710_000_000_000,
    });
    const analysis = await response.json() as AgentAnalysis;

    expect(response.status).toBe(200);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(analysis.responseType).toBe("refusal");
    expect(analysis.orderDraft).toBeUndefined();
    expect(analysis.provider.fallbackReason).toBe("missing_auth");
    expect(telemetry[0]).toMatchObject({
      provider: "deterministic",
      authRejected: true,
      fallbackReason: "missing_auth",
    });
  });

  it("does not call OpenAI when the analysis route is rate limited", async () => {
    const input = buildTestAgentInput();
    const provider: AgentProvider = {
      name: "openai",
      analyzeMarket: vi.fn(async () => validModelAnalysis(input)),
    };
    const telemetry: AgentRouteTelemetryEvent[] = [];

    const response = await handleAgentAnalysisPost(agentRequest(input), {
      env: openAiEnabledEnv(),
      provider,
      authVerifier: async () => authenticated(),
      rateLimiter: denyLimiter(17),
      telemetry: (event) => telemetry.push(event),
      now: () => 1_710_000_000_000,
    });
    const analysis = await response.json() as AgentAnalysis;

    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(provider.analyzeMarket).not.toHaveBeenCalled();
    expect(analysis.responseType).toBe("refusal");
    expect(analysis.orderDraft).toBeUndefined();
    expect(analysis.summary).toContain("rate limited");
    expect(telemetry[0]).toMatchObject({
      rateLimited: true,
      fallbackReason: "Rate limited for 17 seconds.",
    });
  });

  it("rejects malformed route provider output without filling a ticket", async () => {
    const input = buildTestAgentInput();
    const invalidProvider = {
      name: "openai",
      analyzeMarket: vi.fn(async () => ({
        responseType: "trade_proposal",
        summary: "Bad",
        thesis: "Missing orderDraft must fail.",
        side: "long",
        confidence: 0.9,
        receipts: [],
        riskNote: "bad",
        whyWrong: "bad",
        warnings: [],
        provider: { name: "openai", deterministic: false, generatedAt: input.timestamp },
      })),
    } as unknown as AgentProvider;
    const telemetry: AgentRouteTelemetryEvent[] = [];

    const response = await handleAgentAnalysisPost(agentRequest(input), {
      env: openAiEnabledEnv(),
      provider: invalidProvider,
      authVerifier: async () => authenticated(),
      rateLimiter: allowAllLimiter(),
      telemetry: (event) => telemetry.push(event),
      now: () => 1_710_000_000_000,
    });
    const analysis = await response.json() as AgentAnalysis;

    expect(response.status).toBe(200);
    expect(analysis.responseType).toBe("refusal");
    expect(analysis.orderDraft).toBeUndefined();
    expect(telemetry[0]).toMatchObject({
      invalidOutput: true,
      fallbackReason: "Provider returned invalid analysis.",
    });
  });

  it("degrades safely when the route provider throws", async () => {
    const input = buildTestAgentInput();
    const throwingProvider: AgentProvider = {
      name: "openai",
      analyzeMarket: vi.fn(async () => {
        throw new Error("provider failed");
      }),
    };

    const response = await handleAgentAnalysisPost(agentRequest(input), {
      env: openAiEnabledEnv(),
      provider: throwingProvider,
      authVerifier: async () => authenticated(),
      rateLimiter: allowAllLimiter(),
      now: () => 1_710_000_000_000,
    });
    const analysis = await response.json() as AgentAnalysis;

    expect(response.status).toBe(200);
    expect(analysis.responseType).toBe("refusal");
    expect(analysis.orderDraft).toBeUndefined();
    expect(analysis.provider.fallbackReason).toBe("Agent provider failed before returning validated output.");
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

function openAiEnabledEnv() {
  return {
    AGENT_TRADE_AGENT_PROVIDER: "openai",
    AGENT_TRADE_ENABLE_LIVE_LLM: "true",
    AGENT_TRADE_AGENT_MODEL: "test-agent-model",
    OPENAI_API_KEY: "sk-test",
  };
}

function agentRequest(input: ReturnType<typeof buildTestAgentInput>): Request {
  return new Request("http://localhost/api/agent-trade/agent-analysis", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
    },
    body: JSON.stringify(input),
  });
}

function authenticated(): AgentRouteAuthResult {
  return {
    authenticated: true,
    privyUserId: "did:privy:test",
    walletAddress: "0x4da360ca0da696ba4d56d94c3ef2d4ba4f26cb43",
    rateLimitKey: "privy:did:privy:test:0x4da360ca0da696ba4d56d94c3ef2d4ba4f26cb43",
  };
}

function unauthenticated(reason: AgentRouteAuthFailureReason): AgentRouteAuthResult {
  return {
    authenticated: false,
    reason,
    rateLimitKey: "ip:203.0.113.10",
  };
}

function allowAllLimiter() {
  return {
    check: ({ key }: { key: string }): AgentRouteRateLimitDecision => ({
      allowed: true,
      key,
      limit: 100,
      remaining: 99,
      resetAt: 1_710_000_060_000,
      retryAfterSeconds: 60,
    }),
  };
}

function denyLimiter(retryAfterSeconds: number) {
  return {
    check: ({ key }: { key: string }): AgentRouteRateLimitDecision => ({
      allowed: false,
      key,
      limit: 1,
      remaining: 0,
      resetAt: 1_710_000_017_000,
      retryAfterSeconds,
    }),
  };
}
