import type { EligibilityMode } from "./types";
import type { WalletReadinessSummary } from "./account-readiness";

export const BUILDER_APPROVAL_REQUIRED_MESSAGE = "Approve Agent.trade builder fee before first live order.";

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
      title: "Builder approval unavailable",
      summary: "Privy sign-in is not configured in this environment. Paper mode remains available.",
      ctaLabel: "Approval unavailable",
      ctaVisible: false,
      ctaEnabled: false,
      approved: false,
    };
  }

  if (input.wallet.status === "loading" || input.wallet.authStatus === "loading") {
    return {
      status: "loading",
      title: "Checking builder approval",
      summary: "Checking the active wallet before showing builder approval readiness.",
      ctaLabel: "Checking approval",
      ctaVisible: false,
      ctaEnabled: false,
      approved: false,
    };
  }

  if (input.wallet.status !== "connected" || !input.wallet.address || input.wallet.authStatus !== "authenticated") {
    return {
      status: "not-connected",
      title: "Connect wallet first",
      summary: "A connected Privy wallet is required before checking or approving Agent.trade builder fees.",
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
      summary: "Restricted, unknown, paper-only, or kill-switch states cannot approve builder fees or submit live orders.",
      ctaLabel: "Approval disabled",
      ctaVisible: false,
      ctaEnabled: false,
      approved: false,
    };
  }

  if (input.hlAccountValueUsd < input.minOrderNotionalUsd) {
    return {
      status: "funding-required",
      title: "Fund Hyperliquid first",
      summary: `Deposit enough USDC into Hyperliquid to reach Agent.trade's $${input.minOrderNotionalUsd} minimum order notional before approving the builder fee.`,
      ctaLabel: "Approval waits for funding",
      ctaVisible: true,
      ctaEnabled: false,
      ctaDisabledReason: "Hyperliquid trading balance is below the order minimum.",
      approved: false,
    };
  }

  if (input.approvalLoading) {
    return {
      status: "loading",
      title: "Checking builder approval",
      summary: "Checking Hyperliquid builder fee approval for the active wallet.",
      ctaLabel: "Checking approval",
      ctaVisible: true,
      ctaEnabled: false,
      ctaDisabledReason: "Approval status is still loading.",
      approved: false,
    };
  }

  if (!input.approval) {
    return {
      status: "unavailable",
      title: "Approval status unavailable",
      summary: input.approvalError ?? "Agent.trade could not read Hyperliquid builder approval for this wallet.",
      ctaLabel: "Approval unavailable",
      ctaVisible: true,
      ctaEnabled: false,
      ctaDisabledReason: "Refresh approval status before live trading.",
      approved: false,
    };
  }

  if (input.approval.canTradePerps) {
    return {
      status: "approved",
      title: "Builder fee approved",
      summary: "This wallet has approved the configured Agent.trade builder fee for Hyperliquid perps. Every live order still requires explicit confirmation.",
      ctaLabel: "Approved",
      ctaVisible: true,
      ctaEnabled: false,
      approved: true,
    };
  }

  return {
    status: "approval-required",
    title: "Builder approval required",
    summary: "Approve Agent.trade builder fee so Hyperliquid can apply the configured builder code and fee. This does not grant autonomous trading; every order still requires confirmation.",
    ctaLabel: "Approve Agent.trade builder fee",
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
