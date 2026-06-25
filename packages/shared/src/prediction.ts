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
