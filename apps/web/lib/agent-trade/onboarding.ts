import type { EligibilityMode } from "./types";

export interface EligibilityDisplay {
  label: string;
  tone: "green" | "amber" | "red" | "blue";
  liveTradingEnabled: boolean;
  liveFundingEnabled: boolean;
  paperAvailable: boolean;
  summary: string;
}

export function formatWalletAddress(address?: string | null): string {
  if (!address) {
    return "Not connected";
  }
  if (address.length <= 12) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function getEligibilityDisplay(state: EligibilityMode): EligibilityDisplay {
  switch (state) {
    case "liveEligible":
      return {
        label: "Live eligible",
        tone: "green",
        liveTradingEnabled: true,
        liveFundingEnabled: true,
        paperAvailable: true,
        summary: "Live trading can be enabled after wallet setup and risk acknowledgement.",
      };
    case "restricted":
      return {
        label: "Restricted",
        tone: "red",
        liveTradingEnabled: false,
        liveFundingEnabled: false,
        paperAvailable: true,
        summary: "Live trading unavailable. Paper mode remains available for testing.",
      };
    case "unknown":
      return {
        label: "Eligibility unknown",
        tone: "amber",
        liveTradingEnabled: false,
        liveFundingEnabled: false,
        paperAvailable: true,
        summary: "The server cannot prove an allowed jurisdiction. Use paper mode until eligibility is resolved.",
      };
    case "killSwitchDisabled":
      return {
        label: "Live disabled",
        tone: "red",
        liveTradingEnabled: false,
        liveFundingEnabled: false,
        paperAvailable: true,
        summary: "The live trading kill switch is active. Paper mode remains available.",
      };
    case "paper":
      return {
        label: "Paper mode",
        tone: "blue",
        liveTradingEnabled: false,
        liveFundingEnabled: false,
        paperAvailable: true,
        summary: "This account is using simulated trading while live readiness is incomplete.",
      };
    case "loading":
    default:
      return {
        label: "Checking eligibility",
        tone: "amber",
        liveTradingEnabled: false,
        liveFundingEnabled: false,
        paperAvailable: true,
        summary: "Live trading stays disabled until the server returns an eligible state.",
      };
  }
}
