import type { FastifyInstance, FastifyRequest } from "fastify";

import type {
  PredictionLiveOrderRequest,
  PredictionOutcome,
  PredictionOutcomeSide,
} from "@alchemy-hl/shared";

import type { Config } from "../config.js";
import { ApiException } from "../errors.js";
import {
  assertAgentTradeExchangeAllowed,
  recordAgentTradeNotional,
} from "../helpers/agentTradeSafety.js";
import {
  recordAuditEvent,
  recordExchangeResponse,
  recordExchangeSubmission,
} from "../helpers/agentTradeAudit.js";
import { HlClient } from "../helpers/hlClient.js";
import { hip4PredictionTechnicalDetails } from "../helpers/predictionHip4.js";
import { TtlCache, cachedAsync } from "../helpers/ttlCache.js";
import { registerExchangeEndpoint } from "./exchange.js";
import { fetchPredictionMeta, findQuestion, type PredictionMeta } from "./prediction.js";
import {
  assertPredictionSpotBalanceSufficient,
  fetchPredictionBalanceState,
} from "./predictionBalance.js";
import type { ExchangeBody } from "../schemas.js";

const ROUTE = "/prediction/exchange";
const PREDICTION_ACK_GUIDANCE =
  "Send x-agent-trade-risk-accepted:true and x-agent-trade-terms-accepted:true only after the user confirms the live prediction-market order.";

export async function predictionExchangeRoute(app: FastifyInstance): Promise<void> {
  const hl = new HlClient({
    baseUrl: app.config.HYPERLIQUID_API_URL,
    logger: { warn: app.log.warn.bind(app.log) },
  });
  const metaCache = new TtlCache<Promise<PredictionMeta>>({ ttlMs: 60_000, maxEntries: 4 });

  async function validate(req: FastifyRequest, body: ExchangeBody): Promise<PredictionValidation> {
    const meta = await cachedAsync(metaCache, "prediction-meta", () => fetchPredictionMeta(hl));
    return validatePredictionLiveExchange({
      cfg: app.config,
      req,
      body,
      meta,
    });
  }

  await registerExchangeEndpoint(app, {
    path: ROUTE,
    metricRoute: ROUTE,
    hooks: {
      beforeBuild: async ({ req, body, nonce }) => {
        const validated = await validate(req, body);
        assertAgentTradeExchangeAllowed({
          req,
          cfg: app.config,
          action: body.action,
          user: body.user,
          riskAckGuidance: PREDICTION_ACK_GUIDANCE,
          minOrderNotionalUsd: app.config.AGENT_TRADE_HIP4_MIN_ORDER_COST_USD,
          minOrderMessage: predictionMinCostMessage(app.config),
          minOrderGuidance: predictionMinCostGuidance(app.config),
        });
        await assertPredictionBalanceReady({
          hl,
          req,
          user: body.user,
          validated,
          phase: "build",
        });
        await recordExchangeSubmission({
          req,
          cfg: app.config,
          phase: "build",
          route: ROUTE,
          status: "started",
          action: body.action,
          user: body.user,
          nonce,
          redactedPayload: validationPayload(validated),
        });
        await recordAuditEvent({
          req,
          cfg: app.config,
          actorType: "wallet",
          actorId: body.user?.toLowerCase() ?? null,
          walletAddress: body.user,
          route: ROUTE,
          eventType: "prediction.exchange.build_started",
          payload: validationPayload(validated),
        });
      },
      afterBuild: async ({ req, body, response }) => {
        await recordExchangeSubmission({
          req,
          cfg: app.config,
          phase: "build",
          route: ROUTE,
          status: "built",
          action: body.action,
          user: body.user,
          nonce: response.nonce,
          builderFeeBps: response.builderFee,
          redactedPayload: {
            hash: response.hash,
            nonce: response.nonce,
            builder: response.builder,
            builderFee: response.builderFee,
            isSpot: response.isSpot,
            prediction: body.prediction ?? null,
          },
        });
      },
      onBuildError: async ({ req, body, error, nonce }) => {
        await recordExchangeSubmission({
          req,
          cfg: app.config,
          phase: "build",
          route: ROUTE,
          status: "failed",
          action: body.action,
          user: body.user,
          nonce,
          error,
        });
      },
      beforeSend: async ({ req, body, signer, builderFeeBps }) => {
        const validated = await validate(req, body);
        assertAgentTradeExchangeAllowed({
          req,
          cfg: app.config,
          action: body.action,
          user: signer,
          riskAckGuidance: PREDICTION_ACK_GUIDANCE,
          minOrderNotionalUsd: app.config.AGENT_TRADE_HIP4_MIN_ORDER_COST_USD,
          minOrderMessage: predictionMinCostMessage(app.config),
          minOrderGuidance: predictionMinCostGuidance(app.config),
        });
        await assertPredictionBalanceReady({
          hl,
          req,
          user: signer,
          validated,
          phase: "send",
        });
        await recordExchangeSubmission({
          req,
          cfg: app.config,
          phase: "send",
          route: ROUTE,
          status: "started",
          action: body.action,
          signer,
          nonce: body.nonce,
          signature: body.signature,
          builderFeeBps,
          redactedPayload: validationPayload(validated),
        });
        await recordAuditEvent({
          req,
          cfg: app.config,
          actorType: "wallet",
          actorId: signer.toLowerCase(),
          walletAddress: signer,
          route: ROUTE,
          eventType: "prediction.exchange.send_started",
          payload: validationPayload(validated),
        });
      },
      afterSend: async ({ req, body, signer, exchangeResponse, latencyMs, builderFeeBps }) => {
        const submissionId = await recordExchangeSubmission({
          req,
          cfg: app.config,
          phase: "send",
          route: ROUTE,
          status: "forwarded",
          action: body.action,
          signer,
          nonce: body.nonce,
          signature: body.signature,
          builderFeeBps,
          redactedPayload: { prediction: body.prediction ?? null },
        });
        await recordExchangeResponse({
          req,
          cfg: app.config,
          exchangeSubmissionId: submissionId,
          walletAddress: signer,
          success: true,
          responsePayload: exchangeResponse,
          latencyMs,
        });
        await recordAuditEvent({
          req,
          cfg: app.config,
          actorType: "wallet",
          actorId: signer.toLowerCase(),
          walletAddress: signer,
          route: ROUTE,
          eventType: "prediction.exchange.send_forwarded",
          payload: { actionType: body.action.type, nonce: body.nonce, latencyMs, prediction: body.prediction ?? null },
        });
        recordAgentTradeNotional({ req, action: body.action, user: signer });
      },
      onSendError: async ({ req, body, signer, error, builderFeeBps }) => {
        const submissionId = await recordExchangeSubmission({
          req,
          cfg: app.config,
          phase: "send",
          route: ROUTE,
          status: "failed",
          action: body.action,
          signer,
          nonce: body.nonce,
          signature: body.signature,
          error,
          builderFeeBps,
        });
        if (signer) {
          await recordExchangeResponse({
            req,
            cfg: app.config,
            exchangeSubmissionId: submissionId,
            walletAddress: signer,
            success: false,
            error,
          });
        }
      },
    },
  });
}

export function validatePredictionLiveExchange(args: {
  cfg: Config;
  req: FastifyRequest;
  body: ExchangeBody;
  meta: PredictionMeta;
}): PredictionValidation {
  if (!args.cfg.AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING) {
    throw new ApiException(
      "REGION_BLOCKED",
      "Live HIP-4 prediction trading is disabled.",
      "Set AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING=true only after review and deployment approval.",
    );
  }

  const prediction = args.body.prediction as PredictionLiveOrderRequest | undefined;
  if (!prediction) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Prediction live orders require prediction context.",
      "Send prediction { questionId, outcome, side, action, contracts, limitProbability, tif, criteriaAcknowledged, liveAcknowledged } with the exchange action.",
    );
  }

  if (!prediction.criteriaAcknowledged || !prediction.liveAcknowledged) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Live prediction orders require explicit criteria and live-order acknowledgement.",
      "Require the user to confirm resolution criteria and live Hyperliquid prediction order submission before building the payload.",
    );
  }

  if (!args.body.signature && !args.body.user) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Live prediction order builds require the wallet address.",
      "Send user=0x... so Agent.trade can verify HIP-4 spot-style spendable balance before wallet signing.",
    );
  }

  if (prediction.action !== "buy") {
    throw new ApiException(
      "INVALID_PARAMS",
      "Live HIP-4 selling is disabled for this spike.",
      "HIP4-C only allows buy orders until exit-only position checks are implemented.",
    );
  }

  if (!Number.isInteger(prediction.contracts) || prediction.contracts <= 0) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Prediction contract size must be a positive whole number.",
      "Use whole contract counts for HIP-4 outcome assets.",
    );
  }

  if (!Number.isFinite(prediction.limitProbability) || prediction.limitProbability <= 0 || prediction.limitProbability >= 1) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Prediction limit probability must be greater than 0 and less than 1.",
      "Use probability prices in the open interval (0, 1).",
    );
  }

  const question = findQuestion(args.meta, prediction.questionId);
  const outcome = [
    ...(question.fallbackOutcome ? [question.fallbackOutcome] : []),
    ...question.namedOutcomes,
  ].find((item) => item.outcome === prediction.outcome);
  if (!outcome) {
    throw new ApiException(
      "INVALID_PARAMS",
      `Outcome ${prediction.outcome} does not belong to prediction question ${prediction.questionId}.`,
      "Use an outcome returned by GET /prediction/questions/:questionId.",
    );
  }

  const side = outcome.sides[prediction.side];
  if (!side) {
    throw new ApiException(
      "INVALID_PARAMS",
      `Invalid prediction side ${prediction.side}.`,
      "HIP-4 outcome side must be 0 or 1.",
    );
  }

  const technical = hip4PredictionTechnicalDetails(outcome.outcome, side.side, outcome.quoteToken);
  if (
    side.encoding !== technical.encoding ||
    side.coin !== technical.coin ||
    side.assetId !== technical.assetId
  ) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Prediction outcome metadata does not match HIP-4 asset encoding.",
      `Expected encoding ${technical.encoding}, coin ${technical.coin}, and assetId ${technical.assetId}.`,
    );
  }

  const expectedPrice = predictionLimitPriceWire(prediction.limitProbability);
  const costUsd = Number(expectedPrice) * prediction.contracts;
  if (costUsd < args.cfg.AGENT_TRADE_HIP4_MIN_ORDER_COST_USD) {
    throw new ApiException(
      "INVALID_PARAMS",
      predictionMinCostMessage(args.cfg),
      predictionMinCostGuidance(args.cfg),
    );
  }

  assertActionMatchesPrediction(args.body, prediction, side, expectedPrice);

  return { prediction, outcome, side, wirePrice: expectedPrice, estimatedCost: roundUsd(costUsd) };
}

async function assertPredictionBalanceReady(args: {
  hl: HlClient;
  req: FastifyRequest;
  user: `0x${string}` | undefined;
  validated: PredictionValidation;
  phase: "build" | "send";
}): Promise<void> {
  if (!args.user) {
    return;
  }
  let balance;
  try {
    balance = await fetchPredictionBalanceState(args.hl, args.user);
  } catch (err) {
    args.req.log.warn(
      { ...validationPayload(args.validated), user: args.user, err },
      `prediction_exchange_${args.phase}_balance_unavailable`,
    );
    throw new ApiException(
      "HL_EXCHANGE_REJECTED",
      "Could not verify HIP-4 prediction spot balance.",
      "Retry before signing. Agent.trade requires a readable Hyperliquid spot-style USDC balance for live prediction orders.",
    );
  }
  const payload = {
    ...validationPayload(args.validated),
    user: args.user,
    predictedSpendableBalance: balance.spotUsdcAvailable,
    perpWithdrawable: balance.perpWithdrawable,
  };
  args.req.log.info(payload, `prediction_exchange_${args.phase}_preflight`);
  assertPredictionSpotBalanceSufficient({
    balance,
    requiredCostUsd: args.validated.estimatedCost,
  });
}

function assertActionMatchesPrediction(
  body: ExchangeBody,
  prediction: PredictionLiveOrderRequest,
  side: PredictionOutcomeSide,
  expectedPrice: string,
): void {
  if (body.action.type !== "order" || body.action.grouping !== "na" || body.action.orders.length !== 1) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Live prediction orders must be a single plain limit order.",
      "Submit one order leg with grouping \"na\".",
    );
  }

  const order = body.action.orders[0]!;
  if (order.a !== side.assetId) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Prediction order asset id does not match outcome metadata.",
      `Expected assetId ${side.assetId} for ${side.coin}.`,
    );
  }
  if (order.b !== true) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Only live HIP-4 buys are enabled for this spike.",
      "Submit buy:true orders only until exit-only sell validation is implemented.",
    );
  }
  if (order.r !== false) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Prediction live orders must not use reduce-only in buy-only mode.",
      "Submit r:false for buy orders.",
    );
  }
  if (!("limit" in order.t) || !["Ioc", "Gtc"].includes(order.t.limit.tif) || order.t.limit.tif !== prediction.tif) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Prediction live orders must use a matching IOC or GTC limit order.",
      "Use t.limit.tif equal to the prediction request tif.",
    );
  }

  const size = Number(order.s);
  if (order.p !== expectedPrice) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Prediction order price does not match the normalized HIP-4 wire probability.",
      `Use ${expectedPrice} for order.p after Hyperliquid spot price rounding.`,
    );
  }
  if (!Number.isInteger(size) || size !== prediction.contracts) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Prediction order size does not match the requested contract count.",
      "Use the same whole contract count in prediction.contracts and order.s.",
    );
  }
}

function predictionLimitPriceWire(limitProbability: number): string {
  return formatHip4PredictionPrice(limitProbability);
}

function formatHip4PredictionPrice(price: string | number): string {
  const parsed = typeof price === "number" ? price : Number(price);
  if (!Number.isFinite(parsed)) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Prediction limit probability must be finite.",
      "Use a numeric probability price before building the HIP-4 order.",
    );
  }
  if (parsed === 0) return "0";
  return (Math.round(parsed * 10_000) / 10_000)
    .toFixed(4)
    .replace(/0+$/u, "")
    .replace(/\.$/u, "");
}

function predictionMinCostMessage(cfg: Config): string {
  return `HIP-4 prediction orders must be at least $${formatUsd(cfg.AGENT_TRADE_HIP4_MIN_ORDER_COST_USD)}.`;
}

function predictionMinCostGuidance(cfg: Config): string {
  return `Increase contracts or limit probability so cost is at least ${formatUsd(cfg.AGENT_TRADE_HIP4_MIN_ORDER_COST_USD)} USDC.`;
}

function formatUsd(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2);
}

function validationPayload(validated: PredictionValidation) {
  return {
    questionId: validated.prediction.questionId,
    outcome: validated.prediction.outcome,
    side: validated.prediction.side,
    action: validated.prediction.action,
    contracts: validated.prediction.contracts,
    limitProbability: validated.prediction.limitProbability,
    rawLimitProbability: validated.prediction.limitProbability,
    wirePrice: validated.wirePrice,
    estimatedCost: validated.estimatedCost,
    tif: validated.prediction.tif,
    assetId: validated.side.assetId,
    coin: validated.side.coin,
    encoding: validated.side.encoding,
    outcomeName: validated.outcome.name,
    sideName: validated.side.name,
  };
}

interface PredictionValidation {
  prediction: PredictionLiveOrderRequest;
  outcome: PredictionOutcome;
  side: PredictionOutcomeSide;
  wirePrice: string;
  estimatedCost: number;
}

function roundUsd(value: number): number {
  return Number(value.toFixed(8));
}
