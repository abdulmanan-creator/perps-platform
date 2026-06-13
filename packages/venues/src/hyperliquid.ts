/**
 * Hyperliquid venue adapter.
 *
 * This is the venue we already have a full engine for — inherited from the
 * builder-codes repo this platform was forked from. The build-sign-send logic,
 * EIP-712 phantom-agent envelope, builder-fee injection, signature recovery,
 * and HL client all live under apps/api (helpers/eip712, helpers/builder,
 * helpers/hash, helpers/hlClient, routes/exchange).
 *
 * Migration plan: those helpers move into this package (packages/venues/
 * hyperliquid/*) so the adapter owns the full lifecycle and apps/api becomes a
 * thin venue-router. Until that extraction lands, buildOrder/submitOrder
 * delegate to the existing relay route and throw NotImplementedError here so
 * the boundary is explicit. listMarkets is implemented directly — proving an
 * adapter can serve a venue end-to-end through this interface.
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

const HL_MAINNET_INFO = "https://api.hyperliquid.xyz/info";

interface HlMetaResponse {
  universe?: { name: string; szDecimals: number; maxLeverage: number }[];
}

export class HyperliquidVenue implements Venue {
  readonly id = "hyperliquid" as const;

  readonly capabilities: VenueCapabilities = {
    signing: "eip712",
    settlement: "sync",
    kinds: ["perp", "spot", "prediction"],
    requiresGas: false,
    earnsBuilderFee: true,
    reduceOnly: true,
  };

  constructor(private readonly infoUrl: string = HL_MAINNET_INFO) {}

  async listMarkets(): Promise<VenueMarket[]> {
    const res = await fetch(this.infoUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "meta" }),
    });
    if (!res.ok) throw new Error(`hyperliquid: /info meta ${res.status}`);
    const meta = (await res.json()) as HlMetaResponse;
    const universe = meta.universe ?? [];
    return universe.map((a) => ({
      id: `hyperliquid:${a.name}`,
      venue: this.id,
      symbol: a.name,
      kind: "perp" as const,
      szDecimals: a.szDecimals,
      maxLeverage: a.maxLeverage,
    }));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async buildOrder(_input: BuildOrderInput): Promise<BuildResult> {
    // Reuse apps/api/src/helpers/builder.ts (injectBuilder, feeBpsFor) +
    // helpers/hash.ts (phantomAgentTypedData) once extracted into this package.
    throw new NotImplementedError(this.id, "buildOrder (pending helper extraction from apps/api)");
  }

  async submitOrder(_signed: unknown): Promise<SubmitResult> {
    // Reuse apps/api/src/helpers/hlClient.ts (forward to HL /exchange) +
    // helpers/verify.ts (recoverActionSigner) once extracted.
    throw new NotImplementedError(this.id, "submitOrder (pending helper extraction from apps/api)");
  }

  async getOrderStatus(_ref: string): Promise<SubmitResult> {
    // HL settles synchronously — status comes back on submit. This exists for
    // interface parity with asyncOnchain venues (Ostium).
    throw new NotImplementedError(this.id, "getOrderStatus");
  }
}
