import type { WalletReadinessSummary } from "./account-readiness";
import type { FundingDisplay } from "./funding";
import { getEligibilityDisplay } from "./onboarding";
import type { EligibilityMode } from "./types";

export type OnboardingTone = "green" | "amber" | "red" | "blue";

export interface ReadinessItem {
  label: string;
  value: string;
  ok: boolean;
  tone: OnboardingTone;
  detail: string;
}

export interface OnboardingReadinessInput {
  hasPrivyEnv: boolean;
  wallet: WalletReadinessSummary;
  eligibilityState: EligibilityMode;
  executionVenue: string;
  mainnetExecutionEnabled: boolean;
  killSwitchEnabled: boolean;
  funding: FundingDisplay;
}

export interface OnboardingReadinessSummary {
  label: string;
  tone: OnboardingTone;
  summary: string;
  signInMethods: ReadinessItem;
  embeddedWallet: ReadinessItem;
  eligibility: ReadinessItem;
  tradingMode: ReadinessItem;
  funding: ReadinessItem;
  oneTapTrading: ReadinessItem;
}

export const supportedSignInMethods = ["Email", "Google", "Wallet"] as const;

export function getOnboardingReadiness(input: OnboardingReadinessInput): OnboardingReadinessSummary {
  const eligibility = getEligibilityDisplay(input.eligibilityState);
  const signInMethods = getSignInMethodsReadiness(input);
  const embeddedWallet = getEmbeddedWalletReadiness(input);
  const tradingMode = getTradingModeReadiness(input);
  const funding = getFundingReadiness(input);
  const oneTapTrading = getOneTapTradingReadiness();
  const isReadyForLive =
    input.wallet.status === "connected" &&
    input.wallet.authStatus === "authenticated" &&
    input.eligibilityState === "liveEligible" &&
    !input.killSwitchEnabled;

  return {
    label: isReadyForLive ? "Wallet and eligibility ready" : "Paper-first readiness",
    tone: isReadyForLive ? "green" : eligibility.tone,
    summary: isReadyForLive
      ? "Sign-in, wallet, and eligibility are ready. Live orders still require account state, explicit confirmation, and server-side safety checks."
      : "Agent.trade stays paper-first until Privy sign-in, wallet, eligibility, account state, and funding gates are all explicit.",
    signInMethods,
    embeddedWallet,
    eligibility: {
      label: "Eligibility",
      value: eligibility.label,
      ok: input.eligibilityState === "liveEligible",
      tone: eligibility.tone,
      detail: eligibility.summary,
    },
    tradingMode,
    funding,
    oneTapTrading,
  };
}

function getSignInMethodsReadiness(input: OnboardingReadinessInput): ReadinessItem {
  if (!input.hasPrivyEnv) {
    return {
      label: "Sign-in methods",
      value: "Local-dev paper only",
      ok: false,
      tone: "amber",
      detail: "Set NEXT_PUBLIC_PRIVY_APP_ID to expose configured email, Google, and wallet sign-in.",
    };
  }

  return {
    label: "Sign-in methods",
    value: supportedSignInMethods.join(", "),
    ok: true,
    tone: "green",
    detail: "These are the configured sign-in methods wired in the app today. Apple stays hidden unless explicitly configured.",
  };
}

function getEmbeddedWalletReadiness(input: OnboardingReadinessInput): ReadinessItem {
  if (!input.hasPrivyEnv) {
    return {
      label: "Embedded wallet",
      value: "Privy env missing",
      ok: false,
      tone: "amber",
      detail: "Embedded wallet creation is unavailable until Privy is configured.",
    };
  }

  if (input.wallet.status === "connected" && input.wallet.walletKind === "embedded") {
    return {
      label: "Embedded wallet",
      value: "Connected",
      ok: true,
      tone: "green",
      detail: "The active wallet is a Privy embedded wallet.",
    };
  }

  if (input.wallet.status === "connected" && input.wallet.walletKind === "external") {
    return {
      label: "Embedded wallet",
      value: "External wallet active",
      ok: true,
      tone: "blue",
      detail: "Existing-wallet login is supported; users without a wallet may receive an embedded wallet when dashboard settings allow it.",
    };
  }

  if (input.wallet.authStatus === "authenticated") {
    return {
      label: "Embedded wallet",
      value: "Wallet missing",
      ok: false,
      tone: "amber",
      detail: "The user is signed in but no usable wallet is available yet.",
    };
  }

  return {
    label: "Embedded wallet",
    value: "Ready after sign-in",
    ok: false,
    tone: "amber",
    detail: "Privy can create an embedded wallet for users without wallets when dashboard settings allow it.",
  };
}

function getTradingModeReadiness(input: OnboardingReadinessInput): ReadinessItem {
  if (input.killSwitchEnabled || input.eligibilityState === "killSwitchDisabled") {
    return {
      label: "Trading mode",
      value: "Paper only",
      ok: false,
      tone: "red",
      detail: "The live trading kill switch is active.",
    };
  }

  if (input.eligibilityState !== "liveEligible") {
    return {
      label: "Trading mode",
      value: "Paper available",
      ok: true,
      tone: "blue",
      detail: "Live trading stays disabled until eligibility is confirmed.",
    };
  }

  if (input.executionVenue === "hyperliquid-testnet") {
    return {
      label: "Trading mode",
      value: "Testnet eligible",
      ok: true,
      tone: "green",
      detail: "Testnet execution can be selected only after wallet and account-readiness gates pass.",
    };
  }

  if (input.mainnetExecutionEnabled) {
    return {
      label: "Trading mode",
      value: "Mainnet eligible",
      ok: true,
      tone: "green",
      detail: "Mainnet execution is still guarded by geo, account readiness, caps, acknowledgements, and confirmation.",
    };
  }

  return {
    label: "Trading mode",
    value: "Execution disabled",
    ok: false,
    tone: "red",
    detail: "The venue is not testnet and mainnet execution is disabled by policy.",
  };
}

function getFundingReadiness(input: OnboardingReadinessInput): ReadinessItem {
  return {
    label: "Funding",
    value: input.funding.title,
    ok: input.funding.liveFundingEnabled,
    tone: input.funding.tone,
    detail: input.funding.summary,
  };
}

function getOneTapTradingReadiness(): ReadinessItem {
  return {
    label: "One-tap trading",
    value: "Coming soon",
    ok: false,
    tone: "blue",
    detail: "Current MVP confirms orders in Agent.trade and may still ask for wallet signatures until a dedicated Hyperliquid API wallet flow is enabled.",
  };
}
