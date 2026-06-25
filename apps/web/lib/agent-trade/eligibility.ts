import type { EligibilityResponse } from "./types";

export const DEFAULT_ELIGIBILITY_RESPONSE: EligibilityResponse = {
  state: "unknown",
  executionVenue: "hyperliquid-mainnet",
  mainnetExecutionEnabled: false,
  killSwitchEnabled: false,
  minOrderNotionalUsd: 10,
  orderNotionalCapUsd: 0,
  dailyNotionalCapUsd: 0,
};

export async function normalizeEligibilityResponse(response: Response): Promise<EligibilityResponse> {
  const body = await readJson(response);
  if (response.ok) {
    return {
      ...DEFAULT_ELIGIBILITY_RESPONSE,
      ...(body && typeof body === "object" ? body : {}),
    } as EligibilityResponse;
  }

  if (body && typeof body === "object" && "error" in body && body.error === "REGION_BLOCKED") {
    return {
      ...DEFAULT_ELIGIBILITY_RESPONSE,
      state: "restricted",
    };
  }

  return DEFAULT_ELIGIBILITY_RESPONSE;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
