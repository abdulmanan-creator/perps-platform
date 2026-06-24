import { describe, expect, it } from "vitest";

import {
  getBridgeDepositDecision,
  getLegacyApprovalDecision,
  getOAuthCompatibilityDecision,
} from "../lib/agent-trade/legacy-safety";

describe("Agent.trade legacy compatibility safety helpers", () => {
  it("keeps approveBuilderFee hidden/disabled when legacy approvals are default-off", () => {
    const decision = getLegacyApprovalDecision({
      featureEnabled: false,
      eligibilityState: "liveEligible",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.ctaEnabled).toBe(false);
    expect(decision.reason).toBe("feature_disabled");
    expect(decision.summary).toContain("disabled");
  });

  it("keeps approveAgent compatibility hidden/disabled when OAuth compatibility is default-off", () => {
    const decision = getOAuthCompatibilityDecision({
      featureEnabled: false,
      eligibilityState: "liveEligible",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.ctaEnabled).toBe(false);
    expect(decision.reason).toBe("feature_disabled");
    expect(decision.summary).toContain("return orders to Agent.trade");
  });

  it("keeps the Hyperliquid Bridge2 deposit CTA hidden/disabled by default", () => {
    const decision = getBridgeDepositDecision({
      featureEnabled: false,
      eligibilityState: "liveEligible",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.ctaEnabled).toBe(false);
    expect(decision.reason).toBe("feature_disabled");
    expect(decision.summary).toContain("Bridge2 deposit path is not enabled");
  });

  it("blocks enabled compatibility flows until live eligibility is proven", () => {
    for (const eligibilityState of ["loading", "restricted", "unknown", "paper", "killSwitchDisabled"] as const) {
      const approval = getLegacyApprovalDecision({
        featureEnabled: true,
        eligibilityState,
      });
      const oauth = getOAuthCompatibilityDecision({
        featureEnabled: true,
        eligibilityState,
      });
      const deposit = getBridgeDepositDecision({
        featureEnabled: true,
        eligibilityState,
      });

      expect(approval.allowed).toBe(false);
      expect(oauth.allowed).toBe(false);
      expect(deposit.allowed).toBe(false);
    }
  });
});
