import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { ApiException, sendError } from "../src/errors.js";
import { resetAuditDbForTests, setAuditDbForTests } from "../src/helpers/agentTradeAudit.js";
import { setGaslessDepositRuntimeForTests } from "../src/helpers/gaslessHlDeposit.js";
import {
  agentTradeDepositRoute,
  resetAgentTradeDepositRateLimitForTests,
} from "../src/routes/agentTradeDeposit.js";

const USER = "0xcccc000000000000000000000000000000000001" as const;
const OTHER = "0xcccc000000000000000000000000000000000002" as const;
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const BRIDGE = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7" as const;
const TX_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const RELAYER_KEY = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const baseEnv = {
  ALCHEMY_BUILDER_ADDRESS: "0xAAAA000000000000000000000000000000000001",
  HYPERLIQUID_API_URL: "https://api.hyperliquid.xyz",
  PERPS_BUILDER_FEE_BPS: "4",
  SPOT_BUILDER_FEE_BPS: "5",
  PRIVY_APP_ID: "test-app-id",
  PRIVY_APP_SECRET: "test-secret",
  AGENT_TRADE_ENABLE_GASLESS_HL_DEPOSIT: "true",
  AGENT_TRADE_GASLESS_DEPOSIT_ALLOWED_WALLETS: USER,
  AGENT_TRADE_DEPOSIT_RELAYER_PRIVATE_KEY: RELAYER_KEY,
  AGENT_TRADE_MAINNET_EXECUTION_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;

vi.mock("@privy-io/server-auth", () => {
  class MockPrivyClient {
    constructor(_appId: string, _secret: string) {}
    async verifyAuthToken(token: string) {
      if (token === "good-token") {
        return { userId: "did:privy:test" };
      }
      throw new Error("invalid token");
    }
    async getUser(_id: string) {
      return {
        id: "did:privy:test",
        linkedAccounts: [{ type: "wallet", address: USER, walletClientType: "privy" }],
      };
    }
  }
  return { PrivyClient: MockPrivyClient };
});

function cfg(extra: Record<string, string> = {}): Config {
  return loadConfig({ ...baseEnv, ...extra } as NodeJS.ProcessEnv);
}

async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("config", config);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiException) {
      return sendError(reply, err);
    }
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: String(err) });
  });
  await agentTradeDepositRoute(app);
  return app;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    owner: USER,
    token: USDC,
    spender: BRIDGE,
    amount: "5000000",
    deadline: 1_700_000_600,
    signature: {
      r: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      s: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      v: 27,
    },
    ...overrides,
  };
}

function liveHeaders(country = "CA") {
  return {
    authorization: "Bearer good-token",
    "cf-ipcountry": country,
  };
}

describe("Agent.trade gasless Hyperliquid deposit route", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    setGaslessDepositRuntimeForTests({
      nowSeconds: () => 1_700_000_000,
      readUsdcBalance: async () => 20_000_000n,
      submitBridgeDeposit: async () => TX_HASH,
    });
    app = await buildApp(cfg());
  });

  afterEach(async () => {
    await app.close();
    setGaslessDepositRuntimeForTests(undefined);
    resetAgentTradeDepositRateLimitForTests();
    resetAuditDbForTests();
    vi.restoreAllMocks();
  });

  it("reports disabled status when the backend flag is off", async () => {
    await app.close();
    app = await buildApp(cfg({ AGENT_TRADE_ENABLE_GASLESS_HL_DEPOSIT: "false" }));

    const res = await app.inject({
      method: "GET",
      url: `/agent-trade/deposit/status?user=${USER}`,
      headers: liveHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
    expect(res.json().reason).toMatch(/not enabled/i);
  });

  it("blocks relays when the backend flag is off", async () => {
    await app.close();
    app = await buildApp(cfg({ AGENT_TRADE_ENABLE_GASLESS_HL_DEPOSIT: "false" }));

    const res = await app.inject({
      method: "POST",
      url: "/agent-trade/deposit/permit",
      headers: liveHeaders(),
      payload: payload(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/not enabled/i);
  });

  it("blocks status and relays when the gasless allowlist is empty", async () => {
    await app.close();
    let submitted = false;
    setGaslessDepositRuntimeForTests({
      nowSeconds: () => 1_700_000_000,
      readUsdcBalance: async () => 20_000_000n,
      submitBridgeDeposit: async () => {
        submitted = true;
        return TX_HASH;
      },
    });
    app = await buildApp(cfg({ AGENT_TRADE_GASLESS_DEPOSIT_ALLOWED_WALLETS: "" }));

    const status = await app.inject({
      method: "GET",
      url: `/agent-trade/deposit/status?user=${USER}`,
      headers: liveHeaders(),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      enabled: false,
      allowed: false,
    });
    expect(status.json().reason).toMatch(/not allowlisted/i);

    const res = await app.inject({
      method: "POST",
      url: "/agent-trade/deposit/permit",
      headers: liveHeaders(),
      payload: payload(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/not allowlisted/i);
    expect(submitted).toBe(false);
  });

  it("blocks non-allowlisted live-eligible wallets before relay submission", async () => {
    await app.close();
    let submitted = false;
    setGaslessDepositRuntimeForTests({
      nowSeconds: () => 1_700_000_000,
      readUsdcBalance: async () => 20_000_000n,
      submitBridgeDeposit: async () => {
        submitted = true;
        return TX_HASH;
      },
    });
    app = await buildApp(cfg({ AGENT_TRADE_GASLESS_DEPOSIT_ALLOWED_WALLETS: OTHER }));

    const res = await app.inject({
      method: "POST",
      url: "/agent-trade/deposit/permit",
      headers: liveHeaders(),
      payload: payload(),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/not allowlisted/i);
    expect(submitted).toBe(false);
  });

  it("lets allowlisted wallets proceed to existing validation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent-trade/deposit/permit",
      headers: liveHeaders(),
      payload: payload({ amount: "4999999" }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/minimum deposit is 5 USDC/i);
  });

  it("blocks restricted and unknown users", async () => {
    const restricted = await app.inject({
      method: "POST",
      url: "/agent-trade/deposit/permit",
      headers: liveHeaders("US"),
      payload: payload(),
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/agent-trade/deposit/permit",
      headers: { authorization: "Bearer good-token" },
      payload: payload(),
    });

    expect(restricted.statusCode).toBe(451);
    expect(unknown.statusCode).toBe(451);
  });

  it("blocks owner, spender, token, amount, and expired-deadline mismatches", async () => {
    const cases = [
      payload({ owner: OTHER }),
      payload({ token: OTHER }),
      payload({ spender: OTHER }),
      payload({ amount: "4999999" }),
      payload({ deadline: 1_699_999_999 }),
      payload({ deadline: 1_700_002_000 }),
    ];

    for (const body of cases) {
      const res = await app.inject({
        method: "POST",
        url: "/agent-trade/deposit/permit",
        headers: liveHeaders(),
        payload: body,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
  });

  it("blocks deposits above current native Arbitrum USDC balance", async () => {
    setGaslessDepositRuntimeForTests({
      nowSeconds: () => 1_700_000_000,
      readUsdcBalance: async () => 1_000_000n,
      submitBridgeDeposit: async () => TX_HASH,
    });

    const res = await app.inject({
      method: "POST",
      url: "/agent-trade/deposit/permit",
      headers: liveHeaders(),
      payload: payload(),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/exceeds native Arbitrum USDC balance/i);
  });

  it("returns a tx hash for a successful mocked relay", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent-trade/deposit/permit",
      headers: liveHeaders(),
      payload: payload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "submitted",
      txHash: TX_HASH,
      amount: "5000000",
    });
    expect(res.json().owner.toLowerCase()).toBe(USER.toLowerCase());
  });

  it("does not write raw permit signatures to audit payloads", async () => {
    const params: unknown[][] = [];
    setAuditDbForTests({
      async query(_text, queryParams) {
        params.push(queryParams ?? []);
        return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/agent-trade/deposit/permit",
      headers: liveHeaders(),
      payload: payload(),
    });

    expect(res.statusCode).toBe(200);
    const serialized = JSON.stringify(params);
    expect(serialized).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(serialized).not.toContain("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });
});
