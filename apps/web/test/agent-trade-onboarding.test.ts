import { describe, expect, it } from "vitest";

import { getAccountReadinessDisplay } from "../lib/agent-trade/account-readiness";
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

  it("labels disconnected users as paper/simulated account users", () => {
    const display = getAccountReadinessDisplay({
      wallet: { status: "not-connected" },
      eligibilityState: "unknown",
      accountValueKind: "paper",
    });

    expect(display.mode).toBe("disconnected_paper");
    expect(display.liveTradingEnabled).toBe(false);
    expect(display.paperTradingEnabled).toBe(true);
    expect(display.accountValueLabel).toBe("Simulated account values");
    expect(display.summary).toContain("account values are simulated");
  });

  it("keeps restricted and unknown connected wallets live-disabled while preserving paper", () => {
    for (const state of ["unknown", "restricted"] satisfies EligibilityMode[]) {
      const display = getAccountReadinessDisplay({
        wallet: { status: "connected", address: "0x1234567890abcdef1234567890abcdef12345678" },
        eligibilityState: state,
        accountValueKind: "real",
        liveAccountDataLoaded: true,
      });

      expect(display.liveTradingEnabled).toBe(false);
      expect(display.paperTradingEnabled).toBe(true);
      expect(display.accountValueLabel).toBe("Read-only Hyperliquid account");
    }
  });

  it("marks connected live-eligible accounts as real only after read-only data loads", () => {
    const noAccountData = getAccountReadinessDisplay({
      wallet: { status: "connected", address: "0x1234567890abcdef1234567890abcdef12345678" },
      eligibilityState: "liveEligible",
      accountValueKind: "paper",
      liveAccountDataLoaded: false,
    });
    const withAccountData = getAccountReadinessDisplay({
      wallet: { status: "connected", address: "0x1234567890abcdef1234567890abcdef12345678" },
      eligibilityState: "liveEligible",
      accountValueKind: "real",
      liveAccountDataLoaded: true,
    });

    expect(noAccountData.mode).toBe("connected_testnet_ready");
    expect(noAccountData.accountValueLabel).toBe("Simulated account values");
    expect(withAccountData.mode).toBe("connected_live_eligible");
    expect(withAccountData.accountValueLabel).toBe("Read-only Hyperliquid account");
  });

  it("fails gracefully to paper labeling when read-only account data is unavailable", () => {
    const display = getAccountReadinessDisplay({
      wallet: { status: "connected", address: "0x1234567890abcdef1234567890abcdef12345678" },
      eligibilityState: "liveEligible",
      liveAccountDataUnavailable: true,
    });

    expect(display.mode).toBe("api_unavailable_paper");
    expect(display.liveTradingEnabled).toBe(false);
    expect(display.paperTradingEnabled).toBe(true);
    expect(display.accountValueLabel).toBe("Account data unavailable");
  });
});
