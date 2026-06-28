import { AGENT_ANALYSIS_JSON_SCHEMA, buildAgentPrompt } from "./agent-prompt";
import type { AgentAnalysis, AgentInput, AgentProvider, AgentProviderName } from "./agent-provider";
import {
  invalidAgentOutputRefusal,
  normalizeModelAgentAnalysisOutput,
  parseAgentAnalysisWithDiagnostics,
} from "./agent-validation";

export const DEFAULT_OPENAI_AGENT_MODEL = "gpt-4.1-mini";
export const DEFAULT_DEEPSEEK_AGENT_MODEL = "deepseek-chat";
export const DEFAULT_QWEN_AGENT_MODEL = "qwen-plus";
const DEFAULT_OPENAI_TIMEOUT_MS = 12_000;
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const QWEN_CHAT_COMPLETIONS_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";

export type AgentFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ChatCompletionAgentProviderOptions {
  providerName: Extract<AgentProviderName, "openai" | "deepseek" | "qwen">;
  apiKey: string;
  model: string;
  endpoint: string;
  responseFormat: "json_schema" | "json_object";
  timeoutMs?: number;
  fetchImpl?: AgentFetch;
}

export interface OpenAIAgentProviderOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: AgentFetch;
}

export interface DeepSeekAgentProviderOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: AgentFetch;
}

export interface QwenAgentProviderOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: AgentFetch;
}

export class ChatCompletionAgentProvider implements AgentProvider {
  readonly name: Extract<AgentProviderName, "openai" | "deepseek" | "qwen">;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly responseFormat: ChatCompletionAgentProviderOptions["responseFormat"];
  private readonly timeoutMs: number;
  private readonly fetchImpl: AgentFetch;
  private readonly apiKey: string;

  constructor(options: ChatCompletionAgentProviderOptions) {
    this.name = options.providerName;
    this.model = options.model;
    this.endpoint = options.endpoint;
    this.responseFormat = options.responseFormat;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey;
  }

  async analyzeMarket(input: AgentInput): Promise<AgentAnalysis> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content:
                "You are Agent.trade. Return only JSON that matches the provided schema. Drafts are proposals only and never executed.",
            },
            {
              role: "user",
              content: buildAgentPrompt(input),
            },
          ],
          temperature: 0.2,
          response_format: this.buildResponseFormat(),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        safeLogProviderWarning({ providerName: this.name, input, message: `${providerDisplayName(this.name)} HTTP ${response.status}` });
        return this.refusal(input, `${providerDisplayName(this.name)} provider returned HTTP ${response.status}.`, startedAt);
      }

      const content = extractChatCompletionContent(await response.json());
      if (!content) {
        safeLogProviderWarning({ providerName: this.name, input, message: `${providerDisplayName(this.name)} response missing content` });
        return this.refusal(input, `${providerDisplayName(this.name)} provider returned no JSON content.`, startedAt);
      }

      const generatedAt = Date.now();
      const normalized = normalizeModelAgentAnalysisOutput({
        output: parseJson(content),
        providerName: this.name,
        model: this.model,
        generatedAt,
      });
      const parsed = parseAgentAnalysisWithDiagnostics(normalized, { input });
      if (!parsed.ok) {
        safeLogProviderWarning({
          providerName: this.name,
          input,
          message: `${providerDisplayName(this.name)} response failed AgentAnalysis validation`,
          diagnostic: parsed.code,
        });
        return this.refusal(
          input,
          `${providerDisplayName(this.name)} provider returned malformed AgentAnalysis JSON (${parsed.code}).`,
          startedAt,
        );
      }

      return {
        ...parsed.analysis,
        provider: {
          ...parsed.analysis.provider,
          name: this.name,
          model: this.model,
          deterministic: false,
          generatedAt,
          latencyMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError"
        ? `${providerDisplayName(this.name)} provider timed out after ${this.timeoutMs}ms.`
        : `${providerDisplayName(this.name)} provider failed before returning validated output.`;
      safeLogProviderWarning({ providerName: this.name, input, message: reason });
      return this.refusal(input, reason, startedAt);
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildResponseFormat() {
    if (this.responseFormat === "json_schema") {
      return {
        type: "json_schema",
        json_schema: {
          name: "agent_trade_analysis",
          schema: AGENT_ANALYSIS_JSON_SCHEMA,
          strict: false,
        },
      };
    }
    if (this.responseFormat === "json_object") {
      return { type: "json_object" };
    }
    throw new Error(`Unsupported response format: ${this.responseFormat}`);
  }

  private refusal(input: AgentInput, reason: string, startedAt: number): AgentAnalysis {
    const analysis = invalidAgentOutputRefusal(input, reason);
    return {
      ...analysis,
      provider: {
        name: this.name,
        model: this.model,
        deterministic: false,
        generatedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        fallbackReason: reason,
      },
    };
  }
}

export class OpenAIAgentProvider extends ChatCompletionAgentProvider {
  constructor(options: OpenAIAgentProviderOptions) {
    super({
      providerName: "openai",
      apiKey: options.apiKey,
      model: options.model ?? DEFAULT_OPENAI_AGENT_MODEL,
      endpoint: OPENAI_CHAT_COMPLETIONS_URL,
      responseFormat: "json_schema",
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  }
}

export class DeepSeekAgentProvider extends ChatCompletionAgentProvider {
  constructor(options: DeepSeekAgentProviderOptions) {
    super({
      providerName: "deepseek",
      apiKey: options.apiKey,
      model: options.model ?? DEFAULT_DEEPSEEK_AGENT_MODEL,
      endpoint: options.endpoint ?? DEEPSEEK_CHAT_COMPLETIONS_URL,
      responseFormat: "json_object",
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  }
}

export class QwenAgentProvider extends ChatCompletionAgentProvider {
  constructor(options: QwenAgentProviderOptions) {
    super({
      providerName: "qwen",
      apiKey: options.apiKey,
      model: options.model ?? DEFAULT_QWEN_AGENT_MODEL,
      endpoint: options.endpoint ?? QWEN_CHAT_COMPLETIONS_URL,
      responseFormat: "json_object",
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  }
}

function extractChatCompletionContent(response: unknown): string | undefined {
  if (!isRecord(response) || !Array.isArray(response.choices)) {
    return undefined;
  }
  const firstChoice = response.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    return undefined;
  }
  return typeof firstChoice.message.content === "string" ? firstChoice.message.content : undefined;
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

function safeLogProviderWarning(args: {
  providerName: Extract<AgentProviderName, "openai" | "deepseek" | "qwen">;
  input: AgentInput;
  message: string;
  diagnostic?: string;
}) {
  if (process.env.NODE_ENV === "test") {
    return;
  }
  console.warn(`Agent.trade ${providerDisplayName(args.providerName)} provider warning`, {
    provider: args.providerName,
    symbol: args.input.market.symbol,
    source: args.input.market.source,
    message: args.message,
    diagnostic: args.diagnostic,
  });
}

function providerDisplayName(providerName: AgentProviderName): string {
  if (providerName === "openai") {
    return "OpenAI";
  }
  if (providerName === "deepseek") {
    return "DeepSeek";
  }
  if (providerName === "qwen") {
    return "Qwen";
  }
  if (providerName === "anthropic") {
    return "Anthropic";
  }
  if (providerName === "deterministic") {
    return "Deterministic";
  }
  if (providerName === "openrouter") {
    return "OpenRouter";
  }
  throw new Error(`Unsupported provider: ${providerName}`);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}
