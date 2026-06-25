"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useFundWallet, usePrivy, useWallets } from "@privy-io/react-auth";

import { API_BASE_URL } from "@/lib/api";
import {
  getAccountReadinessDisplay,
  getLiveTradingReadiness,
  type WalletReadinessSummary,
} from "@/lib/agent-trade/account-readiness";
import { getFundingDisplay } from "@/lib/agent-trade/funding";
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
  authStatus?: "not-configured" | "loading" | "unauthenticated" | "authenticated";
  address?: string;
  walletType?: string;
  walletKind?: "embedded" | "external" | "unknown";
  login?: () => void;
  logout?: () => void;
}

const HAS_PRIVY = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
const PRIVY_FUNDING_ENABLED = process.env.NEXT_PUBLIC_AGENT_TRADE_ENABLE_PRIVY_FUNDING === "true";
const HL_BRIDGE_DEPOSIT_ENABLED = process.env.NEXT_PUBLIC_AGENT_TRADE_ENABLE_HL_BRIDGE_DEPOSIT === "true";

export function OnboardingClient({ surface = "onboarding" }: { surface?: "onboarding" | "settings" }) {
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
  const copy = surface === "settings"
    ? {
        kicker: "Settings",
        title: "Agent.trade readiness",
        intro: "Review sign-in, wallet, eligibility, execution, and funding readiness before internal testnet trading.",
      }
    : {
        kicker: "Account readiness",
        title: "Account readiness",
        intro: "Set up Agent.trade for paper exploration first, then connect a wallet and funding path only if live trading is eligible.",
      };

  return (
    <main className="onboarding-page">
      <section className="onboarding-head">
        <div>
          <p className="at-kicker">{copy.kicker}</p>
          <h1>{copy.title}</h1>
          <p>{copy.intro}</p>
        </div>
        <div className="onboarding-actions">
          <Link className="secondary-action" href="/markets">View markets</Link>
          <Link className="primary-link" href="/terminal">Continue in paper mode</Link>
        </div>
      </section>

      <section className="onboarding-grid">
        <StatusCard eligibility={eligibility} />
        {HAS_PRIVY ? <PrivyWalletCard /> : <LocalDevWalletCard />}
        <AccountReadinessCardShell eligibility={eligibility} />
      </section>

      <section className="onboarding-grid wide">
        <FundingCardShell eligibility={eligibility} />
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
        <ReadinessRow label="Server funding eligibility" value={display.liveFundingEnabled ? "Eligible" : "Disabled"} ok={display.liveFundingEnabled} />
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
          authStatus: "authenticated",
          address: activeWallet.address,
          walletType: activeWallet.walletClientType,
          walletKind: walletKindForType(activeWallet.walletClientType),
          logout,
        }
      : authenticated
        ? { status: "not-connected", authStatus: "authenticated", login }
        : { status: "not-connected", authStatus: "unauthenticated", login };

  return <WalletCard wallet={wallet} />;
}

function LocalDevWalletCard() {
  return <WalletCard wallet={{ status: "local-dev", authStatus: "not-configured" }} />;
}

function useWalletSummary(): WalletSummary {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const activeWallet = useMemo(() => {
    const embedded = wallets.find((wallet) => wallet.walletClientType === "privy");
    return embedded ?? wallets[0];
  }, [wallets]);

  if (!ready) {
    return { status: "loading", authStatus: "loading" };
  }
  if (authenticated && activeWallet) {
    return {
      status: "connected",
      authStatus: "authenticated",
      address: activeWallet.address,
      walletType: activeWallet.walletClientType,
      walletKind: walletKindForType(activeWallet.walletClientType),
      logout,
    };
  }
  if (authenticated) {
    return { status: "not-connected", authStatus: "authenticated", login };
  }
  return { status: "not-connected", authStatus: "unauthenticated", login };
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
        <span>Sign-in</span>
        <strong>{authStatusLabel(wallet.authStatus)}</strong>
        <span>Address</span>
        <strong>{formatWalletAddress(wallet.address)}</strong>
        <span>Provider</span>
        <strong>{wallet.walletType ?? (wallet.status === "local-dev" ? "Privy env missing" : "Not selected")}</strong>
        <span>Wallet type</span>
        <strong>{walletKindLabel(wallet.walletKind)}</strong>
      </div>
      <p className="onboarding-note">
        Wallet connection does not change the current MVP confirmation
        requirement. The agent researches, explains, and drafts; every live
        order returns to Agent.trade for explicit confirmation.
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

function FundingCardShell({ eligibility }: { eligibility: EligibilityResponse }) {
  if (!HAS_PRIVY) {
    return (
      <FundingCard
        eligibility={eligibility}
        wallet={{ status: "local-dev", authStatus: "not-configured" }}
        providerEnabled={PRIVY_FUNDING_ENABLED}
        providerAvailable={false}
      />
    );
  }
  return <PrivyFundingCard eligibility={eligibility} />;
}

function AccountReadinessCardShell({ eligibility }: { eligibility: EligibilityResponse }) {
  if (!HAS_PRIVY) {
    return <AccountReadinessCard eligibility={eligibility} wallet={{ status: "local-dev" }} />;
  }
  return <PrivyAccountReadinessCard eligibility={eligibility} />;
}

function PrivyAccountReadinessCard({ eligibility }: { eligibility: EligibilityResponse }) {
  const wallet = useWalletSummary();
  return <AccountReadinessCard eligibility={eligibility} wallet={wallet} />;
}

function AccountReadinessCard({
  eligibility,
  wallet,
}: {
  eligibility: EligibilityResponse;
  wallet: WalletSummary;
}) {
  const readiness = getAccountReadinessDisplay({
    wallet: toReadinessWallet(wallet),
    eligibilityState: eligibility.state,
    accountValueKind: "paper",
    liveAccountDataLoaded: false,
    liveAccountDataUnavailable: false,
  });
  const liveReadiness = getLiveTradingReadiness({
    wallet: toReadinessWallet(wallet),
    eligibilityState: eligibility.state,
    executionVenue: eligibility.executionVenue,
    mainnetExecutionEnabled: eligibility.mainnetExecutionEnabled,
    killSwitchEnabled: eligibility.killSwitchEnabled,
  });

  return (
    <div className="panel onboarding-card">
      <div className="panel-head">
        <div>
          <span>Account state</span>
          <strong>{readiness.label}</strong>
        </div>
        <span className={`readiness-pill ${readiness.tone}`}>{readiness.accountValueLabel}</span>
      </div>
      <div className="readiness-list">
        <ReadinessRow label="Privy sign-in" value={authStatusLabel(wallet.authStatus)} ok={wallet.authStatus === "authenticated"} />
        <ReadinessRow label="Wallet readiness" value={readiness.walletLabel} ok={wallet.status === "connected"} />
        <ReadinessRow label="Wallet type" value={walletKindLabel(wallet.walletKind)} ok={wallet.status === "connected"} />
        <ReadinessRow label="Account values" value={readiness.accountValueLabel} ok={readiness.accountValueKind === "real" || readiness.accountValueKind === "hybrid"} />
        <ReadinessRow label="Eligibility" value={getEligibilityDisplay(eligibility.state).label} ok={eligibility.state === "liveEligible"} />
        <ReadinessRow label="Execution unlock" value={liveReadiness.label} ok={liveReadiness.allowed} />
        <ReadinessRow label="Paper trading" value={readiness.paperTradingEnabled ? "Available" : "Unavailable"} ok={readiness.paperTradingEnabled} />
        <ReadinessRow label="Testnet trading" value={liveReadiness.allowed ? "Ready after confirmation" : liveReadiness.disabledReason} ok={liveReadiness.allowed} />
      </div>
      <p className="onboarding-note">{liveReadiness.allowed ? liveReadiness.summary : `${readiness.summary} ${liveReadiness.summary}`}</p>
    </div>
  );
}

function toReadinessWallet(wallet: WalletSummary): WalletReadinessSummary {
  return {
    status: wallet.status,
    address: wallet.address,
    authStatus: wallet.authStatus,
    walletType: wallet.walletType,
    walletKind: wallet.walletKind,
  };
}

function PrivyFundingCard({ eligibility }: { eligibility: EligibilityResponse }) {
  const wallet = useWalletSummary();
  const { fundWallet } = useFundWallet();
  const [opening, setOpening] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);

  async function openProvider() {
    if (
      wallet.status !== "connected" ||
      !wallet.address ||
      eligibility.state !== "liveEligible" ||
      !PRIVY_FUNDING_ENABLED ||
      typeof fundWallet !== "function"
    ) {
      return;
    }

    setOpening(true);
    setProviderError(null);
    try {
      await fundWallet(wallet.address);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The funding provider could not be opened.";
      setProviderError(message);
    } finally {
      setOpening(false);
    }
  }

  return (
    <FundingCard
      eligibility={eligibility}
      wallet={wallet}
      providerEnabled={PRIVY_FUNDING_ENABLED}
      providerAvailable={PRIVY_FUNDING_ENABLED && typeof fundWallet === "function"}
      providerOpening={opening}
      providerError={providerError}
      onOpenProvider={openProvider}
    />
  );
}

function FundingCard(props: {
  eligibility: EligibilityResponse;
  wallet: WalletSummary;
  providerEnabled: boolean;
  providerAvailable: boolean;
  providerOpening?: boolean;
  providerError?: string | null;
  onOpenProvider?: () => void;
}) {
  const display = getFundingDisplay({
    eligibilityState: props.eligibility.state,
    hasPrivyEnv: HAS_PRIVY,
    walletConnected: props.wallet.status === "connected",
    providerEnabled: props.providerEnabled,
    providerAvailable: props.providerAvailable,
    providerOpening: props.providerOpening,
    providerError: props.providerError,
  });
  const eligibilityDisplay = getEligibilityDisplay(props.eligibility.state);
  const liveEligible = eligibilityDisplay.liveFundingEnabled;
  const bridgeDepositEnabled = HL_BRIDGE_DEPOSIT_ENABLED && liveEligible;
  const walletAddress = formatWalletAddress(props.wallet.address);

  const primaryAction =
    display.primaryCtaKind === "paper" ? (
      <Link className="primary-action compact-button" href="/terminal">{display.primaryCtaLabel}</Link>
    ) : display.primaryCtaKind === "connect_wallet" && props.wallet.login ? (
      <button className="primary-action compact-button" onClick={props.wallet.login}>{display.primaryCtaLabel}</button>
    ) : display.primaryCtaKind === "open_provider" ? (
      <button className="primary-action compact-button" disabled={!display.primaryCtaEnabled} onClick={props.onOpenProvider}>
        {display.primaryCtaLabel}
      </button>
    ) : (
      <button className="primary-action compact-button" disabled>{display.primaryCtaLabel}</button>
    );

  return (
    <div className="panel onboarding-card funding-card">
      <div className="panel-head">
        <div>
          <span>Funding</span>
          <strong>{display.title}</strong>
        </div>
        <span className={`readiness-pill ${display.tone}`}>
          {display.liveFundingEnabled ? "Provider ready" : "Paper first"}
        </span>
      </div>
      <div className="funding-status">
        <div>
          <span>Destination wallet</span>
          <strong>{walletAddress}</strong>
        </div>
        <p>{display.summary}</p>
        <div className="card-actions">
          {primaryAction}
          <Link className="secondary-action compact-button" href="/markets">Scan markets</Link>
        </div>
      </div>
      <div className="funding-methods">
        <FundingMethod
          title="Provider wallet funding"
          body="Privy dashboard providers may be configured, but Agent.trade only exposes a funding CTA when the product flag, wallet, eligibility, and provider hook are all ready."
          status={
            display.liveFundingEnabled
              ? "Provider available"
              : props.providerEnabled
                ? "Disabled until ready"
                : "Not enabled in this environment"
          }
          enabled={display.liveFundingEnabled}
        />
        <FundingMethod
          title="Hyperliquid deposit"
          body="Wallet funding is separate from depositing into Hyperliquid. The legacy bridge/deposit surface is hidden unless explicitly enabled for an approved internal environment."
          status={
            bridgeDepositEnabled
              ? "Flag enabled; still requires confirmation"
              : HL_BRIDGE_DEPOSIT_ENABLED
                ? "Disabled until live eligible"
                : "Default-off"
          }
          enabled={bridgeDepositEnabled}
        />
        <FundingMethod
          title="Testnet funds"
          body="MVP execution defaults to Hyperliquid testnet. Internal testers can proceed with separately funded testnet wallets before product-gated funding is exposed."
          status={props.eligibility.mainnetExecutionEnabled ? "Mainnet env enabled" : "Testnet default"}
          enabled
        />
        <FundingMethod
          title="MoonPay, Stripe, and deposit address"
          body="MoonPay fiat onramp and deposit address funding are future/product-gated. Stripe requires SDK compatibility validation before Agent.trade exposes it in-app."
          status={display.status === "provider_ready" ? "Provider-dependent" : "Not available in this state"}
          enabled={display.status === "provider_ready"}
        />
      </div>
      <p className="onboarding-note">
        Funding does not bypass Agent.trade eligibility, caps, acknowledgements, or order confirmation. Restricted or unknown eligibility disables live funding CTAs.
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

function authStatusLabel(status: WalletSummary["authStatus"]): string {
  switch (status) {
    case "authenticated":
      return "Signed in";
    case "unauthenticated":
      return "Sign-in required";
    case "loading":
      return "Checking session";
    case "not-configured":
    default:
      return "Local-dev paper only";
  }
}

function walletKindForType(walletType?: string): "embedded" | "external" | "unknown" {
  if (!walletType) {
    return "unknown";
  }
  return walletType === "privy" ? "embedded" : "external";
}

function walletKindLabel(kind: WalletSummary["walletKind"]): string {
  switch (kind) {
    case "embedded":
      return "Privy embedded";
    case "external":
      return "External wallet";
    case "unknown":
    default:
      return "Not detected";
  }
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
