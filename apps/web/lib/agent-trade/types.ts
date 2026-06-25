export type EligibilityMode =
  | "loading"
  | "liveEligible"
  | "restricted"
  | "unknown"
  | "paper"
  | "killSwitchDisabled";

export interface EligibilityResponse {
  state: EligibilityMode;
  executionVenue: string;
  mainnetExecutionEnabled: boolean;
  killSwitchEnabled: boolean;
  minOrderNotionalUsd: number;
  orderNotionalCapUsd: number;
  dailyNotionalCapUsd: number;
}

export type TradeSide = "long" | "short";
export type OrderType = "market" | "limit";
export type MarginMode = "isolated" | "cross";
export type DataSource = "mock" | "live-mainnet";
export type AccountValueKind = "paper" | "real" | "hybrid" | "unavailable";

export interface MarketSnapshot {
  symbol: string;
  base: string;
  venue: string;
  assetIndex: number;
  szDecimals: number;
  maxLeverage: number;
  markPrice: number;
  oraclePrice: number;
  change24hPct: number;
  change24hAbs: number;
  fundingRatePct: number;
  openInterestUsd: number;
  openInterestChangePct: number | null;
  volume24hUsd: number;
  liquidityUsd: number;
  nextFundingMinutes: number;
  dataAgeSeconds: number;
  source: DataSource;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface RecentTrade {
  side: "buy" | "sell";
  price: number;
  size: number;
  timestamp: number;
}

export interface Position {
  symbol: string;
  base: string;
  side: TradeSide;
  mode?: "paper" | "live";
  updatedAt?: number;
  orderCount?: number;
  lastFillId?: string;
  size: number;
  leverage: number;
  marginMode: MarginMode;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  pnlUsd: number;
  pnlPct: number;
  marginUsd: number;
  fundingUsd: number;
  takeProfit?: number;
  stopLoss?: number;
}

export interface OpenOrder {
  oid?: number;
  assetIndex?: number;
  symbol: string;
  side: "buy" | "sell";
  type: OrderType;
  mode?: "paper" | "live";
  price: number;
  size: number;
  reduceOnly: boolean;
  timestamp: number;
  cancelAction?: {
    type: "cancel";
    cancels: { a: number; o: number }[];
  };
}

export interface Fill {
  symbol: string;
  side: "buy" | "sell";
  mode?: "paper" | "live";
  orderId?: string;
  fromAgent?: boolean;
  price: number;
  size: number;
  feeUsd: number;
  timestamp: number;
}

export interface AccountSnapshot {
  address: `0x${string}`;
  valueKind?: AccountValueKind;
  sourceLabel?: string;
  liveAccountDataLoaded?: boolean;
  liveAccountDataUnavailable?: boolean;
  updatedAt?: number;
  equityUsd: number;
  availableUsd: number;
  marginUsedUsd: number;
  unrealizedPnlUsd: number;
  dailyLiveNotionalUsedUsd: number;
  simulatedBalanceUsd: number;
  positions: Position[];
  openOrders: OpenOrder[];
  fills: Fill[];
}

export interface SharedTradingSnapshot {
  asOf: number;
  market: MarketSnapshot;
  orderBook: {
    bids: BookLevel[];
    asks: BookLevel[];
  };
  recentTrades: RecentTrade[];
  account: AccountSnapshot;
}

export interface ChartAnnotation {
  id: string;
  kind: "liquidationCluster" | "invalidation" | "target" | "support" | "resistance";
  price: number;
  label: string;
  tone: "green" | "red" | "amber" | "blue";
}

export interface OrderDraft {
  symbol: string;
  side: TradeSide;
  orderType: OrderType;
  sizeBtc: number;
  leverage: number;
  marginMode: MarginMode;
  reduceOnly: boolean;
  limitPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  fromAgent: boolean;
  scenarioId?: string;
}

export interface AgentReceipt {
  label: string;
  value: string;
  timestamp: number;
}

export interface AgentResponse {
  id: string;
  state: "tradeProposal" | "answered" | "noTrade" | "staleRefusal";
  question: string;
  thesis: string;
  receipts: AgentReceipt[];
  riskNote: string;
  whyWrong: string;
  orderDraft?: OrderDraft;
  annotations: ChartAnnotation[];
  followUps?: string[];
}

export interface PaperOrder {
  id: string;
  draft: OrderDraft;
  estimatedEntry: number;
  notionalUsd: number;
  createdAt: number;
}

export interface PaperAccountSnapshot {
  sessionId: string;
  ledgerRevision?: number;
  updatedAt?: number;
  equityUsd: number;
  availableUsd: number;
  marginUsedUsd: number;
  unrealizedPnlUsd: number;
  simulatedBalanceUsd: number;
  positions: Position[];
  openOrders: OpenOrder[];
  fills: Fill[];
}
