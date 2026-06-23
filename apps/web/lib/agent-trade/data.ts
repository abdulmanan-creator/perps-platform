import { API_BASE_URL } from "@/lib/api";

import { MOCK_TRADING_SNAPSHOT, buildFallbackOrderBook } from "./mock-data";
import type { BookLevel, SharedTradingSnapshot } from "./types";

interface MarketStatsResponse {
  perps?: {
    assetIndex: number;
    name: string;
    markPx?: string;
    midPx?: string;
    prevDayPx?: string;
    dayNtlVlm?: string;
    openInterest?: string;
    funding?: string;
  }[];
}

interface L2BookResponse {
  levels?: {
    px: string;
    sz: string;
  }[][];
}

function num(input: string | number | undefined, fallback: number): number {
  if (input === undefined) {
    return fallback;
  }
  const parsed = typeof input === "number" ? input : Number(input);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseLevels(levels: { px: string; sz: string }[] | undefined): BookLevel[] {
  return (levels ?? []).slice(0, 8).map((level) => ({
    price: num(level.px, 0),
    size: num(level.sz, 0),
  }));
}

export async function loadTradingSnapshot(): Promise<SharedTradingSnapshot> {
  const fallback = MOCK_TRADING_SNAPSHOT;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2500);

  try {
    const [statsRes, bookRes] = await Promise.all([
      fetch(`${API_BASE_URL}/marketStats`, { cache: "no-store", signal: controller.signal }),
      fetch(`${API_BASE_URL}/l2Book?coin=BTC&nSigFigs=5`, { cache: "no-store", signal: controller.signal }),
    ]);

    if (!statsRes.ok || !bookRes.ok) {
      return fallback;
    }

    const stats = (await statsRes.json()) as MarketStatsResponse;
    const book = (await bookRes.json()) as L2BookResponse;
    const btc = stats.perps?.find((market) => market.name === "BTC");
    if (!btc) {
      return fallback;
    }

    const markPrice = num(btc.markPx ?? btc.midPx, fallback.market.markPrice);
    const prevDay = num(btc.prevDayPx, markPrice - fallback.market.change24hAbs);
    const change24hAbs = markPrice - prevDay;
    const change24hPct = prevDay > 0 ? (change24hAbs / prevDay) * 100 : fallback.market.change24hPct;
    const asks = parseLevels(book.levels?.[1]);
    const bids = parseLevels(book.levels?.[0]);

    const btcEntry = Number((markPrice * 0.973).toFixed(1));
    const btcTakeProfit = Number((markPrice * 1.053).toFixed(1));
    const btcStopLoss = Number((markPrice * 0.972).toFixed(1));

    return {
      ...fallback,
      asOf: Date.now(),
      market: {
        ...fallback.market,
        markPrice,
        oraclePrice: markPrice,
        change24hAbs,
        change24hPct,
        fundingRatePct: num(btc.funding, fallback.market.fundingRatePct / 100) * 100,
        openInterestUsd: num(btc.openInterest, fallback.market.openInterestUsd / markPrice) * markPrice,
        volume24hUsd: num(btc.dayNtlVlm, fallback.market.volume24hUsd),
        dataAgeSeconds: 0,
        source: "live-mainnet",
      },
      orderBook: asks.length > 0 && bids.length > 0 ? { asks, bids } : buildFallbackOrderBook(markPrice),
      recentTrades: fallback.recentTrades.map((trade, index) => ({
        ...trade,
        price: Number((markPrice + (index - 2) * 7.5).toFixed(1)),
      })),
      account: {
        ...fallback.account,
        positions: fallback.account.positions.map((position) =>
          position.symbol === "BTC-USD"
            ? {
                ...position,
                entryPrice: btcEntry,
                markPrice,
                liquidationPrice: Number((markPrice * 0.753).toFixed(1)),
                pnlUsd: (markPrice - btcEntry) * position.size,
                pnlPct: ((markPrice - btcEntry) / btcEntry) * 100,
                takeProfit: btcTakeProfit,
                stopLoss: btcStopLoss,
              }
            : position,
        ),
        openOrders: fallback.account.openOrders.map((order) =>
          order.symbol === "BTC-USD"
            ? { ...order, price: btcTakeProfit }
            : order,
        ),
        fills: fallback.account.fills.map((fill) =>
          fill.symbol === "BTC-USD"
            ? { ...fill, price: btcEntry }
            : fill,
        ),
      },
    };
  } catch {
    return fallback;
  } finally {
    window.clearTimeout(timeout);
  }
}
