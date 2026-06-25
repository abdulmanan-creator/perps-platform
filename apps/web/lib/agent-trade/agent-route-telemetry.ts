import type { AgentProviderName, AgentResponseType } from "./agent-provider";

export interface AgentRouteTelemetryEvent {
  route: "agent_analysis";
  provider: AgentProviderName;
  model?: string;
  symbol?: string;
  source?: string;
  responseType?: AgentResponseType;
  latencyMs: number;
  fallbackReason?: string;
  invalidOutput?: boolean;
  timeout?: boolean;
  rateLimited?: boolean;
  authRejected?: boolean;
}

export type AgentRouteTelemetryLogger = (event: AgentRouteTelemetryEvent) => void;

export function logAgentRouteTelemetry(event: AgentRouteTelemetryEvent): void {
  if (process.env.NODE_ENV === "test") {
    return;
  }
  console.info("agent_trade_agent_analysis", compactTelemetry(event));
}

function compactTelemetry(event: AgentRouteTelemetryEvent): AgentRouteTelemetryEvent {
  return {
    route: event.route,
    provider: event.provider,
    model: event.model,
    symbol: event.symbol,
    source: event.source,
    responseType: event.responseType,
    latencyMs: event.latencyMs,
    fallbackReason: event.fallbackReason,
    invalidOutput: event.invalidOutput || undefined,
    timeout: event.timeout || undefined,
    rateLimited: event.rateLimited || undefined,
    authRejected: event.authRejected || undefined,
  };
}
