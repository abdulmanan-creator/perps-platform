import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { privateKeyToAccount } from "viem/accounts";

import type { Action, SendResponse } from "@alchemy-hl/shared";

import { ApiException } from "../errors.js";
import { injectBuilder } from "../helpers/builder.js";
import {
  AGENT_NAME,
  deriveAgentAddress,
  deriveAgentKey,
} from "../helpers/agent.js";
import { phantomAgentTypedData } from "../helpers/hash.js";
import { HlClient } from "../helpers/hlClient.js";
import { metrics, recordOrderOutcome } from "../helpers/metrics.js";
import { verifyPrivyAuth } from "../helpers/privyAuth.js";
import { ActionSchema, ApprovalQuerySchema } from "../schemas.js";
import { TtlCache, cachedAsync } from "../helpers/ttlCache.js";
import { WRITE_RATE_LIMIT } from "./exchange.js";
import {
  assertAgentTradeExchangeAllowed,
  isAgentTradeGuardedAction,
  recordAgentTradeNotional,
} from "../helpers/agentTradeSafety.js";

/**
 * GET /agent?user=0x... → { user, agentAddress, agentName }
 * POST /agent/exchange     → server-side agent-signing (Privy JWT auth)
 *
 * GET is unauthenticated — anyone can look up a user's deterministic agent
 * address (it's not secret, just derivation-bound).
 *
 * POST is the unattended-trading entrypoint: authenticated by a Privy JWT,
 * server signs the action with the user's per-user agent key and forwards
 * to HL. The user must have signed approveAgent for that agent address
 * separately (typically once during /connect/* setup). Without that
 * approval, HL rejects the trade — passes through as HL_EXCHANGE_REJECTED.
 *
 * Action types accepted on /agent/exchange:
 *   - order, cancel, cancelByCloid  ← agent-signable L1 actions
 *
 * Refused on /agent/exchange:
 *   - approveBuilderFee, approveAgent  ← must come from the user's main key
 *     since they require user authorization (the user can't delegate the
 *     act of delegating).
 */
export async function agentRoute(app: FastifyInstance): Promise<void> {
  const hl = new HlClient({
    baseUrl: app.config.HYPERLIQUID_API_URL,
    logger: { warn: app.log.warn.bind(app.log) },
  });

  // -------------------------------------------------------------------------
  // GET /agent — public lookup of a user's derived agent address.
  // -------------------------------------------------------------------------
  app.get("/agent", async (req, reply) => {
    let q;
    try {
      q = ApprovalQuerySchema.parse(req.query);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ApiException(
          "INVALID_PARAMS",
          "Bad query: provide ?user=0x...",
          "Pass the wallet you intend to delegate trading authority from.",
        );
      }
      throw err;
    }

    if (!app.config.AGENT_MASTER_SEED) {
      throw new ApiException(
        "INVALID_PARAMS",
        "AGENT_MASTER_SEED is not configured on this deployment.",
        "Server hasn't enabled unattended trading. Set AGENT_MASTER_SEED (32-byte hex) in env and restart.",
      );
    }

    const agentAddress = deriveAgentAddress(
      app.config.AGENT_MASTER_SEED as `0x${string}`,
      q.user,
    );

    // Check HL's extraAgents registry for this user. If our derived agent is
    // already listed, the /oauth/authorize page can skip the approveAgent
    // step — HL rejects re-approving the same agent address with "Extra
    // agent already used" (which is what happens when a user OAuth's
    // through both Claude + ChatGPT against the same wallet).
    let approved = false;
    let validUntil: number | null = null;
    try {
      const agents = (await hl.info<HlExtraAgent[]>({
        type: "extraAgents",
        user: q.user,
      })) ?? [];
      const lower = agentAddress.toLowerCase();
      const hit = agents.find((a) => a.address?.toLowerCase() === lower);
      if (hit) {
        approved = true;
        validUntil = typeof hit.validUntil === "number" ? hit.validUntil : null;
      }
    } catch (err) {
      // Don't fail the lookup if HL is unreachable — caller can still
      // attempt approveAgent and surface any error from there.
      req.log.warn({ err: (err as Error).message }, "extra_agents_lookup_failed");
    }

    return reply.send({
      user: q.user,
      agentAddress,
      agentName: AGENT_NAME,
      approved,
      validUntil,
    });
  });

  // Idempotency for unattended trading. Unlike /exchange (where the client's
  // signature makes replays detectable), this path mints a fresh nonce per
  // request — so a blind retry from an MCP host (Claude re-running a tool
  // call that looked like it timed out) would place a *second* live order.
  // Callers pass `idempotencyKey` (any string ≤128 chars, unique per logical
  // order); repeats within the window get the original response back,
  // including coalescing onto a still-in-flight first attempt.
  const idempotentResponses = new TtlCache<Promise<SendResponse>>({
    ttlMs: 10 * 60_000,
    maxEntries: 20_000,
  });

  // -------------------------------------------------------------------------
  // POST /agent/exchange — authenticated agent-signing.
  // -------------------------------------------------------------------------
  app.post("/agent/exchange", { config: { rateLimit: WRITE_RATE_LIMIT } }, async (req, reply) => {
    // 1. Verify Privy JWT, resolve to the user's wallet address.
    const auth = await verifyPrivyAuth(req.headers.authorization, app.config);

    if (!app.config.AGENT_MASTER_SEED) {
      throw new ApiException(
        "INVALID_PARAMS",
        "AGENT_MASTER_SEED is not configured.",
        "Server hasn't enabled unattended trading. Set AGENT_MASTER_SEED in env and restart.",
      );
    }

    // 2. Validate body shape.
    let action: Action;
    let idempotencyKey: string | undefined;
    try {
      const body = req.body as { action: unknown; idempotencyKey?: unknown };
      if (typeof body?.idempotencyKey === "string" && body.idempotencyKey.length > 0) {
        if (body.idempotencyKey.length > 128) {
          throw new ApiException(
            "INVALID_PARAMS",
            "idempotencyKey must be at most 128 characters.",
            "Use a short unique string per logical order — a UUID works.",
          );
        }
        idempotencyKey = body.idempotencyKey;
      }
      if (!body?.action) {
        throw new ApiException(
          "INVALID_PARAMS",
          "Body must include `action`.",
          "POST { \"action\": {...} } — same action shape as POST /exchange.",
        );
      }
      action = ActionSchema.parse(body.action);
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.issues[0];
        throw new ApiException(
          "INVALID_PARAMS",
          `Bad action at ${first?.path.join(".") ?? "(root)"}: ${first?.message ?? "validation failed"}`,
          "See the action schema in @alchemy-hl/shared.",
        );
      }
      throw err;
    }

    // 3. Reject action types that must come from the user's main key.
    if (action.type === "approveBuilderFee" || action.type === "approveAgent") {
      throw new ApiException(
        "INVALID_PARAMS",
        `Action "${action.type}" cannot be agent-signed — it requires the user's primary wallet signature.`,
        "Use POST /exchange (the normal user-signed path) for approveBuilderFee and approveAgent. /agent/exchange is for routine trading actions only.",
      );
    }

    // 3b. Cap leverage on the agent path. Users wanting higher leverage can
    //     still set it via /exchange with their primary wallet.
    if (action.type === "updateLeverage") {
      if (action.leverage > app.config.MAX_AGENT_LEVERAGE_PERPS) {
        throw new ApiException(
          "INVALID_PARAMS",
          `Leverage ${action.leverage}x exceeds the agent-path cap of ${app.config.MAX_AGENT_LEVERAGE_PERPS}x.`,
          `To set higher leverage, sign the updateLeverage action with your primary wallet via /exchange. Otherwise lower the requested leverage to ${app.config.MAX_AGENT_LEVERAGE_PERPS}x or less.`,
        );
      }
    }

    // 4. Builder injection for order actions (same as the regular /exchange path).
    if (action.type === "order") {
      injectBuilder(action, app.config);
    }
    if (isAgentTradeGuardedAction(action)) {
      assertAgentTradeExchangeAllowed({
        req,
        cfg: app.config,
        action,
        user: auth.walletAddress,
      });
    }

    // 5/6. Derive the user's agent key, sign the L1 phantom-agent envelope,
    //      forward to HL. HL recovers the agent's address from the sig, looks
    //      up the user via approveAgent records, processes the trade as
    //      coming from the user.
    const execute = async (): Promise<SendResponse> => {
      const agentKey = deriveAgentKey(
        app.config.AGENT_MASTER_SEED as `0x${string}`,
        auth.walletAddress,
      );
      const agentAccount = privateKeyToAccount(agentKey);
      const nonce = Date.now();
      const { typedData } = phantomAgentTypedData(action, nonce, {
        isTestnet: app.config.isTestnet,
      });
      const sigHex = await agentAccount.signTypedData({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });
      const signature = splitHexSig(sigHex);

      req.log.info(
        {
          type: action.type,
          user: auth.walletAddress,
          agent: agentAccount.address,
          nonce,
          idempotencyKey,
        },
        "agent_send",
      );

      let exchangeResponse: unknown;
      try {
        exchangeResponse = await hl.forwardExchange({
          action: action as unknown,
          nonce,
          signature,
        });
      } catch (err) {
        metrics.hlForwards.inc({ action: action.type, outcome: "error", path: "agent" });
        throw err;
      }
      metrics.hlForwards.inc({ action: action.type, outcome: "ok", path: "agent" });
      if (action.type === "order") {
        recordOrderOutcome(exchangeResponse, action.builder?.f, "agent");
        recordAgentTradeNotional({
          req,
          action,
          user: auth.walletAddress,
        });
      }

      return {
        success: true,
        user: auth.walletAddress,
        exchangeResponse,
      };
    };

    let out: SendResponse;
    if (idempotencyKey) {
      const cacheKey = `${auth.walletAddress}:${idempotencyKey}`;
      if (idempotentResponses.get(cacheKey) !== undefined) {
        metrics.duplicatesRejected.inc({ route: "/agent/exchange" });
        req.log.info({ idempotencyKey, user: auth.walletAddress }, "idempotent_replay_served");
      }
      // Failed executions self-evict (cachedAsync), so a retry after a real
      // error re-executes instead of replaying the failure for 10 minutes.
      out = await cachedAsync(idempotentResponses, cacheKey, execute);
    } else {
      out = await execute();
    }
    return reply.send(out);
  });
}

/**
 * Shape of an entry in HL's `/info { type: "extraAgents" }` response.
 * Fields beyond what we read are intentionally not typed — HL adds new
 * ones occasionally and we don't want strict typing to break the call.
 */
interface HlExtraAgent {
  address: string;
  name?: string;
  validUntil?: number;
}

/**
 * Split a 65-byte hex signature into {r, s, v}, normalizing v to 27/28.
 * Same shape as the user-side helper; duplicated here to keep this file
 * self-contained.
 */
function splitHexSig(hex: `0x${string}`): {
  r: `0x${string}`;
  s: `0x${string}`;
  v: number;
} {
  const stripped = hex.replace(/^0x/, "");
  if (stripped.length !== 130) {
    throw new Error(`Unexpected sig length: ${stripped.length}`);
  }
  let v = parseInt(stripped.slice(128, 130), 16);
  if (v < 27) v += 27;
  return {
    r: `0x${stripped.slice(0, 64)}` as `0x${string}`,
    s: `0x${stripped.slice(64, 128)}` as `0x${string}`,
    v,
  };
}
