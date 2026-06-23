import type { SharedTradingSnapshot } from "./types";

const now = Date.now();

export const MOCK_TRADING_SNAPSHOT: SharedTradingSnapshot = {
  asOf: now,
  market: {
    symbol: "BTC-USD",
    base: "BTC",
    venue: "Hyperliquid",
    assetIndex: 0,
    szDecimals: 5,
    maxLeverage: 40,
    markPrice: 104_820.5,
    oraclePrice: 104_806.2,
    change24hPct: 2.14,
    change24hAbs: 2196.4,
    fundingRatePct: 0.012,
    openInterestUsd: 4_820_000_000,
    openInterestChangePct: 7.6,
    volume24hUsd: 1_940_000_000,
    liquidityUsd: 38_200_000,
    nextFundingMinutes: 42,
    dataAgeSeconds: 3,
    source: "mock",
  },
  orderBook: {
    asks: [
      { price: 104_861.5, size: 1.14 },
      { price: 104_854.0, size: 0.88 },
      { price: 104_842.5, size: 1.93 },
      { price: 104_834.0, size: 0.64 },
      { price: 104_829.5, size: 2.12 },
      { price: 104_825.0, size: 0.95 },
    ],
    bids: [
      { price: 104_816.0, size: 1.21 },
      { price: 104_808.5, size: 2.34 },
      { price: 104_797.0, size: 0.72 },
      { price: 104_784.5, size: 1.86 },
      { price: 104_776.0, size: 1.03 },
      { price: 104_761.5, size: 2.58 },
    ],
  },
  recentTrades: [
    { side: "buy", price: 104_819.5, size: 0.042, timestamp: now - 14_000 },
    { side: "sell", price: 104_812.0, size: 0.118, timestamp: now - 31_000 },
    { side: "buy", price: 104_823.5, size: 0.067, timestamp: now - 47_000 },
    { side: "buy", price: 104_831.0, size: 0.025, timestamp: now - 75_000 },
    { side: "sell", price: 104_802.5, size: 0.091, timestamp: now - 92_000 },
  ],
  account: {
    address: "0xA9c2E4f805dB9E58b9d09B817f0f1dB585E2c111",
    equityUsd: 26_480.42,
    availableUsd: 18_940.18,
    marginUsedUsd: 7_540.24,
    unrealizedPnlUsd: 824.12,
    dailyLiveNotionalUsedUsd: 0,
    simulatedBalanceUsd: 50_000,
    positions: [
      {
        symbol: "BTC-USD",
        base: "BTC",
        side: "long",
        size: 0.18,
        leverage: 4,
        marginMode: "isolated",
        entryPrice: 101_940,
        markPrice: 104_820.5,
        liquidationPrice: 78_940,
        pnlUsd: 518.49,
        pnlPct: 2.82,
        marginUsd: 4_588.2,
        fundingUsd: -12.86,
        takeProfit: 110_400,
        stopLoss: 101_900,
      },
      {
        symbol: "SOL-USD",
        base: "SOL",
        side: "short",
        size: 42,
        leverage: 3,
        marginMode: "cross",
        entryPrice: 146.2,
        markPrice: 143.9,
        liquidationPrice: 191.4,
        pnlUsd: 96.6,
        pnlPct: 1.57,
        marginUsd: 2_047,
        fundingUsd: 4.12,
      },
    ],
    openOrders: [
      {
        symbol: "BTC-USD",
        side: "sell",
        type: "limit",
        price: 110_400,
        size: 0.18,
        reduceOnly: true,
        timestamp: now - 28 * 60_000,
      },
      {
        symbol: "SOL-USD",
        side: "buy",
        type: "limit",
        price: 139.8,
        size: 42,
        reduceOnly: true,
        timestamp: now - 47 * 60_000,
      },
    ],
    fills: [
      {
        symbol: "BTC-USD",
        side: "buy",
        price: 101_940,
        size: 0.18,
        feeUsd: 8.26,
        timestamp: now - 4 * 60 * 60_000,
      },
      {
        symbol: "SOL-USD",
        side: "sell",
        price: 146.2,
        size: 42,
        feeUsd: 2.76,
        timestamp: now - 7 * 60 * 60_000,
      },
    ],
  },
};

export function buildFallbackOrderBook(markPrice: number): SharedTradingSnapshot["orderBook"] {
  const steps = [5, 13, 24, 39, 57, 82];
  return {
    asks: steps.map((step, index) => ({
      price: markPrice + step,
      size: Number((0.55 + index * 0.31).toFixed(3)),
    })),
    bids: steps.map((step, index) => ({
      price: markPrice - step,
      size: Number((0.7 + index * 0.29).toFixed(3)),
    })),
  };
}
