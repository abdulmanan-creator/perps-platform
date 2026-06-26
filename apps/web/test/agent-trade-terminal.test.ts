import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { DeterministicAgentService } from "../lib/agent-trade/agent-service";
import {
  connectorDraftReviewPath,
  encodeConnectorDraftParam,
  parseConnectorDraftParam,
} from "../lib/agent-trade/connector-draft";
import { buildAgentInput, type AgentAnalysis, type AgentProvider } from "../lib/agent-trade/agent-provider";
import { buildAgentPrompt } from "../lib/agent-trade/agent-prompt";
import { parseAgentAnalysis } from "../lib/agent-trade/agent-validation";
import {
  agentDataReadSummary,
  agentProviderDisplay,
  PHASE_4B_AGENT_VALIDATION_CHECKLIST,
  ticketSourceDisplay,
} from "../lib/agent-trade/agent-ux";
import { buildSwitchingMarketSnapshot, loadReadOnlyHyperliquidAccount, loadTerminalCandles, loadTradingSnapshot } from "../lib/agent-trade/data";
import { api } from "../lib/api";
import { hypurrscanAddressUrl, normalizeHypurrscanAddress } from "../lib/agent-trade/hypurrscan";
import { filterMarketsForSelector, sortMarketsForSelector, type JoinedMarket } from "../lib/agent-trade/markets";
import { MOCK_TRADING_SNAPSHOT } from "../lib/agent-trade/mock-data";
import { buildHlOrderAction, formatOrderPrice, formatOrderSize } from "../lib/agent-trade/orders";
import {
  fmtMarketNumber,
  fmtMarketUsd,
  marketPriceChartFormat,
  marketPriceDisplayDecimals,
} from "../lib/agent-trade/format";
import { getPaperSessionId, mergePaperAccount, paperSessionHeaders } from "../lib/agent-trade/paper";
import {
  applyTerminalCandleEvent,
  applyTerminalPriceToChart,
  applyTerminalStreamEvent,
  mergeRecentTrades,
  normalizeTerminalWsMessage,
  terminalAccountSubscriptions,
  terminalMarketSubscriptions,
  terminalStreamStatusLabel,
  upsertTerminalCandles,
} from "../lib/agent-trade/streaming";
import {
  AGENT_PANEL_HEADING,
  applyManualDraftPatch,
  buildFallbackTerminalChartData,
  buildSyntheticTerminalCandles,
  closePositionDraft,
  closePositionSubmitState,
  getConfirmationAckCopy,
  getLiveBuilderApprovalRequired,
  getTerminalEligibilityStatus,
  getTerminalFreshness,
  getTicketSource,
  liveOrderErrorMessage,
  liveOrderPreSubmitBlockReason,
  liveOrderSubmitState,
  normalizeHexSignature,
  normalizeTerminalCandlesResponse,
  paperOrderSubmitState,
  paperOrderEndpoint,
  paperOrderFailureMessage,
  resolveTypedPromptMarket,
  summarizeExchangeResponse,
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
import { AGENT_TRADE_GOLDEN_PROMPT_FIXTURES } from "./fixtures/agent-trade-golden-prompts";

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

  it("imports connector draft links as ticket drafts, not executable orders", () => {
    const payload = {
      v: 1,
      source: "claude",
      symbol: "BTC",
      side: "long",
      orderType: "market",
      sizeBtc: 0.01,
      leverage: 2,
      marginMode: "isolated",
      reduceOnly: false,
    } as const;
    const encoded = encodeConnectorDraftParam(payload);
    const reviewPath = connectorDraftReviewPath(payload);
    const parsed = parseConnectorDraftParam(encoded);

    expect(reviewPath).toContain("/terminal?symbol=BTC&draft=");
    expect(reviewPath).not.toContain("/exchange");
    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") {
      throw new Error("expected valid connector draft");
    }
    expect(parsed.draft).toMatchObject({
      symbol: "BTC-USD",
      side: "long",
      fromAgent: true,
      source: "connector",
    });
    expect(getTicketSource(parsed.draft)).toBe("connector");
    expect(getConfirmationAckCopy(getTicketSource(parsed.draft))).toContain("confirming in Agent.trade");
    expect(ticketSourceDisplay(parsed.draft)).toMatchObject({
      state: "connector",
      label: "From Connector",
    });
  });

  it("rejects malformed connector drafts before they can prefill a ticket", () => {
    expect(parseConnectorDraftParam("%7Bnot-json")).toMatchObject({
      status: "invalid",
    });
    expect(
      parseConnectorDraftParam(
        encodeURIComponent(JSON.stringify({ v: 1, symbol: "BTC", side: "long", orderType: "market", sizeBtc: -1, leverage: 2, marginMode: "isolated" })),
      ),
    ).toMatchObject({
      status: "invalid",
      message: "Connector draft size must be positive.",
    });
  });

  it("keeps llms connector copy free of live execution claims", () => {
    const copy = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");

    expect(copy).toContain("research, explain, and draft");
    expect(copy).toContain("orders return to Agent.trade");
    expect(copy).toContain("future roadmap only");
    expect(copy).not.toMatch(/connectors can place trades directly/i);
    expect(copy).not.toMatch(/autonomous connector trade execution is live/i);
  });

  it("uses close-specific confirmation copy for paper and live closes", () => {
    expect(getConfirmationAckCopy("manual", "paper", "close")).toContain("paper close");
    expect(getConfirmationAckCopy("manual", "live", "close")).toContain("reduce-only live perpetual order");
    expect(getConfirmationAckCopy("manual", "live", "order")).toContain("live order");
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

  it("builds Hypurrscan address links only for valid wallets", () => {
    const address = "0x4da360ca0da696ba4d56d94c3ef2d4ba4f26cb43";

    expect(normalizeHypurrscanAddress(address.toUpperCase().replace(/^0X/u, "0x"))).toBe(address);
    expect(hypurrscanAddressUrl(address)).toBe(`https://hypurrscan.io/address/${address}`);
    expect(hypurrscanAddressUrl("0xdeadbeef")).toBeNull();
    expect(hypurrscanAddressUrl(undefined)).toBeNull();
  });

  it("keeps paper success free of Hypurrscan links and adds links for live success", () => {
    const address = "0x4da360ca0da696ba4d56d94c3ef2d4ba4f26cb43";
    const paper = paperOrderSubmitState("Paper fill recorded. Position updated.");
    const live = liveOrderSubmitState({
      scannerUrl: hypurrscanAddressUrl(address),
      market: "HYPE-USD",
      side: "long",
      notionalUsd: 10.28,
      resultSummary: "Hyperliquid returned ok (order).",
    });

    expect(paper.message).toContain("Paper fill recorded");
    expect(paper.scannerUrl).toBeUndefined();
    expect(live.message).toContain("Live order submitted: HYPE-USD long $10.28 notional.");
    expect(live.detail).toBe("Hyperliquid returned ok (order).");
    expect(live.scannerUrl).toBe(`https://hypurrscan.io/address/${address}`);
  });

  it("distinguishes paper close success from live close scanner verification", () => {
    const address = "0x4da360ca0da696ba4d56d94c3ef2d4ba4f26cb43";
    const paper = closePositionSubmitState({
      mode: "paper",
      market: "BTC-USD",
      side: "short",
      notionalUsd: 1000,
    });
    const live = closePositionSubmitState({
      mode: "live",
      market: "HYPE-USD",
      side: "short",
      notionalUsd: 10.28,
      scannerUrl: hypurrscanAddressUrl(address),
    });

    expect(paper.message).toContain("Paper close submitted");
    expect(paper.scannerUrl).toBeUndefined();
    expect(live.message).toContain("Live close submitted");
    expect(live.scannerUrl).toBe(`https://hypurrscan.io/address/${address}`);
  });

  it("maps common live order errors to actionable guidance while retaining detail", () => {
    expect(liveOrderErrorMessage({ message: "Must deposit before performing actions" })).toContain("needs a deposit");
    expect(liveOrderErrorMessage({ message: "Insufficient margin" })).toContain("Insufficient margin");
    expect(liveOrderErrorMessage({ message: "builder fee approval missing" })).toContain("Builder fee approval");
    expect(liveOrderErrorMessage({ message: "below $10 min notional" })).toContain("$10 minimum notional");
    expect(liveOrderErrorMessage({ message: "HL_EXCHANGE_REJECTED: rejected" })).toContain("Hyperliquid rejected");
  });

  it("shows nested Hyperliquid order errors as rejected instead of success", () => {
    const summary = summarizeExchangeResponse({
      success: true,
      exchangeResponse: {
        status: "ok",
        response: {
          type: "order",
          data: { statuses: [{ error: "Order must have minimum value of $10." }] },
        },
      },
    });

    expect(summary).toBe("Rejected: Order must have minimum value of $10.");
  });

  it("shows filled Hyperliquid responses as filled", () => {
    expect(summarizeExchangeResponse({
      exchangeResult: { status: "filled", label: "Filled" },
      exchangeResponse: {
        status: "ok",
        response: {
          type: "order",
          data: { statuses: [{ filled: { totalSz: "0.1", avgPx: "100" } }] },
        },
      },
    })).toBe("Filled.");
  });

  it("shows resting Hyperliquid responses as open-order success", () => {
    expect(summarizeExchangeResponse({
      exchangeResult: { status: "resting", label: "Resting open order" },
      exchangeResponse: {
        status: "ok",
        response: {
          type: "order",
          data: { statuses: [{ resting: { oid: 99 } }] },
        },
      },
    })).toBe("Resting open order.");
  });

  it("blocks live submit below the configured minimum notional", () => {
    const reason = liveOrderPreSubmitBlockReason({
      mode: "live",
      notionalUsd: 5,
      minOrderNotionalUsd: 10,
      liveAllowed: true,
      liveDisabledReason: "Live ready.",
    });

    expect(reason).toContain("$10.00 notional");
  });

  it("blocks live submit when account state is for a different wallet", () => {
    const reason = liveOrderPreSubmitBlockReason({
      mode: "live",
      notionalUsd: 20,
      minOrderNotionalUsd: 10,
      liveAllowed: true,
      liveDisabledReason: "Live ready.",
      walletAddress: "0x31Ab9F30D205B2fb5fAC3DB47493D445eFC8FbCb",
      accountAddress: "0x4DA360ca0Da696bA4D56D94C3eF2D4Ba4F26cb43",
      liveAccountDataLoaded: true,
    });

    expect(reason).toContain("Active wallet changed");
  });

  it("blocks live submit before wallet signing when builder approval is missing", () => {
    const reason = liveOrderPreSubmitBlockReason({
      mode: "live",
      notionalUsd: 20,
      minOrderNotionalUsd: 10,
      liveAllowed: true,
      liveDisabledReason: "Live ready.",
      walletAddress: "0x31Ab9F30D205B2fb5fAC3DB47493D445eFC8FbCb",
      accountAddress: "0x31Ab9F30D205B2fb5fAC3DB47493D445eFC8FbCb",
      liveAccountDataLoaded: true,
      builderApprovalRequired: true,
      builderFeeApproved: false,
    });

    expect(reason).toBe("Approve Agent.trade builder fee before first live order.");
  });

  it("requires builder approval for live orders even when funded balance is below order notional minimum", () => {
    const builderApprovalRequired = getLiveBuilderApprovalRequired({ liveAllowed: true });
    const reason = liveOrderPreSubmitBlockReason({
      mode: "live",
      notionalUsd: 20,
      minOrderNotionalUsd: 10,
      liveAllowed: true,
      liveDisabledReason: "Live ready.",
      walletAddress: "0x31Ab9F30D205B2fb5fAC3DB47493D445eFC8FbCb",
      accountAddress: "0x31Ab9F30D205B2fb5fAC3DB47493D445eFC8FbCb",
      liveAccountDataLoaded: true,
      builderApprovalRequired,
      builderFeeApproved: false,
    });

    expect(builderApprovalRequired).toBe(true);
    expect(reason).toBe("Approve Agent.trade builder fee before first live order.");
  });

  it("keeps live submit enabled after builder approval is confirmed", () => {
    const reason = liveOrderPreSubmitBlockReason({
      mode: "live",
      notionalUsd: 20,
      minOrderNotionalUsd: 10,
      liveAllowed: true,
      liveDisabledReason: "Live ready.",
      walletAddress: "0x31Ab9F30D205B2fb5fAC3DB47493D445eFC8FbCb",
      accountAddress: "0x31Ab9F30D205B2fb5fAC3DB47493D445eFC8FbCb",
      liveAccountDataLoaded: true,
      builderApprovalRequired: true,
      builderFeeApproved: true,
    });

    expect(reason).toBeUndefined();
  });

  it("blocks live submit while builder approval status is unavailable", () => {
    const reason = liveOrderPreSubmitBlockReason({
      mode: "live",
      notionalUsd: 20,
      minOrderNotionalUsd: 10,
      liveAllowed: true,
      liveDisabledReason: "Live ready.",
      builderApprovalRequired: true,
      builderApprovalUnavailable: true,
    });

    expect(reason).toContain("could not be checked");
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

  it("formats Hyperliquid market prices with selected-market display precision", () => {
    const hype = { szDecimals: 2 };
    const btc = { szDecimals: 5 };
    const wholeTickMarket = { szDecimals: 6 };

    expect(fmtMarketUsd({ price: 61.665, market: hype })).toBe("$61.665");
    expect(marketPriceDisplayDecimals({ price: 61.665, market: hype })).toBe(3);
    expect(fmtMarketUsd({ price: 104_820.5, market: btc })).toBe("$104,820.5");
    expect(fmtMarketUsd({ price: 123.45, market: wholeTickMarket })).toBe("$123");
  });

  it("uses the same selected-market precision for order book rows and chart labels", () => {
    const hype = { szDecimals: 2 };
    const expectedPrecision = marketPriceDisplayDecimals({ price: 61.665, market: hype });

    expect(fmtMarketNumber({ price: 61.665, market: hype })).toBe("61.665");
    expect(marketPriceChartFormat({ price: 61.665, market: hype })).toEqual({
      precision: expectedPrecision,
      minMove: 0.001,
    });
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

  it("builds reduce-only close orders with the opposite side and market precision", () => {
    const closeLong = closePositionDraft({
      symbol: "HYPE-USD",
      base: "HYPE",
      mode: "live",
      side: "long",
      size: 0.160009,
      leverage: 5,
      marginMode: "isolated",
      entryPrice: 64.24,
      markPrice: 64.242,
      liquidationPrice: 52,
      pnlUsd: 0,
      pnlPct: 0,
      marginUsd: 2,
      fundingUsd: 0,
    });

    const action = buildHlOrderAction(closeLong, {
      assetIndex: 159,
      markPrice: 64.242,
      szDecimals: 2,
    });

    expect(closeLong).toMatchObject({
      side: "short",
      sizeBtc: 0.160009,
      reduceOnly: true,
      fromAgent: false,
    });
    expect(action.orders[0]).toMatchObject({
      a: 159,
      b: false,
      r: true,
      s: "0.16",
      t: { limit: { tif: "Ioc" } },
    });
  });

  it("builds buy reduce-only close orders for short positions", () => {
    const closeShort = closePositionDraft({
      symbol: "ETH-USD",
      base: "ETH",
      mode: "live",
      side: "short",
      size: 1.2345,
      leverage: 3,
      marginMode: "cross",
      entryPrice: 3000,
      markPrice: 2990,
      liquidationPrice: 3600,
      pnlUsd: 0,
      pnlPct: 0,
      marginUsd: 1200,
      fundingUsd: 0,
    });

    const action = buildHlOrderAction(closeShort, {
      assetIndex: 1,
      markPrice: 2990,
      szDecimals: 4,
    });

    expect(closeShort.side).toBe("long");
    expect(action.orders[0]).toMatchObject({
      b: true,
      r: true,
      s: "1.2345",
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
    vi.spyOn(api, "openOrders").mockResolvedValue({
      user,
      orders: [{
        oid: 987,
        assetIndex: 1,
        side: "sell",
        limitPx: "3200",
        sz: "0.25",
        origSz: "0.25",
        timestamp: 1710000001000,
        cancelAction: { type: "cancel", cancels: [{ a: 1, o: 987 }] },
      }],
    });

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
    vi.spyOn(api, "openOrders").mockResolvedValue({
      user,
      orders: [{
        oid: 987,
        assetIndex: 1,
        side: "sell",
        limitPx: "3200",
        sz: "0.25",
        origSz: "0.25",
        timestamp: 1710000001000,
        cancelAction: { type: "cancel", cancels: [{ a: 1, o: 987 }] },
      }],
    });

    const account = await loadReadOnlyHyperliquidAccount(user, MOCK_TRADING_SNAPSHOT);

    expect(account.valueKind).toBe("real");
    expect(account.equityUsd).toBe(1250.5);
    expect(account.positions).toHaveLength(1);
    expect(account.positions[0]).toMatchObject({ symbol: "ETH-USD", mode: "live", size: 0.5 });
    expect(account.positions.some((position) => position.mode === "paper")).toBe(false);
    expect(account.fills[0]).toMatchObject({ symbol: "ETH-USD", mode: "live", feeUsd: 0.8 });
    expect(account.openOrders[0]).toMatchObject({
      oid: 987,
      assetIndex: 1,
      mode: "live",
      cancelAction: { type: "cancel", cancels: [{ a: 1, o: 987 }] },
    });
  });

  it("marks connected wallet account state unavailable instead of simulated when account fetch fails", async () => {
    const user = "0x1234567890abcdef1234567890abcdef12345678";
    vi.spyOn(api, "balance").mockRejectedValue(new Error("account read failed"));
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));

    const result = await loadTradingSnapshot("BTC", { accountAddress: user });

    expect(result.snapshot.account.valueKind).toBe("unavailable");
    expect(result.snapshot.account.sourceLabel).toBe("Read-only Hyperliquid account unavailable");
    expect(result.snapshot.account.liveAccountDataUnavailable).toBe(true);
    expect(result.snapshot.account.positions).toEqual([]);
    expect(result.snapshot.account.fills).toEqual([]);
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

  it("does not seed successful live market snapshots with mock BTC recent trades", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/markets")) {
        return new Response(JSON.stringify({
          perps: [{ name: "HYPE", szDecimals: 2, maxLeverage: 5, assetIndex: 110 }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/marketStats")) {
        return new Response(JSON.stringify({
          perps: [{
            assetIndex: 110,
            name: "HYPE",
            markPx: "37.5",
            midPx: "37.49",
            prevDayPx: "36",
            dayNtlVlm: "1000000",
            openInterest: "20000",
            funding: "0.0001",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/l2Book")) {
        return new Response(JSON.stringify({
          levels: [
            [{ px: "37.48", sz: "12" }],
            [{ px: "37.52", sz: "8" }],
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/agent-trade/paper-account")) {
        return new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await loadTradingSnapshot("HYPE");

    expect(result.resolvedSymbol).toBe("HYPE");
    expect(result.snapshot.market.base).toBe("HYPE");
    expect(result.snapshot.recentTrades).toEqual([]);
  });

  it("clears prior-market book and trades immediately when switching to HYPE, ETH, or SOL", () => {
    const current = {
      ...MOCK_TRADING_SNAPSHOT,
      recentTrades: [
        { id: "BTC:1", side: "buy" as const, price: 100_000, size: 0.1, timestamp: 1 },
      ],
    };

    for (const market of selectorMarkets().filter((item) => ["HYPE", "ETH", "SOL"].includes(item.symbol))) {
      const reset = buildSwitchingMarketSnapshot({ current, market });

      expect(reset.market.base).toBe(market.symbol);
      expect(reset.orderBook).toEqual({ asks: [], bids: [] });
      expect(reset.recentTrades).toEqual([]);
      expect(reset.market.symbol).toBe(`${market.symbol}-USD`);
    }
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

  it("normalizes and applies active asset context updates from Hyperliquid WS", () => {
    const [event] = normalizeTerminalWsMessage({
      selectedCoin: "BTC",
      interval: "15m",
      now: 1710000000000,
      message: {
        channel: "activeAssetCtx",
        data: {
          coin: "BTC",
          ctx: {
            markPx: "101000",
            midPx: "100990",
            oraclePx: "100980",
            prevDayPx: "100000",
            dayNtlVlm: "2000000000",
            openInterest: "12000",
            funding: "0.00012",
          },
        },
      },
    });

    const patched = applyTerminalStreamEvent(MOCK_TRADING_SNAPSHOT, event);

    expect(event.type).toBe("activeAssetCtx");
    expect(patched.asOf).toBe(1710000000000);
    expect(patched.market.markPrice).toBe(101000);
    expect(patched.market.oraclePrice).toBe(100980);
    expect(patched.market.volume24hUsd).toBe(2_000_000_000);
    expect(patched.market.openInterestUsd).toBe(1_212_000_000);
    expect(patched.market.fundingRatePct).toBe(0.012);
  });

  it("replaces order book levels from Hyperliquid WS l2Book messages", () => {
    const [event] = normalizeTerminalWsMessage({
      selectedCoin: "BTC",
      interval: "15m",
      now: 1710000000000,
      message: {
        channel: "l2Book",
        data: {
          coin: "BTC",
          levels: [
            [{ px: "100000", sz: "1.25" }],
            [{ px: "100010", sz: "2.5" }],
          ],
        },
      },
    });

    const patched = applyTerminalStreamEvent(MOCK_TRADING_SNAPSHOT, event);

    expect(event.type).toBe("l2Book");
    expect(patched.orderBook.bids).toEqual([{ price: 100000, size: 1.25 }]);
    expect(patched.orderBook.asks).toEqual([{ price: 100010, size: 2.5 }]);
    expect(patched.market.liquidityUsd).toBeCloseTo(375025);
  });

  it("dedupes and prepends recent WS trades", () => {
    const merged = mergeRecentTrades(
      [{ id: "BTC:10:1", side: "buy", price: 100, size: 1, timestamp: 10 }],
      [
        { id: "BTC:10:1", side: "buy", price: 100, size: 1, timestamp: 10 },
        { id: "BTC:20:2", side: "sell", price: 101, size: 2, timestamp: 20 },
      ],
    );

    expect(merged).toEqual([
      { id: "BTC:20:2", side: "sell", price: 101, size: 2, timestamp: 20 },
      { id: "BTC:10:1", side: "buy", price: 100, size: 1, timestamp: 10 },
    ]);

    const [event] = normalizeTerminalWsMessage({
      selectedCoin: "BTC",
      interval: "15m",
      message: {
        channel: "trades",
        data: [
          { coin: "BTC", side: "B", px: "100500", sz: "0.05", time: 1710000000000, tid: 123 },
          { coin: "ETH", side: "A", px: "3000", sz: "1", time: 1710000000001 },
        ],
      },
    });
    expect(event).toMatchObject({
      type: "trades",
      trades: [{ id: "BTC:1710000000000:123", side: "buy", price: 100500, size: 0.05, timestamp: 1710000000000 }],
    });
  });

  it("drops BTC trades when the selected stream coin is HYPE, ETH, or SOL", () => {
    for (const selectedCoin of ["HYPE", "ETH", "SOL"]) {
      const events = normalizeTerminalWsMessage({
        selectedCoin,
        interval: "15m",
        message: {
          channel: "trades",
          data: [
            { coin: "BTC", side: "B", px: "100500", sz: "0.05", time: 1710000000000, tid: 1 },
            { coin: selectedCoin, side: "A", px: "37.50", sz: "10", time: 1710000000001, tid: 2 },
          ],
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "trades",
        coin: selectedCoin,
        trades: [{ id: `${selectedCoin}:1710000000001:2`, side: "sell", price: 37.5, size: 10 }],
      });
    }
  });

  it("upserts WS candles by candle time", () => {
    const existing = [
      { time: 100, open: 1, high: 2, low: 1, close: 2, volume: 10 },
      { time: 200, open: 2, high: 3, low: 2, close: 3, volume: 20 },
    ];
    const incoming = [
      { time: 200, open: 2, high: 4, low: 2, close: 4, volume: 25 },
      { time: 300, open: 4, high: 5, low: 4, close: 5, volume: 30 },
    ];

    expect(upsertTerminalCandles(existing, incoming)).toEqual([
      { time: 100, open: 1, high: 2, low: 1, close: 2, volume: 10 },
      { time: 200, open: 2, high: 4, low: 2, close: 4, volume: 25 },
      { time: 300, open: 4, high: 5, low: 4, close: 5, volume: 30 },
    ]);

    const [event] = normalizeTerminalWsMessage({
      selectedCoin: "BTC",
      interval: "15m",
      now: 1710000900000,
      message: {
        channel: "candle",
        data: [{ s: "BTC", i: "15m", t: 1710000000000, o: "100", h: "110", l: "90", c: "105", v: "12" }],
      },
    });
    const chart = applyTerminalCandleEvent({
      interval: "15m",
      candles: existing,
      source: "synthetic",
      fetchedAt: 1,
      isFallback: true,
      error: "fallback",
    }, event, "15m");

    expect(chart).toMatchObject({ source: "hyperliquid", isFallback: false, fetchedAt: 1710000900000 });
    expect(chart.candles.at(-1)).toEqual({ time: 1710000000, open: 100, high: 110, low: 90, close: 105, volume: 12 });
  });

  it("updates the visible current candle from live price events between REST candle refreshes", () => {
    const chart = applyTerminalPriceToChart({
      interval: "15m",
      candles: [
        { time: 1710000000, open: 100, high: 105, low: 95, close: 101, volume: 10 },
      ],
      source: "hyperliquid",
      fetchedAt: 1710000000000,
      isFallback: false,
    }, {
      price: 107,
      timestamp: 1710000100000,
      receivedAt: 1710000101000,
    }, "15m");

    expect(chart.livePriceAt).toBe(1710000101000);
    expect(chart.candles.at(-1)).toMatchObject({
      time: 1710000000,
      high: 107,
      low: 95,
      close: 107,
    });
  });

  it("exposes compact terminal stream status labels", () => {
    expect(terminalStreamStatusLabel("live")).toBe("Live stream");
    expect(terminalStreamStatusLabel("rest_fallback")).toBe("REST fallback");
  });

  it("subscribes to HYPE using Hyperliquid's raw coin symbol", () => {
    expect(terminalMarketSubscriptions({ coin: "HYPE", interval: "15m" })).toEqual([
      { type: "activeAssetCtx", coin: "HYPE" },
      { type: "l2Book", coin: "HYPE", nSigFigs: 5, fast: true },
      { type: "trades", coin: "HYPE" },
      { type: "candle", coin: "HYPE", interval: "15m" },
    ]);
  });

  it("builds account WebSocket subscriptions only from a wallet address", () => {
    const user = "0x1234567890abcdef1234567890abcdef12345678";

    expect(terminalAccountSubscriptions({ user })).toEqual([
      { type: "clearinghouseState", user },
      { type: "openOrders", user },
      { type: "userFills", user },
      { type: "userEvents", user },
      { type: "orderUpdates", user },
    ]);
  });

  it("replaces live account and positions from clearinghouseState while preserving paper ledger rows", () => {
    const user = MOCK_TRADING_SNAPSHOT.account.address;
    const hybrid = mergePaperAccount({
      ...MOCK_TRADING_SNAPSHOT,
      account: {
        ...MOCK_TRADING_SNAPSHOT.account,
        address: user,
        valueKind: "real",
        liveAccountDataLoaded: true,
        positions: [{
          ...MOCK_TRADING_SNAPSHOT.account.positions[0],
          symbol: "ETH-USD",
          base: "ETH",
          mode: "live",
        }],
        openOrders: [],
        fills: [],
      },
    }, paperAccount);
    const [event] = normalizeTerminalWsMessage({
      selectedCoin: "BTC",
      interval: "15m",
      accountAddress: user,
      now: 1710000000000,
      message: {
        channel: "clearinghouseState",
        data: {
          user,
          marginSummary: {
            accountValue: "2000",
            totalMarginUsed: "300",
          },
          withdrawable: "1700",
          assetPositions: [{
            position: {
              coin: "HYPE",
              szi: "2.5",
              entryPx: "61.5",
              positionValue: "155",
              unrealizedPnl: "1.25",
              returnOnEquity: "0.008",
              liquidationPx: "45",
              leverage: { type: "isolated", value: 3 },
              marginUsed: "52",
            },
          }],
        },
      },
    });

    const patched = applyTerminalStreamEvent(hybrid, event);

    expect(event.type).toBe("clearinghouseState");
    expect(patched.account.valueKind).toBe("hybrid");
    expect(patched.account.liveAccountDataLoaded).toBe(true);
    expect(patched.account.positions[0]).toMatchObject({ mode: "paper", symbol: "BTC-USD" });
    expect(patched.account.positions[1]).toMatchObject({ mode: "live", symbol: "HYPE-USD", size: 2.5 });
    expect(patched.account.equityUsd).toBe(2000);
    expect(patched.account.marginUsedUsd).toBe(800);
    expect(patched.account.availableUsd).toBe(1200);
  });

  it("replaces live open orders from openOrders while preserving paper orders", () => {
    const user = MOCK_TRADING_SNAPSHOT.account.address;
    const paperOrderSnapshot = {
      ...MOCK_TRADING_SNAPSHOT,
      account: {
        ...MOCK_TRADING_SNAPSHOT.account,
        address: user,
        valueKind: "hybrid" as const,
        liveAccountDataLoaded: true,
        openOrders: [
          {
            symbol: "BTC-USD",
            mode: "paper" as const,
            side: "sell" as const,
            type: "limit" as const,
            price: 120_000,
            size: 0.01,
            reduceOnly: true,
            timestamp: 1,
          },
          {
            oid: 1,
            symbol: "ETH-USD",
            mode: "live" as const,
            side: "buy" as const,
            type: "limit" as const,
            price: 3000,
            size: 1,
            reduceOnly: false,
            timestamp: 2,
          },
        ],
      },
    };
    const [event] = normalizeTerminalWsMessage({
      selectedCoin: "BTC",
      interval: "15m",
      accountAddress: user,
      now: 1710000000000,
      message: {
        channel: "openOrders",
        data: {
          user,
          orders: [{ coin: "HYPE", oid: 77, side: "B", limitPx: "62.5", sz: "3", timestamp: 1710000000000 }],
        },
      },
    });

    const patched = applyTerminalStreamEvent(paperOrderSnapshot, event);

    expect(event.type).toBe("openOrders");
    expect(patched.account.openOrders).toHaveLength(2);
    expect(patched.account.openOrders[0]).toMatchObject({ mode: "paper", symbol: "BTC-USD" });
    expect(patched.account.openOrders[1]).toMatchObject({ mode: "live", symbol: "HYPE-USD", oid: 77 });
  });

  it("appends and dedupes live fills from userFills and userEvents without touching paper fills", () => {
    const user = MOCK_TRADING_SNAPSHOT.account.address;
    const hybrid = mergePaperAccount({
      ...MOCK_TRADING_SNAPSHOT,
      account: {
        ...MOCK_TRADING_SNAPSHOT.account,
        address: user,
        valueKind: "real",
        liveAccountDataLoaded: true,
        fills: [],
      },
    }, paperAccount);
    const fillMessage = {
      user,
      fills: [
        { coin: "HYPE", side: "B", px: "62.1", sz: "2", time: 1710000000000, oid: 10, tid: 999, fee: "0.01" },
      ],
    };
    const [snapshotEvent] = normalizeTerminalWsMessage({
      selectedCoin: "BTC",
      interval: "15m",
      accountAddress: user,
      now: 1710000001000,
      message: { channel: "userFills", data: { ...fillMessage, isSnapshot: true } },
    });
    const afterSnapshot = applyTerminalStreamEvent(hybrid, snapshotEvent);
    const [streamEvent] = normalizeTerminalWsMessage({
      selectedCoin: "BTC",
      interval: "15m",
      accountAddress: user,
      now: 1710000002000,
      message: { channel: "userEvents", data: fillMessage },
    });

    const patched = applyTerminalStreamEvent(afterSnapshot, streamEvent);

    expect(snapshotEvent.type).toBe("userFills");
    expect(streamEvent.type).toBe("userEvents");
    expect(patched.account.fills.filter((fill) => fill.mode === "paper")).toHaveLength(1);
    expect(patched.account.fills.filter((fill) => fill.mode === "live")).toHaveLength(1);
    expect(patched.account.fills[1]).toMatchObject({ symbol: "HYPE-USD", orderId: "HYPE:10:999" });
  });

  it("patches live order lifecycle from orderUpdates and non-user cancel events", () => {
    const user = MOCK_TRADING_SNAPSHOT.account.address;
    const withLiveOrder = {
      ...MOCK_TRADING_SNAPSHOT,
      account: {
        ...MOCK_TRADING_SNAPSHOT.account,
        address: user,
        valueKind: "real" as const,
        liveAccountDataLoaded: true,
        openOrders: [{
          oid: 77,
          symbol: "HYPE-USD",
          mode: "live" as const,
          side: "buy" as const,
          type: "limit" as const,
          price: 62.5,
          size: 3,
          reduceOnly: false,
          timestamp: 1710000000000,
        }],
      },
    };
    const [filledEvent] = normalizeTerminalWsMessage({
      selectedCoin: "BTC",
      interval: "15m",
      accountAddress: user,
      now: 1710000003000,
      message: {
        channel: "orderUpdates",
        data: [{
          status: "filled",
          statusTimestamp: 1710000003000,
          order: { coin: "HYPE", oid: 77, side: "B", limitPx: "62.5", sz: "3", timestamp: 1710000000000 },
        }],
      },
    });
    const afterFill = applyTerminalStreamEvent(withLiveOrder, filledEvent);

    expect(afterFill.account.openOrders).toEqual([]);

    const [cancelEvent] = normalizeTerminalWsMessage({
      selectedCoin: "BTC",
      interval: "15m",
      accountAddress: user,
      now: 1710000004000,
      message: {
        channel: "userEvents",
        data: { user, nonUserCancel: [{ coin: "HYPE", oid: 77 }] },
      },
    });
    const afterCancel = applyTerminalStreamEvent(withLiveOrder, cancelEvent);

    expect(filledEvent.type).toBe("orderUpdates");
    expect(cancelEvent.type).toBe("userEvents");
    expect(afterCancel.account.openOrders).toEqual([]);
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
    expect(staleMarket).toMatchObject({ state: "degraded", isDraftSafe: true });
    expect(staleMarket.label).toBe("Market data stale");
    expect(staleCandles).toMatchObject({ state: "degraded", label: "Candles stale", isDraftSafe: true });
    expect(staleAccount).toMatchObject({ state: "fresh", label: "Live market data", isDraftSafe: true });
    expect(staleAccount.accountFreshness).toMatchObject({
      state: "stale",
      warning: "Portfolio impact may use stale account values.",
    });
  });

  it("treats fallback candles, loading, and API outage as warnings instead of hard draft blockers", () => {
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

    expect(fallback).toMatchObject({ state: "degraded", isDraftSafe: true });
    expect(warming).toMatchObject({ state: "warming", label: "Refreshing...", isDraftSafe: true });
    expect(apiUnavailable).toMatchObject({ state: "apiUnavailable", label: "API unavailable", isDraftSafe: true });
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

  it("warns but still drafts typed long and short trades when market data is stale", async () => {
    const long = await runTypedPrompt("Should I long BTC here?", true);
    const short = await runTypedPrompt("Should I short BTC here?", true);

    expect(long.state).toBe("tradeProposal");
    expect(long.orderDraft).toMatchObject({ side: "long" });
    expect(long.riskNote).toContain("Market data may be delayed; confirm price in the ticket before submitting.");
    expect(short.state).toBe("tradeProposal");
    expect(short.orderDraft).toMatchObject({ side: "short" });
    expect(short.riskNote).toContain("Market data may be delayed; confirm price in the ticket before submitting.");
  });

  it("refuses trade drafts when there is no usable price", async () => {
    const response = await runTypedPrompt("Should I long BTC here?", false, undefined, { markPrice: 0 });

    expect(response.state).toBe("staleRefusal");
    expect(response.orderDraft).toBeUndefined();
    expect(response.thesis).toContain("without a usable market price");
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
    expect(ticketSourceDisplay(draft!)).toMatchObject({
      state: "agent",
      label: "From Agent",
    });

    const edited = applyManualDraftPatch(draft!, { sizeBtc: draft!.sizeBtc + 0.01 });
    expect(getTicketSource(edited)).toBe("manual");
    expect(ticketSourceDisplay(edited)).toMatchObject({
      state: "editedAfterAgent",
      label: "Edited after agent",
    });
  });

  it("maps agent provider state to terminal badge copy", () => {
    expect(agentProviderDisplay()).toMatchObject({
      state: "deterministic",
      label: "Deterministic",
    });
    expect(agentProviderDisplay({
      provider: {
        name: "openai",
        model: "gpt-test",
        deterministic: false,
        generatedAt: Date.now(),
      },
    })).toMatchObject({
      state: "liveModel",
      label: "OpenAI gpt-test",
    });
    expect(agentProviderDisplay({
      provider: {
        name: "deterministic",
        deterministic: true,
        generatedAt: Date.now(),
        fallbackReason: "OpenAI provider requested without OPENAI_API_KEY; using deterministic fallback.",
      },
    })).toMatchObject({
      state: "fallback",
      label: "Fallback",
      detail: expect.stringContaining("deterministic fallback"),
    });
  });

  it("summarizes the market, book, funding, trades, candles, and account context the agent read", () => {
    const items = agentDataReadSummary({
      snapshot: MOCK_TRADING_SNAPSHOT,
      eligibility: "restricted",
      agent: {
        id: "test",
        state: "answered",
        question: "read",
        thesis: "read",
        receipts: [],
        riskNote: "risk",
        whyWrong: "wrong",
        annotations: [],
      },
    });

    expect(items.map((item) => item.label)).toEqual(expect.arrayContaining([
      "Market",
      "Mark",
      "Book",
      "Funding",
      "Open interest",
      "Trades/candles",
      "Account",
      "Mode",
    ]));
    expect(items.find((item) => item.label === "Mode")?.value).toBe("Paper draft only");
  });

  it("keeps a local/staging validation checklist for Phase 4B agent paths", () => {
    expect(PHASE_4B_AGENT_VALIDATION_CHECKLIST).toEqual(expect.arrayContaining([
      "deterministic mode",
      "OpenAI disabled mode",
      "OpenAI enabled with mock/fake key failure",
      "OpenAI enabled with valid key if available",
      "malformed model output",
      "timeout/provider error",
      "no usable price",
      "restricted/paper user",
      "eligible/live user",
    ]));
  });

  it("builds structured agent input from terminal snapshot, order book, trades, candles, and freshness", () => {
    const chartData = buildFallbackTerminalChartData(MOCK_TRADING_SNAPSHOT.market, "15m", "test fallback");
    const freshness = getTerminalFreshness({
      now: MOCK_TRADING_SNAPSHOT.asOf + 5_000,
      marketAsOf: MOCK_TRADING_SNAPSHOT.asOf,
      candlesFetchedAt: chartData.fetchedAt,
      candlesFallback: chartData.isFallback,
      candlesError: chartData.error,
      accountUpdatedAt: MOCK_TRADING_SNAPSHOT.account.updatedAt,
      apiStatus: "ok",
    });

    const input = buildAgentInput({
      prompt: "Should I short BTC?",
      scenario: "short",
      snapshot: MOCK_TRADING_SNAPSHOT,
      chartData,
      freshness,
      mode: "paper",
      eligibilityState: "restricted",
      liveAllowed: false,
      paperAllowed: true,
    });

    expect(input.market).toMatchObject({
      symbol: "BTC-USD",
      base: "BTC",
      markPrice: MOCK_TRADING_SNAPSHOT.market.markPrice,
      oraclePrice: MOCK_TRADING_SNAPSHOT.market.oraclePrice,
      fundingRatePct: MOCK_TRADING_SNAPSHOT.market.fundingRatePct,
      openInterestUsd: MOCK_TRADING_SNAPSHOT.market.openInterestUsd,
    });
    expect(input.orderBook.bids[0]).toEqual(MOCK_TRADING_SNAPSHOT.orderBook.bids[0]);
    expect(input.orderBook.asks[0]).toEqual(MOCK_TRADING_SNAPSHOT.orderBook.asks[0]);
    expect(input.recentTrades).toHaveLength(MOCK_TRADING_SNAPSHOT.recentTrades.length);
    expect(input.candleSummary.count).toBeGreaterThan(0);
    expect(input.account.availableUsd).toBe(MOCK_TRADING_SNAPSHOT.account.availableUsd);
    expect(input.selectedPosition?.symbol).toBe("BTC-USD");
    expect(input.eligibility).toMatchObject({ state: "restricted", mode: "paper", liveAllowed: false, paperAllowed: true });
  });

  it("builds a prompt with market data, order book state, safety rules, and JSON output schema", () => {
    const input = buildAgentInput({
      prompt: "sell ETH",
      snapshot: MOCK_TRADING_SNAPSHOT,
      mode: "paper",
      eligibilityState: "restricted",
      liveAllowed: false,
    });

    const prompt = buildAgentPrompt(input);

    expect(prompt).toContain("Order book state");
    expect(prompt).toContain("Market snapshot");
    expect(prompt).toContain("user confirmation");
    expect(prompt).toContain("Restricted, unknown, loading, paper, or kill-switch users may draft paper orders only");
    expect(prompt).toContain('"responseType"');
    expect(prompt).toContain('"trade_proposal"');
  });

  it("deterministic provider returns valid structured analysis", async () => {
    vi.useFakeTimers();
    const service = new DeterministicAgentService();
    const input = buildAgentInput({
      prompt: "Should I long BTC?",
      scenario: "long",
      snapshot: MOCK_TRADING_SNAPSHOT,
      mode: "paper",
      eligibilityState: "restricted",
      liveAllowed: false,
    });
    const promise = service.analyzeMarket(input);
    await vi.advanceTimersByTimeAsync(700);
    const analysis = await promise;

    expect(analysis.responseType).toBe("trade_proposal");
    expect(analysis.side).toBe("long");
    expect(analysis.orderDraft).toMatchObject({ symbol: "BTC-USD", side: "long", fromAgent: true });
    expect(analysis.provider).toMatchObject({ name: "deterministic", deterministic: true });
  });

  it("keeps golden agent prompts schema-safe and draft-safe", async () => {
    vi.useFakeTimers();
    const service = new DeterministicAgentService();

    for (const fixture of AGENT_TRADE_GOLDEN_PROMPT_FIXTURES) {
      const input = buildAgentInput({
        prompt: fixture.prompt,
        snapshot: MOCK_TRADING_SNAPSHOT,
        mode: fixture.mode,
        eligibilityState: fixture.eligibilityState,
        liveAllowed: fixture.liveAllowed,
        paperAllowed: true,
      });
      const promise = service.analyzeMarket(input);
      await vi.advanceTimersByTimeAsync(700);
      const analysis = await promise;

      expect(parseAgentAnalysis(analysis), fixture.name).toBeTruthy();
      expect(analysis.responseType, fixture.name).toBe(fixture.responseType);
      expect(analysis.side, fixture.name).toBe(fixture.side);
      if (fixture.expectsDraft) {
        expect(analysis.orderDraft, fixture.name).toMatchObject({
          symbol: "BTC-USD",
          fromAgent: true,
        });
      } else {
        expect(analysis.orderDraft, fixture.name).toBeUndefined();
      }
    }
  });

  it("rejects invalid provider output safely without filling a malformed ticket", async () => {
    const invalidProvider: AgentProvider = {
      name: "deterministic",
      analyzeMarket: async () => ({
        responseType: "trade_proposal",
        summary: "bad",
        thesis: "bad",
        side: "long",
        confidence: 0.8,
        receipts: [],
        riskNote: "bad",
        whyWrong: "bad",
        warnings: [],
        provider: { name: "deterministic", deterministic: true, generatedAt: Date.now() },
      } as AgentAnalysis),
    };
    const service = new DeterministicAgentService(invalidProvider);

    const response = await service.runPrompt({
      prompt: "Should I long BTC?",
      snapshot: MOCK_TRADING_SNAPSHOT,
      isStale: false,
      mode: "paper",
    });

    expect(response.state).toBe("staleRefusal");
    expect(response.orderDraft).toBeUndefined();
    expect(response.thesis).toContain("could not validate");
  });

  it("allows restricted users to draft paper orders but not live orders", async () => {
    const paper = await runTypedPrompt("Should I short BTC?", false, undefined, {}, {
      mode: "paper",
      eligibilityState: "restricted",
      liveAllowed: false,
    });
    const live = await runTypedPrompt("Should I short BTC?", false, undefined, {}, {
      mode: "live",
      eligibilityState: "restricted",
      liveAllowed: false,
    });

    expect(paper.state).toBe("tradeProposal");
    expect(paper.orderDraft).toMatchObject({ side: "short" });
    expect(live.state).toBe("staleRefusal");
    expect(live.orderDraft).toBeUndefined();
    expect(live.thesis).toContain("live trading is not allowed");
  });

  it("allows live drafts only when live mode is explicitly allowed", async () => {
    const response = await runTypedPrompt("Should I short BTC?", false, undefined, {}, {
      mode: "live",
      eligibilityState: "liveEligible",
      liveAllowed: true,
    });

    expect(response.state).toBe("tradeProposal");
    expect(response.orderDraft).toMatchObject({ side: "short" });
    expect(response.thesis).toContain("controlled live short");
  });

  it("does not call exchange or any network endpoint from agent analysis", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await runTypedPrompt("Should I long BTC?");

    expect(response.state).toBe("tradeProposal");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

async function runTypedPrompt(
  prompt: string,
  isStale = false,
  accountFreshnessWarning?: string,
  marketPatch: Partial<typeof MOCK_TRADING_SNAPSHOT.market> = {},
  options: {
    mode?: "paper" | "live";
    eligibilityState?: "loading" | "liveEligible" | "restricted" | "unknown" | "paper" | "killSwitchDisabled";
    liveAllowed?: boolean;
  } = {},
) {
  vi.useFakeTimers();
  const service = new DeterministicAgentService();
  const snapshot = {
    ...MOCK_TRADING_SNAPSHOT,
    market: {
      ...MOCK_TRADING_SNAPSHOT.market,
      ...marketPatch,
      dataAgeSeconds: isStale ? 46 : (marketPatch.dataAgeSeconds ?? MOCK_TRADING_SNAPSHOT.market.dataAgeSeconds),
    },
  };
  const promise = service.runPrompt({
    prompt,
    snapshot,
    isStale,
    accountFreshnessWarning,
    mode: options.mode ?? "paper",
    eligibilityState: options.eligibilityState,
    liveAllowed: options.liveAllowed,
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
