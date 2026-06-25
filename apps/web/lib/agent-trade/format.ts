export function fmtUsd(value: number, digits = 0): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

export interface HyperliquidPricePrecision {
  szDecimals: number;
  isSpot?: boolean;
}

export interface MarketPriceDisplayArgs {
  price: number;
  market: HyperliquidPricePrecision;
}

export interface MarketPriceChartFormat {
  precision: number;
  minMove: number;
}

export function fmtCompactUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function fmtAdaptiveUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: adaptivePriceDecimals(value),
    minimumFractionDigits: 0,
  }).format(value);
}

export function fmtMarketUsd(args: MarketPriceDisplayArgs): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: marketPriceDisplayDecimals(args),
    minimumFractionDigits: 0,
  }).format(args.price);
}

export function fmtMarketNumber(args: MarketPriceDisplayArgs): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: marketPriceDisplayDecimals(args),
    minimumFractionDigits: 0,
  }).format(args.price);
}

export function fmtPct(value: number, digits = 3): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function fmtNumber(value: number, digits = 2): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

export function hyperliquidMaxPriceDecimals(market: HyperliquidPricePrecision): number {
  const maxDecimals = market.isSpot ? 8 : 6;
  return Math.max(0, maxDecimals - market.szDecimals);
}

export function marketPriceDisplayDecimals(args: MarketPriceDisplayArgs): number {
  const maxDecimals = hyperliquidMaxPriceDecimals(args.market);
  if (!Number.isFinite(args.price) || args.price === 0) {
    return Math.min(maxDecimals, 2);
  }

  const absPrice = Math.abs(args.price);
  if (absPrice >= 10_000) {
    return Math.min(maxDecimals, 1);
  }

  const integerDigits = absPrice >= 1 ? Math.floor(absPrice).toString().length : 0;
  const significantFigureDecimals = Math.max(0, 5 - integerDigits);
  return Math.min(maxDecimals, significantFigureDecimals);
}

export function marketPriceChartFormat(args: MarketPriceDisplayArgs): MarketPriceChartFormat {
  const precision = marketPriceDisplayDecimals(args);
  return {
    precision,
    minMove: precision === 0 ? 1 : 1 / 10 ** precision,
  };
}

function adaptivePriceDecimals(value: number): number {
  if (!Number.isFinite(value)) {
    return 2;
  }
  const absValue = Math.abs(value);
  if (absValue >= 10_000) {
    return 1;
  }
  if (absValue >= 100) {
    return 2;
  }
  if (absValue >= 1) {
    return 4;
  }
  return 6;
}

export function fmtAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(1, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  return `${Math.floor(minutes / 60)}h ago`;
}
