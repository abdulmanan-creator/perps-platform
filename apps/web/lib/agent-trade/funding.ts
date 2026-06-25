import { getEligibilityDisplay } from "./onboarding";
import type { EligibilityMode } from "./types";

export type FundingStatus =
  | "unavailable_missing_privy_env"
  | "unavailable_restricted"
  | "unavailable_unknown_eligibility"
  | "paper_only"
  | "testnet_guidance"
  | "wallet_not_connected"
  | "provider_configured_not_exposed"
  | "provider_ready"
  | "provider_opening"
  | "provider_error";

export type FundingCtaKind = "paper" | "connect_wallet" | "open_provider" | "none";

export interface FundingStateInput {
  eligibilityState: EligibilityMode;
  hasPrivyEnv: boolean;
  walletConnected: boolean;
  providerEnabled: boolean;
  providerAvailable: boolean;
  providerConfigured?: boolean;
  depositAddressConfigured?: boolean;
  providerOpening?: boolean;
  providerError?: string | null;
}

export interface FundingDisplay {
  status: FundingStatus;
  tone: "green" | "amber" | "red" | "blue";
  title: string;
  summary: string;
  primaryCtaLabel: string;
  primaryCtaKind: FundingCtaKind;
  primaryCtaEnabled: boolean;
  paperAvailable: boolean;
  liveFundingEnabled: boolean;
}

export interface FundingMethodDisplay {
  title: string;
  body: string;
  status: string;
  enabled: boolean;
  detail: string;
}

export function getFundingDisplay(input: FundingStateInput): FundingDisplay {
  const eligibility = getEligibilityDisplay(input.eligibilityState);

  if (!input.hasPrivyEnv) {
    return {
      status: "unavailable_missing_privy_env",
      tone: "amber",
      title: "Provider not configured",
      summary: "Set NEXT_PUBLIC_PRIVY_APP_ID to enable wallet sign-in and Privy funding. Paper trading remains available in local development.",
      primaryCtaLabel: "Continue in paper mode",
      primaryCtaKind: "paper",
      primaryCtaEnabled: true,
      paperAvailable: true,
      liveFundingEnabled: false,
    };
  }

  if (input.eligibilityState === "restricted") {
    return {
      status: "unavailable_restricted",
      tone: "red",
      title: "Live funding unavailable",
      summary: "This jurisdiction is restricted for live Agent.trade activity. Funding CTAs stay disabled and paper mode remains available.",
      primaryCtaLabel: "Continue in paper mode",
      primaryCtaKind: "paper",
      primaryCtaEnabled: true,
      paperAvailable: eligibility.paperAvailable,
      liveFundingEnabled: false,
    };
  }

  if (input.eligibilityState === "unknown" || input.eligibilityState === "loading") {
    return {
      status: "unavailable_unknown_eligibility",
      tone: "amber",
      title: "Eligibility required",
      summary: "Agent.trade cannot prove live eligibility yet. Funding stays disabled until the server returns an eligible state.",
      primaryCtaLabel: "Continue in paper mode",
      primaryCtaKind: "paper",
      primaryCtaEnabled: true,
      paperAvailable: eligibility.paperAvailable,
      liveFundingEnabled: false,
    };
  }

  if (input.eligibilityState === "killSwitchDisabled" || input.eligibilityState === "paper") {
    return {
      status: "paper_only",
      tone: input.eligibilityState === "killSwitchDisabled" ? "red" : "blue",
      title: "Paper mode only",
      summary: "Live funding is unavailable in this mode. Use paper trading while live readiness is incomplete.",
      primaryCtaLabel: "Continue in paper mode",
      primaryCtaKind: "paper",
      primaryCtaEnabled: true,
      paperAvailable: eligibility.paperAvailable,
      liveFundingEnabled: false,
    };
  }

  if (!input.walletConnected) {
    return {
      status: "wallet_not_connected",
      tone: "amber",
      title: "Connect wallet first",
      summary: "A connected wallet is required before opening a provider funding flow. Connecting a wallet does not authorize trading.",
      primaryCtaLabel: "Connect wallet",
      primaryCtaKind: "connect_wallet",
      primaryCtaEnabled: true,
      paperAvailable: eligibility.paperAvailable,
      liveFundingEnabled: false,
    };
  }

  if (!input.providerEnabled) {
    if (input.providerConfigured) {
      return {
        status: "provider_configured_not_exposed",
        tone: "amber",
        title: "Provider configured, app hidden",
        summary: "Funding providers may be configured outside the app, but Agent.trade keeps provider funding hidden until the product flag, eligibility, wallet readiness, compliance, and QA all pass.",
        primaryCtaLabel: "Continue in paper mode",
        primaryCtaKind: "paper",
        primaryCtaEnabled: true,
        paperAvailable: eligibility.paperAvailable,
        liveFundingEnabled: false,
      };
    }

    return {
      status: "testnet_guidance",
      tone: "amber",
      title: "Provider not enabled",
      summary: "Privy funding is not enabled for this Agent.trade environment. Use paper mode or internal testnet funding guidance.",
      primaryCtaLabel: "Continue in paper mode",
      primaryCtaKind: "paper",
      primaryCtaEnabled: true,
      paperAvailable: eligibility.paperAvailable,
      liveFundingEnabled: false,
    };
  }

  if (input.providerError) {
    return {
      status: "provider_error",
      tone: "red",
      title: "Provider did not open",
      summary: input.providerError,
      primaryCtaLabel: input.providerAvailable ? "Try provider again" : "Continue in paper mode",
      primaryCtaKind: input.providerAvailable ? "open_provider" : "paper",
      primaryCtaEnabled: true,
      paperAvailable: eligibility.paperAvailable,
      liveFundingEnabled: false,
    };
  }

  if (input.providerOpening) {
    return {
      status: "provider_opening",
      tone: "blue",
      title: "Opening provider",
      summary: "Privy is opening the funding provider for the connected wallet. Provider availability depends on region, payment method, and KYC.",
      primaryCtaLabel: "Opening provider",
      primaryCtaKind: "none",
      primaryCtaEnabled: false,
      paperAvailable: eligibility.paperAvailable,
      liveFundingEnabled: false,
    };
  }

  if (input.providerAvailable) {
    return {
      status: "provider_ready",
      tone: "green",
      title: "Provider ready",
      summary: "Fund your wallet through a supported Privy provider. Funding a wallet is separate from depositing into Hyperliquid.",
      primaryCtaLabel: "Open provider",
      primaryCtaKind: "open_provider",
      primaryCtaEnabled: true,
      paperAvailable: eligibility.paperAvailable,
      liveFundingEnabled: true,
    };
  }

  return {
    status: "testnet_guidance",
    tone: "amber",
    title: "Provider unavailable",
    summary: "Privy funding is enabled, but no stable funding provider API is available in this environment. Use paper mode or internal testnet funding guidance.",
    primaryCtaLabel: "Continue in paper mode",
    primaryCtaKind: "paper",
    primaryCtaEnabled: true,
    paperAvailable: eligibility.paperAvailable,
    liveFundingEnabled: false,
  };
}

export function getFundingMethodDisplays(input: FundingStateInput): FundingMethodDisplay[] {
  const display = getFundingDisplay(input);
  const providerStatus = (() => {
    if (display.liveFundingEnabled) {
      return "Provider available";
    }
    if (display.status === "provider_configured_not_exposed") {
      return "Dashboard configured; app hidden";
    }
    if (input.providerEnabled) {
      return "Flag enabled; provider unavailable";
    }
    return "Not enabled in this environment";
  })();

  return [
    {
      title: "Supported today",
      body: "Email, Google, existing-wallet sign-in, and embedded wallet creation are the supported onboarding methods when Privy is configured.",
      status: input.hasPrivyEnv ? "Privy sign-in configured" : "Privy env missing",
      enabled: input.hasPrivyEnv,
      detail: "Current support is limited to configured sign-in and wallet readiness.",
    },
    {
      title: "Provider wallet funding",
      body: "Dashboard provider setup does not expose a user funding CTA by itself. Agent.trade requires the product flag, wallet readiness, live eligibility, legal approval, and QA.",
      status: providerStatus,
      enabled: display.liveFundingEnabled,
      detail: "Provider funding adds funds to the wallet; it does not prove Hyperliquid account deposit.",
    },
    {
      title: "Hyperliquid account deposit",
      body: "Wallet funding and Hyperliquid account funding are separate states. Live orders remain disabled until account state, eligibility, and confirmation gates pass.",
      status: "Separate account-readiness gate",
      enabled: input.walletConnected && input.eligibilityState === "liveEligible",
      detail: "Do not treat wallet balance as exchange margin until Hyperliquid account state confirms readiness.",
    },
    {
      title: "Future deposit address",
      body: "Deposit-address funding stays future-gated until an installed SDK or backend API is verified and an app-specific flag, status model, and compliance review exist.",
      status: input.depositAddressConfigured ? "Dashboard configured; not exposed" : "Future gated",
      enabled: false,
      detail: "No deposit-address CTA is exposed from the current app state.",
    },
  ];
}
