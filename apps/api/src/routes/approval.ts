import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { ApprovalState } from "@alchemy-hl/shared";

import { ApiException } from "../errors.js";
import { HlClient } from "../helpers/hlClient.js";
import { ApprovalQuerySchema } from "../schemas.js";

/**
 * GET /approval?user=0x... — read the user's maxBuilderFee for Alchemy's
 * builder and shape it into ApprovalState for the UI.
 *
 * Hyperliquid's /info endpoint accepts:
 *   { type: "maxBuilderFee", user, builder }
 *
 * The response is the raw int the protocol stores. Per Hyperliquid's
 * convention the unit is "tenths of basis points" — i.e. a `maxFeeRate`
 * of "0.001%" maps to a raw value of 1, "1%" to 1000, "10%" to 10000. We
 * preserve the raw value and provide a human-friendly string for the UI.
 *
 * Whether the user can route perps/spot at our configured fee comes from
 * comparing their raw cap against (our configured bps × 10) — the unit
 * conversion lives here so the UI doesn't have to know it.
 */
export async function approvalRoute(app: FastifyInstance): Promise<void> {
  const hl = new HlClient({
    baseUrl: app.config.HYPERLIQUID_API_URL,
    logger: { warn: app.log.warn.bind(app.log) },
  });

  app.get("/approval", async (req, reply) => {
    let q;
    try {
      q = ApprovalQuerySchema.parse(req.query);
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.issues[0];
        throw new ApiException(
          "INVALID_PARAMS",
          `Bad query: ${first?.path.join(".") ?? "(root)"}: ${first?.message ?? "validation failed"}`,
          "Provide ?user=0x... (the wallet address whose approval state you want to read).",
        );
      }
      throw err;
    }

    const raw = await hl.info<number | string>({
      type: "maxBuilderFee",
      user: q.user,
      builder: app.config.ALCHEMY_BUILDER_ADDRESS,
    });

    // Hyperliquid returns a number; guard against the occasional stringified
    // response by coercing here. NaN → not approved.
    const maxFeeRaw = Number(raw);
    const safeRaw = Number.isFinite(maxFeeRaw) ? maxFeeRaw : 0;

    // raw → percent: rawTenthsOfBps / 1000 = percent value
    const percent = safeRaw / 1000;
    const maxFeeRate = percent === 0 ? "0%" : trimPercent(percent);

    // 1 bps = 10 raw units. canTradeX = raw >= configuredBps × 10.
    const canTradePerps = safeRaw >= app.config.PERPS_BUILDER_FEE_BPS * 10;
    const canTradeSpot = safeRaw >= app.config.SPOT_BUILDER_FEE_BPS * 10;

    const out: ApprovalState = {
      builder: app.config.ALCHEMY_BUILDER_ADDRESS,
      approved: safeRaw > 0,
      maxFeeRate,
      maxFeeRaw: safeRaw,
      canTradePerps,
      canTradeSpot,
      feeBreakdown: {
        configuredPerpsBps: app.config.PERPS_BUILDER_FEE_BPS,
        configuredSpotBps: app.config.SPOT_BUILDER_FEE_BPS,
        protocolMaxPerpsBps: app.config.MAX_BUILDER_FEE_BPS_PERPS,
        protocolMaxSpotBps: app.config.MAX_BUILDER_FEE_BPS_SPOT,
      },
    };

    req.log.info(
      { user: q.user, maxFeeRaw: safeRaw, approved: out.approved },
      "approval_read",
    );
    return reply.send(out);
  });
}

/**
 * "1" → "1%", "0.04" → "0.04%", trailing zeros trimmed.
 */
function trimPercent(n: number): string {
  const fixed = n.toFixed(6);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return `${trimmed}%`;
}
