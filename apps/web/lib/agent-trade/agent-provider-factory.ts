import { DeterministicAgentService } from "./agent-service";
import type { AgentAnalysis, AgentInput, AgentProvider, AgentProviderName } from "./agent-provider";
import { OpenAIAgentProvider, type AgentFetch } from "./openai-agent-provider";

export interface AgentProviderEnv {
  AGENT_TRADE_AGENT_PROVIDER?: string;
  AGENT_TRADE_ENABLE_LIVE_LLM?: string;
  AGENT_TRADE_AGENT_MODEL?: string;
  OPENAI_API_KEY?: string;
}

export interface ServerAgentProviderOptions {
  env?: AgentProviderEnv;
  fetchImpl?: AgentFetch;
}

export interface ServerAgentProviderConfig {
  requested: AgentProviderName;
  isLiveModelEnabled: boolean;
  liveCallsEnabled: boolean;
  hasOpenAIKey: boolean;
  model?: string;
  fallbackReason?: string;
}

/**
 * Server-only model env:
 * - AGENT_TRADE_AGENT_PROVIDER=openai
 * - AGENT_TRADE_ENABLE_LIVE_LLM=true
 * - OPENAI_API_KEY=<server secret>
 * - AGENT_TRADE_AGENT_MODEL optional
 *
 * Never expose an OpenAI key through NEXT_PUBLIC_* env vars.
 */
export function resolveServerAgentProviderConfig(env: AgentProviderEnv = readAgentProviderEnv()): ServerAgentProviderConfig {
  const requested = readProviderName(env.AGENT_TRADE_AGENT_PROVIDER);
  const liveCallsEnabled = env.AGENT_TRADE_ENABLE_LIVE_LLM === "true";
  const hasOpenAIKey = Boolean(env.OPENAI_API_KEY);
  const isLiveModelEnabled = requested === "openai" && liveCallsEnabled && hasOpenAIKey;
  return {
    requested,
    isLiveModelEnabled,
    liveCallsEnabled,
    hasOpenAIKey,
    model: env.AGENT_TRADE_AGENT_MODEL,
    fallbackReason: isLiveModelEnabled
      ? undefined
      : fallbackReason({ requested, hasApiKey: hasOpenAIKey, liveCallsEnabled }),
  };
}

export function createServerAgentProvider(options: ServerAgentProviderOptions = {}): AgentProvider {
  const env = options.env ?? readAgentProviderEnv();
  const config = resolveServerAgentProviderConfig(env);

  if (config.requested === "deterministic") {
    return new DeterministicAgentService();
  }

  if (config.isLiveModelEnabled && env.OPENAI_API_KEY) {
    return new OpenAIAgentProvider({
      apiKey: env.OPENAI_API_KEY,
      model: env.AGENT_TRADE_AGENT_MODEL,
      fetchImpl: options.fetchImpl,
    });
  }

  return new DeterministicFallbackProvider(
    config.requested,
    config.fallbackReason ?? "Model provider unavailable; using deterministic fallback.",
  );
}

function readAgentProviderEnv(): AgentProviderEnv {
  return {
    AGENT_TRADE_AGENT_PROVIDER: process.env.AGENT_TRADE_AGENT_PROVIDER,
    AGENT_TRADE_ENABLE_LIVE_LLM: process.env.AGENT_TRADE_ENABLE_LIVE_LLM,
    AGENT_TRADE_AGENT_MODEL: process.env.AGENT_TRADE_AGENT_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
}

function readProviderName(input: string | undefined): AgentProviderName {
  if (input === "openai" || input === "anthropic" || input === "openrouter") {
    return input;
  }
  return "deterministic";
}

function fallbackReason(args: {
  requested: AgentProviderName;
  hasApiKey: boolean;
  liveCallsEnabled: boolean;
}) {
  if (args.requested !== "openai") {
    return `${args.requested} provider is not wired in Phase 4B; using deterministic fallback.`;
  }
  if (!args.liveCallsEnabled) {
    return "OpenAI provider requested but AGENT_TRADE_ENABLE_LIVE_LLM is not true; using deterministic fallback.";
  }
  if (!args.hasApiKey) {
    return "OpenAI provider requested without OPENAI_API_KEY; using deterministic fallback.";
  }
  return "OpenAI provider unavailable; using deterministic fallback.";
}

class DeterministicFallbackProvider implements AgentProvider {
  readonly name = "deterministic" as const;
  private readonly deterministic = new DeterministicAgentService();

  constructor(
    private readonly requestedProvider: AgentProviderName,
    private readonly reason: string,
  ) {}

  async analyzeMarket(input: AgentInput): Promise<AgentAnalysis> {
    const analysis = await this.deterministic.analyzeMarket(input);
    return {
      ...analysis,
      warnings: [...analysis.warnings, this.reason],
      provider: {
        ...analysis.provider,
        fallbackReason: this.reason,
      },
    };
  }
}
