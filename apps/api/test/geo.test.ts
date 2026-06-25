/**
 * Tests for jurisdiction gating (helpers/geo.ts) and the onRequest guard.
 *
 * Coverage:
 *   - resolveCountry: header read, casing, array headers, empty/missing
 *   - geoDecision: restricted block, allowed pass-through, Tor block,
 *     unknown fail-open vs fail-closed, master switch off
 *   - custom RESTRICTED_COUNTRIES + GEO_COUNTRY_HEADER overrides
 *   - integration: the guard returns 451 REGION_BLOCKED and exempts /healthz
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { ApiException, sendError } from "../src/errors.js";
import { geoDecision, isGlobalGeoExemptPath, resolveCountry } from "../src/helpers/geo.js";

const baseEnv = {
  ALCHEMY_BUILDER_ADDRESS: "0xAAAA000000000000000000000000000000000001",
  HYPERLIQUID_API_URL: "https://api.hyperliquid-testnet.xyz",
  PERPS_BUILDER_FEE_BPS: "4",
  SPOT_BUILDER_FEE_BPS: "5",
} as unknown as NodeJS.ProcessEnv;

function cfg(extra: Record<string, string> = {}): Config {
  return loadConfig({ ...baseEnv, ...extra } as NodeJS.ProcessEnv);
}

/** Minimal request stand-in — geoDecision only touches headers. */
function req(headers: Record<string, string | string[]>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe("resolveCountry", () => {
  it("reads and uppercases the configured header", () => {
    expect(resolveCountry(req({ "cf-ipcountry": "us" }), cfg())).toBe("US");
  });

  it("returns null when the header is missing or empty", () => {
    expect(resolveCountry(req({}), cfg())).toBeNull();
    expect(resolveCountry(req({ "cf-ipcountry": "  " }), cfg())).toBeNull();
  });

  it("takes the first value when the header repeats", () => {
    expect(resolveCountry(req({ "cf-ipcountry": ["GB", "US"] }), cfg())).toBe("GB");
  });

  it("honors a custom country header", () => {
    const c = cfg({ GEO_COUNTRY_HEADER: "x-vercel-ip-country" });
    expect(resolveCountry(req({ "x-vercel-ip-country": "FR" }), c)).toBe("FR");
  });
});

describe("geoDecision", () => {
  it("blocks a default-restricted country (US)", () => {
    const d = geoDecision(req({ "cf-ipcountry": "US" }), cfg());
    expect(d).toEqual({ allowed: false, country: "US", reason: "restricted" });
  });

  it("blocks sanctioned defaults (IR, KP)", () => {
    expect(geoDecision(req({ "cf-ipcountry": "IR" }), cfg()).allowed).toBe(false);
    expect(geoDecision(req({ "cf-ipcountry": "KP" }), cfg()).allowed).toBe(false);
  });

  it("allows a permitted country", () => {
    expect(geoDecision(req({ "cf-ipcountry": "GB" }), cfg()).allowed).toBe(true);
  });

  it("blocks Tor exit nodes regardless of fail-open", () => {
    const d = geoDecision(req({ "cf-ipcountry": "T1" }), cfg({ GEO_FAIL_CLOSED: "false" }));
    expect(d).toEqual({ allowed: false, country: "T1", reason: "tor" });
  });

  it("fails open on unknown country by default", () => {
    expect(geoDecision(req({}), cfg()).allowed).toBe(true);
    expect(geoDecision(req({ "cf-ipcountry": "XX" }), cfg()).allowed).toBe(true);
  });

  it("fails closed on unknown country when configured", () => {
    const c = cfg({ GEO_FAIL_CLOSED: "true" });
    expect(geoDecision(req({}), c)).toEqual({ allowed: false, country: null, reason: "unknown" });
    expect(geoDecision(req({ "cf-ipcountry": "XX" }), c).allowed).toBe(false);
  });

  it("passes everything through when the master switch is off", () => {
    const c = cfg({ GEO_BLOCK_ENABLED: "false" });
    expect(geoDecision(req({ "cf-ipcountry": "US" }), c).allowed).toBe(true);
    expect(geoDecision(req({ "cf-ipcountry": "T1" }), c).allowed).toBe(true);
  });

  it("honors a custom restricted list (and drops defaults not listed)", () => {
    const c = cfg({ RESTRICTED_COUNTRIES: "FR, de" });
    expect(geoDecision(req({ "cf-ipcountry": "FR" }), c).allowed).toBe(false);
    expect(geoDecision(req({ "cf-ipcountry": "DE" }), c).allowed).toBe(false);
    expect(geoDecision(req({ "cf-ipcountry": "US" }), c).allowed).toBe(true);
  });
});

describe("onRequest guard (integration)", () => {
  async function buildApp(env: Record<string, string> = {}): Promise<FastifyInstance> {
    const config = cfg(env);
    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (request, reply) => {
      if (isGlobalGeoExemptPath(request.routeOptions?.url ?? request.url)) return;
      const decision = geoDecision(request, config);
      if (decision.allowed) return;
      return sendError(
        reply,
        new ApiException("REGION_BLOCKED", "This service is not available in your region.", "..."),
      );
    });
    app.get("/healthz", async () => ({ ok: true }));
    app.get("/markets", async () => ({ ok: true }));
    app.get("/agent-trade/eligibility", async () => ({ state: "restricted" }));
    app.post("/agent-trade/paper-orders", async () => ({ ok: true }));
    app.post("/agent-trade/exchange", async () => ({ ok: true }));
    app.post("/exchange", async () => ({ ok: true }));
    return app;
  }

  it("returns 451 REGION_BLOCKED for a restricted region", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/exchange",
      headers: { "cf-ipcountry": "US" },
      payload: {},
    });
    expect(res.statusCode).toBe(451);
    expect(res.json().error).toBe("REGION_BLOCKED");
  });

  it("lets a permitted region through", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/exchange",
      headers: { "cf-ipcountry": "GB" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it("never blocks the /healthz operational endpoint", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz", headers: { "cf-ipcountry": "US" } });
    expect(res.statusCode).toBe(200);
  });

  it("allows restricted users to access Agent.trade paper/read endpoints", async () => {
    const app = await buildApp();
    const headers = { "cf-ipcountry": "US" };

    const markets = await app.inject({ method: "GET", url: "/markets", headers });
    const eligibility = await app.inject({ method: "GET", url: "/agent-trade/eligibility", headers });
    const paper = await app.inject({ method: "POST", url: "/agent-trade/paper-orders", headers, payload: {} });

    expect(markets.statusCode).toBe(200);
    expect(eligibility.statusCode).toBe(200);
    expect(eligibility.json().state).toBe("restricted");
    expect(paper.statusCode).toBe(200);
  });

  it("keeps live exchange routes blocked for restricted users", async () => {
    const app = await buildApp();
    const headers = { "cf-ipcountry": "US" };

    const generic = await app.inject({ method: "POST", url: "/exchange", headers, payload: {} });
    const agentTrade = await app.inject({ method: "POST", url: "/agent-trade/exchange", headers, payload: {} });

    expect(generic.statusCode).toBe(451);
    expect(agentTrade.statusCode).toBe(451);
  });
});
