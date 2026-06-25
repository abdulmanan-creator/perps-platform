import type { FastifyRequest } from "fastify";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrderAction } from "@alchemy-hl/shared";

import { loadConfig } from "../src/config.js";
import { ApiException, sendError } from "../src/errors.js";
import {
  recordAuditEvent,
  recordExchangeSubmission,
  redactForAudit,
  resetAuditDbForTests,
  setAuditDbForTests,
} from "../src/helpers/agentTradeAudit.js";
import { agentTradeRoute } from "../src/routes/agentTrade.js";

const baseEnv = {
  ALCHEMY_BUILDER_ADDRESS: "0xAAAA000000000000000000000000000000000001",
  HYPERLIQUID_API_URL: "https://api.hyperliquid-testnet.xyz",
  PERPS_BUILDER_FEE_BPS: "4",
  SPOT_BUILDER_FEE_BPS: "5",
} as unknown as NodeJS.ProcessEnv;

function req(): FastifyRequest {
  return {
    id: "req-audit-1",
    method: "POST",
    url: "/agent-trade/exchange",
    routeOptions: { url: "/agent-trade/exchange" },
    headers: {
      authorization: "Bearer eyJhbGciOi.fake.jwt",
      cookie: "sid=secret",
    },
    log: { warn: vi.fn() },
  } as unknown as FastifyRequest;
}

function order(): OrderAction {
  return {
    type: "order",
    grouping: "na",
    orders: [
      { a: 0, b: true, p: "1000", s: "0.01", r: false, t: { limit: { tif: "Ioc" } } },
    ],
  };
}

describe("Agent.trade audit helpers", () => {
  afterEach(() => {
    resetAuditDbForTests();
    vi.restoreAllMocks();
  });

  it("no-ops without DATABASE_URL", async () => {
    await expect(recordAuditEvent({
      req: req(),
      cfg: loadConfig(baseEnv),
      eventType: "agent_trade.test",
      payload: { ok: true },
    })).resolves.toBeUndefined();
  });

  it("does not throw when the DB write fails", async () => {
    const request = req();
    const query = vi.fn().mockRejectedValue(new Error("db down"));
    setAuditDbForTests({ query });

    await expect(recordAuditEvent({
      req: request,
      cfg: loadConfig({ ...baseEnv, DATABASE_URL: "postgres://audit:test@localhost:5432/audit" } as NodeJS.ProcessEnv),
      eventType: "agent_trade.test",
      payload: { ok: true },
    })).resolves.toBeUndefined();

    expect(request.log.warn).toHaveBeenCalled();
  });

  it("redacts tokens, authorization headers, secrets, and raw signatures", () => {
    const redacted = redactForAudit({
      authorization: "Bearer eyJhbGciOi.fake.jwt",
      nested: {
        privyJwt: "eyJhbGciOi.fake.jwt",
        secret: "do-not-store",
        signature: { r: "0xabc", s: "0xdef", v: 27 },
      },
      safe: "kept",
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).toContain("kept");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("eyJhbGciOi");
    expect(serialized).not.toContain("do-not-store");
    expect(serialized).not.toContain("0xabc");
  });

  it("stores signature hashes and redacted payloads, not raw signatures", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "00000000-0000-0000-0000-000000000001" }] });
    setAuditDbForTests({ query });
    const cfg = loadConfig({ ...baseEnv, DATABASE_URL: "postgres://audit:test@localhost:5432/audit" } as NodeJS.ProcessEnv);

    const id = await recordExchangeSubmission({
      req: req(),
      cfg,
      phase: "send",
      route: "/agent-trade/exchange",
      status: "started",
      signer: "0xcccc000000000000000000000000000000000001",
      nonce: 123,
      signature: {
        r: "0x1111111111111111111111111111111111111111111111111111111111111111",
        s: "0x2222222222222222222222222222222222222222222222222222222222222222",
        v: 27,
      },
      action: {
        type: "order",
        grouping: "na",
        orders: [
          { a: 0, b: true, p: "1000", s: "0.01", r: false, t: { limit: { tif: "Ioc" } } },
        ],
      },
    });

    expect(id).toBe("00000000-0000-0000-0000-000000000001");
    const params = query.mock.calls[0]?.[1] as unknown[];
    const serializedParams = JSON.stringify(params);
    expect(serializedParams).toContain("0xcccc000000000000000000000000000000000001");
    expect(serializedParams).not.toContain("0x1111111111111111111111111111111111111111111111111111111111111111");
    expect(serializedParams).not.toContain("0x2222222222222222222222222222222222222222222222222222222222222222");
  });

  it("/agent-trade/exchange build response is unchanged when audit DB is disabled", async () => {
    const app = Fastify({ logger: false });
    app.decorate("config", loadConfig(baseEnv));
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof ApiException) return sendError(reply, err);
      return reply.code(500).send({ error: "INTERNAL_ERROR", message: String(err) });
    });
    await app.register(agentTradeRoute);

    const res = await app.inject({
      method: "POST",
      url: "/agent-trade/exchange",
      headers: {
        "cf-ipcountry": "CA",
        "x-agent-trade-risk-accepted": "true",
        "x-agent-trade-terms-accepted": "true",
      },
      payload: { action: order(), user: "0xcccc000000000000000000000000000000000001" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      nonce: expect.any(Number),
      builderFee: 4,
      isSpot: false,
    });
    expect(typeof body.hash).toBe("string");
    await app.close();
  });
});
