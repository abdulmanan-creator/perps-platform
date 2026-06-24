import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";

import { ApiException } from "../errors.js";
import { HlClient } from "../helpers/hlClient.js";
import { TtlCache, cachedAsync } from "../helpers/ttlCache.js";

const supportedIntervals = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
] as const;
type SupportedInterval = (typeof supportedIntervals)[number];

const intervalMs: Record<SupportedInterval, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "3d": 3 * 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
  "1M": 30 * 24 * 60 * 60_000,
};

/**
 * GET /agent-trade/candles?symbol=BTC-USD&interval=15m
 *
 * Read-only Agent.trade chart data. Proxies Hyperliquid's public
 * `candleSnapshot` info request and maps it into the lightweight-charts shape.
 */
export async function agentTradeCandlesRoute(app: FastifyInstance): Promise<void> {
  const hl = new HlClient({
    baseUrl: app.config.HYPERLIQUID_API_URL,
    logger: { warn: app.log.warn.bind(app.log) },
  });
  const metaCache = new TtlCache<Promise<Map<string, string>>>({ ttlMs: 60_000, maxEntries: 4 });

  app.get("/agent-trade/candles", async (req, reply) => {
    let q;
    try {
      q = z
        .object({
          symbol: z.string().min(1),
          interval: z.enum(supportedIntervals).default("15m"),
        })
        .parse(req.query);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ApiException(
          "INVALID_PARAMS",
          "Bad query: provide ?symbol=BTC-USD&interval=15m.",
          `Supported intervals: ${supportedIntervals.join(", ")}.`,
        );
      }
      throw err;
    }

    const supportedSymbols = await cachedAsync(metaCache, "perp-symbols", async () => fetchPerpSymbols(hl));
    const coin = supportedSymbols.get(normalizePerpSymbol(q.symbol));
    if (!coin) {
      throw new ApiException(
        "INVALID_PARAMS",
        `Unsupported Hyperliquid perp symbol: ${q.symbol}.`,
        "Use a perpetual symbol from /markets, e.g. BTC-USD or ETH-USD.",
      );
    }

    const fetchedAt = Date.now();
    const endTime = fetchedAt;
    const startTime = endTime - intervalMs[q.interval] * 180;
    const raw = await hl.info<HlCandle[]>({
      type: "candleSnapshot",
      req: {
        coin,
        interval: q.interval,
        startTime,
        endTime,
      },
    });
    const candles = raw.map(mapHlCandle).filter((candle): candle is Candle => candle !== null);

    return reply.send({
      symbol: `${coin}-USD`,
      interval: q.interval,
      candles,
      source: "hyperliquid",
      fetchedAt,
    });
  });
}

async function fetchPerpSymbols(hl: HlClient): Promise<Map<string, string>> {
  const meta = await hl.info<HlMeta>({ type: "meta" });
  return new Map((meta.universe ?? []).map((asset) => [normalizePerpSymbol(asset.name), asset.name]));
}

function normalizePerpSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  return normalized.replace(/-PERP$/u, "").replace(/-USD$/u, "");
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function mapHlCandle(raw: HlCandle): Candle | null {
  const timeMs = numberFrom(raw.t);
  const open = numberFrom(raw.o);
  const high = numberFrom(raw.h);
  const low = numberFrom(raw.l);
  const close = numberFrom(raw.c);
  const volume = numberFrom(raw.v);

  if (
    timeMs === null ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null
  ) {
    return null;
  }

  return {
    time: Math.floor(timeMs / 1000),
    open,
    high,
    low,
    close,
    volume,
  };
}

function numberFrom(value: string | number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface HlMeta {
  universe: Array<{ name: string }>;
}

export interface HlCandle {
  t?: number;
  T?: number;
  s?: string;
  i?: string;
  o?: string | number;
  c?: string | number;
  h?: string | number;
  l?: string | number;
  v?: string | number;
  n?: number;
}
