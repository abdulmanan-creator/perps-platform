import type { EligibilityMode } from "./types";
import type { WalletReadinessSummary } from "./account-readiness";

export const BUILDER_APPROVAL_REQUIRED_MESSAGE = "Enable Agent.trade execution before the first live order.";

export interface BuilderApprovalState {
  approved: boolean;
  maxFeeRate: string;
  maxFeeRaw: number;
  canTradePerps: boolean;
  canTradeSpot: boolean;
  builder: `0x${string}`;
  feeBreakdown?: {
    configuredPerpsBps?: number;
    configuredSpotBps?: number;
    protocolMaxPerpsBps?: number;
    protocolMaxSpotBps?: number;
  };
}

export type BuilderApprovalStatus =
  | "local-dev"
  | "not-connected"
  | "ineligible"
  | "funding-required"
  | "loading"
  | "unavailable"
  | "approval-required"
  | "approved";

export interface BuilderApprovalReadiness {
  status: BuilderApprovalStatus;
  title: string;
  summary: string;
  ctaLabel: string;
  ctaVisible: boolean;
  ctaEnabled: boolean;
  ctaDisabledReason?: string;
  approved: boolean;
}

export function getBuilderApprovalReadiness(input: {
  hasPrivyEnv: boolean;
  wallet: WalletReadinessSummary;
  eligibilityState: EligibilityMode;
  hlAccountValueUsd: number;
  minOrderNotionalUsd: number;
  approval?: BuilderApprovalState;
  approvalLoading?: boolean;
  approvalError?: string | null;
}): BuilderApprovalReadiness {
  if (!input.hasPrivyEnv || input.wallet.status === "local-dev" || input.wallet.authStatus === "not-configured") {
    return {
      status: "local-dev",
      title: "Trading permission unavailable",
      summary: "Privy sign-in is not configured in this environment. Paper mode remains available.",
      ctaLabel: "Enable Agent.trade execution unavailable",
      ctaVisible: false,
      ctaEnabled: false,
      approved: false,
    };
  }

  if (input.wallet.status === "loading" || input.wallet.authStatus === "loading") {
    return {
      status: "loading",
      title: "Checking trading permission",
      summary: "Checking the active wallet before showing one-time Hyperliquid permission readiness.",
      ctaLabel: "Checking permission",
      ctaVisible: false,
      ctaEnabled: false,
      approved: false,
    };
  }

  if (input.wallet.status !== "connected" || !input.wallet.address || input.wallet.authStatus !== "authenticated") {
    return {
      status: "not-connected",
      title: "Connect wallet first",
      summary: "A connected Privy wallet is required before checking the one-time Hyperliquid permission.",
      ctaLabel: "Connect wallet",
      ctaVisible: false,
      ctaEnabled: false,
      approved: false,
    };
  }

  if (input.eligibilityState !== "liveEligible") {
    return {
      status: "ineligible",
      title: "Paper mode only",
      summary: "Restricted, unknown, paper-only, or kill-switch states cannot enable live trading or submit live orders.",
      ctaLabel: "Enable Agent.trade execution disabled",
      ctaVisible: false,
      ctaEnabled: false,
      approved: false,
    };
  }

  if (!Number.isFinite(input.hlAccountValueUsd) || input.hlAccountValueUsd <= 0) {
    return {
      status: "funding-required",
      title: "Fund Hyperliquid first",
      summary: "Deposit USDC into Hyperliquid before enabling Agent.trade execution. Hyperliquid requires a funded account before wallet setup actions.",
      ctaLabel: "Enable Agent.trade execution waits for funding",
      ctaVisible: true,
      ctaEnabled: false,
      ctaDisabledReason: "Hyperliquid trading balance is empty or unavailable.",
      approved: false,
    };
  }

  if (input.approvalLoading) {
    return {
      status: "loading",
      title: "Checking trading permission",
      summary: "Checking the one-time Hyperliquid permission for the active wallet.",
      ctaLabel: "Checking permission",
      ctaVisible: true,
      ctaEnabled: false,
      ctaDisabledReason: "Permission status is still loading.",
      approved: false,
    };
  }

  if (!input.approval) {
    return {
      status: "unavailable",
      title: "Trading permission unavailable",
      summary: input.approvalError ?? "Agent.trade could not read the Hyperliquid trading permission for this wallet.",
      ctaLabel: "Permission unavailable",
      ctaVisible: true,
      ctaEnabled: false,
      ctaDisabledReason: "Refresh permission status before live trading.",
      approved: false,
    };
  }

  if (input.approval.canTradePerps) {
    return {
      status: "approved",
      title: "Trading enabled",
      summary: input.hlAccountValueUsd < input.minOrderNotionalUsd
        ? `This wallet has the one-time Hyperliquid permission enabled. Trading balance is below Agent.trade's $${input.minOrderNotionalUsd}+ order notional requirement; orders still require sufficient margin and Agent.trade confirmation.`
        : "This wallet has the one-time Hyperliquid permission enabled. You confirm orders in Agent.trade. Current MVP may still ask for wallet signatures until one-tap trading is enabled.",
      ctaLabel: "Start trading",
      ctaVisible: true,
      ctaEnabled: false,
      approved: true,
    };
  }

  return {
    status: "approval-required",
    title: "Enable Agent.trade execution",
    summary: input.hlAccountValueUsd < input.minOrderNotionalUsd
      ? `Enable Agent.trade execution with a one-time Hyperliquid permission. Trading balance is below Agent.trade's $${input.minOrderNotionalUsd}+ order notional requirement; orders still require sufficient margin and Agent.trade confirmation.`
      : "Enable Agent.trade execution with a one-time Hyperliquid permission. You confirm orders in Agent.trade. Current MVP may still ask for wallet signatures until one-tap trading is enabled.",
    ctaLabel: "Enable Agent.trade execution",
    ctaVisible: true,
    ctaEnabled: true,
    approved: false,
  };
}

export function builderApprovalMaxFeeRate(approval?: BuilderApprovalState): string | undefined {
  const configuredBps = approval?.feeBreakdown?.configuredPerpsBps;
  if (configuredBps == null || !Number.isFinite(configuredBps) || configuredBps < 0) {
    return undefined;
  }
  return `${trimDecimal(configuredBps / 100)}%`;
}

export function formatBuilderFeeBps(approval?: BuilderApprovalState): string {
  const configuredBps = approval?.feeBreakdown?.configuredPerpsBps;
  return configuredBps == null || !Number.isFinite(configuredBps)
    ? "Not checked"
    : `${trimDecimal(configuredBps)} bps`;
}

function trimDecimal(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/u, "");
}
