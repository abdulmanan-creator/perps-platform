import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { ApiException, sendError } from "../src/errors.js";
import { agentTradeCandlesRoute, mapHlCandle } from "../src/routes/agentTradeCandles.js";

const baseEnv = {
  ALCHEMY_BUILDER_ADDRESS: "0xAAAA000000000000000000000000000000000001",
  HYPERLIQUID_API_URL: "https://api.hyperliquid-testnet.xyz",
  PERPS_BUILDER_FEE_BPS: "4",
  SPOT_BUILDER_FEE_BPS: "5",
} as unknown as NodeJS.ProcessEnv;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("config", loadConfig(baseEnv));
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiException) return sendError(reply, err);
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: String(err) });
  });
  await app.register(agentTradeCandlesRoute);
  return app;
}

function mockInfo(...responses: unknown[]): ReturnType<typeof vi.spyOn> {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const response of responses) {
    spy.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }
  return spy;
}

describe("GET /agent-trade/candles", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("validates supported intervals", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agent-trade/candles?symbol=BTC-USD&interval=30m",
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "INVALID_PARAMS" });
  });

  it("rejects unsupported symbols after checking Hyperliquid meta", async () => {
    mockInfo({ universe: [{ name: "BTC" }, { name: "ETH" }] });

    const res = await app.inject({
      method: "GET",
      url: "/agent-trade/candles?symbol=NOPE-USD&interval=15m",
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "INVALID_PARAMS" });
  });

  it("maps Hyperliquid candleSnapshot data to chart candles", async () => {
    const fetchSpy = mockInfo(
      { universe: [{ name: "BTC" }, { name: "ETH" }] },
      [
        {
          t: 1_720_000_000_000,
          T: 1_720_000_899_999,
          s: "BTC",
          i: "15m",
          o: "60000",
          h: "61000",
          l: "59000",
          c: "60500",
          v: "12.345",
          n: 42,
        },
      ],
    );

    const res = await app.inject({
      method: "GET",
      url: "/agent-trade/candles?symbol=BTC-USD&interval=15m",
    });

    expect(res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "https://api.hyperliquid-testnet.xyz/info",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"type":"candleSnapshot"'),
      }),
    );
    expect(res.json()).toMatchObject({
      symbol: "BTC-USD",
      interval: "15m",
      source: "hyperliquid",
      candles: [
        {
          time: 1_720_000_000,
          open: 60000,
          high: 61000,
          low: 59000,
          close: 60500,
          volume: 12.345,
        },
      ],
    });
  });

  it("resolves supported non-BTC/ETH and mixed-case symbols through Hyperliquid meta", async () => {
    const fetchSpy = mockInfo(
      { universe: [{ name: "BTC" }, { name: "ETH" }, { name: "SOL" }, { name: "kPEPE" }] },
      [
        {
          t: 1_720_000_000_000,
          o: "0.012",
          h: "0.014",
          l: "0.011",
          c: "0.013",
          v: "1000000",
        },
      ],
    );

    const res = await app.inject({
      method: "GET",
      url: "/agent-trade/candles?symbol=KPEPE-USD&interval=5m",
    });

    expect(res.statusCode).toBe(200);
    const candleRequest = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body)) as {
      req: { coin: string; interval: string };
    };
    expect(candleRequest.req).toMatchObject({ coin: "kPEPE", interval: "5m" });
    expect(res.json()).toMatchObject({
      symbol: "kPEPE-USD",
      interval: "5m",
      source: "hyperliquid",
    });
  });
});

describe("mapHlCandle", () => {
  it("drops malformed candle rows", () => {
    expect(mapHlCandle({ t: 1_720_000_000_000, o: "1", h: "2", l: "0.5", c: "bad", v: "1" })).toBeNull();
  });
});
