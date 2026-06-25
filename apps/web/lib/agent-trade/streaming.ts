import { estimateTopBookLiquidityUsd, normalizeSymbol, parseBookLevels } from "./markets";
import { terminalIntervalSeconds, type TerminalCandle, type TerminalChartData, type TerminalChartInterval } from "./terminal";
import type { AccountSnapshot, Fill, OpenOrder, Position, RecentTrade, SharedTradingSnapshot } from "./types";

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
    }
  | {
      type: "clearinghouseState";
      user: `0x${string}`;
      receivedAt: number;
      account: Pick<AccountSnapshot, "equityUsd" | "availableUsd" | "marginUsedUsd" | "unrealizedPnlUsd" | "positions">;
    }
  | {
      type: "openOrders";
      user: `0x${string}`;
      receivedAt: number;
      openOrders: OpenOrder[];
    }
  | {
      type: "userFills";
      user: `0x${string}`;
      receivedAt: number;
      fills: Fill[];
      isSnapshot: boolean;
    }
  | {
      type: "userEvents";
      user: `0x${string}`;
      receivedAt: number;
      fills: Fill[];
      cancelledOids: number[];
    }
  | {
      type: "orderUpdates";
      user: `0x${string}`;
      receivedAt: number;
      orders: TerminalOrderUpdate[];
    };

export interface TerminalMarketStreamSubscription {
  type: "activeAssetCtx" | "l2Book" | "trades" | "candle";
  coin: string;
  interval?: TerminalChartInterval;
  nSigFigs?: number;
  fast?: boolean;
}

export interface TerminalAccountStreamSubscription {
  type: "clearinghouseState" | "openOrders" | "userFills" | "userEvents" | "orderUpdates";
  user: `0x${string}`;
  aggregateByTime?: boolean;
}

export type TerminalStreamSubscription = TerminalMarketStreamSubscription | TerminalAccountStreamSubscription;

export interface TerminalLivePriceUpdate {
  price: number;
  timestamp: number;
  receivedAt: number;
}

export interface TerminalOrderUpdate {
  status: string;
  statusTimestamp: number;
  order: OpenOrder;
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
}): TerminalMarketStreamSubscription[] {
  return [
    { type: "activeAssetCtx", coin: args.coin },
    { type: "l2Book", coin: args.coin, nSigFigs: 5, fast: true },
    { type: "trades", coin: args.coin },
    { type: "candle", coin: args.coin, interval: args.interval },
  ];
}

export function terminalAccountSubscriptions(args: {
  user: `0x${string}`;
}): TerminalAccountStreamSubscription[] {
  return [
    { type: "clearinghouseState", user: args.user },
    { type: "openOrders", user: args.user },
    { type: "userFills", user: args.user },
    { type: "userEvents", user: args.user },
    { type: "orderUpdates", user: args.user },
  ];
}

export function subscriptionMessage(subscription: TerminalStreamSubscription) {
  const payload: Record<string, unknown> = {
    type: subscription.type,
  };

  if ("coin" in subscription) {
    payload.coin = subscription.coin;
  }
  if ("user" in subscription) {
    payload.user = subscription.user;
  }
  if (subscription.type === "candle" && "interval" in subscription) {
    payload.interval = subscription.interval;
  }
  if (subscription.type === "l2Book" && "nSigFigs" in subscription) {
    payload.nSigFigs = subscription.nSigFigs;
    payload.fast = subscription.fast;
  }
  if (subscription.type === "userFills") {
    payload.aggregateByTime = subscription.aggregateByTime;
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
  accountAddress?: string;
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
    case "clearinghouseState":
      return normalizeClearinghouseState({ data, accountAddress: args.accountAddress, receivedAt });
    case "openOrders":
      return normalizeOpenOrders({ data, accountAddress: args.accountAddress, receivedAt });
    case "userFills":
      return normalizeUserFills({ data, accountAddress: args.accountAddress, receivedAt });
    case "userEvents":
      return normalizeUserEvents({ data, accountAddress: args.accountAddress, receivedAt });
    case "orderUpdates":
      return normalizeOrderUpdates({ data, accountAddress: args.accountAddress, receivedAt });
    default:
      return [];
  }
}

export function applyTerminalStreamEvent(
  snapshot: SharedTradingSnapshot,
  event: TerminalStreamEvent,
): SharedTradingSnapshot {
  switch (event.type) {
    case "activeAssetCtx":
      if (normalizeSymbol(event.coin) !== normalizeSymbol(snapshot.market.base)) {
        return snapshot;
      }
      return applyAssetContext(snapshot, event);
    case "l2Book": {
      if (normalizeSymbol(event.coin) !== normalizeSymbol(snapshot.market.base)) {
        return snapshot;
      }
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
      if (normalizeSymbol(event.coin) !== normalizeSymbol(snapshot.market.base)) {
        return snapshot;
      }
      return {
        ...snapshot,
        asOf: event.receivedAt,
        recentTrades: mergeRecentTrades(snapshot.recentTrades, event.trades),
      };
    case "candle":
      return snapshot;
    case "clearinghouseState":
      return applyClearinghouseState(snapshot, event);
    case "openOrders":
      return applyOpenOrders(snapshot, event);
    case "userFills":
      return applyFills(snapshot, event.fills, event.receivedAt);
    case "userEvents":
      return applyUserEvents(snapshot, event);
    case "orderUpdates":
      return applyOrderUpdates(snapshot, event);
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

function normalizeClearinghouseState(args: {
  data: unknown;
  accountAddress?: string;
  receivedAt: number;
}): TerminalStreamEvent[] {
  const user = normalizedAccountAddress(args.accountAddress);
  if (!user) {
    return [];
  }

  const record = objectRecord(args.data);
  if (!record || !isAccountMessageForUser(record, user)) {
    return [];
  }

  const state = objectRecord(record.clearinghouseState) ?? record;
  const marginSummary = objectRecord(state.marginSummary);
  const withdrawable = finiteNumber(state.withdrawable);
  const rawPositions = Array.isArray(state.assetPositions) ? state.assetPositions : [];
  const positions = rawPositions.flatMap((raw) => {
    const position = parseClearinghousePosition(raw);
    return position ? [position] : [];
  });
  const unrealizedPnlUsd = positions.reduce((sum, position) => sum + position.pnlUsd, 0);
  const equityUsd = finiteNumber(marginSummary?.accountValue);
  const marginUsedUsd = finiteNumber(marginSummary?.totalMarginUsed);

  if (equityUsd == null || withdrawable == null || marginUsedUsd == null) {
    return [];
  }

  return [{
    type: "clearinghouseState",
    user,
    receivedAt: args.receivedAt,
    account: {
      equityUsd,
      availableUsd: withdrawable,
      marginUsedUsd,
      unrealizedPnlUsd,
      positions,
    },
  }];
}

function normalizeOpenOrders(args: {
  data: unknown;
  accountAddress?: string;
  receivedAt: number;
}): TerminalStreamEvent[] {
  const user = normalizedAccountAddress(args.accountAddress);
  if (!user) {
    return [];
  }

  const record = objectRecord(args.data);
  if (record && !isAccountMessageForUser(record, user)) {
    return [];
  }
  const rawOrders = record && Array.isArray(record.orders)
    ? record.orders
    : Array.isArray(args.data)
      ? args.data
      : [];
  const openOrders = rawOrders.flatMap((raw) => {
    const order = parseOpenOrder(raw);
    return order ? [order] : [];
  });

  return [{
    type: "openOrders",
    user,
    receivedAt: args.receivedAt,
    openOrders,
  }];
}

function normalizeUserFills(args: {
  data: unknown;
  accountAddress?: string;
  receivedAt: number;
}): TerminalStreamEvent[] {
  const user = normalizedAccountAddress(args.accountAddress);
  if (!user) {
    return [];
  }

  const record = objectRecord(args.data);
  if (!record || !isAccountMessageForUser(record, user)) {
    return [];
  }
  const rawFills = Array.isArray(record.fills) ? record.fills : [];
  const fills = rawFills.flatMap((raw) => {
    const fill = parseFill(raw);
    return fill ? [fill] : [];
  });

  if (fills.length === 0 && booleanValue(record.isSnapshot) !== true) {
    return [];
  }

  return [{
    type: "userFills",
    user,
    receivedAt: args.receivedAt,
    fills,
    isSnapshot: booleanValue(record.isSnapshot) === true,
  }];
}

function normalizeUserEvents(args: {
  data: unknown;
  accountAddress?: string;
  receivedAt: number;
}): TerminalStreamEvent[] {
  const user = normalizedAccountAddress(args.accountAddress);
  if (!user) {
    return [];
  }

  const record = objectRecord(args.data);
  if (!record || !isAccountMessageForUser(record, user)) {
    return [];
  }
  const rawFills = Array.isArray(record.fills) ? record.fills : [];
  const rawCancels = Array.isArray(record.nonUserCancel) ? record.nonUserCancel : [];
  const fills = rawFills.flatMap((raw) => {
    const fill = parseFill(raw);
    return fill ? [fill] : [];
  });
  const cancelledOids = rawCancels.flatMap((raw) => {
    const oid = finiteNumber(objectRecord(raw)?.oid);
    return oid == null ? [] : [oid];
  });

  if (fills.length === 0 && cancelledOids.length === 0) {
    return [];
  }

  return [{
    type: "userEvents",
    user,
    receivedAt: args.receivedAt,
    fills,
    cancelledOids,
  }];
}

function normalizeOrderUpdates(args: {
  data: unknown;
  accountAddress?: string;
  receivedAt: number;
}): TerminalStreamEvent[] {
  const user = normalizedAccountAddress(args.accountAddress);
  if (!user) {
    return [];
  }

  const rawUpdates = Array.isArray(args.data) ? args.data : [args.data];
  const orders = rawUpdates.flatMap((raw) => {
    const update = parseOrderUpdate(raw);
    return update ? [update] : [];
  });
  if (orders.length === 0) {
    return [];
  }

  return [{
    type: "orderUpdates",
    user,
    receivedAt: args.receivedAt,
    orders,
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

function applyClearinghouseState(
  snapshot: SharedTradingSnapshot,
  event: Extract<TerminalStreamEvent, { type: "clearinghouseState" }>,
): SharedTradingSnapshot {
  return {
    ...snapshot,
    account: mergeLiveAccountFields({
      account: snapshot.account,
      user: event.user,
      updatedAt: event.receivedAt,
      live: {
        equityUsd: event.account.equityUsd,
        availableUsd: event.account.availableUsd,
        marginUsedUsd: event.account.marginUsedUsd,
        unrealizedPnlUsd: event.account.unrealizedPnlUsd,
        positions: event.account.positions,
      },
    }),
  };
}

function applyOpenOrders(
  snapshot: SharedTradingSnapshot,
  event: Extract<TerminalStreamEvent, { type: "openOrders" }>,
): SharedTradingSnapshot {
  return {
    ...snapshot,
    account: mergeLiveAccountFields({
      account: snapshot.account,
      user: event.user,
      updatedAt: event.receivedAt,
      live: {
        openOrders: event.openOrders.map((order) => enrichOpenOrder({ order, snapshot })),
      },
    }),
  };
}

function applyFills(
  snapshot: SharedTradingSnapshot,
  fills: Fill[],
  receivedAt: number,
): SharedTradingSnapshot {
  const user = normalizedAccountAddress(snapshot.account.address);
  if (!user || fills.length === 0) {
    return snapshot;
  }

  const existingLiveFills = snapshot.account.fills.filter((fill) => fill.mode !== "paper");
  return {
    ...snapshot,
    account: mergeLiveAccountFields({
      account: snapshot.account,
      user,
      updatedAt: receivedAt,
      live: {
        fills: mergeLiveFills(existingLiveFills, fills),
      },
    }),
  };
}

function applyUserEvents(
  snapshot: SharedTradingSnapshot,
  event: Extract<TerminalStreamEvent, { type: "userEvents" }>,
): SharedTradingSnapshot {
  const liveOpenOrders = snapshot.account.openOrders
    .filter((order) => order.mode !== "paper")
    .filter((order) => order.oid == null || !event.cancelledOids.includes(order.oid));
  const withCancels = {
    ...snapshot,
    account: mergeLiveAccountFields({
      account: snapshot.account,
      user: event.user,
      updatedAt: event.receivedAt,
      live: {
        openOrders: liveOpenOrders,
      },
    }),
  };
  return applyFills(withCancels, event.fills, event.receivedAt);
}

function applyOrderUpdates(
  snapshot: SharedTradingSnapshot,
  event: Extract<TerminalStreamEvent, { type: "orderUpdates" }>,
): SharedTradingSnapshot {
  const liveOrders = new Map<string, OpenOrder>();
  for (const order of snapshot.account.openOrders.filter((item) => item.mode !== "paper")) {
    liveOrders.set(orderKey(order), order);
  }

  for (const update of event.orders) {
    const key = orderKey(update.order);
    if (isClosedOrderStatus(update.status)) {
      liveOrders.delete(key);
    } else {
      liveOrders.set(key, {
        ...enrichOpenOrder({ order: update.order, snapshot }),
        status: update.status,
        statusTimestamp: update.statusTimestamp,
      });
    }
  }

  return {
    ...snapshot,
    account: mergeLiveAccountFields({
      account: snapshot.account,
      user: event.user,
      updatedAt: event.receivedAt,
      live: {
        openOrders: [...liveOrders.values()].sort((a, b) => b.timestamp - a.timestamp),
      },
    }),
  };
}

function mergeLiveAccountFields(args: {
  account: AccountSnapshot;
  user: `0x${string}`;
  updatedAt: number;
  live: Partial<Pick<AccountSnapshot,
    "equityUsd" |
    "availableUsd" |
    "marginUsedUsd" |
    "unrealizedPnlUsd" |
    "positions" |
    "openOrders" |
    "fills"
  >>;
}): AccountSnapshot {
  const paperPositions = args.account.positions.filter((position) => position.mode === "paper");
  const paperOpenOrders = args.account.openOrders.filter((order) => order.mode === "paper");
  const paperFills = args.account.fills.filter((fill) => fill.mode === "paper");
  const livePositions = args.live.positions ?? args.account.positions.filter((position) => position.mode !== "paper");
  const liveOpenOrders = args.live.openOrders ?? args.account.openOrders.filter((order) => order.mode !== "paper");
  const liveFills = args.live.fills ?? args.account.fills.filter((fill) => fill.mode !== "paper");
  const paperMarginUsd = paperPositions.reduce((sum, position) => sum + position.marginUsd, 0);
  const paperUnrealizedPnlUsd = paperPositions.reduce((sum, position) => sum + position.pnlUsd, 0);
  const liveEquityUsd = args.live.equityUsd ?? liveAccountMetric(args.account, "equityUsd", paperUnrealizedPnlUsd);
  const liveAvailableUsd = args.live.availableUsd ?? liveAccountMetric(args.account, "availableUsd", paperMarginUsd);
  const liveMarginUsedUsd = args.live.marginUsedUsd ?? liveAccountMetric(args.account, "marginUsedUsd", paperMarginUsd);
  const liveUnrealizedPnlUsd = args.live.unrealizedPnlUsd ?? liveAccountMetric(args.account, "unrealizedPnlUsd", paperUnrealizedPnlUsd);
  const hasPaperLedger = paperPositions.length > 0 || paperOpenOrders.length > 0 || paperFills.length > 0;

  return {
    ...args.account,
    address: args.user,
    valueKind: hasPaperLedger ? "hybrid" : "real",
    sourceLabel: hasPaperLedger ? "Read-only account plus paper ledger" : "Read-only Hyperliquid account",
    liveAccountDataLoaded: true,
    liveAccountDataUnavailable: false,
    updatedAt: args.updatedAt,
    equityUsd: liveEquityUsd + paperUnrealizedPnlUsd,
    availableUsd: Math.max(0, liveAvailableUsd - paperMarginUsd),
    marginUsedUsd: liveMarginUsedUsd + paperMarginUsd,
    unrealizedPnlUsd: liveUnrealizedPnlUsd + paperUnrealizedPnlUsd,
    positions: [...paperPositions, ...livePositions],
    openOrders: [...paperOpenOrders, ...liveOpenOrders],
    fills: [...paperFills, ...liveFills],
  };
}

function liveAccountMetric(
  account: AccountSnapshot,
  key: "equityUsd" | "availableUsd" | "marginUsedUsd" | "unrealizedPnlUsd",
  paperValue: number,
): number {
  if (account.valueKind === "hybrid") {
    return key === "availableUsd" ? account[key] + paperValue : account[key] - paperValue;
  }
  return account[key];
}

function mergeLiveFills(existing: Fill[], incoming: Fill[], maxFills = 50): Fill[] {
  const byKey = new Map<string, Fill>();
  for (const fill of [...incoming, ...existing]) {
    byKey.set(fillKey(fill), { ...fill, mode: "live" });
  }
  return [...byKey.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, maxFills);
}

function enrichOpenOrder(args: {
  order: OpenOrder;
  snapshot: SharedTradingSnapshot;
}): OpenOrder {
  const selectedAssetIndex = normalizeSymbol(args.order.symbol) === normalizeSymbol(args.snapshot.market.symbol) ||
    normalizeSymbol(args.order.symbol) === normalizeSymbol(args.snapshot.market.base)
    ? args.snapshot.market.assetIndex
    : undefined;
  const assetIndex = args.order.assetIndex ?? selectedAssetIndex;
  const cancelAction = args.order.cancelAction ?? (
    assetIndex != null && args.order.oid != null
      ? { type: "cancel" as const, cancels: [{ a: assetIndex, o: args.order.oid }] }
      : undefined
  );
  return {
    ...args.order,
    assetIndex,
    cancelAction,
  };
}

function parseClearinghousePosition(raw: unknown): Position | undefined {
  const record = objectRecord(raw);
  const position = objectRecord(record?.position) ?? record;
  const coin = stringValue(position?.coin);
  const signedSize = finiteNumber(position?.szi);
  const entryPrice = finiteNumber(position?.entryPx);
  if (!coin || signedSize == null || signedSize === 0 || entryPrice == null) {
    return undefined;
  }

  const size = Math.abs(signedSize);
  const positionValue = finiteNumber(position?.positionValue);
  const markPrice = positionValue != null && size > 0 ? positionValue / size : entryPrice;
  const leverageRecord = objectRecord(position?.leverage);
  const leverage = finiteNumber(leverageRecord?.value) ?? finiteNumber(position?.leverage) ?? 1;
  const leverageType = stringValue(leverageRecord?.type)?.toLowerCase();
  const marginMode = leverageType?.includes("isolated") ? "isolated" : "cross";
  const liquidationPrice = finiteNumber(position?.liquidationPx) ?? 0;
  const pnlUsd = finiteNumber(position?.unrealizedPnl) ?? 0;
  const returnOnEquity = finiteNumber(position?.returnOnEquity) ?? 0;
  const marginUsd = finiteNumber(position?.marginUsed) ?? (leverage > 0 ? Math.abs(positionValue ?? 0) / leverage : 0);
  const cumFunding = objectRecord(position?.cumFunding);

  return {
    symbol: `${coin}-USD`,
    base: coin,
    mode: "live",
    side: signedSize >= 0 ? "long" : "short",
    size,
    leverage,
    marginMode,
    entryPrice,
    markPrice,
    liquidationPrice,
    pnlUsd,
    pnlPct: returnOnEquity * 100,
    marginUsd,
    fundingUsd: finiteNumber(cumFunding?.sinceOpen) ?? 0,
  };
}

function parseOpenOrder(raw: unknown): OpenOrder | undefined {
  const record = objectRecord(raw);
  const order = objectRecord(record?.order) ?? record;
  const coin = stringValue(order?.coin);
  const assetIndex = finiteNumber(order?.assetIndex) ?? finiteNumber(order?.a);
  const oid = finiteNumber(order?.oid) ?? finiteNumber(order?.o);
  const side = parseSide(order?.side ?? order?.b);
  const price = finiteNumber(order?.limitPx) ?? finiteNumber(order?.px) ?? finiteNumber(order?.p);
  const size = finiteNumber(order?.sz) ?? finiteNumber(order?.s);
  const timestamp = finiteNumber(order?.timestamp) ?? finiteNumber(order?.time) ?? Date.now();
  if (!side || price == null || size == null || oid == null) {
    return undefined;
  }

  const symbol = coin ? `${coin}-USD` : assetIndex == null ? "Unknown" : `#${assetIndex}`;
  return {
    oid,
    assetIndex,
    symbol,
    mode: "live",
    side,
    type: "limit",
    price,
    size,
    reduceOnly: booleanValue(order?.reduceOnly) === true,
    timestamp,
    cancelAction: assetIndex == null ? undefined : { type: "cancel", cancels: [{ a: assetIndex, o: oid }] },
  };
}

function parseOrderUpdate(raw: unknown): TerminalOrderUpdate | undefined {
  const record = objectRecord(raw);
  const status = stringValue(record?.status);
  const statusTimestamp = finiteNumber(record?.statusTimestamp) ?? Date.now();
  const order = parseOpenOrder(record?.order);
  if (!status || !order) {
    return undefined;
  }

  return {
    status,
    statusTimestamp,
    order,
  };
}

function parseFill(raw: unknown): Fill | undefined {
  const record = objectRecord(raw);
  const coin = stringValue(record?.coin);
  const side = parseSide(record?.side);
  const price = finiteNumber(record?.px);
  const size = finiteNumber(record?.sz);
  const timestamp = finiteNumber(record?.time);
  if (!coin || !side || price == null || size == null || timestamp == null) {
    return undefined;
  }

  const fee = Math.abs(finiteNumber(record?.fee) ?? 0);
  const builderFee = Math.abs(finiteNumber(record?.builderFee) ?? 0);
  const oid = finiteNumber(record?.oid);
  const tid = finiteNumber(record?.tid);
  const hash = stringValue(record?.hash);
  return {
    symbol: `${coin}-USD`,
    mode: "live",
    side,
    orderId: fillStableId({ coin, oid, tid, hash, timestamp, price, size, side }),
    price,
    size,
    feeUsd: fee + builderFee,
    timestamp,
  };
}

function isClosedOrderStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    normalized.includes("filled") ||
    normalized.includes("canceled") ||
    normalized.includes("cancelled") ||
    normalized.includes("rejected") ||
    normalized.includes("liquidated") ||
    normalized.includes("delisted")
  );
}

function orderKey(order: OpenOrder): string {
  if (order.oid != null) {
    return String(order.oid);
  }
  return [order.symbol, order.side, order.price, order.size, order.timestamp].join(":");
}

function fillKey(fill: Fill): string {
  if (fill.orderId) {
    return fill.orderId;
  }
  return [fill.symbol, fill.side, fill.timestamp, fill.price, fill.size].join(":");
}

function fillStableId(args: {
  coin: string;
  oid?: number;
  tid?: number;
  hash?: string;
  timestamp: number;
  price: number;
  size: number;
  side: Fill["side"];
}): string {
  if (args.hash && args.tid != null) {
    return [normalizeSymbol(args.coin), args.hash, args.tid].join(":");
  }
  if (args.oid != null && args.tid != null) {
    return [normalizeSymbol(args.coin), args.oid, args.tid].join(":");
  }
  return [normalizeSymbol(args.coin), args.side, args.timestamp, args.price, args.size].join(":");
}

function normalizedAccountAddress(input: string | undefined): `0x${string}` | undefined {
  if (typeof input !== "string" || !/^0x[a-fA-F0-9]{40}$/u.test(input)) {
    return undefined;
  }
  return input.toLowerCase() as `0x${string}`;
}

function isAccountMessageForUser(record: Record<string, unknown>, user: `0x${string}`): boolean {
  const messageUser = normalizedAccountAddress(stringValue(record.user));
  return !messageUser || messageUser === user;
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
  if (typeof input === "boolean") {
    return input ? "buy" : "sell";
  }
  const side = stringValue(input)?.toLowerCase();
  if (side === "b" || side === "buy") {
    return "buy";
  }
  if (side === "a" || side === "ask" || side === "sell") {
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

function booleanValue(input: unknown): boolean | undefined {
  if (typeof input === "boolean") {
    return input;
  }
  if (typeof input === "string") {
    if (input.toLowerCase() === "true") {
      return true;
    }
    if (input.toLowerCase() === "false") {
      return false;
    }
  }
  return undefined;
}

function assertNeverStatus(status: never): never {
  throw new Error(`Unexpected terminal stream status: ${String(status)}`);
}

function assertNeverEvent(event: never): never {
  throw new Error(`Unexpected terminal stream event: ${String(event)}`);
}
