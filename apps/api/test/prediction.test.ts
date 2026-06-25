import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PredictionOutcomeOdds,
  PredictionQuestion,
  PredictionQuestionOdds,
  PredictionSettlementState,
} from "@alchemy-hl/shared";

import { loadConfig } from "../src/config.js";
import { ApiException, sendError } from "../src/errors.js";
import { predictionRoute } from "../src/routes/prediction.js";

const baseEnv = {
  ALCHEMY_BUILDER_ADDRESS: "0xAAAA000000000000000000000000000000000001",
  HYPERLIQUID_API_URL: "https://api.hyperliquid-testnet.xyz",
  PERPS_BUILDER_FEE_BPS: "4",
  SPOT_BUILDER_FEE_BPS: "5",
} as unknown as NodeJS.ProcessEnv;

const OUTCOME_META = {
  outcomes: [
    {
      outcome: 100,
      name: "Fallback",
      description: "",
      sideSpecs: [{ name: "Yes" }, { name: "No" }],
      quoteToken: "USDC",
    },
    {
      outcome: 101,
      name: "Alpha wins",
      description: "Alpha resolves Yes if Alpha wins.",
      sideSpecs: [{ name: "Yes" }, { name: "No" }],
      quoteToken: "USDC",
    },
    {
      outcome: 102,
      name: "Beta wins",
      description: "Beta resolves Yes if Beta wins.",
      sideSpecs: [{ name: "Yes" }, { name: "No" }],
      quoteToken: "USDC",
    },
  ],
  questions: [
    {
      question: 7,
      name: "Alpha vs Beta",
      description:
        "Exactly one outcome resolves Yes. metadata=category:sports|subCategory:test",
      fallbackOutcome: 100,
      namedOutcomes: [101, 102],
      settledNamedOutcomes: [101],
    },
  ],
};

async function buildApp(): Promise<FastifyInstance> {
  const cfg = loadConfig(baseEnv);
  const app = Fastify({ logger: false });
  app.decorate("config", cfg);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiException) return sendError(reply, err);
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: String(err) });
  });
  await predictionRoute(app);
  return app;
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockHyperliquid() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse((init?.body as string) ?? "{}") as {
      type?: string;
      coin?: string;
      outcome?: number;
    };
    if (body.type === "outcomeMeta") return jsonRes(OUTCOME_META);
    if (body.type === "settledOutcome") return jsonRes(null);
    if (body.type === "l2Book") {
      if (body.coin === "#1010") {
        return jsonRes({
          coin: body.coin,
          levels: [
            [
              { px: "0.42", sz: "10", n: 1 },
              { px: "0.40", sz: "5", n: 1 },
            ],
            [{ px: "0.48", sz: "12", n: 1 }],
          ],
        });
      }
      if (body.coin === "#1020") {
        return jsonRes({
          coin: body.coin,
          levels: [[{ px: "0.20", sz: "3", n: 1 }], []],
        });
      }
      if (body.coin === "#1021") {
        return jsonRes({
          coin: body.coin,
          levels: [[], [{ px: "0.81", sz: "7", n: 1 }]],
        });
      }
      return jsonRes({ coin: body.coin, levels: [[], []] });
    }
    throw new Error(`Unexpected info type: ${body.type}`);
  });
}

describe("prediction routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockHyperliquid();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("GET /prediction/questions preserves grouped outcomeMeta questions", async () => {
    const res = await app.inject({ method: "GET", url: "/prediction/questions" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { questions: PredictionQuestion[] };
    expect(body.questions).toHaveLength(1);
    const question = body.questions[0]!;
    expect(question.questionId).toBe(7);
    expect(question.name).toBe("Alpha vs Beta");
    expect(question.criteria).toBe("Exactly one outcome resolves Yes.");
    expect(question.metadata).toEqual({
      category: "sports",
      subCategory: "test",
      raw: "category:sports|subCategory:test",
    });
    expect(question.quoteToken).toBe("USDC");
    expect(question.fallbackOutcome?.outcome).toBe(100);
    expect(question.namedOutcomes.map((outcome) => outcome.outcome)).toEqual([101, 102]);
    expect(question.settlement).toEqual({
      state: "partiallySettled",
      settledNamedOutcomeIds: [101],
    });
  });

  it("derives outcome side encoding, book coin, and future exchange asset id", async () => {
    const res = await app.inject({ method: "GET", url: "/prediction/questions/7" });
    expect(res.statusCode).toBe(200);
    const { question } = res.json() as { question: PredictionQuestion };
    const alphaYes = question.namedOutcomes[0]!.sides[0];
    const alphaNo = question.namedOutcomes[0]!.sides[1];
    expect(alphaYes).toMatchObject({
      side: 0,
      encoding: 1010,
      coin: "#1010",
      assetId: 100_001_010,
    });
    expect(alphaNo).toMatchObject({
      side: 1,
      encoding: 1011,
      coin: "#1011",
      assetId: 100_001_011,
    });
  });

  it("GET /prediction/outcomes/:outcome/odds derives midpoint, spread, and depth", async () => {
    const res = await app.inject({ method: "GET", url: "/prediction/outcomes/101/odds" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PredictionOutcomeOdds;
    const [yes, no] = body.sides;
    expect(yes.bestBid).toBe("0.42");
    expect(yes.bestAsk).toBe("0.48");
    expect(yes.midpointProbability).toBeCloseTo(0.45);
    expect(yes.spread).toBeCloseTo(0.06);
    expect(yes.emptyBook).toBe(false);
    expect(yes.depth).toEqual({
      bidLevels: 2,
      askLevels: 1,
      bidSize: 15,
      askSize: 12,
      bidNotional: 6.2,
      askNotional: 5.76,
    });
    expect(no.bestBid).toBeNull();
    expect(no.bestAsk).toBeNull();
    expect(no.midpointProbability).toBeNull();
    expect(no.spread).toBeNull();
    expect(no.emptyBook).toBe(true);
  });

  it("GET /prediction/questions/:questionId/odds batches every outcome side and handles thin books", async () => {
    const res = await app.inject({ method: "GET", url: "/prediction/questions/7/odds" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PredictionQuestionOdds;
    expect(body.questionId).toBe(7);
    expect(body.outcomes.map((outcome) => outcome.outcome)).toEqual([100, 101, 102]);
    expect(body.outcomes[0]!.sides.every((side) => side.emptyBook)).toBe(true);
    const betaYes = body.outcomes[2]!.sides[0];
    const betaNo = body.outcomes[2]!.sides[1];
    expect(betaYes.bestBid).toBe("0.20");
    expect(betaYes.bestAsk).toBeNull();
    expect(betaYes.midpointProbability).toBeNull();
    expect(betaYes.emptyBook).toBe(false);
    expect(betaNo.bestBid).toBeNull();
    expect(betaNo.bestAsk).toBe("0.81");
    expect(betaNo.midpointProbability).toBeNull();
    expect(betaNo.emptyBook).toBe(false);
    expect(typeof betaNo.fetchedAt).toBe("number");
  });

  it("GET /prediction/outcomes/:outcome/settlement returns unresolved state on null", async () => {
    const res = await app.inject({ method: "GET", url: "/prediction/outcomes/101/settlement" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PredictionSettlementState;
    expect(body).toMatchObject({
      outcome: 101,
      state: "unresolved",
      isResolved: false,
      resolvedSide: null,
      raw: null,
    });
    expect(typeof body.fetchedAt).toBe("number");
  });

  it("rejects unknown question and outcome ids", async () => {
    const question = await app.inject({ method: "GET", url: "/prediction/questions/999" });
    expect(question.statusCode).toBe(422);
    expect(question.json().error).toBe("INVALID_PARAMS");

    const outcome = await app.inject({ method: "GET", url: "/prediction/outcomes/999/odds" });
    expect(outcome.statusCode).toBe(422);
    expect(outcome.json().message).toContain("Unknown prediction outcome");
  });

  it("rejects malformed ids", async () => {
    const question = await app.inject({ method: "GET", url: "/prediction/questions/not-a-number" });
    expect(question.statusCode).toBe(422);
    expect(question.json()).toMatchObject({
      error: "INVALID_PARAMS",
      message: "Bad path parameter: questionId must be a non-negative integer.",
    });

    const outcome = await app.inject({ method: "GET", url: "/prediction/outcomes/-1/odds" });
    expect(outcome.statusCode).toBe(422);
    expect(outcome.json().message).toContain("outcome must be a non-negative integer");
  });

  it("returns a stable API error shape when Hyperliquid is unreachable", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));
    const res = await app.inject({ method: "GET", url: "/prediction/questions" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: "HL_EXCHANGE_UNREACHABLE",
      message: "Could not reach Hyperliquid.",
    });
  });

  it("returns guidance when upstream outcomeMeta has an unexpected shape", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonRes({ outcomes: [] }));
    const res = await app.inject({ method: "GET", url: "/prediction/questions" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: "HL_EXCHANGE_REJECTED",
      message: "Hyperliquid returned an unexpected outcomeMeta response.",
    });
  });
});
