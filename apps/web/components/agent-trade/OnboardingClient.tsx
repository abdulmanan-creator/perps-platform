"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";

import { API_BASE_URL } from "@/lib/api";
import { formatWalletAddress, getEligibilityDisplay } from "@/lib/agent-trade/onboarding";
import type { EligibilityMode } from "@/lib/agent-trade/types";

interface EligibilityResponse {
  state: EligibilityMode;
  executionVenue: string;
  mainnetExecutionEnabled: boolean;
  killSwitchEnabled: boolean;
  orderNotionalCapUsd: number;
  dailyNotionalCapUsd: number;
}

interface WalletSummary {
  status: "local-dev" | "loading" | "not-connected" | "connected";
  address?: string;
  walletType?: string;
  login?: () => void;
  logout?: () => void;
}

const HAS_PRIVY = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

export function OnboardingClient() {
  const [eligibility, setEligibility] = useState<EligibilityResponse>({
    state: "loading",
    executionVenue: "hyperliquid-testnet",
    mainnetExecutionEnabled: false,
    killSwitchEnabled: false,
    orderNotionalCapUsd: 250,
    dailyNotionalCapUsd: 1000,
  });

  useEffect(() => {
    let cancelled = false;

    async function loadEligibility() {
      try {
        const res = await fetch(`${API_BASE_URL}/agent-trade/eligibility`, { cache: "no-store" });
        if (!res.ok) {
          throw new Error("eligibility request failed");
        }
        const next = (await res.json()) as EligibilityResponse;
        if (!cancelled) {
          setEligibility(next);
        }
      } catch {
        if (!cancelled) {
          setEligibility((current) => ({ ...current, state: "unknown" }));
        }
      }
    }

    void loadEligibility();
    return () => {
      cancelled = true;
    };
  }, []);

  const display = getEligibilityDisplay(eligibility.state);

  return (
    <main className="onboarding-page">
      <section className="onboarding-head">
        <div>
          <p className="at-kicker">Account readiness</p>
          <h1>Account readiness</h1>
          <p>
            Set up Agent.trade for paper exploration first, then connect a wallet and funding path only if live trading is eligible.
          </p>
        </div>
        <div className="onboarding-actions">
          <Link className="secondary-action" href="/markets">View markets</Link>
          <Link className="primary-link" href="/terminal">Continue in paper mode</Link>
        </div>
      </section>

      <section className="onboarding-grid">
        <StatusCard eligibility={eligibility} />
        {HAS_PRIVY ? <PrivyWalletCard /> : <LocalDevWalletCard />}
      </section>

      <section className="onboarding-grid wide">
        <FundingCard eligibility={eligibility} />
        <RiskCard state={eligibility.state} />
      </section>

      <section className="onboarding-next panel">
        <div className="panel-head">
          <div>
            <span>Next actions</span>
            <strong>{display.label}</strong>
          </div>
        </div>
        <div className="next-action-grid">
          <ActionTile
            title="Paper trading"
            body="Explore markets, ask the agent, and submit simulated orders without a wallet."
            href="/terminal"
            cta="Open terminal"
            enabled={display.paperAvailable}
          />
          <ActionTile
            title="Market discovery"
            body="Scan mainnet read-only market data before drafting a trade."
            href="/markets"
            cta="View markets"
            enabled
          />
          <ActionTile
            title="Portfolio risk"
            body="Review the current hybrid account snapshot and draft impact context."
            href="/portfolio"
            cta="View portfolio"
            enabled
          />
          <ActionTile
            title="Live setup"
            body={display.liveTradingEnabled ? "Eligible for testnet-default live execution after confirmation." : display.summary}
            href="/terminal"
            cta="Open live ticket"
            enabled={display.liveTradingEnabled}
          />
        </div>
      </section>
    </main>
  );
}

function StatusCard({ eligibility }: { eligibility: EligibilityResponse }) {
  const display = getEligibilityDisplay(eligibility.state);
  const executionPolicy = eligibility.mainnetExecutionEnabled
    ? "Mainnet enabled by env"
    : "Hyperliquid testnet default";
  return (
    <div className="panel onboarding-card">
      <div className="panel-head">
        <div>
          <span>Eligibility</span>
          <strong>Server enforced</strong>
        </div>
        <span className={`readiness-pill ${display.tone}`}>{display.label}</span>
      </div>
      <div className="readiness-list">
        <ReadinessRow label="Paper mode" value={display.paperAvailable ? "Available" : "Unavailable"} ok={display.paperAvailable} />
        <ReadinessRow label="Live trading" value={display.liveTradingEnabled ? "Eligible" : "Disabled"} ok={display.liveTradingEnabled} />
        <ReadinessRow label="Live funding CTA" value={display.liveFundingEnabled ? "Enabled" : "Disabled"} ok={display.liveFundingEnabled} />
        <ReadinessRow label="Execution policy" value={executionPolicy} ok={!eligibility.mainnetExecutionEnabled} />
        <ReadinessRow label="Kill switch" value={eligibility.killSwitchEnabled ? "Active" : "Clear"} ok={!eligibility.killSwitchEnabled} />
        <ReadinessRow label="Mainnet execution" value={eligibility.mainnetExecutionEnabled ? "Enabled by env" : "Disabled by default"} ok={!eligibility.mainnetExecutionEnabled} />
      </div>
      <p className="onboarding-note">{display.summary}</p>
    </div>
  );
}

function PrivyWalletCard() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const activeWallet = useMemo(() => {
    const embedded = wallets.find((wallet) => wallet.walletClientType === "privy");
    return embedded ?? wallets[0];
  }, [wallets]);
  const wallet: WalletSummary = !ready
    ? { status: "loading" }
    : authenticated && activeWallet
      ? {
          status: "connected",
          address: activeWallet.address,
          walletType: activeWallet.walletClientType,
          logout,
        }
      : { status: "not-connected", login };

  return <WalletCard wallet={wallet} />;
}

function LocalDevWalletCard() {
  return <WalletCard wallet={{ status: "local-dev" }} />;
}

function WalletCard({ wallet }: { wallet: WalletSummary }) {
  const connected = wallet.status === "connected";
  const title =
    wallet.status === "local-dev"
      ? "Local dev"
      : wallet.status === "loading"
        ? "Checking session"
        : connected
          ? "Wallet connected"
          : "Not connected";

  return (
    <div className="panel onboarding-card">
      <div className="panel-head">
        <div>
          <span>Wallet</span>
          <strong>{title}</strong>
        </div>
        <span className={`readiness-pill ${connected ? "green" : "amber"}`}>
          {connected ? "Connected" : "Paper-ready"}
        </span>
      </div>
      <div className="wallet-summary">
        <span>Address</span>
        <strong>{formatWalletAddress(wallet.address)}</strong>
        <span>Provider</span>
        <strong>{wallet.walletType ?? (wallet.status === "local-dev" ? "Privy env missing" : "Not selected")}</strong>
      </div>
      <p className="onboarding-note">
        Wallet connection does not authorize autonomous live trading. In the
        current MVP flow, the agent researches, explains, and drafts; every
        live order returns to Agent.trade for explicit confirmation.
      </p>
      {wallet.status === "local-dev" ? (
        <p className="local-dev-note">Set NEXT_PUBLIC_PRIVY_APP_ID to enable the Privy sign-in modal. Paper exploration works without it.</p>
      ) : null}
      <div className="card-actions">
        {wallet.login ? <button className="primary-action compact-button" onClick={wallet.login}>Connect wallet</button> : null}
        {wallet.logout ? <button className="secondary-action compact-button" onClick={wallet.logout}>Disconnect</button> : null}
        <Link className="secondary-action compact-button" href="/terminal">Skip to paper</Link>
      </div>
    </div>
  );
}

function FundingCard({ eligibility }: { eligibility: EligibilityResponse }) {
  const display = getEligibilityDisplay(eligibility.state);
  return (
    <div className="panel onboarding-card funding-card">
      <div className="panel-head">
        <div>
          <span>Funding shell</span>
          <strong>Deposit readiness</strong>
        </div>
        <span className={`readiness-pill ${display.liveFundingEnabled ? "green" : "amber"}`}>
          {display.liveFundingEnabled ? "Live funding ready" : "Paper first"}
        </span>
      </div>
      <div className="funding-methods">
        <FundingMethod
          title="Crypto deposit"
          body="Fund Hyperliquid with USDC on Arbitrum, then return to Agent.trade to trade from the terminal."
          status={display.liveFundingEnabled ? "Eligible account" : "Disabled until live eligible"}
          enabled={display.liveFundingEnabled}
        />
        <FundingMethod
          title="Testnet funds"
          body="MVP execution defaults to Hyperliquid testnet. Internal testers should use the configured testnet funding path before live order smoke tests."
          status="Internal tester guidance"
          enabled
        />
        <FundingMethod
          title="Bank/card on-ramp"
          body="Planned provider-dependent entry point. Apple Pay, PayPal, Venmo, and cards stay placeholders until provider/legal review."
          status="Not integrated"
          enabled={false}
        />
      </div>
      <p className="onboarding-note">
        Restricted or unknown eligibility disables live funding CTAs. Use paper mode for product testing.
      </p>
    </div>
  );
}

function RiskCard({ state }: { state: EligibilityMode }) {
  const display = getEligibilityDisplay(state);
  return (
    <div className="panel onboarding-card">
      <div className="panel-head">
        <div>
          <span>Risk controls</span>
          <strong>Self-directed trading</strong>
        </div>
      </div>
      <div className="risk-copy-list">
        <p>Leveraged perpetuals can lose more than expected if sizing and liquidation risk are misunderstood.</p>
        <p>In the current MVP flow, orders require Agent.trade confirmation. Permissioned agent execution is future roadmap work with scopes, caps, revocation, eligibility checks, audit logs, and kill switches.</p>
        <p>Live orders remain guarded by server-side eligibility, caps, terms acknowledgement, and the kill switch.</p>
        <p>Where the edge jurisdiction gate blocks an entire restricted region, visitors may see the restricted page instead of app surfaces.</p>
        <p>{display.summary}</p>
      </div>
    </div>
  );
}

function ReadinessRow(props: { label: string; value: string; ok: boolean }) {
  return (
    <div className="readiness-row">
      <span>{props.label}</span>
      <strong className={props.ok ? "pos" : "neg"}>{props.value}</strong>
    </div>
  );
}

function FundingMethod(props: { title: string; body: string; status: string; enabled: boolean }) {
  return (
    <div className={`funding-method ${props.enabled ? "enabled" : "disabled"}`}>
      <strong>{props.title}</strong>
      <p>{props.body}</p>
      <span>{props.status}</span>
    </div>
  );
}

function ActionTile(props: { title: string; body: string; href: string; cta: string; enabled: boolean }) {
  return (
    <div className={`action-tile ${props.enabled ? "" : "disabled"}`}>
      <strong>{props.title}</strong>
      <p>{props.body}</p>
      {props.enabled ? <Link href={props.href}>{props.cta}</Link> : <span>{props.cta}</span>}
    </div>
  );
}
