import { estimateTopBookLiquidityUsd, normalizeSymbol, parseBookLevels } from "./markets";
import { terminalIntervalSeconds, type TerminalCandle, type TerminalChartData, type TerminalChartInterval } from "./terminal";
import type { RecentTrade, SharedTradingSnapshot } from "./types";

export type TerminalStreamStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "rest_fallback"
  | "disconnected"
  | "degraded";

export type TerminalStreamEvent =
  | {
      type: "activeAssetCtx";
      coin: string;
      receivedAt: number;
      ctx: {
        markPx?: number;
        midPx?: number;
        prevDayPx?: number;
        dayNtlVlm?: number;
        openInterest?: number;
        funding?: number;
        oraclePx?: number;
      };
    }
  | {
      type: "l2Book";
      coin: string;
      receivedAt: number;
      bids: { px: string; sz: string }[];
      asks: { px: string; sz: string }[];
    }
  | {
      type: "trades";
      coin: string;
      receivedAt: number;
      trades: RecentTrade[];
    }
  | {
      type: "candle";
      coin: string;
      receivedAt: number;
      interval: TerminalChartInterval;
      candles: TerminalCandle[];
    };

export interface TerminalStreamSubscription {
  type: "activeAssetCtx" | "l2Book" | "trades" | "candle";
  coin: string;
  interval?: TerminalChartInterval;
  nSigFigs?: number;
  fast?: boolean;
}

export interface TerminalLivePriceUpdate {
  price: number;
  timestamp: number;
  receivedAt: number;
}

export function hyperliquidWsUrlForVenue(executionVenue: string | undefined): string {
  const configured = process.env.NEXT_PUBLIC_HYPERLIQUID_WS_URL;
  if (configured) {
    return configured;
  }
  if (executionVenue?.toLowerCase().includes("testnet")) {
    return "wss://api.hyperliquid-testnet.xyz/ws";
  }
  return "wss://api.hyperliquid.xyz/ws";
}

export function terminalStreamStatusLabel(status: TerminalStreamStatus): string {
  switch (status) {
    case "connecting":
      return "Live stream connecting";
    case "live":
      return "Live stream";
    case "reconnecting":
      return "Live stream reconnecting";
    case "rest_fallback":
      return "REST fallback";
    case "disconnected":
      return "Stream disconnected";
    case "degraded":
      return "Stream degraded";
    default:
      return assertNeverStatus(status);
  }
}

export function terminalStreamStatusDetail(status: TerminalStreamStatus): string {
  switch (status) {
    case "connecting":
      return "Connecting to Hyperliquid WebSocket; REST snapshot remains active.";
    case "live":
      return "Hyperliquid WebSocket is updating market data.";
    case "reconnecting":
      return "Reconnecting to Hyperliquid WebSocket; REST fallback remains active.";
    case "rest_fallback":
      return "Hyperliquid WebSocket is unavailable; using REST refreshes.";
    case "disconnected":
      return "Hyperliquid WebSocket is not connected.";
    case "degraded":
      return "Some WebSocket messages could not be applied; REST fallback remains active.";
    default:
      return assertNeverStatus(status);
  }
}

export function isTerminalStreamWarning(status: TerminalStreamStatus): boolean {
  return status !== "live";
}

export function terminalMarketSubscriptions(args: {
  coin: string;
  interval: TerminalChartInterval;
}): TerminalStreamSubscription[] {
  return [
    { type: "activeAssetCtx", coin: args.coin },
    { type: "l2Book", coin: args.coin, nSigFigs: 5, fast: true },
    { type: "trades", coin: args.coin },
    { type: "candle", coin: args.coin, interval: args.interval },
  ];
}

export function subscriptionMessage(subscription: TerminalStreamSubscription) {
  const payload: Record<string, unknown> = {
    type: subscription.type,
    coin: subscription.coin,
  };
  if (subscription.type === "candle") {
    payload.interval = subscription.interval;
  }
  if (subscription.type === "l2Book") {
    payload.nSigFigs = subscription.nSigFigs;
    payload.fast = subscription.fast;
  }
  return {
    method: "subscribe",
    subscription: payload,
  };
}

export function unsubscribeMessage(subscription: TerminalStreamSubscription) {
  return {
    ...subscriptionMessage(subscription),
    method: "unsubscribe",
  };
}

export function normalizeTerminalWsMessage(args: {
  message: unknown;
  selectedCoin: string;
  interval: TerminalChartInterval;
  now?: number;
}): TerminalStreamEvent[] {
  const record = objectRecord(args.message);
  if (!record) {
    return [];
  }
  const channel = stringValue(record.channel);
  const data = record.data;
  const receivedAt = args.now ?? Date.now();

  if (!channel || channel === "subscriptionResponse" || channel === "pong") {
    return [];
  }

  switch (channel) {
    case "activeAssetCtx":
      return normalizeActiveAssetCtx({ data, selectedCoin: args.selectedCoin, receivedAt });
    case "l2Book":
      return normalizeL2Book({ data, selectedCoin: args.selectedCoin, receivedAt });
    case "trades":
      return normalizeTrades({ data, selectedCoin: args.selectedCoin, receivedAt });
    case "candle":
      return normalizeCandles({
        data,
        selectedCoin: args.selectedCoin,
        interval: args.interval,
        receivedAt,
      });
    default:
      return [];
  }
}

export function applyTerminalStreamEvent(
  snapshot: SharedTradingSnapshot,
  event: TerminalStreamEvent,
): SharedTradingSnapshot {
  if (normalizeSymbol(event.coin) !== normalizeSymbol(snapshot.market.base)) {
    return snapshot;
  }

  switch (event.type) {
    case "activeAssetCtx":
      return applyAssetContext(snapshot, event);
    case "l2Book": {
      const orderBook = {
        bids: parseBookLevels(event.bids),
        asks: parseBookLevels(event.asks),
      };
      if (orderBook.bids.length === 0 || orderBook.asks.length === 0) {
        return snapshot;
      }
      return {
        ...snapshot,
        asOf: event.receivedAt,
        market: {
          ...snapshot.market,
          liquidityUsd: estimateTopBookLiquidityUsd(orderBook),
          dataAgeSeconds: 0,
          source: "live-mainnet",
        },
        orderBook,
      };
    }
    case "trades":
      return {
        ...snapshot,
        asOf: event.receivedAt,
        recentTrades: mergeRecentTrades(snapshot.recentTrades, event.trades),
      };
    case "candle":
      return snapshot;
    default:
      return assertNeverEvent(event);
  }
}

export function applyTerminalCandleEvent(
  chartData: TerminalChartData,
  event: TerminalStreamEvent,
  interval: TerminalChartInterval,
): TerminalChartData {
  if (event.type !== "candle" || event.interval !== interval) {
    return chartData;
  }

  return {
    interval,
    candles: upsertTerminalCandles(chartData.candles, event.candles),
    source: "hyperliquid",
    fetchedAt: event.receivedAt,
    isFallback: false,
  };
}

export function applyTerminalPriceToChart(
  chartData: TerminalChartData,
  priceUpdate: TerminalLivePriceUpdate,
  interval: TerminalChartInterval,
): TerminalChartData {
  if (!Number.isFinite(priceUpdate.price) || priceUpdate.price <= 0 || chartData.candles.length === 0) {
    return chartData;
  }

  const intervalSeconds = terminalIntervalSeconds(interval);
  const tradeSeconds = Math.floor(priceUpdate.timestamp > 10_000_000_000
    ? priceUpdate.timestamp / 1000
    : priceUpdate.timestamp);
  const bucketTime = Math.floor(tradeSeconds / intervalSeconds) * intervalSeconds;
  const candles = [...chartData.candles];
  const last = candles.at(-1);
  if (!last) {
    return chartData;
  }

  const updateCandle = (candle: TerminalCandle): TerminalCandle => ({
    ...candle,
    high: Math.max(candle.high, priceUpdate.price),
    low: Math.min(candle.low, priceUpdate.price),
    close: priceUpdate.price,
  });

  const existingIndex = candles.findIndex((candle) => candle.time === bucketTime);
  if (existingIndex >= 0) {
    candles[existingIndex] = updateCandle(candles[existingIndex]);
  } else if (bucketTime > last.time) {
    candles.push({
      time: bucketTime,
      open: last.close,
      high: Math.max(last.close, priceUpdate.price),
      low: Math.min(last.close, priceUpdate.price),
      close: priceUpdate.price,
      volume: 0,
    });
  } else {
    candles[candles.length - 1] = updateCandle(last);
  }

  return {
    ...chartData,
    candles: candles.slice(-240),
    livePriceAt: priceUpdate.receivedAt,
  };
}

export function upsertTerminalCandles(
  existing: TerminalCandle[],
  incoming: TerminalCandle[],
  maxCandles = 240,
): TerminalCandle[] {
  const byTime = new Map<number, TerminalCandle>();
  for (const candle of existing) {
    byTime.set(candle.time, candle);
  }
  for (const candle of incoming) {
    if (isValidStreamCandle(candle)) {
      byTime.set(candle.time, candle);
    }
  }
  return [...byTime.values()]
    .sort((a, b) => a.time - b.time)
    .slice(-maxCandles);
}

export function mergeRecentTrades(
  existing: RecentTrade[],
  incoming: RecentTrade[],
  maxTrades = 40,
): RecentTrade[] {
  const byKey = new Map<string, RecentTrade>();
  for (const trade of [...incoming, ...existing]) {
    if (!isValidTrade(trade)) {
      continue;
    }
    byKey.set(tradeKey(trade), trade);
  }
  return [...byKey.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, maxTrades);
}

function normalizeActiveAssetCtx(args: {
  data: unknown;
  selectedCoin: string;
  receivedAt: number;
}): TerminalStreamEvent[] {
  const record = objectRecord(args.data);
  const coin = stringValue(record?.coin);
  const ctxRecord = objectRecord(record?.ctx);
  if (!coin || normalizeSymbol(coin) !== normalizeSymbol(args.selectedCoin) || !ctxRecord) {
    return [];
  }

  return [{
    type: "activeAssetCtx",
    coin,
    receivedAt: args.receivedAt,
    ctx: {
      markPx: finiteNumber(ctxRecord.markPx),
      midPx: finiteNumber(ctxRecord.midPx),
      prevDayPx: finiteNumber(ctxRecord.prevDayPx),
      dayNtlVlm: finiteNumber(ctxRecord.dayNtlVlm),
      openInterest: finiteNumber(ctxRecord.openInterest),
      funding: finiteNumber(ctxRecord.funding),
      oraclePx: finiteNumber(ctxRecord.oraclePx),
    },
  }];
}

function normalizeL2Book(args: {
  data: unknown;
  selectedCoin: string;
  receivedAt: number;
}): TerminalStreamEvent[] {
  const record = objectRecord(args.data);
  const coin = stringValue(record?.coin);
  if (!coin || normalizeSymbol(coin) !== normalizeSymbol(args.selectedCoin)) {
    return [];
  }
  const levels = Array.isArray(record?.levels) ? record.levels : [];
  const bids = parseRawLevels(levels[0]);
  const asks = parseRawLevels(levels[1]);
  if (bids.length === 0 || asks.length === 0) {
    return [];
  }
  return [{
    type: "l2Book",
    coin,
    receivedAt: args.receivedAt,
    bids,
    asks,
  }];
}

function normalizeTrades(args: {
  data: unknown;
  selectedCoin: string;
  receivedAt: number;
}): TerminalStreamEvent[] {
  const rawTrades = Array.isArray(args.data) ? args.data : [];
  const trades = rawTrades
    .map((raw) => parseTrade(raw))
    .filter((trade): trade is RecentTrade & { coin: string } => trade !== undefined)
    .filter((trade) => normalizeSymbol(trade.coin) === normalizeSymbol(args.selectedCoin))
    .map(({ coin: _coin, ...trade }) => trade);

  if (trades.length === 0) {
    return [];
  }
  return [{
    type: "trades",
    coin: args.selectedCoin,
    receivedAt: args.receivedAt,
    trades,
  }];
}

function normalizeCandles(args: {
  data: unknown;
  selectedCoin: string;
  interval: TerminalChartInterval;
  receivedAt: number;
}): TerminalStreamEvent[] {
  const rawCandles = Array.isArray(args.data) ? args.data : [args.data];
  const candles = rawCandles
    .map((raw) => parseCandle(raw))
    .filter((candle): candle is TerminalCandle & { coin: string; interval: string } => candle !== undefined)
    .filter((candle) =>
      normalizeSymbol(candle.coin) === normalizeSymbol(args.selectedCoin) &&
      candle.interval === args.interval,
    )
    .map(({ coin: _coin, interval: _interval, ...candle }) => candle);

  if (candles.length === 0) {
    return [];
  }
  return [{
    type: "candle",
    coin: args.selectedCoin,
    receivedAt: args.receivedAt,
    interval: args.interval,
    candles,
  }];
}

function applyAssetContext(
  snapshot: SharedTradingSnapshot,
  event: Extract<TerminalStreamEvent, { type: "activeAssetCtx" }>,
): SharedTradingSnapshot {
  const markPrice = event.ctx.markPx ?? snapshot.market.markPrice;
  const prevDayPrice = event.ctx.prevDayPx ?? (snapshot.market.markPrice - snapshot.market.change24hAbs);
  const change24hAbs = markPrice - prevDayPrice;
  const change24hPct = prevDayPrice > 0 ? (change24hAbs / prevDayPrice) * 100 : snapshot.market.change24hPct;
  const openInterestUsd = event.ctx.openInterest == null
    ? snapshot.market.openInterestUsd
    : event.ctx.openInterest * markPrice;

  return {
    ...snapshot,
    asOf: event.receivedAt,
    market: {
      ...snapshot.market,
      markPrice,
      oraclePrice: event.ctx.oraclePx ?? event.ctx.midPx ?? snapshot.market.oraclePrice,
      change24hPct,
      change24hAbs,
      fundingRatePct: event.ctx.funding == null ? snapshot.market.fundingRatePct : event.ctx.funding * 100,
      openInterestUsd,
      volume24hUsd: event.ctx.dayNtlVlm ?? snapshot.market.volume24hUsd,
      dataAgeSeconds: 0,
      source: "live-mainnet",
    },
  };
}

function parseRawLevels(input: unknown): { px: string; sz: string }[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.flatMap((raw) => {
    const record = objectRecord(raw);
    const px = stringOrNumberValue(record?.px);
    const sz = stringOrNumberValue(record?.sz);
    return px && sz ? [{ px, sz }] : [];
  });
}

function parseTrade(raw: unknown): (RecentTrade & { coin: string }) | undefined {
  const record = objectRecord(raw);
  const coin = stringValue(record?.coin);
  const price = finiteNumber(record?.px);
  const size = finiteNumber(record?.sz);
  const timestamp = finiteNumber(record?.time);
  const side = parseSide(record?.side);
  const hash = stringValue(record?.hash);
  const tid = finiteNumber(record?.tid);
  if (!coin || price == null || size == null || timestamp == null || !side) {
    return undefined;
  }
  return {
    id: tradeStableId({ coin, hash, tid, timestamp, side, price, size }),
    coin,
    side,
    price,
    size,
    timestamp,
  };
}

function parseCandle(raw: unknown): (TerminalCandle & { coin: string; interval: string }) | undefined {
  const record = objectRecord(raw);
  const coin = stringValue(record?.s);
  const interval = stringValue(record?.i);
  const timeMs = finiteNumber(record?.t);
  const open = finiteNumber(record?.o);
  const high = finiteNumber(record?.h);
  const low = finiteNumber(record?.l);
  const close = finiteNumber(record?.c);
  const volume = finiteNumber(record?.v);
  if (
    !coin ||
    !interval ||
    timeMs == null ||
    open == null ||
    high == null ||
    low == null ||
    close == null ||
    volume == null
  ) {
    return undefined;
  }
  return {
    coin,
    interval,
    time: Math.floor(timeMs / 1000),
    open,
    high,
    low,
    close,
    volume,
  };
}

function parseSide(input: unknown): RecentTrade["side"] | undefined {
  const side = stringValue(input)?.toLowerCase();
  if (side === "b" || side === "buy") {
    return "buy";
  }
  if (side === "a" || side === "sell") {
    return "sell";
  }
  return undefined;
}

function isValidTrade(trade: RecentTrade): boolean {
  return (
    Number.isFinite(trade.price) &&
    Number.isFinite(trade.size) &&
    Number.isFinite(trade.timestamp) &&
    trade.size > 0
  );
}

function isValidStreamCandle(candle: TerminalCandle): boolean {
  return (
    Number.isFinite(candle.time) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    Number.isFinite(candle.volume) &&
    candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= Math.min(candle.open, candle.close)
  );
}

function tradeKey(trade: RecentTrade): string {
  if (trade.id) {
    return trade.id;
  }
  return [trade.side, trade.timestamp, trade.price, trade.size].join(":");
}

function tradeStableId(args: {
  coin: string;
  hash?: string;
  tid?: number;
  timestamp: number;
  side: RecentTrade["side"];
  price: number;
  size: number;
}): string {
  if (args.tid != null) {
    return [normalizeSymbol(args.coin), args.timestamp, args.tid].join(":");
  }
  if (args.hash) {
    return [normalizeSymbol(args.coin), args.hash, args.timestamp].join(":");
  }
  return [normalizeSymbol(args.coin), args.side, args.timestamp, args.price, args.size].join(":");
}

function objectRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null ? input as Record<string, unknown> : undefined;
}

function stringValue(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}

function stringOrNumberValue(input: unknown): string | undefined {
  if (typeof input === "string" && input.length > 0) {
    return input;
  }
  if (typeof input === "number" && Number.isFinite(input)) {
    return String(input);
  }
  return undefined;
}

function finiteNumber(input: unknown): number | undefined {
  const parsed = typeof input === "number" ? input : typeof input === "string" ? Number(input) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function assertNeverStatus(status: never): never {
  throw new Error(`Unexpected terminal stream status: ${String(status)}`);
}

function assertNeverEvent(event: never): never {
  throw new Error(`Unexpected terminal stream event: ${String(event)}`);
}
