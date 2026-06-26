import type { FastifyInstance, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";

import { ApiException } from "../errors.js";
import { eligibilityForRequest } from "../helpers/agentTradeSafety.js";
import { recordAuditEvent } from "../helpers/agentTradeAudit.js";
import {
  gaslessDepositRelayerStatus,
  gaslessDepositWalletAllowed,
  gaslessDepositStatus,
  validateAndRelayGaslessDeposit,
  type GaslessDepositPermitPayload,
} from "../helpers/gaslessHlDeposit.js";
import { verifyPrivyAuth } from "../helpers/privyAuth.js";

const DepositStatusQuerySchema = z.object({
  user: z.string().regex(/^0x[0-9a-fA-F]{40}$/u).optional(),
});

const DepositPermitSchema = z.object({
  owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  spender: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  amount: z.string().regex(/^[0-9]+$/u),
  deadline: z.number().int().positive(),
  signature: z.object({
    r: z.string().regex(/^0x[0-9a-fA-F]{64}$/u),
    s: z.string().regex(/^0x[0-9a-fA-F]{64}$/u),
    v: z.number().int().min(0).max(255),
  }),
});

const depositRateLimit = new Map<string, number[]>();

export function resetAgentTradeDepositRateLimitForTests(): void {
  depositRateLimit.clear();
}

export async function agentTradeDepositRoute(app: FastifyInstance): Promise<void> {
  app.get("/agent-trade/deposit/status", async (req, reply) => {
    let query: z.infer<typeof DepositStatusQuerySchema>;
    try {
      query = DepositStatusQuerySchema.parse(req.query);
    } catch (err) {
      throw validationError("Bad deposit status query", err);
    }

    const state = eligibilityForRequest(req, app.config);
    const status = gaslessDepositStatus(app.config);
    const relayer = await gaslessDepositRelayerStatus({ cfg: app.config });
    const allowlist = gaslessDepositWalletAllowed({
      cfg: app.config,
      wallet: query.user as `0x${string}` | undefined,
    });
    const enabled = status.enabled && relayer.ready && allowlist.allowed;
    const reason = (() => {
      if (!status.enabled) {
        return status.reason;
      }
      if (!relayer.ready) {
        return relayer.reason;
      }
      if (!allowlist.allowed) {
        return allowlist.reason;
      }
      return status.reason;
    })();
    return reply.send({
      ...status,
      enabled,
      reason,
      allowed: allowlist.allowed,
      relayerReady: relayer.ready,
      relayerMinBalanceWei: relayer.minBalanceWei,
      eligibilityState: state,
      liveEligible: state === "liveEligible",
      mainnetExecutionEnabled: app.config.AGENT_TRADE_MAINNET_EXECUTION_ENABLED,
      killSwitchEnabled: app.config.AGENT_TRADE_LIVE_TRADING_KILL_SWITCH,
      minOrderNotionalUsd: app.config.AGENT_TRADE_MIN_ORDER_NOTIONAL_USD,
      user: query.user ?? null,
    });
  });

  app.post("/agent-trade/deposit/permit", async (req, reply) => {
    assertDepositRateLimit(req);

    let body: z.infer<typeof DepositPermitSchema>;
    try {
      body = DepositPermitSchema.parse(req.body);
    } catch (err) {
      throw validationError("Bad deposit permit request", err);
    }

    const auth = await verifyPrivyAuth(req.headers.authorization, app.config);
    await recordAuditEvent({
      req,
      cfg: app.config,
      actorType: "wallet",
      actorId: auth.walletAddress.toLowerCase(),
      walletAddress: auth.walletAddress,
      route: "/agent-trade/deposit/permit",
      eventType: "agent_trade.deposit.requested",
      eligibilityState: eligibilityForRequest(req, app.config),
      payload: {
        owner: body.owner.toLowerCase(),
        token: body.token.toLowerCase(),
        spender: body.spender.toLowerCase(),
        amount: body.amount,
        deadline: body.deadline,
      },
    });

    try {
      const result = await validateAndRelayGaslessDeposit({
        cfg: app.config,
        req,
        authWallet: auth.walletAddress,
        payload: body as GaslessDepositPermitPayload,
      });
      await recordAuditEvent({
        req,
        cfg: app.config,
        actorType: "wallet",
        actorId: auth.walletAddress.toLowerCase(),
        walletAddress: auth.walletAddress,
        route: "/agent-trade/deposit/permit",
        eventType: "agent_trade.deposit.submitted",
        eligibilityState: "liveEligible",
        payload: {
          owner: result.owner.toLowerCase(),
          amount: result.amount,
          txHash: result.txHash,
        },
      });
      return reply.send({
        status: "submitted",
        txHash: result.txHash,
        owner: result.owner,
        amount: result.amount,
      });
    } catch (err) {
      await recordAuditEvent({
        req,
        cfg: app.config,
        actorType: "wallet",
        actorId: auth.walletAddress.toLowerCase(),
        walletAddress: auth.walletAddress,
        route: "/agent-trade/deposit/permit",
        eventType: "agent_trade.deposit.failed",
        severity: "warn",
        eligibilityState: eligibilityForRequest(req, app.config),
        payload: {
          owner: body.owner.toLowerCase(),
          amount: body.amount,
          error: safeDepositFailureMessage(err),
        },
      });
      throw err;
    }
  });
}

function safeDepositFailureMessage(err: unknown): string {
  if (err instanceof ApiException) {
    return err.message;
  }
  return "Gasless deposit relay failed before submission.";
}

function validationError(prefix: string, err: unknown): ApiException {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return new ApiException(
      "INVALID_PARAMS",
      `${prefix}: ${first?.path.join(".") ?? "(root)"} ${first?.message ?? "validation failed"}`,
      "Use the Agent.trade onboarding permit builder and do not edit token, spender, amount, or signature fields.",
    );
  }
  if (err instanceof Error) {
    return new ApiException("INVALID_PARAMS", `${prefix}: ${err.message}`, "Retry with a valid request.");
  }
  return new ApiException("INVALID_PARAMS", prefix, "Retry with a valid request.");
}

function assertDepositRateLimit(req: FastifyRequest): void {
  const now = Date.now();
  const key = req.ip;
  const recent = (depositRateLimit.get(key) ?? []).filter((timestamp) => now - timestamp < 60_000);
  if (recent.length >= 3) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Too many deposit attempts.",
      "Wait a minute before retrying the gasless deposit relayer.",
    );
  }
  recent.push(now);
  depositRateLimit.set(key, recent);
}
