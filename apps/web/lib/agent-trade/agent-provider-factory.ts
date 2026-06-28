import { AnthropicAgentProvider, DEFAULT_ANTHROPIC_AGENT_MODEL } from "./anthropic-agent-provider";
import { DeterministicAgentService } from "./agent-service";
import type {
  AgentAnalysis,
  AgentInput,
  AgentProvider,
  AgentProviderName,
  AgentProviderSelection,
} from "./agent-provider";
import {
  DeepSeekAgentProvider,
  DEFAULT_DEEPSEEK_AGENT_MODEL,
  DEFAULT_OPENAI_AGENT_MODEL,
  DEFAULT_QWEN_AGENT_MODEL,
  OpenAIAgentProvider,
  QwenAgentProvider,
  type AgentFetch,
} from "./openai-agent-provider";

type LiveAgentProviderName = Exclude<AgentProviderSelection, "auto" | "deterministic">;

export interface AgentProviderEnv {
  AGENT_TRADE_AGENT_PROVIDER?: string;
  AGENT_TRADE_ENABLE_LIVE_LLM?: string;
  AGENT_TRADE_AGENT_MODEL?: string;
  AGENT_TRADE_OPENAI_MODEL?: string;
  AGENT_TRADE_ANTHROPIC_MODEL?: string;
  AGENT_TRADE_DEEPSEEK_MODEL?: string;
  AGENT_TRADE_QWEN_MODEL?: string;
  DEEPSEEK_BASE_URL?: string;
  QWEN_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  QWEN_API_KEY?: string;
}

export interface ServerAgentProviderOptions {
  env?: AgentProviderEnv;
  fetchImpl?: AgentFetch;
  requestedProvider?: AgentProviderSelection;
}

export interface ProviderAvailability {
  name: AgentProviderSelection;
  label: string;
  available: boolean;
  configured: boolean;
  model?: string;
  reason?: string;
}

export interface ServerAgentProviderConfig {
  requested: AgentProviderSelection;
  resolved: AgentProviderName;
  isLiveModelEnabled: boolean;
  liveCallsEnabled: boolean;
  models: Record<Exclude<AgentProviderSelection, "auto" | "deterministic">, string>;
  keys: Record<Exclude<AgentProviderSelection, "auto" | "deterministic">, boolean>;
  model?: string;
  fallbackReason?: string;
  providers: ProviderAvailability[];
}

const LIVE_PROVIDER_ORDER: LiveAgentProviderName[] = [
  "openai",
  "anthropic",
  "deepseek",
  "qwen",
];

/**
 * Server-only model env. Never expose provider keys through NEXT_PUBLIC_*.
 */
export function resolveServerAgentProviderConfig(
  env: AgentProviderEnv = readAgentProviderEnv(),
  requestedOverride?: AgentProviderSelection,
): ServerAgentProviderConfig {
  const requested = requestedOverride ?? readProviderSelection(env.AGENT_TRADE_AGENT_PROVIDER);
  const liveCallsEnabled = env.AGENT_TRADE_ENABLE_LIVE_LLM === "true";
  const models = providerModels(env);
  const keys = {
    openai: Boolean(env.OPENAI_API_KEY),
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    deepseek: Boolean(env.DEEPSEEK_API_KEY),
    qwen: Boolean(env.QWEN_API_KEY),
  };
  const resolved = resolveProvider({ requested, liveCallsEnabled, keys });
  const isLiveModelEnabled = isLiveAgentProviderName(resolved) && liveCallsEnabled && keys[resolved];
  const model = isLiveAgentProviderName(resolved) ? models[resolved] : undefined;
  const providers = providerAvailability({ requested, resolved, liveCallsEnabled, keys, models });

  return {
    requested,
    resolved,
    isLiveModelEnabled,
    liveCallsEnabled,
    models,
    keys,
    model,
    fallbackReason: isLiveModelEnabled ? undefined : fallbackReason({ requested, resolved, liveCallsEnabled, keys }),
    providers,
  };
}

export function createServerAgentProvider(options: ServerAgentProviderOptions = {}): AgentProvider {
  const env = options.env ?? readAgentProviderEnv();
  const config = resolveServerAgentProviderConfig(env, options.requestedProvider);

  if (config.resolved === "deterministic") {
    if (config.requested === "deterministic" || config.requested === "auto") {
      return new DeterministicAgentService();
    }
    return new DeterministicFallbackProvider(
      config.requested,
      config.fallbackReason ?? "Model provider unavailable; using deterministic fallback.",
    );
  }

  if (config.resolved === "openai" && config.isLiveModelEnabled && env.OPENAI_API_KEY) {
    return new OpenAIAgentProvider({
      apiKey: env.OPENAI_API_KEY,
      model: config.models.openai,
      fetchImpl: options.fetchImpl,
    });
  }

  if (config.resolved === "anthropic" && config.isLiveModelEnabled && env.ANTHROPIC_API_KEY) {
    return new AnthropicAgentProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      model: config.models.anthropic,
      fetchImpl: options.fetchImpl,
    });
  }

  if (config.resolved === "deepseek" && config.isLiveModelEnabled && env.DEEPSEEK_API_KEY) {
    return new DeepSeekAgentProvider({
      apiKey: env.DEEPSEEK_API_KEY,
      model: config.models.deepseek,
      endpoint: env.DEEPSEEK_BASE_URL,
      fetchImpl: options.fetchImpl,
    });
  }

  if (config.resolved === "qwen" && config.isLiveModelEnabled && env.QWEN_API_KEY) {
    return new QwenAgentProvider({
      apiKey: env.QWEN_API_KEY,
      model: config.models.qwen,
      endpoint: env.QWEN_BASE_URL,
      fetchImpl: options.fetchImpl,
    });
  }

  return new DeterministicFallbackProvider(
    config.requested,
    config.fallbackReason ?? "Model provider unavailable; using deterministic fallback.",
  );
}

export function readAgentProviderEnv(): AgentProviderEnv {
  return {
    AGENT_TRADE_AGENT_PROVIDER: process.env.AGENT_TRADE_AGENT_PROVIDER,
    AGENT_TRADE_ENABLE_LIVE_LLM: process.env.AGENT_TRADE_ENABLE_LIVE_LLM,
    AGENT_TRADE_AGENT_MODEL: process.env.AGENT_TRADE_AGENT_MODEL,
    AGENT_TRADE_OPENAI_MODEL: process.env.AGENT_TRADE_OPENAI_MODEL,
    AGENT_TRADE_ANTHROPIC_MODEL: process.env.AGENT_TRADE_ANTHROPIC_MODEL,
    AGENT_TRADE_DEEPSEEK_MODEL: process.env.AGENT_TRADE_DEEPSEEK_MODEL,
    AGENT_TRADE_QWEN_MODEL: process.env.AGENT_TRADE_QWEN_MODEL,
    DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
    QWEN_BASE_URL: process.env.QWEN_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    QWEN_API_KEY: process.env.QWEN_API_KEY,
  };
}

function readProviderSelection(input: string | undefined): AgentProviderSelection {
  if (
    input === "auto" ||
    input === "openai" ||
    input === "anthropic" ||
    input === "deepseek" ||
    input === "qwen" ||
    input === "deterministic"
  ) {
    return input;
  }
  return "deterministic";
}

function resolveProvider(args: {
  requested: AgentProviderSelection;
  liveCallsEnabled: boolean;
  keys: ServerAgentProviderConfig["keys"];
}): AgentProviderName {
  if (args.requested === "deterministic") {
    return "deterministic";
  }
  if (!args.liveCallsEnabled) {
    return "deterministic";
  }
  if (args.requested === "auto") {
    return LIVE_PROVIDER_ORDER.find((provider) => args.keys[provider]) ?? "deterministic";
  }
  return args.keys[args.requested] ? args.requested : "deterministic";
}

function providerModels(env: AgentProviderEnv): ServerAgentProviderConfig["models"] {
  return {
    openai: env.AGENT_TRADE_OPENAI_MODEL ?? env.AGENT_TRADE_AGENT_MODEL ?? DEFAULT_OPENAI_AGENT_MODEL,
    anthropic: env.AGENT_TRADE_ANTHROPIC_MODEL ?? env.AGENT_TRADE_AGENT_MODEL ?? DEFAULT_ANTHROPIC_AGENT_MODEL,
    deepseek: env.AGENT_TRADE_DEEPSEEK_MODEL ?? env.AGENT_TRADE_AGENT_MODEL ?? DEFAULT_DEEPSEEK_AGENT_MODEL,
    qwen: env.AGENT_TRADE_QWEN_MODEL ?? env.AGENT_TRADE_AGENT_MODEL ?? DEFAULT_QWEN_AGENT_MODEL,
  };
}

function providerAvailability(args: {
  requested: AgentProviderSelection;
  resolved: AgentProviderName;
  liveCallsEnabled: boolean;
  keys: ServerAgentProviderConfig["keys"];
  models: ServerAgentProviderConfig["models"];
}): ProviderAvailability[] {
  const liveDisabledReason = "AGENT_TRADE_ENABLE_LIVE_LLM is not true.";
  return [
    {
      name: "auto",
      label: "Auto",
      available: true,
      configured: args.resolved !== "deterministic",
      model: args.resolved === "deterministic" || args.resolved === "openrouter" ? undefined : args.models[args.resolved],
      reason: args.resolved === "deterministic" ? "Auto will use deterministic fallback until a live provider is enabled and keyed." : undefined,
    },
    ...LIVE_PROVIDER_ORDER.map((name): ProviderAvailability => {
      const hasKey = args.keys[name];
      const available = args.liveCallsEnabled && hasKey;
      return {
        name,
        label: providerLabel(name),
        available,
        configured: hasKey,
        model: args.models[name],
        reason: available
          ? undefined
          : args.liveCallsEnabled
            ? `${providerLabel(name)} API key is not configured.`
            : liveDisabledReason,
      };
    }),
    {
      name: "deterministic",
      label: "Deterministic",
      available: true,
      configured: true,
      reason: "Local deterministic analysis; no external model call.",
    },
  ];
}

function fallbackReason(args: {
  requested: AgentProviderSelection;
  resolved: AgentProviderName;
  liveCallsEnabled: boolean;
  keys: ServerAgentProviderConfig["keys"];
}): string | undefined {
  if (args.requested === "deterministic") {
    return undefined;
  }
  if (args.requested === "auto" && args.resolved === "deterministic") {
    return "Auto provider selected deterministic fallback because no live provider is enabled and keyed.";
  }
  if (!args.liveCallsEnabled) {
    return `${providerLabel(args.requested)} provider requested but AGENT_TRADE_ENABLE_LIVE_LLM is not true; using deterministic fallback.`;
  }
  if (isLiveAgentProviderName(args.requested) && !args.keys[args.requested]) {
    return `${providerLabel(args.requested)} provider requested without ${providerKeyEnv(args.requested)}; using deterministic fallback.`;
  }
  return "Model provider unavailable; using deterministic fallback.";
}

function providerLabel(provider: AgentProviderSelection | AgentProviderName): string {
  if (provider === "auto") {
    return "Auto";
  }
  if (provider === "openai") {
    return "OpenAI";
  }
  if (provider === "anthropic") {
    return "Anthropic";
  }
  if (provider === "deepseek") {
    return "DeepSeek";
  }
  if (provider === "qwen") {
    return "Qwen";
  }
  if (provider === "deterministic") {
    return "Deterministic";
  }
  if (provider === "openrouter") {
    return "OpenRouter";
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

function providerKeyEnv(provider: LiveAgentProviderName): string {
  if (provider === "openai") {
    return "OPENAI_API_KEY";
  }
  if (provider === "anthropic") {
    return "ANTHROPIC_API_KEY";
  }
  if (provider === "deepseek") {
    return "DEEPSEEK_API_KEY";
  }
  if (provider === "qwen") {
    return "QWEN_API_KEY";
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

function isLiveAgentProviderName(input: AgentProviderName | AgentProviderSelection): input is LiveAgentProviderName {
  return input === "openai" || input === "anthropic" || input === "deepseek" || input === "qwen";
}

class DeterministicFallbackProvider implements AgentProvider {
  readonly name = "deterministic" as const;
  private readonly deterministic = new DeterministicAgentService();

  constructor(
    private readonly requestedProvider: AgentProviderSelection,
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
