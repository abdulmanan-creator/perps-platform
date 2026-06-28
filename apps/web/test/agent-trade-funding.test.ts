import { describe, expect, it } from "vitest";

import { getFundingDisplay, getFundingMethodDisplays, getFundingMethodGroups } from "../lib/agent-trade/funding";
import {
  HL_BRIDGE_ARBITRUM,
  USDC_ARBITRUM,
  buildUsdcPermitTypedData,
  getGaslessDepositReadiness,
  getGaslessDepositUi,
  validateGaslessDepositAmount,
} from "../lib/agent-trade/gasless-deposit";

describe("Agent.trade funding helpers", () => {
  it("keeps missing Privy env in local-dev paper mode", () => {
    const display = getFundingDisplay({
      eligibilityState: "liveEligible",
      hasPrivyEnv: false,
      walletConnected: false,
      providerEnabled: false,
      providerAvailable: false,
    });

    expect(display.status).toBe("unavailable_missing_privy_env");
    expect(display.liveFundingEnabled).toBe(false);
    expect(display.primaryCtaKind).toBe("paper");
    expect(display.paperAvailable).toBe(true);
  });

  it("blocks restricted and unknown users from provider funding", () => {
    for (const eligibilityState of ["restricted", "unknown"] as const) {
      const display = getFundingDisplay({
        eligibilityState,
        hasPrivyEnv: true,
        walletConnected: true,
        providerEnabled: true,
        providerAvailable: true,
      });

      expect(display.liveFundingEnabled).toBe(false);
      expect(display.primaryCtaKind).toBe("paper");
      expect(display.paperAvailable).toBe(true);
    }
  });

  it("requires a wallet before provider funding", () => {
    const display = getFundingDisplay({
      eligibilityState: "liveEligible",
      hasPrivyEnv: true,
      walletConnected: false,
      providerEnabled: true,
      providerAvailable: true,
    });

    expect(display.status).toBe("wallet_not_connected");
    expect(display.liveFundingEnabled).toBe(false);
    expect(display.primaryCtaKind).toBe("connect_wallet");
  });

  it("does not treat the SDK hook as provider-ready when product funding is disabled", () => {
    const display = getFundingDisplay({
      eligibilityState: "liveEligible",
      hasPrivyEnv: true,
      walletConnected: true,
      providerEnabled: false,
      providerAvailable: true,
    });

    expect(display.status).toBe("testnet_guidance");
    expect(display.liveFundingEnabled).toBe(false);
    expect(display.primaryCtaKind).toBe("paper");
    expect(display.summary).toContain("not enabled");
  });

  it("distinguishes dashboard-configured providers from exposed app funding", () => {
    const display = getFundingDisplay({
      eligibilityState: "liveEligible",
      hasPrivyEnv: true,
      walletConnected: true,
      providerEnabled: false,
      providerAvailable: true,
      providerConfigured: true,
    });

    expect(display.status).toBe("provider_configured_not_exposed");
    expect(display.liveFundingEnabled).toBe(false);
    expect(display.primaryCtaKind).toBe("paper");
    expect(display.summary).toContain("hidden until the product flag");
  });

  it("enables provider CTA only when eligible, connected, product-enabled, and provider API is available", () => {
    const display = getFundingDisplay({
      eligibilityState: "liveEligible",
      hasPrivyEnv: true,
      walletConnected: true,
      providerEnabled: true,
      providerAvailable: true,
    });

    expect(display.status).toBe("provider_ready");
    expect(display.liveFundingEnabled).toBe(true);
    expect(display.primaryCtaKind).toBe("open_provider");
    expect(display.primaryCtaEnabled).toBe(true);
  });

  it("falls back to testnet guidance when the provider API is unavailable", () => {
    const display = getFundingDisplay({
      eligibilityState: "liveEligible",
      hasPrivyEnv: true,
      walletConnected: true,
      providerEnabled: true,
      providerAvailable: false,
    });

    expect(display.status).toBe("testnet_guidance");
    expect(display.liveFundingEnabled).toBe(false);
    expect(display.primaryCtaKind).toBe("paper");
  });

  it("builds funding method cards without unsupported provider claims", () => {
    const methods = getFundingMethodDisplays({
      eligibilityState: "liveEligible",
      hasPrivyEnv: true,
      walletConnected: true,
      providerEnabled: false,
      providerAvailable: true,
      providerConfigured: true,
      depositAddressConfigured: true,
    });
    const copy = methods
      .flatMap((method) => [method.title, method.body, method.status, method.detail])
      .join(" ");

    expect(copy).toContain("Dashboard configured; app hidden");
    expect(copy).toContain("Hidden by feature flag");
    expect(copy).not.toMatch(/\b(MoonPay|Stripe|ACH|Apple Pay|Google Pay|bank deposit)\b/u);
  });

  it("shows configured cash funding only when the fiat on-ramp flag and provider API are available", () => {
    const methods = getFundingMethodGroups({
      eligibilityState: "liveEligible",
      hasPrivyEnv: true,
      walletConnected: true,
      providerEnabled: true,
      providerAvailable: true,
      providerConfigured: true,
      fiatOnrampEnabled: true,
    });
    const cash = methods.cash.find((method) => method.title === "Cash");

    expect(cash?.enabled).toBe(true);
    expect(cash?.status).toBe("Privy provider available");
    expect(cash?.body).toContain("Privy's configured funding flow");
  });

  it("keeps bank transfer and deposit address hidden without explicit verified configuration", () => {
    const methods = getFundingMethodDisplays({
      eligibilityState: "liveEligible",
      hasPrivyEnv: true,
      walletConnected: true,
      providerEnabled: true,
      providerAvailable: true,
      bankDepositEnabled: true,
      bankDepositConfigured: false,
      cryptoDepositAddressEnabled: true,
      depositAddressConfigured: false,
    });
    const bank = methods.find((method) => method.title === "Bank transfer");
    const depositAddress = methods.find((method) => method.title === "Deposit address");

    expect(bank?.enabled).toBe(false);
    expect(bank?.status).toContain("Hidden");
    expect(depositAddress?.enabled).toBe(false);
    expect(depositAddress?.status).toBe("Hidden");
  });

  it("does not enable live funding while the provider is opening or errored", () => {
    const opening = getFundingDisplay({
      eligibilityState: "liveEligible",
      hasPrivyEnv: true,
      walletConnected: true,
      providerEnabled: true,
      providerAvailable: true,
      providerOpening: true,
    });
    const errored = getFundingDisplay({
      eligibilityState: "liveEligible",
      hasPrivyEnv: true,
      walletConnected: true,
      providerEnabled: true,
      providerAvailable: true,
      providerError: "Provider rejected this region.",
    });

    expect(opening.status).toBe("provider_opening");
    expect(opening.liveFundingEnabled).toBe(false);
    expect(errored.status).toBe("provider_error");
    expect(errored.liveFundingEnabled).toBe(false);
    expect(errored.summary).toContain("Provider rejected");
  });

  it("builds the native Arbitrum USDC EIP-2612 permit payload", () => {
    const typedData = buildUsdcPermitTypedData({
      owner: "0x1234567890abcdef1234567890abcdef12345678",
      spender: HL_BRIDGE_ARBITRUM,
      token: USDC_ARBITRUM,
      value: 5_000_000n,
      nonce: 7n,
      deadline: 1_700_000_000n,
    });

    expect(typedData.domain).toEqual({
      name: "USD Coin",
      version: "2",
      chainId: 42161,
      verifyingContract: USDC_ARBITRUM,
    });
    expect(typedData.message).toMatchObject({
      spender: HL_BRIDGE_ARBITRUM,
      value: 5_000_000n,
      nonce: 7n,
      deadline: 1_700_000_000n,
    });
  });

  it("blocks a 1 USDC Hyperliquid deposit with clear minimum copy", () => {
    const validation = validateGaslessDepositAmount({
      amount: "1",
      walletUsdcUnits: 1_000_000n,
    });

    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.message).toContain("Hyperliquid minimum deposit is 5 USDC");
      expect(validation.message).toContain("4 more USDC");
    }
  });

  it("labels wallet-funded-not-Hyperliquid-funded state without claiming provider support", () => {
    const ui = getGaslessDepositUi({
      frontendEnabled: true,
      backendStatus: {
        enabled: true,
        reason: "Gasless deposit enabled.",
        bridge: HL_BRIDGE_ARBITRUM,
        token: USDC_ARBITRUM,
        minDepositUsdc: 5,
        chainId: 42161,
        eligibilityState: "liveEligible",
        liveEligible: true,
        mainnetExecutionEnabled: true,
        killSwitchEnabled: false,
        minOrderNotionalUsd: 10,
      },
      walletConnected: true,
      eligibilityState: "liveEligible",
      walletUsdcUnits: 6_000_000n,
      hlAccountValueUsd: 0,
      amount: "5",
    });

    expect(ui.title).toBe("Wallet funded, Hyperliquid not funded");
    expect(ui.summary.toLowerCase()).toContain("native arbitrum usdc");
    expect(ui.ctaEnabled).toBe(true);
    expect(`${ui.title} ${ui.summary}`).not.toMatch(/\b(Base deposit|ACH|Apple Pay|Google Pay)\b/u);
  });

  it("prioritizes Hyperliquid deposit for live eligible wallets with USDC and low HL balance", () => {
    const readiness = getGaslessDepositReadiness({
      frontendEnabled: true,
      backendStatus: {
        enabled: true,
        reason: "Gasless deposit enabled.",
        bridge: HL_BRIDGE_ARBITRUM,
        token: USDC_ARBITRUM,
        minDepositUsdc: 5,
        chainId: 42161,
        eligibilityState: "liveEligible",
        liveEligible: true,
        mainnetExecutionEnabled: true,
        killSwitchEnabled: false,
        minOrderNotionalUsd: 10,
      },
      walletConnected: true,
      eligibilityState: "liveEligible",
      walletUsdcUnits: 12_000_000n,
      hlAccountValueUsd: 0,
      amount: "5",
    });

    expect(readiness.action).toBe("deposit_hyperliquid");
    expect(readiness.primaryLabel).toBe("Deposit USDC into Hyperliquid");
    expect(readiness.ctaEnabled).toBe(true);
  });

  it("prioritizes mainnet ticket only after Hyperliquid balance reaches order minimum", () => {
    const readiness = getGaslessDepositReadiness({
      frontendEnabled: true,
      backendStatus: {
        enabled: true,
        reason: "Gasless deposit enabled.",
        bridge: HL_BRIDGE_ARBITRUM,
        token: USDC_ARBITRUM,
        minDepositUsdc: 5,
        chainId: 42161,
        eligibilityState: "liveEligible",
        liveEligible: true,
        mainnetExecutionEnabled: true,
        killSwitchEnabled: false,
        minOrderNotionalUsd: 10,
      },
      walletConnected: true,
      eligibilityState: "liveEligible",
      walletUsdcUnits: 12_000_000n,
      hlAccountValueUsd: 10,
      amount: "5",
    });

    expect(readiness.action).toBe("open_ticket");
    expect(readiness.primaryLabel).toBe("Start trading");
    expect(readiness.readyToTrade).toBe(true);
  });

  it("keeps restricted users paper-first with no gasless CTA", () => {
    const readiness = getGaslessDepositReadiness({
      frontendEnabled: true,
      backendStatus: {
        enabled: true,
        reason: "Gasless deposit enabled.",
        bridge: HL_BRIDGE_ARBITRUM,
        token: USDC_ARBITRUM,
        minDepositUsdc: 5,
        chainId: 42161,
        eligibilityState: "restricted",
        liveEligible: false,
        mainnetExecutionEnabled: true,
        killSwitchEnabled: false,
        minOrderNotionalUsd: 10,
      },
      walletConnected: true,
      eligibilityState: "restricted",
      walletUsdcUnits: 12_000_000n,
      hlAccountValueUsd: 0,
      amount: "5",
    });

    expect(readiness.action).toBe("paper");
    expect(readiness.ctaEnabled).toBe(false);
    expect(readiness.ctaDisabledReason).toContain("Live eligibility required");
  });

  it("shows an explicit balance read failure instead of silently treating it as 0", () => {
    const ui = getGaslessDepositUi({
      frontendEnabled: true,
      backendStatus: {
        enabled: true,
        reason: "Gasless deposit enabled.",
        bridge: HL_BRIDGE_ARBITRUM,
        token: USDC_ARBITRUM,
        minDepositUsdc: 5,
        chainId: 42161,
        eligibilityState: "liveEligible",
        liveEligible: true,
        mainnetExecutionEnabled: true,
        killSwitchEnabled: false,
        minOrderNotionalUsd: 10,
      },
      walletConnected: true,
      eligibilityState: "liveEligible",
      walletUsdcUnits: 0n,
      walletUsdcReadError: true,
      hlAccountValueUsd: 0,
      amount: "5",
    });

    expect(ui.title).toBe("Wallet balance unavailable");
    expect(ui.amountError).toContain("balance read failed");
    expect(ui.ctaEnabled).toBe(false);
  });

  it("marks the account ready only after Hyperliquid balance reaches order minimum", () => {
    const ui = getGaslessDepositUi({
      frontendEnabled: true,
      backendStatus: {
        enabled: true,
        reason: "Gasless deposit enabled.",
        bridge: HL_BRIDGE_ARBITRUM,
        token: USDC_ARBITRUM,
        minDepositUsdc: 5,
        chainId: 42161,
        eligibilityState: "liveEligible",
        liveEligible: true,
        mainnetExecutionEnabled: true,
        killSwitchEnabled: false,
        minOrderNotionalUsd: 10,
      },
      walletConnected: true,
      eligibilityState: "liveEligible",
      walletUsdcUnits: 20_000_000n,
      hlAccountValueUsd: 10,
      amount: "5",
    });

    expect(ui.title).toBe("Ready to trade");
    expect(ui.readyToTrade).toBe(true);
  });

  it("labels Base-USDC-only wallets without claiming bridge support", () => {
    const ui = getGaslessDepositUi({
      frontendEnabled: true,
      backendStatus: {
        enabled: true,
        reason: "Gasless deposit enabled.",
        bridge: HL_BRIDGE_ARBITRUM,
        token: USDC_ARBITRUM,
        minDepositUsdc: 5,
        chainId: 42161,
        eligibilityState: "liveEligible",
        liveEligible: true,
        mainnetExecutionEnabled: true,
        killSwitchEnabled: false,
        minOrderNotionalUsd: 10,
      },
      walletConnected: true,
      eligibilityState: "liveEligible",
      walletUsdcUnits: 0n,
      baseUsdcUnits: 8_000_000n,
      hlAccountValueUsd: 0,
      amount: "5",
    });

    expect(ui.summary).toContain("Base USDC detected");
    expect(ui.summary).toContain("does not yet bridge Base deposits");
    expect(ui.ctaEnabled).toBe(false);
  });
});
