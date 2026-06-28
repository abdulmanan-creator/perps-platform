import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";

import type { UserFill } from "@alchemy-hl/shared";

import { ApiException } from "../errors.js";
import { HlClient } from "../helpers/hlClient.js";
import { isAuditEnabled } from "../helpers/agentTradeAudit.js";

const TAX_YEAR_MIN = 2020;
const TAX_YEAR_MAX = 2100;

export interface TaxFillsResponse {
  user: `0x${string}`;
  year: number;
  startTime: number;
  endTime: number;
  fills: UserFill[];
  source: "hyperliquid";
  audit: {
    enabled: boolean;
    reconciliation: "unavailable" | "not_joined";
  };
}

export function taxYearWindowMs(year: number): { startTime: number; endTime: number } {
  const startTime = Date.UTC(year, 0, 1, 0, 0, 0, 0);
  const endTime = Date.UTC(year + 1, 0, 1, 0, 0, 0, 0) - 1;
  return { startTime, endTime };
}

/**
 * Read-only Agent.trade tax export endpoint.
 *
 * Hyperliquid exposes historical fills through the `userFillsByTime` info
 * request. We keep this route separate from trading routes: it does not build,
 * sign, or forward exchange actions, and it intentionally has no eligibility
 * gate so restricted users can still export read-only activity for reporting.
 */
export async function taxRoute(app: FastifyInstance): Promise<void> {
  const hl = new HlClient({
    baseUrl: app.config.HYPERLIQUID_API_URL,
    logger: { warn: app.log.warn.bind(app.log) },
  });

  app.get("/agent-trade/tax/fills", async (req, reply) => {
    let q;
    try {
      q = z
        .object({
          user: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
          year: z.coerce.number().int().min(TAX_YEAR_MIN).max(TAX_YEAR_MAX),
        })
        .parse(req.query);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ApiException(
          "INVALID_PARAMS",
          "Bad query: provide ?user=0x...&year=YYYY.",
          "user must be a 0x-prefixed 20-byte address and year must be a four-digit tax year.",
        );
      }
      throw err;
    }

    const { startTime, endTime } = taxYearWindowMs(q.year);
    const fills = (await hl.info<UserFill[]>({
      type: "userFillsByTime",
      user: q.user.toLowerCase(),
      startTime,
      endTime,
    })) ?? [];

    const auditEnabled = isAuditEnabled(app.config);
    const out: TaxFillsResponse = {
      user: q.user as `0x${string}`,
      year: q.year,
      startTime,
      endTime,
      fills,
      source: "hyperliquid",
      audit: {
        enabled: auditEnabled,
        reconciliation: auditEnabled ? "not_joined" : "unavailable",
      },
    };
    return reply.send(out);
  });
}
