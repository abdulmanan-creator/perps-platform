import type { FastifyInstance, FastifyRequest } from "fastify";
import { hashTypedData } from "viem";
import { ZodError } from "zod";

import type {
  Action,
  BuildResponse,
  SendResponse,
} from "@alchemy-hl/shared";

import { ApiException } from "../errors.js";
import { ExchangeBodySchema, type ExchangeBody } from "../schemas.js";
import { injectBuilder, orderHasSpot, feeBpsFor } from "../helpers/builder.js";
import { phantomAgentTypedData } from "../helpers/hash.js";
import {
  buildApproveAgentTypedData,
  buildApproveBuilderFeeTypedData,
} from "../helpers/eip712.js";
import { deriveAgentAddress, AGENT_NAME } from "../helpers/agent.js";
import { recoverActionSigner } from "../helpers/verify.js";
import { HlClient, classifyHlExchangeResponse, type HlExchangeResult } from "../helpers/hlClient.js";
import { metrics, recordOrderOutcome } from "../helpers/metrics.js";
import { TtlCache } from "../helpers/ttlCache.js";

/**
 * POST /exchange — single dispatch endpoint.
 *
 * Phase A (Build):
 *   body = { action }
 *   → server validates + injects builder + returns hash/nonce/typedData
 *
 * Phase B (Send):
 *   body = { action, nonce, signature }
 *   → server re-injects builder, re-derives the EIP-712 envelope, recovers
 *     the signer, re-checks builder + cap, forwards the signed payload.
 *
 * The phase is determined by presence of `signature`. Missing nonce in Phase A
 * is filled with Date.now(); missing nonce in Phase B is INVALID_PARAMS.
 *
 * This route intentionally remains the generic builder/API exchange path for
 * SDK, MCP, dashboard, and legacy callers. Agent.trade product live orders use
 * /agent-trade/exchange, which wraps this same execution logic with
 * Agent.trade-specific eligibility, acknowledgement, kill-switch, mainnet, and
 * notional-cap checks.
 */
export async function exchangeRoute(app: FastifyInstance): Promise<void> {
  await registerExchangeEndpoint(app, { path: "/exchange", metricRoute: "/exchange" });
}

export interface ExchangeEndpointHooks {
  beforeBuild?: (args: {
    req: FastifyRequest;
    body: ExchangeBody;
    nonce: number;
  }) => void | Promise<void>;
  afterBuild?: (args: {
    req: FastifyRequest;
    body: ExchangeBody;
    response: BuildResponse;
  }) => void | Promise<void>;
  onBuildError?: (args: {
    req: FastifyRequest;
    body: ExchangeBody;
    error: unknown;
    nonce?: number;
  }) => void | Promise<void>;
  beforeSend?: (args: {
    req: FastifyRequest;
    body: ExchangeBody;
    signer: `0x${string}`;
    builderFeeBps?: number;
  }) => void | Promise<void>;
  afterSend?: (args: {
    req: FastifyRequest;
    body: ExchangeBody;
    signer: `0x${string}`;
    exchangeResponse: unknown;
    latencyMs: number;
    builderFeeBps?: number;
  }) => void | Promise<void>;
  onSendError?: (args: {
    req: FastifyRequest;
    body: ExchangeBody;
    signer?: `0x${string}`;
    error: unknown;
    builderFeeBps?: number;
  }) => void | Promise<void>;
}

export async function registerExchangeEndpoint(
  app: FastifyInstance,
  args: {
    path: string;
    metricRoute: string;
    hooks?: ExchangeEndpointHooks;
  },
): Promise<void> {
  const hl = new HlClient({
    baseUrl: app.config.HYPERLIQUID_API_URL,
    logger: { warn: app.log.warn.bind(app.log) },
  });

  // Replay guard for Phase B. A signature is unique to one signed payload, so
  // seeing the same (r,s,v,nonce) twice within the window means a client
  // retry of an already-forwarded action — reject instead of resubmitting to
  // HL (where it would either double-place or die with an opaque duplicate-
  // nonce error). 10-minute TTL comfortably covers retry storms; HL's own
  // per-address nonce tracking is the backstop beyond that.
  const seenSignatures = new TtlCache<true>({ ttlMs: 10 * 60_000, maxEntries: 50_000 });

  app.post(args.path, { config: { rateLimit: WRITE_RATE_LIMIT } }, async (req, reply) => {
    let body: ExchangeBody;
    try {
      body = ExchangeBodySchema.parse(req.body);
    } catch (err) {
      throw zodToApi(err);
    }

    if (body.signature) {
      // ---- Phase B: send -----------------------------------------------------
      let signer: `0x${string}` | undefined;
      let builderFee: number | undefined;
      try {
        if (body.nonce === undefined) {
          throw new ApiException(
            "INVALID_PARAMS",
            "Phase B requires `nonce` (the one returned by Phase A).",
            "Echo back the nonce you got from the build response alongside the signature.",
          );
        }

        // Re-inject builder for order actions. This protects against a client
        // that built locally with one fee then tried to send a different one.
        if (body.action.type === "order") {
          injectBuilder(body.action, app.config);
          builderFee = feeBpsFor(body.action, app.config);
        }

        signer = await recoverActionSigner(
          body.action,
          body.nonce,
          body.signature,
          app.config,
        );
        await args.hooks?.beforeSend?.({ req, body, signer, builderFeeBps: builderFee });

        const replayKey = `${body.signature.r}:${body.signature.s}:${body.signature.v}:${body.nonce}`;
        if (!seenSignatures.addIfAbsent(replayKey, true)) {
          metrics.duplicatesRejected.inc({ route: args.metricRoute });
          throw new ApiException(
            "DUPLICATE_REQUEST",
            "This signed payload was already submitted.",
            "The same signature + nonce was forwarded within the last 10 minutes — the original request likely succeeded. Check order state via /openOrders or /orderStatus instead of retrying. To place the same order again, build and sign a fresh payload.",
          );
        }

        req.log.info(
          { route: args.metricRoute, type: body.action.type, signer, builderFee, nonce: body.nonce },
          "exchange_send",
        );

        // Normalize signature recovery id (v) to 27/28 before forwarding to HL.
        // Some signers (Privy embedded wallets via raw EIP-1193, certain smart
        // signers) return v in 0/1 (yParity) format. viem normalizes on recovery
        // — so OUR recoverActionSigner above returns the right signer — but HL's
        // ecrecover uses v as-is. Without normalization HL recovers a different
        // (random-looking) address and rejects with "User does not exist".
        const originalV = body.signature.v;
        const normalizedSignature = {
          r: body.signature.r,
          s: body.signature.s,
          v: originalV < 27 ? originalV + 27 : originalV,
        };
        req.log.info(
          {
            signerWeRecovered: signer,
            rawV: originalV,
            normalizedV: normalizedSignature.v,
            actionKeysOrder: Object.keys(body.action),
          },
          "forwarding_to_hl",
        );

        const startedAt = Date.now();
        let exchangeResponse: unknown;
        try {
          exchangeResponse = await hl.forwardExchange({
            action: body.action as unknown,
            nonce: body.nonce,
            signature: normalizedSignature,
          });
        } catch (err) {
          // The payload never reached HL — clear the replay guard so the
          // client can legitimately retry the same signed payload. Rejections
          // (HL saw it and said no) stay guarded.
          if (err instanceof ApiException && err.code === "HL_EXCHANGE_UNREACHABLE") {
            seenSignatures.delete(replayKey);
          }
          metrics.hlForwards.inc({ action: body.action.type, outcome: "error", path: "user" });
          throw err;
        }
        const latencyMs = Date.now() - startedAt;
        metrics.hlForwards.inc({ action: body.action.type, outcome: "ok", path: "user" });
        if (body.action.type === "order") {
          recordOrderOutcome(exchangeResponse, builderFee, "user");
        }
        await args.hooks?.afterSend?.({ req, body, signer, exchangeResponse, latencyMs, builderFeeBps: builderFee });

        const exchangeResult = classifyHlExchangeResponse(exchangeResponse);
        const out: SendResponse & { exchangeResult: HlExchangeResult } = {
          success: true,
          user: signer,
          exchangeResponse,
          exchangeResult,
        };
        return reply.send(out);
      } catch (err) {
        await args.hooks?.onSendError?.({ req, body, signer, error: err, builderFeeBps: builderFee });
        throw err;
      }
    }

    // ---- Phase A: build ------------------------------------------------------
    const nonce = body.nonce ?? Date.now();
    try {
      await args.hooks?.beforeBuild?.({ req, body, nonce });
      const out = buildPhase(body.action, nonce, app.config, body.user);
      await args.hooks?.afterBuild?.({ req, body, response: out });
      req.log.info(
        { route: args.metricRoute, type: body.action.type, nonce, hash: out.hash, builderFee: out.builderFee },
        "exchange_build",
      );
      return reply.send(out);
    } catch (err) {
      await args.hooks?.onBuildError?.({ req, body, error: err, nonce });
      throw err;
    }
  });
}

/**
 * Refuse to build sign-able payloads when the configured builder is the zero
 * address — almost always means ALCHEMY_BUILDER_ADDRESS wasn't set in .env
 * before the API was started. Without this guard the user could approve the
 * zero address as their builder (harmless but wasted), or place orders that
 * inject builder=0x0 (fees burn). Better to fail loudly here.
 *
 * cancel / cancelByCloid don't reference the builder address so they pass.
 */
const ZERO_ADDR = /^0x0+$/i;

/**
 * Tighter per-route bucket for the write path (the global limit in server.ts
 * covers reads). Forwarding to HL is the expensive, irreversible operation —
 * 10 signed submissions per second per IP is far above any human flow and
 * still generous for bots.
 */
export const WRITE_RATE_LIMIT = { max: 10, timeWindow: "1 second" } as const;

function buildPhase(
  action: Action,
  nonce: number,
  cfg: import("../config.js").Config,
  user?: `0x${string}`,
): BuildResponse {
  if (
    (action.type === "order" || action.type === "approveBuilderFee") &&
    ZERO_ADDR.test(cfg.ALCHEMY_BUILDER_ADDRESS)
  ) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Server's ALCHEMY_BUILDER_ADDRESS is the zero address.",
      "Set ALCHEMY_BUILDER_ADDRESS in .env to a real wallet, then fully restart the API (dotenv only reads .env at boot). Until then this endpoint refuses to build payloads that would commit to the zero address.",
    );
  }

  if (action.type === "order") {
    injectBuilder(action, cfg);
    const { hash, typedData } = phantomAgentTypedData(action, nonce, {
      isTestnet: cfg.isTestnet,
    });
    return {
      hash,
      nonce,
      action,
      isSpot: orderHasSpot(action),
      builderFee: feeBpsFor(action, cfg),
      builder: cfg.ALCHEMY_BUILDER_ADDRESS,
      typedData,
    };
  }

  if (action.type === "approveBuilderFee") {
    const { typedData, action: filled, nonce: usedNonce } =
      buildApproveBuilderFeeTypedData(action, {
        builder: cfg.ALCHEMY_BUILDER_ADDRESS,
        isTestnet: cfg.isTestnet,
        nonce,
      });
    // For user-signed actions there's no separate L1 hash to surface — the
    // client signs the typed data directly and gets the digest from their
    // wallet's signing flow. We return the EIP-712 digest as a courtesy
    // (the same value the wallet computes internally).
    return {
      hash: hashTypedDataDigest(typedData),
      nonce: usedNonce,
      action: filled,
      isSpot: false,
      builderFee: 0,
      builder: cfg.ALCHEMY_BUILDER_ADDRESS,
      typedData,
    };
  }

  if (action.type === "approveAgent") {
    if (!cfg.AGENT_MASTER_SEED) {
      throw new ApiException(
        "INVALID_PARAMS",
        "Server's AGENT_MASTER_SEED is not configured.",
        "Set AGENT_MASTER_SEED in .env to enable approveAgent + unattended trading. Generate with: openssl rand -hex 32",
      );
    }
    // Caller may explicitly pass agentAddress (e.g. all-zeros to revoke);
    // otherwise we derive the user's canonical agent address. Derivation
    // requires knowing the user's address — that's the `user` field on the
    // ExchangeBody.
    let agentAddress = action.agentAddress;
    if (!agentAddress) {
      if (!user) {
        throw new ApiException(
          "INVALID_PARAMS",
          "approveAgent build needs the user address.",
          "Pass `user: 0x...` in the request body so we can derive their agent wallet from AGENT_MASTER_SEED. Alternatively pass an explicit `action.agentAddress`.",
        );
      }
      agentAddress = deriveAgentAddress(
        cfg.AGENT_MASTER_SEED as `0x${string}`,
        user,
      );
    }
    const { typedData, action: filled, nonce: usedNonce } =
      buildApproveAgentTypedData(action, {
        agentAddress,
        agentName: action.agentName ?? AGENT_NAME,
        isTestnet: cfg.isTestnet,
        nonce,
      });
    return {
      hash: hashTypedDataDigest(typedData),
      nonce: usedNonce,
      action: filled,
      isSpot: false,
      builderFee: 0,
      builder: cfg.ALCHEMY_BUILDER_ADDRESS,
      typedData,
    };
  }

  if (
    action.type === "cancel" ||
    action.type === "cancelByCloid" ||
    action.type === "updateLeverage"
  ) {
    const { hash, typedData } = phantomAgentTypedData(action, nonce, {
      isTestnet: cfg.isTestnet,
    });
    return {
      hash,
      nonce,
      action,
      isSpot: false,
      builderFee: 0,
      builder: cfg.ALCHEMY_BUILDER_ADDRESS,
      typedData,
    };
  }

  // Exhaustiveness — TS will catch new variants at compile time.
  const _exhaustive: never = action;
  throw new ApiException(
    "INVALID_PARAMS",
    `Unsupported action type.`,
    "Use one of: order, cancel, cancelByCloid, updateLeverage, approveBuilderFee, approveAgent.",
  );
}

function hashTypedDataDigest(td: import("@alchemy-hl/shared").EIP712TypedData): `0x${string}` {
  return hashTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: td.message,
  });
}

function zodToApi(err: unknown): ApiException {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const path = first?.path.join(".") ?? "(root)";
    return new ApiException(
      "INVALID_PARAMS",
      `Bad shape at ${path}: ${first?.message ?? "validation failed"}`,
      "Check the action schema. See the API docs for the exact field names and types.",
    );
  }
  return new ApiException(
    "INVALID_JSON",
    "Request body could not be parsed.",
    "Send a JSON object with at minimum an `action` field. Set content-type to application/json.",
  );
}
