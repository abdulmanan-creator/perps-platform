import { describe, expect, it } from "vitest";

import { getFundingDisplay } from "../lib/agent-trade/funding";

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
});
