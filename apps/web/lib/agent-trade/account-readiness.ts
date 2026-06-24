import type { AccountValueKind, EligibilityMode } from "./types";

export type WalletConnectionStatus = "local-dev" | "loading" | "not-connected" | "connected";

export type AccountReadinessMode =
  | "disconnected_paper"
  | "connected_unknown_eligibility"
  | "connected_restricted"
  | "connected_testnet_ready"
  | "connected_live_eligible"
  | "api_unavailable_paper"
  | "kill_switch_paper";

export interface WalletReadinessSummary {
  status: WalletConnectionStatus;
  address?: string;
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
      label: "Paper account",
      summary: "Connected wallet detected, but read-only Hyperliquid account data is unavailable. Showing simulated account values.",
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
        : "Wallet connected and eligibility passed. Account values remain simulated until read-only account data loads.",
      liveTradingEnabled: true,
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
