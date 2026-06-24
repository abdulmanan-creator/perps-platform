import type { EligibilityMode, OrderDraft } from "./types";

export type TicketSource = "manual" | "agent";

export const AGENT_PANEL_HEADING = "Ask Agent.trade";

export interface TerminalEligibilityStatus {
  visible: boolean;
  tone: "amber" | "red" | "blue";
  label: string;
  message: string;
}

export function getTicketSource(draft: Pick<OrderDraft, "fromAgent">): TicketSource {
  return draft.fromAgent ? "agent" : "manual";
}

export function applyManualDraftPatch(draft: OrderDraft, patch: Partial<OrderDraft>): OrderDraft {
  return { ...draft, ...patch, fromAgent: false };
}

export function getConfirmationAckCopy(source: TicketSource): string {
  if (source === "agent") {
    return "I understand this is a leveraged perpetual order. The agent drafted, but I am confirming.";
  }

  return "I understand this is a leveraged perpetual order. I am confirming this paper order.";
}

export function getTerminalEligibilityStatus(state: EligibilityMode): TerminalEligibilityStatus {
  switch (state) {
    case "unknown":
    case "loading":
      return {
        visible: true,
        tone: "amber",
        label: "Paper mode only",
        message: "Paper mode only. Live eligibility has not been confirmed.",
      };
    case "restricted":
      return {
        visible: true,
        tone: "red",
        label: "Live unavailable",
        message: "Live trading unavailable in this region. Paper trading remains available.",
      };
    case "killSwitchDisabled":
      return {
        visible: true,
        tone: "red",
        label: "Live disabled",
        message: "Live trading is disabled by the Agent.trade kill switch. Paper trading remains available.",
      };
    case "paper":
      return {
        visible: true,
        tone: "blue",
        label: "Paper mode",
        message: "Paper mode is active. Live trading is disabled until account readiness is complete.",
      };
    case "liveEligible":
    default:
      return {
        visible: false,
        tone: "blue",
        label: "Live eligible",
        message: "Live trading can be enabled after confirmation.",
      };
  }
}

export function paperOrderEndpoint(apiBaseUrl: string): string {
  return `${apiBaseUrl}/agent-trade/paper-orders`;
}

export function paperOrderFailureMessage(error: unknown, endpoint: string): string {
  if (error instanceof TypeError) {
    return `Paper order failed: API unavailable at ${endpoint}`;
  }
  if (error instanceof Error && error.message) {
    return `Paper order failed: ${error.message}`;
  }
  return `Paper order failed: API unavailable at ${endpoint}`;
}
