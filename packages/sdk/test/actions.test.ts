import { describe, expect, it } from "vitest";

import {
  buildApproveBuilderFee,
  buildCancel,
  buildLimitOrder,
  buildMarketOrder,
} from "../src/actions.js";

describe("buildLimitOrder", () => {
  it("produces a single-leg order with defaults", () => {
    const a = buildLimitOrder({
      assetIndex: 0,
      szDecimals: 5,
      side: "buy",
      size: 0.001,
      price: 60000,
    });
    expect(a).toEqual({
      type: "order",
      grouping: "na",
      orders: [
        { a: 0, b: true, p: "60000", s: "0.001", r: false, t: { limit: { tif: "Gtc" } } },
      ],
    });
  });

  it("honors tif + reduce-only + cloid", () => {
    const a = buildLimitOrder({
      assetIndex: 1,
      szDecimals: 4,
      side: "sell",
      size: 0.5,
      price: 2400,
      tif: "Ioc",
      reduceOnly: true,
      cloid: "0xabc0000000000000000000000000000000000000000000000000000000000001",
    });
    expect(a.orders[0]).toMatchObject({
      a: 1,
      b: false,
      r: true,
      t: { limit: { tif: "Ioc" } },
      c: "0xabc0000000000000000000000000000000000000000000000000000000000001",
    });
  });

  it("strips trailing zeros from numeric inputs", () => {
    const a = buildLimitOrder({ assetIndex: 0, szDecimals: 5, side: "buy", size: 1.10, price: 1000 });
    expect(a.orders[0]?.s).toBe("1.1");
    expect(a.orders[0]?.p).toBe("1000");
  });

  it("truncates size to szDecimals (HL rejects over-precise sizes at deserialize time)", () => {
    // HYPE has szDecimals=2; size 0.2757346605 must truncate to "0.27".
    const a = buildLimitOrder({
      assetIndex: 159,
      szDecimals: 2,
      side: "buy",
      size: 0.2757346605,
      price: 76,
    });
    expect(a.orders[0]?.s).toBe("0.27");
  });

  it("caps price decimals at (6 - szDecimals) for perps", () => {
    // HYPE szDecimals=2 → max 4 decimals on price.
    const a = buildLimitOrder({
      assetIndex: 159,
      szDecimals: 2,
      side: "buy",
      size: 1,
      price: 76.160175,
    });
    // Cap to 4 decimals → 76.1602, sig-fig cap to 5 → "76.16".
    expect(a.orders[0]?.p).toBe("76.16");
  });

  it("keeps perp price formatting unchanged after HIP-4 tick-size patch", () => {
    const a = buildLimitOrder({
      assetIndex: 159,
      szDecimals: 2,
      side: "buy",
      size: 1,
      price: 76.160175,
    });
    expect(a.orders[0]?.p).toBe("76.16");
  });

  it("formats spot outcome prices with HIP-4-compatible precision", () => {
    const a = buildLimitOrder({
      assetIndex: 100_002_170,
      szDecimals: 0,
      isSpot: true,
      side: "buy",
      size: 53,
      price: 0.188789123,
      tif: "Ioc",
    });
    expect(a.orders[0]).toMatchObject({ a: 100_002_170, p: "0.18879", s: "53" });
  });
});

describe("buildMarketOrder", () => {
  it("uses size directly when given", () => {
    const a = buildMarketOrder({
      assetIndex: 0,
      szDecimals: 5,
      side: "buy",
      size: 0.001,
      markPrice: 60000,
    });
    expect(a.orders[0]?.s).toBe("0.001");
    expect(a.orders[0]?.t).toEqual({ limit: { tif: "Ioc" } });
  });

  it("computes size from notional + markPrice", () => {
    const a = buildMarketOrder({
      assetIndex: 0,
      szDecimals: 5,
      side: "buy",
      notional: 100,
      markPrice: 50000,
    });
    expect(a.orders[0]?.s).toBe("0.002");
  });

  it("sets a buy limit above mark by at least 5%", () => {
    const a = buildMarketOrder({
      assetIndex: 0,
      szDecimals: 5,
      side: "buy",
      size: 0.001,
      markPrice: 100,
    });
    expect(Number(a.orders[0]?.p)).toBeGreaterThanOrEqual(105);
  });

  it("sets a sell limit below mark by at least 5%", () => {
    const a = buildMarketOrder({
      assetIndex: 0,
      szDecimals: 5,
      side: "sell",
      size: 0.001,
      markPrice: 100,
    });
    expect(Number(a.orders[0]?.p)).toBeLessThanOrEqual(95);
  });

  it("rejects when neither size nor notional given", () => {
    expect(() =>
      buildMarketOrder({ assetIndex: 0, szDecimals: 5, side: "buy", markPrice: 100 }),
    ).toThrow(/either `size` or `notional`/);
  });

  it("rejects notional without markPrice", () => {
    expect(() =>
      buildMarketOrder({ assetIndex: 0, szDecimals: 5, side: "buy", notional: 100 }),
    ).toThrow(/markPrice/);
  });
});

describe("buildCancel", () => {
  it("packs multiple cancels in one action", () => {
    const a = buildCancel([
      { assetIndex: 0, oid: 1 },
      { assetIndex: 1, oid: 2 },
    ]);
    expect(a).toEqual({
      type: "cancel",
      cancels: [{ a: 0, o: 1 }, { a: 1, o: 2 }],
    });
  });

  it("rejects empty input", () => {
    expect(() => buildCancel([])).toThrow(/at least one/);
  });
});

describe("buildApproveBuilderFee", () => {
  it("accepts well-formed percent strings", () => {
    expect(buildApproveBuilderFee("1%")).toEqual({
      type: "approveBuilderFee",
      maxFeeRate: "1%",
    });
    expect(buildApproveBuilderFee("0.04%").maxFeeRate).toBe("0.04%");
  });

  it("rejects bare numbers and bad formats", () => {
    expect(() => buildApproveBuilderFee("1")).toThrow();
    expect(() => buildApproveBuilderFee("1.5")).toThrow();
    expect(() => buildApproveBuilderFee("one percent")).toThrow();
  });
});
