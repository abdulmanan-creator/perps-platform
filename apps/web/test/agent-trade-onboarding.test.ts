import { describe, expect, it } from "vitest";

import { getAccountReadinessDisplay, getLiveTradingReadiness } from "../lib/agent-trade/account-readiness";
import { getLegacyDepositPathUi, getWalletAddressCopyUi } from "../components/agent-trade/OnboardingClient";
import { normalizeEligibilityResponse } from "../lib/agent-trade/eligibility";
import { getFundingDisplay } from "../lib/agent-trade/funding";
import { formatWalletAddress, getEligibilityDisplay } from "../lib/agent-trade/onboarding";
import { getOnboardingReadiness, supportedSignInMethods } from "../lib/agent-trade/onboarding-readiness";
import type { EligibilityMode } from "../lib/agent-trade/types";

describe("Agent.trade onboarding helpers", () => {
  it("normalizes REGION_BLOCKED eligibility responses into restricted paper mode", async () => {
    const display = await normalizeEligibilityResponse(new Response(JSON.stringify({
      error: "REGION_BLOCKED",
      message: "This service is not available in your region.",
    }), { status: 451, headers: { "content-type": "application/json" } }));

    expect(display.state).toBe("restricted");
    expect(getEligibilityDisplay(display.state).paperAvailable).toBe(true);
    expect(getEligibilityDisplay(display.state).liveTradingEnabled).toBe(false);
  });

  it("normalizes unavailable eligibility responses into unknown paper mode", async () => {
    const display = await normalizeEligibilityResponse(new Response("unavailable", { status: 503 }));

    expect(display.state).toBe("unknown");
    expect(getEligibilityDisplay(display.state).paperAvailable).toBe(true);
    expect(getEligibilityDisplay(display.state).liveTradingEnabled).toBe(false);
  });

  it("preserves live eligible server eligibility responses", async () => {
    const display = await normalizeEligibilityResponse(new Response(JSON.stringify({
      state: "liveEligible",
      executionVenue: "hyperliquid-mainnet",
      mainnetExecutionEnabled: true,
      killSwitchEnabled: false,
      minOrderNotionalUsd: 10,
      orderNotionalCapUsd: 0,
      dailyNotionalCapUsd: 0,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    expect(display.state).toBe("liveEligible");
    expect(display.mainnetExecutionEnabled).toBe(true);
    expect(getEligibilityDisplay(display.state).liveTradingEnabled).toBe(true);
  });

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

  it("keeps onboarding wallet copy feedback honest and exposes the full manual address", () => {
    const address = "0x1234567890abcdef1234567890abcdef12345678";

    expect(getWalletAddressCopyUi({ walletAddress: address, copyState: "idle" })).toEqual({
      buttonLabel: "Copy",
    });
    expect(getWalletAddressCopyUi({ walletAddress: address, copyState: "copied" })).toEqual({
      buttonLabel: "Copied",
      helperText: "Address copied.",
    });
    expect(getWalletAddressCopyUi({ walletAddress: address, copyState: "manual" })).toEqual({
      buttonLabel: "Copy",
      helperText: "Clipboard unavailable. Select the full address below.",
      manualAddress: address,
    });
  });

  it("labels the legacy Bridge2 path as disabled when gasless deposit is active", () => {
    const copy = getLegacyDepositPathUi({
      gaslessEnabled: true,
      legacyAllowed: true,
      legacySummary: "Bridge2 compatibility path is enabled.",
    });

    expect(copy.disabled).toBe(true);
    expect(copy.href).toBeUndefined();
    expect(copy.title).toBe("Legacy deposit path disabled");
    expect(copy.summary).toContain("gasless Bridge2 permit deposit");
  });

  it("summarizes missing Privy env as local-dev paper readiness", () => {
    const funding = getFundingDisplay({
      eligibilityState: "liveEligible",
      hasPrivyEnv: false,
      walletConnected: false,
      providerEnabled: false,
      providerAvailable: false,
      providerConfigured: true,
    });
    const readiness = getOnboardingReadiness({
      hasPrivyEnv: false,
      wallet: { status: "local-dev", authStatus: "not-configured" },
      eligibilityState: "liveEligible",
      executionVenue: "hyperliquid-testnet",
      mainnetExecutionEnabled: false,
      killSwitchEnabled: false,
      funding,
    });

    expect(readiness.signInMethods.value).toBe("Local-dev paper only");
    expect(readiness.embeddedWallet.value).toBe("Privy env missing");
    expect(readiness.tradingMode.value).toBe("Testnet eligible");
    expect(readiness.funding.value).toBe("Provider not configured");
  });

  it("summarizes signed-in embedded wallet readiness without funding claims", () => {
    const funding = getFundingDisplay({
      eligibilityState: "liveEligible",
      hasPrivyEnv: true,
      walletConnected: true,
      providerEnabled: false,
      providerAvailable: true,
      providerConfigured: true,
    });
    const readiness = getOnboardingReadiness({
      hasPrivyEnv: true,
      wallet: {
        status: "connected",
        authStatus: "authenticated",
        address: "0x1234567890abcdef1234567890abcdef12345678",
        walletKind: "embedded",
        walletType: "privy",
      },
      eligibilityState: "liveEligible",
      executionVenue: "hyperliquid-testnet",
      mainnetExecutionEnabled: false,
      killSwitchEnabled: false,
      funding,
    });

    expect(readiness.signInMethods.value).toBe(supportedSignInMethods.join(", "));
    expect(readiness.embeddedWallet.value).toBe("Connected");
    expect(readiness.tradingMode.value).toBe("Testnet eligible");
    expect(readiness.funding.value).toBe("Provider configured, app hidden");
    expect(readiness.funding.ok).toBe(false);
  });

  it("summarizes restricted users as paper-only with funding disabled", () => {
    const funding = getFundingDisplay({
      eligibilityState: "restricted",
      hasPrivyEnv: true,
      walletConnected: true,
      providerEnabled: true,
      providerAvailable: true,
      providerConfigured: true,
    });
    const readiness = getOnboardingReadiness({
      hasPrivyEnv: true,
      wallet: {
        status: "connected",
        authStatus: "authenticated",
        address: "0x1234567890abcdef1234567890abcdef12345678",
        walletKind: "external",
      },
      eligibilityState: "restricted",
      executionVenue: "hyperliquid-testnet",
      mainnetExecutionEnabled: false,
      killSwitchEnabled: false,
      funding,
    });

    expect(readiness.eligibility.value).toBe("Restricted");
    expect(readiness.tradingMode.value).toBe("Paper available");
    expect(readiness.funding.ok).toBe(false);
    expect(readiness.funding.detail).toContain("restricted");
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
