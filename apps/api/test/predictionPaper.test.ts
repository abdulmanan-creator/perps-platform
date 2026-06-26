import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PredictionPaperAccount } from "@alchemy-hl/shared";

import { ApiException, sendError } from "../src/errors.js";
import { predictionPaperRoute } from "../src/routes/predictionPaper.js";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiException) return sendError(reply, err);
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: String(err) });
  });
  await predictionPaperRoute(app);
  return app;
}

const paperOrder = {
  questionId: 32,
  questionName: "2026 World Cup Champion",
  outcome: 173,
  outcomeName: "Argentina",
  side: 0,
  sideName: "Yes",
  contracts: 10,
  limitProbability: 0.15,
  currentProbability: 0.16,
  quoteToken: "USDC",
  criteriaAcknowledged: true,
};

describe("prediction paper routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("POST /prediction/paper-orders records a simulated fill without calling Hyperliquid", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await app.inject({
      method: "POST",
      url: "/prediction/paper-orders",
      headers: { "x-agent-trade-session-id": "prediction-paper-a" },
      payload: paperOrder,
    });

    expect(res.statusCode).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const body = res.json();
    expect(body.mode).toBe("paper");
    expect(body.fill).toMatchObject({
      mode: "paper",
      questionId: 32,
      outcome: 173,
      side: 0,
      contracts: 10,
      limitProbability: 0.15,
      cost: 1.5,
      maxPayout: 10,
      maxProfit: 8.5,
      maxLoss: 1.5,
      breakEvenProbability: 0.15,
    });
    expect(body.account.positions[0]).toMatchObject({
      mode: "paper",
      questionName: "2026 World Cup Champion",
      outcomeName: "Argentina",
      contracts: 10,
      avgCost: 0.15,
      currentValue: 1.6,
      unrealizedPnl: 0.1,
      resolutionStatus: "open",
    });
  });

  it("GET /prediction/paper-account returns session-scoped positions and fills", async () => {
    await app.inject({
      method: "POST",
      url: "/prediction/paper-orders",
      headers: { "x-agent-trade-session-id": "prediction-paper-b" },
      payload: paperOrder,
    });

    const sameSession = await app.inject({
      method: "GET",
      url: "/prediction/paper-account",
      headers: { "x-agent-trade-session-id": "prediction-paper-b" },
    });
    const otherSession = await app.inject({
      method: "GET",
      url: "/prediction/paper-account",
      headers: { "x-agent-trade-session-id": "prediction-paper-c" },
    });

    expect(sameSession.statusCode).toBe(200);
    expect((sameSession.json() as PredictionPaperAccount).positions).toHaveLength(1);
    expect((sameSession.json() as PredictionPaperAccount).fills).toHaveLength(1);
    expect((otherSession.json() as PredictionPaperAccount).positions).toHaveLength(0);
  });

  it("keeps prediction paper account state across refreshes for the same in-memory API process", async () => {
    const headers = { "x-agent-trade-session-id": "prediction-paper-refresh" };
    await app.inject({
      method: "POST",
      url: "/prediction/paper-orders",
      headers,
      payload: paperOrder,
    });

    const firstRefresh = await app.inject({
      method: "GET",
      url: "/prediction/paper-account",
      headers,
    });
    const secondRefresh = await app.inject({
      method: "GET",
      url: "/prediction/paper-account",
      headers,
    });

    expect(firstRefresh.statusCode).toBe(200);
    expect(secondRefresh.statusCode).toBe(200);
    expect(firstRefresh.json()).toMatchObject(secondRefresh.json());
    expect((secondRefresh.json() as PredictionPaperAccount).fills[0]).toMatchObject({
      questionId: 32,
      outcomeName: "Argentina",
      mode: "paper",
    });
  });

  it("nets repeated same-market buys into one paper exposure", async () => {
    const headers = { "x-agent-trade-session-id": "prediction-paper-repeat" };
    await app.inject({
      method: "POST",
      url: "/prediction/paper-orders",
      headers,
      payload: paperOrder,
    });
    const second = await app.inject({
      method: "POST",
      url: "/prediction/paper-orders",
      headers,
      payload: {
        ...paperOrder,
        contracts: 20,
        limitProbability: 0.2,
        currentProbability: 0.25,
      },
    });

    expect(second.statusCode).toBe(200);
    const account = second.json().account as PredictionPaperAccount;
    expect(account.positions).toHaveLength(1);
    expect(account.positions[0]).toMatchObject({
      contracts: 30,
      totalCost: 5.5,
      avgCost: 0.183333,
      currentValue: 7.5,
      unrealizedPnl: 2,
      maxPayout: 30,
    });
    expect(account.fills).toHaveLength(2);
  });

  it("requires explicit resolution-criteria acknowledgement", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/prediction/paper-orders",
      payload: {
        ...paperOrder,
        criteriaAcknowledged: false,
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: "INVALID_PARAMS",
    });
  });
});
