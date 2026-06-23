export type EligibilityMode =
  | "loading"
  | "liveEligible"
  | "restricted"
  | "unknown"
  | "paper"
  | "killSwitchDisabled";

export type TradeSide = "long" | "short";
export type OrderType = "market" | "limit";
export type MarginMode = "isolated" | "cross";
export type DataSource = "mock" | "live-mainnet";

export interface MarketSnapshot {
  symbol: string;
  base: string;
  venue: string;
  assetIndex: number;
  markPrice: number;
  oraclePrice: number;
  change24hPct: number;
  change24hAbs: number;
  fundingRatePct: number;
  openInterestUsd: number;
  openInterestChangePct: number;
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
  symbol: string;
  side: "buy" | "sell";
  type: OrderType;
  price: number;
  size: number;
  reduceOnly: boolean;
  timestamp: number;
}

export interface Fill {
  symbol: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  feeUsd: number;
  timestamp: number;
}

export interface AccountSnapshot {
  address: `0x${string}`;
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
