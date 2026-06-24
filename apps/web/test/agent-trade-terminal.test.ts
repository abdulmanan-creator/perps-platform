import { afterEach, describe, expect, it, vi } from "vitest";

import { loadTradingSnapshot } from "../lib/agent-trade/data";
import { MOCK_TRADING_SNAPSHOT } from "../lib/agent-trade/mock-data";
import { mergePaperAccount } from "../lib/agent-trade/paper";
import {
  AGENT_PANEL_HEADING,
  getConfirmationAckCopy,
  getTerminalEligibilityStatus,
  getTicketSource,
  paperOrderEndpoint,
  paperOrderFailureMessage,
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
    expect(restricted.message).toBe("Live trading unavailable in this region. Paper trading remains available.");
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
    expect(merged.account.marginUsedUsd).toBe(MOCK_TRADING_SNAPSHOT.account.marginUsedUsd + 500);
  });

  it("provides portfolio-visible paper positions and exposure inputs", () => {
    const merged = mergePaperAccount(MOCK_TRADING_SNAPSHOT, paperAccount);
    const paperPositions = merged.account.positions.filter((position) => position.mode === "paper");

    expect(paperPositions).toHaveLength(1);
    expect(paperPositions[0].marginUsd).toBe(500);
    expect(merged.account.simulatedBalanceUsd).toBe(50_000);
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
});
