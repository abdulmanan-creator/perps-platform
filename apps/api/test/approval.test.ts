/**
 * GET /approval tests.
 *
 * Cases:
 *   - User who has never approved → approved: false, maxFeeRaw 0
 *   - User approved at 1% (raw 1000) → both canTrade flags true
 *   - User approved tiny (raw 30) → covers perps (>= 40? no, 4 bps × 10 = 40)
 *   - Bad query → INVALID_PARAMS
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalState } from "@alchemy-hl/shared";

import { loadConfig } from "../src/config.js";
import { ApiException, sendError } from "../src/errors.js";
import { approvalRoute } from "../src/routes/approval.js";

const baseEnv = {
  ALCHEMY_BUILDER_ADDRESS: "0xAAAA000000000000000000000000000000000001",
  HYPERLIQUID_API_URL: "https://api.hyperliquid-testnet.xyz",
  PERPS_BUILDER_FEE_BPS: "4", // raw cutoff = 40
  SPOT_BUILDER_FEE_BPS: "5",  // raw cutoff = 50
  MAX_BUILDER_FEE_BPS_PERPS: "10",
  MAX_BUILDER_FEE_BPS_SPOT: "100",
} as unknown as NodeJS.ProcessEnv;
const TEST_BUILDER = "0xaaaa000000000000000000000000000000000001";

async function buildApp(): Promise<FastifyInstance> {
  const cfg = loadConfig(baseEnv);
  const app = Fastify({ logger: false });
  app.decorate("config", cfg);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiException) return sendError(reply, err);
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: String(err) });
  });
  await app.register(approvalRoute);
  return app;
}

function mockInfo(raw: number | string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(raw), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("GET /approval", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("not approved when raw=0", async () => {
    mockInfo(0);
    const res = await app.inject({
      method: "GET",
      url: "/approval?user=0xCccc000000000000000000000000000000000001",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ApprovalState;
    expect(body.builder.toLowerCase()).toBe(TEST_BUILDER);
    expect(body.approved).toBe(false);
    expect(body.maxFeeRaw).toBe(0);
    expect(body.maxFeeRate).toBe("0%");
    expect(body.canTradePerps).toBe(false);
    expect(body.canTradeSpot).toBe(false);
  });

  it("approved at 1% (raw=1000) covers both perps and spot", async () => {
    mockInfo(1000);
    const res = await app.inject({
      method: "GET",
      url: "/approval?user=0xCccc000000000000000000000000000000000001",
    });
    const body = res.json() as ApprovalState;
    expect(body.approved).toBe(true);
    expect(body.maxFeeRaw).toBe(1000);
    expect(body.maxFeeRate).toBe("1%");
    expect(body.canTradePerps).toBe(true);
    expect(body.canTradeSpot).toBe(true);
  });

  it("approved at 0.04% (raw=40) covers perps but not spot", async () => {
    mockInfo(40);
    const res = await app.inject({
      method: "GET",
      url: "/approval?user=0xCccc000000000000000000000000000000000001",
    });
    const body = res.json() as ApprovalState;
    expect(body.maxFeeRate).toBe("0.04%");
    expect(body.canTradePerps).toBe(true);
    expect(body.canTradeSpot).toBe(false);
  });

  it("coerces stringified responses to a number", async () => {
    mockInfo("500");
    const res = await app.inject({
      method: "GET",
      url: "/approval?user=0xCccc000000000000000000000000000000000001",
    });
    const body = res.json() as ApprovalState;
    expect(body.maxFeeRaw).toBe(500);
    expect(body.maxFeeRate).toBe("0.5%");
  });

  it("rejects a missing or malformed user with INVALID_PARAMS", async () => {
    const res = await app.inject({ method: "GET", url: "/approval" });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("INVALID_PARAMS");
  });

  it("rejects a non-address user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/approval?user=not-an-address",
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("INVALID_PARAMS");
  });

  it("returns feeBreakdown reflecting the running config", async () => {
    mockInfo(1000);
    const res = await app.inject({
      method: "GET",
      url: "/approval?user=0xCccc000000000000000000000000000000000001",
    });
    const body = res.json() as ApprovalState;
    expect(body.feeBreakdown).toEqual({
      configuredPerpsBps: 4,
      configuredSpotBps: 5,
      protocolMaxPerpsBps: 10,
      protocolMaxSpotBps: 100,
    });
  });
});
