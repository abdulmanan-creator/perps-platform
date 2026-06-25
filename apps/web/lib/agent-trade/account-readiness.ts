import type { AccountValueKind, EligibilityMode } from "./types";

export type WalletConnectionStatus = "local-dev" | "loading" | "not-connected" | "connected";

export type PrivyAuthStatus = "not-configured" | "loading" | "unauthenticated" | "authenticated";

export type WalletKind = "embedded" | "external" | "unknown";

export type AccountReadinessMode =
  | "disconnected_paper"
  | "connected_unknown_eligibility"
  | "connected_restricted"
  | "connected_testnet_ready"
  | "connected_live_eligible"
  | "api_unavailable_paper"
  | "kill_switch_paper";

export type LiveTradingBlockReason =
  | "privy_not_configured"
  | "privy_loading"
  | "not_authenticated"
  | "wallet_missing"
  | "eligibility_loading"
  | "eligibility_unknown"
  | "restricted"
  | "paper_only"
  | "account_unavailable"
  | "kill_switch"
  | "execution_disabled"
  | "ready";

export interface WalletReadinessSummary {
  status: WalletConnectionStatus;
  address?: string;
  authStatus?: PrivyAuthStatus;
  walletType?: string;
  walletKind?: WalletKind;
}

export interface AccountReadinessInput {
  wallet: WalletReadinessSummary;
  eligibilityState: EligibilityMode;
  accountValueKind?: AccountValueKind;
  liveAccountDataLoaded?: boolean;
  liveAccountDataUnavailable?: boolean;
}

export interface AccountReadinessDisplay {
  mode: AccountReadinessMode;
  label: string;
  summary: string;
  liveTradingEnabled: boolean;
  paperTradingEnabled: boolean;
  accountValueKind: AccountValueKind;
  accountValueLabel: string;
  walletLabel: string;
  tone: "green" | "amber" | "red" | "blue";
}

export interface LiveTradingReadinessInput {
  wallet: WalletReadinessSummary;
  eligibilityState: EligibilityMode;
  executionVenue: string;
  mainnetExecutionEnabled: boolean;
  killSwitchEnabled: boolean;
  accountValueKind?: AccountValueKind;
  liveAccountDataLoaded?: boolean;
  liveAccountDataUnavailable?: boolean;
}

export interface LiveTradingReadiness {
  allowed: boolean;
  reason: LiveTradingBlockReason;
  label: string;
  disabledReason: string;
  summary: string;
  tone: "green" | "amber" | "red" | "blue";
}

export function getLiveTradingReadiness(input: LiveTradingReadinessInput): LiveTradingReadiness {
  if (input.wallet.status === "local-dev" || input.wallet.authStatus === "not-configured") {
    return blockLiveTrading(
      "privy_not_configured",
      "Privy not configured",
      "Sign-in is not configured in this environment. Paper mode remains available.",
      "Set Privy configuration before enabling testnet trading.",
      "amber",
    );
  }

  if (input.wallet.status === "loading" || input.wallet.authStatus === "loading") {
    return blockLiveTrading(
      "privy_loading",
      "Checking sign-in",
      "Checking Privy session before enabling testnet trading.",
      "Wait for Privy session readiness.",
      "amber",
    );
  }

  if (input.wallet.authStatus !== "authenticated") {
    return blockLiveTrading(
      "not_authenticated",
      "Sign-in required",
      "Sign in to enable testnet trading.",
      "Sign in to enable testnet trading.",
      "amber",
    );
  }

  if (input.wallet.status !== "connected" || !input.wallet.address) {
    return blockLiveTrading(
      "wallet_missing",
      "Wallet required",
      "Wallet required. Sign in again or enable embedded wallet creation in Privy.",
      "Wallet required.",
      "amber",
    );
  }

  if (input.killSwitchEnabled || input.eligibilityState === "killSwitchDisabled") {
    return blockLiveTrading(
      "kill_switch",
      "Execution disabled",
      "Execution disabled by safety switch.",
      "Execution disabled by safety switch.",
      "red",
    );
  }

  if (input.eligibilityState === "restricted") {
    return blockLiveTrading(
      "restricted",
      "Restricted region",
      "Restricted region: paper only.",
      "Restricted region: paper only.",
      "red",
    );
  }

  if (input.eligibilityState === "loading") {
    return blockLiveTrading(
      "eligibility_loading",
      "Checking eligibility",
      "Eligibility not confirmed.",
      "Eligibility not confirmed.",
      "amber",
    );
  }

  if (input.eligibilityState === "unknown") {
    return blockLiveTrading(
      "eligibility_unknown",
      "Eligibility not confirmed",
      "Eligibility not confirmed.",
      "Eligibility not confirmed.",
      "amber",
    );
  }

  if (input.eligibilityState === "paper") {
    return blockLiveTrading(
      "paper_only",
      "Paper only",
      "Paper mode is active while account readiness is incomplete.",
      "Paper mode only.",
      "blue",
    );
  }

  if (input.liveAccountDataUnavailable || !input.liveAccountDataLoaded || input.accountValueKind === "unavailable") {
    return blockLiveTrading(
      "account_unavailable",
      "Account unavailable",
      "Hyperliquid account state unavailable. Refresh before live trading.",
      "Read-only Hyperliquid account state must load before live orders are enabled.",
      "amber",
    );
  }

  const isTestnet = input.executionVenue === "hyperliquid-testnet";
  if (!isTestnet && !input.mainnetExecutionEnabled) {
    return blockLiveTrading(
      "execution_disabled",
      "Execution disabled",
      "Execution is not on testnet and mainnet execution is disabled.",
      "Execution disabled by policy.",
      "red",
    );
  }

  return {
    allowed: true,
    reason: "ready",
    label: isTestnet ? "Testnet ready" : "Live ready",
    disabledReason: "Testnet trading is available after confirmation.",
    summary: isTestnet
      ? "Privy sign-in, wallet, eligibility, and testnet execution policy are ready."
      : "Privy sign-in, wallet, eligibility, and explicit mainnet execution policy are ready.",
    tone: "green",
  };
}

export function getAccountReadinessDisplay(input: AccountReadinessInput): AccountReadinessDisplay {
  const walletConnected = input.wallet.status === "connected";
  const accountValueKind = resolveAccountValueKind(input);
  const walletLabel = walletStatusLabel(input.wallet.status);

  if (input.eligibilityState === "killSwitchDisabled") {
    return {
      mode: "kill_switch_paper",
      label: "Paper account",
      summary: "Live trading is disabled by the kill switch. Paper trading remains available.",
      liveTradingEnabled: false,
      paperTradingEnabled: true,
      accountValueKind,
      accountValueLabel: accountValueKindLabel(accountValueKind),
      walletLabel,
      tone: "red",
    };
  }

  if (!walletConnected) {
    return {
      mode: "disconnected_paper",
      label: "Paper account",
      summary: "Paper mode active. Market data is live; account values are simulated until a wallet is connected.",
      liveTradingEnabled: false,
      paperTradingEnabled: true,
      accountValueKind: "paper",
      accountValueLabel: accountValueKindLabel("paper"),
      walletLabel,
      tone: "blue",
    };
  }

  if (input.liveAccountDataUnavailable) {
    return {
      mode: "api_unavailable_paper",
      label: "Account unavailable",
      summary: "Connected wallet detected, but read-only Hyperliquid account data is unavailable. Live trading is disabled until account state refreshes.",
      liveTradingEnabled: false,
      paperTradingEnabled: true,
      accountValueKind: "unavailable",
      accountValueLabel: accountValueKindLabel("unavailable"),
      walletLabel,
      tone: "amber",
    };
  }

  if (input.eligibilityState === "restricted") {
    return {
      mode: "connected_restricted",
      label: accountValueKind === "real" || accountValueKind === "hybrid" ? "Connected read-only" : "Paper account",
      summary: "Live trading unavailable in your region. Paper trading remains available.",
      liveTradingEnabled: false,
      paperTradingEnabled: true,
      accountValueKind,
      accountValueLabel: accountValueKindLabel(accountValueKind),
      walletLabel,
      tone: "red",
    };
  }

  if (input.eligibilityState === "liveEligible") {
    const hasRealValues = input.liveAccountDataLoaded === true;
    return {
      mode: hasRealValues ? "connected_live_eligible" : "connected_testnet_ready",
      label: hasRealValues ? "Connected account" : "Connected wallet",
      summary: hasRealValues
        ? "Read-only Hyperliquid account data is loaded. Live orders still require Agent.trade confirmation."
        : "Wallet connected and eligibility passed. Hyperliquid account state is still loading; live trading remains disabled.",
      liveTradingEnabled: hasRealValues,
      paperTradingEnabled: true,
      accountValueKind,
      accountValueLabel: accountValueKindLabel(accountValueKind),
      walletLabel,
      tone: hasRealValues ? "green" : "amber",
    };
  }

  if (input.eligibilityState === "paper") {
    return {
      mode: "connected_testnet_ready",
      label: "Paper account",
      summary: "This session is using paper trading while live readiness is incomplete.",
      liveTradingEnabled: false,
      paperTradingEnabled: true,
      accountValueKind,
      accountValueLabel: accountValueKindLabel(accountValueKind),
      walletLabel,
      tone: "blue",
    };
  }

  return {
    mode: "connected_unknown_eligibility",
    label: accountValueKind === "real" || accountValueKind === "hybrid" ? "Connected read-only" : "Paper account",
    summary: "Paper mode active. Live trading unavailable until eligibility is confirmed.",
    liveTradingEnabled: false,
    paperTradingEnabled: true,
    accountValueKind,
    accountValueLabel: accountValueKindLabel(accountValueKind),
    walletLabel,
    tone: "amber",
  };
}

function blockLiveTrading(
  reason: Exclude<LiveTradingBlockReason, "ready">,
  label: string,
  disabledReason: string,
  summary: string,
  tone: "amber" | "red" | "blue",
): LiveTradingReadiness {
  return {
    allowed: false,
    reason,
    label,
    disabledReason,
    summary,
    tone,
  };
}

export function accountValueKindLabel(kind: AccountValueKind): string {
  switch (kind) {
    case "paper":
      return "Simulated account values";
    case "real":
      return "Read-only Hyperliquid account";
    case "hybrid":
      return "Read-only account plus paper ledger";
    case "unavailable":
      return "Account data unavailable";
    default:
      return assertNever(kind);
  }
}

function resolveAccountValueKind(input: AccountReadinessInput): AccountValueKind {
  if (input.liveAccountDataUnavailable) {
    return "unavailable";
  }
  if (input.accountValueKind) {
    return input.accountValueKind;
  }
  if (input.liveAccountDataLoaded) {
    return "real";
  }
  return "paper";
}

function walletStatusLabel(status: WalletConnectionStatus): string {
  switch (status) {
    case "connected":
      return "Wallet connected";
    case "loading":
      return "Checking wallet session";
    case "local-dev":
      return "Local dev wallet unavailable";
    case "not-connected":
      return "Wallet not connected";
    default:
      return assertNever(status);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
