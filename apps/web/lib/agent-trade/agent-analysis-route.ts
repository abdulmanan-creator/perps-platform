import { NextResponse } from "next/server";

import type { AgentProvider } from "./agent-provider";
import {
  createServerAgentProvider,
  readAgentProviderEnv,
  resolveServerAgentProviderConfig,
  type AgentProviderEnv,
} from "./agent-provider-factory";
import type { AgentProviderSelection } from "./agent-provider";
import {
  ipRateLimitKey,
  verifyAgentRoutePrivyAuth,
  type AgentRouteAuthEnv,
  type AgentRouteAuthVerifier,
} from "./agent-route-auth";
import {
  agentAnalysisRateLimiter,
  type AgentRouteRateLimitEnv,
  type AgentRouteRateLimiter,
} from "./agent-route-rate-limit";
import { authRequiredAgentRefusal, rateLimitedAgentRefusal } from "./agent-route-responses";
import {
  logAgentRouteTelemetry,
  type AgentRouteTelemetryLogger,
} from "./agent-route-telemetry";
import {
  invalidAgentOutputRefusal,
  parseProviderName,
  parseAgentAnalysis,
  parseAgentAnalysisWithDiagnostics,
  parseAgentInput,
} from "./agent-validation";
import type { AgentFetch } from "./openai-agent-provider";

export interface AgentAnalysisRouteEnv extends AgentProviderEnv, AgentRouteAuthEnv, AgentRouteRateLimitEnv {}

export interface AgentAnalysisRouteOptions {
  env?: AgentAnalysisRouteEnv;
  fetchImpl?: AgentFetch;
  authVerifier?: AgentRouteAuthVerifier;
  rateLimiter?: AgentRouteRateLimiter;
  telemetry?: AgentRouteTelemetryLogger;
  provider?: AgentProvider;
  now?: () => number;
}

export async function handleAgentAnalysisPost(
  request: Request,
  options: AgentAnalysisRouteOptions = {},
) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const telemetry = options.telemetry ?? logAgentRouteTelemetry;
  const env = options.env ?? readAgentAnalysisRouteEnv();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Invalid JSON body." }, { status: 400 });
  }

  const envelope = parseAgentAnalysisRequest(body);
  const providerConfig = resolveServerAgentProviderConfig(env, envelope.provider);
  const input = parseAgentInput(envelope.input);
  if (!input) {
    return NextResponse.json({ message: "Invalid AgentInput body." }, { status: 400 });
  }

  const authResult = providerConfig.isLiveModelEnabled
    ? await (options.authVerifier ?? verifyAgentRoutePrivyAuth)({ request, env })
    : undefined;
  const rateLimitKey = authResult?.rateLimitKey ?? ipRateLimitKey(request);
  const rateLimit = (options.rateLimiter ?? agentAnalysisRateLimiter).check({
    key: rateLimitKey,
    now: startedAt,
  });

  if (!rateLimit.allowed) {
    const analysis = rateLimitedAgentRefusal(input, rateLimit.retryAfterSeconds);
    telemetry({
      route: "agent_analysis",
      provider: analysis.provider.name,
      model: providerConfig.model,
      symbol: input.market.symbol,
      source: input.market.source,
      responseType: analysis.responseType,
      latencyMs: now() - startedAt,
      fallbackReason: analysis.provider.fallbackReason,
      rateLimited: true,
    });
    return NextResponse.json(analysis, {
      headers: {
        ...jsonHeaders(),
        "retry-after": String(rateLimit.retryAfterSeconds),
      },
    });
  }

  if (providerConfig.isLiveModelEnabled && authResult?.authenticated !== true) {
    const analysis = authRequiredAgentRefusal(
      input,
      authResult?.reason ?? "Privy session verification failed.",
    );
    telemetry({
      route: "agent_analysis",
      provider: analysis.provider.name,
      model: providerConfig.model,
      symbol: input.market.symbol,
      source: input.market.source,
      responseType: analysis.responseType,
      latencyMs: now() - startedAt,
      fallbackReason: analysis.provider.fallbackReason,
      authRejected: true,
    });
    return NextResponse.json(analysis, {
      headers: jsonHeaders(),
    });
  }

  const provider = options.provider ?? createServerAgentProvider({
    env,
    fetchImpl: options.fetchImpl,
    requestedProvider: providerConfig.requested,
  });
  let rawAnalysis: unknown;
  try {
    rawAnalysis = await provider.analyzeMarket(input);
  } catch {
    rawAnalysis = invalidAgentOutputRefusal(input, "Agent provider failed before returning validated output.");
  }
  const parsedAnalysis = parseAgentAnalysisWithDiagnostics(rawAnalysis, { input });
  const analysis = parsedAnalysis.ok
    ? parsedAnalysis.analysis
    : invalidAgentOutputRefusal(input, `Provider returned invalid analysis (${parsedAnalysis.code}).`);
  analysis.provider.latencyMs = now() - startedAt;
  const invalidOutput = !parsedAnalysis.ok;
  telemetry({
    route: "agent_analysis",
    provider: analysis.provider.name,
    model: analysis.provider.model ?? providerConfig.model,
    symbol: input.market.symbol,
    source: input.market.source,
    responseType: analysis.responseType,
    latencyMs: now() - startedAt,
    fallbackReason: analysis.provider.fallbackReason,
    invalidOutput,
    timeout: analysis.provider.fallbackReason?.toLowerCase().includes("timed out") || undefined,
  });
  return NextResponse.json(analysis, {
    headers: jsonHeaders(),
  });
}

export async function handleAgentAnalysisGet(options: Pick<AgentAnalysisRouteOptions, "env"> = {}) {
  const env = options.env ?? readAgentAnalysisRouteEnv();
  const providerConfig = resolveServerAgentProviderConfig(env);
  return NextResponse.json(
    {
      requested: providerConfig.requested,
      resolved: providerConfig.resolved,
      liveCallsEnabled: providerConfig.liveCallsEnabled,
      providers: providerConfig.providers,
    },
    {
      headers: jsonHeaders(),
    },
  );
}

function parseAgentAnalysisRequest(body: unknown): {
  input: unknown;
  provider?: AgentProviderSelection;
} {
  if (isRecord(body) && "input" in body) {
    return {
      input: body.input,
      provider: parseProviderSelection(body.provider),
    };
  }
  return {
    input: body,
    provider: isRecord(body) ? parseProviderSelection(body.providerPreference) : undefined,
  };
}

function jsonHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
  };
}

function readAgentAnalysisRouteEnv(): AgentAnalysisRouteEnv {
  return {
    ...readAgentProviderEnv(),
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    QWEN_API_KEY: process.env.QWEN_API_KEY,
    PRIVY_APP_ID: process.env.PRIVY_APP_ID,
    PRIVY_APP_SECRET: process.env.PRIVY_APP_SECRET,
    AGENT_TRADE_AGENT_RATE_LIMIT_MAX: process.env.AGENT_TRADE_AGENT_RATE_LIMIT_MAX,
    AGENT_TRADE_AGENT_RATE_LIMIT_WINDOW_MS: process.env.AGENT_TRADE_AGENT_RATE_LIMIT_WINDOW_MS,
  };
}

function parseProviderSelection(input: unknown): AgentProviderSelection | undefined {
  if (input === "auto") {
    return "auto";
  }
  const providerName = parseProviderName(input);
  if (
    providerName === "deterministic" ||
    providerName === "openai" ||
    providerName === "anthropic" ||
    providerName === "deepseek" ||
    providerName === "qwen"
  ) {
    return providerName;
  }
  return undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}
