"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useFundWallet, usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { useBalance, useReadContract, useSignTypedData } from "wagmi";
import { createPublicClient, erc20Abi, formatEther, http, type Hex } from "viem";
import { base } from "viem/chains";

import { api, API_BASE_URL } from "@/lib/api";
import {
  getAccountReadinessDisplay,
  getLiveTradingReadiness,
  type WalletReadinessSummary,
} from "@/lib/agent-trade/account-readiness";
import { loadTradingSnapshot } from "@/lib/agent-trade/data";
import { normalizeEligibilityResponse } from "@/lib/agent-trade/eligibility";
import { getFundingDisplay, getFundingMethodDisplays } from "@/lib/agent-trade/funding";
import {
  ARBITRUM_CHAIN_ID,
  HL_BRIDGE_ARBITRUM,
  MIN_AGENT_TRADE_ORDER_NOTIONAL_USD,
  USDC_BASE,
  USDC_ARBITRUM,
  buildUsdcPermitTypedData,
  formatUsdc,
  getGaslessDepositUi,
  splitPermitSignature,
  validateGaslessDepositAmount,
  type GaslessDepositPhase,
  type GaslessDepositStatus,
} from "@/lib/agent-trade/gasless-deposit";
import { formatWalletAddress, getEligibilityDisplay } from "@/lib/agent-trade/onboarding";
import {
  getOnboardingReadiness,
  type ReadinessItem,
} from "@/lib/agent-trade/onboarding-readiness";
import { getBridgeDepositDecision } from "@/lib/agent-trade/legacy-safety";
import type { AccountValueKind, EligibilityMode, EligibilityResponse } from "@/lib/agent-trade/types";

interface WalletSummary {
  status: "local-dev" | "loading" | "not-connected" | "connected";
  authStatus?: "not-configured" | "loading" | "unauthenticated" | "authenticated";
  address?: string;
  walletType?: string;
  walletKind?: "embedded" | "external" | "unknown";
  login?: () => void;
  logout?: () => void;
}

type WalletAddressCopyState = "idle" | "copied" | "manual";

export function getWalletAddressCopyUi(input: {
  walletAddress?: string;
  copyState: WalletAddressCopyState;
}): {
  buttonLabel: string;
  helperText?: string;
  manualAddress?: string;
} | undefined {
  if (!input.walletAddress) {
    return undefined;
  }

  if (input.copyState === "copied") {
    return {
      buttonLabel: "Copied",
      helperText: "Address copied.",
    };
  }

  if (input.copyState === "manual") {
    return {
      buttonLabel: "Copy",
      helperText: "Clipboard unavailable. Select the full address below.",
      manualAddress: input.walletAddress,
    };
  }

  return {
    buttonLabel: "Copy",
  };
}

const HAS_PRIVY = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
const PRIVY_FUNDING_ENABLED = process.env.NEXT_PUBLIC_AGENT_TRADE_ENABLE_PRIVY_FUNDING === "true";
const HL_BRIDGE_DEPOSIT_ENABLED = process.env.NEXT_PUBLIC_AGENT_TRADE_ENABLE_HL_BRIDGE_DEPOSIT === "true";
const GASLESS_HL_DEPOSIT_ENABLED =
  process.env.NEXT_PUBLIC_AGENT_TRADE_ENABLE_GASLESS_HL_DEPOSIT === "true";
const DASHBOARD_PROVIDER_CONFIGURED = true;
const DASHBOARD_DEPOSIT_ADDRESS_CONFIGURED = true;

export function OnboardingClient({ surface = "onboarding" }: { surface?: "onboarding" | "settings" }) {
  const [eligibility, setEligibility] = useState<EligibilityResponse>({
    state: "loading",
    executionVenue: "hyperliquid-testnet",
    mainnetExecutionEnabled: false,
    killSwitchEnabled: false,
    minOrderNotionalUsd: 10,
    orderNotionalCapUsd: 250,
    dailyNotionalCapUsd: 1000,
  });

  useEffect(() => {
    let cancelled = false;

    async function loadEligibility() {
      try {
        const res = await fetch(`${API_BASE_URL}/agent-trade/eligibility`, { cache: "no-store" });
        const next = await normalizeEligibilityResponse(res);
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

      <OnboardingPathShell eligibility={eligibility} />

      <section className="onboarding-grid">
        <ReadinessOverviewCardShell eligibility={eligibility} />
        <StatusCard eligibility={eligibility} />
        {HAS_PRIVY ? <PrivyWalletCard /> : <LocalDevWalletCard />}
        <AccountReadinessCardShell eligibility={eligibility} />
      </section>

      <section className="onboarding-grid wide">
        <FundingCardShell eligibility={eligibility} />
        <GaslessDepositCardShell eligibility={eligibility} />
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
            body={display.liveTradingEnabled ? "Eligible for Hyperliquid live execution after wallet, account, and confirmation checks." : display.summary}
            href="/terminal"
            cta="Open live ticket"
            enabled={display.liveTradingEnabled}
          />
        </div>
      </section>
    </main>
  );
}

function OnboardingPathShell({ eligibility }: { eligibility: EligibilityResponse }) {
  if (!HAS_PRIVY) {
    return (
      <OnboardingPath
        eligibility={eligibility}
        wallet={{ status: "local-dev", authStatus: "not-configured" }}
        providerAvailable={false}
      />
    );
  }
  return <PrivyOnboardingPath eligibility={eligibility} />;
}

function PrivyOnboardingPath({ eligibility }: { eligibility: EligibilityResponse }) {
  const wallet = useWalletSummary();
  const { fundWallet } = useFundWallet();
  const [opening, setOpening] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const providerAvailable = PRIVY_FUNDING_ENABLED && typeof fundWallet === "function";

  async function openProvider() {
    if (
      wallet.status !== "connected" ||
      !wallet.address ||
      eligibility.state !== "liveEligible" ||
      !providerAvailable
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
    <OnboardingPath
      eligibility={eligibility}
      wallet={wallet}
      providerAvailable={providerAvailable}
      providerOpening={opening}
      providerError={providerError}
      onOpenProvider={openProvider}
    />
  );
}

function OnboardingPath(props: {
  eligibility: EligibilityResponse;
  wallet: WalletSummary;
  providerAvailable: boolean;
  providerOpening?: boolean;
  providerError?: string | null;
  onOpenProvider?: () => void;
}) {
  const [addressCopyState, setAddressCopyState] = useState<WalletAddressCopyState>("idle");
  const eligibilityDisplay = getEligibilityDisplay(props.eligibility.state);
  const funding = getFundingDisplay({
    eligibilityState: props.eligibility.state,
    hasPrivyEnv: HAS_PRIVY,
    walletConnected: props.wallet.status === "connected",
    providerEnabled: PRIVY_FUNDING_ENABLED,
    providerAvailable: props.providerAvailable,
    providerConfigured: DASHBOARD_PROVIDER_CONFIGURED,
    depositAddressConfigured: DASHBOARD_DEPOSIT_ADDRESS_CONFIGURED,
    providerOpening: props.providerOpening,
    providerError: props.providerError,
  });
  const walletConnected = props.wallet.status === "connected";
  const walletAddress = walletConnected ? props.wallet.address : undefined;
  const canOpenProvider = funding.primaryCtaKind === "open_provider" && funding.primaryCtaEnabled;
  const depositDecision = getBridgeDepositDecision({
    featureEnabled: HL_BRIDGE_DEPOSIT_ENABLED,
    eligibilityState: props.eligibility.state,
  });
  const executionLabel = props.eligibility.mainnetExecutionEnabled ? "Mainnet" : "Testnet";
  const liveEligible = props.eligibility.state === "liveEligible";
  const fundingStepCopy = liveEligible
    ? "Fund the embedded wallet with USDC, deposit USDC into Hyperliquid, then return to Agent.trade."
    : props.eligibility.state === "restricted"
      ? "Live funding is unavailable for this eligibility state. Paper mode remains available."
      : "Funding stays gated until wallet readiness and live eligibility are confirmed.";
  const walletAddressCopyUi = getWalletAddressCopyUi({
    walletAddress,
    copyState: addressCopyState,
  });

  async function copyWalletAddress() {
    if (!walletAddress || !navigator.clipboard) {
      setAddressCopyState("manual");
      return;
    }

    try {
      await navigator.clipboard.writeText(walletAddress);
      setAddressCopyState("copied");
      window.setTimeout(() => setAddressCopyState("idle"), 1600);
    } catch {
      setAddressCopyState("manual");
    }
  }

  return (
    <section className="onboarding-path panel">
      <div className="panel-head">
        <div>
          <span>Start path</span>
          <strong>Sign in to wallet to eligibility to funding</strong>
        </div>
        <span className={`readiness-pill ${funding.liveFundingEnabled ? "green" : "amber"}`}>
          {funding.liveFundingEnabled ? "Funding action ready" : "Funding gated"}
        </span>
      </div>
      <div className="onboarding-path-grid">
        <PathStep
          step="1"
          title={HAS_PRIVY ? "Sign in" : "Local dev"}
          body={HAS_PRIVY ? "Use configured email, Google, or existing-wallet sign-in." : "Privy is not configured here; paper mode remains available."}
          status={HAS_PRIVY ? "Ready" : "Privy env missing"}
          tone={HAS_PRIVY ? "green" : "amber"}
        />
        <PathStep
          step="2"
          title="Wallet"
          body={walletConnected ? `Active wallet ${formatWalletAddress(props.wallet.address)}.` : "Sign in to create or connect a self-custodial wallet."}
          status={walletConnected ? walletKindLabel(props.wallet.walletKind) : "Not connected"}
          tone={walletConnected ? "green" : "amber"}
        />
        <PathStep
          step="3"
          title="Eligibility"
          body={eligibilityDisplay.summary}
          status={eligibilityDisplay.label}
          tone={eligibilityDisplay.tone}
        />
        <div className="path-step path-step-start">
          <div className="path-step-top">
            <span className="path-step-index">4</span>
            <span className={`readiness-pill ${funding.tone}`}>{funding.title}</span>
          </div>
          <strong>Fund your account</strong>
          <p>{fundingStepCopy}</p>
          {walletAddress ? (
            <div className="path-wallet-copy">
              <span>Wallet address</span>
              <code title={walletAddress}>{walletAddress}</code>
              <button type="button" onClick={copyWalletAddress}>{walletAddressCopyUi?.buttonLabel ?? "Copy"}</button>
              {walletAddressCopyUi?.helperText ? <small>{walletAddressCopyUi.helperText}</small> : null}
              {walletAddressCopyUi?.manualAddress ? <code className="path-wallet-copy-full">{walletAddressCopyUi.manualAddress}</code> : null}
            </div>
          ) : null}
          {walletConnected ? (
            <div className="manual-funding-steps">
              <div>
                <strong>1. Fund wallet with USDC</strong>
                <span>{canOpenProvider ? "Provider CTA available" : funding.summary}</span>
              </div>
              <div>
                <strong>2. Deposit USDC into Hyperliquid</strong>
                <span>{depositDecision.allowed ? "Bridge2 compatibility path is enabled for this eligible user." : depositDecision.summary}</span>
              </div>
              <div>
                <strong>3. Return to Agent.trade terminal</strong>
                <span>{liveEligible ? "Live orders still require account readiness and explicit confirmation." : "Use paper mode until live eligibility is available."}</span>
              </div>
            </div>
          ) : null}
          <div className="path-choice-list">
            <Link className="path-choice active" href="/terminal">
              <strong>{props.eligibility.state === "liveEligible" ? `Open ${executionLabel.toLowerCase()} ticket` : "Explore paper first"}</strong>
              <span>{props.eligibility.state === "liveEligible" ? "Live actions still require account state and confirmation." : "Simulate against live prices while readiness is incomplete."}</span>
            </Link>
            <button
              className="path-choice"
              disabled={!canOpenProvider}
              onClick={props.onOpenProvider}
              title={funding.summary}
            >
              <strong>{canOpenProvider ? funding.primaryCtaLabel : "Fund wallet"}</strong>
              <span>{canOpenProvider ? "Opens the configured provider for this wallet." : funding.summary}</span>
            </button>
            {depositDecision.allowed ? (
              <Link className="path-choice" href="/approve">
                <strong>Deposit into Hyperliquid</strong>
                <span>Open the gated legacy Bridge2 compatibility path.</span>
              </Link>
            ) : (
              <button className="path-choice" disabled title={depositDecision.summary}>
                <strong>Deposit into Hyperliquid</strong>
                <span>{depositDecision.summary}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function PathStep(props: {
  step: string;
  title: string;
  body: string;
  status: string;
  tone: "green" | "amber" | "red" | "blue";
}) {
  return (
    <div className="path-step">
      <div className="path-step-top">
        <span className="path-step-index">{props.step}</span>
        <span className={`readiness-pill ${props.tone}`}>{props.status}</span>
      </div>
      <strong>{props.title}</strong>
      <p>{props.body}</p>
    </div>
  );
}

function StatusCard({ eligibility }: { eligibility: EligibilityResponse }) {
  const display = getEligibilityDisplay(eligibility.state);
  const executionPolicy = eligibility.mainnetExecutionEnabled
    ? "Hyperliquid mainnet"
    : "Hyperliquid testnet";
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
        <ReadinessRow label="Execution venue" value={executionPolicy} ok />
        <ReadinessRow label="Kill switch" value={eligibility.killSwitchEnabled ? "Active" : "Clear"} ok={!eligibility.killSwitchEnabled} />
        <ReadinessRow
          label="Mainnet execution"
          value={eligibility.mainnetExecutionEnabled ? "Eligible users only" : "Disabled by policy"}
          ok={eligibility.mainnetExecutionEnabled ? display.liveTradingEnabled && !eligibility.killSwitchEnabled : false}
        />
      </div>
      <p className="onboarding-note">{display.summary}</p>
    </div>
  );
}

function ReadinessOverviewCardShell({ eligibility }: { eligibility: EligibilityResponse }) {
  if (!HAS_PRIVY) {
    return (
      <ReadinessOverviewCard
        eligibility={eligibility}
        wallet={{ status: "local-dev", authStatus: "not-configured" }}
        providerAvailable={false}
      />
    );
  }
  return <PrivyReadinessOverviewCard eligibility={eligibility} />;
}

function PrivyReadinessOverviewCard({ eligibility }: { eligibility: EligibilityResponse }) {
  const wallet = useWalletSummary();
  const { fundWallet } = useFundWallet();
  return (
    <ReadinessOverviewCard
      eligibility={eligibility}
      wallet={wallet}
      providerAvailable={PRIVY_FUNDING_ENABLED && typeof fundWallet === "function"}
    />
  );
}

function ReadinessOverviewCard({
  eligibility,
  wallet,
  providerAvailable,
}: {
  eligibility: EligibilityResponse;
  wallet: WalletSummary;
  providerAvailable: boolean;
}) {
  const funding = getFundingDisplay({
    eligibilityState: eligibility.state,
    hasPrivyEnv: HAS_PRIVY,
    walletConnected: wallet.status === "connected",
    providerEnabled: PRIVY_FUNDING_ENABLED,
    providerAvailable,
    providerConfigured: DASHBOARD_PROVIDER_CONFIGURED,
    depositAddressConfigured: DASHBOARD_DEPOSIT_ADDRESS_CONFIGURED,
  });
  const overview = getOnboardingReadiness({
    hasPrivyEnv: HAS_PRIVY,
    wallet: toReadinessWallet(wallet),
    eligibilityState: eligibility.state,
    executionVenue: eligibility.executionVenue,
    mainnetExecutionEnabled: eligibility.mainnetExecutionEnabled,
    killSwitchEnabled: eligibility.killSwitchEnabled,
    funding,
  });

  return (
    <div className="panel onboarding-card">
      <div className="panel-head">
        <div>
          <span>Readiness overview</span>
          <strong>{overview.label}</strong>
        </div>
        <span className={`readiness-pill ${overview.tone}`}>{funding.liveFundingEnabled ? "Funding ready" : "Funding gated"}</span>
      </div>
      <div className="readiness-list">
        <ReadinessItemRow item={overview.signInMethods} />
        <ReadinessItemRow item={overview.embeddedWallet} />
        <ReadinessItemRow item={overview.eligibility} />
        <ReadinessItemRow item={overview.tradingMode} />
        <ReadinessItemRow item={overview.funding} />
      </div>
      <p className="onboarding-note">{overview.summary}</p>
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
  const [accountState, setAccountState] = useState<{
    valueKind: AccountValueKind;
    loaded: boolean;
    unavailable: boolean;
  }>({ valueKind: "paper", loaded: false, unavailable: false });

  useEffect(() => {
    let cancelled = false;

    async function loadAccount() {
      if (wallet.status !== "connected" || !wallet.address) {
        setAccountState({ valueKind: "paper", loaded: false, unavailable: false });
        return;
      }

      try {
        const result = await loadTradingSnapshot("BTC", { accountAddress: wallet.address });
        if (!cancelled) {
          setAccountState({
            valueKind: result.snapshot.account.valueKind ?? "paper",
            loaded: result.snapshot.account.liveAccountDataLoaded === true,
            unavailable: result.snapshot.account.liveAccountDataUnavailable === true,
          });
        }
      } catch {
        if (!cancelled) {
          setAccountState({ valueKind: "unavailable", loaded: false, unavailable: true });
        }
      }
    }

    void loadAccount();
    return () => {
      cancelled = true;
    };
  }, [wallet.address, wallet.status]);

  const readiness = getAccountReadinessDisplay({
    wallet: toReadinessWallet(wallet),
    eligibilityState: eligibility.state,
    accountValueKind: accountState.valueKind,
    liveAccountDataLoaded: accountState.loaded,
    liveAccountDataUnavailable: accountState.unavailable,
  });
  const liveReadiness = getLiveTradingReadiness({
    wallet: toReadinessWallet(wallet),
    eligibilityState: eligibility.state,
    executionVenue: eligibility.executionVenue,
    mainnetExecutionEnabled: eligibility.mainnetExecutionEnabled,
    killSwitchEnabled: eligibility.killSwitchEnabled,
    accountValueKind: readiness.accountValueKind,
    liveAccountDataLoaded: readiness.accountValueKind === "real" || readiness.accountValueKind === "hybrid",
    liveAccountDataUnavailable: readiness.accountValueKind === "unavailable",
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
        <ReadinessRow label="Live trading" value={liveReadiness.allowed ? "Ready after confirmation" : liveReadiness.disabledReason} ok={liveReadiness.allowed} />
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
    providerConfigured: DASHBOARD_PROVIDER_CONFIGURED,
    depositAddressConfigured: DASHBOARD_DEPOSIT_ADDRESS_CONFIGURED,
    providerOpening: props.providerOpening,
    providerError: props.providerError,
  });
  const methods = getFundingMethodDisplays({
    eligibilityState: props.eligibility.state,
    hasPrivyEnv: HAS_PRIVY,
    walletConnected: props.wallet.status === "connected",
    providerEnabled: props.providerEnabled,
    providerAvailable: props.providerAvailable,
    providerConfigured: DASHBOARD_PROVIDER_CONFIGURED,
    depositAddressConfigured: DASHBOARD_DEPOSIT_ADDRESS_CONFIGURED,
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
        {methods.map((method) => (
          <FundingMethod
            key={method.title}
            title={method.title}
            body={method.body}
            status={method.status}
            enabled={method.enabled}
            detail={method.detail}
          />
        ))}
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
          detail="This default-off legacy compatibility path is not normal onboarding."
        />
      </div>
      <p className="onboarding-note">
        Funding does not bypass Agent.trade eligibility, caps, acknowledgements, or order confirmation. Restricted or unknown eligibility disables live funding CTAs.
      </p>
    </div>
  );
}

function GaslessDepositCardShell({ eligibility }: { eligibility: EligibilityResponse }) {
  if (!HAS_PRIVY) {
    return (
      <GaslessDepositCard
        eligibility={eligibility}
        wallet={{ status: "local-dev", authStatus: "not-configured" }}
        walletUsdcUnits={0n}
        baseUsdcUnits={0n}
        walletEthLabel="Unavailable"
        hlAccountValueUsd={0}
        amount="5"
        setAmount={() => undefined}
        phase="idle"
        txHash={null}
        error="Privy is not configured in this environment."
        status={undefined}
        onSubmit={() => undefined}
      />
    );
  }
  return <PrivyGaslessDepositCard eligibility={eligibility} />;
}

function PrivyGaslessDepositCard({ eligibility }: { eligibility: EligibilityResponse }) {
  const { getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { signTypedDataAsync } = useSignTypedData();
  const activeWallet = useMemo<ConnectedWallet | undefined>(() => {
    const embedded = wallets.find((wallet) => wallet.walletClientType === "privy");
    return embedded ?? wallets[0];
  }, [wallets]);
  const wallet = useWalletSummary();
  const address = wallet.status === "connected" && wallet.address
    ? wallet.address as `0x${string}`
    : undefined;
  const [amount, setAmount] = useState("5");
  const [phase, setPhase] = useState<GaslessDepositPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [backendStatus, setBackendStatus] = useState<GaslessDepositStatus | undefined>();
  const [hlAccountValueUsd, setHlAccountValueUsd] = useState(0);
  const [baseUsdcUnits, setBaseUsdcUnits] = useState(0n);

  useEffect(() => {
    if (activeWallet) {
      void setActiveWallet(activeWallet);
    }
  }, [activeWallet, setActiveWallet]);

  const { data: walletUsdcRaw, refetch: refetchWalletUsdc } = useReadContract({
    abi: erc20Abi,
    address: USDC_ARBITRUM,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: {
      enabled: GASLESS_HL_DEPOSIT_ENABLED && Boolean(address),
      refetchInterval: 10_000,
    },
  });
  const { data: permitNonceRaw, refetch: refetchPermitNonce } = useReadContract({
    abi: usdcPermitAbi,
    address: USDC_ARBITRUM,
    functionName: "nonces",
    args: address ? [address] : undefined,
    query: {
      enabled: GASLESS_HL_DEPOSIT_ENABLED && Boolean(address),
      refetchInterval: 10_000,
    },
  });
  const { data: ethBalance } = useBalance({
    address,
    chainId: ARBITRUM_CHAIN_ID,
    query: {
      enabled: GASLESS_HL_DEPOSIT_ENABLED && Boolean(address),
      refetchInterval: 15_000,
    },
  });

  useEffect(() => {
    let cancelled = false;
    async function loadBaseUsdc() {
      if (!GASLESS_HL_DEPOSIT_ENABLED || !address) {
        setBaseUsdcUnits(0n);
        return;
      }
      try {
        const publicClient = createPublicClient({
          chain: base,
          transport: http(),
        });
        const balance = await publicClient.readContract({
          abi: erc20Abi,
          address: USDC_BASE,
          functionName: "balanceOf",
          args: [address],
        });
        if (!cancelled) {
          setBaseUsdcUnits(balance);
        }
      } catch {
        if (!cancelled) {
          setBaseUsdcUnits(0n);
        }
      }
    }
    void loadBaseUsdc();
    return () => {
      cancelled = true;
    };
  }, [address]);

  useEffect(() => {
    let cancelled = false;
    async function loadStatus() {
      if (!GASLESS_HL_DEPOSIT_ENABLED || !address) {
        setBackendStatus(undefined);
        return;
      }
      try {
        const res = await fetch(`${API_BASE_URL}/agent-trade/deposit/status?user=${encodeURIComponent(address)}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          throw new Error(`status ${res.status}`);
        }
        const body = await res.json() as GaslessDepositStatus;
        if (!cancelled) {
          setBackendStatus(body);
        }
      } catch {
        if (!cancelled) {
          setBackendStatus({
            enabled: false,
            reason: "Backend relayer status is unavailable.",
            bridge: HL_BRIDGE_ARBITRUM,
            token: USDC_ARBITRUM,
            minDepositUsdc: 5,
            chainId: ARBITRUM_CHAIN_ID,
            eligibilityState: "unknown",
            liveEligible: false,
            mainnetExecutionEnabled: false,
            killSwitchEnabled: false,
            minOrderNotionalUsd: MIN_AGENT_TRADE_ORDER_NOTIONAL_USD,
          });
        }
      }
    }
    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [address]);

  const refreshHlBalance = useCallback(async () => {
    if (!address) {
      setHlAccountValueUsd(0);
      return;
    }
    try {
      const balance = await api.balance(address);
      setHlAccountValueUsd(Number(balance.accountValue ?? 0));
    } catch {
      setHlAccountValueUsd(0);
    }
  }, [address]);

  useEffect(() => {
    void refreshHlBalance();
  }, [refreshHlBalance]);

  useEffect(() => {
    if (phase !== "polling" || !address) {
      return undefined;
    }
    const interval = window.setInterval(() => {
      void refreshHlBalance();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [address, phase, refreshHlBalance]);

  useEffect(() => {
    if (phase === "polling" && hlAccountValueUsd >= 5) {
      setPhase("confirmed");
    }
  }, [hlAccountValueUsd, phase]);

  async function submitGaslessDeposit() {
    if (!address) {
      return;
    }
    const amountResult = validateGaslessDepositAmount({
      amount,
      walletUsdcUnits: walletUsdcRaw ?? 0n,
    });
    if (!amountResult.ok) {
      setError(amountResult.message);
      return;
    }
    if (permitNonceRaw == null) {
      setError("Could not read the USDC permit nonce. Retry in a moment.");
      return;
    }
    if (!backendStatus?.enabled) {
      setError(backendStatus?.reason ?? "Gasless deposit not enabled.");
      return;
    }

    setError(null);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 60);
    const typedData = buildUsdcPermitTypedData({
      owner: address,
      spender: backendStatus.bridge,
      token: backendStatus.token,
      value: amountResult.amountUnits,
      nonce: permitNonceRaw,
      deadline,
    });

    try {
      setPhase("signing");
      const signed = await signTypedDataAsync(typedData);
      const signature = splitPermitSignature(signed as Hex);
      setPhase("signed");
      const token = await getAccessToken();
      if (!token) {
        throw new Error("Privy session token unavailable. Sign in again before depositing.");
      }
      setPhase("submitting");
      const res = await fetch(`${API_BASE_URL}/agent-trade/deposit/permit`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          owner: address,
          token: backendStatus.token,
          spender: backendStatus.bridge,
          amount: amountResult.amountUnits.toString(),
          deadline: Number(deadline),
          signature,
        }),
      });
      const body = await res.json() as { txHash?: Hex; message?: string; guidance?: string };
      if (!res.ok || !body.txHash) {
        throw new Error(body.guidance ? `${body.message ?? "Deposit failed"} ${body.guidance}` : body.message ?? "Deposit failed.");
      }
      setTxHash(body.txHash);
      setPhase("polling");
      await refetchWalletUsdc();
      await refetchPermitNonce();
      await refreshHlBalance();
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Gasless deposit failed.");
    }
  }

  return (
    <GaslessDepositCard
      eligibility={eligibility}
      wallet={wallet}
      walletUsdcUnits={walletUsdcRaw ?? 0n}
      baseUsdcUnits={baseUsdcUnits}
      walletEthLabel={ethBalance?.value == null ? "Not checked" : `${Number(formatEther(ethBalance.value)).toFixed(5)} ETH`}
      hlAccountValueUsd={hlAccountValueUsd}
      amount={amount}
      setAmount={setAmount}
      phase={phase}
      txHash={txHash}
      error={error}
      status={backendStatus}
      onSubmit={submitGaslessDeposit}
    />
  );
}

function GaslessDepositCard(props: {
  eligibility: EligibilityResponse;
  wallet: WalletSummary;
  walletUsdcUnits: bigint;
  baseUsdcUnits: bigint;
  walletEthLabel: string;
  hlAccountValueUsd: number;
  amount: string;
  setAmount: (amount: string) => void;
  phase: GaslessDepositPhase;
  txHash: Hex | null;
  error: string | null;
  status: GaslessDepositStatus | undefined;
  onSubmit: () => void;
}) {
  const walletConnected = props.wallet.status === "connected";
  const ui = getGaslessDepositUi({
    frontendEnabled: GASLESS_HL_DEPOSIT_ENABLED,
    backendStatus: props.status,
    walletConnected,
    eligibilityState: props.eligibility.state,
    walletUsdcUnits: props.walletUsdcUnits,
    baseUsdcUnits: props.baseUsdcUnits,
    hlAccountValueUsd: props.hlAccountValueUsd,
    amount: props.amount,
  });
  const isBusy = props.phase === "signing" || props.phase === "signed" || props.phase === "submitting" || props.phase === "polling";
  const phaseLabel = (() => {
    if (props.phase === "signing") {
      return "Signing permit";
    }
    if (props.phase === "signed") {
      return "Permit signed";
    }
    if (props.phase === "submitting") {
      return "Relayer submitting deposit";
    }
    if (props.phase === "polling") {
      return "Waiting for Hyperliquid balance";
    }
    if (props.phase === "confirmed") {
      return props.hlAccountValueUsd >= MIN_AGENT_TRADE_ORDER_NOTIONAL_USD
        ? "Ready to trade"
        : "Deposited below order minimum";
    }
    if (props.phase === "error") {
      return "Deposit failed";
    }
    return ui.title;
  })();

  return (
    <div className="panel onboarding-card gasless-deposit-card">
      <div className="panel-head">
        <div>
          <span>Hyperliquid deposit</span>
          <strong>{phaseLabel}</strong>
        </div>
        <span className={`readiness-pill ${ui.readyToTrade ? "green" : ui.ctaEnabled ? "blue" : "amber"}`}>
          {ui.readyToTrade ? "Ready" : ui.ctaEnabled ? "Permit available" : "Gated"}
        </span>
      </div>
      <div className="readiness-list">
        <ReadinessRow label="Arbitrum wallet USDC" value={`${formatUsdc(props.walletUsdcUnits)} USDC`} ok={props.walletUsdcUnits >= 5_000_000n} />
        <ReadinessRow label="Arbitrum ETH gas" value={props.walletEthLabel} ok />
        <ReadinessRow label="Hyperliquid trading balance" value={`$${props.hlAccountValueUsd.toFixed(2)}`} ok={props.hlAccountValueUsd >= MIN_AGENT_TRADE_ORDER_NOTIONAL_USD} />
      </div>
      <div className="gasless-deposit-body">
        <p>{ui.summary}</p>
        <label>
          <span>Amount</span>
          <input
            value={props.amount}
            onChange={(event) => props.setAmount(event.target.value)}
            inputMode="decimal"
            disabled={!GASLESS_HL_DEPOSIT_ENABLED || isBusy}
          />
        </label>
        {ui.amountError ? <p className="form-error">{ui.amountError}</p> : null}
        {props.error ? <p className="form-error">{props.error}</p> : null}
        {props.txHash ? (
          <a className="secondary-action compact-button" href={`https://arbiscan.io/tx/${props.txHash}`} target="_blank" rel="noreferrer">
            View Arbiscan transaction
          </a>
        ) : null}
        {props.hlAccountValueUsd >= 5 && props.hlAccountValueUsd < MIN_AGENT_TRADE_ORDER_NOTIONAL_USD ? (
          <p className="onboarding-note">Deposited, but below Agent.trade&apos;s $10 minimum order notional.</p>
        ) : null}
        <button
          className="primary-action compact-button"
          disabled={!ui.ctaEnabled || isBusy}
          onClick={props.onSubmit}
        >
          {isBusy ? phaseLabel : ui.ctaLabel}
        </button>
      </div>
    </div>
  );
}

const usdcPermitAbi = [
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

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

function ReadinessItemRow({ item }: { item: ReadinessItem }) {
  return (
    <div className="readiness-row" title={item.detail}>
      <span>{item.label}</span>
      <strong className={item.ok ? "pos" : "neg"}>{item.value}</strong>
    </div>
  );
}

function FundingMethod(props: { title: string; body: string; status: string; enabled: boolean; detail: string }) {
  return (
    <div className={`funding-method ${props.enabled ? "enabled" : "disabled"}`} title={props.detail}>
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
