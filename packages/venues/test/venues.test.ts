/**
 * Tests for the venue abstraction: registry resolution, market-id parsing,
 * and that each adapter declares the capabilities the platform branches on.
 */

import { describe, expect, it } from "vitest";

import {
  NotImplementedError,
  createRegistry,
  getVenue,
  listVenues,
  parseMarketId,
} from "../src/index.js";

describe("registry", () => {
  it("resolves all three launch venues", () => {
    expect(getVenue("hyperliquid").id).toBe("hyperliquid");
    expect(getVenue("lighter").id).toBe("lighter");
    expect(getVenue("ostium").id).toBe("ostium");
  });

  it("throws on an unknown venue", () => {
    // @ts-expect-error — exercising the runtime guard with a bad id
    expect(() => getVenue("kraken")).toThrow(/unknown venue/);
  });

  it("lists every registered venue", () => {
    expect(listVenues().map((v) => v.id).sort()).toEqual(["hyperliquid", "lighter", "ostium"]);
  });

  it("is independent per createRegistry() call", () => {
    expect(createRegistry().size).toBe(3);
  });
});

describe("parseMarketId", () => {
  it("splits venue and symbol", () => {
    expect(parseMarketId("hyperliquid:BTC")).toEqual({ venue: "hyperliquid", symbol: "BTC" });
  });

  it("keeps colons inside the symbol", () => {
    expect(parseMarketId("ostium:EUR/USD")).toEqual({ venue: "ostium", symbol: "EUR/USD" });
  });

  it("rejects an unqualified id", () => {
    expect(() => parseMarketId("BTC")).toThrow(/<venue>:<symbol>/);
  });
});

describe("capabilities reflect each venue's real model", () => {
  it("hyperliquid: eip712 / sync / earns builder fee", () => {
    const c = getVenue("hyperliquid").capabilities;
    expect(c.signing).toBe("eip712");
    expect(c.settlement).toBe("sync");
    expect(c.earnsBuilderFee).toBe(true);
    expect(c.requiresGas).toBe(false);
  });

  it("lighter: venueSig / sync / no builder fee", () => {
    const c = getVenue("lighter").capabilities;
    expect(c.signing).toBe("venueSig");
    expect(c.earnsBuilderFee).toBe(false);
  });

  it("ostium: evmTx / asyncOnchain / requires gas", () => {
    const c = getVenue("ostium").capabilities;
    expect(c.signing).toBe("evmTx");
    expect(c.settlement).toBe("asyncOnchain");
    expect(c.requiresGas).toBe(true);
  });
});

describe("unwired adapters fail explicitly", () => {
  it("lighter.listMarkets throws NotImplementedError", async () => {
    await expect(getVenue("lighter").listMarkets()).rejects.toBeInstanceOf(NotImplementedError);
  });

  it("hyperliquid write path throws NotImplementedError until extraction", async () => {
    await expect(
      getVenue("hyperliquid").buildOrder({ market: "hyperliquid:BTC", side: "buy", size: "0.001" }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});
