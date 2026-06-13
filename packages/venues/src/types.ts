/**
 * The venue abstraction — the core of the multi-venue platform.
 *
 * Every trading venue (Hyperliquid, Lighter, Ostium, ...) implements `Venue`.
 * The hard part is that the three launch venues do not share a signing model or
 * a settlement model, so the interface is built around two discriminated unions
 * rather than HL's single "build EIP-712 → sign → POST /exchange" assumption:
 *
 *   Signing model — what the client actually signs:
 *     - "eip712"   Hyperliquid: a phantom-agent typed-data envelope (chainId 1337
 *                  for L1 actions; user-signed for approvals). One hash to sign.
 *     - "venueSig" Lighter: a payload signed with a venue-registered L2 API key
 *                  (not an Ethereum personal-sign / typed-data envelope).
 *     - "evmTx"    Ostium: a real Arbitrum transaction (open/close trade on the
 *                  Trading contract). The "signature" is a signed EVM tx and the
 *                  "send" is an on-chain broadcast.
 *
 *   Settlement model — how a submitted order resolves:
 *     - "sync"     Hyperliquid / Lighter: the submit response carries the fill
 *                  or resting order id.
 *     - "asyncOnchain" Ostium: submit broadcasts a tx; an oracle/keeper executes
 *                  it a few blocks later, so the final state arrives via polling
 *                  getOrderStatus, not the submit response.
 *
 * Keeping these explicit is what lets one platform UI/API drive all three
 * without leaking venue-specific lifecycle assumptions into the app layer.
 */

export type VenueId = "hyperliquid" | "lighter" | "ostium";

export type MarketKind = "perp" | "spot" | "prediction";

export type SigningModel = "eip712" | "venueSig" | "evmTx";

export type SettlementModel = "sync" | "asyncOnchain";

/** What a venue can do — lets the UI/API hide controls a venue doesn't support. */
export interface VenueCapabilities {
  signing: SigningModel;
  settlement: SettlementModel;
  kinds: MarketKind[];
  /** Trades cost on-chain gas (Ostium). Drives the paymaster/funding UX. */
  requiresGas: boolean;
  /** We can attach a builder/referral code and earn on routed flow (HL today). */
  earnsBuilderFee: boolean;
  /** Reduce-only / TP-SL / priority-fee support, etc. — extend as needed. */
  reduceOnly: boolean;
}

/** Venue-agnostic market handle. `id` is namespaced: "hyperliquid:BTC". */
export interface VenueMarket {
  /** Fully-qualified market id, "<venue>:<symbol>". */
  id: string;
  venue: VenueId;
  /** Venue-native symbol ("BTC", "EUR/USD", "#10"). */
  symbol: string;
  kind: MarketKind;
  /** Size decimals — round size to this before submitting (HL rejects extras). */
  szDecimals: number;
  /** Price decimals where the venue enforces them; undefined if oracle-priced. */
  pxDecimals?: number;
  maxLeverage?: number;
}

export type OrderSide = "buy" | "sell";

export type TimeInForce = "gtc" | "ioc" | "alo" | "market";

/** Venue-agnostic order request from the app layer. */
export interface BuildOrderInput {
  /** Fully-qualified market id ("hyperliquid:BTC") or bare symbol if unambiguous. */
  market: string;
  side: OrderSide;
  size: string;
  /** Omit for market orders. */
  price?: string;
  tif?: TimeInForce;
  reduceOnly?: boolean;
}

/** A signing request the client must satisfy, tagged by model. */
export type SigningRequest =
  | {
      kind: "eip712";
      /** EIP-712 typed data the client signs; `hash` is its digest. */
      typedData: unknown;
      hash: `0x${string}`;
      /** Echoed back unchanged on submit (HL nonce is part of the signed action). */
      nonce: number;
    }
  | {
      kind: "venueSig";
      /** Opaque payload the Lighter L2 key signs. */
      payload: unknown;
      scheme: string;
    }
  | {
      kind: "evmTx";
      /** Unsigned Arbitrum tx fields; client signs and broadcasts. */
      tx: { to: `0x${string}`; data: `0x${string}`; value: string; chainId: number };
      gasHint?: string;
    };

/** Result of buildOrder — what to sign, plus any builder-fee we attached. */
export interface BuildResult {
  venue: VenueId;
  signing: SigningRequest;
  /** Builder/referral fee attached, in the venue's wire units, if any. */
  builderFeeWire?: number;
}

/** Result of submitOrder. For asyncOnchain venues, `status` starts "pending". */
export interface SubmitResult {
  venue: VenueId;
  status: "filled" | "resting" | "pending" | "rejected";
  /** Venue order id / tx hash for follow-up. */
  ref?: string;
  /** Raw venue response, for debugging / analytics. */
  raw?: unknown;
}

/**
 * One venue adapter. Read methods (listMarkets) work without signing; write
 * methods follow build → (client signs) → submit. asyncOnchain venues also need
 * getOrderStatus polling after submit.
 */
export interface Venue {
  readonly id: VenueId;
  readonly capabilities: VenueCapabilities;
  listMarkets(): Promise<VenueMarket[]>;
  buildOrder(input: BuildOrderInput): Promise<BuildResult>;
  submitOrder(signed: unknown): Promise<SubmitResult>;
  getOrderStatus(ref: string): Promise<SubmitResult>;
}

/** Thrown by adapter methods that aren't wired yet, so callers can branch. */
export class NotImplementedError extends Error {
  constructor(venue: VenueId, op: string) {
    super(`${venue}: ${op} not implemented yet`);
    this.name = "NotImplementedError";
  }
}
