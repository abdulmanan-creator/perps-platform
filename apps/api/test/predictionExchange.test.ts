import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type {
  BuildResponse,
  OrderAction,
  PredictionLiveOrderRequest,
} from "@alchemy-hl/shared";

import { loadConfig } from "../src/config.js";
import { ApiException, sendError } from "../src/errors.js";
import {
  hip4PredictionAssetId,
  hip4PredictionCoin,
  hip4PredictionEncoding,
} from "../src/helpers/predictionHip4.js";
import { predictionExchangeRoute } from "../src/routes/predictionExchange.js";

const TEST_BUILDER = "0xAAAA000000000000000000000000000000000001" as const;

const baseEnv = {
  ALCHEMY_BUILDER_ADDRESS: TEST_BUILDER,
  HYPERLIQUID_API_URL: "https://api.hyperliquid.xyz",
  PERPS_BUILDER_FEE_BPS: "4",
  SPOT_BUILDER_FEE_BPS: "5",
  AGENT_TRADE_MAINNET_EXECUTION_ENABLED: "true",
  AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING: "true",
} as unknown as NodeJS.ProcessEnv;

const OUTCOME_META = {
  outcomes: [
    {
      outcome: 189,
      name: "France",
      description: "This outcome resolves to Yes if France wins.",
      sideSpecs: [{ name: "Yes" }, { name: "No" }],
      quoteToken: "USDC",
    },
  ],
  questions: [
    {
      question: 32,
      name: "2026 World Cup Champion",
      description: "metadata=category:sports|subCategory:football",
      namedOutcomes: [189],
      settledNamedOutcomes: [],
    },
  ],
};

const prediction: PredictionLiveOrderRequest = {
  questionId: 32,
  outcome: 189,
  side: 0,
  action: "buy",
  contracts: 53,
  limitProbability: 0.1888,
  tif: "Ioc",
  criteriaAcknowledged: true,
  liveAcknowledged: true,
};

function actionFor(input: PredictionLiveOrderRequest = prediction, assetId = 100_001_890): OrderAction {
  return {
    type: "order",
    grouping: "na",
    orders: [
      {
        a: assetId,
        b: input.action === "buy",
        p: String(input.limitProbability),
        s: String(input.contracts),
        r: false,
        t: { limit: { tif: input.tif } },
      },
    ],
  };
}

async function buildApp(env: NodeJS.ProcessEnv = baseEnv): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("config", loadConfig(env));
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiException) return sendError(reply, err);
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: (err as Error).message });
  });
  await app.register(predictionExchangeRoute);
  return app;
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockOutcomeMeta() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse((init?.body as string) ?? "{}") as { type?: string };
    if (body.type === "outcomeMeta") return jsonRes(OUTCOME_META);
    throw new Error(`Unexpected fetch: ${body.type}`);
  });
}

function liveHeaders(country = "SG") {
  return {
    "cf-ipcountry": country,
    "x-agent-trade-risk-accepted": "true",
    "x-agent-trade-terms-accepted": "true",
  };
}

describe("prediction live exchange route", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockOutcomeMeta();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("blocks live HIP-4 when the feature flag is off", async () => {
    await app.close();
    app = await buildApp({
      ...baseEnv,
      AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING: "false",
    } as unknown as NodeJS.ProcessEnv);

    const res = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { prediction, action: actionFor() },
    });

    expect(res.statusCode).toBe(451);
    expect(res.json().message).toContain("Live HIP-4 prediction trading is disabled");
  });

  it("blocks restricted users before building live prediction orders", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders("US"),
      payload: { prediction, action: actionFor() },
    });

    expect(res.statusCode).toBe(451);
    expect(res.json().message).toContain("not eligible");
  });

  it("builds a valid HIP-4 order with computed encoding and spot builder fee", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { prediction, action: actionFor() },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as BuildResponse;
    expect(body.isSpot).toBe(true);
    expect(body.builderFee).toBe(5);
    expect(body.action).toMatchObject({
      type: "order",
      grouping: "na",
      orders: [{ a: 100_001_890, b: true, p: "0.1888", s: "53", r: false, t: { limit: { tif: "Ioc" } } }],
    });
    expect(body.action.type === "order" ? body.action.orders[0]!.a : null).toBe(100_001_890);
    expect(hip4PredictionEncoding(189, 0)).toBe(1_890);
    expect(hip4PredictionCoin(189, 0)).toBe("#1890");
    expect(hip4PredictionAssetId(189, 0)).toBe(100_001_890);
  });

  it("rejects invalid question, outcome, side, asset, price, and contract inputs", async () => {
    const cases: Array<{ label: string; prediction: unknown; action?: OrderAction }> = [
      { label: "question", prediction: { ...prediction, questionId: 999 }, action: actionFor() },
      { label: "outcome", prediction: { ...prediction, outcome: 190 }, action: actionFor() },
      { label: "side", prediction: { ...prediction, side: 2 }, action: actionFor() },
      { label: "asset", prediction, action: actionFor(prediction, 100_001_891) },
      { label: "price", prediction: { ...prediction, limitProbability: 1 }, action: actionFor({ ...prediction, limitProbability: 1 }) },
      { label: "contracts", prediction: { ...prediction, contracts: 0 }, action: actionFor({ ...prediction, contracts: 0 }) },
      {
        label: "cost",
        prediction: { ...prediction, contracts: 10, limitProbability: 0.5 },
        action: actionFor({ ...prediction, contracts: 10, limitProbability: 0.5 }),
      },
    ];

    for (const item of cases) {
      const res = await app.inject({
        method: "POST",
        url: "/prediction/exchange",
        headers: liveHeaders(),
        payload: { prediction: item.prediction, action: item.action ?? actionFor() },
      });
      expect(res.statusCode, item.label).toBe(422);
    }
  });

  it("keeps sell behavior disabled for HIP4-C", async () => {
    const sell = { ...prediction, action: "sell" as const };
    const res = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { prediction: sell, action: actionFor(sell) },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain("selling is disabled");
  });

  it("surfaces nested Hyperliquid statuses error on send", async () => {
    const buildRes = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { prediction, action: actionFor() },
    });
    expect(buildRes.statusCode).toBe(200);
    const built = buildRes.json() as BuildResponse;
    if (!built.typedData) throw new Error("missing typedData");

    const account = privateKeyToAccount(generatePrivateKey());
    const sigHex = await account.signTypedData({
      domain: built.typedData.domain,
      types: built.typedData.types,
      primaryType: built.typedData.primaryType,
      message: built.typedData.message,
    });
    const signature = splitHexSig(sigHex);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonRes({
        status: "ok",
        response: { type: "order", data: { statuses: [{ error: "Order must have minimum value of $10." }] } },
      }),
    );

    const sendRes = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { prediction, action: built.action, nonce: built.nonce, signature },
    });

    expect(sendRes.statusCode).toBe(422);
    expect(sendRes.json().message).toContain("Order must have minimum value of $10.");
  });
});

function splitHexSig(hex: `0x${string}`): {
  r: `0x${string}`;
  s: `0x${string}`;
  v: number;
} {
  const stripped = hex.slice(2);
  if (stripped.length !== 130) throw new Error(`bad sig length: ${stripped.length}`);
  return {
    r: `0x${stripped.slice(0, 64)}` as `0x${string}`,
    s: `0x${stripped.slice(64, 128)}` as `0x${string}`,
    v: Number.parseInt(stripped.slice(128, 130), 16),
  };
}
