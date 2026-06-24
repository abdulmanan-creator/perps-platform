import type { EligibilityMode } from "./types";

export type LegacySafetyReason =
  | "feature_disabled"
  | "eligibility_loading"
  | "eligibility_blocked"
  | "allowed";

export interface LegacySafetyInput {
  featureEnabled: boolean;
  eligibilityState: EligibilityMode;
}

export interface LegacySafetyDecision {
  allowed: boolean;
  ctaEnabled: boolean;
  reason: LegacySafetyReason;
  title: string;
  summary: string;
}

export function getLegacyApprovalDecision(input: LegacySafetyInput): LegacySafetyDecision {
  if (!input.featureEnabled) {
    return {
      allowed: false,
      ctaEnabled: false,
      reason: "feature_disabled",
      title: "Legacy approvals disabled",
      summary:
        "Agent.trade compatibility approvals are disabled in this environment. Current connector flows remain research and draft handoffs.",
    };
  }

  return eligibilityDecision(input.eligibilityState, "compatibility approvals");
}

export function getOAuthCompatibilityDecision(input: LegacySafetyInput): LegacySafetyDecision {
  if (!input.featureEnabled) {
    return {
      allowed: false,
      ctaEnabled: false,
      reason: "feature_disabled",
      title: "Connector compatibility disabled",
      summary:
        "OAuth compatibility approvals are disabled in this environment. Current connectors return orders to Agent.trade for review and confirmation.",
    };
  }

  return eligibilityDecision(input.eligibilityState, "OAuth compatibility approvals");
}

export function getBridgeDepositDecision(input: LegacySafetyInput): LegacySafetyDecision {
  if (!input.featureEnabled) {
    return {
      allowed: false,
      ctaEnabled: false,
      reason: "feature_disabled",
      title: "Bridge deposit disabled",
      summary:
        "The in-app Hyperliquid Bridge2 deposit path is not enabled in this environment. Use account readiness for funding guidance.",
    };
  }

  return eligibilityDecision(input.eligibilityState, "Bridge2 deposits");
}

function eligibilityDecision(state: EligibilityMode, actionLabel: string): LegacySafetyDecision {
  if (state === "loading") {
    return {
      allowed: false,
      ctaEnabled: false,
      reason: "eligibility_loading",
      title: "Checking eligibility",
      summary: `${actionLabel} stay disabled until Agent.trade confirms live eligibility.`,
    };
  }

  if (state !== "liveEligible") {
    return {
      allowed: false,
      ctaEnabled: false,
      reason: "eligibility_blocked",
      title: "Live eligibility required",
      summary:
        "Restricted or unknown eligibility cannot use live compatibility, approval, or deposit flows. Paper mode remains available where routing permits.",
    };
  }

  return {
    allowed: true,
    ctaEnabled: true,
    reason: "allowed",
    title: "Live eligible",
    summary: `${actionLabel} may be shown because this environment explicitly enabled the flow and Agent.trade confirmed live eligibility.`,
  };
}
