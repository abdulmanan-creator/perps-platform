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
import { predictionBalanceRoute } from "../src/routes/predictionBalance.js";
import { predictionExchangeRoute } from "../src/routes/predictionExchange.js";

const TEST_BUILDER = "0xAAAA000000000000000000000000000000000001" as const;
const TEST_USER = "0x0000000000000000000000000000000000000001" as const;

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
    {
      outcome: 217,
      name: "USA",
      description: "This outcome resolves to Yes if USA wins.",
      sideSpecs: [{ name: "Yes" }, { name: "No" }],
      quoteToken: "USDC",
    },
  ],
  questions: [
    {
      question: 32,
      name: "2026 World Cup Champion",
      description: "metadata=category:sports|subCategory:football",
      namedOutcomes: [189, 217],
      settledNamedOutcomes: [],
    },
  ],
};

const prediction: PredictionLiveOrderRequest = {
  questionId: 32,
  outcome: 189,
  side: 0,
  action: "buy",
  contracts: 59,
  limitProbability: 0.1888,
  tif: "Ioc",
  criteriaAcknowledged: true,
  liveAcknowledged: true,
};

const DEFAULT_SPOT_STATE = {
  balances: [
    { coin: "USDC", token: 0, hold: "1.25", total: "101.25", entryNtl: "0.0" },
    { coin: "+2170", token: 100_002_170, hold: "0", total: "4", entryNtl: "0.16" },
  ],
};

const DEFAULT_PERP_STATE = {
  withdrawable: "250.00",
  marginSummary: { accountValue: "260.00", totalMarginUsed: "10.00" },
};

function actionFor(
  input: PredictionLiveOrderRequest = prediction,
  assetId = 100_001_890,
  price = formatPrice(input.limitProbability),
): OrderAction {
  return {
    type: "order",
    grouping: "na",
    orders: [
      {
        a: assetId,
        b: input.action === "buy",
        p: price,
        s: String(input.contracts),
        r: false,
        t: { limit: { tif: input.tif } },
      },
    ],
  };
}

function formatPrice(value: number): string {
  return (Math.round(value * 10_000) / 10_000)
    .toFixed(4)
    .replace(/0+$/u, "")
    .replace(/\.$/u, "");
}

async function buildApp(env: NodeJS.ProcessEnv = baseEnv): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("config", loadConfig(env));
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiException) return sendError(reply, err);
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: (err as Error).message });
  });
  await app.register(predictionBalanceRoute);
  await app.register(predictionExchangeRoute);
  return app;
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockOutcomeMeta(args: {
  spotState?: unknown;
  perpState?: unknown;
  exchangeResponse?: unknown;
} = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse((init?.body as string) ?? "{}") as { type?: string };
    if (body.type === "outcomeMeta") return jsonRes(OUTCOME_META);
    if (body.type === "spotClearinghouseState") {
      if (args.spotState instanceof Error) throw args.spotState;
      return jsonRes(args.spotState ?? DEFAULT_SPOT_STATE);
    }
    if (body.type === "clearinghouseState") return jsonRes(args.perpState ?? DEFAULT_PERP_STATE);
    if (!body.type && "action" in body) {
      return jsonRes(
        args.exchangeResponse ?? {
          status: "ok",
          response: { type: "order", data: { statuses: [{ resting: { oid: 123 } }] } },
        },
      );
    }
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
      payload: { user: TEST_USER, prediction, action: actionFor() },
    });

    expect(res.statusCode).toBe(451);
    expect(res.json().message).toContain("Live HIP-4 prediction trading is disabled");
  });

  it("blocks restricted users before building live prediction orders", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders("US"),
      payload: { user: TEST_USER, prediction, action: actionFor() },
    });

    expect(res.statusCode).toBe(451);
    expect(res.json().message).toContain("not eligible");
  });

  it("builds a valid HIP-4 order with computed encoding and spot builder fee", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { user: TEST_USER, prediction, action: actionFor() },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as BuildResponse;
    expect(body.isSpot).toBe(true);
    expect(body.builderFee).toBe(5);
    expect(body.action).toMatchObject({
      type: "order",
      grouping: "na",
      orders: [{ a: 100_001_890, b: true, p: "0.1888", s: "59", r: false, t: { limit: { tif: "Ioc" } } }],
    });
    expect(body.action.type === "order" ? body.action.orders[0]!.a : null).toBe(100_001_890);
    expect(hip4PredictionEncoding(189, 0)).toBe(1_890);
    expect(hip4PredictionCoin(189, 0)).toBe("#1890");
    expect(hip4PredictionAssetId(189, 0)).toBe(100_001_890);
  });

  it("reports prediction spot balance separately from perp withdrawable", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/prediction/balance?user=${TEST_USER}`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      source: "spotClearinghouseState",
      spotUsdcAvailable: "100",
      perpWithdrawable: "250.00",
      outcomeBalances: [{ coin: "+2170", available: "4" }],
    });
    expect(res.json().guidance).toContain("spot-style balance");
    expect(res.json().guidance).toContain("perp margin balance may not be spendable");
  });

  it("blocks build before signing when HIP-4 spot USDC is insufficient", async () => {
    await app.close();
    vi.restoreAllMocks();
    mockOutcomeMeta({
      spotState: { balances: [{ coin: "USDC", token: 0, hold: "0", total: "9.99", entryNtl: "0.0" }] },
      perpState: { withdrawable: "500.00" },
    });
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { user: TEST_USER, prediction, action: actionFor() },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain("Insufficient HIP-4 prediction spot balance");
    expect(res.json().guidance).toContain("perp margin balance may not be spendable");
  });

  it("does not build a signable payload when HIP-4 spot balance cannot be verified", async () => {
    await app.close();
    vi.restoreAllMocks();
    mockOutcomeMeta({ spotState: new Error("spot balance unavailable") });
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { user: TEST_USER, prediction, action: actionFor() },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain("Could not verify HIP-4 prediction spot balance");
  });

  it("rejects invalid question, outcome, side, asset, price, and contract inputs", async () => {
    const cases: Array<{ label: string; prediction: unknown; action?: OrderAction }> = [
      { label: "question", prediction: { ...prediction, questionId: 999 }, action: actionFor() },
      { label: "outcome", prediction: { ...prediction, outcome: 190 }, action: actionFor() },
      { label: "side", prediction: { ...prediction, side: 2 }, action: actionFor() },
      { label: "asset", prediction, action: actionFor(prediction, 100_001_891) },
      { label: "price", prediction: { ...prediction, limitProbability: 1 }, action: actionFor({ ...prediction, limitProbability: 1 }) },
      { label: "contracts", prediction: { ...prediction, contracts: 0 }, action: actionFor({ ...prediction, contracts: 0 }) },
      { label: "cost", prediction: { ...prediction, contracts: 58, limitProbability: 0.1888 }, action: actionFor({ ...prediction, contracts: 58, limitProbability: 0.1888 }) },
      { label: "wire price", prediction, action: actionFor(prediction, 100_001_890, "0.18879") },
    ];

    for (const item of cases) {
      const res = await app.inject({
        method: "POST",
        url: "/prediction/exchange",
        headers: liveHeaders(),
        payload: { user: TEST_USER, prediction: item.prediction, action: item.action ?? actionFor() },
      });
      expect(res.statusCode, item.label).toBe(422);
    }
  });

  it("blocks HIP-4 prediction orders below the $11 effective minimum and allows $11+ orders", async () => {
    const belowMin = { ...prediction, contracts: 53, limitProbability: 0.1888 };
    const belowRes = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { user: TEST_USER, prediction: belowMin, action: actionFor(belowMin) },
    });

    expect(belowRes.statusCode).toBe(422);
    expect(belowRes.json().message).toBe("HIP-4 prediction orders must target at least $11.");
    expect(belowRes.json().guidance).toContain("Agent.trade requires an effective minimum of 11 USDC");

    const atMin = { ...prediction, contracts: 59, limitProbability: 0.1888 };
    const atMinRes = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { user: TEST_USER, prediction: atMin, action: actionFor(atMin) },
    });

    expect(atMinRes.statusCode, atMinRes.body).toBe(200);
  });

  it("blocks the observed 42 France Yes order locally and allows the buffered 46-contract order", async () => {
    const observedRejection = { ...prediction, contracts: 42, limitProbability: 0.243 };
    const observedRes = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { user: TEST_USER, prediction: observedRejection, action: actionFor(observedRejection, 100_001_890, "0.243") },
    });

    expect(observedRes.statusCode).toBe(422);
    expect(observedRes.json().message).toContain("at least $11");

    const retry = { ...prediction, contracts: 46, limitProbability: 0.243 };
    const retryRes = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { user: TEST_USER, prediction: retry, action: actionFor(retry, 100_001_890, "0.243") },
    });

    expect(retryRes.statusCode, retryRes.body).toBe(200);
    expect((retryRes.json() as BuildResponse).action).toMatchObject({
      orders: [{ a: 100_001_890, p: "0.243", s: "46" }],
    });
  });

  it("accepts normalized HIP-4 wire prices for too-precise requested probabilities", async () => {
    const precise = { ...prediction, limitProbability: 0.188789123 };
    const res = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { user: TEST_USER, prediction: precise, action: actionFor(precise) },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as BuildResponse).action).toMatchObject({
      orders: [{ p: "0.1888", s: "59" }],
    });
  });

  it("normalizes low-probability HIP-4 prices to the 0.0001 outcome tick", async () => {
    const lowProbability = { ...prediction, outcome: 217, contracts: 276, limitProbability: 0.04002 };
    const res = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { user: TEST_USER, prediction: lowProbability, action: actionFor(lowProbability, 100_002_170) },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as BuildResponse).action).toMatchObject({
      orders: [{ a: 100_002_170, p: "0.04", s: "276" }],
    });
  });

  it("keeps sell behavior disabled for HIP4-C", async () => {
    const sell = { ...prediction, action: "sell" as const };
    const res = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { user: TEST_USER, prediction: sell, action: actionFor(sell) },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain("selling is disabled");
  });

  it("surfaces nested Hyperliquid statuses error on send", async () => {
    const buildRes = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { user: TEST_USER, prediction, action: actionFor() },
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
    vi.restoreAllMocks();
    mockOutcomeMeta({
      exchangeResponse: {
        status: "ok",
        response: { type: "order", data: { statuses: [{ error: "Order must have minimum value of $1." }] } },
      },
    });

    const sendRes = await app.inject({
      method: "POST",
      url: "/prediction/exchange",
      headers: liveHeaders(),
      payload: { prediction, action: built.action, nonce: built.nonce, signature },
    });

    expect(sendRes.statusCode).toBe(422);
    expect(sendRes.json().message).toContain("Order must have minimum value of $1.");
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
