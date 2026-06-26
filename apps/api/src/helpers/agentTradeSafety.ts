import type { FastifyRequest } from "fastify";
import type { Action } from "@alchemy-hl/shared";

import type { Config } from "../config.js";
import { ApiException } from "../errors.js";
import { geoDecision, resolveCountry } from "./geo.js";
import { TtlCache } from "./ttlCache.js";

interface DailyUsage {
  notionalUsd: number;
}

const dailyUsage = new TtlCache<DailyUsage>({
  ttlMs: 24 * 60 * 60_000,
  maxEntries: 50_000,
});

export type EligibilityState =
  | "liveEligible"
  | "restricted"
  | "unknown"
  | "paper"
  | "killSwitchDisabled";

export function eligibilityForRequest(req: FastifyRequest, cfg: Config): EligibilityState {
  if (cfg.AGENT_TRADE_LIVE_TRADING_KILL_SWITCH) {
    return "killSwitchDisabled";
  }

  const country = resolveCountry(req, cfg);
  if (country === "T1" || country === "XX") {
    return "unknown";
  }
  if (country !== null && cfg.restrictedCountries.has(country)) {
    return "restricted";
  }
  if (cfg.AGENT_TRADE_REQUIRE_GEO_ELIGIBILITY && country === null) {
    return "unknown";
  }

  const decision = geoDecision(req, cfg);
  if (!decision.allowed && decision.reason === "restricted") {
    return "restricted";
  }
  if (!decision.allowed) {
    return "unknown";
  }
  if (cfg.GEO_BLOCK_ENABLED && decision.country == null) {
    return "unknown";
  }

  return "liveEligible";
}

export function actionNotionalUsd(action: Action): number {
  if (action.type !== "order") {
    return 0;
  }

  return action.orders.reduce((sum, order) => {
    const price = Number(order.p);
    const size = Number(order.s);
    if (!Number.isFinite(price) || !Number.isFinite(size)) {
      return sum;
    }
    return sum + Math.abs(price * size);
  }, 0);
}

export function isAgentTradeGuardedAction(action: Action): boolean {
  return (
    action.type === "order" ||
    action.type === "updateLeverage" ||
    action.type === "approveAgent" ||
    action.type === "approveBuilderFee"
  );
}

export function assertAgentTradeExchangeAllowed(args: {
  req: FastifyRequest;
  cfg: Config;
  action: Action;
  user?: `0x${string}`;
  riskAckGuidance?: string;
  minOrderNotionalUsd?: number;
  minOrderMessage?: string;
  minOrderGuidance?: string;
}): void {
  if (!isAgentTradeGuardedAction(args.action)) {
    return;
  }

  const state = eligibilityForRequest(args.req, args.cfg);
  if (state === "killSwitchDisabled") {
    throw new ApiException(
      "REGION_BLOCKED",
      "Live trading is disabled by the global Agent.trade kill switch.",
      "Switch to paper mode. Internal operators must clear AGENT_TRADE_LIVE_TRADING_KILL_SWITCH before live orders can resume.",
    );
  }
  if (state === "restricted") {
    throw new ApiException(
      "REGION_BLOCKED",
      "This user is not eligible for live trading.",
      "Restricted jurisdictions cannot submit live orders. Use paper mode instead.",
    );
  }
  if (state === "unknown") {
    throw new ApiException(
      "REGION_BLOCKED",
      "Live trading eligibility is unknown.",
      "The server could not verify an allowed jurisdiction. Unknown eligibility does not default to live trading; use paper mode or route through the configured edge.",
    );
  }

  if (args.cfg.AGENT_TRADE_REQUIRE_RISK_ACK) {
    const riskAck = args.req.headers["x-agent-trade-risk-accepted"];
    const termsAck = args.req.headers["x-agent-trade-terms-accepted"];
    if (riskAck !== "true" || termsAck !== "true") {
      throw new ApiException(
        "INVALID_PARAMS",
        "Live orders require explicit risk and terms acknowledgement.",
        args.riskAckGuidance ??
          "Send x-agent-trade-risk-accepted:true and x-agent-trade-terms-accepted:true only after the user confirms the leveraged-perp modal.",
      );
    }
  }

  if (!args.cfg.isTestnet) {
    if (!args.cfg.AGENT_TRADE_MAINNET_EXECUTION_ENABLED) {
      throw new ApiException(
        "REGION_BLOCKED",
        "Mainnet order execution is disabled for Agent.trade.",
        "Use Hyperliquid testnet for MVP execution, or enable mainnet only with Agent.trade eligibility, acknowledgement, and kill-switch controls active.",
      );
    }
  }

  if (args.action.type !== "order") {
    return;
  }

  const notionalUsd = actionNotionalUsd(args.action);
  const minOrderNotionalUsd =
    args.minOrderNotionalUsd ?? args.cfg.AGENT_TRADE_MIN_ORDER_NOTIONAL_USD;
  if (notionalUsd < minOrderNotionalUsd) {
    throw new ApiException(
      "INVALID_PARAMS",
      args.minOrderMessage ?? "Order is below Hyperliquid's minimum trade size.",
      args.minOrderGuidance ?? `Increase order notional to at least ${minOrderNotionalUsd} USD.`,
    );
  }

  if (
    args.cfg.AGENT_TRADE_ORDER_NOTIONAL_CAP_USD > 0 &&
    notionalUsd > args.cfg.AGENT_TRADE_ORDER_NOTIONAL_CAP_USD
  ) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Order exceeds the Agent.trade per-order notional cap.",
      `Reduce order size below ${args.cfg.AGENT_TRADE_ORDER_NOTIONAL_CAP_USD} USD, or disable the optional product safety throttle by setting AGENT_TRADE_ORDER_NOTIONAL_CAP_USD=0.`,
    );
  }

  const usageKey = args.user?.toLowerCase() ?? args.req.ip;
  const used = dailyUsage.get(usageKey)?.notionalUsd ?? 0;
  if (
    args.cfg.AGENT_TRADE_DAILY_NOTIONAL_CAP_USD > 0 &&
    used + notionalUsd > args.cfg.AGENT_TRADE_DAILY_NOTIONAL_CAP_USD
  ) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Order exceeds the Agent.trade daily notional cap.",
      `This account/session has used ${used.toFixed(2)} USD today. The optional product safety throttle is ${args.cfg.AGENT_TRADE_DAILY_NOTIONAL_CAP_USD} USD.`,
    );
  }
}

export function recordAgentTradeNotional(args: {
  req: FastifyRequest;
  action: Action;
  user?: `0x${string}`;
}): void {
  const notionalUsd = actionNotionalUsd(args.action);
  if (notionalUsd <= 0) {
    return;
  }

  const usageKey = args.user?.toLowerCase() ?? args.req.ip;
  const used = dailyUsage.get(usageKey)?.notionalUsd ?? 0;
  dailyUsage.set(usageKey, { notionalUsd: used + notionalUsd });
}

export function resetAgentTradeNotionalForTests(): void {
  dailyUsage.clear();
}
