export type PredictionSide = 0 | 1;

export interface PredictionOutcomeSide {
  side: PredictionSide;
  name: string;
  encoding: number;
  coin: string;
  assetId: number;
}

export interface PredictionOutcome {
  outcome: number;
  name: string;
  description: string;
  quoteToken: string;
  sides: [PredictionOutcomeSide, PredictionOutcomeSide];
}

export interface PredictionQuestionMetadata {
  category?: string;
  subCategory?: string;
  raw?: string;
}

export interface PredictionSettlementSummary {
  state: "open" | "partiallySettled" | "settled";
  settledNamedOutcomeIds: number[];
}

export interface PredictionQuestion {
  questionId: number;
  name: string;
  description: string;
  criteria: string;
  metadata: PredictionQuestionMetadata | null;
  quoteToken: string | null;
  quoteTokens: string[];
  fallbackOutcome: PredictionOutcome | null;
  namedOutcomes: PredictionOutcome[];
  settlement: PredictionSettlementSummary;
}

export interface PredictionDepthSummary {
  bidLevels: number;
  askLevels: number;
  bidSize: number;
  askSize: number;
  bidNotional: number;
  askNotional: number;
}

export interface PredictionSideOdds extends PredictionOutcomeSide {
  bestBid: string | null;
  bestAsk: string | null;
  midpointProbability: number | null;
  spread: number | null;
  depth: PredictionDepthSummary;
  emptyBook: boolean;
  fetchedAt: number;
}

export interface PredictionOutcomeOdds {
  outcome: number;
  name: string;
  description: string;
  quoteToken: string;
  sides: [PredictionSideOdds, PredictionSideOdds];
}

export interface PredictionQuestionOdds {
  questionId: number;
  name: string;
  fetchedAt: number;
  outcomes: PredictionOutcomeOdds[];
}

export interface PredictionSettlementState {
  outcome: number;
  state: "unresolved" | "resolved";
  isResolved: boolean;
  resolvedSide: PredictionSide | null;
  raw: unknown;
  fetchedAt: number;
}

export interface PredictionPaperOrderRequest {
  questionId: number;
  questionName: string;
  outcome: number;
  outcomeName: string;
  side: PredictionSide;
  sideName: string;
  contracts: number;
  limitProbability: number;
  currentProbability: number | null;
  quoteToken: string;
  criteriaAcknowledged: boolean;
  fromAgent?: boolean;
}

export interface PredictionPaperFill {
  id: string;
  mode: "paper";
  questionId: number;
  questionName: string;
  outcome: number;
  outcomeName: string;
  side: PredictionSide;
  sideName: string;
  contracts: number;
  limitProbability: number;
  cost: number;
  maxPayout: number;
  maxProfit: number;
  maxLoss: number;
  breakEvenProbability: number;
  currentProbability: number | null;
  quoteToken: string;
  timestamp: number;
  fromAgent: boolean;
}

export interface PredictionPaperPosition {
  key: string;
  mode: "paper";
  questionId: number;
  questionName: string;
  outcome: number;
  outcomeName: string;
  side: PredictionSide;
  sideName: string;
  contracts: number;
  avgCost: number;
  totalCost: number;
  currentProbability: number | null;
  currentValue: number | null;
  maxPayout: number;
  maxProfit: number;
  maxLoss: number;
  unrealizedPnl: number | null;
  quoteToken: string;
  resolutionStatus: PredictionSettlementSummary["state"];
  updatedAt: number;
}

export interface PredictionPaperAccount {
  sessionId: string;
  mode: "paper";
  ledgerRevision: number;
  updatedAt: number;
  positions: PredictionPaperPosition[];
  fills: PredictionPaperFill[];
}

export interface PredictionLiveOrderRequest {
  questionId: number;
  outcome: number;
  side: PredictionSide;
  action: "buy" | "sell";
  contracts: number;
  limitProbability: number;
  tif: "Ioc" | "Gtc";
  criteriaAcknowledged: boolean;
  liveAcknowledged: boolean;
}

export interface PredictionLiveOrderTechnicalDetails {
  encoding: number;
  coin: string;
  assetId: number;
  quoteToken: string;
}

export interface PredictionSpotBalance {
  coin: string;
  token: number | string | null;
  total: string;
  hold: string;
  available: string;
  entryNtl: string | null;
}

export interface PredictionBalanceState {
  user: `0x${string}`;
  source: "spotClearinghouseState";
  spotUsdc: PredictionSpotBalance;
  spotUsdcAvailable: string;
  perpWithdrawable: string | null;
  maxTransferableUsdc: string | null;
  balances: PredictionSpotBalance[];
  outcomeBalances: PredictionSpotBalance[];
  fetchedAt: number;
  guidance: string;
}

export interface PredictionUsdcTransferAction {
  type: "usdClassTransfer";
  hyperliquidChain: "Mainnet" | "Testnet";
  signatureChainId: `0x${string}`;
  amount: string;
  toPerp: false;
  nonce: number;
}

export type PredictionUsdcTransferState =
  | "built"
  | "submitted"
  | "rejected"
  | "balance_unavailable"
  | "insufficient_perp_balance";

export interface PredictionUsdcTransferBuildResponse {
  status: "built";
  state: PredictionUsdcTransferState;
  hash: `0x${string}`;
  nonce: number;
  action: PredictionUsdcTransferAction;
  typedData: import("./action.js").EIP712TypedData;
  amount: string;
  direction: "perp_to_spot";
  balance: PredictionBalanceState;
}

export interface PredictionUsdcTransferSendResponse {
  status: "submitted";
  state: PredictionUsdcTransferState;
  success: true;
  user: `0x${string}`;
  action: PredictionUsdcTransferAction;
  exchangeResponse: unknown;
  exchangeResult: {
    status: "filled" | "resting" | "accepted" | "rejected";
    label: string;
    reason?: string;
  };
}
