import { afterEach, describe, expect, it, vi } from "vitest";

import { DeterministicAgentService } from "../lib/agent-trade/agent-service";
import { loadReadOnlyHyperliquidAccount, loadTerminalCandles, loadTradingSnapshot } from "../lib/agent-trade/data";
import { api } from "../lib/api";
import { filterMarketsForSelector, sortMarketsForSelector, type JoinedMarket } from "../lib/agent-trade/markets";
import { MOCK_TRADING_SNAPSHOT } from "../lib/agent-trade/mock-data";
import { buildHlOrderAction, formatOrderPrice, formatOrderSize } from "../lib/agent-trade/orders";
import { getPaperSessionId, mergePaperAccount, paperSessionHeaders } from "../lib/agent-trade/paper";
import {
  AGENT_PANEL_HEADING,
  applyManualDraftPatch,
  buildFallbackTerminalChartData,
  buildSyntheticTerminalCandles,
  getConfirmationAckCopy,
  getTerminalEligibilityStatus,
  getTerminalFreshness,
  getTicketSource,
  normalizeHexSignature,
  normalizeTerminalCandlesResponse,
  paperOrderEndpoint,
  paperOrderFailureMessage,
  resolveTypedPromptMarket,
  terminalChartLabel,
  withExplicitEip712Domain,
  TERMINAL_CHART_INTERVAL_GROUPS,
  TERMINAL_QUICK_CHART_INTERVALS,
  TERMINAL_ACCOUNT_STALE_MS,
  TERMINAL_CANDLES_STALE_MS,
  TERMINAL_MARKET_STALE_MS,
  isTerminalChartInterval,
} from "../lib/agent-trade/terminal";
import type { PaperAccountSnapshot } from "../lib/agent-trade/types";

const paperAccount: PaperAccountSnapshot = {
  sessionId: "paper-test-session",
  equityUsd: 50_000,
  availableUsd: 49_500,
  marginUsedUsd: 500,
  unrealizedPnlUsd: 0,
  simulatedBalanceUsd: 50_000,
  positions: [
    {
      symbol: "BTC-USD",
      base: "BTC",
      mode: "paper",
      side: "long",
      updatedAt: 123,
      orderCount: 1,
      lastFillId: "paper_1",
      size: 0.01,
      leverage: 2,
      marginMode: "isolated",
      entryPrice: 100_000,
      markPrice: 100_000,
      liquidationPrice: 50_600,
      pnlUsd: 0,
      pnlPct: 0,
      marginUsd: 500,
      fundingUsd: 0,
    },
  ],
  openOrders: [],
  fills: [
    {
      symbol: "BTC-USD",
      mode: "paper",
      side: "buy",
      orderId: "paper_1",
      price: 100_000,
      size: 0.01,
      feeUsd: 0.45,
      timestamp: 123,
    },
  ],
};

describe("Agent.trade terminal product-loop helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps manual paper confirmation copy free of agent drafting claims", () => {
    const copy = getConfirmationAckCopy(getTicketSource({ fromAgent: false }));

    expect(copy).toContain("I am confirming this paper order");
    expect(copy).not.toContain("agent drafted");
  });

  it("uses agent-specific confirmation copy only for agent-prefilled tickets", () => {
    const copy = getConfirmationAckCopy(getTicketSource({ fromAgent: true }));

    expect(copy).toContain("The agent drafted");
    expect(getTicketSource({ fromAgent: true })).toBe("agent");
  });

  it("renders visible paper-only/live-disabled status for unknown and restricted eligibility", () => {
    const unknown = getTerminalEligibilityStatus("unknown");
    const restricted = getTerminalEligibilityStatus("restricted");

    expect(unknown.visible).toBe(true);
    expect(unknown.message).toBe("Paper mode only. Live eligibility has not been confirmed.");
    expect(restricted.visible).toBe(true);
    expect(restricted.message).toBe("Live trading unavailable in your region. Paper trading remains available.");
  });

  it("uses the simulated paper-order endpoint instead of exchange", () => {
    const endpoint = paperOrderEndpoint("http://localhost:8080");

    expect(endpoint).toBe("http://localhost:8080/agent-trade/paper-orders");
    expect(endpoint).not.toContain("/exchange");
  });

  it("formats failed fetch as a visible paper-order API error", () => {
    const endpoint = paperOrderEndpoint("http://localhost:8080");
    const message = paperOrderFailureMessage(new TypeError("Failed to fetch"), endpoint);

    expect(message).toBe(`Paper order failed: API unavailable at ${endpoint}`);
  });

  it("keeps the agent panel heading explicit for terminal layout smoke", () => {
    expect(AGENT_PANEL_HEADING).toBe("Ask Agent.trade");
  });

  it("normalizes raw wallet signatures into JSON-safe Hyperliquid signatures", () => {
    const r = "11".repeat(32);
    const s = "22".repeat(32);

    expect(normalizeHexSignature(`0x${r}${s}00`)).toEqual({ r: `0x${r}`, s: `0x${s}`, v: 27 });
    expect(normalizeHexSignature(`0x${r}${s}01`)).toEqual({ r: `0x${r}`, s: `0x${s}`, v: 28 });
    expect(normalizeHexSignature(`0x${r}${s}1b`)).toEqual({ r: `0x${r}`, s: `0x${s}`, v: 27 });
    expect(() => normalizeHexSignature("0xdeadbeef")).toThrow(/signature length/i);
  });

  it("keeps live exchange send bodies JSON serializable", () => {
    const signature = normalizeHexSignature(`0x${"11".repeat(32)}${"22".repeat(32)}01`);
    const action = { type: "order", orders: [{ a: 0, b: true, p: "100000", s: "0.001", r: false }] };
    const body = JSON.stringify({ action, nonce: 1710000000000, signature });

    expect(body).toContain("\"v\":28");
    expect(JSON.parse(body).signature).toEqual(signature);
  });

  it("adds explicit EIP712Domain types for raw eth_signTypedData_v4 wallets", () => {
    const typedData = withExplicitEip712Domain({
      domain: {
        name: "Exchange",
        version: "1",
        chainId: 1337,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      primaryType: "Agent",
      message: { source: "a", connectionId: "0xabc" },
      types: { Agent: [{ name: "source", type: "string" }] },
    });

    expect(typedData.types.EIP712Domain).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ]);
    expect(JSON.stringify(typedData)).toContain("\"chainId\":1337");
  });

  it("posts live order signatures as r/s hex and numeric v", async () => {
    const built = {
      typedData: withExplicitEip712Domain({
        domain: {
          name: "Exchange",
          version: "1",
          chainId: 1337,
          verifyingContract: "0x0000000000000000000000000000000000000000",
        },
        primaryType: "Agent",
        message: { source: "a", connectionId: "0xabc" },
        types: { Agent: [{ name: "source", type: "string" }] },
      }),
      nonce: 1710000000000,
      action: { type: "order", orders: [{ a: 0, b: true, p: "100000", s: "0.001", r: false }] },
    };
    const signature = normalizeHexSignature(`0x${"11".repeat(32)}${"22".repeat(32)}01`);
    const sentBodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        sentBodies.push(JSON.parse(String(init.body)));
      }
      return new Response(JSON.stringify(sentBodies.length === 1 ? built : { ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const buildResponse = await fetch("http://localhost:8080/agent-trade/exchange", {
      method: "POST",
      body: JSON.stringify({ user: "0x1234567890abcdef1234567890abcdef12345678", action: built.action }),
    });
    const buildJson = (await buildResponse.json()) as typeof built;
    const sendBody = {
      action: buildJson.action,
      nonce: buildJson.nonce,
      signature,
    };
    await fetch("http://localhost:8080/agent-trade/exchange", {
      method: "POST",
      body: JSON.stringify(sendBody),
    });

    expect(sentBodies[1]).toEqual(sendBody);
    expect(typeof (sentBodies[1] as typeof sendBody).signature.v).toBe("number");
  });

  it("formats Hyperliquid order size and price with SDK-compatible wire rules", () => {
    expect(formatOrderSize(0.01234567, 5)).toBe("0.01234");
    expect(formatOrderSize(1.23456, 4)).toBe("1.2345");
    expect(formatOrderPrice(12345.6789, 5, false)).toBe("12346");
    expect(formatOrderPrice(0.000123456789, 2, false)).toBe("0.0001");
    expect(formatOrderPrice(1e-7, 5, false)).not.toContain("e");
  });

  it("builds live order action with truncated size and JSON-safe decimal strings", () => {
    const action = buildHlOrderAction({
      symbol: "BTC-USD",
      side: "long",
      orderType: "market",
      sizeBtc: 0.01234567,
      leverage: 2,
      marginMode: "isolated",
      reduceOnly: false,
      fromAgent: false,
    }, {
      assetIndex: 0,
      markPrice: 100_000,
      szDecimals: 5,
    });

    expect(action.orders[0]).toMatchObject({
      a: 0,
      b: true,
      p: "100500",
      s: "0.01234",
      t: { limit: { tif: "Ioc" } },
    });
  });

  it("merges paper ledger positions and fills into terminal snapshots", () => {
    const merged = mergePaperAccount(MOCK_TRADING_SNAPSHOT, paperAccount);

    expect(merged.account.positions[0]).toMatchObject({ symbol: "BTC-USD", mode: "paper" });
    expect(merged.account.fills[0]).toMatchObject({ symbol: "BTC-USD", mode: "paper" });
    expect(merged.account.valueKind).toBe("paper");
    expect(merged.account.sourceLabel).toBe("Simulated paper account");
    expect(merged.account.marginUsedUsd).toBe(MOCK_TRADING_SNAPSHOT.account.marginUsedUsd + 500);
  });

  it("preserves live-read-only plus paper ledger as a hybrid account source", () => {
    const liveSnapshot = {
      ...MOCK_TRADING_SNAPSHOT,
      account: {
        ...MOCK_TRADING_SNAPSHOT.account,
        valueKind: "real" as const,
        sourceLabel: "Read-only Hyperliquid account",
        liveAccountDataLoaded: true,
        positions: [],
        fills: [],
      },
    };
    const merged = mergePaperAccount(liveSnapshot, paperAccount);

    expect(merged.account.valueKind).toBe("hybrid");
    expect(merged.account.sourceLabel).toBe("Read-only account plus paper ledger");
    expect(merged.account.positions[0]).toMatchObject({ symbol: "BTC-USD", mode: "paper" });
  });

  it("loads real empty Hyperliquid account state for a connected wallet", async () => {
    const user = "0x1234567890abcdef1234567890abcdef12345678";
    vi.spyOn(api, "balance").mockResolvedValue({
      user,
      accountValue: "0",
      withdrawable: "0",
      marginUsed: "0",
      openPositions: 0,
    });
    vi.spyOn(api, "positions").mockResolvedValue({ user, positions: [] });
    vi.spyOn(api, "userFills").mockResolvedValue({ user, fills: [] });
    vi.spyOn(api, "openOrders").mockResolvedValue({ user, orders: [] });

    const account = await loadReadOnlyHyperliquidAccount(user, MOCK_TRADING_SNAPSHOT);

    expect(account.valueKind).toBe("real");
    expect(account.sourceLabel).toBe("Read-only Hyperliquid account");
    expect(account.liveAccountDataLoaded).toBe(true);
    expect(account.equityUsd).toBe(0);
    expect(account.availableUsd).toBe(0);
    expect(account.positions).toEqual([]);
    expect(account.fills).toEqual([]);
  });

  it("maps real Hyperliquid positions and fills without simulated account rows", async () => {
    const user = "0x1234567890abcdef1234567890abcdef12345678";
    vi.spyOn(api, "balance").mockResolvedValue({
      user,
      accountValue: "1250.50",
      withdrawable: "1000.25",
      marginUsed: "250.25",
      openPositions: 1,
    });
    vi.spyOn(api, "positions").mockResolvedValue({
      user,
      positions: [{
        coin: "ETH",
        size: "0.5",
        side: "long",
        entryPx: "3000",
        positionValue: "1600",
        unrealizedPnl: "100",
        returnOnEquity: "0.4",
        liquidationPx: "2400",
        leverage: 4,
        leverageMode: "isolated",
        marginUsed: "400",
      }],
    });
    vi.spyOn(api, "userFills").mockResolvedValue({
      user,
      fills: [{
        coin: "ETH",
        side: "B",
        oid: 123,
        px: "3000",
        sz: "0.5",
        fee: "0.75",
        builderFee: "0.05",
        time: 1710000000000,
      }],
    });
    vi.spyOn(api, "openOrders").mockResolvedValue({ user, orders: [] });

    const account = await loadReadOnlyHyperliquidAccount(user, MOCK_TRADING_SNAPSHOT);

    expect(account.valueKind).toBe("real");
    expect(account.equityUsd).toBe(1250.5);
    expect(account.positions).toHaveLength(1);
    expect(account.positions[0]).toMatchObject({ symbol: "ETH-USD", mode: "live", size: 0.5 });
    expect(account.positions.some((position) => position.mode === "paper")).toBe(false);
    expect(account.fills[0]).toMatchObject({ symbol: "ETH-USD", mode: "live", feeUsd: 0.8 });
  });

  it("provides portfolio-visible paper positions and exposure inputs", () => {
    const merged = mergePaperAccount(MOCK_TRADING_SNAPSHOT, paperAccount);
    const paperPositions = merged.account.positions.filter((position) => position.mode === "paper");

    expect(paperPositions).toHaveLength(1);
    expect(paperPositions[0].marginUsd).toBe(500);
    expect(merged.account.simulatedBalanceUsd).toBe(50_000);
  });

  it("uses the latest paper ledger snapshot for repeated paper position updates", () => {
    const repeatedPaperAccount: PaperAccountSnapshot = {
      ...paperAccount,
      ledgerRevision: 2,
      updatedAt: 456,
      availableUsd: 48_350,
      marginUsedUsd: 1_650,
      positions: [
        {
          ...paperAccount.positions[0],
          updatedAt: 456,
          orderCount: 2,
          lastFillId: "paper_2",
          size: 0.03,
          entryPrice: 106_666.67,
          markPrice: 110_000,
          marginUsd: 1_650,
        },
      ],
      fills: [
        {
          ...paperAccount.fills[0],
          orderId: "paper_2",
          timestamp: 456,
          price: 110_000,
          size: 0.02,
          fromAgent: true,
        },
        paperAccount.fills[0],
      ],
    };

    const merged = mergePaperAccount(MOCK_TRADING_SNAPSHOT, repeatedPaperAccount);

    expect(merged.account.positions[0]).toMatchObject({
      symbol: "BTC-USD",
      mode: "paper",
      size: 0.03,
      orderCount: 2,
      lastFillId: "paper_2",
    });
    expect(merged.account.fills.filter((fill) => fill.mode === "paper")).toHaveLength(2);
    expect(merged.account.marginUsedUsd).toBe(MOCK_TRADING_SNAPSHOT.account.marginUsedUsd + 1650);
  });

  it("keeps paper session ids isolated through localStorage", () => {
    const firstStorage = createLocalStorage();
    vi.stubGlobal("window", { localStorage: firstStorage });
    const firstSession = getPaperSessionId();

    expect(firstSession).toBeTruthy();
    expect(getPaperSessionId()).toBe(firstSession);
    expect(paperSessionHeaders()).toEqual({ "x-agent-trade-session-id": firstSession });

    const secondStorage = createLocalStorage();
    vi.stubGlobal("window", { localStorage: secondStorage });
    const secondSession = getPaperSessionId();

    expect(secondSession).toBeTruthy();
    expect(secondSession).not.toBe(firstSession);
  });

  it("preserves paper ledger positions and fills when market data falls back", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/agent-trade/paper-account")) {
        return new Response(JSON.stringify(paperAccount), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("market unavailable", { status: 503 });
    });

    const result = await loadTradingSnapshot("BTC");

    expect(result.usedFallback).toBe(true);
    expect(result.snapshot.account.positions[0]).toMatchObject({ symbol: "BTC-USD", mode: "paper" });
    expect(result.snapshot.account.fills[0]).toMatchObject({ symbol: "BTC-USD", mode: "paper" });
  });

  it("builds deterministic synthetic OHLC candles from the selected market snapshot", () => {
    vi.setSystemTime(new Date("2026-06-24T12:00:00Z"));

    const candles = buildSyntheticTerminalCandles(MOCK_TRADING_SNAPSHOT.market, 12);

    expect(candles).toHaveLength(12);
    expect(candles.at(-1)?.close).toBe(MOCK_TRADING_SNAPSHOT.market.markPrice);
    expect(candles.every((candle) => candle.high >= Math.max(candle.open, candle.close))).toBe(true);
    expect(candles.every((candle) => candle.low <= Math.min(candle.open, candle.close))).toBe(true);
    expect(candles[1].time - candles[0].time).toBe(900);
  });

  it("distinguishes real Hyperliquid candles from fallback synthetic chart data", () => {
    vi.setSystemTime(new Date("2026-06-24T12:00:12Z"));
    const real = normalizeTerminalCandlesResponse(
      {
        symbol: "BTC-USD",
        interval: "15m",
        source: "hyperliquid",
        fetchedAt: Date.now() - 12_000,
        candles: [
          {
            time: 1_720_000_000,
            open: 60000,
            high: 61000,
            low: 59000,
            close: 60500,
            volume: 12.345,
          },
        ],
      },
      MOCK_TRADING_SNAPSHOT.market,
      "15m",
    );
    const fallback = buildFallbackTerminalChartData(MOCK_TRADING_SNAPSHOT.market, "15m", "Candle API unavailable.");

    expect(real.source).toBe("hyperliquid");
    expect(real.isFallback).toBe(false);
    expect(terminalChartLabel(real, Date.now())).toBe("Hyperliquid candles · 15m · updated 12s ago");
    expect(fallback.source).toBe("synthetic");
    expect(terminalChartLabel(fallback)).toBe("Synthetic fallback · 15m · chart data degraded");
  });

  it("exposes supported terminal interval groups without unsupported intervals", () => {
    const intervals = TERMINAL_CHART_INTERVAL_GROUPS.flatMap((group) => group.intervals);

    expect(intervals).toContain("30m");
    expect(intervals).toContain("1M");
    expect(TERMINAL_QUICK_CHART_INTERVALS).toEqual(["1m", "5m", "15m", "1h", "4h"]);
    expect(isTerminalChartInterval("30m")).toBe(true);
    expect(isTerminalChartInterval("2m")).toBe(false);
    expect(isTerminalChartInterval("6h")).toBe(false);
  });

  it("sorts terminal selector markets by 24h volume", () => {
    const markets = selectorMarkets();

    expect(sortMarketsForSelector(markets).map((market) => market.symbol)).toEqual(["ETH", "BTC", "HYPE", "SOL"]);
  });

  it("filters terminal selector markets by symbol, base, and aliases", () => {
    const markets = selectorMarkets();

    expect(filterMarketsForSelector(markets, "eth").map((market) => market.symbol)).toEqual(["ETH"]);
    expect(filterMarketsForSelector(markets, "Ethereum").map((market) => market.symbol)).toEqual(["ETH"]);
    expect(filterMarketsForSelector(markets, "Hyperliquid").map((market) => market.symbol)).toEqual(["HYPE"]);
    expect(filterMarketsForSelector(markets, "nothing")).toEqual([]);
  });

  it("splits market draft safety from account freshness context", () => {
    const now = Date.now();
    const fresh = getTerminalFreshness({
      now,
      marketAsOf: now - 8_000,
      candlesFetchedAt: now - 12_000,
      accountUpdatedAt: now - 20_000,
      apiStatus: "ok",
    });
    const staleMarket = getTerminalFreshness({
      now,
      marketAsOf: now - TERMINAL_MARKET_STALE_MS - 1_000,
      candlesFetchedAt: now - 12_000,
      accountUpdatedAt: now - 20_000,
      apiStatus: "ok",
    });
    const staleCandles = getTerminalFreshness({
      now,
      marketAsOf: now - 8_000,
      candlesFetchedAt: now - TERMINAL_CANDLES_STALE_MS - 1_000,
      accountUpdatedAt: now - 20_000,
      apiStatus: "ok",
    });
    const staleAccount = getTerminalFreshness({
      now,
      marketAsOf: now - 8_000,
      candlesFetchedAt: now - 12_000,
      accountUpdatedAt: now - TERMINAL_ACCOUNT_STALE_MS - 1_000,
      apiStatus: "ok",
    });

    expect(fresh).toMatchObject({ state: "fresh", label: "Live market data", isDraftSafe: true });
    expect(fresh.marketFreshness).toMatchObject({ state: "fresh", isDraftSafe: true });
    expect(fresh.accountFreshness).toMatchObject({ state: "fresh" });
    expect(staleMarket).toMatchObject({ state: "degraded", isDraftSafe: false });
    expect(staleMarket.label).toBe("Market data stale");
    expect(staleCandles).toMatchObject({ state: "degraded", label: "Candles stale", isDraftSafe: false });
    expect(staleAccount).toMatchObject({ state: "fresh", label: "Live market data", isDraftSafe: true });
    expect(staleAccount.accountFreshness).toMatchObject({
      state: "stale",
      warning: "Portfolio impact may use stale account values.",
    });
  });

  it("treats fallback candles, loading, and API outage as not draft-safe", () => {
    const now = Date.now();
    const fallback = getTerminalFreshness({
      now,
      marketAsOf: now - 8_000,
      candlesFetchedAt: now - 10_000,
      candlesFallback: true,
      apiStatus: "ok",
    });
    const warming = getTerminalFreshness({
      now,
      marketAsOf: now - 8_000,
      apiStatus: "checking",
    });
    const apiUnavailable = getTerminalFreshness({
      now,
      marketAsOf: now - 8_000,
      candlesFetchedAt: now - 10_000,
      apiStatus: "unavailable",
    });

    expect(fallback).toMatchObject({ state: "degraded", isDraftSafe: false });
    expect(warming).toMatchObject({ state: "warming", label: "Refreshing...", isDraftSafe: false });
    expect(apiUnavailable).toMatchObject({ state: "apiUnavailable", label: "API unavailable", isDraftSafe: false });
  });

  it("resolves explicit typed prompt market symbols against supported markets", () => {
    const supportedSymbols = ["BTC", "ETH", "SOL", "HYPE"];
    const cases = [
      ["sell ETH", "BTC-USD", { mentionedSymbol: "ETH", resolvedSymbol: "ETH", unsupported: false, isCurrentMarket: false }],
      ["Can you sell ETH?", "BTC-USD", { mentionedSymbol: "ETH", resolvedSymbol: "ETH", unsupported: false, isCurrentMarket: false }],
      ["Should we short SOL here?", "BTC-USD", { mentionedSymbol: "SOL", resolvedSymbol: "SOL", unsupported: false, isCurrentMarket: false }],
      ["Please long HYPE", "BTC-USD", { mentionedSymbol: "HYPE", resolvedSymbol: "HYPE", unsupported: false, isCurrentMarket: false }],
      ["thoughts on HYPE?", "BTC-USD", { mentionedSymbol: "HYPE", resolvedSymbol: "HYPE", unsupported: false, isCurrentMarket: false }],
      ["Hyperliquid", "BTC-USD", { mentionedSymbol: "HYPE", resolvedSymbol: "HYPE", unsupported: false, isCurrentMarket: false }],
      ["thoughts on Hyperliquid?", "BTC-USD", { mentionedSymbol: "HYPE", resolvedSymbol: "HYPE", unsupported: false, isCurrentMarket: false }],
      ["buy Hyperliquid", "BTC-USD", { mentionedSymbol: "HYPE", resolvedSymbol: "HYPE", unsupported: false, isCurrentMarket: false }],
      ["short Ethereum", "BTC-USD", { mentionedSymbol: "ETH", resolvedSymbol: "ETH", unsupported: false, isCurrentMarket: false }],
      ["sell Bitcoin", "ETH-USD", { mentionedSymbol: "BTC", resolvedSymbol: "BTC", unsupported: false, isCurrentMarket: false }],
      ["sell ETH", "ETH-USD", { mentionedSymbol: "ETH", resolvedSymbol: "ETH", unsupported: false, isCurrentMarket: true }],
      ["Should I short BTC?", "BTC-USD", { mentionedSymbol: "BTC", resolvedSymbol: "BTC", unsupported: false, isCurrentMarket: true }],
      ["sell FAKECOIN", "ETH-USD", { mentionedSymbol: "FAKECOIN", unsupported: true, isCurrentMarket: false }],
    ] as const;

    for (const [prompt, currentSymbol, expected] of cases) {
      expect(resolveTypedPromptMarket({ prompt, currentSymbol, supportedSymbols })).toMatchObject(expected);
    }

    for (const prompt of ["Can you explain funding?", "thoughts?", "thoughts on FAKECOIN?"]) {
      const result = resolveTypedPromptMarket({
        prompt,
        currentSymbol: "BTC-USD",
        supportedSymbols,
      });
      expect(result.mentionedSymbol).toBeUndefined();
      expect(result).toMatchObject({
        unsupported: false,
        isCurrentMarket: true,
      });
    }
  });

  it("only reports unsupported aliases on clear trade intent when alias target is unsupported", () => {
    expect(resolveTypedPromptMarket({
      prompt: "Hyperliquid",
      currentSymbol: "BTC-USD",
      supportedSymbols: ["BTC", "ETH", "SOL"],
    })).toMatchObject({
      unsupported: false,
      isCurrentMarket: true,
    });
    expect(resolveTypedPromptMarket({
      prompt: "buy Hyperliquid",
      currentSymbol: "BTC-USD",
      supportedSymbols: ["BTC", "ETH", "SOL"],
    })).toMatchObject({
      mentionedSymbol: "HYPE",
      unsupported: true,
      isCurrentMarket: false,
    });
  });

  it("falls back to synthetic chart data when the candle API fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));

    const result = await loadTerminalCandles(MOCK_TRADING_SNAPSHOT.market, "15m");

    expect(result.source).toBe("synthetic");
    expect(result.isFallback).toBe(true);
    expect(result.error).toContain("503");
    expect(result.candles).not.toHaveLength(0);
  });

  it("maps typed long/setup prompts to an agent order-draft response", async () => {
    const response = await runTypedPrompt("Should I long BTC here?");

    expect(response.question).toBe("Should I long BTC here?");
    expect(response.state).toBe("tradeProposal");
    expect(response.orderDraft).toMatchObject({
      symbol: "BTC-USD",
      side: "long",
      fromAgent: true,
    });
  });

  it("maps typed short prompts to an agent order-draft response", async () => {
    for (const prompt of ["Should I short BTC?", "bearish BTC setup", "sell ETH", "short this"]) {
      const response = await runTypedPrompt(prompt);

      expect(response.question).toBe(prompt);
      expect(response.state).toBe("tradeProposal");
      expect(response.orderDraft).toMatchObject({
        symbol: "BTC-USD",
        side: "short",
        fromAgent: true,
      });
    }
  });

  it("maps typed funding and OI prompts to an explain response without an order draft", async () => {
    const response = await runTypedPrompt("Explain BTC funding and open interest");

    expect(response.state).toBe("answered");
    expect(response.orderDraft).toBeUndefined();
    expect(response.receipts.map((receipt) => receipt.label)).toContain("Funding");
    expect(response.receipts.map((receipt) => receipt.label)).toContain("OI");
  });

  it("returns a useful market read with follow-ups for unknown typed prompts", async () => {
    const response = await runTypedPrompt("What is happening?");

    expect(response.state).toBe("answered");
    expect(response.orderDraft).toBeUndefined();
    expect(response.thesis).toContain("market read");
    expect(response.followUps?.length).toBeGreaterThanOrEqual(2);
  });

  it("answers typed greetings with capabilities instead of a fake market read", async () => {
    const response = await runTypedPrompt("hi");

    expect(response.state).toBe("answered");
    expect(response.orderDraft).toBeUndefined();
    expect(response.thesis).toContain("Ask me about funding, open interest, liquidation levels, portfolio risk, or a trade setup.");
    expect(response.whyWrong).toContain("will not infer a buy or sell direction");
  });

  it("refuses typed long and short trade drafts when market data is stale", async () => {
    const long = await runTypedPrompt("Should I long BTC here?", true);
    const short = await runTypedPrompt("Should I short BTC here?", true);

    expect(long.state).toBe("staleRefusal");
    expect(long.orderDraft).toBeUndefined();
    expect(long.thesis).toBe("I won’t draft a trade from stale data. Refreshing market data first.");
    expect(short.state).toBe("staleRefusal");
    expect(short.orderDraft).toBeUndefined();
  });

  it("allows paper short proposals when only account freshness is stale", async () => {
    const response = await runTypedPrompt(
      "Should I short BTC here?",
      false,
      "Portfolio impact may use stale account values.",
    );

    expect(response.state).toBe("tradeProposal");
    expect(response.orderDraft).toMatchObject({ side: "short" });
    expect(response.riskNote).toContain("Portfolio impact may use stale account values.");
  });

  it("still answers non-order market reads when data is stale", async () => {
    const response = await runTypedPrompt("Explain funding and OI", true);

    expect(response.state).toBe("answered");
    expect(response.orderDraft).toBeUndefined();
    expect(response.receipts.map((receipt) => receipt.label)).toContain("Funding");
  });

  it("keeps typed-chat proposals agent-sourced until a manual edit resets source", async () => {
    const response = await runTypedPrompt("Should I long BTC here?");
    const draft = response.orderDraft;

    expect(draft).toBeTruthy();
    expect(getTicketSource(draft!)).toBe("agent");

    const edited = applyManualDraftPatch(draft!, { sizeBtc: draft!.sizeBtc + 0.01 });
    expect(getTicketSource(edited)).toBe("manual");
  });
});

async function runTypedPrompt(prompt: string, isStale = false, accountFreshnessWarning?: string) {
  vi.useFakeTimers();
  const service = new DeterministicAgentService();
  const promise = service.runPrompt({
    prompt,
    snapshot: isStale
      ? {
          ...MOCK_TRADING_SNAPSHOT,
          market: { ...MOCK_TRADING_SNAPSHOT.market, dataAgeSeconds: 46 },
        }
      : MOCK_TRADING_SNAPSHOT,
    isStale,
    accountFreshnessWarning,
    mode: "paper",
  });
  await vi.advanceTimersByTimeAsync(700);
  return await promise;
}

function createLocalStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function selectorMarkets(): JoinedMarket[] {
  const base = {
    displaySymbol: "BTC-USD",
    base: "BTC",
    assetIndex: 0,
    szDecimals: 5,
    maxLeverage: 40,
    markPrice: 100,
    midPrice: 100,
    prevDayPrice: 99,
    change24hPct: 1,
    change24hAbs: 1,
    fundingRatePct: 0.01,
    openInterestUsd: 1_000_000,
    openInterestChangePct: null,
    volume24hUsd: 1_000,
    opportunityLabels: ["watch only" as const],
  };

  return [
    { ...base, symbol: "BTC", displaySymbol: "BTC-USD", base: "BTC", volume24hUsd: 3_000 },
    { ...base, symbol: "ETH", displaySymbol: "ETH-USD", base: "ETH", volume24hUsd: 5_000 },
    { ...base, symbol: "SOL", displaySymbol: "SOL-USD", base: "SOL", volume24hUsd: 1_000 },
    { ...base, symbol: "HYPE", displaySymbol: "HYPE-USD", base: "HYPE", volume24hUsd: 2_000 },
  ];
}
