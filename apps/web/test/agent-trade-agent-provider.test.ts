import { describe, expect, it, vi } from "vitest";

import { handleAgentAnalysisGet, handleAgentAnalysisPost } from "../lib/agent-trade/agent-analysis-route";
import { agentAnalysisRouteHeaders, fetchAgentAnalysisRoute } from "../lib/agent-trade/agent-service";
import {
  createServerAgentProvider,
  resolveServerAgentProviderConfig,
} from "../lib/agent-trade/agent-provider-factory";
import { buildAgentInput, type AgentAnalysis, type AgentInput, type AgentProvider } from "../lib/agent-trade/agent-provider";
import type { AgentRouteAuthFailureReason, AgentRouteAuthResult } from "../lib/agent-trade/agent-route-auth";
import type { AgentRouteRateLimitDecision } from "../lib/agent-trade/agent-route-rate-limit";
import type { AgentRouteTelemetryEvent } from "../lib/agent-trade/agent-route-telemetry";
import { AnthropicAgentProvider } from "../lib/agent-trade/anthropic-agent-provider";
import { DeepSeekAgentProvider, OpenAIAgentProvider, QwenAgentProvider } from "../lib/agent-trade/openai-agent-provider";
import { MOCK_TRADING_SNAPSHOT } from "../lib/agent-trade/mock-data";
import { buildPredictionAgentInput } from "../lib/agent-trade/predictions";
import {
  normalizeModelAgentAnalysisOutput,
  parseAgentAnalysisWithDiagnostics,
} from "../lib/agent-trade/agent-validation";

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
      resolved: "deterministic",
      isLiveModelEnabled: false,
    });
    expect(resolveServerAgentProviderConfig({
      AGENT_TRADE_AGENT_PROVIDER: "openai",
      AGENT_TRADE_ENABLE_LIVE_LLM: "true",
      OPENAI_API_KEY: "sk-test",
      AGENT_TRADE_AGENT_MODEL: "test-agent-model",
    })).toMatchObject({
      requested: "openai",
      resolved: "openai",
      isLiveModelEnabled: true,
      model: "test-agent-model",
    });
  });

  it("selects Anthropic, DeepSeek, and Qwen only when live calls and keys are configured", () => {
    expect(createServerAgentProvider({
      env: {
        AGENT_TRADE_AGENT_PROVIDER: "anthropic",
        AGENT_TRADE_ENABLE_LIVE_LLM: "true",
        ANTHROPIC_API_KEY: "anthropic-test",
      },
      fetchImpl: vi.fn(),
    }).name).toBe("anthropic");
    expect(createServerAgentProvider({
      env: {
        AGENT_TRADE_AGENT_PROVIDER: "deepseek",
        AGENT_TRADE_ENABLE_LIVE_LLM: "true",
        DEEPSEEK_API_KEY: "deepseek-test",
      },
      fetchImpl: vi.fn(),
    }).name).toBe("deepseek");
    expect(createServerAgentProvider({
      env: {
        AGENT_TRADE_AGENT_PROVIDER: "qwen",
        AGENT_TRADE_ENABLE_LIVE_LLM: "true",
        QWEN_API_KEY: "qwen-test",
      },
      fetchImpl: vi.fn(),
    }).name).toBe("qwen");
  });

  it("auto selects the first configured live provider and otherwise stays deterministic", () => {
    expect(resolveServerAgentProviderConfig({
      AGENT_TRADE_AGENT_PROVIDER: "auto",
      AGENT_TRADE_ENABLE_LIVE_LLM: "true",
      DEEPSEEK_API_KEY: "deepseek-test",
    })).toMatchObject({
      requested: "auto",
      resolved: "deepseek",
      isLiveModelEnabled: true,
    });
    expect(resolveServerAgentProviderConfig({
      AGENT_TRADE_AGENT_PROVIDER: "auto",
      AGENT_TRADE_ENABLE_LIVE_LLM: "true",
    })).toMatchObject({
      requested: "auto",
      resolved: "deterministic",
      isLiveModelEnabled: false,
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

  it("accepts OpenAI model output without provider metadata after server provider injection", async () => {
    const input = buildTestAgentInput();
    const { provider: _modelProvider, ...modelAnalysis } = validModelAnalysis(input);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(modelAnalysis) } }],
    }), { status: 200 }));
    const provider = new OpenAIAgentProvider({
      apiKey: "sk-test",
      model: "test-agent-model",
      fetchImpl,
    });

    const analysis = await provider.analyzeMarket(input);

    expect(analysis.responseType).toBe("market_read");
    expect(analysis.provider).toMatchObject({
      name: "openai",
      model: "test-agent-model",
      deterministic: false,
    });
    expect(JSON.stringify(modelAnalysis)).not.toContain("provider");
  });

  it("normalizes OpenAI model provider metadata even when generatedAt is an ISO string", async () => {
    const input = buildTestAgentInput();
    const modelAnalysis = {
      ...validModelAnalysis(input),
      provider: {
        name: "openai",
        model: "model-claimed-by-output",
        deterministic: false,
        generatedAt: "2026-06-28T00:00:00.000Z",
      },
    };
    const rawParse = parseAgentAnalysisWithDiagnostics(modelAnalysis);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(modelAnalysis) } }],
    }), { status: 200 }));
    const provider = new OpenAIAgentProvider({
      apiKey: "sk-test",
      model: "test-agent-model",
      fetchImpl,
    });

    const analysis = await provider.analyzeMarket(input);

    expect(rawParse).toEqual({ ok: false, code: "missing_provider_generatedAt" });
    expect(analysis.provider).toMatchObject({
      name: "openai",
      model: "test-agent-model",
      deterministic: false,
    });
  });

  it("validates HIP4-32 OpenAI market_read output without model provider metadata", async () => {
    const input = buildPredictionTestAgentInput("Explain this odds move");
    const modelAnalysis = predictionMarketRead(input);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(modelAnalysis) } }],
    }), { status: 200 }));
    const provider = new OpenAIAgentProvider({
      apiKey: "sk-test",
      model: "test-agent-model",
      fetchImpl,
    });

    const analysis = await provider.analyzeMarket(input);

    expect(analysis.responseType).toBe("market_read");
    expect(analysis.orderDraft).toBeUndefined();
    expect(analysis.predictionDraft).toBeUndefined();
    expect(analysis.provider.name).toBe("openai");
  });

  it("validates HIP4-32 OpenAI trade_proposal output with a predictionDraft", async () => {
    const input = buildPredictionTestAgentInput("Draft a marketable order", { mode: "live", liveAllowed: true });
    const modelAnalysis = predictionTradeProposal(input);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(modelAnalysis) } }],
    }), { status: 200 }));
    const provider = new OpenAIAgentProvider({
      apiKey: "sk-test",
      model: "test-agent-model",
      fetchImpl,
    });

    const analysis = await provider.analyzeMarket(input);

    expect(analysis.responseType).toBe("trade_proposal");
    expect(analysis.orderDraft).toBeUndefined();
    expect(analysis.predictionDraft).toMatchObject({
      kind: "prediction_order",
      action: "buy",
      contracts: 12,
      limitProbability: 0.25,
      paperOnly: false,
      fromAgent: true,
    });
  });

  it("rejects HIP4-32 OpenAI trade_proposal output with an orderDraft instead of predictionDraft", async () => {
    const input = buildPredictionTestAgentInput("Draft a marketable order", { mode: "live", liveAllowed: true });
    const modelAnalysis = {
      ...predictionMarketRead(input),
      responseType: "trade_proposal",
      orderDraft: {
        symbol: "BTC-USD",
        side: "long",
        orderType: "market",
        sizeBtc: 0.01,
        leverage: 2,
        marginMode: "isolated",
        reduceOnly: false,
        fromAgent: true,
      },
    };
    const normalized = normalizeModelAgentAnalysisOutput({
      output: modelAnalysis,
      providerName: "openai",
      model: "test-agent-model",
      generatedAt: input.timestamp,
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(modelAnalysis) } }],
    }), { status: 200 }));
    const provider = new OpenAIAgentProvider({
      apiKey: "sk-test",
      model: "test-agent-model",
      fetchImpl,
    });

    const analysis = await provider.analyzeMarket(input);

    expect(parseAgentAnalysisWithDiagnostics(normalized, { input })).toEqual({
      ok: false,
      code: "orderDraft_for_prediction_market",
    });
    expect(analysis.responseType).toBe("refusal");
    expect(analysis.orderDraft).toBeUndefined();
    expect(analysis.predictionDraft).toBeUndefined();
    expect(analysis.provider.fallbackReason).toContain("orderDraft_for_prediction_market");
  });

  it("rejects OpenAI output with both orderDraft and predictionDraft", async () => {
    const input = buildPredictionTestAgentInput("Draft a marketable order", { mode: "live", liveAllowed: true });
    const modelAnalysis = {
      ...predictionTradeProposal(input),
      orderDraft: {
        symbol: "BTC-USD",
        side: "long",
        orderType: "market",
        sizeBtc: 0.01,
        leverage: 2,
        marginMode: "isolated",
        reduceOnly: false,
        fromAgent: true,
      },
    };
    const normalized = normalizeModelAgentAnalysisOutput({
      output: modelAnalysis,
      providerName: "openai",
      model: "test-agent-model",
      generatedAt: input.timestamp,
    });

    expect(parseAgentAnalysisWithDiagnostics(normalized, { input })).toEqual({
      ok: false,
      code: "both_drafts_present",
    });
  });

  it("rejects invalid predictionDraft output without prefilling a ticket", async () => {
    const input = buildPredictionTestAgentInput("Draft a marketable order");
    const modelAnalysis = {
      ...predictionTradeProposal(input),
      predictionDraft: {
        ...predictionTradeProposal(input).predictionDraft,
        contracts: 1.5,
      },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(modelAnalysis) } }],
    }), { status: 200 }));
    const provider = new OpenAIAgentProvider({
      apiKey: "sk-test",
      model: "test-agent-model",
      fetchImpl,
    });

    const analysis = await provider.analyzeMarket(input);

    expect(analysis.responseType).toBe("refusal");
    expect(analysis.orderDraft).toBeUndefined();
    expect(analysis.predictionDraft).toBeUndefined();
    expect(analysis.provider.fallbackReason).toContain("invalid_predictionDraft_contracts");
  });

  it("returns validated Anthropic model output with provider metadata", async () => {
    const input = buildTestAgentInput();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(validModelAnalysis(input, "anthropic")) }],
    }), { status: 200 }));
    const provider = new AnthropicAgentProvider({
      apiKey: "anthropic-test",
      model: "claude-test",
      fetchImpl,
    });

    const analysis = await provider.analyzeMarket(input);

    expect(fetchImpl).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", expect.objectContaining({
      method: "POST",
    }));
    expect(analysis.provider).toMatchObject({
      name: "anthropic",
      model: "claude-test",
      deterministic: false,
    });
    expect(analysis.orderDraft).toBeUndefined();
  });

  it("returns validated DeepSeek and Qwen model output through provider-specific OpenAI-compatible config", async () => {
    const input = buildTestAgentInput();
    const deepSeekFetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(validModelAnalysis(input, "deepseek")) } }],
    }), { status: 200 }));
    const qwenFetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(validModelAnalysis(input, "qwen")) } }],
    }), { status: 200 }));

    const deepSeek = await new DeepSeekAgentProvider({
      apiKey: "deepseek-test",
      model: "deepseek-test-model",
      fetchImpl: deepSeekFetch,
    }).analyzeMarket(input);
    const qwen = await new QwenAgentProvider({
      apiKey: "qwen-test",
      model: "qwen-test-model",
      fetchImpl: qwenFetch,
    }).analyzeMarket(input);

    expect(deepSeekFetch).toHaveBeenCalledWith("https://api.deepseek.com/chat/completions", expect.objectContaining({
      method: "POST",
    }));
    expect(qwenFetch).toHaveBeenCalledWith("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", expect.objectContaining({
      method: "POST",
    }));
    expect(deepSeek.provider).toMatchObject({ name: "deepseek", model: "deepseek-test-model" });
    expect(qwen.provider).toMatchObject({ name: "qwen", model: "qwen-test-model" });
    expect(deepSeek.orderDraft).toBeUndefined();
    expect(qwen.orderDraft).toBeUndefined();
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

  it("exposes provider availability without exposing server API keys", async () => {
    const response = await handleAgentAnalysisGet({
      env: {
        AGENT_TRADE_AGENT_PROVIDER: "auto",
        AGENT_TRADE_ENABLE_LIVE_LLM: "true",
        OPENAI_API_KEY: "sk-test",
        ANTHROPIC_API_KEY: "anthropic-test",
        DEEPSEEK_API_KEY: "deepseek-test",
        QWEN_API_KEY: "qwen-test",
      },
    });
    const body = await response.json() as {
      providers: Array<{ name: string; available: boolean; model?: string; apiKey?: string }>;
    };

    expect(body.providers.map((provider) => provider.name)).toEqual([
      "auto",
      "openai",
      "anthropic",
      "deepseek",
      "qwen",
      "deterministic",
    ]);
    expect(body.providers.filter((provider) => provider.available).map((provider) => provider.name)).toEqual([
      "auto",
      "openai",
      "anthropic",
      "deepseek",
      "qwen",
      "deterministic",
    ]);
    expect(JSON.stringify(body)).not.toContain("sk-test");
    expect(JSON.stringify(body)).not.toContain("anthropic-test");
  });

  it("keeps provider availability GET public without a bearer token", async () => {
    const response = await handleAgentAnalysisGet({ env: openAiEnabledEnv() });
    const body = await response.json() as { providers: Array<{ name: string }> };

    expect(response.status).toBe(200);
    expect(body.providers.map((provider) => provider.name)).toContain("openai");
  });

  it("includes Privy bearer auth on live provider analysis POST when a token is available", async () => {
    const input = buildTestAgentInput();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const body = String(init.body);
      expect(headers.authorization).toBe("Bearer privy-access-token");
      expect(headers["content-type"]).toBe("application/json");
      expect(body).not.toContain("privy-access-token");
      return new Response(JSON.stringify(validModelAnalysis(input)), { status: 200 });
    });

    const response = await fetchAgentAnalysisRoute({
      input,
      provider: "openai",
      getAccessToken: async () => "privy-access-token",
      fetchImpl,
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith("/api/agent-trade/agent-analysis", expect.objectContaining({
      method: "POST",
    }));
  });

  it("omits bearer auth safely when the Privy token is missing or unavailable", async () => {
    await expect(agentAnalysisRouteHeaders({
      getAccessToken: async () => undefined,
    })).resolves.toEqual({ "content-type": "application/json" });
    await expect(agentAnalysisRouteHeaders({
      getAccessToken: async () => {
        throw new Error("Privy unavailable");
      },
    })).resolves.toEqual({ "content-type": "application/json" });
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

  it("uses selected provider metadata from the POST envelope", async () => {
    const input = buildTestAgentInput();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(validModelAnalysis(input, "deepseek")) } }],
    }), { status: 200 }));

    const response = await handleAgentAnalysisPost(agentRequest(input, "deepseek"), {
      env: {
        AGENT_TRADE_AGENT_PROVIDER: "deterministic",
        AGENT_TRADE_ENABLE_LIVE_LLM: "true",
        DEEPSEEK_API_KEY: "deepseek-test",
        AGENT_TRADE_DEEPSEEK_MODEL: "deepseek-selected",
      },
      fetchImpl,
      authVerifier: async () => authenticated(),
      rateLimiter: allowAllLimiter(),
      now: () => 1_710_000_000_000,
    });
    const analysis = await response.json() as AgentAnalysis;

    expect(analysis.provider).toMatchObject({
      name: "deepseek",
      model: "deepseek-selected",
      deterministic: false,
    });
    expect(analysis.orderDraft).toBeUndefined();
  });

  it("falls back deterministically when selected provider is missing an API key", async () => {
    const input = buildTestAgentInput();
    const fetchImpl = vi.fn();

    const response = await handleAgentAnalysisPost(agentRequest(input, "qwen"), {
      env: {
        AGENT_TRADE_AGENT_PROVIDER: "deterministic",
        AGENT_TRADE_ENABLE_LIVE_LLM: "true",
      },
      fetchImpl,
      authVerifier: async () => authenticated(),
      rateLimiter: allowAllLimiter(),
      now: () => 1_710_000_000_000,
    });
    const analysis = await response.json() as AgentAnalysis;

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(analysis.provider).toMatchObject({
      name: "deterministic",
      deterministic: true,
      fallbackReason: "Qwen provider requested without QWEN_API_KEY; using deterministic fallback.",
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
      fallbackReason: "Provider returned invalid analysis (missing_trade_draft).",
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

function validModelAnalysis(
  input: AgentInput,
  providerName: AgentAnalysis["provider"]["name"] = "openai",
): AgentAnalysis {
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
      name: providerName,
      model: "test-agent-model",
      deterministic: false,
      generatedAt: input.timestamp,
    },
    id: "btc-openai-market-read",
    question: input.requestedPrompt,
    annotations: [],
  };
}

function buildPredictionTestAgentInput(
  prompt: string,
  options: { mode?: "paper" | "live"; liveAllowed?: boolean } = {},
): AgentInput {
  return buildPredictionAgentInput({
    prompt,
    question: {
      questionId: 32,
      name: "World Cup Champion",
      description: "World Cup winner.",
      criteria: "Settles to the official FIFA World Cup winner.",
      metadata: { category: "sports", subCategory: "football", raw: "category:sports|subCategory:football" },
      quoteToken: "USDC",
      quoteTokens: ["USDC"],
      fallbackOutcome: null,
      namedOutcomes: [
        {
          outcome: 189,
          name: "France",
          description: "",
          quoteToken: "USDC",
          sides: [
            { side: 0, name: "Yes", encoding: 1890, coin: "#1890", assetId: 100_001_890 },
            { side: 1, name: "No", encoding: 1891, coin: "#1891", assetId: 100_001_891 },
          ],
        },
      ],
      settlement: { state: "open", settledNamedOutcomeIds: [] },
    },
    selectedOutcome: {
      outcome: 189,
      name: "France",
      description: "",
      quoteToken: "USDC",
      sides: [
        { side: 0, name: "Yes", encoding: 1890, coin: "#1890", assetId: 100_001_890 },
        { side: 1, name: "No", encoding: 1891, coin: "#1891", assetId: 100_001_891 },
      ],
    },
    selectedSide: {
      side: 0,
      name: "Yes",
      encoding: 1890,
      coin: "#1890",
      assetId: 100_001_890,
      bestBid: "0.20",
      bestAsk: "0.25",
      midpointProbability: 0.225,
      spread: 0.05,
      depth: { bidLevels: 1, askLevels: 1, bidSize: 30, askSize: 20, bidNotional: 6, askNotional: 5 },
      emptyBook: false,
      fetchedAt: 1_710_000_000_000,
      topBidLevels: [{ px: "0.20", sz: "30" }],
      topAskLevels: [{ px: "0.25", sz: "20" }],
    },
    streamStatus: "live",
    streamLastBookAt: 1_710_000_000_000,
    streamFreshnessLabel: "just now",
    mode: options.mode ?? "paper",
    eligibilityState: options.liveAllowed ? "liveEligible" : "restricted",
    liveAllowed: options.liveAllowed ?? false,
    hip4Spendable: "100",
    perpWithdrawable: "100",
    balanceStatus: "ready",
    ticket: { contracts: 12, limitProbability: 0.25, tif: "Ioc", criteriaAcknowledged: true },
    now: 1_710_000_000_500,
  });
}

function predictionMarketRead(input: AgentInput): Omit<AgentAnalysis, "provider"> {
  return {
    responseType: "market_read",
    summary: "France Yes market read.",
    thesis: "France Yes has usable HIP-4 book context and no draft is needed for this read.",
    side: "none",
    confidence: 0.58,
    receipts: [
      { label: "Question", value: "World Cup Champion", timestamp: input.timestamp },
      { label: "Best bid/ask", value: "0.20 / 0.25", timestamp: input.timestamp },
    ],
    riskNote: "Prediction markets can lose the full premium paid.",
    whyWrong: "The market can move or resolution criteria can differ from expectations.",
    warnings: [],
    annotations: [],
  };
}

function predictionTradeProposal(input: AgentInput): Omit<AgentAnalysis, "provider"> {
  return {
    ...predictionMarketRead(input),
    responseType: "trade_proposal",
    summary: "France Yes prediction draft.",
    predictionDraft: {
      kind: "prediction_order",
      questionId: 32,
      questionName: "World Cup Champion",
      outcome: 189,
      outcomeName: "France",
      side: 0,
      sideName: "Yes",
      action: "buy",
      contracts: 12,
      limitProbability: 0.25,
      tif: "Ioc",
      paperOnly: input.eligibility.mode !== "live" || !input.eligibility.liveAllowed,
      fromAgent: true,
    },
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

function agentRequest(input: ReturnType<typeof buildTestAgentInput>, provider?: string): Request {
  return new Request("http://localhost/api/agent-trade/agent-analysis", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
    },
    body: JSON.stringify(provider ? { input, provider } : input),
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
