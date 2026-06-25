"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import type { Time } from "lightweight-charts";

import { API_BASE_URL } from "@/lib/api";
import {
  getAccountReadinessDisplay,
  getLiveTradingReadiness,
  type AccountReadinessDisplay,
  type LiveTradingReadiness,
  type WalletReadinessSummary,
} from "@/lib/agent-trade/account-readiness";
import { createAgentService, type AgentScenario } from "@/lib/agent-trade/agent-service";
import {
  fmtAdaptiveUsd,
  fmtAgo,
  fmtCompactUsd,
  fmtMarketNumber,
  fmtMarketUsd,
  fmtNumber,
  fmtPct,
  fmtUsd,
  marketPriceChartFormat,
  type HyperliquidPricePrecision,
} from "@/lib/agent-trade/format";
import { buildSwitchingMarketSnapshot, loadTerminalCandles, loadTradingSnapshot } from "@/lib/agent-trade/data";
import { DEFAULT_ELIGIBILITY_RESPONSE, normalizeEligibilityResponse } from "@/lib/agent-trade/eligibility";
import { hypurrscanAddressUrl } from "@/lib/agent-trade/hypurrscan";
import { MOCK_TRADING_SNAPSHOT } from "@/lib/agent-trade/mock-data";
import {
  filterMarketsForSelector,
  loadMarketDiscoverySnapshot,
  normalizeSymbol,
  sortMarketsForSelector,
  type JoinedMarket,
} from "@/lib/agent-trade/markets";
import { buildHlOrderAction } from "@/lib/agent-trade/orders";
import { paperSessionHeaders } from "@/lib/agent-trade/paper";
import {
  calculateDraftImpact,
  calculatePortfolioExposure,
  classifyPortfolioRisk,
  estimateDraftLiquidation,
  type DraftImpact,
} from "@/lib/agent-trade/portfolio";
import {
  AGENT_PANEL_HEADING,
  applyManualDraftPatch,
  annotationPriceLineTitle,
  buildFallbackTerminalChartData,
  closePositionDraft,
  closePositionSubmitState,
  getConfirmationAckCopy,
  getTerminalFreshness,
  getTerminalEligibilityStatus,
  getTicketSource,
  liveOrderErrorMessage,
  liveOrderSubmitState,
  normalizeHexSignature,
  paperOrderSubmitState,
  paperOrderEndpoint,
  paperOrderFailureMessage,
  resolveTypedPromptMarket,
  terminalChartLabel,
  withExplicitEip712Domain,
  TERMINAL_CHART_INTERVAL_GROUPS,
  TERMINAL_QUICK_CHART_INTERVALS,
  type TerminalChartData,
  type TerminalFreshness,
  type TerminalChartInterval,
  type HyperliquidTypedData,
  type SubmitState,
} from "@/lib/agent-trade/terminal";
import {
  applyTerminalCandleEvent,
  applyTerminalPriceToChart,
  applyTerminalStreamEvent,
  hyperliquidWsUrlForVenue,
  isTerminalStreamWarning,
  normalizeTerminalWsMessage,
  subscriptionMessage,
  terminalAccountSubscriptions,
  terminalMarketSubscriptions,
  terminalStreamStatusDetail,
  terminalStreamStatusLabel,
  unsubscribeMessage,
  type TerminalStreamStatus,
} from "@/lib/agent-trade/streaming";
import type {
  AgentResponse,
  ChartAnnotation,
  EligibilityResponse,
  EligibilityMode,
  MarginMode,
  OrderDraft,
  OrderType,
  Position,
  SharedTradingSnapshot,
} from "@/lib/agent-trade/types";

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

interface TerminalWalletReadiness extends WalletReadinessSummary {
  getEthereumProvider?: () => Promise<Eip1193Provider>;
}

interface TerminalStreamDebug {
  selectedMarket: string;
  subscribedCoin: string;
  lastTradeCoin?: string;
  lastCandleUpdateTime?: number;
  lastAccountEvent?: string;
  subscribedAccount?: string;
  streamStatus: TerminalStreamStatus;
}

interface ClosePositionIntent {
  position: Position;
  draft: OrderDraft;
  market: HyperliquidPricePrecision & {
    symbol: string;
    base: string;
    assetIndex: number;
    markPrice: number;
    szDecimals: number;
    isSpot?: boolean;
  };
  entryPrice: number;
}

const agentService = createAgentService();
const HAS_PRIVY = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
const LOCAL_DEV_WALLET: TerminalWalletReadiness = { status: "local-dev", authStatus: "not-configured" };

function buildDefaultDraft(snapshot: SharedTradingSnapshot): OrderDraft {
  const size = Number(
    Math.max(1 / 10 ** snapshot.market.szDecimals, Math.min(0.01, 1000 / snapshot.market.markPrice))
      .toFixed(snapshot.market.szDecimals),
  );
  return {
    symbol: snapshot.market.symbol,
    side: "long",
    orderType: "market",
    sizeBtc: size,
    leverage: 2,
    marginMode: "isolated",
    reduceOnly: false,
    fromAgent: false,
  };
}

function buildLoadingTerminalChartData(
  market: SharedTradingSnapshot["market"],
  interval: TerminalChartInterval,
): TerminalChartData {
  return {
    interval,
    candles: [],
    source: "hyperliquid",
    fetchedAt: Date.now(),
    isFallback: false,
    error: `Loading ${market.base} candles from Hyperliquid.`,
  };
}

function mergeLoadedSnapshot(args: {
  current: SharedTradingSnapshot;
  next: SharedTradingSnapshot;
}): SharedTradingSnapshot {
  if (
    normalizeSymbol(args.current.market.base) === normalizeSymbol(args.next.market.base) &&
    args.current.recentTrades.some((trade) => trade.id)
  ) {
    return {
      ...args.next,
      recentTrades: args.current.recentTrades,
    };
  }

  return args.next;
}

function updateTerminalStreamDebug(
  ref: MutableRefObject<TerminalStreamDebug>,
  patch: Partial<TerminalStreamDebug>,
) {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") {
    return;
  }

  ref.current = { ...ref.current, ...patch };
  (window as Window & { __agentTradeTerminalStream?: TerminalStreamDebug }).__agentTradeTerminalStream = ref.current;
}

function terminalAccountAddress(wallet: TerminalWalletReadiness): `0x${string}` | undefined {
  const address = wallet.status === "connected" ? wallet.address : undefined;
  if (!address || !/^0x[a-fA-F0-9]{40}$/u.test(address)) {
    return undefined;
  }
  return address.toLowerCase() as `0x${string}`;
}

export function TerminalClient() {
  if (HAS_PRIVY) {
    return <PrivyTerminalClient />;
  }
  return <TerminalExperience wallet={LOCAL_DEV_WALLET} />;
}

function PrivyTerminalClient() {
  const wallet = useTerminalWalletSummary();
  return <TerminalExperience wallet={wallet} />;
}

function useTerminalWalletSummary(): TerminalWalletReadiness {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const activeWallet = useMemo(() => {
    const embedded = wallets.find((wallet) => wallet.walletClientType === "privy");
    return embedded ?? wallets[0];
  }, [wallets]);

  if (!ready) {
    return { status: "loading", authStatus: "loading" };
  }
  if (authenticated && activeWallet) {
    return {
      status: "connected",
      authStatus: "authenticated",
      address: activeWallet.address,
      walletType: activeWallet.walletClientType,
      walletKind: walletKindForType(activeWallet.walletClientType),
      getEthereumProvider: () => activeWallet.getEthereumProvider(),
    };
  }
  if (authenticated) {
    return { status: "not-connected", authStatus: "authenticated" };
  }
  return { status: "not-connected", authStatus: "unauthenticated" };
}

function walletKindForType(walletType?: string): "embedded" | "external" | "unknown" {
  if (!walletType) {
    return "unknown";
  }
  return walletType === "privy" ? "embedded" : "external";
}

function buildUnsupportedPromptMarketResponse(
  prompt: string,
  mentionedSymbol: string,
  snapshot: SharedTradingSnapshot,
): AgentResponse {
  return {
    id: `unsupported-${mentionedSymbol.toLowerCase()}-typed-market`,
    state: "noTrade",
    question: prompt,
    thesis:
      `${mentionedSymbol} is not available in the supported Hyperliquid market list for this terminal session. ` +
      `I am staying on ${snapshot.market.symbol} and will not draft an order for an unsupported symbol.`,
    receipts: [
      { label: "Requested market", value: mentionedSymbol, timestamp: snapshot.asOf },
      { label: "Active market", value: snapshot.market.symbol, timestamp: snapshot.asOf },
    ],
    riskNote: "No ticket draft was created. Open Markets or ask about the currently selected market.",
    whyWrong: "Ticker symbols can be ambiguous; Agent.trade only drafts against markets resolved from the shared market metadata.",
    annotations: [],
    followUps: [`Should I long ${snapshot.market.base}?`, `Should I short ${snapshot.market.base}?`, "Open Markets"],
  };
}

function TerminalExperience({ wallet }: { wallet: TerminalWalletReadiness }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedSymbol = normalizeSymbol(searchParams.get("symbol"));
  const [snapshot, setSnapshot] = useState<SharedTradingSnapshot>(MOCK_TRADING_SNAPSHOT);
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [eligibility, setEligibility] = useState<EligibilityResponse>({
    ...DEFAULT_ELIGIBILITY_RESPONSE,
    state: "loading",
    executionVenue: "hyperliquid-testnet",
    orderNotionalCapUsd: 250,
    dailyNotionalCapUsd: 1000,
  });
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState<OrderDraft>(() => buildDefaultDraft(MOCK_TRADING_SNAPSHOT));
  const [agent, setAgent] = useState<AgentResponse | undefined>();
  const [agentQuestion, setAgentQuestion] = useState<string | undefined>();
  const [annotations, setAnnotations] = useState<ChartAnnotation[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [cancellingOrderKey, setCancellingOrderKey] = useState<string | undefined>();
  const [closeIntent, setCloseIntent] = useState<ClosePositionIntent | undefined>();
  const [isAcked, setIsAcked] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState | undefined>();
  const [modalError, setModalError] = useState<string | undefined>();
  const [apiStatus, setApiStatus] = useState<"checking" | "ok" | "unavailable">("checking");
  const [marketNotice, setMarketNotice] = useState<string | undefined>();
  const [marketOptions, setMarketOptions] = useState<JoinedMarket[]>([]);
  const [bottomTab, setBottomTab] = useState<"positions" | "orders" | "fills">("positions");
  const [chartInterval, setChartInterval] = useState<TerminalChartInterval>("15m");
  const [chartData, setChartData] = useState<TerminalChartData>(() =>
    buildFallbackTerminalChartData(MOCK_TRADING_SNAPSHOT.market, "15m", "Waiting for Hyperliquid candles."),
  );
  const [isLoadingCandles, setIsLoadingCandles] = useState(false);
  const [streamStatus, setStreamStatus] = useState<TerminalStreamStatus>("disconnected");
  const streamDebugRef = useRef<TerminalStreamDebug>({
    selectedMarket: MOCK_TRADING_SNAPSHOT.market.symbol,
    subscribedCoin: MOCK_TRADING_SNAPSHOT.market.base,
    streamStatus: "disconnected",
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoadingData(true);
      const result = await loadTradingSnapshot(requestedSymbol, {
        accountAddress: wallet.status === "connected" ? wallet.address : undefined,
      });
      if (!cancelled) {
        const next = result.snapshot;
        setSnapshot((current) => mergeLoadedSnapshot({ current, next }));
        setDraft((current) =>
          current.symbol === next.market.symbol
            ? { ...current, symbol: next.market.symbol }
            : buildDefaultDraft(next),
        );
        setMarketNotice(
          result.usedFallback && requestedSymbol !== "BTC"
            ? `${result.requestedSymbol.toUpperCase()} is not available from /markets yet. Showing BTC instead.`
            : undefined,
        );
        setIsLoadingData(false);
      }
    }

    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [requestedSymbol, wallet.address, wallet.status]);

  async function refreshTerminalSnapshot(options: { preserveDraft?: boolean } = {}) {
    setIsLoadingData(true);
    const result = await loadTradingSnapshot(requestedSymbol, {
      accountAddress: wallet.status === "connected" ? wallet.address : undefined,
    });
    const next = result.snapshot;
    setSnapshot((current) => mergeLoadedSnapshot({ current, next }));
    if (!options.preserveDraft) {
      setDraft((current) =>
        current.symbol === next.market.symbol
          ? { ...current, symbol: next.market.symbol }
          : buildDefaultDraft(next),
      );
    }
    setMarketNotice(
      result.usedFallback && requestedSymbol !== "BTC"
        ? `${result.requestedSymbol.toUpperCase()} is not available from /markets yet. Showing BTC instead.`
        : undefined,
    );
    setApiStatus("ok");
    setIsLoadingData(false);
    return result;
  }

  useEffect(() => {
    if (typeof WebSocket === "undefined" || eligibility.state === "loading") {
      setStreamStatus("disconnected");
      updateTerminalStreamDebug(streamDebugRef, {
        selectedMarket: snapshot.market.symbol,
        subscribedCoin: snapshot.market.base,
        streamStatus: "disconnected",
      });
      return;
    }

    const selectedCoin = snapshot.market.base;
    const accountAddress = terminalAccountAddress(wallet);
    const wsUrl = hyperliquidWsUrlForVenue(eligibility.executionVenue);
    const subscriptions = [
      ...terminalMarketSubscriptions({ coin: selectedCoin, interval: chartInterval }),
      ...(accountAddress ? terminalAccountSubscriptions({ user: accountAddress }) : []),
    ];
    let socket: WebSocket | undefined;
    let cancelled = false;
    let reconnectTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let reconnectAttempt = 0;

    function clearTimers() {
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      if (heartbeatTimer !== undefined) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    }

    function sendJson(payload: unknown) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    }

    function connect() {
      if (cancelled) {
        return;
      }

      const nextStatus = reconnectAttempt === 0 ? "connecting" : "reconnecting";
      setStreamStatus(nextStatus);
      updateTerminalStreamDebug(streamDebugRef, {
        selectedMarket: snapshot.market.symbol,
        subscribedCoin: selectedCoin,
        subscribedAccount: accountAddress,
        streamStatus: nextStatus,
      });
      try {
        socket = new WebSocket(wsUrl);
      } catch {
        setStreamStatus("rest_fallback");
        updateTerminalStreamDebug(streamDebugRef, { streamStatus: "rest_fallback" });
        scheduleReconnect();
        return;
      }

      socket.addEventListener("open", () => {
        if (cancelled) {
          return;
        }
        reconnectAttempt = 0;
        setStreamStatus("live");
        updateTerminalStreamDebug(streamDebugRef, {
          selectedMarket: snapshot.market.symbol,
          subscribedCoin: selectedCoin,
          subscribedAccount: accountAddress,
          streamStatus: "live",
        });
        subscriptions.forEach((subscription) => sendJson(subscriptionMessage(subscription)));
        heartbeatTimer = window.setInterval(() => sendJson({ method: "ping" }), 25_000);
        void refreshTerminalSnapshot({ preserveDraft: true }).catch(() => {
          setStreamStatus("rest_fallback");
          updateTerminalStreamDebug(streamDebugRef, { streamStatus: "rest_fallback" });
        });
      });

      socket.addEventListener("message", (event) => {
        if (cancelled) {
          return;
        }
        try {
          const parsed = JSON.parse(String(event.data)) as unknown;
          const events = normalizeTerminalWsMessage({
            message: parsed,
            selectedCoin,
            interval: chartInterval,
            accountAddress,
          });
          if (events.length > 0) {
            setStreamStatus("live");
            updateTerminalStreamDebug(streamDebugRef, { streamStatus: "live" });
          }
          for (const streamEvent of events) {
            if (streamEvent.type === "candle") {
              updateTerminalStreamDebug(streamDebugRef, {
                lastCandleUpdateTime: streamEvent.receivedAt,
              });
              setChartData((current) => applyTerminalCandleEvent(current, streamEvent, chartInterval));
            } else if (streamEvent.type === "activeAssetCtx") {
              setSnapshot((current) => applyTerminalStreamEvent(current, streamEvent));
              const price = streamEvent.ctx.markPx ?? streamEvent.ctx.midPx ?? streamEvent.ctx.oraclePx;
              if (price != null) {
                setChartData((current) => applyTerminalPriceToChart(current, {
                  price,
                  timestamp: streamEvent.receivedAt,
                  receivedAt: streamEvent.receivedAt,
                }, chartInterval));
              }
            } else if (streamEvent.type === "trades") {
              updateTerminalStreamDebug(streamDebugRef, {
                lastTradeCoin: streamEvent.coin,
              });
              setSnapshot((current) => applyTerminalStreamEvent(current, streamEvent));
              const latestTrade = [...streamEvent.trades].sort((a, b) => b.timestamp - a.timestamp)[0];
              if (latestTrade) {
                setChartData((current) => applyTerminalPriceToChart(current, {
                  price: latestTrade.price,
                  timestamp: latestTrade.timestamp,
                  receivedAt: streamEvent.receivedAt,
                }, chartInterval));
              }
            } else if (
              streamEvent.type === "clearinghouseState" ||
              streamEvent.type === "openOrders" ||
              streamEvent.type === "userFills" ||
              streamEvent.type === "userEvents" ||
              streamEvent.type === "orderUpdates"
            ) {
              updateTerminalStreamDebug(streamDebugRef, {
                lastAccountEvent: streamEvent.type,
              });
              setSnapshot((current) => applyTerminalStreamEvent(current, streamEvent));
            } else {
              setSnapshot((current) => applyTerminalStreamEvent(current, streamEvent));
            }
          }
        } catch {
          setStreamStatus("degraded");
          updateTerminalStreamDebug(streamDebugRef, { streamStatus: "degraded" });
        }
      });

      socket.addEventListener("error", () => {
        if (!cancelled) {
          setStreamStatus("degraded");
          updateTerminalStreamDebug(streamDebugRef, { streamStatus: "degraded" });
        }
      });

      socket.addEventListener("close", () => {
        clearTimers();
        if (cancelled) {
          setStreamStatus("disconnected");
          updateTerminalStreamDebug(streamDebugRef, { streamStatus: "disconnected" });
          return;
        }
        setStreamStatus("reconnecting");
        updateTerminalStreamDebug(streamDebugRef, { streamStatus: "reconnecting" });
        void refreshTerminalSnapshot({ preserveDraft: true }).catch(() => {
          setStreamStatus("rest_fallback");
          updateTerminalStreamDebug(streamDebugRef, { streamStatus: "rest_fallback" });
        });
        scheduleReconnect();
      });
    }

    function scheduleReconnect() {
      reconnectAttempt += 1;
      if (reconnectAttempt >= 4) {
        setStreamStatus("rest_fallback");
        updateTerminalStreamDebug(streamDebugRef, { streamStatus: "rest_fallback" });
      }
      const delay = Math.min(15_000, 500 * 2 ** Math.min(reconnectAttempt, 5));
      reconnectTimer = window.setTimeout(connect, delay + Math.floor(Math.random() * 250));
    }

    connect();

    return () => {
      cancelled = true;
      clearTimers();
      if (socket && socket.readyState === WebSocket.OPEN) {
        subscriptions.forEach((subscription) => sendJson(unsubscribeMessage(subscription)));
      }
      socket?.close();
    };
  }, [chartInterval, eligibility.executionVenue, eligibility.state, requestedSymbol, snapshot.market.base, wallet.address, wallet.status]);

  useEffect(() => {
    let cancelled = false;

    async function loadMarkets() {
      try {
        const discovery = await loadMarketDiscoverySnapshot();
        if (!cancelled) {
          setMarketOptions(sortMarketsForSelector(discovery.markets));
        }
      } catch {
        if (!cancelled) {
          setMarketOptions([]);
        }
      }
    }

    void loadMarkets();
    const timer = window.setInterval(loadMarkets, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadEligibility() {
      try {
        const res = await fetch(`${API_BASE_URL}/agent-trade/eligibility`, { cache: "no-store" });
        const next = await normalizeEligibilityResponse(res);
        if (!cancelled) {
          setEligibility(next);
          setApiStatus("ok");
        }
      } catch {
        if (!cancelled) {
          setEligibility((current) => ({ ...current, state: "unknown" }));
          setApiStatus("unavailable");
          setMode("paper");
        }
      }
    }

    void loadEligibility();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeDraft = closeIntent?.draft ?? draft;
  const activeMode = closeIntent?.position.mode === "live"
    ? "live"
    : closeIntent?.position.mode === "paper"
      ? "paper"
      : mode;
  const activeOrderMarket = closeIntent?.market ?? snapshot.market;
  const activeEntryPrice = closeIntent
    ? closeIntent.entryPrice
    : draft.orderType === "limit" && draft.limitPrice
      ? draft.limitPrice
      : snapshot.market.markPrice;
  const activeNotional = activeDraft.sizeBtc * activeEntryPrice;
  const activeMarginRequired = activeNotional / activeDraft.leverage;
  const activeFees = activeNotional * 0.00045;
  const activeLiquidation = closeIntent ? closeIntent.position.liquidationPrice : estimateDraftLiquidation({
    side: activeDraft.side,
    entryPrice: activeEntryPrice,
    leverage: activeDraft.leverage,
  });
  const entryPrice = draft.orderType === "limit" && draft.limitPrice ? draft.limitPrice : snapshot.market.markPrice;
  const notional = draft.sizeBtc * entryPrice;
  const marginRequired = notional / draft.leverage;
  const fees = notional * 0.00045;
  const liquidation = estimateDraftLiquidation({
    side: draft.side,
    entryPrice,
    leverage: draft.leverage,
  });
  const freshness = useMemo(
    () => getTerminalFreshness({
      now,
      marketAsOf: snapshot.asOf,
      candlesFetchedAt: chartData.fetchedAt,
      candlesFallback: chartData.isFallback,
      candlesError: chartData.error,
      accountUpdatedAt: snapshot.account.updatedAt,
      accountUnavailable: snapshot.account.liveAccountDataUnavailable,
      isLoadingMarket: isLoadingData,
      isLoadingCandles,
      apiStatus,
    }),
    [
      apiStatus,
      chartData.error,
      chartData.fetchedAt,
      chartData.isFallback,
      isLoadingCandles,
      isLoadingData,
      now,
      snapshot.account.liveAccountDataUnavailable,
      snapshot.account.updatedAt,
      snapshot.asOf,
    ],
  );
  const eligibilityStatus = getTerminalEligibilityStatus(eligibility.state);
  const accountReadiness = getAccountReadinessDisplay({
    wallet,
    eligibilityState: eligibility.state,
    accountValueKind: snapshot.account.valueKind,
    liveAccountDataLoaded: snapshot.account.liveAccountDataLoaded,
    liveAccountDataUnavailable: snapshot.account.liveAccountDataUnavailable,
  });
  const liveReadiness = getLiveTradingReadiness({
    wallet,
    eligibilityState: eligibility.state,
    executionVenue: eligibility.executionVenue,
    mainnetExecutionEnabled: eligibility.mainnetExecutionEnabled,
    killSwitchEnabled: eligibility.killSwitchEnabled,
    accountValueKind: snapshot.account.valueKind,
    liveAccountDataLoaded: snapshot.account.liveAccountDataLoaded,
    liveAccountDataUnavailable: snapshot.account.liveAccountDataUnavailable,
  });
  const liveDisabledReason = liveReadiness.disabledReason;
  const canLiveTrade = mode === "live" && liveReadiness.allowed;

  useEffect(() => {
    if (mode === "live" && !liveReadiness.allowed) {
      setMode("paper");
    }
  }, [liveReadiness.allowed, mode]);
  const draftImpact = useMemo(
    () => calculateDraftImpact({ account: snapshot.account, market: snapshot.market, draft, entryPrice }),
    [snapshot.account, snapshot.market, draft, entryPrice],
  );
  const portfolioExposure = useMemo(
    () => calculatePortfolioExposure(snapshot.account, snapshot.market.symbol),
    [snapshot.account, snapshot.market.symbol],
  );
  const portfolioRiskLabels = useMemo(
    () => classifyPortfolioRisk({
      account: snapshot.account,
      exposure: portfolioExposure,
      selectedSymbol: snapshot.market.symbol,
      mode,
    }),
    [snapshot.account, portfolioExposure, snapshot.market.symbol, mode],
  );

  const maxBookSize = useMemo(() => {
    const sizes = [...snapshot.orderBook.asks, ...snapshot.orderBook.bids].map((level) => level.size);
    return Math.max(...sizes, 1);
  }, [snapshot.orderBook]);
  const marketDataWarning = useMemo(() => {
    if (!Number.isFinite(snapshot.market.markPrice) || snapshot.market.markPrice <= 0) {
      return undefined;
    }
    if (isTerminalStreamWarning(streamStatus)) {
      return terminalStreamStatusDetail(streamStatus);
    }
    if (freshness.marketFreshness.state !== "fresh") {
      return freshness.marketFreshness.detail;
    }
    return undefined;
  }, [freshness.marketFreshness.detail, freshness.marketFreshness.state, snapshot.market.markPrice, streamStatus]);

  async function switchTerminalMarket(symbol: string, options: { question?: string } = {}) {
    const resolved = normalizeSymbol(symbol);
    setIsLoadingData(true);
    setIsLoadingCandles(true);
    setMarketNotice(undefined);
    setAnnotations([]);
    if (!options.question) {
      setAgent(undefined);
      setAgentQuestion(undefined);
    }
    const optimisticMarket = marketOptions.find((market) => normalizeSymbol(market.symbol) === resolved);
    const optimisticSnapshot = optimisticMarket
      ? buildSwitchingMarketSnapshot({ current: snapshot, market: optimisticMarket })
      : undefined;

    if (optimisticSnapshot) {
      setSnapshot(optimisticSnapshot);
      setDraft(buildDefaultDraft(optimisticSnapshot));
      setChartData(buildLoadingTerminalChartData(optimisticSnapshot.market, chartInterval));
      setStreamStatus("connecting");
      updateTerminalStreamDebug(streamDebugRef, {
        selectedMarket: optimisticSnapshot.market.symbol,
        subscribedCoin: optimisticSnapshot.market.base,
        lastTradeCoin: undefined,
        lastCandleUpdateTime: undefined,
        streamStatus: "connecting",
      });
      router.replace(`/terminal?symbol=${encodeURIComponent(resolved)}`, { scroll: false });
    }

    try {
      const snapshotPromise = loadTradingSnapshot(resolved, {
        accountAddress: wallet.status === "connected" ? wallet.address : undefined,
      });
      const candlePromise = optimisticSnapshot
        ? loadTerminalCandles(optimisticSnapshot.market, chartInterval)
        : undefined;
      const result = await snapshotPromise;
      if (result.usedFallback || normalizeSymbol(result.resolvedSymbol) !== resolved) {
        setMarketNotice(`${resolved} is not available from /markets yet. Showing ${result.snapshot.market.base} instead.`);
        setSnapshot(result.snapshot);
        setDraft(buildDefaultDraft(result.snapshot));
        setAgent(options.question ? buildUnsupportedPromptMarketResponse(options.question, resolved, snapshot) : undefined);
        setAnnotations([]);
        return { snapshot: result.snapshot, chartData, supported: false };
      }

      const nextChartData = await (candlePromise ?? loadTerminalCandles(result.snapshot.market, chartInterval));
      setSnapshot((current) => mergeLoadedSnapshot({ current, next: result.snapshot }));
      setChartData(nextChartData);
      setDraft(buildDefaultDraft(result.snapshot));
      setApiStatus("ok");
      router.replace(`/terminal?symbol=${encodeURIComponent(result.resolvedSymbol)}`, { scroll: false });
      return { snapshot: result.snapshot, chartData: nextChartData, supported: true };
    } finally {
      setIsLoadingData(false);
      setIsLoadingCandles(false);
    }
  }

  async function runAgent(scenario: AgentScenario) {
    setIsThinking(true);
    setAgent(undefined);
    setAgentQuestion(undefined);
    setAnnotations([]);
    const response = await agentService.run({
      scenario,
      snapshot: {
        ...snapshot,
        market: { ...snapshot.market, dataAgeSeconds: freshness.marketAgeSeconds },
      },
      chartData,
      freshness,
      isStale: !freshness.isDraftSafe,
      accountFreshnessWarning: [marketDataWarning, freshness.accountFreshness.warning].filter(Boolean).join(" ") || undefined,
      marketDataWarning,
      mode,
      eligibilityState: eligibility.state,
      liveAllowed: liveReadiness.allowed,
      paperAllowed: true,
      mainnetExecutionEnabled: eligibility.mainnetExecutionEnabled,
      killSwitchEnabled: eligibility.killSwitchEnabled,
      executionVenue: eligibility.executionVenue,
    });
    setAgent(response);
    setAgentQuestion(response.question);
    setAnnotations(response.annotations);
    setIsThinking(false);
  }

  async function runTypedAgent(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }

    setIsThinking(true);
    setAgent(undefined);
    setAgentQuestion(trimmed);
    setAnnotations([]);
    setMarketNotice(undefined);
    let agentSnapshot = snapshot;
    let agentFreshness = freshness;
    let agentChartData = chartData;

    try {
      const discovery = await loadMarketDiscoverySnapshot();
      const promptMarket = resolveTypedPromptMarket({
        prompt: trimmed,
        currentSymbol: snapshot.market.symbol,
        supportedSymbols: discovery.markets.map((market) => market.symbol),
      });

      if (promptMarket.unsupported && promptMarket.mentionedSymbol) {
        setAgent(buildUnsupportedPromptMarketResponse(trimmed, promptMarket.mentionedSymbol, snapshot));
        setAnnotations([]);
        setIsThinking(false);
        return;
      }

      if (promptMarket.resolvedSymbol && !promptMarket.isCurrentMarket) {
        const switched = await switchTerminalMarket(promptMarket.resolvedSymbol, { question: trimmed });
        if (!switched.supported) {
          setAnnotations([]);
          setIsThinking(false);
          return;
        }

        const nextNow = Date.now();
        agentSnapshot = switched.snapshot;
        agentChartData = switched.chartData;
        agentFreshness = getTerminalFreshness({
          now: nextNow,
          marketAsOf: switched.snapshot.asOf,
          candlesFetchedAt: switched.chartData.fetchedAt,
          candlesFallback: switched.chartData.isFallback,
          candlesError: switched.chartData.error,
          accountUpdatedAt: switched.snapshot.account.updatedAt,
          accountUnavailable: switched.snapshot.account.liveAccountDataUnavailable,
          apiStatus: "ok",
        });

        setNow(nextNow);
      }
    } catch {
      const mentionedSymbol = resolveTypedPromptMarket({
        prompt: trimmed,
        currentSymbol: snapshot.market.symbol,
        supportedSymbols: [snapshot.market.base],
      }).mentionedSymbol;
      if (mentionedSymbol) {
        setAgent(buildUnsupportedPromptMarketResponse(trimmed, mentionedSymbol, snapshot));
        setAnnotations([]);
        setIsLoadingData(false);
        setIsLoadingCandles(false);
        setIsThinking(false);
        return;
      }
      setIsLoadingData(false);
      setIsLoadingCandles(false);
    }

    const response = await agentService.runPrompt({
      prompt: trimmed,
      snapshot: {
        ...agentSnapshot,
        market: { ...agentSnapshot.market, dataAgeSeconds: agentFreshness.marketAgeSeconds },
      },
      chartData: agentChartData,
      freshness: agentFreshness,
      isStale: !agentFreshness.isDraftSafe,
      accountFreshnessWarning: [
        marketDataWarning,
        agentFreshness.accountFreshness.warning,
      ].filter(Boolean).join(" ") || undefined,
      marketDataWarning,
      mode,
      eligibilityState: eligibility.state,
      liveAllowed: liveReadiness.allowed,
      paperAllowed: true,
      mainnetExecutionEnabled: eligibility.mainnetExecutionEnabled,
      killSwitchEnabled: eligibility.killSwitchEnabled,
      executionVenue: eligibility.executionVenue,
    });
    setAgent(response);
    setAnnotations(response.annotations);
    setIsThinking(false);
  }

  function sendToTicket(orderDraft: OrderDraft) {
    setDraft({ ...orderDraft, fromAgent: true });
    setSubmitState({ message: "Agent proposal copied into the ticket." });
    setModalError(undefined);
  }

  function updateDraft(patch: Partial<OrderDraft>) {
    setDraft((current) => applyManualDraftPatch(current, patch));
    setModalError(undefined);
  }

  async function submitPaperOrder(orderDraft: OrderDraft = draft, orderEntryPrice: number = entryPrice) {
    const endpoint = paperOrderEndpoint(API_BASE_URL);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...paperSessionHeaders() },
        body: JSON.stringify({ draft: orderDraft, estimatedEntry: orderEntryPrice }),
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const error = (await res.json()) as { message?: string; guidance?: string };
          message = error.guidance ?? error.message ?? message;
        } catch {
          // Response was not JSON; keep status-based message.
        }
        throw new Error(message);
      }
      const json = (await res.json()) as { id: string; notionalUsd: number };
      setApiStatus("ok");
      const refreshed = await loadTradingSnapshot(snapshot.market.base, {
        accountAddress: wallet.status === "connected" ? wallet.address : undefined,
      });
      setSnapshot(refreshed.snapshot);
      if (orderDraft.reduceOnly) {
        setSubmitState(closePositionSubmitState({
          mode: "paper",
          market: orderDraft.symbol,
          side: orderDraft.side,
          notionalUsd: json.notionalUsd,
          resultSummary: `Paper fill recorded. Position updated: ${json.id}.`,
        }));
      } else {
        setSubmitState(paperOrderSubmitState(`Paper fill recorded. Position updated: ${json.id} (${fmtUsd(json.notionalUsd, 2)} notional).`));
      }
    } catch (err) {
      setApiStatus("unavailable");
      throw new Error(paperOrderFailureMessage(err, endpoint));
    }
  }

  async function buildSignAndSendLiveAction(action: unknown, user: `0x${string}`, provider: Eip1193Provider) {
    if (wallet.status !== "connected" || !wallet.address || !wallet.getEthereumProvider) {
      throw new Error("Wallet required.");
    }
    const headers = {
      "content-type": "application/json",
      "x-agent-trade-risk-accepted": "true",
      "x-agent-trade-terms-accepted": "true",
    };

    const buildRes = await fetch(`${API_BASE_URL}/agent-trade/exchange`, {
      method: "POST",
      headers,
      body: JSON.stringify({ user, action }),
    });
    if (!buildRes.ok) {
      throw new Error(liveOrderErrorMessage(await readLiveOrderError(buildRes, "Exchange build failed")));
    }
    const built = (await buildRes.json()) as { typedData: unknown; nonce: number; action: unknown };
    if (!built.typedData) {
      throw new Error("Exchange build did not return typed data for wallet signing.");
    }
    const typedData = built.typedData as HyperliquidTypedData;
    const rawSignature = await provider.request({
      method: "eth_signTypedData_v4",
      params: [user, JSON.stringify(withExplicitEip712Domain(typedData))],
    });
    if (typeof rawSignature !== "string") {
      throw new Error("Wallet returned an invalid signature.");
    }
    const signature = normalizeHexSignature(rawSignature as `0x${string}`);
    const sendRes = await fetch(`${API_BASE_URL}/agent-trade/exchange`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: built.action, nonce: built.nonce, signature }),
    });
    if (!sendRes.ok) {
      throw new Error(liveOrderErrorMessage(await readLiveOrderError(sendRes, "Exchange send failed")));
    }
    return await readJsonOrEmpty(sendRes);
  }

  async function submitLiveOrder(orderDraft: OrderDraft = draft, orderMarket: ClosePositionIntent["market"] | SharedTradingSnapshot["market"] = snapshot.market, orderNotional: number = notional) {
    if (!canLiveTrade) {
      throw new Error(liveDisabledReason);
    }
    if (wallet.status !== "connected" || !wallet.address || !wallet.getEthereumProvider) {
      throw new Error("Wallet required.");
    }
    const provider = await wallet.getEthereumProvider();
    const user = wallet.address as `0x${string}`;
    const action = buildHlOrderAction(orderDraft, orderMarket);
    const exchangeResponse = await buildSignAndSendLiveAction(action, user, provider);
    const refreshed = await loadTradingSnapshot(snapshot.market.base, {
      accountAddress: user,
    });
    setSnapshot(refreshed.snapshot);
    setBottomTab("fills");
    const submitStateArgs = {
      scannerUrl: hypurrscanAddressUrl(user),
      market: orderDraft.symbol,
      side: orderDraft.side,
      notionalUsd: orderNotional,
      resultSummary: summarizeExchangeResponse(exchangeResponse),
    };
    setSubmitState(orderDraft.reduceOnly
      ? closePositionSubmitState({ mode: "live", ...submitStateArgs })
      : liveOrderSubmitState(submitStateArgs));
  }

  async function cancelLiveOrder(order: SharedTradingSnapshot["account"]["openOrders"][number]) {
    if (!order.cancelAction) {
      setSubmitState({ message: "Cancel unavailable: this open order did not include a cancel action." });
      return;
    }
    if (wallet.status !== "connected" || !wallet.address || !wallet.getEthereumProvider) {
      setSubmitState({ message: "Cancel unavailable: wallet required." });
      return;
    }
    if (!liveReadiness.allowed) {
      setSubmitState({ message: liveReadiness.disabledReason });
      return;
    }

    const orderKey = openOrderRowKey(order);
    setCancellingOrderKey(orderKey);
    setModalError(undefined);
    try {
      const provider = await wallet.getEthereumProvider();
      const user = wallet.address as `0x${string}`;
      const exchangeResponse = await buildSignAndSendLiveAction(order.cancelAction, user, provider);
      const refreshed = await loadTradingSnapshot(snapshot.market.base, { accountAddress: user });
      setSnapshot(refreshed.snapshot);
      setBottomTab("orders");
      setSubmitState({
        message: `Cancel submitted for ${order.symbol} order${order.oid ? ` #${order.oid}` : ""}.`,
        detail: summarizeExchangeResponse(exchangeResponse),
        scannerUrl: hypurrscanAddressUrl(user) ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Cancel failed.";
      setSubmitState({ message });
    } finally {
      setCancellingOrderKey(undefined);
    }
  }

  function marketForPosition(position: Position): ClosePositionIntent["market"] | undefined {
    const normalized = normalizeSymbol(position.symbol);
    if (normalizeSymbol(snapshot.market.symbol) === normalized || normalizeSymbol(snapshot.market.base) === normalized) {
      return {
        ...snapshot.market,
        symbol: snapshot.market.symbol,
        base: snapshot.market.base,
        assetIndex: snapshot.market.assetIndex,
        markPrice: Number.isFinite(position.markPrice) && position.markPrice > 0 ? position.markPrice : snapshot.market.markPrice,
        szDecimals: snapshot.market.szDecimals,
      };
    }

    const market = marketOptions.find((item) => normalizeSymbol(item.symbol) === normalized || normalizeSymbol(item.base) === normalized);
    if (!market) {
      return undefined;
    }
    return {
      symbol: `${market.base}-USD`,
      base: market.base,
      assetIndex: market.assetIndex,
      markPrice: Number.isFinite(position.markPrice) && position.markPrice > 0 ? position.markPrice : market.markPrice,
      szDecimals: market.szDecimals,
    };
  }

  function openClosePositionModal(position: Position) {
    if (!position.size || position.size <= 0) {
      setSubmitState({ message: "Close unavailable: no position size to close." });
      return;
    }
    const market = marketForPosition(position);
    if (!market) {
      setSubmitState({ message: `Close unavailable: market metadata for ${position.symbol} is not loaded.` });
      return;
    }
    if (position.mode === "live") {
      if (mode !== "live") {
        setSubmitState({ message: "Switch to Live mode to close a live Hyperliquid position. Paper mode remains available for simulated positions." });
        return;
      }
      if (!liveReadiness.allowed) {
        setSubmitState({ message: liveReadiness.disabledReason });
        return;
      }
      if (wallet.status !== "connected" || !wallet.address || !wallet.getEthereumProvider) {
        setSubmitState({ message: "Close unavailable: wallet required." });
        return;
      }
      if (snapshot.account.liveAccountDataUnavailable) {
        setSubmitState({ message: "Close unavailable: Hyperliquid account state is unavailable. Refresh before live trading." });
        return;
      }
    }

    setCloseIntent({
      position,
      draft: closePositionDraft(position),
      market,
      entryPrice: market.markPrice,
    });
    setIsAcked(false);
    setModalError(undefined);
    setModalOpen(true);
  }

  async function confirmOrder() {
    if (!isAcked) {
      return;
    }
    setIsConfirming(true);
    setSubmitState(undefined);
    setModalError(undefined);
    try {
      if (activeMode === "paper") {
        await submitPaperOrder(activeDraft, activeEntryPrice);
      } else {
        await submitLiveOrder(activeDraft, activeOrderMarket, activeNotional);
      }
      setModalOpen(false);
      setCloseIntent(undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Order submission failed.";
      setModalError(message);
      setSubmitState({ message });
    } finally {
      setIsConfirming(false);
    }
  }

  return (
    <div className="terminal-shell">
      <TerminalRail />
      <main className="terminal-workspace">
        <TerminalMarketHeader
          snapshot={snapshot}
          eligibility={eligibility}
          eligibilityStatus={eligibilityStatus}
          liveReadiness={liveReadiness}
          mode={mode}
          setMode={setMode}
          apiStatus={apiStatus}
          freshness={freshness}
          streamStatus={streamStatus}
          isLoadingData={isLoadingData}
          marketNotice={marketNotice}
          accountReadiness={accountReadiness}
          marketOptions={marketOptions}
          onSelectMarket={(symbol) => {
            setAgent(undefined);
            setAgentQuestion(undefined);
            setAnnotations([]);
            void switchTerminalMarket(symbol);
          }}
        />
        {apiStatus !== "ok" ? (
          <TerminalStatusBanner
            eligibilityStatus={eligibilityStatus}
            apiStatus={apiStatus}
            apiBaseUrl={API_BASE_URL}
          />
        ) : null}

        <section className="terminal-grid">
          <div className="terminal-chart-stack">
            <ChartPanel
              snapshot={snapshot}
              annotations={annotations}
              chartData={chartData}
              setChartData={setChartData}
              isLoadingCandles={isLoadingCandles}
              setIsLoadingCandles={setIsLoadingCandles}
              interval={chartInterval}
              setInterval={setChartInterval}
            />
            <BottomPanel
              snapshot={snapshot}
              bottomTab={bottomTab}
              setBottomTab={setBottomTab}
              accountAddress={wallet.status === "connected" ? wallet.address : undefined}
              cancellingOrderKey={cancellingOrderKey}
              cancelLiveOrder={(order) => void cancelLiveOrder(order)}
              openClosePositionModal={openClosePositionModal}
            />
          </div>
          <div className="terminal-book-stack">
            <BookPanel snapshot={snapshot} maxBookSize={maxBookSize} isLoading={isLoadingData} />
            <TradesPanel snapshot={snapshot} streamStatus={streamStatus} isLoading={isLoadingData} />
          </div>
          <div className="terminal-ticket-stack">
            <TicketPanel
              base={snapshot.market.base}
              symbol={snapshot.market.symbol}
              pricePrecision={snapshot.market}
              szDecimals={snapshot.market.szDecimals}
              maxLeverage={Math.min(10, snapshot.market.maxLeverage)}
              draft={draft}
              updateDraft={updateDraft}
              entryPrice={entryPrice}
              notional={notional}
              marginRequired={marginRequired}
              fees={fees}
              liquidation={liquidation}
              canLiveTrade={canLiveTrade}
              liveDisabledReason={liveDisabledReason}
              mode={mode}
              eligibility={eligibility}
              apiStatus={apiStatus}
              simulatedBalanceUsd={snapshot.account.simulatedBalanceUsd}
              accountReadiness={accountReadiness}
              openModal={() => {
                setIsAcked(false);
                setModalError(undefined);
                setModalOpen(true);
              }}
            />
            <ImpactPanel
              base={snapshot.market.base}
              impact={draftImpact}
              exposureLabels={portfolioRiskLabels}
            />
            {submitState ? <SubmitStateNotice state={submitState} /> : null}
          </div>
          <div className="terminal-agent-stack">
            <AgentPanel
              base={snapshot.market.base}
              agent={agent}
              agentQuestion={agentQuestion}
              isThinking={isThinking}
              runAgent={runAgent}
              runTypedAgent={runTypedAgent}
              sendToTicket={sendToTicket}
              freshness={freshness}
              streamStatus={streamStatus}
            />
          </div>
        </section>

      {modalOpen ? (
        <ConfirmModal
          draft={activeDraft}
          base={activeOrderMarket.base}
          pricePrecision={activeOrderMarket}
          szDecimals={activeOrderMarket.szDecimals}
          mode={activeMode}
          entryPrice={activeEntryPrice}
          notional={activeNotional}
          marginRequired={activeMarginRequired}
          fees={activeFees}
          liquidation={activeLiquidation}
          canLiveTrade={canLiveTrade}
          liveDisabledReason={liveDisabledReason}
          eligibility={eligibility}
          intent={closeIntent ? "close" : "order"}
          modalError={modalError}
          isAcked={isAcked}
          setIsAcked={setIsAcked}
          close={() => {
            setModalError(undefined);
            setCloseIntent(undefined);
            setModalOpen(false);
          }}
          confirm={confirmOrder}
          isConfirming={isConfirming}
        />
      ) : null}
      </main>
    </div>
  );
}

function SubmitStateNotice({ state }: { state: SubmitState }) {
  return (
    <div className="submit-state">
      <span>{state.message}</span>
      {state.detail ? <small>{state.detail}</small> : null}
      {state.scannerUrl ? (
        <a href={state.scannerUrl} target="_blank" rel="noreferrer">
          View on Hypurrscan
        </a>
      ) : null}
    </div>
  );
}

async function readLiveOrderError(response: Response, fallback: string) {
  const json = await readJsonOrEmpty(response);
  if (json && typeof json === "object") {
    const body = json as { message?: string; guidance?: string; code?: string };
    return {
      code: body.code,
      guidance: body.guidance,
      message: body.message ?? fallback,
    };
  }
  return { message: fallback };
}

async function readJsonOrEmpty(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function summarizeExchangeResponse(response: unknown): string {
  if (!response || typeof response !== "object") {
    return "Hyperliquid response received. Refreshing order state.";
  }
  const record = response as {
    exchangeResponse?: unknown;
    status?: string;
    response?: unknown;
    message?: string;
  };
  const inner = record.exchangeResponse && typeof record.exchangeResponse === "object"
    ? record.exchangeResponse as { status?: string; response?: { type?: string; data?: unknown } }
    : undefined;
  const status = inner?.status ?? record.status;
  const type = inner?.response?.type;
  if (status && type) {
    return `Hyperliquid returned ${status} (${type}).`;
  }
  if (status) {
    return `Hyperliquid returned ${status}.`;
  }
  if (record.message) {
    return record.message;
  }
  return "Hyperliquid response received. Refreshing order state.";
}

function TerminalRail() {
  const items = [
    { href: "/terminal", label: "Terminal", active: true },
    { href: "/markets", label: "Markets" },
    { href: "/portfolio", label: "Portfolio" },
    { href: "/rewards", label: "Strategy Builder" },
    { href: "/settings", label: "Settings" },
  ];

  return (
    <aside className="terminal-rail" aria-label="Agent.trade terminal navigation">
      <Link href="/" className="terminal-rail-brand">
        <span>AT</span>
        <strong>Agent.trade</strong>
      </Link>
      <nav>
        {items.map((item) => (
          <Link key={item.label} href={item.href} className={item.active ? "active" : ""}>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="terminal-rail-note">
        <span>Execution</span>
        <strong>Policy gated</strong>
        <p>Live orders require eligibility, real account state, risk acknowledgement, and confirmation.</p>
      </div>
    </aside>
  );
}

function TerminalMarketHeader({
  snapshot,
  eligibility,
  eligibilityStatus,
  liveReadiness,
  mode,
  setMode,
  apiStatus,
  freshness,
  streamStatus,
  isLoadingData,
  marketNotice,
  accountReadiness,
  marketOptions,
  onSelectMarket,
}: {
  snapshot: SharedTradingSnapshot;
  eligibility: EligibilityResponse;
  eligibilityStatus: ReturnType<typeof getTerminalEligibilityStatus>;
  liveReadiness: LiveTradingReadiness;
  mode: "paper" | "live";
  setMode: (mode: "paper" | "live") => void;
  apiStatus: "checking" | "ok" | "unavailable";
  freshness: TerminalFreshness;
  streamStatus: TerminalStreamStatus;
  isLoadingData: boolean;
  marketNotice: string | undefined;
  accountReadiness: AccountReadinessDisplay;
  marketOptions: JoinedMarket[];
  onSelectMarket: (symbol: string) => void;
}) {
  const marketStats = [
    ["Mark", fmtMarketUsd({ price: snapshot.market.markPrice, market: snapshot.market })],
    ["Oracle", fmtMarketUsd({ price: snapshot.market.oraclePrice, market: snapshot.market })],
    ["24h", `${fmtPct(snapshot.market.change24hPct, 2)} ${fmtMarketUsd({ price: snapshot.market.change24hAbs, market: snapshot.market })}`],
    ["Volume", fmtCompactUsd(snapshot.market.volume24hUsd)],
    ["Open interest", fmtCompactUsd(snapshot.market.openInterestUsd)],
    ["OI 24h", snapshot.market.openInterestChangePct === null ? "--" : fmtPct(snapshot.market.openInterestChangePct, 1)],
    ["Funding", fmtPct(snapshot.market.fundingRatePct, 4)],
    ["Next", `${snapshot.market.nextFundingMinutes}m`],
  ];
  const accountLabelPrefix = accountReadiness.accountValueKind === "real" || accountReadiness.accountValueKind === "hybrid"
    ? "Account"
    : "Paper";
  const accountStats = [
    [`${accountLabelPrefix} equity`, fmtUsd(snapshot.account.equityUsd, 2)],
    [`${accountLabelPrefix} available`, fmtUsd(snapshot.account.availableUsd, 2)],
    ["Unrealized", fmtUsd(snapshot.account.unrealizedPnlUsd, 2)],
  ];
  const statusCopy = apiStatus === "unavailable"
    ? "API unavailable"
    : liveReadiness.allowed
      ? accountReadiness.summary
      : liveReadiness.disabledReason;

  return (
    <header className="terminal-market-header">
      <div className="terminal-pair-block">
        <span className="terminal-venue">{snapshot.market.venue}</span>
        <MarketSelector
          selectedSymbol={snapshot.market.symbol}
          markets={marketOptions}
          isLoading={isLoadingData}
          onSelectMarket={onSelectMarket}
        />
        <div className="terminal-pair-subline">
          <span className={snapshot.market.change24hPct >= 0 ? "pos" : "neg"}>{fmtPct(snapshot.market.change24hPct, 2)} 24h</span>
          <span>{snapshot.market.source === "live-mainnet" ? "Mainnet read-only market data" : "Deterministic market snapshot"}</span>
        </div>
        {marketNotice ? <p className="market-notice">{marketNotice}</p> : null}
      </div>
      <div className="terminal-header-stats" aria-label="Market stats">
        {marketStats.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{isLoadingData ? "..." : value}</strong>
          </div>
        ))}
      </div>
      <div className="terminal-account-strip" aria-label="Account state">
        <div className="account-source-cell">
          <span>{accountReadiness.label}</span>
          <strong>{compactAccountValueLabel(accountReadiness)}</strong>
        </div>
        {accountStats.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong className={label === "Unrealized" && snapshot.account.unrealizedPnlUsd < 0 ? "neg" : ""}>{value}</strong>
          </div>
        ))}
      </div>
      <div className="terminal-header-actions">
        <span
          className={streamStatus === "live" ? "state-pill live" : "state-pill stale"}
          title={terminalStreamStatusDetail(streamStatus)}
        >
          {terminalStreamStatusLabel(streamStatus)}
        </span>
        <span
          className={freshness.marketFreshness.state === "fresh" ? "state-pill live" : "state-pill stale"}
          title={freshness.marketFreshness.detail}
        >
          {freshness.label}
        </span>
        {freshness.accountFreshness.warning ? (
          <span className="state-pill account-warning" title={freshness.accountFreshness.detail}>
            Account values may be stale
          </span>
        ) : null}
        <ModeControl liveReadiness={liveReadiness} mode={mode} setMode={setMode} />
        <span className={`terminal-eligibility-pill ${eligibilityStatus.tone}`}>
          <span className="terminal-status-copy-full">
            {statusCopy}
          </span>
          <span className="terminal-status-copy-mobile">
            {apiStatus === "unavailable" ? "API unavailable" : compactMobileStatus(accountReadiness, eligibility.state, liveReadiness)}
          </span>
        </span>
      </div>
    </header>
  );
}

function compactMobileStatus(
  readiness: AccountReadinessDisplay,
  eligibilityState: EligibilityMode,
  liveReadiness: LiveTradingReadiness,
): string {
  if (!liveReadiness.allowed) {
    return liveReadiness.disabledReason;
  }
  if (eligibilityState === "restricted") {
    return "Paper mode active. Live unavailable.";
  }
  if (eligibilityState === "killSwitchDisabled") {
    return "Paper mode active. Live disabled.";
  }
  if (readiness.accountValueKind === "real") {
    return "Live account read-only.";
  }
  if (readiness.accountValueKind === "hybrid") {
    return "Live account plus paper.";
  }
  return "Paper mode active. Account values simulated.";
}

function MarketSelector({
  selectedSymbol,
  markets,
  isLoading,
  onSelectMarket,
}: {
  selectedSymbol: string;
  markets: JoinedMarket[];
  isLoading: boolean;
  onSelectMarket: (symbol: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedBase = normalizeSymbol(selectedSymbol);
  const selectedMarket = markets.find((market) => normalizeSymbol(market.symbol) === selectedBase);
  const visibleMarkets = useMemo(() => filterMarketsForSelector(markets, query).slice(0, 24), [markets, query]);

  function selectMarket(symbol: string) {
    setOpen(false);
    setQuery("");
    if (normalizeSymbol(symbol) !== selectedBase) {
      onSelectMarket(symbol);
    }
  }

  return (
    <div className="market-selector">
      <button
        type="button"
        className="market-selector-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span>
          <strong>{selectedSymbol}</strong>
          <small>{selectedMarket ? `${fmtCompactUsd(selectedMarket.volume24hUsd)} 24h volume` : "Perpetual"}</small>
        </span>
        <b>{isLoading ? "..." : "v"}</b>
      </button>
      {open ? (
        <div className="market-selector-popover" role="dialog" aria-label="Select terminal market">
          <label>
            <span>Search Hyperliquid perps</span>
            <input
              autoFocus
              value={query}
              placeholder="BTC, Ethereum, HYPE..."
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setOpen(false);
                }
              }}
            />
          </label>
          <div className="market-selector-group">
            <div className="market-selector-group-head">
              <span>Perps</span>
              <small>{visibleMarkets.length} shown</small>
            </div>
            <div className="market-selector-list">
              {visibleMarkets.length > 0 ? visibleMarkets.map((market) => (
                <button
                  key={market.symbol}
                  type="button"
                  className={normalizeSymbol(market.symbol) === selectedBase ? "active" : ""}
                  onClick={() => selectMarket(market.symbol)}
                >
                  <span>
                    <strong>{market.displaySymbol}</strong>
                    <small>{market.base}</small>
                  </span>
                  <span>{fmtMarketUsd({ price: market.markPrice, market })}</span>
                  <span className={market.change24hPct >= 0 ? "pos" : "neg"}>{fmtPct(market.change24hPct, 2)}</span>
                  <span>{fmtCompactUsd(market.volume24hUsd)}</span>
                </button>
              )) : (
                <p>No supported perp matches this search.</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ModeControl({
  liveReadiness,
  mode,
  setMode,
}: {
  liveReadiness: LiveTradingReadiness;
  mode: "paper" | "live";
  setMode: (mode: "paper" | "live") => void;
}) {
  const liveDisabled = !liveReadiness.allowed;
  return (
    <div className="mode-control" aria-label="Trading mode">
      <button className={mode === "paper" ? "active" : ""} onClick={() => setMode("paper")}>
        Paper
      </button>
      <button
        className={mode === "live" ? "active" : ""}
        disabled={liveDisabled}
        onClick={() => setMode("live")}
        title={liveDisabled ? liveReadiness.disabledReason : "Live trading ready after confirmation"}
      >
        Live
      </button>
    </div>
  );
}

function compactAccountValueLabel(readiness: AccountReadinessDisplay): string {
  switch (readiness.accountValueKind) {
    case "paper":
      return "Simulated";
    case "real":
      return "Read-only live";
    case "hybrid":
      return "Live + paper";
    case "unavailable":
      return "Unavailable";
    default:
      return assertNeverAccountValueKind(readiness.accountValueKind);
  }
}

function assertNeverAccountValueKind(value: never): never {
  throw new Error(`Unexpected account value kind: ${String(value)}`);
}

function TerminalStatusBanner({
  eligibilityStatus,
  apiStatus,
  apiBaseUrl,
}: {
  eligibilityStatus: ReturnType<typeof getTerminalEligibilityStatus>;
  apiStatus: "checking" | "ok" | "unavailable";
  apiBaseUrl: string;
}) {
  const showApi = apiStatus !== "ok";
  return (
    <section className={`terminal-status-banner ${eligibilityStatus.tone}`}>
      <div>
        {eligibilityStatus.visible ? (
          <>
            <strong>{eligibilityStatus.label}</strong>
            <span>{eligibilityStatus.message}</span>
          </>
        ) : (
          <>
            <strong>Terminal status</strong>
            <span>Live trading is available only after Agent.trade confirms eligibility and order confirmation.</span>
          </>
        )}
      </div>
      {showApi ? (
        <div className={`api-status ${apiStatus}`}>
          <strong>{apiStatus === "checking" ? "API checking" : "API unavailable"}</strong>
          <span>{apiBaseUrl}</span>
        </div>
      ) : null}
    </section>
  );
}

function StatsStrip({ snapshot, isLoading }: { snapshot: SharedTradingSnapshot; isLoading: boolean }) {
  const stats = [
    ["Funding", fmtPct(snapshot.market.fundingRatePct)],
    ["Open interest", fmtCompactUsd(snapshot.market.openInterestUsd)],
    ["OI 24h", snapshot.market.openInterestChangePct === null ? "--" : fmtPct(snapshot.market.openInterestChangePct, 1)],
    ["24h volume", fmtCompactUsd(snapshot.market.volume24hUsd)],
    ["Liquidity", fmtCompactUsd(snapshot.market.liquidityUsd)],
    ["Next funding", `${snapshot.market.nextFundingMinutes}m`],
  ];
  return (
    <div className="stats-strip">
      {stats.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{isLoading ? "..." : value}</strong>
        </div>
      ))}
    </div>
  );
}

function ChartPanel({
  snapshot,
  annotations,
  chartData,
  setChartData,
  isLoadingCandles,
  setIsLoadingCandles,
  interval,
  setInterval,
}: {
  snapshot: SharedTradingSnapshot;
  annotations: ChartAnnotation[];
  chartData: TerminalChartData;
  setChartData: (data: TerminalChartData) => void;
  isLoadingCandles: boolean;
  setIsLoadingCandles: (value: boolean) => void;
  interval: TerminalChartInterval;
  setInterval: (interval: TerminalChartInterval) => void;
}) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const candles = chartData.candles;
  const marketSymbol = snapshot.market.symbol;
  const priceChartFormat = marketPriceChartFormat({ price: snapshot.market.markPrice, market: snapshot.market });

  useEffect(() => {
    let cancelled = false;
    const market = snapshot.market;

    async function loadCandles() {
      setIsLoadingCandles(true);
      const next = await loadTerminalCandles(market, interval);
      if (!cancelled) {
        setChartData(next);
        setIsLoadingCandles(false);
      }
    }

    void loadCandles();
    return () => {
      cancelled = true;
    };
  }, [interval, marketSymbol]);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    async function renderChart() {
      const container = chartRef.current;
      if (!container) {
        return;
      }
      const { createChart, CrosshairMode } = await import("lightweight-charts");
      if (disposed || !chartRef.current) {
        return;
      }

      const chart = createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
        autoSize: true,
        layout: {
          background: { color: "#070a12" },
          textColor: "#8f9bb7",
          fontFamily: "Inter, system-ui, sans-serif",
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: "rgba(255,255,255,0.045)" },
          horzLines: { color: "rgba(255,255,255,0.06)" },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: "rgba(180,190,255,0.35)", labelBackgroundColor: "#1c2440" },
          horzLine: { color: "rgba(180,190,255,0.35)", labelBackgroundColor: "#1c2440" },
        },
        rightPriceScale: {
          borderColor: "rgba(255,255,255,0.08)",
          scaleMargins: { top: 0.08, bottom: 0.24 },
        },
        timeScale: {
          borderColor: "rgba(255,255,255,0.08)",
          timeVisible: true,
          secondsVisible: false,
        },
      });

      const candleSeries = chart.addCandlestickSeries({
        upColor: "#27d6aa",
        downColor: "#ff5c6c",
        borderUpColor: "#27d6aa",
        borderDownColor: "#ff5c6c",
        wickUpColor: "#27d6aa",
        wickDownColor: "#ff5c6c",
        priceFormat: { type: "price", precision: priceChartFormat.precision, minMove: priceChartFormat.minMove },
      });
      candleSeries.setData(
        candles.map((candle) => ({
          time: candle.time as Time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        })),
      );
      annotations.forEach((annotation) => {
        candleSeries.createPriceLine({
          price: annotation.price,
          color: annotationToneColor(annotation.tone),
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: annotationPriceLineTitle(annotation),
        });
      });

      const volumeSeries = chart.addHistogramSeries({
        color: "rgba(91,99,255,0.32)",
        priceFormat: { type: "volume" },
        priceScaleId: "",
      });
      volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.78, bottom: 0 },
      });
      volumeSeries.setData(
        candles.map((candle) => ({
          time: candle.time as Time,
          value: candle.volume,
          color: candle.close >= candle.open ? "rgba(39,214,170,0.24)" : "rgba(255,92,108,0.24)",
        })),
      );

      chart.timeScale().fitContent();
      cleanup = () => chart.remove();
    }

    void renderChart();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [annotations, candles, priceChartFormat.minMove, priceChartFormat.precision]);

  const sourceLabel = terminalChartLabel(chartData);

  return (
    <div className="panel chart-panel">
      <div className="panel-head">
        <div>
          <span>{snapshot.market.base} perpetual</span>
          <strong>{chartData.source === "hyperliquid" ? `${interval} Hyperliquid candles` : `${interval} fallback candles`}</strong>
        </div>
        <div className="timeframes" aria-label="Chart interval">
          {TERMINAL_QUICK_CHART_INTERVALS.map((tf) => (
            <button key={tf} className={tf === interval ? "active" : ""} onClick={() => setInterval(tf)}>
              {tf}
            </button>
          ))}
          <div className="interval-menu">
            <select
              aria-label="More chart intervals"
              value={interval}
              onChange={(event) => setInterval(event.target.value as TerminalChartInterval)}
            >
              {TERMINAL_CHART_INTERVAL_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.intervals.map((tf) => (
                    <option key={tf} value={tf}>
                      {tf}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="chart-canvas" ref={chartRef} role="img" aria-label={`${snapshot.market.base} candlestick chart with agent annotations`} />
      <div className="chart-disclaimer">
        <span>{isLoadingCandles ? `Loading ${interval} Hyperliquid candles...` : sourceLabel}</span>
        {chartData.livePriceAt ? <span>Last candle follows live price; REST candles remain source of truth.</span> : null}
        {chartData.error ? <span className="chart-degraded-note">{chartData.error}</span> : null}
        {annotations.length > 0 ? <strong>{annotations.length} agent annotation{annotations.length === 1 ? "" : "s"}</strong> : null}
      </div>
    </div>
  );
}

function annotationToneColor(tone: ChartAnnotation["tone"]): string {
  switch (tone) {
    case "green":
      return "#27d6aa";
    case "red":
      return "#ff5c6c";
    case "amber":
      return "#f0a23a";
    case "blue":
    default:
      return "#5b63ff";
  }
}

function BookPanel({
  snapshot,
  maxBookSize,
  isLoading,
}: {
  snapshot: SharedTradingSnapshot;
  maxBookSize: number;
  isLoading: boolean;
}) {
  const hasBook = snapshot.orderBook.asks.length > 0 && snapshot.orderBook.bids.length > 0;
  return (
    <div className="panel compact-panel">
      <div className="panel-head tight"><strong>Order book</strong><span>{fmtMarketUsd({ price: snapshot.market.markPrice, market: snapshot.market })}</span></div>
      <div className="book-table">
        {hasBook ? (
          <>
            {[...snapshot.orderBook.asks].reverse().map((level) => (
              <BookRow key={`ask-${level.price}`} level={level} max={maxBookSize} side="ask" market={snapshot.market} />
            ))}
            <div className="spread-row">
              Spread {fmtMarketUsd({ price: snapshot.orderBook.asks[0].price - snapshot.orderBook.bids[0].price, market: snapshot.market })}
            </div>
            {snapshot.orderBook.bids.map((level) => (
              <BookRow key={`bid-${level.price}`} level={level} max={maxBookSize} side="bid" market={snapshot.market} />
            ))}
          </>
        ) : (
          <div className="spread-row">
            {isLoading ? `Loading ${snapshot.market.base} book...` : `${snapshot.market.base} book unavailable`}
          </div>
        )}
      </div>
    </div>
  );
}

function BookRow({
  level,
  max,
  side,
  market,
}: {
  level: { price: number; size: number };
  max: number;
  side: "bid" | "ask";
  market: HyperliquidPricePrecision;
}) {
  return (
    <div className={`book-row ${side}`}>
      <span className="depth" style={{ width: `${(level.size / max) * 100}%` }} />
      <strong>{fmtMarketNumber({ price: level.price, market })}</strong>
      <span>{fmtNumber(level.size, 3)}</span>
    </div>
  );
}

function TradesPanel({
  snapshot,
  streamStatus,
  isLoading,
}: {
  snapshot: SharedTradingSnapshot;
  streamStatus: TerminalStreamStatus;
  isLoading: boolean;
}) {
  const emptyCopy = isLoading || streamStatus === "connecting" || streamStatus === "reconnecting"
    ? `Waiting for ${snapshot.market.base} trades...`
    : streamStatus === "live"
      ? `No ${snapshot.market.base} trades received yet.`
      : `${snapshot.market.base} trade stream unavailable; REST snapshot has no recent-trades fallback.`;

  return (
    <div className="panel compact-panel trades-panel">
      <div className="panel-head tight"><strong>Recent trades</strong><span>{snapshot.market.base}</span></div>
      {snapshot.recentTrades.length > 0 ? snapshot.recentTrades.map((trade) => (
        <div key={trade.id ?? `${snapshot.market.base}-${trade.timestamp}-${trade.price}-${trade.size}`} className={`trade-row ${trade.side}`}>
          <strong>{trade.side === "buy" ? "Buy" : "Sell"}</strong>
          <span>{fmtMarketUsd({ price: trade.price, market: snapshot.market })}</span>
          <span>{fmtNumber(trade.size, 4)}</span>
          <span>{fmtAgo(trade.timestamp, snapshot.asOf)}</span>
        </div>
      )) : (
        <div className="spread-row">{emptyCopy}</div>
      )}
    </div>
  );
}

function TicketPanel(props: {
  base: string;
  symbol: string;
  pricePrecision: HyperliquidPricePrecision;
  szDecimals: number;
  maxLeverage: number;
  draft: OrderDraft;
  updateDraft: (patch: Partial<OrderDraft>) => void;
  entryPrice: number;
  notional: number;
  marginRequired: number;
  fees: number;
  liquidation: number;
  canLiveTrade: boolean;
  liveDisabledReason: string;
  mode: "paper" | "live";
  eligibility: EligibilityResponse;
  apiStatus: "checking" | "ok" | "unavailable";
  simulatedBalanceUsd: number;
  accountReadiness: AccountReadinessDisplay;
  openModal: () => void;
}) {
  const blocked = props.mode === "live" && !props.canLiveTrade;
  const source = getTicketSource(props.draft);
  const largePaperOrder = props.mode === "paper" && props.notional > props.simulatedBalanceUsd;
  return (
    <div className={`panel ticket-panel ${source === "agent" ? "from-agent" : ""}`}>
      <div className="panel-head">
        <div>
          <span>Order ticket</span>
          <strong>{source === "agent" ? "From Agent" : "Manual"}</strong>
        </div>
        <span className={props.mode === "paper" ? "paper-badge" : "live-badge"}>{props.mode}</span>
      </div>
      <div className="segmented">
        <button className={props.draft.side === "long" ? "active long" : ""} onClick={() => props.updateDraft({ side: "long" })}>Long</button>
        <button className={props.draft.side === "short" ? "active short" : ""} onClick={() => props.updateDraft({ side: "short" })}>Short</button>
      </div>
      <div className="segmented">
        {(["market", "limit"] as OrderType[]).map((type) => (
          <button key={type} className={props.draft.orderType === type ? "active" : ""} onClick={() => props.updateDraft({ orderType: type })}>{type}</button>
        ))}
      </div>
      <label className="field">
        <span>Size ({props.base})</span>
        <div className="input-with-action">
          <input
            value={props.draft.sizeBtc}
            type="number"
            min="0"
            step={1 / 10 ** props.szDecimals}
            onChange={(event) => props.updateDraft({ sizeBtc: Number(event.target.value) })}
          />
          <button
            type="button"
            onClick={() =>
              props.updateDraft({
                sizeBtc: Number(Math.max(1 / 10 ** props.szDecimals, props.simulatedBalanceUsd / props.entryPrice / props.draft.leverage).toFixed(props.szDecimals)),
              })
            }
          >
            Max
          </button>
        </div>
        <small>Base asset amount, not USD. Preview: {fmtUsd(props.notional, 2)} notional on {props.symbol}.</small>
      </label>
      {props.draft.orderType === "limit" ? (
        <label className="field">
          <span>Limit price</span>
          <input value={props.draft.limitPrice ?? ""} type="number" onChange={(event) => props.updateDraft({ limitPrice: Number(event.target.value) })} />
        </label>
      ) : null}
      <label className="field">
        <span>Leverage {props.draft.leverage}x</span>
        <input value={props.draft.leverage} type="range" min="1" max={props.maxLeverage} onChange={(event) => props.updateDraft({ leverage: Number(event.target.value) })} />
      </label>
      <div className="segmented">
        {(["isolated", "cross"] as MarginMode[]).map((marginMode) => (
          <button key={marginMode} className={props.draft.marginMode === marginMode ? "active" : ""} onClick={() => props.updateDraft({ marginMode })}>{marginMode}</button>
        ))}
      </div>
      <label className="check-row">
        <input type="checkbox" checked={props.draft.reduceOnly} onChange={(event) => props.updateDraft({ reduceOnly: event.target.checked })} />
        Reduce only
      </label>
      <div className="ticket-two">
        <label className="field">
          <span>Take profit</span>
          <input value={props.draft.takeProfit ?? ""} type="number" onChange={(event) => props.updateDraft({ takeProfit: Number(event.target.value) })} />
        </label>
        <label className="field">
          <span>Stop loss</span>
          <input value={props.draft.stopLoss ?? ""} type="number" onChange={(event) => props.updateDraft({ stopLoss: Number(event.target.value) })} />
        </label>
      </div>
      <div className="ticket-summary">
        <span>Source <strong>{source === "agent" ? "Agent draft" : "Manual input"}</strong></span>
        <span>Account <strong>{props.accountReadiness.accountValueKind === "real" ? "Read-only live" : props.accountReadiness.accountValueKind === "hybrid" ? "Live + paper" : "Paper"}</strong></span>
        <span>Entry <strong>{fmtMarketUsd({ price: props.entryPrice, market: props.pricePrecision })}</strong></span>
        <span>Notional <strong>{fmtUsd(props.notional, 2)}</strong></span>
        <span>Margin <strong>{fmtUsd(props.marginRequired, 2)}</strong></span>
        <span>Est. liq <strong>{fmtMarketUsd({ price: props.liquidation, market: props.pricePrecision })}</strong></span>
        <span>Fees <strong>{fmtUsd(props.fees, 2)}</strong></span>
      </div>
      {blocked ? <p className="block-note">{props.liveDisabledReason} Use paper mode.</p> : null}
      <p className="account-mode-note">{props.accountReadiness.summary}</p>
      {largePaperOrder ? (
        <p className="paper-note">
          Large paper size: this order is above the simulated balance of {fmtUsd(props.simulatedBalanceUsd, 2)}.
        </p>
      ) : null}
      {props.apiStatus === "unavailable" ? (
        <p className="block-note">API unavailable. Paper submit will retry {API_BASE_URL}.</p>
      ) : null}
      <button className="primary-action" disabled={props.draft.sizeBtc <= 0 || blocked} onClick={props.openModal}>
        Review {props.mode} order
      </button>
    </div>
  );
}

function ImpactPanel(props: {
  base: string;
  impact: DraftImpact;
  exposureLabels: string[];
}) {
  return (
    <div className="panel impact-panel">
      <div className="panel-head tight">
        <div>
          <span>Impact on portfolio</span>
          <strong>Before confirmation</strong>
        </div>
      </div>
      <div className="impact-grid">
        <span>Est. notional <strong>{fmtUsd(props.impact.estimatedNotionalUsd, 2)}</strong></span>
        <span>Margin required <strong>{fmtUsd(props.impact.marginRequiredUsd, 2)}</strong></span>
        <span>Post-trade available <strong className={props.impact.postTradeAvailableUsd >= 0 ? "pos" : "neg"}>{fmtUsd(props.impact.postTradeAvailableUsd, 2)}</strong></span>
        <span>Added exposure <strong className={props.impact.addedExposureUsd >= 0 ? "pos" : "neg"}>{fmtUsd(props.impact.addedExposureUsd, 2)}</strong></span>
        <span>{props.base} concentration <strong>{fmtPct(props.impact.selectedMarketConcentrationPct, 1)}</strong></span>
        <span>Liq distance <strong>{fmtPct(props.impact.liquidationDistancePct, 1)}</strong></span>
      </div>
      <div className="risk-tags compact">
        {props.exposureLabels.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function formatRowMarketPrice(
  price: number,
  symbol: string,
  selectedMarket: SharedTradingSnapshot["market"],
): string {
  if (
    normalizeSymbol(symbol) === normalizeSymbol(selectedMarket.symbol) ||
    normalizeSymbol(symbol) === normalizeSymbol(selectedMarket.base)
  ) {
    return fmtMarketUsd({ price, market: selectedMarket });
  }
  return fmtAdaptiveUsd(price);
}

function AgentPanel(props: {
  base: string;
  agent: AgentResponse | undefined;
  agentQuestion: string | undefined;
  isThinking: boolean;
  runAgent: (scenario: AgentScenario) => void;
  runTypedAgent: (prompt: string) => void;
  sendToTicket: (draft: OrderDraft) => void;
  freshness: TerminalFreshness;
  streamStatus: TerminalStreamStatus;
}) {
  const [prompt, setPrompt] = useState("");

  function submitPrompt() {
    const next = prompt.trim();
    if (!next || props.isThinking) {
      return;
    }
    props.runTypedAgent(next);
    setPrompt("");
  }

  return (
    <div className="panel agent-panel">
      <div className="panel-head">
        <div>
          <span>{AGENT_PANEL_HEADING}</span>
          <strong>{props.streamStatus === "live" && props.freshness.marketFreshness.state === "fresh" ? "Agent market read" : "Drafts include market-data warning"}</strong>
        </div>
      </div>
      <div className="prompt-chips">
        <button onClick={() => props.runAgent("long")}>Should I long {props.base}?</button>
        <button onClick={() => props.runAgent("short")}>Should I short {props.base}?</button>
        <button onClick={() => props.runAgent("explain")}>Explain funding + OI</button>
        <button onClick={() => props.runAgent("noTrade")}>Find cleaner setup</button>
      </div>
      <div className="agent-chat-box">
        <input
          aria-label="Ask Agent.trade"
          value={prompt}
          placeholder={`Ask about ${props.base} funding, OI, or a trade setup...`}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitPrompt();
            }
          }}
        />
        <button onClick={submitPrompt} disabled={!prompt.trim() || props.isThinking}>
          Send
        </button>
      </div>
      {props.agentQuestion ? (
        <div className="agent-user-message">
          <span>User</span>
          <p>{props.agentQuestion}</p>
        </div>
      ) : null}
      {props.isThinking ? <div className="thinking">Reading funding, OI, book pressure, and liquidation levels...</div> : null}
      {!props.isThinking && props.agent ? (
        <div className={`agent-answer ${props.agent.state}`}>
          <p className="agent-question">Agent.trade response</p>
          <h3>{props.agent.state === "noTrade" ? "No clean setup" : props.agent.state === "staleRefusal" ? "Refusing to draft" : "Market read"}</h3>
          <p>{props.agent.thesis}</p>
          <div className="receipt-row">
            {props.agent.receipts.map((item) => (
              <span key={item.label}>{item.label}: {item.value}</span>
            ))}
          </div>
          <div className="agent-risk">
            <strong>Risk</strong>
            <p>{props.agent.riskNote}</p>
            <strong>Why this could be wrong</strong>
            <p>{props.agent.whyWrong}</p>
          </div>
          {props.agent.orderDraft ? (
            <button className="secondary-action" onClick={() => props.sendToTicket(props.agent?.orderDraft as OrderDraft)}>
              Send to ticket
            </button>
          ) : null}
          {props.agent.followUps ? (
            <div className="prompt-chips followups">
              {props.agent.followUps.map((followUp) => <button key={followUp}>{followUp}</button>)}
            </div>
          ) : null}
        </div>
      ) : null}
      {!props.isThinking && !props.agent ? (
        <p className="agent-empty">Ask about setups, funding, OI, liquidations, or risk. I can annotate the chart and prefill the ticket.</p>
      ) : null}
    </div>
  );
}

function BottomPanel(props: {
  snapshot: SharedTradingSnapshot;
  bottomTab: "positions" | "orders" | "fills";
  setBottomTab: (tab: "positions" | "orders" | "fills") => void;
  accountAddress?: string;
  cancellingOrderKey?: string;
  cancelLiveOrder: (order: SharedTradingSnapshot["account"]["openOrders"][number]) => void;
  openClosePositionModal: (position: SharedTradingSnapshot["account"]["positions"][number]) => void;
}) {
  const scannerUrl = hypurrscanAddressUrl(props.accountAddress);
  const selectedMarket = props.snapshot.market;
  return (
    <div className="panel bottom-panel">
      <div className="bottom-tabs">
        <button className={props.bottomTab === "positions" ? "active" : ""} onClick={() => props.setBottomTab("positions")}>Positions</button>
        <button className={props.bottomTab === "orders" ? "active" : ""} onClick={() => props.setBottomTab("orders")}>Open orders</button>
        <button className={props.bottomTab === "fills" ? "active" : ""} onClick={() => props.setBottomTab("fills")}>Fills</button>
        <span>Equity {fmtUsd(props.snapshot.account.equityUsd, 2)} | Available {fmtUsd(props.snapshot.account.availableUsd, 2)}</span>
      </div>
      {props.bottomTab === "positions" ? (
        <div className="data-table">
          {props.snapshot.account.positions.map((position) => (
            <div key={positionRowKey(position)} className="data-row">
              <strong>{position.symbol}{position.mode === "paper" ? <span className="paper-ledger-badge">Paper</span> : null}</strong>
              <span className={position.side === "long" ? "pos" : "neg"}>{position.side} {position.size} {position.base}</span>
              <span>{position.leverage}x {position.marginMode}</span>
              <span>Entry {formatRowMarketPrice(position.entryPrice, position.symbol, selectedMarket)}</span>
              <span>PnL <b className={position.pnlUsd >= 0 ? "pos" : "neg"}>{fmtUsd(position.pnlUsd, 2)}</b></span>
              <span className="row-actions-cell">
                Liq {formatRowMarketPrice(position.liquidationPrice, position.symbol, selectedMarket)}
                {position.mode === "live" && scannerUrl ? <HypurrscanLink href={scannerUrl} label="Verify" /> : null}
                {position.mode === "paper" || position.mode === "live" ? (
                  <button
                    type="button"
                    className="mini-action-button"
                    onClick={() => props.openClosePositionModal(position)}
                  >
                    Close
                  </button>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {props.bottomTab === "orders" ? (
        <div className="data-table">
          {props.snapshot.account.openOrders.map((order) => (
            <div key={openOrderRowKey(order)} className="data-row">
              <strong>{order.symbol}{order.mode === "paper" ? <span className="paper-ledger-badge">Paper</span> : null}</strong>
              <span className={order.side === "buy" ? "pos" : "neg"}>{order.side}</span>
              <span>{order.type}</span>
              <span>{formatRowMarketPrice(order.price, order.symbol, selectedMarket)}</span>
              <span>{order.size}</span>
              <span className="row-actions-cell">
                {order.reduceOnly ? "Reduce only" : "Open"}
                {order.mode === "live" && order.cancelAction ? (
                  <button
                    type="button"
                    className="mini-action-button"
                    disabled={props.cancellingOrderKey === openOrderRowKey(order)}
                    onClick={() => props.cancelLiveOrder(order)}
                  >
                    {props.cancellingOrderKey === openOrderRowKey(order) ? "Cancelling..." : "Cancel"}
                  </button>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {props.bottomTab === "fills" ? (
        <div className="data-table">
          {props.snapshot.account.fills.map((fill) => (
            <div key={fillRowKey(fill)} className="data-row">
              <strong>{fill.symbol}{fill.mode === "paper" ? <span className="paper-ledger-badge">Paper</span> : null}</strong>
              <span className={fill.side === "buy" ? "pos" : "neg"}>{fill.side}</span>
              <span>{formatRowMarketPrice(fill.price, fill.symbol, selectedMarket)}</span>
              <span>{fill.size}</span>
              <span>Fee {fmtUsd(fill.feeUsd, 2)}</span>
              <span>
                {fmtAgo(fill.timestamp, props.snapshot.asOf)}
                {fill.mode === "live" && scannerUrl ? <HypurrscanLink href={scannerUrl} label="View" /> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HypurrscanLink({ href, label }: { href: string; label: string }) {
  return (
    <a className="hypurrscan-link" href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

function positionRowKey(position: SharedTradingSnapshot["account"]["positions"][number]): string {
  return [
    position.mode ?? "demo",
    position.symbol,
    position.side,
    position.lastFillId ?? position.updatedAt ?? position.entryPrice,
  ].join("-");
}

function openOrderRowKey(order: SharedTradingSnapshot["account"]["openOrders"][number]): string {
  return [
    order.mode ?? "demo",
    order.oid ?? order.timestamp,
    order.symbol,
    order.side,
    order.price,
    order.size,
  ].join("-");
}

function fillRowKey(fill: SharedTradingSnapshot["account"]["fills"][number]): string {
  return [
    fill.mode ?? "demo",
    fill.symbol,
    fill.orderId ?? fill.timestamp,
    fill.side,
    fill.price,
    fill.size,
  ].join("-");
}

function ConfirmModal(props: {
  draft: OrderDraft;
  base: string;
  pricePrecision: HyperliquidPricePrecision;
  szDecimals: number;
  mode: "paper" | "live";
  entryPrice: number;
  notional: number;
  marginRequired: number;
  fees: number;
  liquidation: number;
  canLiveTrade: boolean;
  liveDisabledReason: string;
  eligibility: EligibilityResponse;
  intent: "order" | "close";
  modalError: string | undefined;
  isAcked: boolean;
  setIsAcked: (value: boolean) => void;
  close: () => void;
  confirm: () => void;
  isConfirming: boolean;
}) {
  const liveBlocked = props.mode === "live" && !props.canLiveTrade;
  const source = getTicketSource(props.draft);
  const title = props.intent === "close" ? "Close position" : props.mode === "paper" ? "Paper confirmation" : "Live confirmation";
  const actionLabel = props.intent === "close"
    ? `Confirm ${props.mode} close`
    : `Confirm ${props.mode} order`;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm order">
      <div className={`confirm-modal ${props.mode}`}>
        <div className="panel-head">
          <div>
            <span>{title}</span>
            <strong>{props.draft.symbol} {props.draft.side}</strong>
          </div>
          {source === "agent" ? <span className="from-agent-badge">From Agent</span> : null}
        </div>
        <div className="confirm-grid">
          <span>Market <strong>{props.draft.symbol}</strong></span>
          <span>Side <strong>{props.draft.side}</strong></span>
          <span>Source <strong>{source === "agent" ? "Agent draft" : "Manual input"}</strong></span>
          <span>Size <strong>{fmtNumber(props.draft.sizeBtc, props.szDecimals)} {props.base}</strong></span>
          <span>Order type <strong>{props.draft.orderType}</strong></span>
          <span>Leverage <strong>{props.draft.leverage}x</strong></span>
          <span>Margin mode <strong>{props.draft.marginMode}</strong></span>
          <span>Reduce only <strong>{props.draft.reduceOnly ? "Yes" : "No"}</strong></span>
          <span>Estimated entry <strong>{fmtMarketUsd({ price: props.entryPrice, market: props.pricePrecision })}</strong></span>
          <span>Est. liquidation <strong>{fmtMarketUsd({ price: props.liquidation, market: props.pricePrecision })}</strong></span>
          <span>TP <strong>{props.draft.takeProfit ? fmtMarketUsd({ price: props.draft.takeProfit, market: props.pricePrecision }) : "Not set"}</strong></span>
          <span>SL <strong>{props.draft.stopLoss ? fmtMarketUsd({ price: props.draft.stopLoss, market: props.pricePrecision }) : "Not set"}</strong></span>
          <span>Notional <strong>{fmtUsd(props.notional, 2)}</strong></span>
          <span>Est. fees <strong>{fmtUsd(props.fees, 2)}</strong></span>
        </div>
        <label className="ack-row">
          <input type="checkbox" checked={props.isAcked} onChange={(event) => props.setIsAcked(event.target.checked)} />
          {getConfirmationAckCopy(source, props.mode, props.intent)}
        </label>
        {props.mode === "paper" ? <p className="paper-note">Paper {props.intent === "close" ? "closes" : "orders"} are simulated and never call /exchange.</p> : null}
        {props.mode === "live" && props.intent === "close" ? <p className="paper-note">Live close submits an opposite-side reduce-only market order through the guarded Agent.trade path.</p> : null}
        {liveBlocked ? <p className="block-note">{props.liveDisabledReason}</p> : null}
        {props.modalError ? <p className="modal-error">{props.modalError}</p> : null}
        <div className="modal-actions">
          <button className="secondary-action" onClick={props.close}>Cancel</button>
          <button className="primary-action" disabled={!props.isAcked || liveBlocked || props.isConfirming} onClick={props.confirm}>
            {props.isConfirming ? "Submitting..." : actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
