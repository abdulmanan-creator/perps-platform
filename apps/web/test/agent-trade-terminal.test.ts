import { afterEach, describe, expect, it, vi } from "vitest";

import { DeterministicAgentService } from "../lib/agent-trade/agent-service";
import { loadTerminalCandles, loadTradingSnapshot } from "../lib/agent-trade/data";
import { MOCK_TRADING_SNAPSHOT } from "../lib/agent-trade/mock-data";
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
  normalizeTerminalCandlesResponse,
  paperOrderEndpoint,
  paperOrderFailureMessage,
  resolveTypedPromptMarket,
  terminalChartLabel,
  TERMINAL_ACCOUNT_STALE_MS,
  TERMINAL_CANDLES_STALE_MS,
  TERMINAL_MARKET_STALE_MS,
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
