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

export function createServerAgentProvider(options: ServerAgentProviderOptions = {}): AgentProvider {
  const env = options.env ?? process.env;
  const requested = readProviderName(env.AGENT_TRADE_AGENT_PROVIDER);

  if (requested === "deterministic") {
    return new DeterministicAgentService();
  }

  const liveCallsEnabled = env.AGENT_TRADE_ENABLE_LIVE_LLM === "true";
  if (requested === "openai" && env.OPENAI_API_KEY && liveCallsEnabled) {
    return new OpenAIAgentProvider({
      apiKey: env.OPENAI_API_KEY,
      model: env.AGENT_TRADE_AGENT_MODEL,
      fetchImpl: options.fetchImpl,
    });
  }

  const reason = fallbackReason({
    requested,
    hasApiKey: Boolean(env.OPENAI_API_KEY),
    liveCallsEnabled,
  });
  return new DeterministicFallbackProvider(requested, reason);
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
