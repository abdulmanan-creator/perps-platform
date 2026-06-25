import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import type { BuildResponse, OrderAction, UpdateLeverageAction } from "@alchemy-hl/shared";

import { loadConfig, type Config } from "../src/config.js";
import { ApiException, sendError } from "../src/errors.js";
import {
  assertAgentTradeExchangeAllowed,
  eligibilityForRequest,
  recordAgentTradeNotional,
  resetAgentTradeNotionalForTests,
} from "../src/helpers/agentTradeSafety.js";
import { agentRoute } from "../src/routes/agent.js";
import { agentTradeRoute } from "../src/routes/agentTrade.js";
import { exchangeRoute } from "../src/routes/exchange.js";

const USER = "0xcccc000000000000000000000000000000000001" as const;
const SEED = "0x1111111111111111111111111111111111111111111111111111111111111111";

const baseEnv = {
  ALCHEMY_BUILDER_ADDRESS: "0xAAAA000000000000000000000000000000000001",
  HYPERLIQUID_API_URL: "https://api.hyperliquid-testnet.xyz",
  PERPS_BUILDER_FEE_BPS: "4",
  SPOT_BUILDER_FEE_BPS: "5",
  AGENT_MASTER_SEED: SEED,
  PRIVY_APP_ID: "test-app-id",
  PRIVY_APP_SECRET: "test-secret",
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
        linkedAccounts: [{ type: "wallet", address: USER, walletClientType: "privy" }],
      };
    }
  }
  return { PrivyClient: MockPrivyClient };
});

function cfg(extra: Record<string, string> = {}): Config {
  return loadConfig({ ...baseEnv, ...extra } as NodeJS.ProcessEnv);
}

function req(headers: Record<string, string> = {}, ip = "127.0.0.1"): FastifyRequest {
  return { headers, ip } as unknown as FastifyRequest;
}

function ackHeaders(country = "CA"): Record<string, string> {
  return {
    "cf-ipcountry": country,
    "x-agent-trade-risk-accepted": "true",
    "x-agent-trade-terms-accepted": "true",
  };
}

function order(price = 1000, size = 0.01): OrderAction {
  return {
    type: "order",
    grouping: "na",
    orders: [
      {
        a: 0,
        b: true,
        p: String(price),
        s: String(size),
        r: false,
        t: { limit: { tif: "Ioc" } },
      },
    ],
  };
}

function updateLeverage(): UpdateLeverageAction {
  return {
    type: "updateLeverage",
    asset: 0,
    isCross: false,
    leverage: 3,
  };
}

async function appWithConfig(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("config", config);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiException) return sendError(reply, err);
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: String(err) });
  });
  return app;
}

function splitHexSig(hex: `0x${string}`): { r: `0x${string}`; s: `0x${string}`; v: number } {
  const stripped = hex.replace(/^0x/, "");
  let v = parseInt(stripped.slice(128, 130), 16);
  if (v < 27) v += 27;
  return {
    r: `0x${stripped.slice(0, 64)}` as `0x${string}`,
    s: `0x${stripped.slice(64, 128)}` as `0x${string}`,
    v,
  };
}

async function signBuiltAction(built: BuildResponse) {
  const account = privateKeyToAccount(generatePrivateKey());
  if (!built.typedData) {
    throw new Error("missing typedData");
  }
  const sigHex = await account.signTypedData({
    domain: built.typedData.domain,
    types: built.typedData.types,
    primaryType: built.typedData.primaryType,
    message: built.typedData.message,
  });
  return splitHexSig(sigHex);
}

describe("Agent.trade safety helper", () => {
  afterEach(() => {
    resetAgentTradeNotionalForTests();
  });

  it("restricted jurisdiction blocks live order guard", () => {
    expect(() =>
      assertAgentTradeExchangeAllowed({
        req: req(ackHeaders("US")),
        cfg: cfg(),
        action: order(),
        user: USER,
      }),
    ).toThrow(/not eligible/i);
  });

  it("unknown eligibility blocks live order guard", () => {
    expect(eligibilityForRequest(req(), cfg())).toBe("unknown");
    expect(() =>
      assertAgentTradeExchangeAllowed({
        req: req(),
        cfg: cfg(),
        action: order(),
        user: USER,
      }),
    ).toThrow(/eligibility is unknown/i);
  });

  it("kill switch blocks live order guard", () => {
    expect(() =>
      assertAgentTradeExchangeAllowed({
        req: req(ackHeaders()),
        cfg: cfg({ AGENT_TRADE_LIVE_TRADING_KILL_SWITCH: "true" }),
        action: order(),
        user: USER,
      }),
    ).toThrow(/kill switch/i);
  });

  it("missing risk and terms acknowledgement blocks when required", () => {
    expect(() =>
      assertAgentTradeExchangeAllowed({
        req: req({ "cf-ipcountry": "CA" }),
        cfg: cfg(),
        action: order(),
        user: USER,
      }),
    ).toThrow(/acknowledgement/i);
  });

  it("minimum order notional blocks orders below Hyperliquid minimum", () => {
    expect(() =>
      assertAgentTradeExchangeAllowed({
        req: req(ackHeaders()),
        cfg: cfg(),
        action: order(1000, 0.009),
        user: USER,
      }),
    ).toThrow(/minimum trade size/i);
  });

  it("per-order notional cap blocks oversized orders", () => {
    expect(() =>
      assertAgentTradeExchangeAllowed({
        req: req(ackHeaders()),
        cfg: cfg({ AGENT_TRADE_ORDER_NOTIONAL_CAP_USD: "50" }),
        action: order(1000, 0.06),
        user: USER,
      }),
    ).toThrow(/per-order notional cap/i);
  });

  it("disabled per-order cap defers oversized order rejection downstream", () => {
    expect(() =>
      assertAgentTradeExchangeAllowed({
        req: req(ackHeaders()),
        cfg: cfg({
          AGENT_TRADE_ORDER_NOTIONAL_CAP_USD: "0",
          AGENT_TRADE_DAILY_NOTIONAL_CAP_USD: "0",
        }),
        action: order(1000, 100),
        user: USER,
      }),
    ).not.toThrow();
  });

  it("daily notional cap blocks after recorded usage", () => {
    const config = cfg({ AGENT_TRADE_DAILY_NOTIONAL_CAP_USD: "100" });
    const request = req(ackHeaders());
    const firstOrder = order(1000, 0.06);
    const secondOrder = order(1000, 0.06);

    assertAgentTradeExchangeAllowed({ req: request, cfg: config, action: firstOrder, user: USER });
    recordAgentTradeNotional({ req: request, action: firstOrder, user: USER });

    expect(() =>
      assertAgentTradeExchangeAllowed({
        req: request,
        cfg: config,
        action: secondOrder,
        user: USER,
      }),
    ).toThrow(/daily notional cap/i);
  });

  it("disabled daily cap allows usage above the optional product throttle", () => {
    const config = cfg({
      AGENT_TRADE_ORDER_NOTIONAL_CAP_USD: "0",
      AGENT_TRADE_DAILY_NOTIONAL_CAP_USD: "0",
    });
    const request = req(ackHeaders());
    const firstOrder = order(1000, 100);
    const secondOrder = order(1000, 100);

    assertAgentTradeExchangeAllowed({ req: request, cfg: config, action: firstOrder, user: USER });
    recordAgentTradeNotional({ req: request, action: firstOrder, user: USER });

    expect(() =>
      assertAgentTradeExchangeAllowed({
        req: request,
        cfg: config,
        action: secondOrder,
        user: USER,
      }),
    ).not.toThrow();
  });

  it("mainnet execution disabled blocks order actions", () => {
    expect(() =>
      assertAgentTradeExchangeAllowed({
        req: req(ackHeaders()),
        cfg: cfg({ HYPERLIQUID_API_URL: "https://api.hyperliquid.xyz" }),
        action: order(),
        user: USER,
      }),
    ).toThrow(/Mainnet order execution is disabled/i);
  });

  it("eligible acknowledged users may pass Agent.trade mainnet policy without internal allowlist", () => {
    expect(() =>
      assertAgentTradeExchangeAllowed({
        req: req(ackHeaders()),
        cfg: cfg({
          HYPERLIQUID_API_URL: "https://api.hyperliquid.xyz",
          AGENT_TRADE_MAINNET_EXECUTION_ENABLED: "true",
          AGENT_TRADE_ORDER_NOTIONAL_CAP_USD: "0",
          AGENT_TRADE_DAILY_NOTIONAL_CAP_USD: "0",
        }),
        action: order(),
        user: USER,
      }),
    ).not.toThrow();
  });

  it("unknown eligibility blocks updateLeverage guard", () => {
    expect(() =>
      assertAgentTradeExchangeAllowed({
        req: req(),
        cfg: cfg(),
        action: updateLeverage(),
        user: USER,
      }),
    ).toThrow(/eligibility is unknown/i);
  });

  it("restricted jurisdiction blocks updateLeverage guard", () => {
    expect(() =>
      assertAgentTradeExchangeAllowed({
        req: req(ackHeaders("US")),
        cfg: cfg(),
        action: updateLeverage(),
        user: USER,
      }),
    ).toThrow(/not eligible/i);
  });
});

describe("Agent.trade route safety", () => {
  afterEach(() => {
    resetAgentTradeNotionalForTests();
    vi.restoreAllMocks();
  });

  it("paper order path does not call Hyperliquid exchange", async () => {
    const app = await appWithConfig(cfg());
    await agentTradeRoute(app);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await app.inject({
      method: "POST",
      url: "/agent-trade/paper-orders",
      payload: {
        draft: {
          symbol: "BTC-USD",
          side: "long",
          orderType: "market",
          sizeBtc: 0.01,
          leverage: 2,
          marginMode: "isolated",
          reduceOnly: false,
          fromAgent: true,
        },
        estimatedEntry: 60000,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe("paper");
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("paper POST records a fill and position for a session", async () => {
    const app = await appWithConfig(cfg());
    await agentTradeRoute(app);

    const res = await app.inject({
      method: "POST",
      url: "/agent-trade/paper-orders",
      headers: { "x-agent-trade-session-id": "session-paper-a" },
      payload: {
        draft: {
          symbol: "BTC-USD",
          side: "long",
          orderType: "market",
          sizeBtc: 0.02,
          leverage: 2,
          marginMode: "isolated",
          reduceOnly: false,
          fromAgent: false,
        },
        estimatedEntry: 60000,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fill.mode).toBe("paper");
    expect(body.fill.side).toBe("buy");
    expect(body.account.positions[0]).toMatchObject({
      symbol: "BTC-USD",
      side: "long",
      mode: "paper",
      size: 0.02,
      entryPrice: 60000,
    });
    expect(body.account.fills).toHaveLength(1);
    await app.close();
  });

  it("paper GET returns subsequent fills and positions for the same session", async () => {
    const app = await appWithConfig(cfg());
    await agentTradeRoute(app);

    await app.inject({
      method: "POST",
      url: "/agent-trade/paper-orders",
      headers: { "x-agent-trade-session-id": "session-paper-b" },
      payload: {
        draft: {
          symbol: "ETH-USD",
          side: "short",
          orderType: "market",
          sizeBtc: 1.5,
          leverage: 3,
          marginMode: "cross",
          reduceOnly: false,
          fromAgent: true,
        },
        estimatedEntry: 3000,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/agent-trade/paper-account",
      headers: { "x-agent-trade-session-id": "session-paper-b" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessionId).toBe("session-paper-b");
    expect(body.positions[0]).toMatchObject({ symbol: "ETH-USD", side: "short", mode: "paper" });
    expect(body.fills[0]).toMatchObject({ symbol: "ETH-USD", side: "sell", fromAgent: true });
    await app.close();
  });

  it("paper ledger nets repeated same-side market orders into one larger position", async () => {
    const app = await appWithConfig(cfg());
    await agentTradeRoute(app);
    const headers = { "x-agent-trade-session-id": "session-paper-repeat-long" };

    const first = await app.inject({
      method: "POST",
      url: "/agent-trade/paper-orders",
      headers,
      payload: {
        draft: {
          symbol: "BTC-USD",
          side: "long",
          orderType: "market",
          sizeBtc: 0.01,
          leverage: 2,
          marginMode: "isolated",
          reduceOnly: false,
          fromAgent: false,
        },
        estimatedEntry: 100000,
      },
    });
    const firstBody = first.json();

    const second = await app.inject({
      method: "POST",
      url: "/agent-trade/paper-orders",
      headers,
      payload: {
        draft: {
          symbol: "BTC-USD",
          side: "long",
          orderType: "market",
          sizeBtc: 0.02,
          leverage: 2,
          marginMode: "isolated",
          reduceOnly: false,
          fromAgent: true,
        },
        estimatedEntry: 110000,
      },
    });

    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.account.fills).toHaveLength(2);
    expect(body.account.positions).toHaveLength(1);
    expect(body.account.positions[0]).toMatchObject({
      symbol: "BTC-USD",
      side: "long",
      size: 0.03,
      entryPrice: 106666.67,
      markPrice: 110000,
      orderCount: 2,
      lastFillId: body.id,
    });
    expect(body.account.positions[0].marginUsd).toBe(1650);
    expect(body.account.availableUsd).toBeLessThan(firstBody.account.availableUsd);
    await app.close();
  });

  it("paper ledger reduces and flips positions with opposite-side market orders", async () => {
    const app = await appWithConfig(cfg());
    await agentTradeRoute(app);
    const headers = { "x-agent-trade-session-id": "session-paper-repeat-flip" };

    await app.inject({
      method: "POST",
      url: "/agent-trade/paper-orders",
      headers,
      payload: {
        draft: {
          symbol: "BTC-USD",
          side: "long",
          orderType: "market",
          sizeBtc: 0.03,
          leverage: 3,
          marginMode: "cross",
          reduceOnly: false,
          fromAgent: false,
        },
        estimatedEntry: 100000,
      },
    });

    const reduced = await app.inject({
      method: "POST",
      url: "/agent-trade/paper-orders",
      headers,
      payload: {
        draft: {
          symbol: "BTC-USD",
          side: "short",
          orderType: "market",
          sizeBtc: 0.01,
          leverage: 5,
          marginMode: "isolated",
          reduceOnly: false,
          fromAgent: false,
        },
        estimatedEntry: 110000,
      },
    });

    expect(reduced.statusCode).toBe(200);
    expect(reduced.json().account.positions[0]).toMatchObject({
      side: "long",
      size: 0.02,
      entryPrice: 100000,
      markPrice: 110000,
      leverage: 3,
      marginMode: "cross",
      orderCount: 2,
    });

    const flipped = await app.inject({
      method: "POST",
      url: "/agent-trade/paper-orders",
      headers,
      payload: {
        draft: {
          symbol: "BTC-USD",
          side: "short",
          orderType: "market",
          sizeBtc: 0.05,
          leverage: 4,
          marginMode: "isolated",
          reduceOnly: false,
          fromAgent: true,
        },
        estimatedEntry: 90000,
      },
    });

    expect(flipped.statusCode).toBe(200);
    const body = flipped.json();
    expect(body.account.fills).toHaveLength(3);
    expect(body.account.positions[0]).toMatchObject({
      side: "short",
      size: 0.03,
      entryPrice: 90000,
      markPrice: 90000,
      orderCount: 3,
      lastFillId: body.id,
    });
    await app.close();
  });

  it("paper reduce-only close records a fill and removes the closed position without Hyperliquid exchange", async () => {
    const app = await appWithConfig(cfg());
    await agentTradeRoute(app);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const headers = { "x-agent-trade-session-id": "session-paper-close-long" };

    await app.inject({
      method: "POST",
      url: "/agent-trade/paper-orders",
      headers,
      payload: {
        draft: {
          symbol: "HYPE-USD",
          side: "long",
          orderType: "market",
          sizeBtc: 0.16,
          leverage: 5,
          marginMode: "isolated",
          reduceOnly: false,
          fromAgent: false,
        },
        estimatedEntry: 64.24,
      },
    });

    const close = await app.inject({
      method: "POST",
      url: "/agent-trade/paper-orders",
      headers,
      payload: {
        draft: {
          symbol: "HYPE-USD",
          side: "short",
          orderType: "market",
          sizeBtc: 0.16,
          leverage: 5,
          marginMode: "isolated",
          reduceOnly: true,
          fromAgent: false,
        },
        estimatedEntry: 64.25,
      },
    });

    expect(close.statusCode).toBe(200);
    const body = close.json();
    expect(body.fill).toMatchObject({ symbol: "HYPE-USD", side: "sell", mode: "paper", size: 0.16 });
    expect(body.account.positions).toHaveLength(0);
    expect(body.account.fills).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("paper ledgers are isolated by session id", async () => {
    const app = await appWithConfig(cfg());
    await agentTradeRoute(app);

    await app.inject({
      method: "POST",
      url: "/agent-trade/paper-orders",
      headers: { "x-agent-trade-session-id": "session-paper-c" },
      payload: {
        draft: {
          symbol: "BTC-USD",
          side: "long",
          orderType: "market",
          sizeBtc: 0.01,
          leverage: 2,
          marginMode: "isolated",
          reduceOnly: false,
          fromAgent: false,
        },
        estimatedEntry: 60000,
      },
    });

    const other = await app.inject({
      method: "GET",
      url: "/agent-trade/paper-account",
      headers: { "x-agent-trade-session-id": "session-paper-d" },
    });

    expect(other.statusCode).toBe(200);
    expect(other.json().positions).toHaveLength(0);
    expect(other.json().fills).toHaveLength(0);
    await app.close();
  });

  it("/agent-trade/exchange is guarded while generic /exchange remains backward-compatible", async () => {
    const app = await appWithConfig(cfg());
    await exchangeRoute(app);
    await agentTradeRoute(app);

    const guarded = await app.inject({
      method: "POST",
      url: "/agent-trade/exchange",
      payload: { action: order() },
    });
    expect(guarded.statusCode).toBe(451);
    expect(guarded.json().message).toMatch(/eligibility is unknown/i);

    const generic = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { action: order() },
    });
    expect(generic.statusCode).toBe(200);
    expect(generic.json().typedData).toBeTruthy();
    await app.close();
  });

  it("/agent/exchange order actions are covered by the same safety model", async () => {
    const app = await appWithConfig(cfg());
    await agentRoute(app);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await app.inject({
      method: "POST",
      url: "/agent/exchange",
      headers: { authorization: "Bearer good-token" },
      payload: { action: order() },
    });

    expect(res.statusCode).toBe(451);
    expect(res.json().message).toMatch(/eligibility is unknown/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("unknown eligibility blocks updateLeverage on /agent-trade/exchange", async () => {
    const app = await appWithConfig(cfg());
    await agentTradeRoute(app);

    const res = await app.inject({
      method: "POST",
      url: "/agent-trade/exchange",
      payload: { action: updateLeverage() },
    });

    expect(res.statusCode).toBe(451);
    expect(res.json().message).toMatch(/eligibility is unknown/i);
    await app.close();
  });

  it("restricted eligibility blocks updateLeverage on /agent-trade/exchange", async () => {
    const app = await appWithConfig(cfg());
    await agentTradeRoute(app);

    const res = await app.inject({
      method: "POST",
      url: "/agent-trade/exchange",
      headers: ackHeaders("US"),
      payload: { action: updateLeverage() },
    });

    expect(res.statusCode).toBe(451);
    expect(res.json().message).toMatch(/not eligible/i);
    await app.close();
  });

  it("unknown eligibility blocks updateLeverage on /agent/exchange", async () => {
    const app = await appWithConfig(cfg());
    await agentRoute(app);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await app.inject({
      method: "POST",
      url: "/agent/exchange",
      headers: { authorization: "Bearer good-token" },
      payload: { action: updateLeverage() },
    });

    expect(res.statusCode).toBe(451);
    expect(res.json().message).toMatch(/eligibility is unknown/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("restricted eligibility blocks updateLeverage on /agent/exchange", async () => {
    const app = await appWithConfig(cfg());
    await agentRoute(app);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await app.inject({
      method: "POST",
      url: "/agent/exchange",
      headers: { authorization: "Bearer good-token", ...ackHeaders("US") },
      payload: { action: updateLeverage() },
    });

    expect(res.statusCode).toBe(451);
    expect(res.json().message).toMatch(/not eligible/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("policy-rejected send can be retried after fixing headers without DUPLICATE_REQUEST", async () => {
    const app = await appWithConfig(cfg());
    await agentTradeRoute(app);

    const buildRes = await app.inject({
      method: "POST",
      url: "/agent-trade/exchange",
      headers: ackHeaders(),
      payload: { action: updateLeverage() },
    });
    expect(buildRes.statusCode).toBe(200);
    const built = buildRes.json() as BuildResponse;
    const signature = await signBuiltAction(built);
    const payload = { action: built.action, nonce: built.nonce, signature };

    const rejected = await app.inject({
      method: "POST",
      url: "/agent-trade/exchange",
      headers: { "cf-ipcountry": "CA" },
      payload,
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error).toBe("INVALID_PARAMS");
    expect(rejected.json().message).toMatch(/acknowledgement/i);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const retry = await app.inject({
      method: "POST",
      url: "/agent-trade/exchange",
      headers: ackHeaders(),
      payload,
    });

    expect(retry.statusCode).toBe(200);
    expect(retry.json().success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    await app.close();
  });
});
