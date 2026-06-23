import { describe, expect, it } from "vitest";

import {
  calculateDraftImpact,
  calculatePortfolioExposure,
  calculatePositionNotional,
  classifyPortfolioRisk,
} from "../lib/agent-trade/portfolio";
import type { AccountSnapshot, MarketSnapshot, OrderDraft, Position } from "../lib/agent-trade/types";

const baseMarket: MarketSnapshot = {
  symbol: "ETH-USD",
  base: "ETH",
  venue: "Hyperliquid",
  assetIndex: 1,
  szDecimals: 4,
  maxLeverage: 25,
  markPrice: 4000,
  oraclePrice: 3998,
  change24hPct: 2.1,
  change24hAbs: 82,
  fundingRatePct: 0.011,
  openInterestUsd: 1_800_000_000,
  openInterestChangePct: null,
  volume24hUsd: 3_000_000_000,
  liquidityUsd: 12_000_000,
  nextFundingMinutes: 31,
  dataAgeSeconds: 2,
  source: "live-mainnet",
};

function position(patch: Partial<Position>): Position {
  return {
    symbol: "ETH-USD",
    base: "ETH",
    side: "long",
    size: 2,
    leverage: 4,
    marginMode: "isolated",
    entryPrice: 3900,
    markPrice: 4000,
    liquidationPrice: 3100,
    pnlUsd: 200,
    pnlPct: 2.56,
    marginUsd: 1950,
    fundingUsd: -4,
    ...patch,
  };
}

function account(positions: Position[]): AccountSnapshot {
  return {
    address: "0x0000000000000000000000000000000000000000",
    equityUsd: 20_000,
    availableUsd: 14_000,
    marginUsedUsd: 4_000,
    unrealizedPnlUsd: 300,
    dailyLiveNotionalUsedUsd: 250,
    simulatedBalanceUsd: 50_000,
    positions,
    openOrders: [],
    fills: [],
  };
}

function draft(patch: Partial<OrderDraft> = {}): OrderDraft {
  return {
    symbol: "ETH-USD",
    side: "long",
    orderType: "market",
    sizeBtc: 1.5,
    leverage: 3,
    marginMode: "isolated",
    reduceOnly: false,
    fromAgent: false,
    ...patch,
  };
}

describe("Agent.trade portfolio helpers", () => {
  it("calculates position notional from absolute size and mark", () => {
    expect(calculatePositionNotional(position({ size: -2, markPrice: 4100 }))).toBe(8200);
  });

  it("separates long, short, gross, and net exposure", () => {
    const exposure = calculatePortfolioExposure(account([
      position({ symbol: "ETH-USD", side: "long", size: 2, markPrice: 4000 }),
      position({ symbol: "BTC-USD", base: "BTC", side: "short", size: 0.05, markPrice: 100_000 }),
    ]), "ETH-USD");

    expect(exposure.longNotionalUsd).toBe(8000);
    expect(exposure.shortNotionalUsd).toBe(5000);
    expect(exposure.netExposureUsd).toBe(3000);
    expect(exposure.grossExposureUsd).toBe(13_000);
    expect(exposure.selectedMarketNotionalUsd).toBe(8000);
    expect(exposure.largestPosition?.symbol).toBe("ETH-USD");
  });

  it("calculates selected-market draft impact", () => {
    const impact = calculateDraftImpact({
      account: account([position({ symbol: "ETH-USD", side: "long", size: 1, markPrice: 4000 })]),
      market: baseMarket,
      draft: draft({ sizeBtc: 2, leverage: 4 }),
    });

    expect(impact.estimatedNotionalUsd).toBe(8000);
    expect(impact.marginRequiredUsd).toBe(2000);
    expect(impact.postTradeAvailableUsd).toBe(12_000);
    expect(impact.addedExposureUsd).toBe(8000);
    expect(impact.selectedMarketConcentrationPct).toBeCloseTo(100);
    expect(impact.liquidationDistancePct).toBeGreaterThan(20);
  });

  it("uses negative added exposure for short drafts", () => {
    const impact = calculateDraftImpact({
      account: account([]),
      market: baseMarket,
      draft: draft({ side: "short", sizeBtc: 1, leverage: 5 }),
    });

    expect(impact.addedExposureUsd).toBe(-4000);
    expect(impact.estimatedLiquidationPrice).toBeGreaterThan(baseMarket.markPrice);
  });

  it("classifies crowded concentration and near-liquidation risk", () => {
    const riskyAccount = account([
      position({ symbol: "ETH-USD", side: "long", size: 5, markPrice: 4000, liquidationPrice: 3820 }),
      position({ symbol: "BTC-USD", base: "BTC", side: "short", size: 0.02, markPrice: 100_000 }),
    ]);
    const exposure = calculatePortfolioExposure(riskyAccount, "ETH-USD");
    const labels = classifyPortfolioRisk({
      account: riskyAccount,
      exposure,
      selectedSymbol: "ETH-USD",
      mode: "live",
    });

    expect(labels).toContain("crowded exposure");
    expect(labels).toContain("near liquidation");
    expect(labels).toContain("unhedged beta");
  });

  it("labels paper mode and low margin use", () => {
    const lowRiskAccount = account([position({ size: 0.2, markPrice: 4000, liquidationPrice: 2500 })]);
    lowRiskAccount.marginUsedUsd = 500;
    const labels = classifyPortfolioRisk({
      account: lowRiskAccount,
      exposure: calculatePortfolioExposure(lowRiskAccount, "ETH-USD"),
      selectedSymbol: "ETH-USD",
      mode: "paper",
    });

    expect(labels).toContain("paper only");
    expect(labels).toContain("low margin use");
  });
});
