import { API_BASE_URL } from "../api";

import type { BookLevel, MarketSnapshot } from "./types";

export interface PerpAssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  assetIndex: number;
}

export interface MarketStatWire {
  assetIndex: number;
  name: string;
  markPx?: string;
  midPx?: string;
  prevDayPx?: string;
  dayNtlVlm?: string;
  openInterest?: string;
  funding?: string;
}

export interface MarketsWireResponse {
  perps?: PerpAssetMeta[];
}

export interface MarketStatsWireResponse {
  perps?: MarketStatWire[];
}

export type OpportunityLabel =
  | "OI expansion"
  | "funding elevated"
  | "high volume"
  | "range mover"
  | "watch only";

export interface JoinedMarket {
  symbol: string;
  displaySymbol: string;
  base: string;
  assetIndex: number;
  szDecimals: number;
  maxLeverage: number;
  markPrice: number;
  midPrice: number;
  prevDayPrice: number;
  change24hPct: number;
  change24hAbs: number;
  fundingRatePct: number;
  openInterestUsd: number;
  openInterestChangePct: number | null;
  volume24hUsd: number;
  opportunityLabels: OpportunityLabel[];
}

export type MarketSortKey = "volume" | "change" | "funding" | "openInterest" | "symbol";
export type MarketFilterKey = "all" | "opportunities" | "funding" | "volume" | "movers";

export interface MarketDiscoverySnapshot {
  markets: JoinedMarket[];
  asOf: number;
  source: "live-mainnet" | "mock";
}

export interface L2BookWireResponse {
  levels?: {
    px: string;
    sz: string;
  }[][];
}

function num(input: string | number | undefined, fallback: number): number {
  if (input === undefined) {
    return fallback;
  }
  const parsed = typeof input === "number" ? input : Number(input);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeSymbol(input: string | null | undefined): string {
  const raw = (input ?? "BTC").trim().toUpperCase();
  return raw.replace(/-USD$|\/USD$|USDC$/u, "") || "BTC";
}

export const MARKET_SYMBOL_ALIASES: Record<string, string[]> = {
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "ether", "eth"],
  HYPE: ["hyperliquid", "hype"],
  SOL: ["solana", "sol"],
};

export function marketSearchAliases(symbol: string): string[] {
  const normalized = normalizeSymbol(symbol);
  return MARKET_SYMBOL_ALIASES[normalized] ?? [];
}

export function joinPerpMarkets(args: {
  markets: MarketsWireResponse;
  stats: MarketStatsWireResponse;
}): JoinedMarket[] {
  const statsByIndex = new Map((args.stats.perps ?? []).map((stat) => [stat.assetIndex, stat]));
  return (args.markets.perps ?? [])
    .map((meta) => {
      const stat = statsByIndex.get(meta.assetIndex) ?? args.stats.perps?.find((item) => item.name === meta.name);
      const markPrice = num(stat?.markPx ?? stat?.midPx, 0);
      const midPrice = num(stat?.midPx ?? stat?.markPx, markPrice);
      const prevDayPrice = num(stat?.prevDayPx, markPrice);
      const change24hAbs = markPrice - prevDayPrice;
      const change24hPct = prevDayPrice > 0 ? (change24hAbs / prevDayPrice) * 100 : 0;
      const fundingRatePct = num(stat?.funding, 0) * 100;
      const openInterestBase = num(stat?.openInterest, 0);
      const openInterestUsd = openInterestBase * markPrice;
      const volume24hUsd = num(stat?.dayNtlVlm, 0);
      const market: Omit<JoinedMarket, "opportunityLabels"> = {
        symbol: meta.name,
        displaySymbol: `${meta.name}-USD`,
        base: meta.name,
        assetIndex: meta.assetIndex,
        szDecimals: meta.szDecimals,
        maxLeverage: meta.maxLeverage,
        markPrice,
        midPrice,
        prevDayPrice,
        change24hAbs,
        change24hPct,
        fundingRatePct,
        openInterestUsd,
        openInterestChangePct: null,
        volume24hUsd,
      };
      return {
        ...market,
        opportunityLabels: classifyOpportunity(market),
      };
    })
    .filter((market) => market.markPrice > 0);
}

export function classifyOpportunity(
  market: Omit<JoinedMarket, "opportunityLabels">,
): OpportunityLabel[] {
  const labels: OpportunityLabel[] = [];
  const volumeToOi = market.openInterestUsd > 0 ? market.volume24hUsd / market.openInterestUsd : 0;

  if (market.openInterestChangePct !== null && market.openInterestChangePct >= 5) {
    labels.push("OI expansion");
  } else if (market.openInterestUsd >= 1_000_000_000 && volumeToOi >= 0.35) {
    labels.push("OI expansion");
  }
  if (Math.abs(market.fundingRatePct) >= 0.03) {
    labels.push("funding elevated");
  }
  if (market.volume24hUsd >= 500_000_000) {
    labels.push("high volume");
  }
  if (Math.abs(market.change24hPct) >= 5) {
    labels.push("range mover");
  }

  return labels.length > 0 ? labels : ["watch only"];
}

export function filterAndSortMarkets(args: {
  markets: JoinedMarket[];
  query: string;
  filter: MarketFilterKey;
  sort: MarketSortKey;
}): JoinedMarket[] {
  const query = args.query.trim().toUpperCase();
  return args.markets
    .filter((market) => {
      if (
        query &&
        !normalizeSymbol(market.symbol).includes(query) &&
        !normalizeSymbol(market.displaySymbol).includes(query)
      ) {
        return false;
      }
      if (args.filter === "opportunities") {
        return !market.opportunityLabels.includes("watch only");
      }
      if (args.filter === "funding") {
        return market.opportunityLabels.includes("funding elevated");
      }
      if (args.filter === "volume") {
        return market.opportunityLabels.includes("high volume");
      }
      if (args.filter === "movers") {
        return market.opportunityLabels.includes("range mover");
      }
      return true;
    })
    .sort((a, b) => {
      if (args.sort === "symbol") {
        return a.symbol.localeCompare(b.symbol);
      }
      if (args.sort === "change") {
        return Math.abs(b.change24hPct) - Math.abs(a.change24hPct);
      }
      if (args.sort === "funding") {
        return Math.abs(b.fundingRatePct) - Math.abs(a.fundingRatePct);
      }
      if (args.sort === "openInterest") {
        return b.openInterestUsd - a.openInterestUsd;
      }
      return b.volume24hUsd - a.volume24hUsd;
    });
}

export function sortMarketsForSelector(markets: JoinedMarket[]): JoinedMarket[] {
  return [...markets].sort((a, b) => b.volume24hUsd - a.volume24hUsd || a.symbol.localeCompare(b.symbol));
}

export function filterMarketsForSelector(markets: JoinedMarket[], query: string): JoinedMarket[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return sortMarketsForSelector(markets);
  }

  const rawQuery = trimmed.toLowerCase();
  const symbolQuery = normalizeSymbol(trimmed).toLowerCase();

  return sortMarketsForSelector(markets).filter((market) => {
    const haystack = [
      market.symbol,
      market.displaySymbol,
      market.base,
      ...marketSearchAliases(market.symbol),
    ].map((value) => value.toLowerCase());

    return haystack.some((value) => value.includes(rawQuery) || value.includes(symbolQuery));
  });
}

export function resolveSelectedMarket(args: {
  symbol: string | null | undefined;
  markets: JoinedMarket[];
  fallbackSymbol?: string;
}): JoinedMarket | undefined {
  const wanted = normalizeSymbol(args.symbol);
  const fallback = normalizeSymbol(args.fallbackSymbol);
  return (
    args.markets.find((market) => normalizeSymbol(market.symbol) === wanted) ??
    args.markets.find((market) => normalizeSymbol(market.displaySymbol) === wanted) ??
    args.markets.find((market) => normalizeSymbol(market.symbol) === fallback) ??
    args.markets.find((market) => normalizeSymbol(market.displaySymbol) === fallback) ??
    args.markets[0]
  );
}

export function parseBookLevels(levels: { px: string; sz: string }[] | undefined): BookLevel[] {
  return (levels ?? []).slice(0, 8).map((level) => ({
    price: num(level.px, 0),
    size: num(level.sz, 0),
  }));
}

export function estimateTopBookLiquidityUsd(book: { asks: BookLevel[]; bids: BookLevel[] }): number {
  return [...book.asks, ...book.bids].reduce((sum, level) => sum + level.price * level.size, 0);
}

export function marketToSnapshot(market: JoinedMarket, book: { asks: BookLevel[]; bids: BookLevel[] }): MarketSnapshot {
  return {
    symbol: market.displaySymbol,
    base: market.base,
    venue: "Hyperliquid",
    assetIndex: market.assetIndex,
    szDecimals: market.szDecimals,
    maxLeverage: market.maxLeverage,
    markPrice: market.markPrice,
    oraclePrice: market.midPrice || market.markPrice,
    change24hPct: market.change24hPct,
    change24hAbs: market.change24hAbs,
    fundingRatePct: market.fundingRatePct,
    openInterestUsd: market.openInterestUsd,
    openInterestChangePct: market.openInterestChangePct,
    volume24hUsd: market.volume24hUsd,
    liquidityUsd: estimateTopBookLiquidityUsd(book),
    nextFundingMinutes: 42,
    dataAgeSeconds: 0,
    source: "live-mainnet",
  };
}

export async function loadMarketDiscoverySnapshot(): Promise<MarketDiscoverySnapshot> {
  const [marketsRes, statsRes] = await Promise.all([
    fetch(`${API_BASE_URL}/markets`, { cache: "no-store" }),
    fetch(`${API_BASE_URL}/marketStats`, { cache: "no-store" }),
  ]);
  if (!marketsRes.ok || !statsRes.ok) {
    throw new Error("market discovery request failed");
  }
  const [markets, stats] = (await Promise.all([
    marketsRes.json(),
    statsRes.json(),
  ])) as [MarketsWireResponse, MarketStatsWireResponse];

  return {
    markets: joinPerpMarkets({ markets, stats }),
    asOf: Date.now(),
    source: "live-mainnet",
  };
}
