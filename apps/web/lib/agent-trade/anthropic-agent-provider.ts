import { AGENT_ANALYSIS_JSON_SCHEMA, buildAgentPrompt } from "./agent-prompt";
import type { AgentAnalysis, AgentInput, AgentProvider } from "./agent-provider";
import { invalidAgentOutputRefusal, parseAgentAnalysis } from "./agent-validation";

export const DEFAULT_ANTHROPIC_AGENT_MODEL = "claude-3-5-haiku-latest";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_ANTHROPIC_TIMEOUT_MS = 12_000;

export type AnthropicAgentFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface AnthropicAgentProviderOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: AnthropicAgentFetch;
}

export class AnthropicAgentProvider implements AgentProvider {
  readonly name = "anthropic" as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: AnthropicAgentFetch;

  constructor(options: AnthropicAgentProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_ANTHROPIC_AGENT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ANTHROPIC_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async analyzeMarket(input: AgentInput): Promise<AgentAnalysis> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1_800,
          temperature: 0.2,
          system:
            "You are Agent.trade. Return only JSON that matches the provided schema. Drafts are proposals only and never executed.",
          messages: [
            {
              role: "user",
              content: buildAgentPrompt(input),
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        safeLogProviderWarning(input, `Anthropic HTTP ${response.status}`);
        return this.refusal(input, `Anthropic provider returned HTTP ${response.status}.`, startedAt);
      }

      const content = extractAnthropicText(await response.json());
      if (!content) {
        safeLogProviderWarning(input, "Anthropic response missing content");
        return this.refusal(input, "Anthropic provider returned no JSON content.", startedAt);
      }

      const parsed = parseAgentAnalysis(parseJson(content));
      if (!parsed) {
        safeLogProviderWarning(input, "Anthropic response failed AgentAnalysis validation");
        return this.refusal(input, "Anthropic provider returned malformed AgentAnalysis JSON.", startedAt);
      }

      return {
        ...parsed,
        provider: {
          ...parsed.provider,
          name: "anthropic",
          model: this.model,
          deterministic: false,
          generatedAt: Date.now(),
          latencyMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError"
        ? `Anthropic provider timed out after ${this.timeoutMs}ms.`
        : "Anthropic provider failed before returning validated output.";
      safeLogProviderWarning(input, reason);
      return this.refusal(input, reason, startedAt);
    } finally {
      clearTimeout(timeout);
    }
  }

  private refusal(input: AgentInput, reason: string, startedAt: number): AgentAnalysis {
    const analysis = invalidAgentOutputRefusal(input, reason);
    return {
      ...analysis,
      provider: {
        name: "anthropic",
        model: this.model,
        deterministic: false,
        generatedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        fallbackReason: reason,
      },
    };
  }
}

function extractAnthropicText(response: unknown): string | undefined {
  if (!isRecord(response) || !Array.isArray(response.content)) {
    return undefined;
  }
  const texts = response.content
    .map((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : undefined)
    .filter((text): text is string => Boolean(text));
  return texts.join("").trim() || undefined;
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

function safeLogProviderWarning(input: AgentInput, message: string) {
  if (process.env.NODE_ENV === "test") {
    return;
  }
  console.warn("Agent.trade Anthropic provider warning", {
    provider: "anthropic",
    symbol: input.market.symbol,
    source: input.market.source,
    message,
  });
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}
