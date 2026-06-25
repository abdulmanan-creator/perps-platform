import { describe, expect, it } from "vitest";

import { getAccountReadinessDisplay, getLiveTradingReadiness } from "../lib/agent-trade/account-readiness";
import { getFundingDisplay } from "../lib/agent-trade/funding";
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

  it("blocks testnet trading when Privy env is missing", () => {
    const readiness = getLiveTradingReadiness({
      wallet: { status: "local-dev", authStatus: "not-configured" },
      eligibilityState: "liveEligible",
      executionVenue: "hyperliquid-testnet",
      mainnetExecutionEnabled: false,
      killSwitchEnabled: false,
    });

    expect(readiness.allowed).toBe(false);
    expect(readiness.reason).toBe("privy_not_configured");
    expect(readiness.disabledReason).toContain("Sign-in is not configured");
  });

  it("blocks testnet trading until a configured Privy user signs in", () => {
    const readiness = getLiveTradingReadiness({
      wallet: { status: "not-connected", authStatus: "unauthenticated" },
      eligibilityState: "liveEligible",
      executionVenue: "hyperliquid-testnet",
      mainnetExecutionEnabled: false,
      killSwitchEnabled: false,
    });

    expect(readiness.allowed).toBe(false);
    expect(readiness.reason).toBe("not_authenticated");
    expect(readiness.disabledReason).toBe("Sign in to enable testnet trading.");
  });

  it("blocks authenticated users without a usable wallet", () => {
    const readiness = getLiveTradingReadiness({
      wallet: { status: "not-connected", authStatus: "authenticated" },
      eligibilityState: "liveEligible",
      executionVenue: "hyperliquid-testnet",
      mainnetExecutionEnabled: false,
      killSwitchEnabled: false,
    });

    expect(readiness.allowed).toBe(false);
    expect(readiness.reason).toBe("wallet_missing");
    expect(readiness.disabledReason).toContain("Wallet required.");
  });

  it("blocks authenticated wallets while eligibility is unknown", () => {
    const readiness = getLiveTradingReadiness({
      wallet: {
        status: "connected",
        authStatus: "authenticated",
        address: "0x1234567890abcdef1234567890abcdef12345678",
        walletKind: "embedded",
      },
      eligibilityState: "unknown",
      executionVenue: "hyperliquid-testnet",
      mainnetExecutionEnabled: false,
      killSwitchEnabled: false,
    });

    expect(readiness.allowed).toBe(false);
    expect(readiness.reason).toBe("eligibility_unknown");
    expect(readiness.disabledReason).toBe("Eligibility not confirmed.");
  });

  it("allows authenticated wallet plus live eligibility on testnet", () => {
    const readiness = getLiveTradingReadiness({
      wallet: {
        status: "connected",
        authStatus: "authenticated",
        address: "0x1234567890abcdef1234567890abcdef12345678",
        walletKind: "external",
      },
      eligibilityState: "liveEligible",
      executionVenue: "hyperliquid-testnet",
      mainnetExecutionEnabled: false,
      killSwitchEnabled: false,
      accountValueKind: "real",
      liveAccountDataLoaded: true,
      liveAccountDataUnavailable: false,
    });

    expect(readiness.allowed).toBe(true);
    expect(readiness.reason).toBe("ready");
    expect(readiness.summary).toContain("testnet execution policy");
  });

  it("blocks live trading when read-only Hyperliquid account state is unavailable", () => {
    const readiness = getLiveTradingReadiness({
      wallet: {
        status: "connected",
        authStatus: "authenticated",
        address: "0x1234567890abcdef1234567890abcdef12345678",
        walletKind: "embedded",
      },
      eligibilityState: "liveEligible",
      executionVenue: "hyperliquid-mainnet",
      mainnetExecutionEnabled: true,
      killSwitchEnabled: false,
      accountValueKind: "unavailable",
      liveAccountDataLoaded: false,
      liveAccountDataUnavailable: true,
    });

    expect(readiness.allowed).toBe(false);
    expect(readiness.reason).toBe("account_unavailable");
    expect(readiness.disabledReason).toBe("Hyperliquid account state unavailable. Refresh before live trading.");
  });

  it("blocks restricted and kill-switch states even with an authenticated wallet", () => {
    const wallet = {
      status: "connected" as const,
      authStatus: "authenticated" as const,
      address: "0x1234567890abcdef1234567890abcdef12345678",
    };
    const restricted = getLiveTradingReadiness({
      wallet,
      eligibilityState: "restricted",
      executionVenue: "hyperliquid-testnet",
      mainnetExecutionEnabled: false,
      killSwitchEnabled: false,
    });
    const killSwitch = getLiveTradingReadiness({
      wallet,
      eligibilityState: "liveEligible",
      executionVenue: "hyperliquid-testnet",
      mainnetExecutionEnabled: false,
      killSwitchEnabled: true,
    });

    expect(restricted.allowed).toBe(false);
    expect(restricted.reason).toBe("restricted");
    expect(killSwitch.allowed).toBe(false);
    expect(killSwitch.reason).toBe("kill_switch");
  });

  it("keeps funding disabled when the product flag is off", () => {
    const funding = getFundingDisplay({
      eligibilityState: "liveEligible",
      hasPrivyEnv: true,
      walletConnected: true,
      providerEnabled: false,
      providerAvailable: true,
    });

    expect(funding.liveFundingEnabled).toBe(false);
    expect(funding.primaryCtaKind).toBe("paper");
    expect(funding.summary).toContain("not enabled");
  });
});
