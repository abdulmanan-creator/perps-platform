import type { PositionsResponse, UserFillsResponse } from "@alchemy-hl/sdk-preview";

import { api, API_BASE_URL } from "../api";

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
import { loadPaperAccount, mergePaperAccount } from "./paper";
import {
  buildFallbackTerminalChartData,
  normalizeTerminalCandlesResponse,
  type TerminalCandlesWireResponse,
  type TerminalChartData,
  type TerminalChartInterval,
} from "./terminal";
import type { SharedTradingSnapshot } from "./types";

export interface SelectedMarketResult {
  snapshot: SharedTradingSnapshot;
  requestedSymbol: string;
  resolvedSymbol: string;
  usedFallback: boolean;
}

export interface LoadTradingSnapshotOptions {
  accountAddress?: string;
}

export function applyMarketToAccount(
  snapshot: SharedTradingSnapshot,
): SharedTradingSnapshot["account"] {
  const { market } = snapshot;
  const entryPrice = Number((market.markPrice * 0.973).toFixed(2));
  const takeProfit = Number((market.markPrice * 1.053).toFixed(2));
  const stopLoss = Number((market.markPrice * 0.972).toFixed(2));
  const demoSize = Number(Math.max(1 / 10 ** market.szDecimals, 5000 / market.markPrice).toFixed(market.szDecimals));

  const hedgeSymbol = market.base === "ETH" ? "BTC-USD" : "ETH-USD";
  const hedgeBase = hedgeSymbol.replace("-USD", "");
  const hedgeMark = Number((market.base === "ETH" ? market.markPrice * 28 : market.markPrice * 0.038).toFixed(2));
  const hedgeEntry = Number((hedgeMark * 1.041).toFixed(2));
  const hedgeSize = Number(Math.max(1 / 1000, 2600 / hedgeMark).toFixed(3));
  const selectedPnlUsd = (market.markPrice - entryPrice) * demoSize;
  const hedgePnlUsd = (hedgeEntry - hedgeMark) * hedgeSize;
  const selectedMarginUsd = (entryPrice * demoSize) / 4;
  const hedgeMarginUsd = (hedgeEntry * hedgeSize) / 3;

  return {
    ...snapshot.account,
    valueKind: "paper",
    sourceLabel: "Simulated paper account",
    liveAccountDataLoaded: false,
    liveAccountDataUnavailable: false,
    availableUsd: 18_740,
    equityUsd: 24_860 + selectedPnlUsd + hedgePnlUsd,
    marginUsedUsd: selectedMarginUsd + hedgeMarginUsd,
    unrealizedPnlUsd: selectedPnlUsd + hedgePnlUsd,
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
        pnlUsd: selectedPnlUsd,
        pnlPct: ((market.markPrice - entryPrice) / entryPrice) * 100,
        marginUsd: selectedMarginUsd,
        fundingUsd: -Math.abs((market.fundingRatePct / 100) * entryPrice * demoSize),
        takeProfit,
        stopLoss,
      },
      {
        symbol: hedgeSymbol,
        base: hedgeBase,
        side: "short",
        size: hedgeSize,
        leverage: 3,
        marginMode: "cross",
        entryPrice: hedgeEntry,
        markPrice: hedgeMark,
        liquidationPrice: Number((hedgeMark * 1.182).toFixed(2)),
        pnlUsd: hedgePnlUsd,
        pnlPct: ((hedgeEntry - hedgeMark) / hedgeEntry) * 100,
        marginUsd: hedgeMarginUsd,
        fundingUsd: 2.84,
        stopLoss: Number((hedgeMark * 1.071).toFixed(2)),
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
      {
        symbol: hedgeSymbol,
        side: "buy",
        type: "limit",
        price: Number((hedgeMark * 0.958).toFixed(2)),
        size: Number((hedgeSize * 0.5).toFixed(2)),
        reduceOnly: true,
        timestamp: snapshot.asOf - 54 * 60_000,
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
      {
        symbol: hedgeSymbol,
        side: "sell",
        price: hedgeEntry,
        size: hedgeSize,
        feeUsd: hedgeEntry * hedgeSize * 0.00045,
        timestamp: snapshot.asOf - 7 * 60 * 60_000,
      },
    ],
  };
}

export async function loadTradingSnapshot(
  symbol?: string | null,
  options: LoadTradingSnapshotOptions = {},
): Promise<SelectedMarketResult> {
  const requestedSymbol = symbol ?? "BTC";
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 2500);

  try {
    const [marketsRes, statsRes] = await Promise.all([
      fetch(`${API_BASE_URL}/markets`, { cache: "no-store", signal: controller.signal }),
      fetch(`${API_BASE_URL}/marketStats`, { cache: "no-store", signal: controller.signal }),
    ]);
    if (!marketsRes.ok || !statsRes.ok) {
      return await fallbackResult(requestedSymbol);
    }

    const [marketsWire, statsWire] = (await Promise.all([
      marketsRes.json(),
      statsRes.json(),
    ])) as [MarketsWireResponse, MarketStatsWireResponse];
    const markets = joinPerpMarkets({ markets: marketsWire, stats: statsWire });
    const selected = resolveSelectedMarket({ symbol, markets, fallbackSymbol: "BTC" });
    if (!selected) {
      return await fallbackResult(requestedSymbol);
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

    const marketAccountSnapshot = await applyAccountState(snapshot, options.accountAddress);
    const paperAccount = await loadPaperAccount();

    return {
      snapshot: mergePaperAccount(marketAccountSnapshot, paperAccount),
      requestedSymbol,
      resolvedSymbol: selected.symbol,
      usedFallback: selected.symbol !== normalizeSymbol(requestedSymbol),
    };
  } catch {
    return await fallbackResult(requestedSymbol, options);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function loadTerminalCandles(
  market: SharedTradingSnapshot["market"],
  interval: TerminalChartInterval,
): Promise<TerminalChartData> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 2500);

  try {
    const res = await fetch(
      `${API_BASE_URL}/agent-trade/candles?symbol=${encodeURIComponent(market.symbol)}&interval=${encodeURIComponent(interval)}`,
      { cache: "no-store", signal: controller.signal },
    );
    if (!res.ok) {
      return buildFallbackTerminalChartData(market, interval, `Candle API returned ${res.status}.`);
    }

    const wire = (await res.json()) as TerminalCandlesWireResponse;
    return normalizeTerminalCandlesResponse(wire, market, interval);
  } catch (err) {
    const message = err instanceof Error && err.name === "AbortError"
      ? "Candle API timed out."
      : "Candle API unavailable.";
    return buildFallbackTerminalChartData(market, interval, message);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function fallbackResult(
  requestedSymbol: string,
  options: LoadTradingSnapshotOptions = {},
): Promise<SelectedMarketResult> {
  const paperAccount = await loadPaperAccount();
  const baseSnapshot = await applyAccountState(MOCK_TRADING_SNAPSHOT, options.accountAddress);
  const snapshot = mergePaperAccount(baseSnapshot, paperAccount);
  return {
    snapshot,
    requestedSymbol,
    resolvedSymbol: "BTC",
    usedFallback: true,
  };
}

async function applyAccountState(
  snapshot: SharedTradingSnapshot,
  accountAddress?: string,
): Promise<SharedTradingSnapshot> {
  if (!isHexAddress(accountAddress)) {
    return {
      ...snapshot,
      account: applyMarketToAccount(snapshot),
    };
  }

  try {
    const liveAccount = await loadReadOnlyHyperliquidAccount(accountAddress, snapshot);
    return {
      ...snapshot,
      account: liveAccount,
    };
  } catch {
    return {
      ...snapshot,
      account: {
        ...applyMarketToAccount(snapshot),
        address: accountAddress,
        liveAccountDataUnavailable: true,
        sourceLabel: "Read-only account unavailable; showing simulated account",
      },
    };
  }
}

export async function loadReadOnlyHyperliquidAccount(
  accountAddress: `0x${string}`,
  snapshot: SharedTradingSnapshot,
): Promise<SharedTradingSnapshot["account"]> {
  const [balance, positions, fills] = await Promise.all([
    api.balance(accountAddress),
    readOptionalPositions(accountAddress),
    readOptionalFills(accountAddress),
  ]);

  return {
    address: accountAddress,
    valueKind: "real",
    sourceLabel: "Read-only Hyperliquid account",
    liveAccountDataLoaded: true,
    liveAccountDataUnavailable: false,
    equityUsd: toNumber(balance.accountValue),
    availableUsd: toNumber(balance.withdrawable),
    marginUsedUsd: toNumber(balance.marginUsed),
    unrealizedPnlUsd: positions.positions.reduce(
      (sum, position) => sum + toNumber(position.unrealizedPnl),
      0,
    ),
    dailyLiveNotionalUsedUsd: 0,
    simulatedBalanceUsd: snapshot.account.simulatedBalanceUsd,
    positions: positions.positions.map((position) => {
      const size = Math.abs(toNumber(position.size));
      const positionValue = toNumber(position.positionValue);
      const markPrice = size > 0 ? positionValue / size : toNumber(position.entryPx);
      return {
        symbol: `${position.coin}-USD`,
        base: position.coin,
        mode: "live",
        side: position.side,
        size,
        leverage: position.leverage,
        marginMode: position.leverageMode,
        entryPrice: toNumber(position.entryPx),
        markPrice,
        liquidationPrice: position.liquidationPx == null ? 0 : toNumber(position.liquidationPx),
        pnlUsd: toNumber(position.unrealizedPnl),
        pnlPct: toNumber(position.returnOnEquity) * 100,
        marginUsd: toNumber(position.marginUsed),
        fundingUsd: 0,
      };
    }),
    openOrders: [],
    fills: fills.fills.map((fill) => ({
      symbol: `${fill.coin}-USD`,
      mode: "live",
      side: fill.side === "B" ? "buy" : "sell",
      orderId: String(fill.oid),
      price: toNumber(fill.px),
      size: toNumber(fill.sz),
      feeUsd: Math.abs(toNumber(fill.fee ?? "0")) + Math.abs(toNumber(fill.builderFee ?? "0")),
      timestamp: fill.time,
    })),
  };
}

async function readOptionalPositions(accountAddress: `0x${string}`): Promise<PositionsResponse> {
  try {
    return await api.positions(accountAddress);
  } catch {
    return { user: accountAddress, positions: [] };
  }
}

async function readOptionalFills(accountAddress: `0x${string}`): Promise<UserFillsResponse> {
  try {
    return await api.userFills(accountAddress, 20);
  } catch {
    return { user: accountAddress, fills: [] };
  }
}

function isHexAddress(value: string | undefined): value is `0x${string}` {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/u.test(value);
}

function toNumber(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
