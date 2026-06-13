/**
 * Lighter venue adapter (stub).
 *
 * Lighter is an orderbook perp DEX on its own zk-rollup. Orders are placed via
 * its API, signed with a venue-registered L2 API key — NOT an Ethereum
 * typed-data envelope — so capabilities.signing is "venueSig". Settlement is
 * synchronous (the API responds with order state). No builder-code primitive
 * today, so earnsBuilderFee is false (revenue would come from a referral
 * program or a platform-side fee wrapper).
 *
 * Wiring needs: L2 key registration/management, the Lighter signing scheme,
 * and its order/market API. See packages/venues/ROADMAP for sequencing.
 */

import {
  NotImplementedError,
  type BuildOrderInput,
  type BuildResult,
  type SubmitResult,
  type Venue,
  type VenueCapabilities,
  type VenueMarket,
} from "./types.js";

export class LighterVenue implements Venue {
  readonly id = "lighter" as const;

  readonly capabilities: VenueCapabilities = {
    signing: "venueSig",
    settlement: "sync",
    kinds: ["perp"],
    requiresGas: false,
    earnsBuilderFee: false,
    reduceOnly: true,
  };

  async listMarkets(): Promise<VenueMarket[]> {
    throw new NotImplementedError(this.id, "listMarkets");
  }
  async buildOrder(_input: BuildOrderInput): Promise<BuildResult> {
    throw new NotImplementedError(this.id, "buildOrder");
  }
  async submitOrder(_signed: unknown): Promise<SubmitResult> {
    throw new NotImplementedError(this.id, "submitOrder");
  }
  async getOrderStatus(_ref: string): Promise<SubmitResult> {
    throw new NotImplementedError(this.id, "getOrderStatus");
  }
}
