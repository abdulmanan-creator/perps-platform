/**
 * /exchange unit tests.
 *
 * Covers the four invariants from the project brief:
 *   1. Builder-fee injection produces the right `f` and overwrites `b`.
 *   2. Signature recovery yields the same wallet that signed (both L1 and
 *      EIP-712 user-signed envelopes).
 *   3. Configured fee > protocol cap → server refuses to build.
 *   4. End-to-end build → sign → send roundtrip with a mocked Hyperliquid.
 *
 * The mocked HL fetch lets us run these without hitting the network.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import type { BuildResponse, SendResponse } from "@alchemy-hl/shared";

import { loadConfig } from "../src/config.js";
import { ApiException, sendError } from "../src/errors.js";
import { injectBuilder, feeBpsFor } from "../src/helpers/builder.js";
import { exchangeRoute } from "../src/routes/exchange.js";

/**
 * Test builder address. Note: config.ts checksums on load via viem.getAddress,
 * so anything we read back from the API will be EIP-55 cased — compare with
 * .toLowerCase() rather than strict equality.
 */
const TEST_BUILDER = "0xAAAA000000000000000000000000000000000001" as const;
const TEST_BUILDER_LOWER = TEST_BUILDER.toLowerCase();
const baseEnv = {
  ALCHEMY_BUILDER_ADDRESS: TEST_BUILDER,
  HYPERLIQUID_API_URL: "https://api.hyperliquid-testnet.xyz",
  PERPS_BUILDER_FEE_BPS: "4",
  SPOT_BUILDER_FEE_BPS: "5",
  MAX_BUILDER_FEE_BPS_PERPS: "10",
  MAX_BUILDER_FEE_BPS_SPOT: "100",
} as unknown as NodeJS.ProcessEnv;

function makeOrder(asset = 0): import("@alchemy-hl/shared").OrderAction {
  return {
    type: "order",
    grouping: "na",
    orders: [
      {
        a: asset,
        b: true,
        p: "1000",
        s: "0.001",
        r: false,
        t: { limit: { tif: "Gtc" } },
      },
    ],
  };
}

async function buildApp(envOverride: NodeJS.ProcessEnv = baseEnv): Promise<FastifyInstance> {
  const cfg = loadConfig(envOverride);
  const app = Fastify({ logger: false });
  app.decorate("config", cfg);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiException) return sendError(reply, err);
    return reply.code(500).send({
      error: "INTERNAL_ERROR",
      message: (err as Error).message,
    });
  });
  await app.register(exchangeRoute);
  return app;
}

describe("builder injection", () => {
  it("attaches Alchemy's builder + perps fee on a perp order", () => {
    const cfg = loadConfig(baseEnv);
    const action = makeOrder(0); // perp asset
    injectBuilder(action, cfg);
    expect(action.builder?.b.toLowerCase()).toBe(TEST_BUILDER_LOWER);
    // HL wire format is tenths of basis points: 4 bps configured → f=40 on the wire.
    expect(action.builder?.f).toBe(40);
  });

  it("emits builder.b lowercased — HL hashes addresses lowercase", () => {
    const cfg = loadConfig(baseEnv);
    const action = makeOrder(0);
    injectBuilder(action, cfg);
    // The address must be byte-identical to lowercase form, not just case-insensitive
    // equal — msgpack encodes strings literally and HL canonicalizes to lowercase.
    expect(action.builder?.b).toBe(TEST_BUILDER_LOWER);
  });

  it("attaches spot fee when the leg is a spot asset (>= 10000)", () => {
    const cfg = loadConfig(baseEnv);
    const action = makeOrder(10001); // spot
    injectBuilder(action, cfg);
    expect(action.builder?.b.toLowerCase()).toBe(TEST_BUILDER_LOWER);
    // 5 bps configured → f=50 on the wire (tenths of bps).
    expect(action.builder?.f).toBe(50);
  });

  it("rejects a mismatched builder in the incoming action", () => {
    const cfg = loadConfig(baseEnv);
    const action = makeOrder(0);
    action.builder = { b: "0xBBBB000000000000000000000000000000000002", f: 4 };
    expect(() => injectBuilder(action, cfg)).toThrow(/BUILDER_MISMATCH|does not match/);
  });

  it("on mixed perps+spot orders, picks the higher fee", () => {
    const cfg = loadConfig(baseEnv);
    const action = makeOrder(0);
    action.orders.push({
      a: 10001,
      b: false,
      p: "10",
      s: "1",
      r: false,
      t: { limit: { tif: "Gtc" } },
    });
    expect(feeBpsFor(action, cfg)).toBe(Math.max(4, 5));
  });
});

describe("cap enforcement", () => {
  it("refuses to load config with PERPS fee above protocol cap", () => {
    expect(() =>
      loadConfig({ ...baseEnv, PERPS_BUILDER_FEE_BPS: "11" } as NodeJS.ProcessEnv),
    ).toThrow(/PERPS_BUILDER_FEE_BPS/);
  });

  it("refuses to load config with SPOT fee above protocol cap", () => {
    expect(() =>
      loadConfig({ ...baseEnv, SPOT_BUILDER_FEE_BPS: "101" } as NodeJS.ProcessEnv),
    ).toThrow(/SPOT_BUILDER_FEE_BPS/);
  });
});

describe("POST /exchange — build phase", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it("builds an order: injects builder, returns hash + typedData", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { action: makeOrder(0) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BuildResponse;
    expect(body.action.type).toBe("order");
    if (body.action.type !== "order") return;
    expect(body.action.builder?.b.toLowerCase()).toBe(TEST_BUILDER_LOWER);
    // f is on the wire in tenths of bps: 4 bps configured → 40 on the wire.
    expect(body.action.builder?.f).toBe(40);
    // builderFee in the BuildResponse stays in bps for caller ergonomics.
    expect(body.builderFee).toBe(4);
    expect(body.builder.toLowerCase()).toBe(TEST_BUILDER_LOWER);
    expect(body.isSpot).toBe(false);
    expect(body.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.typedData?.primaryType).toBe("Agent");
    expect(body.nonce).toBeGreaterThan(0);
  });

  it("builds an approveBuilderFee: returns HyperliquidTransaction EIP-712", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { action: { type: "approveBuilderFee", maxFeeRate: "1%" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BuildResponse;
    expect(body.typedData?.primaryType).toBe(
      "HyperliquidTransaction:ApproveBuilderFee",
    );
    if (body.action.type !== "approveBuilderFee") throw new Error("wrong type");
    expect(body.action.builder?.toLowerCase()).toBe(TEST_BUILDER_LOWER);
    expect(body.action.maxFeeRate).toBe("1%");
    expect(body.action.hyperliquidChain).toBe("Testnet"); // baseEnv uses testnet URL
    expect(body.typedData?.domain.chainId).toBe(42161);
  });

  it("rejects bad action shape with INVALID_PARAMS", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { action: { type: "order", grouping: "na", orders: [] } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("INVALID_PARAMS");
  });
});

describe("signature recovery", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it("L1 order: signing the returned typedData recovers the signer", async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);

    const buildRes = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { action: makeOrder(0) },
    });
    const built = buildRes.json() as BuildResponse;
    if (!built.typedData) throw new Error("missing typedData");

    const sigHex = await account.signTypedData({
      domain: built.typedData.domain,
      types: built.typedData.types,
      primaryType: built.typedData.primaryType,
      message: built.typedData.message,
    });
    const sig = splitHexSig(sigHex);

    // Mock the upstream so we exercise verify -> forward path without network.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok", response: { type: "order" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const sendRes = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { action: built.action, nonce: built.nonce, signature: sig },
    });
    expect(sendRes.statusCode).toBe(200);
    const sent = sendRes.json() as SendResponse;
    expect(sent.user.toLowerCase()).toBe(account.address.toLowerCase());
    expect(sent.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  it("approveBuilderFee: signing recovers the signer", async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);

    const buildRes = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { action: { type: "approveBuilderFee", maxFeeRate: "1%" } },
    });
    const built = buildRes.json() as BuildResponse;
    if (!built.typedData) throw new Error("missing typedData");

    const sigHex = await account.signTypedData({
      domain: built.typedData.domain,
      types: built.typedData.types,
      primaryType: built.typedData.primaryType,
      message: built.typedData.message,
    });
    const sig = splitHexSig(sigHex);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const sendRes = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { action: built.action, nonce: built.nonce, signature: sig },
    });
    expect(sendRes.statusCode).toBe(200);
    const sent = sendRes.json() as SendResponse;
    expect(sent.user.toLowerCase()).toBe(account.address.toLowerCase());
    fetchSpy.mockRestore();
  });

  it("rejects a tampered signature with SIGNATURE_INVALID", async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);

    const buildRes = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { action: makeOrder(0) },
    });
    const built = buildRes.json() as BuildResponse;
    if (!built.typedData) throw new Error("missing typedData");

    const sigHex = await account.signTypedData({
      domain: built.typedData.domain,
      types: built.typedData.types,
      primaryType: built.typedData.primaryType,
      message: built.typedData.message,
    });
    const sig = splitHexSig(sigHex);

    // Flip a byte in r — should yield a different (or invalid) recovery.
    const tampered = {
      ...sig,
      r: (sig.r.slice(0, -2) +
        (sig.r.endsWith("0") ? "1" : "0")) as `0x${string}`,
    };

    const sendRes = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: {
        action: built.action,
        nonce: built.nonce,
        signature: tampered,
      },
    });
    // Tampering should produce either a SIGNATURE_INVALID error or a
    // recovered-but-different signer that will fail at HL. Either way it's
    // never a 2xx with the original account.
    if (sendRes.statusCode === 200) {
      const sent = sendRes.json() as SendResponse;
      expect(sent.user.toLowerCase()).not.toBe(account.address.toLowerCase());
    } else {
      expect(sendRes.statusCode).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("v normalization on send", () => {
  it("normalizes v=0 → v=27 in the HL forwarding payload", async () => {
    const app = await buildApp();
    try {
      const pk = generatePrivateKey();
      const account = privateKeyToAccount(pk);

      const buildRes = await app.inject({
        method: "POST",
        url: "/exchange",
        payload: { action: makeOrder(0) },
      });
      const built = buildRes.json() as BuildResponse;
      if (!built.typedData) throw new Error("missing typedData");

      const sigHex = await account.signTypedData({
        domain: built.typedData.domain,
        types: built.typedData.types,
        primaryType: built.typedData.primaryType,
        message: built.typedData.message,
      });
      const sig = splitHexSig(sigHex);

      // Force the test client to send v in 0/1 format (some Privy embedded
      // wallets via raw EIP-1193 do this). Recovery should still succeed
      // because viem normalizes; the forwarded payload to HL should have v=27.
      const yParitySig = { ...sig, v: sig.v - 27 };
      expect(yParitySig.v).toBeLessThan(2);

      let capturedHlBody: { signature?: { v: number } } | undefined;
      vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
        if (init?.body && typeof init.body === "string") {
          capturedHlBody = JSON.parse(init.body);
        }
        return new Response(JSON.stringify({ status: "ok", response: { type: "order" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const sendRes = await app.inject({
        method: "POST",
        url: "/exchange",
        payload: { action: built.action, nonce: built.nonce, signature: yParitySig },
      });
      expect(sendRes.statusCode).toBe(200);
      expect(capturedHlBody?.signature?.v).toBeGreaterThanOrEqual(27);
      expect(capturedHlBody?.signature?.v).toBeLessThanOrEqual(28);
    } finally {
      // Clean up the spy at the test's end (not via afterEach since other tests
      // in this file rely on a clean fetch spy).
      vi.restoreAllMocks();
    }
  });
});

describe("zero-builder guard", () => {
  it("refuses to build approveBuilderFee when ALCHEMY_BUILDER_ADDRESS is 0x0", async () => {
    const zeroEnv = {
      ...baseEnv,
      ALCHEMY_BUILDER_ADDRESS: "0x0000000000000000000000000000000000000000",
    } as NodeJS.ProcessEnv;
    const app = await buildApp(zeroEnv);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/exchange",
        payload: { action: { type: "approveBuilderFee", maxFeeRate: "1%" } },
      });
      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.error).toBe("INVALID_PARAMS");
      expect(body.message).toMatch(/zero address/i);
      expect(body.guidance).toMatch(/restart/i);
    } finally {
      await app.close();
    }
  });

  it("refuses to build an order when ALCHEMY_BUILDER_ADDRESS is 0x0", async () => {
    const zeroEnv = {
      ...baseEnv,
      ALCHEMY_BUILDER_ADDRESS: "0x0000000000000000000000000000000000000000",
    } as NodeJS.ProcessEnv;
    const app = await buildApp(zeroEnv);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/exchange",
        payload: { action: makeOrder(0) },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("INVALID_PARAMS");
    } finally {
      await app.close();
    }
  });
});

describe("HL error mapping", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("maps 'Must deposit before performing actions' → NEEDS_DEPOSIT with a deposit url", async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);

    const buildRes = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { action: { type: "approveBuilderFee", maxFeeRate: "1%" } },
    });
    const built = buildRes.json() as BuildResponse;
    if (!built.typedData) throw new Error("missing typedData");

    const sigHex = await account.signTypedData({
      domain: built.typedData.domain,
      types: built.typedData.types,
      primaryType: built.typedData.primaryType,
      message: built.typedData.message,
    });
    const sig = splitHexSig(sigHex);

    // HL replies with status:"err" + the human deposit-required string.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "err",
          response: "Must deposit before performing actions. User: 0xabc...",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const sendRes = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { action: built.action, nonce: built.nonce, signature: sig },
    });
    expect(sendRes.statusCode).toBe(422);
    const body = sendRes.json();
    expect(body.error).toBe("NEEDS_DEPOSIT");
    // baseEnv uses the testnet URL → testnet faucet link in guidance.
    expect(body.guidance).toContain("hyperliquid-testnet.xyz/drip");
  });

  it("maps nested order status errors in HTTP 200 responses to HL_EXCHANGE_REJECTED", async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);

    const buildRes = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { action: makeOrder(0) },
    });
    const built = buildRes.json() as BuildResponse;
    if (!built.typedData) throw new Error("missing typedData");

    const sigHex = await account.signTypedData({
      domain: built.typedData.domain,
      types: built.typedData.types,
      primaryType: built.typedData.primaryType,
      message: built.typedData.message,
    });
    const sig = splitHexSig(sigHex);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "ok",
          response: {
            type: "order",
            data: { statuses: [{ error: "Order must have minimum value of $10." }] },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const sendRes = await app.inject({
      method: "POST",
      url: "/exchange",
      payload: { action: built.action, nonce: built.nonce, signature: sig },
    });

    expect(sendRes.statusCode).toBe(422);
    const body = sendRes.json();
    expect(body.error).toBe("HL_EXCHANGE_REJECTED");
    expect(body.message).toContain("Order must have minimum value of $10.");
    expect(body.guidance).toBe("Order must have minimum value of $10.");
  });

  it("preserves filled order responses with structured exchangeResult detail", async () => {
    const response = await signAndSendMockedOrder({
      app,
      hlResponse: { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.1", avgPx: "100" } }] } } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().exchangeResult).toEqual({ status: "filled", label: "Filled" });
  });

  it("preserves resting order responses with structured exchangeResult detail", async () => {
    const response = await signAndSendMockedOrder({
      app,
      hlResponse: { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 99 } }] } } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().exchangeResult).toEqual({ status: "resting", label: "Resting open order" });
  });
});

async function signAndSendMockedOrder(args: {
  app: FastifyInstance;
  hlResponse: unknown;
}) {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const buildRes = await args.app.inject({
    method: "POST",
    url: "/exchange",
    payload: { action: makeOrder(0) },
  });
  const built = buildRes.json() as BuildResponse;
  if (!built.typedData) throw new Error("missing typedData");

  const sigHex = await account.signTypedData({
    domain: built.typedData.domain,
    types: built.typedData.types,
    primaryType: built.typedData.primaryType,
    message: built.typedData.message,
  });
  const sig = splitHexSig(sigHex);

  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(args.hlResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  return await args.app.inject({
    method: "POST",
    url: "/exchange",
    payload: { action: built.action, nonce: built.nonce, signature: sig },
  });
}

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
    v: parseInt(stripped.slice(128, 130), 16),
  };
}
