import { describe, expect, it } from "vitest";

import {
  AGENT_PANEL_HEADING,
  getConfirmationAckCopy,
  getTerminalEligibilityStatus,
  getTicketSource,
  paperOrderEndpoint,
  paperOrderFailureMessage,
} from "../lib/agent-trade/terminal";

describe("Agent.trade terminal product-loop helpers", () => {
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
});
