import type { AccountSnapshot, MarketSnapshot, OrderDraft, Position, TradeSide } from "./types";

export interface PortfolioExposure {
  longNotionalUsd: number;
  shortNotionalUsd: number;
  netExposureUsd: number;
  grossExposureUsd: number;
  largestPosition?: {
    symbol: string;
    notionalUsd: number;
    side: TradeSide;
  };
  highestLiquidationRisk?: {
    symbol: string;
    distancePct: number;
    side: TradeSide;
  };
  selectedMarketNotionalUsd: number;
}

export interface DraftImpact {
  estimatedNotionalUsd: number;
  marginRequiredUsd: number;
  postTradeAvailableUsd: number;
  addedExposureUsd: number;
  selectedMarketConcentrationPct: number;
  liquidationDistancePct: number;
  estimatedLiquidationPrice: number;
}

export type PortfolioRiskLabel =
  | "low margin use"
  | "crowded exposure"
  | "near liquidation"
  | "unhedged beta"
  | "paper only";

export function calculatePositionNotional(position: Position): number {
  return Math.abs(position.size * position.markPrice);
}

function liquidationDistancePct(position: Position): number {
  if (position.markPrice <= 0) {
    return 0;
  }
  return Math.abs(position.markPrice - position.liquidationPrice) / position.markPrice * 100;
}

export function estimateDraftLiquidation(args: {
  side: TradeSide;
  entryPrice: number;
  leverage: number;
}): number {
  const maintenance = 0.006;
  return args.side === "long"
    ? args.entryPrice * (1 - 1 / args.leverage + maintenance)
    : args.entryPrice * (1 + 1 / args.leverage - maintenance);
}

export function calculatePortfolioExposure(
  account: AccountSnapshot,
  selectedSymbol?: string,
): PortfolioExposure {
  let longNotionalUsd = 0;
  let shortNotionalUsd = 0;
  let selectedMarketNotionalUsd = 0;
  let largestPosition: PortfolioExposure["largestPosition"];
  let highestLiquidationRisk: PortfolioExposure["highestLiquidationRisk"];

  for (const position of account.positions) {
    const notionalUsd = calculatePositionNotional(position);
    if (position.side === "long") {
      longNotionalUsd += notionalUsd;
    } else {
      shortNotionalUsd += notionalUsd;
    }
    if (selectedSymbol && position.symbol === selectedSymbol) {
      selectedMarketNotionalUsd += notionalUsd;
    }
    if (!largestPosition || notionalUsd > largestPosition.notionalUsd) {
      largestPosition = { symbol: position.symbol, notionalUsd, side: position.side };
    }

    const distancePct = liquidationDistancePct(position);
    if (!highestLiquidationRisk || distancePct < highestLiquidationRisk.distancePct) {
      highestLiquidationRisk = { symbol: position.symbol, distancePct, side: position.side };
    }
  }

  const netExposureUsd = longNotionalUsd - shortNotionalUsd;
  return {
    longNotionalUsd,
    shortNotionalUsd,
    netExposureUsd,
    grossExposureUsd: longNotionalUsd + shortNotionalUsd,
    largestPosition,
    highestLiquidationRisk,
    selectedMarketNotionalUsd,
  };
}

export function calculateDraftImpact(args: {
  account: AccountSnapshot;
  market: MarketSnapshot;
  draft: OrderDraft;
  entryPrice?: number;
}): DraftImpact {
  const entryPrice =
    args.entryPrice ??
    (args.draft.orderType === "limit" && args.draft.limitPrice ? args.draft.limitPrice : args.market.markPrice);
  const estimatedNotionalUsd = Math.max(0, args.draft.sizeBtc * entryPrice);
  const marginRequiredUsd = args.draft.leverage > 0 ? estimatedNotionalUsd / args.draft.leverage : estimatedNotionalUsd;
  const exposure = calculatePortfolioExposure(args.account, args.market.symbol);
  const signedAddedExposure = args.draft.side === "long" ? estimatedNotionalUsd : -estimatedNotionalUsd;
  const selectedMarketPostNotional = exposure.selectedMarketNotionalUsd + estimatedNotionalUsd;
  const grossPostExposure = exposure.grossExposureUsd + estimatedNotionalUsd;
  const estimatedLiquidationPrice = estimateDraftLiquidation({
    side: args.draft.side,
    entryPrice,
    leverage: Math.max(1, args.draft.leverage),
  });
  const liquidationDistancePct =
    entryPrice > 0 ? Math.abs(entryPrice - estimatedLiquidationPrice) / entryPrice * 100 : 0;

  return {
    estimatedNotionalUsd,
    marginRequiredUsd,
    postTradeAvailableUsd: args.account.availableUsd - marginRequiredUsd,
    addedExposureUsd: signedAddedExposure,
    selectedMarketConcentrationPct:
      grossPostExposure > 0 ? selectedMarketPostNotional / grossPostExposure * 100 : 0,
    liquidationDistancePct,
    estimatedLiquidationPrice,
  };
}

export function classifyPortfolioRisk(args: {
  account: AccountSnapshot;
  exposure: PortfolioExposure;
  selectedSymbol?: string;
  mode?: "paper" | "live";
}): PortfolioRiskLabel[] {
  const labels: PortfolioRiskLabel[] = [];
  const marginUsePct = args.account.equityUsd > 0 ? args.account.marginUsedUsd / args.account.equityUsd * 100 : 0;
  const netToEquityPct = args.account.equityUsd > 0 ? Math.abs(args.exposure.netExposureUsd) / args.account.equityUsd * 100 : 0;
  const largestToGrossPct =
    args.exposure.grossExposureUsd > 0 && args.exposure.largestPosition
      ? args.exposure.largestPosition.notionalUsd / args.exposure.grossExposureUsd * 100
      : 0;

  if (args.mode === "paper") {
    labels.push("paper only");
  }
  if (marginUsePct < 25) {
    labels.push("low margin use");
  }
  if (largestToGrossPct >= 65 || (args.selectedSymbol && args.exposure.selectedMarketNotionalUsd / Math.max(1, args.exposure.grossExposureUsd) >= 0.6)) {
    labels.push("crowded exposure");
  }
  if (args.exposure.highestLiquidationRisk && args.exposure.highestLiquidationRisk.distancePct <= 12) {
    labels.push("near liquidation");
  }
  if (netToEquityPct >= 75) {
    labels.push("unhedged beta");
  }

  return labels.length > 0 ? labels : ["low margin use"];
}
