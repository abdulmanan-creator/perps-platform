/**
 * HIP-4 prediction market SDK surface — outcomes()/outcomeOdds() reads,
 * outcomeOrder() asset encoding + validation, cancel by raw assetId.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Alchemy, SdkInputError } from "../src/index.js";

const USER = "0xcccc000000000000000000000000000000000001";

function jsonRes(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jwtFor(sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ sub })}.sig`;
}

describe("outcome markets", () => {
  const sent: Array<{ url: string; body: unknown }> = [];

  beforeEach(() => {
    sent.length = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("/outcomeOdds")) {
        return jsonRes({
          outcome: 104,
          name: "June Fed rate change",
          quoteToken: "USDC",
          sides: [
            { side: 0, name: "Change", assetId: 100_001_040, coin: "#1040", bestBid: "0.008", bestAsk: "0.009", probability: 0.0085 },
            { side: 1, name: "No Change", assetId: 100_001_041, coin: "#1041", bestBid: null, bestAsk: null, probability: null },
          ],
        });
      }
      if (u.includes("/outcomes")) {
        return jsonRes({
          outcomes: [
            {
              outcome: 104,
              name: "June Fed rate change",
              description: "Resolves to Change if …",
              sides: [
                { side: 0, name: "Change", assetId: 100_001_040, coin: "#1040" },
                { side: 1, name: "No Change", assetId: 100_001_041, coin: "#1041" },
              ],
              quoteToken: "USDC",
            },
          ],
        });
      }
      if (u.endsWith("/agent/exchange")) {
        sent.push({ url: u, body: JSON.parse((init?.body as string) ?? "{}") });
        return jsonRes({
          success: true,
          user: USER,
          exchangeResponse: {
            status: "ok",
            response: { type: "order", data: { statuses: [{ resting: { oid: 77 } }] } },
          },
        });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("outcomes() and outcomeOdds() return typed reads", async () => {
    const sdk = new Alchemy({ baseUrl: "http://x" });
    const { outcomes } = await sdk.outcomes();
    expect(outcomes[0]!.sides[0].coin).toBe("#1040");
    const odds = await sdk.outcomeOdds(104);
    expect(odds.sides[0].probability).toBeCloseTo(0.0085);
    expect(odds.sides[1].probability).toBeNull();
  });

  it("outcomeOrder encodes assetId = 100M + 10*outcome + side, integer contracts", async () => {
    const sdk = new Alchemy({ baseUrl: "http://x", agentJwt: jwtFor(USER) });
    const result = await sdk.outcomeOrder({
      outcome: 217,
      side: 0,
      action: "buy",
      contracts: 250,
      price: 0.04002,
    });
    expect(result.restingOid).toBe(77);
    const body = sent[0]!.body as {
      action: { orders: Array<{ a: number; b: boolean; p: string; s: string; r: boolean }> };
    };
    const leg = body.action.orders[0]!;
    expect(leg.a).toBe(100_002_170);
    expect(leg.b).toBe(true);
    expect(leg.p).toBe("0.04");
    expect(leg.s).toBe("250");
    expect(leg.r).toBe(false);
  });

  it("rejects out-of-range probabilities and fractional contracts", async () => {
    const sdk = new Alchemy({ baseUrl: "http://x", agentJwt: jwtFor(USER) });
    await expect(
      sdk.outcomeOrder({ outcome: 1, side: 0, action: "buy", contracts: 10, price: 1.2 }),
    ).rejects.toThrow(SdkInputError);
    await expect(
      sdk.outcomeOrder({ outcome: 1, side: 0, action: "buy", contracts: 2.5, price: 0.5 }),
    ).rejects.toThrow(SdkInputError);
  });

  it("cancel accepts a raw assetId (outcome assets have no symbol)", async () => {
    const sdk = new Alchemy({ baseUrl: "http://x", agentJwt: jwtFor(USER) });
    await sdk.cancel({ assetId: 100_001_041, oid: 77 });
    const body = sent.at(-1)!.body as { action: { type: string; cancels: Array<{ a: number; o: number }> } };
    expect(body.action.type).toBe("cancel");
    expect(body.action.cancels[0]).toEqual({ a: 100_001_041, o: 77 });
  });
});
