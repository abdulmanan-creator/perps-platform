import type {
  PredictionLiveOrderTechnicalDetails,
  PredictionSide,
} from "@alchemy-hl/shared";

const HIP4_OUTCOME_ASSET_OFFSET = 100_000_000;

export function hip4PredictionEncoding(outcome: number, side: PredictionSide): number {
  return 10 * outcome + side;
}

export function hip4PredictionCoin(outcome: number, side: PredictionSide): string {
  return `#${hip4PredictionEncoding(outcome, side)}`;
}

export function hip4PredictionAssetId(outcome: number, side: PredictionSide): number {
  return HIP4_OUTCOME_ASSET_OFFSET + hip4PredictionEncoding(outcome, side);
}

export function hip4PredictionTechnicalDetails(
  outcome: number,
  side: PredictionSide,
  quoteToken: string,
): PredictionLiveOrderTechnicalDetails {
  return {
    encoding: hip4PredictionEncoding(outcome, side),
    coin: hip4PredictionCoin(outcome, side),
    assetId: hip4PredictionAssetId(outcome, side),
    quoteToken,
  };
}
