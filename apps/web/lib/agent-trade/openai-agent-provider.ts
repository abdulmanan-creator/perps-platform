import { AGENT_ANALYSIS_JSON_SCHEMA, buildAgentPrompt } from "./agent-prompt";
import type { AgentAnalysis, AgentInput, AgentProvider } from "./agent-provider";
import { invalidAgentOutputRefusal, parseAgentAnalysis } from "./agent-validation";

export const DEFAULT_OPENAI_AGENT_MODEL = "gpt-4.1-mini";
const DEFAULT_OPENAI_TIMEOUT_MS = 12_000;
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

export type AgentFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenAIAgentProviderOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: AgentFetch;
}

export class OpenAIAgentProvider implements AgentProvider {
  readonly name = "openai" as const;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: AgentFetch;

  constructor(options: OpenAIAgentProviderOptions) {
    this.model = options.model ?? DEFAULT_OPENAI_AGENT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey;
  }

  private readonly apiKey: string;

  async analyzeMarket(input: AgentInput): Promise<AgentAnalysis> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
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
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "agent_trade_analysis",
              schema: AGENT_ANALYSIS_JSON_SCHEMA,
              strict: false,
            },
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        safeLogProviderWarning(input, `OpenAI HTTP ${response.status}`);
        return this.refusal(input, `OpenAI provider returned HTTP ${response.status}.`);
      }

      const content = extractChatCompletionContent(await response.json());
      if (!content) {
        safeLogProviderWarning(input, "OpenAI response missing content");
        return this.refusal(input, "OpenAI provider returned no JSON content.");
      }

      const decoded = parseJson(content);
      const parsed = parseAgentAnalysis(decoded);
      if (!parsed) {
        safeLogProviderWarning(input, "OpenAI response failed AgentAnalysis validation");
        return this.refusal(input, "OpenAI provider returned malformed AgentAnalysis JSON.");
      }

      return {
        ...parsed,
        provider: {
          ...parsed.provider,
          name: "openai",
          model: this.model,
          deterministic: false,
          generatedAt: Date.now(),
        },
      };
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError"
        ? `OpenAI provider timed out after ${this.timeoutMs}ms.`
        : "OpenAI provider failed before returning validated output.";
      safeLogProviderWarning(input, reason);
      return this.refusal(input, reason);
    } finally {
      clearTimeout(timeout);
    }
  }

  private refusal(input: AgentInput, reason: string): AgentAnalysis {
    const analysis = invalidAgentOutputRefusal(input, reason);
    return {
      ...analysis,
      provider: {
        name: "openai",
        model: this.model,
        deterministic: false,
        generatedAt: Date.now(),
        fallbackReason: reason,
      },
    };
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

function safeLogProviderWarning(input: AgentInput, message: string) {
  if (process.env.NODE_ENV === "test") {
    return;
  }
  console.warn("Agent.trade OpenAI provider warning", {
    provider: "openai",
    symbol: input.market.symbol,
    source: input.market.source,
    message,
  });
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}
