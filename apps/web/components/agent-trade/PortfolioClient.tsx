"use client";

import { useEffect, useMemo, useState } from "react";

import { loadTradingSnapshot } from "@/lib/agent-trade/data";
import { fmtAgo, fmtCompactUsd, fmtNumber, fmtPct, fmtUsd } from "@/lib/agent-trade/format";
import { MOCK_TRADING_SNAPSHOT } from "@/lib/agent-trade/mock-data";
import {
  calculatePortfolioExposure,
  classifyPortfolioRisk,
} from "@/lib/agent-trade/portfolio";
import type { SharedTradingSnapshot } from "@/lib/agent-trade/types";

export function PortfolioClient() {
  const [snapshot, setSnapshot] = useState<SharedTradingSnapshot>(MOCK_TRADING_SNAPSHOT);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      const result = await loadTradingSnapshot("BTC");
      if (!cancelled) {
        setSnapshot(result.snapshot);
        setIsLoading(false);
      }
    }

    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const exposure = useMemo(
    () => calculatePortfolioExposure(snapshot.account, snapshot.market.symbol),
    [snapshot.account, snapshot.market.symbol],
  );
  const riskLabels = useMemo(
    () => classifyPortfolioRisk({
      account: snapshot.account,
      exposure,
      selectedSymbol: snapshot.market.symbol,
      mode: "paper",
    }),
    [snapshot.account, exposure, snapshot.market.symbol],
  );
  const marginUsePct =
    snapshot.account.equityUsd > 0 ? snapshot.account.marginUsedUsd / snapshot.account.equityUsd * 100 : 0;

  return (
    <main className="portfolio-page">
      <section className="portfolio-head">
        <div>
          <p className="at-kicker">Portfolio risk</p>
          <h1>Portfolio</h1>
          <p>Hybrid market-read and paper account view. Paper positions are simulated and do not imply live Hyperliquid exposure.</p>
        </div>
        <div className="portfolio-health">
          <span className="state-pill live">{snapshot.market.source === "live-mainnet" ? "Mainnet market data" : "Mock account"}</span>
          <span>{isLoading ? "Refreshing..." : `Updated ${fmtAgo(snapshot.asOf)}`}</span>
        </div>
      </section>

      <section className="portfolio-grid">
        <div className="overview-grid">
          <Metric label="Equity" value={fmtUsd(snapshot.account.equityUsd, 2)} />
          <Metric label="Available" value={fmtUsd(snapshot.account.availableUsd, 2)} />
          <Metric label="Margin used" value={fmtUsd(snapshot.account.marginUsedUsd, 2)} detail={fmtPct(marginUsePct, 1)} />
          <Metric
            label="Unrealized PnL"
            value={fmtUsd(snapshot.account.unrealizedPnlUsd, 2)}
            tone={snapshot.account.unrealizedPnlUsd >= 0 ? "pos" : "neg"}
          />
          <Metric label="Sim balance" value={fmtUsd(snapshot.account.simulatedBalanceUsd, 2)} />
          <Metric label="Daily live notional" value={fmtUsd(snapshot.account.dailyLiveNotionalUsedUsd, 2)} />
        </div>

        <div className="panel exposure-panel">
          <div className="panel-head">
            <div>
              <span>Exposure summary</span>
              <strong>Book shape</strong>
            </div>
          </div>
          <div className="exposure-grid">
            <Metric label="Long notional" value={fmtUsd(exposure.longNotionalUsd, 0)} />
            <Metric label="Short notional" value={fmtUsd(exposure.shortNotionalUsd, 0)} />
            <Metric
              label="Net exposure"
              value={fmtUsd(exposure.netExposureUsd, 0)}
              tone={exposure.netExposureUsd >= 0 ? "pos" : "neg"}
            />
            <Metric label="Gross exposure" value={fmtUsd(exposure.grossExposureUsd, 0)} />
            <Metric
              label="Largest position"
              value={exposure.largestPosition ? exposure.largestPosition.symbol : "--"}
              detail={exposure.largestPosition ? fmtUsd(exposure.largestPosition.notionalUsd, 0) : undefined}
            />
            <Metric
              label="Highest liq risk"
              value={exposure.highestLiquidationRisk ? exposure.highestLiquidationRisk.symbol : "--"}
              detail={exposure.highestLiquidationRisk ? `${fmtNumber(exposure.highestLiquidationRisk.distancePct, 1)}% away` : undefined}
            />
          </div>
          <div className="risk-tags">
            {riskLabels.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="portfolio-tables">
        <div className="panel">
          <div className="panel-head">
            <div>
              <span>Positions</span>
              <strong>{snapshot.account.positions.length} open</strong>
            </div>
          </div>
          <div className="portfolio-table positions-table">
            <div className="portfolio-row portfolio-row-head">
              <span>Market</span>
              <span>Side</span>
              <span>Size</span>
              <span>Entry / mark</span>
              <span>PnL</span>
              <span>Margin</span>
              <span>Liq</span>
              <span>Funding</span>
              <span>TP / SL</span>
            </div>
            {snapshot.account.positions.map((position) => (
              <div key={`${position.symbol}-${position.mode ?? "demo"}`} className="portfolio-row">
                <strong>{position.symbol}{position.mode === "paper" ? <span className="paper-ledger-badge">Paper</span> : null}</strong>
                <span className={position.side === "long" ? "pos" : "neg"}>{position.side}</span>
                <span>{fmtNumber(position.size, 4)} {position.base}</span>
                <span>{fmtUsd(position.entryPrice, 1)} / {fmtUsd(position.markPrice, 1)}</span>
                <span className={position.pnlUsd >= 0 ? "pos" : "neg"}>{fmtUsd(position.pnlUsd, 2)} ({fmtPct(position.pnlPct, 1)})</span>
                <span>{fmtUsd(position.marginUsd, 2)}</span>
                <span>{fmtUsd(position.liquidationPrice, 1)}</span>
                <span className={position.fundingUsd >= 0 ? "pos" : "neg"}>{fmtUsd(position.fundingUsd, 2)}</span>
                <span>{position.takeProfit ? fmtUsd(position.takeProfit, 1) : "--"} / {position.stopLoss ? fmtUsd(position.stopLoss, 1) : "--"}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="portfolio-side-tables">
          <SmallTable
            title="Open orders"
            subtitle={`${snapshot.account.openOrders.length} working`}
            rows={snapshot.account.openOrders.map((order) => [
              order.mode === "paper" ? `${order.symbol} Paper` : order.symbol,
              order.side,
              order.type,
              fmtUsd(order.price, 1),
              `${fmtNumber(order.size, 4)} ${order.reduceOnly ? "RO" : ""}`,
            ])}
          />
          <SmallTable
            title="Recent fills"
            subtitle={`${snapshot.account.fills.length} fills`}
            rows={snapshot.account.fills.map((fill) => [
              fill.mode === "paper" ? `${fill.symbol} Paper` : fill.symbol,
              fill.side,
              fmtUsd(fill.price, 1),
              fmtNumber(fill.size, 4),
              `${fmtUsd(fill.feeUsd, 2)} ${fmtAgo(fill.timestamp, snapshot.asOf)}`,
            ])}
          />
        </div>
      </section>
    </main>
  );
}

function Metric(props: { label: string; value: string; detail?: string; tone?: "pos" | "neg" }) {
  return (
    <div className="metric-tile">
      <span>{props.label}</span>
      <strong className={props.tone}>{props.value}</strong>
      {props.detail ? <em>{props.detail}</em> : null}
    </div>
  );
}

function SmallTable(props: { title: string; subtitle: string; rows: string[][] }) {
  return (
    <div className="panel small-risk-table">
      <div className="panel-head">
        <div>
          <span>{props.title}</span>
          <strong>{props.subtitle}</strong>
        </div>
      </div>
      <div className="portfolio-table compact-risk-table">
        {props.rows.map((row) => (
          <div key={row.join("-")} className="portfolio-row">
            {row.map((cell, index) => index === 0 ? <strong key={cell}>{cell}</strong> : <span key={`${cell}-${index}`}>{cell}</span>)}
          </div>
        ))}
      </div>
    </div>
  );
}
