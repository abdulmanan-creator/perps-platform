export interface AgentRouteRateLimitEnv {
  AGENT_TRADE_AGENT_RATE_LIMIT_MAX?: string;
  AGENT_TRADE_AGENT_RATE_LIMIT_WINDOW_MS?: string;
}

export interface AgentRouteRateLimitDecision {
  allowed: boolean;
  key: string;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export interface AgentRouteRateLimiter {
  check(args: { key: string; now?: number }): AgentRouteRateLimitDecision;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export class InMemoryAgentRouteRateLimiter implements AgentRouteRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(args: { env?: AgentRouteRateLimitEnv; limit?: number; windowMs?: number } = {}) {
    this.limit = args.limit ?? positiveInt(args.env?.AGENT_TRADE_AGENT_RATE_LIMIT_MAX, 12);
    this.windowMs = args.windowMs ?? positiveInt(args.env?.AGENT_TRADE_AGENT_RATE_LIMIT_WINDOW_MS, 60_000);
  }

  check(args: { key: string; now?: number }): AgentRouteRateLimitDecision {
    const now = args.now ?? Date.now();
    const existing = this.buckets.get(args.key);
    const bucket = existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + this.windowMs };

    bucket.count += 1;
    this.buckets.set(args.key, bucket);

    const remaining = Math.max(0, this.limit - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return {
      allowed: bucket.count <= this.limit,
      key: args.key,
      limit: this.limit,
      remaining,
      resetAt: bucket.resetAt,
      retryAfterSeconds,
    };
  }
}

export const agentAnalysisRateLimiter = new InMemoryAgentRouteRateLimiter({
  env: readAgentRouteRateLimitEnv(),
});

function positiveInt(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }
  const parsed = Number(input);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readAgentRouteRateLimitEnv(): AgentRouteRateLimitEnv {
  return {
    AGENT_TRADE_AGENT_RATE_LIMIT_MAX: process.env.AGENT_TRADE_AGENT_RATE_LIMIT_MAX,
    AGENT_TRADE_AGENT_RATE_LIMIT_WINDOW_MS: process.env.AGENT_TRADE_AGENT_RATE_LIMIT_WINDOW_MS,
  };
}
