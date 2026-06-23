"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { fmtCompactUsd, fmtNumber, fmtPct, fmtUsd } from "@/lib/agent-trade/format";
import {
  filterAndSortMarkets,
  joinPerpMarkets,
  loadMarketDiscoverySnapshot,
  type JoinedMarket,
  type MarketFilterKey,
  type MarketSortKey,
} from "@/lib/agent-trade/markets";

const MOCK_MARKETS = joinPerpMarkets({
  markets: {
    perps: [
      { name: "BTC", assetIndex: 0, szDecimals: 5, maxLeverage: 40 },
      { name: "ETH", assetIndex: 1, szDecimals: 4, maxLeverage: 25 },
      { name: "SOL", assetIndex: 5, szDecimals: 2, maxLeverage: 20 },
    ],
  },
  stats: {
    perps: [
      {
        name: "BTC",
        assetIndex: 0,
        markPx: "104820.5",
        prevDayPx: "102624.1",
        dayNtlVlm: "1940000000",
        openInterest: "45983.3",
        funding: "0.00012",
      },
      {
        name: "ETH",
        assetIndex: 1,
        markPx: "3820.25",
        prevDayPx: "3655.8",
        dayNtlVlm: "980000000",
        openInterest: "590122.1",
        funding: "0.00034",
      },
      {
        name: "SOL",
        assetIndex: 5,
        markPx: "147.82",
        prevDayPx: "151.36",
        dayNtlVlm: "420000000",
        openInterest: "1020042",
        funding: "-0.00008",
      },
    ],
  },
});

const filters: { key: MarketFilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "opportunities", label: "Opportunities" },
  { key: "funding", label: "Funding" },
  { key: "volume", label: "Volume" },
  { key: "movers", label: "Movers" },
];

const sorts: { key: MarketSortKey; label: string }[] = [
  { key: "volume", label: "Volume" },
  { key: "openInterest", label: "Open interest" },
  { key: "change", label: "24h move" },
  { key: "funding", label: "Funding" },
  { key: "symbol", label: "Symbol" },
];

export function MarketsClient() {
  const [markets, setMarkets] = useState<JoinedMarket[]>(MOCK_MARKETS);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MarketFilterKey>("all");
  const [sort, setSort] = useState<MarketSortKey>("volume");
  const [source, setSource] = useState<"live-mainnet" | "mock">("mock");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      try {
        const next = await loadMarketDiscoverySnapshot();
        if (!cancelled && next.markets.length > 0) {
          setMarkets(next.markets);
          setSource(next.source);
          setError(undefined);
        }
      } catch {
        if (!cancelled) {
          setMarkets(MOCK_MARKETS);
          setSource("mock");
          setError("Live market scanner unavailable. Showing deterministic fallback data.");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleMarkets = useMemo(
    () => filterAndSortMarkets({ markets, query, filter, sort }),
    [markets, query, filter, sort],
  );

  return (
    <main className="markets-page">
      <section className="markets-head">
        <div>
          <p className="at-kicker">Milestone 2A scanner</p>
          <h1>Markets</h1>
          <p>
            Rule-based opportunity discovery from Hyperliquid market metadata and live stats. No LLM ranking yet.
          </p>
        </div>
        <div className="markets-health">
          <span className={source === "live-mainnet" ? "state-pill live" : "state-pill stale"}>
            {source === "live-mainnet" ? "Live mainnet read" : "Mock fallback"}
          </span>
          <span>{isLoading ? "Refreshing..." : `${markets.length} perps`}</span>
        </div>
      </section>

      <section className="markets-toolbar">
        <label>
          <span>Search</span>
          <input value={query} placeholder="BTC, ETH, SOL..." onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="markets-tabs">
          {filters.map((item) => (
            <button key={item.key} className={filter === item.key ? "active" : ""} onClick={() => setFilter(item.key)}>
              {item.label}
            </button>
          ))}
        </div>
        <label>
          <span>Sort</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as MarketSortKey)}>
            {sorts.map((item) => (
              <option key={item.key} value={item.key}>{item.label}</option>
            ))}
          </select>
        </label>
      </section>

      {error ? <p className="market-notice">{error}</p> : null}

      <section className="panel markets-table-panel">
        <div className="markets-row markets-row-head">
          <span>Market</span>
          <span>Mark</span>
          <span>24h</span>
          <span>Funding</span>
          <span>Open interest</span>
          <span>OI 24h</span>
          <span>Volume</span>
          <span>Max lev</span>
          <span>Opportunity</span>
        </div>
        {visibleMarkets.map((market) => (
          <Link key={market.symbol} className="markets-row" href={`/terminal?symbol=${market.symbol}`}>
            <strong>{market.displaySymbol}</strong>
            <span>{fmtUsd(market.markPrice, market.markPrice > 1000 ? 1 : 4)}</span>
            <span className={market.change24hPct >= 0 ? "pos" : "neg"}>
              {fmtPct(market.change24hPct, 2)}
            </span>
            <span className={market.fundingRatePct >= 0 ? "pos" : "neg"}>{fmtPct(market.fundingRatePct, 4)}</span>
            <span>{fmtCompactUsd(market.openInterestUsd)}</span>
            <span>{market.openInterestChangePct === null ? "--" : fmtPct(market.openInterestChangePct, 1)}</span>
            <span>{fmtCompactUsd(market.volume24hUsd)}</span>
            <span>{fmtNumber(market.maxLeverage, 0)}x</span>
            <span className="opportunity-tags">
              {market.opportunityLabels.map((label) => (
                <em key={label}>{label}</em>
              ))}
            </span>
          </Link>
        ))}
        {visibleMarkets.length === 0 ? (
          <div className="markets-empty">No markets match the current scanner filters.</div>
        ) : null}
      </section>
    </main>
  );
}

