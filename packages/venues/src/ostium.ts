/**
 * Ostium venue adapter (stub).
 *
 * Ostium is a real-world-asset perp DEX (FX, commodities, indices) on Arbitrum.
 * Trades are on-chain contract calls against its Trading contract, oracle-priced
 * and executed by a keeper a few blocks after submission — so this is the one
 * venue that is signing="evmTx" AND settlement="asyncOnchain", and requiresGas.
 *
 * That combination is why the Venue interface carries getOrderStatus and an
 * evmTx signing variant: after submitOrder broadcasts the tx, the final fill
 * arrives via polling, not the submit response. requiresGas drives the product
 * decision (fund ETH on Arbitrum via the embedded wallet, or relayer/paymaster).
 * No builder-fee primitive — earnsBuilderFee is false.
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

export class OstiumVenue implements Venue {
  readonly id = "ostium" as const;

  readonly capabilities: VenueCapabilities = {
    signing: "evmTx",
    settlement: "asyncOnchain",
    kinds: ["perp"],
    requiresGas: true,
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
