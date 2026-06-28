import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { ApiException, sendError } from "../src/errors.js";
import { taxRoute, taxYearWindowMs, type TaxFillsResponse } from "../src/routes/tax.js";

const baseEnv = {
  ALCHEMY_BUILDER_ADDRESS: "0xAAAA000000000000000000000000000000000001",
  HYPERLIQUID_API_URL: "https://api.hyperliquid-testnet.xyz",
  PERPS_BUILDER_FEE_BPS: "4",
  SPOT_BUILDER_FEE_BPS: "5",
} as unknown as NodeJS.ProcessEnv;

const USER = "0xcccc000000000000000000000000000000000001";

async function buildApp(env: NodeJS.ProcessEnv = baseEnv): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("config", loadConfig(env));
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiException) return sendError(reply, err);
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: String(err) });
  });
  await app.register(taxRoute);
  return app;
}

function mockInfo(body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("GET /agent-trade/tax/fills", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("fetches Hyperliquid userFillsByTime for the selected tax year", async () => {
    const fetchSpy = mockInfo([
      {
        coin: "#1890",
        px: "0.6400",
        sz: "10",
        side: "B",
        time: Date.UTC(2026, 5, 1),
        oid: 101,
        tid: 202,
        hash: "0xabc",
        fee: "0.0100",
        builderFee: "0.0025",
        closedPnl: "0.0",
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/agent-trade/tax/fills?user=${USER}&year=2026`,
      headers: { "cf-ipcountry": "US" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as TaxFillsResponse;
    expect(body.user).toBe(USER);
    expect(body.year).toBe(2026);
    expect(body.source).toBe("hyperliquid");
    expect(body.audit.reconciliation).toBe("unavailable");
    expect(body.fills).toHaveLength(1);
    expect(body.fills[0]).toMatchObject({ coin: "#1890", builderFee: "0.0025" });

    const sent = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      type: string;
      user: string;
      startTime: number;
      endTime: number;
    };
    expect(sent).toEqual({
      type: "userFillsByTime",
      user: USER.toLowerCase(),
      ...taxYearWindowMs(2026),
    });
  });

  it("returns an empty year without treating restricted users as blocked", async () => {
    mockInfo([]);

    const res = await app.inject({
      method: "GET",
      url: `/agent-trade/tax/fills?user=${USER}&year=2025`,
      headers: { "cf-ipcountry": "US" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as TaxFillsResponse;
    expect(body.fills).toEqual([]);
  });

  it("rejects invalid query params", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agent-trade/tax/fills?user=nope&year=2019",
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "INVALID_PARAMS" });
  });
});
