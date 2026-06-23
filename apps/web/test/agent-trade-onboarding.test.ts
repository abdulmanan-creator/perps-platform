import { describe, expect, it } from "vitest";

import { formatWalletAddress, getEligibilityDisplay } from "../lib/agent-trade/onboarding";
import type { EligibilityMode } from "../lib/agent-trade/types";

describe("Agent.trade onboarding helpers", () => {
  it("keeps unknown, restricted, and kill switch states fail-closed for live CTAs", () => {
    for (const state of ["unknown", "restricted", "killSwitchDisabled"] satisfies EligibilityMode[]) {
      const display = getEligibilityDisplay(state);
      expect(display.liveTradingEnabled).toBe(false);
      expect(display.liveFundingEnabled).toBe(false);
      expect(display.paperAvailable).toBe(true);
    }
  });

  it("keeps loading fail-closed while eligibility is pending", () => {
    const display = getEligibilityDisplay("loading");
    expect(display.liveTradingEnabled).toBe(false);
    expect(display.liveFundingEnabled).toBe(false);
    expect(display.paperAvailable).toBe(true);
  });

  it("enables live CTAs only for liveEligible", () => {
    const display = getEligibilityDisplay("liveEligible");
    expect(display.liveTradingEnabled).toBe(true);
    expect(display.liveFundingEnabled).toBe(true);
    expect(display.paperAvailable).toBe(true);
  });

  it("preserves paper CTA availability for paper mode", () => {
    const display = getEligibilityDisplay("paper");
    expect(display.liveTradingEnabled).toBe(false);
    expect(display.liveFundingEnabled).toBe(false);
    expect(display.paperAvailable).toBe(true);
  });

  it("formats wallet addresses for display", () => {
    expect(formatWalletAddress()).toBe("Not connected");
    expect(formatWalletAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234...5678");
  });
});
