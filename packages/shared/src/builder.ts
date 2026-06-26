/**
 * HL clearinghouse balance for a wallet. Returned by GET /balance?user=0x...
 *
 * - `accountValue` is the total perp account value in USD (positions + USDC + unrealized PnL).
 * - `withdrawable` is the USDC the user can withdraw right now (account value minus margin used).
 * - `marginUsed` is the USDC currently posted as initial/maintenance margin for open positions.
 *
 * For "did the builder earn a fee" the right number to watch is `accountValue` —
 * builder fee credits land in the perp account and bump it.
 */
export interface BalanceState {
  user: `0x${string}`;
  accountValue: string;
  withdrawable: string;
  marginUsed: string;
  /** Number of open perp positions. */
  openPositions: number;
}

/**
 * One open perp position, shaped from HL clearinghouseState.assetPositions.
 * String-typed numerics mirror HL's wire format (avoids float drift; render
 * layers format as needed).
 */
export interface PerpPosition {
  coin: string;
  /** Absolute position size in coin units (HL's szi is signed; we split sign into `side`). */
  size: string;
  side: "long" | "short";
  entryPx: string;
  /** Current USD value of the position. */
  positionValue: string;
  unrealizedPnl: string;
  /** Fractional return on equity, e.g. "0.05" = +5%. */
  returnOnEquity: string;
  /** Null when there's no liquidation price (e.g. fully collateralized). */
  liquidationPx: string | null;
  leverage: number;
  leverageMode: "cross" | "isolated";
  marginUsed: string;
}

/** Response from GET /positions?user=0x... */
export interface PositionsResponse {
  user: `0x${string}`;
  positions: PerpPosition[];
}

/**
 * One resting order, as returned by POST /openOrders. `cancelAction` is the
 * exact action to feed back into /exchange (or /agent/exchange) to cancel it.
 */
export interface OpenOrder {
  oid: number;
  assetIndex: number;
  side: "buy" | "sell";
  limitPx: string;
  /** Remaining size. */
  sz: string;
  /** Original size at placement. */
  origSz: string;
  timestamp: number;
  cancelAction: import("./action.js").CancelAction;
}

/** Response from POST /openOrders { user }. */
export interface OpenOrdersResponse {
  user: `0x${string}`;
  orders: OpenOrder[];
}

/** Response from GET /agent?user=0x... — the user's derived agent wallet. */
export interface AgentState {
  user: `0x${string}`;
  agentAddress: `0x${string}`;
  agentName: string;
  /** True iff this agent is registered in HL's extraAgents for the user. */
  approved: boolean;
  /** HL expiry timestamp (ms) for the delegation, when known. */
  validUntil: number | null;
}

/**
 * Approval-state response from GET /approval?user=0x...
 *
 * Maps Hyperliquid's `maxBuilderFee` raw int into something the UI can render.
 */
export interface ApprovalState {
  /** Builder address the approval state was checked against. */
  builder: `0x${string}`;
  /** True iff the user has approved any positive fee for our builder. */
  approved: boolean;
  /** Human-friendly percentage, e.g. "0.04%" or "1%". */
  maxFeeRate: string;
  /** Raw integer Hyperliquid returns (basis points * 10, per their API). */
  maxFeeRaw: number;
  /** True iff the approved cap is high enough to route perps at our configured fee. */
  canTradePerps: boolean;
  /** True iff the approved cap is high enough to route spot at our configured fee. */
  canTradeSpot: boolean;
  feeBreakdown: {
    configuredPerpsBps: number;
    configuredSpotBps: number;
    protocolMaxPerpsBps: number;
    protocolMaxSpotBps: number;
  };
}
