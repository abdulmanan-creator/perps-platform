/**
 * /agent/exchange idempotency.
 *
 * The agent path mints a fresh nonce per request, so a blind client retry
 * (Claude re-running a tool call that "timed out") would double-trade.
 * `idempotencyKey` in the body dedupes: repeats within the window get the
 * original response back without a second HL forward.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { ApiException, sendError } from "../src/errors.js";
import { agentRoute } from "../src/routes/agent.js";

const USER = "0xcccc000000000000000000000000000000000001" as const;
const SEED = "0x1111111111111111111111111111111111111111111111111111111111111111";
const AUTH_HEADERS = {
  authorization: "Bearer good-token",
  "cf-ipcountry": "CA",
  "x-agent-trade-risk-accepted": "true",
  "x-agent-trade-terms-accepted": "true",
};

const baseEnv = {
  ALCHEMY_BUILDER_ADDRESS: "0xAAAA000000000000000000000000000000000001",
  HYPERLIQUID_API_URL: "https://api.hyperliquid-testnet.xyz",
  PERPS_BUILDER_FEE_BPS: "4",
  SPOT_BUILDER_FEE_BPS: "5",
  AGENT_MASTER_SEED: SEED,
  PRIVY_APP_ID: "test-app-id",
  PRIVY_APP_SECRET: "test-secret",
  AGENT_TRADE_REQUIRE_GEO_ELIGIBILITY: "false",
  AGENT_TRADE_REQUIRE_RISK_ACK: "false",
} as unknown as NodeJS.ProcessEnv;

vi.mock("@privy-io/server-auth", () => {
  class MockPrivyClient {
    constructor(_appId: string, _secret: string) {}
    async verifyAuthToken(token: string) {
      if (token === "good-token") return { userId: "did:privy:test" };
      throw new Error("invalid token");
    }
    async getUser(_id: string) {
      return {
        id: "did:privy:test",
        email: { address: "test@example.com" },
        linkedAccounts: [{ type: "wallet", address: USER, walletClientType: "privy" }],
      };
    }
  }
  return { PrivyClient: MockPrivyClient };
});

async function buildApp(): Promise<FastifyInstance> {
  const cfg = loadConfig(baseEnv);
  const app = Fastify({ logger: false });
  app.decorate("config", cfg);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiException) return sendError(reply, err);
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: String(err) });
  });
  await agentRoute(app);
  return app;
}

const ORDER_ACTION = {
  type: "order",
  grouping: "na",
  orders: [{ a: 0, b: true, p: "60000", s: "0.001", r: false, t: { limit: { tif: "Ioc" } } }],
};

const HL_OK = () =>
  new Response(JSON.stringify({ status: "ok", response: { type: "order" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function post(app: FastifyInstance, payload: unknown) {
  return app.inject({
    method: "POST",
    url: "/agent/exchange",
    headers: AUTH_HEADERS,
    payload: payload as Record<string, unknown>,
  });
}

describe("/agent/exchange idempotency", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("same idempotencyKey → one HL forward, identical responses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(HL_OK());
    const payload = { action: ORDER_ACTION, idempotencyKey: "order-abc-1" };

    const first = await post(app, payload);
    const second = await post(app, payload);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("different keys → separate HL forwards", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(HL_OK());

    await post(app, { action: ORDER_ACTION, idempotencyKey: "order-1" });
    await post(app, { action: ORDER_ACTION, idempotencyKey: "order-2" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("no key → every request forwards (current behavior, caller opts in)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(HL_OK());

    await post(app, { action: ORDER_ACTION });
    await post(app, { action: ORDER_ACTION });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("failed execution is not cached — retry with the same key re-executes", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(HL_OK());
    const payload = { action: ORDER_ACTION, idempotencyKey: "order-retry" };

    const first = await post(app, payload);
    expect(first.statusCode).toBe(502);

    const retry = await post(app, payload);
    expect(retry.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects oversize keys", async () => {
    const res = await post(app, {
      action: ORDER_ACTION,
      idempotencyKey: "x".repeat(129),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("INVALID_PARAMS");
  });
});
