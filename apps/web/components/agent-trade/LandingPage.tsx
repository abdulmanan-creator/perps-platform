import Link from "next/link";

import { fmtCompactUsd, fmtPct, fmtUsd } from "@/lib/agent-trade/format";
import { MOCK_TRADING_SNAPSHOT } from "@/lib/agent-trade/mock-data";

const snapshot = MOCK_TRADING_SNAPSHOT;
const market = snapshot.market;

export function LandingPage() {
  return (
    <main className="public-page">
      <PublicNav />
      <section className="public-hero">
        <div className="public-hero-copy">
          <p className="at-kicker">Agent-native Hyperliquid terminal</p>
          <h1>Find better trades with an agent-native Hyperliquid terminal.</h1>
          <p>
            Agent.trade reads market context, explains the setup, annotates the chart, and drafts the ticket.
            The user stays in control and confirms every order.
          </p>
          <div className="public-cta-row">
            <Link className="primary-link" href="/onboarding">Start paper trading</Link>
            <Link className="secondary-action compact-button" href="/terminal">Open terminal</Link>
          </div>
          <div className="public-proof-row">
            <span>Mainnet read-only market data</span>
            <span>Testnet-default execution</span>
            <span>Paper mode first</span>
          </div>
        </div>
        <ProductProof />
      </section>

      <section className="public-section public-section-tight">
        <div>
          <p className="at-kicker">Core loop</p>
          <h2>Market read, agent thesis, ticket draft, human confirmation.</h2>
        </div>
        <div className="public-feature-grid">
          <Feature
            title="Hyperliquid-first execution"
            body="Agent.trade is built around crypto perps from Hyperliquid, with execution guarded through the app's confirmation and eligibility flow."
          />
          <Feature
            title="Agent-driven discovery"
            body="The embedded agent uses funding, OI, book pressure, liquidations, and portfolio context to explain why a setup is or is not clean."
          />
          <Feature
            title="Realistic market context"
            body="The MVP prefers mainnet read-only market data where practical, while live execution defaults to Hyperliquid testnet."
          />
          <Feature
            title="Paper before live"
            body="New testers can explore markets, ask the agent, and submit simulated orders before connecting live trading."
          />
          <Feature
            title="Wallet and funding readiness"
            body="Onboarding explains eligibility, wallet connection, testnet funding, and planned provider-dependent on-ramp paths without pretending they are live."
          />
          <Feature
            title="Human risk controls"
            body="The agent drafts. The user confirms. Restricted or unknown eligibility cannot submit live orders."
          />
        </div>
      </section>

      <section className="public-band">
        <div>
          <p className="at-kicker">Connectors</p>
          <h2>Bring trade reads into AI conversations without bypassing the terminal.</h2>
          <p>
            Connector surfaces are designed for asking Claude, ChatGPT, or future assistants for a market read.
            Proposals still route back to Agent.trade for review, risk acknowledgement, and confirmation.
          </p>
        </div>
        <Link className="secondary-action compact-button" href="/connectors">View connectors</Link>
      </section>
    </main>
  );
}

function PublicNav() {
  return (
    <header className="public-nav">
      <Link className="at-brand public-brand" href="/">
        <span className="at-brand-mark">A</span>
        <span>
          <strong>Agent.trade</strong>
          <small>Agent-native perps terminal</small>
        </span>
      </Link>
      <nav aria-label="Public navigation">
        <Link href="/terminal">Terminal</Link>
        <Link href="/markets">Markets</Link>
        <Link href="/portfolio">Portfolio</Link>
        <Link href="/connectors">Connectors</Link>
      </nav>
      <Link className="primary-link nav-cta" href="/onboarding">Start paper trading</Link>
    </header>
  );
}

function ProductProof() {
  const proposalSize = 0.03;
  const notional = proposalSize * market.markPrice;
  return (
    <div className="product-proof" aria-label="Agent.trade terminal preview">
      <div className="proof-topbar">
        <span>Agent.trade terminal</span>
        <strong>{market.symbol}</strong>
        <em>{market.source === "mock" ? "demo snapshot" : "mainnet read"}</em>
      </div>
      <div className="proof-stats">
        <Metric label="Mark" value={fmtUsd(market.markPrice, 1)} tone="pos" />
        <Metric label="Funding" value={fmtPct(market.fundingRatePct)} />
        <Metric label="Open interest" value={fmtCompactUsd(market.openInterestUsd)} />
        <Metric label="24h volume" value={fmtCompactUsd(market.volume24hUsd)} />
      </div>
      <div className="proof-body">
        <div className="proof-chart">
          <div className="proof-chart-head">
            <span>{market.base} perpetual</span>
            <strong>Agent annotated chart</strong>
          </div>
          <svg viewBox="0 0 620 300" role="img" aria-label="Mock Agent.trade chart with annotation lines">
            <defs>
              <linearGradient id="landingChartFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="rgba(39, 214, 170, 0.24)" />
                <stop offset="100%" stopColor="rgba(39, 214, 170, 0)" />
              </linearGradient>
            </defs>
            {[70, 125, 180, 235].map((y) => <line key={y} x1="20" x2="600" y1={y} y2={y} />)}
            <path d="M22 242 L78 224 L132 235 L190 188 L248 202 L304 152 L360 170 L420 121 L480 132 L540 86 L598 103 L598 280 L22 280 Z" />
            <polyline points="22,242 78,224 132,235 190,188 248,202 304,152 360,170 420,121 480,132 540,86 598,103" />
            <line className="proof-annotation amber" x1="22" x2="598" y1="96" y2="96" />
            <line className="proof-annotation red" x1="22" x2="598" y1="232" y2="232" />
          </svg>
          <span className="chart-callout amber">Liq cluster {fmtUsd(market.markPrice * 1.012, 0)}</span>
          <span className="chart-callout red">Invalidation {fmtUsd(market.markPrice * 0.972, 0)}</span>
        </div>
        <div className="proof-agent">
          <span>Embedded agent</span>
          <strong>Controlled long draft</strong>
          <p>
            {market.base} is holding the upper range while funding is still modest at {fmtPct(market.fundingRatePct)}.
            Draft only with defined invalidation.
          </p>
          <div className="receipt-row proof-receipts">
            <span>OI: {fmtCompactUsd(market.openInterestUsd)}</span>
            <span>Funding: {fmtPct(market.fundingRatePct)}</span>
            <span>Volume: {fmtCompactUsd(market.volume24hUsd)}</span>
          </div>
          <div className="proof-ticket">
            <span>Draft ticket</span>
            <strong>Long {proposalSize.toFixed(2)} {market.base}</strong>
            <em>Notional {fmtUsd(notional, 0)} · 3x isolated</em>
            <Link href="/terminal">Review in terminal</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric(props: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div>
      <span>{props.label}</span>
      <strong className={props.tone}>{props.value}</strong>
    </div>
  );
}

function Feature(props: { title: string; body: string }) {
  return (
    <article className="public-feature">
      <strong>{props.title}</strong>
      <p>{props.body}</p>
    </article>
  );
}
