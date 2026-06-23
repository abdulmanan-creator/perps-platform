/**
 * /agent/exchange tests — the server-side agent-signing path.
 *
 * We mock @privy-io/server-auth to skip real JWT verification (it'd need a
 * Privy app + a fresh-minted token per test, neither of which we want in
 * unit tests). The mock returns a fixed user with a wallet, lets us assert
 * the rest of the pipeline:
 *
 *   - Missing/malformed Authorization → 403 NOT_APPROVED
 *   - Action validated by ActionSchema
 *   - approveBuilderFee / approveAgent refused (must come from user's key)
 *   - Order action has builder injected, gets agent-signed, forwarded to HL
 *   - Cancel action gets agent-signed and forwarded
 *   - HL's response is passed through as exchangeResponse
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

// Mock @privy-io/server-auth so verifyAuthToken returns a stub user whose
// linkedAccounts include an embedded wallet at USER. Hooked early so the
// import in privyAuth.ts picks up the mock.
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
        linkedAccounts: [
          { type: "wallet", address: USER, walletClientType: "privy" },
        ],
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
  orders: [
    { a: 0, b: true, p: "60000", s: "0.001", r: false, t: { limit: { tif: "Ioc" } } },
  ],
};

const CANCEL_ACTION = {
  type: "cancel",
  cancels: [{ a: 0, o: 123456 }],
};

describe("POST /agent/exchange", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("rejects request with no Authorization header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/exchange",
      payload: { action: ORDER_ACTION },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("NOT_APPROVED");
  });

  it("rejects malformed Authorization header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/exchange",
      headers: { authorization: "Token foo" },
      payload: { action: ORDER_ACTION },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an invalid JWT", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/exchange",
      headers: { authorization: "Bearer bad-token" },
      payload: { action: ORDER_ACTION },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/verification failed/i);
  });

  it("agent-signs an order, injects builder, forwards to HL", async () => {
    let hlBody: { action?: { builder?: { b: string; f: number } }; signature?: { v: number } } | undefined;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_url, init) => {
        hlBody = JSON.parse((init?.body as string) ?? "{}");
        return new Response(
          JSON.stringify({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 99 } }] } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

    const res = await app.inject({
      method: "POST",
      url: "/agent/exchange",
      headers: AUTH_HEADERS,
      payload: { action: ORDER_ACTION },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.user).toBe(USER);

    // The action HL received had our builder injected.
    expect(hlBody?.action?.builder?.b).toBeTruthy();
    // f is in tenths of bps on the wire (40 = 4 bps).
    expect(hlBody?.action?.builder?.f).toBe(40);
    // Signature v normalized to 27 or 28.
    expect([27, 28]).toContain(hlBody?.signature?.v);

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("agent-signs a cancel and forwards to HL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/agent/exchange",
      headers: AUTH_HEADERS,
      payload: { action: CANCEL_ACTION },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it("refuses approveBuilderFee on the agent path", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/exchange",
      headers: AUTH_HEADERS,
      payload: { action: { type: "approveBuilderFee", maxFeeRate: "1%" } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/cannot be agent-signed/);
  });

  it("refuses approveAgent on the agent path", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/exchange",
      headers: AUTH_HEADERS,
      payload: { action: { type: "approveAgent" } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/cannot be agent-signed/);
  });

  it("rejects bad action shape with INVALID_PARAMS", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/exchange",
      headers: AUTH_HEADERS,
      payload: { action: { type: "order", grouping: "na", orders: [] } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("INVALID_PARAMS");
  });
});
