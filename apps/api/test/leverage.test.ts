/**
 * updateLeverage tests:
 *   - /exchange build phase produces L1 phantom-agent typed data
 *   - /agent/exchange enforces MAX_AGENT_LEVERAGE_PERPS cap
 *   - Schema rejects non-integer / too-low / too-high leverage
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { ApiException, sendError } from "../src/errors.js";
import { exchangeRoute } from "../src/routes/exchange.js";
import { agentRoute } from "../src/routes/agent.js";

const SEED = "0x1111111111111111111111111111111111111111111111111111111111111111";
const USER = "0xcccc000000000000000000000000000000000001" as const;
const AUTH_HEADERS = {
  authorization: "Bearer good",
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
  PRIVY_APP_ID: "test-app",
  PRIVY_APP_SECRET: "test-secret",
  MAX_AGENT_LEVERAGE_PERPS: "10",
} as unknown as NodeJS.ProcessEnv;

vi.mock("@privy-io/server-auth", () => {
  class MockPrivyClient {
    constructor(_appId: string, _secret: string) {}
    async verifyAuthToken(token: string) {
      if (token === "good") return { userId: "did:privy:test" };
      throw new Error("invalid token");
    }
    async getUser(_id: string) {
      return {
        id: "did:privy:test",
        linkedAccounts: [
          { type: "wallet", address: USER, walletClientType: "privy" },
        ],
      };
    }
  }
  return { PrivyClient: MockPrivyClient };
});

async function build(register: (a: FastifyInstance) => Promise<void>, env = baseEnv) {
  const cfg = loadConfig(env);
  const app = Fastify({ logger: false });
  app.decorate("config", cfg);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiException) return sendError(reply, err);
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: String(err) });
  });
  await register(app);
  return app;
}

describe("/exchange build for updateLeverage", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await build(exchangeRoute);
  });
  afterEach(async () => {
    await app.close();
  });

  it("builds an L1 phantom-agent envelope for updateLeverage", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: {
        action: { type: "updateLeverage", asset: 0, isCross: true, leverage: 5 },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.action).toEqual({
      type: "updateLeverage",
      asset: 0,
      isCross: true,
      leverage: 5,
    });
    expect(body.typedData.primaryType).toBe("Agent");
    expect(body.typedData.domain.chainId).toBe(1337);
  });

  it("rejects non-integer leverage", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: {
        action: { type: "updateLeverage", asset: 0, isCross: true, leverage: 5.5 },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects leverage above 50", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: {
        action: { type: "updateLeverage", asset: 0, isCross: true, leverage: 100 },
      },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("/agent/exchange leverage cap", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await build(agentRoute);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("accepts leverage at or under the cap (10x)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/exchange",
      headers: AUTH_HEADERS,
      payload: {
        action: { type: "updateLeverage", asset: 0, isCross: true, leverage: 10 },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it("refuses leverage above the cap", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/exchange",
      headers: AUTH_HEADERS,
      payload: {
        action: { type: "updateLeverage", asset: 0, isCross: true, leverage: 25 },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/exceeds the agent-path cap/);
  });
});
