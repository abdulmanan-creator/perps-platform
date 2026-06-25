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
