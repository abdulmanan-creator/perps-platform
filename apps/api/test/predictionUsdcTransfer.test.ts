import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { PredictionUsdcTransferBuildResponse } from "@alchemy-hl/shared";

import { loadConfig } from "../src/config.js";
import { ApiException, sendError } from "../src/errors.js";
import { predictionUsdcTransferRoute } from "../src/routes/predictionUsdcTransfer.js";

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

async function buildApp(env: NodeJS.ProcessEnv = baseEnv): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("config", loadConfig(env));
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiException) return sendError(reply, err);
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: (err as Error).message });
  });
  await app.register(predictionUsdcTransferRoute);
  return app;
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockHyperliquid(args: {
  spotState?: unknown;
  perpState?: unknown;
  exchangeResponse?: unknown;
} = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse((init?.body as string) ?? "{}") as { type?: string };
    if (body.type === "spotClearinghouseState") {
      return jsonRes(args.spotState ?? { balances: [{ coin: "USDC", token: 0, hold: "0", total: "0", entryNtl: "0" }] });
    }
    if (body.type === "clearinghouseState") {
      if (args.perpState instanceof Error) throw args.perpState;
      return jsonRes(args.perpState ?? { withdrawable: "25.5" });
    }
    if (!body.type && "action" in body) {
      return jsonRes(args.exchangeResponse ?? { status: "ok", response: { type: "usdClassTransfer" } });
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

describe("prediction USDC transfer route", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockHyperliquid();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("blocks prediction balance transfers when HIP-4 live trading is flag-off", async () => {
    await app.close();
    app = await buildApp({
      ...baseEnv,
      AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING: "false",
    } as unknown as NodeJS.ProcessEnv);

    const res = await app.inject({
      method: "POST",
      url: "/prediction/usdc-transfer",
      headers: liveHeaders(),
      payload: { user: TEST_USER, amount: "10" },
    });

    expect(res.statusCode).toBe(451);
    expect(res.json().message).toContain("Live HIP-4 prediction trading is disabled");
  });

  it("blocks restricted users before building a transfer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/prediction/usdc-transfer",
      headers: liveHeaders("US"),
      payload: { user: TEST_USER, amount: "10" },
    });

    expect(res.statusCode).toBe(451);
    expect(res.json().message).toContain("not eligible");
  });

  it("blocks insufficient perp withdrawable before signing", async () => {
    await app.close();
    vi.restoreAllMocks();
    mockHyperliquid({ perpState: { withdrawable: "4.999999" } });
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/prediction/usdc-transfer",
      headers: liveHeaders(),
      payload: { user: TEST_USER, amount: "5" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain("Insufficient perp withdrawable");
    expect(res.json().state).toBe("insufficient_perp_balance");
  });

  it("accepts transfer amount equal to exact max transferable USDC", async () => {
    await app.close();
    vi.restoreAllMocks();
    mockHyperliquid({ perpState: { withdrawable: "1.55" } });
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/prediction/usdc-transfer",
      headers: liveHeaders(),
      payload: { user: TEST_USER, amount: "1.55" },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as PredictionUsdcTransferBuildResponse;
    expect(body.amount).toBe("1.55");
    expect(body.action.amount).toBe("1.55");
    expect(body.balance.maxTransferableUsdc).toBe("1.55");
  });

  it("rejects transfer amount above exact max by one micro-USDC", async () => {
    await app.close();
    vi.restoreAllMocks();
    mockHyperliquid({ perpState: { withdrawable: "1.549555" } });
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/prediction/usdc-transfer",
      headers: liveHeaders(),
      payload: { user: TEST_USER, amount: "1.549556" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      state: "insufficient_perp_balance",
      message: "Insufficient perp withdrawable balance for prediction USDC transfer.",
    });
    expect(res.json().guidance).toBe("Available transfer amount is 1.549555 USDC. Use max.");
  });

  it("fails closed when perp withdrawable balance is unavailable", async () => {
    await app.close();
    vi.restoreAllMocks();
    mockHyperliquid({ perpState: new Error("clearinghouse unavailable") });
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/prediction/usdc-transfer",
      headers: liveHeaders(),
      payload: { user: TEST_USER, amount: "5" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().state).toBe("balance_unavailable");
    expect(res.json().message).toContain("Perp withdrawable balance is unavailable");
  });

  it("builds a perp-to-spot usdClassTransfer action", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/prediction/usdc-transfer",
      headers: liveHeaders(),
      payload: { user: TEST_USER, amount: "10.500000" },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as PredictionUsdcTransferBuildResponse;
    expect(body).toMatchObject({
      status: "built",
      state: "built",
      amount: "10.5",
      direction: "perp_to_spot",
      action: {
        type: "usdClassTransfer",
        amount: "10.5",
        toPerp: false,
        hyperliquidChain: "Mainnet",
        signatureChainId: "0xa4b1",
      },
    });
    expect(body.action.nonce).toBe(body.nonce);
    expect(body.typedData.primaryType).toBe("HyperliquidTransaction:UsdClassTransfer");
    expect(body.typedData.message).toMatchObject({
      hyperliquidChain: "Mainnet",
      amount: "10.5",
      toPerp: false,
      nonce: body.nonce,
    });
  });

  it("normalizes Hyperliquid rejection on send", async () => {
    const buildRes = await app.inject({
      method: "POST",
      url: "/prediction/usdc-transfer",
      headers: liveHeaders(),
      payload: { user: TEST_USER, amount: "10" },
    });
    expect(buildRes.statusCode).toBe(200);
    const built = buildRes.json() as PredictionUsdcTransferBuildResponse;

    const account = privateKeyToAccount(generatePrivateKey());
    const sigHex = await account.signTypedData({
      domain: built.typedData.domain,
      types: built.typedData.types,
      primaryType: built.typedData.primaryType,
      message: built.typedData.message,
    });
    const signature = splitHexSig(sigHex);

    vi.restoreAllMocks();
    mockHyperliquid({
      exchangeResponse: {
        status: "ok",
        response: { type: "usdClassTransfer", data: { statuses: [{ error: "Transfer rejected by matcher" }] } },
      },
    });

    const sendRes = await app.inject({
      method: "POST",
      url: "/prediction/usdc-transfer",
      headers: liveHeaders(),
      payload: { action: built.action, nonce: built.nonce, signature },
    });

    expect(sendRes.statusCode).toBe(422);
    expect(sendRes.json().message).toContain("Transfer rejected by matcher");
    expect(sendRes.json().state).toBe("rejected");
  });

  it("rejects send when claimed user does not match recovered signer", async () => {
    const buildRes = await app.inject({
      method: "POST",
      url: "/prediction/usdc-transfer",
      headers: liveHeaders(),
      payload: { user: TEST_USER, amount: "10" },
    });
    expect(buildRes.statusCode).toBe(200);
    const built = buildRes.json() as PredictionUsdcTransferBuildResponse;

    const account = privateKeyToAccount(generatePrivateKey());
    const sigHex = await account.signTypedData({
      domain: built.typedData.domain,
      types: built.typedData.types,
      primaryType: built.typedData.primaryType,
      message: built.typedData.message,
    });

    const sendRes = await app.inject({
      method: "POST",
      url: "/prediction/usdc-transfer",
      headers: liveHeaders(),
      payload: {
        user: TEST_USER,
        action: built.action,
        nonce: built.nonce,
        signature: splitHexSig(sigHex),
      },
    });

    expect(sendRes.statusCode).toBe(422);
    expect(sendRes.json().error).toBe("SIGNATURE_INVALID");
    expect(sendRes.json().message).toContain("does not match");
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
