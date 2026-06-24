import { describe, expect, it } from "vitest";

import { buildHlOrderAction } from "../lib/agent-trade/orders";
import {
  filterAndSortMarkets,
  joinPerpMarkets,
  marketToSnapshot,
  resolveSelectedMarket,
} from "../lib/agent-trade/markets";
import type { OrderDraft } from "../lib/agent-trade/types";

const joined = joinPerpMarkets({
  markets: {
    perps: [
      { name: "BTC", assetIndex: 0, szDecimals: 5, maxLeverage: 40 },
      { name: "ETH", assetIndex: 1, szDecimals: 4, maxLeverage: 25 },
      { name: "SOL", assetIndex: 5, szDecimals: 2, maxLeverage: 20 },
      { name: "kPEPE", assetIndex: 9, szDecimals: 0, maxLeverage: 10 },
    ],
  },
  stats: {
    perps: [
      {
        name: "BTC",
        assetIndex: 0,
        markPx: "100000",
        prevDayPx: "99000",
        dayNtlVlm: "2000000000",
        openInterest: "45000",
        funding: "0.00012",
      },
      {
        name: "ETH",
        assetIndex: 1,
        markPx: "4000",
        prevDayPx: "3700",
        dayNtlVlm: "900000000",
        openInterest: "500000",
        funding: "0.00035",
      },
      {
        name: "SOL",
        assetIndex: 5,
        markPx: "150",
        prevDayPx: "149",
        dayNtlVlm: "100000000",
        openInterest: "100000",
        funding: "0.00001",
      },
      {
        name: "kPEPE",
        assetIndex: 9,
        markPx: "0.013",
        prevDayPx: "0.012",
        dayNtlVlm: "20000000",
        openInterest: "1000000000",
        funding: "0.00002",
      },
    ],
  },
});

function draft(sizeBtc: number): OrderDraft {
  return {
    symbol: "ETH-USD",
    side: "long",
    orderType: "market",
    sizeBtc,
    leverage: 2,
    marginMode: "isolated",
    reduceOnly: false,
    fromAgent: false,
  };
}

describe("Agent.trade market scanner helpers", () => {
  it("joins metadata and stats and assigns deterministic opportunity labels", () => {
    const btc = joined.find((market) => market.symbol === "BTC");
    const eth = joined.find((market) => market.symbol === "ETH");

    expect(btc?.assetIndex).toBe(0);
    expect(btc?.openInterestUsd).toBe(4_500_000_000);
    expect(btc?.opportunityLabels).toContain("high volume");
    expect(eth?.opportunityLabels).toContain("funding elevated");
    expect(eth?.opportunityLabels).toContain("range mover");
  });

  it("filters and sorts markets for scanner views", () => {
    const visible = filterAndSortMarkets({
      markets: joined,
      query: "E",
      filter: "funding",
      sort: "funding",
    });

    expect(visible.map((market) => market.symbol)).toEqual(["ETH"]);
  });

  it("falls back safely to BTC for unsupported terminal symbols", () => {
    const resolved = resolveSelectedMarket({ symbol: "NOTREAL", markets: joined, fallbackSymbol: "BTC" });
    expect(resolved?.symbol).toBe("BTC");
    expect(resolved?.assetIndex).toBe(0);
  });

  it("resolves non-BTC/ETH and mixed-case markets through market metadata", () => {
    const sol = resolveSelectedMarket({ symbol: "SOL-USD", markets: joined, fallbackSymbol: "BTC" });
    const pepe = resolveSelectedMarket({ symbol: "KPEPE-USD", markets: joined, fallbackSymbol: "BTC" });
    const filtered = filterAndSortMarkets({
      markets: joined,
      query: "kpepe",
      filter: "all",
      sort: "symbol",
    });

    expect(sol?.symbol).toBe("SOL");
    expect(sol?.assetIndex).toBe(5);
    expect(pepe?.symbol).toBe("kPEPE");
    expect(pepe?.assetIndex).toBe(9);
    expect(filtered.map((market) => market.symbol)).toEqual(["kPEPE"]);
  });

  it("preserves unknown OI change through terminal market snapshots", () => {
    const eth = resolveSelectedMarket({ symbol: "ETH", markets: joined, fallbackSymbol: "BTC" });
    if (!eth) throw new Error("missing ETH");

    const snapshot = marketToSnapshot(eth, {
      asks: [{ price: eth.markPrice + 1, size: 1 }],
      bids: [{ price: eth.markPrice - 1, size: 1 }],
    });

    expect(eth.openInterestChangePct).toBeNull();
    expect(snapshot.openInterestChangePct).toBeNull();
  });
});

describe("Agent.trade selected-market order action builder", () => {
  it("uses BTC asset index for BTC", () => {
    const btc = resolveSelectedMarket({ symbol: "BTC", markets: joined, fallbackSymbol: "BTC" });
    if (!btc) throw new Error("missing BTC");

    const action = buildHlOrderAction(draft(0.01234567), {
      assetIndex: btc.assetIndex,
      markPrice: btc.markPrice,
      szDecimals: btc.szDecimals,
    });

    expect(action.orders[0].a).toBe(0);
    expect(action.orders[0].s).toBe("0.01235");
  });

  it("uses another supported perp asset index and precision", () => {
    const eth = resolveSelectedMarket({ symbol: "ETH", markets: joined, fallbackSymbol: "BTC" });
    if (!eth) throw new Error("missing ETH");

    const action = buildHlOrderAction(draft(1.23456), {
      assetIndex: eth.assetIndex,
      markPrice: eth.markPrice,
      szDecimals: eth.szDecimals,
    });

    expect(action.orders[0].a).toBe(1);
    expect(action.orders[0].s).toBe("1.2346");
  });

  it("unsupported symbol resolves to BTC before action building", () => {
    const fallback = resolveSelectedMarket({ symbol: "NOPE", markets: joined, fallbackSymbol: "BTC" });
    if (!fallback) throw new Error("missing fallback");

    const action = buildHlOrderAction(draft(0.1), {
      assetIndex: fallback.assetIndex,
      markPrice: fallback.markPrice,
      szDecimals: fallback.szDecimals,
    });

    expect(fallback.symbol).toBe("BTC");
    expect(action.orders[0].a).toBe(0);
  });
});
