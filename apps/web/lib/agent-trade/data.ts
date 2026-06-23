import { API_BASE_URL } from "@/lib/api";

import {
  joinPerpMarkets,
  marketToSnapshot,
  normalizeSymbol,
  parseBookLevels,
  resolveSelectedMarket,
  type L2BookWireResponse,
  type MarketStatsWireResponse,
  type MarketsWireResponse,
} from "./markets";
import { MOCK_TRADING_SNAPSHOT, buildFallbackOrderBook } from "./mock-data";
import type { SharedTradingSnapshot } from "./types";

export interface SelectedMarketResult {
  snapshot: SharedTradingSnapshot;
  requestedSymbol: string;
  resolvedSymbol: string;
  usedFallback: boolean;
}

export function applyMarketToAccount(
  snapshot: SharedTradingSnapshot,
): SharedTradingSnapshot["account"] {
  const { market } = snapshot;
  const entryPrice = Number((market.markPrice * 0.973).toFixed(2));
  const takeProfit = Number((market.markPrice * 1.053).toFixed(2));
  const stopLoss = Number((market.markPrice * 0.972).toFixed(2));
  const demoSize = Number(Math.max(1 / 10 ** market.szDecimals, 5000 / market.markPrice).toFixed(market.szDecimals));

  return {
    ...snapshot.account,
    positions: [
      {
        symbol: market.symbol,
        base: market.base,
        side: "long",
        size: demoSize,
        leverage: Math.min(4, market.maxLeverage),
        marginMode: "isolated",
        entryPrice,
        markPrice: market.markPrice,
        liquidationPrice: Number((market.markPrice * 0.753).toFixed(2)),
        pnlUsd: (market.markPrice - entryPrice) * demoSize,
        pnlPct: ((market.markPrice - entryPrice) / entryPrice) * 100,
        marginUsd: (entryPrice * demoSize) / 4,
        fundingUsd: -Math.abs((market.fundingRatePct / 100) * entryPrice * demoSize),
        takeProfit,
        stopLoss,
      },
    ],
    openOrders: [
      {
        symbol: market.symbol,
        side: "sell",
        type: "limit",
        price: takeProfit,
        size: demoSize,
        reduceOnly: true,
        timestamp: snapshot.asOf - 28 * 60_000,
      },
    ],
    fills: [
      {
        symbol: market.symbol,
        side: "buy",
        price: entryPrice,
        size: demoSize,
        feeUsd: entryPrice * demoSize * 0.00045,
        timestamp: snapshot.asOf - 4 * 60 * 60_000,
      },
    ],
  };
}

export async function loadTradingSnapshot(symbol?: string | null): Promise<SelectedMarketResult> {
  const requestedSymbol = symbol ?? "BTC";
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2500);

  try {
    const [marketsRes, statsRes] = await Promise.all([
      fetch(`${API_BASE_URL}/markets`, { cache: "no-store", signal: controller.signal }),
      fetch(`${API_BASE_URL}/marketStats`, { cache: "no-store", signal: controller.signal }),
    ]);
    if (!marketsRes.ok || !statsRes.ok) {
      return fallbackResult(requestedSymbol);
    }

    const [marketsWire, statsWire] = (await Promise.all([
      marketsRes.json(),
      statsRes.json(),
    ])) as [MarketsWireResponse, MarketStatsWireResponse];
    const markets = joinPerpMarkets({ markets: marketsWire, stats: statsWire });
    const selected = resolveSelectedMarket({ symbol, markets, fallbackSymbol: "BTC" });
    if (!selected) {
      return fallbackResult(requestedSymbol);
    }

    const bookRes = await fetch(`${API_BASE_URL}/l2Book?coin=${encodeURIComponent(selected.symbol)}&nSigFigs=5`, {
      cache: "no-store",
      signal: controller.signal,
    });
    const bookWire = bookRes.ok ? (await bookRes.json() as L2BookWireResponse) : undefined;
    const parsedBook = {
      bids: parseBookLevels(bookWire?.levels?.[0]),
      asks: parseBookLevels(bookWire?.levels?.[1]),
    };
    const orderBook =
      parsedBook.asks.length > 0 && parsedBook.bids.length > 0
        ? parsedBook
        : buildFallbackOrderBook(selected.markPrice);
    const marketSnapshot = marketToSnapshot(selected, orderBook);
    const snapshot: SharedTradingSnapshot = {
      ...MOCK_TRADING_SNAPSHOT,
      asOf: Date.now(),
      market: marketSnapshot,
      orderBook,
      recentTrades: MOCK_TRADING_SNAPSHOT.recentTrades.map((trade, index) => ({
        ...trade,
        price: Number((selected.markPrice + (index - 2) * selected.markPrice * 0.00012).toFixed(2)),
        size: Number((Math.max(1 / 10 ** selected.szDecimals, trade.size)).toFixed(selected.szDecimals)),
      })),
    };

    return {
      snapshot: {
        ...snapshot,
        account: applyMarketToAccount(snapshot),
      },
      requestedSymbol,
      resolvedSymbol: selected.symbol,
      usedFallback: selected.symbol !== normalizeSymbol(requestedSymbol),
    };
  } catch {
    return fallbackResult(requestedSymbol);
  } finally {
    window.clearTimeout(timeout);
  }
}

function fallbackResult(requestedSymbol: string): SelectedMarketResult {
  return {
    snapshot: MOCK_TRADING_SNAPSHOT,
    requestedSymbol,
    resolvedSymbol: "BTC",
    usedFallback: true,
  };
}
