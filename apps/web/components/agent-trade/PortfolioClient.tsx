"use client";

import { useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";

import { API_BASE_URL } from "@/lib/api";
import {
  getAccountReadinessDisplay,
  type WalletReadinessSummary,
} from "@/lib/agent-trade/account-readiness";
import { loadTradingSnapshot } from "@/lib/agent-trade/data";
import { normalizeEligibilityResponse } from "@/lib/agent-trade/eligibility";
import { fmtAdaptiveUsd, fmtAgo, fmtCompactUsd, fmtNumber, fmtPct, fmtUsd } from "@/lib/agent-trade/format";
import { hypurrscanAddressUrl } from "@/lib/agent-trade/hypurrscan";
import { MOCK_TRADING_SNAPSHOT } from "@/lib/agent-trade/mock-data";
import { loadPaperAccount, mergePaperAccount } from "@/lib/agent-trade/paper";
import {
  calculatePortfolioExposure,
  classifyPortfolioRisk,
} from "@/lib/agent-trade/portfolio";
import type { EligibilityMode, Fill, OpenOrder, Position, SharedTradingSnapshot } from "@/lib/agent-trade/types";

const HAS_PRIVY = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
const LOCAL_DEV_WALLET: WalletReadinessSummary = { status: "local-dev" };

export function PortfolioClient() {
  if (HAS_PRIVY) {
    return <PrivyPortfolioClient />;
  }
  return <PortfolioExperience wallet={LOCAL_DEV_WALLET} />;
}

function PrivyPortfolioClient() {
  const wallet = usePortfolioWalletSummary();
  return <PortfolioExperience wallet={wallet} />;
}

function usePortfolioWalletSummary(): WalletReadinessSummary {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const activeWallet = useMemo(() => {
    const embedded = wallets.find((item) => item.walletClientType === "privy");
    return embedded ?? wallets[0];
  }, [wallets]);

  if (!ready) {
    return { status: "loading" };
  }
  if (authenticated && activeWallet) {
    return { status: "connected", address: activeWallet.address };
  }
  return { status: "not-connected" };
}

function PortfolioExperience({ wallet }: { wallet: WalletReadinessSummary }) {
  const [snapshot, setSnapshot] = useState<SharedTradingSnapshot>(MOCK_TRADING_SNAPSHOT);
  const [eligibility, setEligibility] = useState<EligibilityMode>("loading");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      const paperAccount = await loadPaperAccount();
      if (!cancelled && paperAccount && (paperAccount.positions.length > 0 || paperAccount.fills.length > 0)) {
        setSnapshot(mergePaperAccount(MOCK_TRADING_SNAPSHOT, paperAccount));
      }

      const result = await loadTradingSnapshot("BTC", {
        accountAddress: wallet.status === "connected" ? wallet.address : undefined,
      });
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
  }, [wallet.address, wallet.status]);

  useEffect(() => {
    let cancelled = false;

    async function loadEligibility() {
      try {
        const res = await fetch(`${API_BASE_URL}/agent-trade/eligibility`, {
          cache: "no-store",
        });
        const next = await normalizeEligibilityResponse(res);
        if (!cancelled) {
          setEligibility(next.state);
        }
      } catch {
        if (!cancelled) {
          setEligibility("unknown");
        }
      }
    }

    void loadEligibility();
    return () => {
      cancelled = true;
    };
  }, []);

  const accountReadiness = useMemo(
    () => getAccountReadinessDisplay({
      wallet,
      eligibilityState: eligibility,
      accountValueKind: snapshot.account.valueKind,
      liveAccountDataLoaded: snapshot.account.liveAccountDataLoaded,
      liveAccountDataUnavailable: snapshot.account.liveAccountDataUnavailable,
    }),
    [
      snapshot.account.liveAccountDataLoaded,
      snapshot.account.liveAccountDataUnavailable,
      snapshot.account.valueKind,
      eligibility,
      wallet.address,
      wallet.status,
    ],
  );
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
  const portfolioSummary = accountReadiness.accountValueKind === "real"
    ? "Read-only Hyperliquid account data is loaded. Live orders still require Agent.trade confirmation."
    : accountReadiness.accountValueKind === "unavailable"
      ? "Hyperliquid account state is unavailable. Live trading is disabled until account data refreshes; paper mode remains available."
      : `${accountReadiness.summary} Paper positions are simulated and do not imply live Hyperliquid exposure.`;
  const hypurrscanUrl = accountReadiness.accountValueKind === "real" || accountReadiness.accountValueKind === "hybrid"
    ? hypurrscanAddressUrl(wallet.address)
    : null;
  const hasRealAccountValues = accountReadiness.accountValueKind === "real" || accountReadiness.accountValueKind === "hybrid";

  return (
    <main className="portfolio-page">
      <section className="portfolio-head">
        <div>
          <p className="at-kicker">Portfolio risk</p>
          <h1>Portfolio</h1>
          <p>{portfolioSummary}</p>
        </div>
        <div className="portfolio-health">
          <span className={`readiness-pill ${accountReadiness.tone}`}>{accountReadiness.label}</span>
          <span className="state-pill live">{snapshot.market.source === "live-mainnet" ? "Mainnet market data" : "Deterministic market data"}</span>
          {hypurrscanUrl ? (
            <a className="hypurrscan-link" href={hypurrscanUrl} target="_blank" rel="noreferrer">
              View account on Hypurrscan
            </a>
          ) : null}
          <span>{isLoading ? "Refreshing..." : `Updated ${fmtAgo(snapshot.asOf)}`}</span>
        </div>
      </section>

      <section className="portfolio-grid">
        <div className="overview-grid">
          <Metric label={hasRealAccountValues ? "Account equity" : "Paper equity"} value={fmtUsd(snapshot.account.equityUsd, 2)} detail={accountReadiness.accountValueLabel} />
          <Metric label={hasRealAccountValues ? "Account available" : "Paper available"} value={fmtUsd(snapshot.account.availableUsd, 2)} />
          <Metric label="Margin used" value={fmtUsd(snapshot.account.marginUsedUsd, 2)} detail={fmtPct(marginUsePct, 1)} />
          <Metric
            label="Unrealized PnL"
            value={fmtUsd(snapshot.account.unrealizedPnlUsd, 2)}
            tone={snapshot.account.unrealizedPnlUsd >= 0 ? "pos" : "neg"}
          />
          <Metric
            label={hasRealAccountValues ? "Paper ledger" : "Paper balance"}
            value={hasRealAccountValues ? "Separate" : fmtUsd(snapshot.account.simulatedBalanceUsd, 2)}
            detail={hasRealAccountValues ? "Paper mode remains available but is not live exposure." : undefined}
          />
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
              <div key={positionRowKey(position)} className="portfolio-row">
                <strong>{position.symbol}{position.mode === "paper" ? <span className="paper-ledger-badge">Paper</span> : null}</strong>
                <span className={position.side === "long" ? "pos" : "neg"}>{position.side}</span>
                <span>{fmtNumber(position.size, 4)} {position.base}</span>
                <span>{fmtAdaptiveUsd(position.entryPrice)} / {fmtAdaptiveUsd(position.markPrice)}</span>
                <span className={position.pnlUsd >= 0 ? "pos" : "neg"}>{fmtUsd(position.pnlUsd, 2)} ({fmtPct(position.pnlPct, 1)})</span>
                <span>{fmtUsd(position.marginUsd, 2)}</span>
                <span>{fmtAdaptiveUsd(position.liquidationPrice)}</span>
                <span className={position.fundingUsd >= 0 ? "pos" : "neg"}>{fmtUsd(position.fundingUsd, 2)}</span>
                <span>{position.takeProfit ? fmtAdaptiveUsd(position.takeProfit) : "--"} / {position.stopLoss ? fmtAdaptiveUsd(position.stopLoss) : "--"}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="portfolio-side-tables">
          <SmallTable
            title="Open orders"
            subtitle={`${snapshot.account.openOrders.length} working`}
            rows={snapshot.account.openOrders.map((order) => ({
              key: openOrderRowKey(order),
              cells: [
                order.mode === "paper" ? `${order.symbol} Paper` : order.symbol,
                order.side,
                order.type,
                fmtAdaptiveUsd(order.price),
                `${fmtNumber(order.size, 4)} ${order.reduceOnly ? "RO" : ""}`,
              ],
            }))}
          />
          <SmallTable
            title="Recent fills"
            subtitle={`${snapshot.account.fills.length} fills`}
            rows={snapshot.account.fills.map((fill) => ({
              key: fillRowKey(fill),
              cells: [
                fill.mode === "paper" ? `${fill.symbol} Paper` : fill.symbol,
                fill.side,
                fmtAdaptiveUsd(fill.price),
                fmtNumber(fill.size, 4),
                `${fmtUsd(fill.feeUsd, 2)} ${fmtAgo(fill.timestamp, snapshot.asOf)}`,
              ],
            }))}
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

function positionRowKey(position: Position): string {
  return [
    position.mode ?? "demo",
    position.symbol,
    position.side,
    position.lastFillId ?? position.updatedAt ?? position.entryPrice,
  ].join("-");
}

function openOrderRowKey(order: OpenOrder): string {
  return [
    order.mode ?? "demo",
    order.symbol,
    order.side,
    order.timestamp,
  ].join("-");
}

function fillRowKey(fill: Fill): string {
  return [
    fill.mode ?? "demo",
    fill.symbol,
    fill.orderId ?? fill.timestamp,
    fill.side,
    fill.price,
    fill.size,
  ].join("-");
}

function SmallTable(props: { title: string; subtitle: string; rows: Array<{ key: string; cells: string[] }> }) {
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
          <div key={row.key} className="portfolio-row">
            {row.cells.map((cell, index) => index === 0 ? <strong key={cell}>{cell}</strong> : <span key={`${cell}-${index}`}>{cell}</span>)}
          </div>
        ))}
      </div>
    </div>
  );
}
