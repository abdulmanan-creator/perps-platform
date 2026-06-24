"use client";

/**
 * /approve — Agent.trade wallet-readiness surface.
 *
 * Legacy approveBuilderFee and Bridge2 deposit mechanics remain in this file
 * for internal compatibility testing, but they are default-off behind explicit
 * public Agent.trade flags and live-eligibility checks.
 *
 * State machine (matches the approve.html data-state names):
 *   "connect"  — !ready || !authenticated      (state A in the mockup)
 *   "ready"    — authenticated, ¬approved      (state B)
 *   "approved" — authenticated, approved       (state C)
 *   "pending"  — in-flight build/sign/send     (state D)
 *   "error"    — last action failed            (state E)
 *
 * Build/sign/send:
 *   1. POST /exchange { action: { type:"approveBuilderFee", maxFeeRate } }
 *      → { typedData, nonce, hash, action }
 *   2. signTypedDataAsync(typedData) via wagmi (routes through Privy)
 *   3. POST /exchange { action, nonce, signature }
 *   4. Refetch GET /approval, transition to "approved".
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  usePrivy,
  useWallets,
  type ConnectedWallet,
} from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import {
  useReadContract,
  useSignTypedData,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { erc20Abi, parseUnits } from "viem";

// Hyperliquid's deposit contract (Bridge2) on Arbitrum mainnet. Verified at
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/bridge2
// On testnet HL uses a different bridge; if/when we wire testnet end-to-end,
// derive this from a server endpoint instead of hardcoding.
const HL_BRIDGE_ARBITRUM = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7" as const;
// Native Circle USDC on Arbitrum (the variant HL accepts).
const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;

// Internal-only feature flag. When true, /approve's approved state renders a
// "Place test trade" card so we can smoke-test the fee-earning loop on mainnet
// from inside our app. NOT product surface — the product is the API itself.
const TEST_TRADE_ENABLED = process.env.NEXT_PUBLIC_ENABLE_TEST_TRADE === "true";
const HAS_PRIVY = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
const LEGACY_APPROVALS_ENABLED =
  process.env.NEXT_PUBLIC_AGENT_TRADE_ENABLE_LEGACY_APPROVALS === "true";
const HL_BRIDGE_DEPOSIT_ENABLED =
  process.env.NEXT_PUBLIC_AGENT_TRADE_ENABLE_HL_BRIDGE_DEPOSIT === "true";

import type {
  ApprovalState,
  BalanceState,
  BuildResponse,
  SendResponse,
} from "@alchemy-hl/sdk-preview";
import { AppShell } from "@/components/agent-trade/AppShell";
import {
  getBridgeDepositDecision,
  getLegacyApprovalDecision,
} from "@/lib/agent-trade/legacy-safety";
import type { EligibilityMode } from "@/lib/agent-trade/types";
import { api, API_BASE_URL, BUILDER_ADDR } from "@/lib/api";

type Phase = "idle" | "building" | "signing" | "sending" | "refreshing";

interface ErrState {
  code?: string;
  message: string;
  guidance: string;
}

export default function ApprovePage() {
  if (!LEGACY_APPROVALS_ENABLED) {
    return <ApproveLegacyDisabled />;
  }
  if (!HAS_PRIVY) {
    return <ApproveMissingPrivy />;
  }
  return <ApproveFlow />;
}

function ApproveFlow() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { signTypedDataAsync } = useSignTypedData();

  // If the user signed in via email/Google we have an embedded wallet; prefer
  // that as the signer (matches the email-first product story). Otherwise fall
  // back to whatever external wallet is first in Privy's list.
  const activeWallet = useMemo<ConnectedWallet | undefined>(() => {
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    return embedded ?? wallets[0];
  }, [wallets]);
  const isEmbedded = activeWallet?.walletClientType === "privy";
  const userAddress = activeWallet?.address as `0x${string}` | undefined;
  const [eligibilityState, setEligibilityState] = useState<EligibilityMode>("loading");

  // Sync wagmi's active account to whatever wallet Privy has selected. Without
  // this, useSignTypedData (wagmi) can sign with a still-connected external
  // wallet (e.g. MetaMask from an earlier session) even though useWallets()
  // says the embedded wallet is the user's primary. Producing a mismatch
  // between the address shown in the chip and the address that actually signs.
  useEffect(() => {
    if (activeWallet) {
      void setActiveWallet(activeWallet);
    }
  }, [activeWallet, setActiveWallet]);

  // ---- HL deposit (in-app) ------------------------------------------------
  // Privy embedded wallets can't connect to app.hyperliquid.xyz from outside
  // our app, so we drive the deposit transaction (USDC.transfer → HL Bridge2
  // on Arbitrum) from inside /approve via wagmi. After confirmation, HL's
  // indexer credits the wallet's HL account in 1-3s; the user clicks Retry.
  const { writeContractAsync, data: depositTxHash, reset: resetDeposit } = useWriteContract();
  const {
    isLoading: depositConfirming,
    isSuccess: depositConfirmed,
  } = useWaitForTransactionReceipt({ hash: depositTxHash });

  // Live USDC balance of the embedded wallet on Arbitrum — used to render
  // "you have N USDC available to deposit" and validate the amount before
  // submitting.
  const { data: usdcBalanceRaw } = useReadContract({
    abi: erc20Abi,
    address: USDC_ARBITRUM,
    functionName: "balanceOf",
    args: activeWallet?.address ? [activeWallet.address as `0x${string}`] : undefined,
    query: {
      enabled:
        LEGACY_APPROVALS_ENABLED &&
        HL_BRIDGE_DEPOSIT_ENABLED &&
        eligibilityState === "liveEligible" &&
        !!activeWallet?.address,
      refetchInterval: 5_000,
    },
  });

  const usdcBalance = usdcBalanceRaw ? Number(usdcBalanceRaw) / 1e6 : 0;
  const [depositAmount, setDepositAmount] = useState("5");
  const [depositPhase, setDepositPhase] = useState<"idle" | "submitting" | "confirming" | "done" | "error">("idle");
  const [depositError, setDepositError] = useState<string | null>(null);

  const submitDeposit = useCallback(async () => {
    const depositDecision = getBridgeDepositDecision({
      featureEnabled: HL_BRIDGE_DEPOSIT_ENABLED,
      eligibilityState,
    });
    if (!activeWallet?.address || !depositDecision.allowed) return;
    setDepositError(null);
    try {
      const amount = parseUnits(depositAmount, 6);
      if (amount === 0n) throw new Error("Deposit amount must be > 0");
      setDepositPhase("submitting");
      await writeContractAsync({
        abi: erc20Abi,
        address: USDC_ARBITRUM,
        functionName: "transfer",
        args: [HL_BRIDGE_ARBITRUM, amount],
      });
      setDepositPhase("confirming");
    } catch (err) {
      setDepositError((err as Error).message ?? "Deposit transaction failed.");
      setDepositPhase("error");
    }
  }, [activeWallet?.address, depositAmount, eligibilityState, writeContractAsync]);

  useEffect(() => {
    if (depositConfirmed) {
      setDepositPhase("done");
    }
  }, [depositConfirmed]);

  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [feeRate, setFeeRate] = useState("1");
  const [error, setError] = useState<ErrState | null>(null);

  useEffect(() => {
    if (!ready || !authenticated || !userAddress) {
      setEligibilityState("loading");
      return;
    }

    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/agent-trade/eligibility`, { cache: "no-store" });
        if (!res.ok) throw new Error(`eligibility ${res.status}`);
        const body = (await res.json()) as { state?: EligibilityMode };
        if (alive) {
          setEligibilityState(body.state ?? "unknown");
        }
      } catch {
        if (alive) {
          setEligibilityState("unknown");
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [ready, authenticated, userAddress]);

  const refetchApproval = useCallback(async () => {
    if (!userAddress || eligibilityState !== "liveEligible") {
      setApproval(null);
      return;
    }
    setApprovalLoading(true);
    setError(null);
    try {
      const state = await api.approval(userAddress);
      setApproval(state);
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setApprovalLoading(false);
    }
  }, [eligibilityState, userAddress]);

  useEffect(() => {
    void refetchApproval();
  }, [refetchApproval]);

  const runApproval = useCallback(
    async (rate: string) => {
      if (!userAddress) return;
      const approvalDecision = getLegacyApprovalDecision({
        featureEnabled: LEGACY_APPROVALS_ENABLED,
        eligibilityState,
      });
      if (!approvalDecision.allowed) {
        setError({
          message: approvalDecision.title,
          guidance: approvalDecision.summary,
        });
        return;
      }
      setError(null);
      try {
        setPhase("building");
        const built = (await api.build({
          type: "approveBuilderFee",
          maxFeeRate: rate,
        })) as BuildResponse;
        if (!built.typedData) throw new Error("Server did not return typedData.");

        setPhase("signing");
        const sigHex = await signTypedDataAsync({
          domain: built.typedData.domain,
          types: built.typedData.types,
          primaryType: built.typedData.primaryType,
          message: built.typedData.message as Record<string, unknown>,
        });
        const sig = splitHexSig(sigHex as `0x${string}`);

        setPhase("sending");
        (await api.send(built.action, built.nonce, sig)) as SendResponse;

        setPhase("refreshing");
        await refetchApproval();
        setPhase("idle");
      } catch (err) {
        setError(extractApiError(err));
        setPhase("idle");
      }
    },
    [eligibilityState, userAddress, signTypedDataAsync, refetchApproval],
  );

  // ---- Derived state -------------------------------------------------------

  const inFlight = phase !== "idle";
  const approvalDecision = getLegacyApprovalDecision({
    featureEnabled: LEGACY_APPROVALS_ENABLED,
    eligibilityState,
  });
  const depositDecision = getBridgeDepositDecision({
    featureEnabled: HL_BRIDGE_DEPOSIT_ENABLED,
    eligibilityState,
  });
  const stateName: "connect" | "ready" | "approved" | "pending" | "error" | "deposit" = (() => {
    if (!ready || !authenticated) return "connect";
    if (inFlight) return "pending";
    if (error?.code === "NEEDS_DEPOSIT") return "deposit";
    if (error) return "error";
    if (approval?.approved) return "approved";
    return "ready";
  })();

  // ---- Render --------------------------------------------------------------

  return (
    <div className="approve-shell">
      <div className="approve-nav">
        <Link href="/" className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/logo-wordmark-white.svg" alt="Agent.trade" />
          <span className="nav-divider"></span>
          <span className="sub">Wallet readiness</span>
        </Link>
        <Link href="/onboarding" className="back">← Back to account readiness</Link>
      </div>

      <main className="approve-main">
        <div style={{ width: "100%", maxWidth: 520 }}>
          {stateName === "connect" && (
            <ConnectCard onLogin={login} ready={ready} />
          )}
          {stateName !== "connect" && !approvalDecision.allowed && (
            <LegacyActionDisabledCard
              title={approvalDecision.title}
              summary={approvalDecision.summary}
              userAddress={userAddress!}
              onDisconnect={logout}
            />
          )}
          {stateName === "ready" && approvalDecision.allowed && (
            <ReadyCard
              userAddress={userAddress!}
              isEmbedded={isEmbedded}
              feeRate={feeRate}
              setFeeRate={setFeeRate}
              onApprove={() => runApproval(`${feeRate}%`)}
              onDisconnect={logout}
              userDisplay={displayUser(user, userAddress)}
              approvalLoading={approvalLoading}
            />
          )}
          {stateName === "approved" && approvalDecision.allowed && (
            <>
              <ApprovedCard
                approval={approval!}
                userAddress={userAddress!}
                isEmbedded={isEmbedded}
                onRevoke={() => runApproval("0%")}
                onDisconnect={logout}
              />
              {TEST_TRADE_ENABLED && userAddress && (
                <div style={{ marginTop: 16 }}>
                  <TestTradeCard userAddress={userAddress} />
                </div>
              )}
            </>
          )}
          {stateName === "pending" && approvalDecision.allowed && (
            <PendingCard
              phase={phase}
              userAddress={userAddress!}
              feeRate={feeRate}
              onDisconnect={logout}
            />
          )}
          {stateName === "error" && approvalDecision.allowed && (
            <ErrorCard
              error={error!}
              userAddress={userAddress!}
              feeRate={feeRate}
              setFeeRate={setFeeRate}
              onRetry={() => runApproval(`${feeRate}%`)}
              onDisconnect={logout}
            />
          )}
          {stateName === "deposit" && approvalDecision.allowed && !depositDecision.allowed && (
            <BridgeDepositDisabledCard
              title={depositDecision.title}
              summary={depositDecision.summary}
              error={error!}
              userAddress={userAddress!}
              onDisconnect={logout}
              onRetry={() => runApproval(`${feeRate}%`)}
            />
          )}
          {stateName === "deposit" && approvalDecision.allowed && depositDecision.allowed && (
            <DepositCard
              error={error!}
              userAddress={userAddress!}
              isEmbedded={isEmbedded}
              onDisconnect={logout}
              onRetry={() => runApproval(`${feeRate}%`)}
              usdcBalance={usdcBalance}
              depositAmount={depositAmount}
              setDepositAmount={setDepositAmount}
              depositPhase={depositPhase}
              depositTxHash={depositTxHash}
              depositConfirming={depositConfirming}
              depositError={depositError}
              onDeposit={submitDeposit}
              onResetDeposit={() => {
                resetDeposit();
                setDepositPhase("idle");
                setDepositError(null);
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function ApproveMissingPrivy() {
  return (
    <AppShell>
      <main className="onboarding-page">
        <section className="onboarding-head">
          <div>
            <p className="at-kicker">Wallet readiness</p>
            <h1>Wallet readiness unavailable</h1>
            <p>
              Privy is not configured in this environment, so wallet approval
              and OAuth compatibility setup are disabled. Paper trading and
              market discovery remain available.
            </p>
          </div>
          <div className="onboarding-actions">
            <Link className="secondary-action" href="/connectors">Connector overview</Link>
            <Link className="primary-link" href="/terminal">Open terminal</Link>
          </div>
        </section>
        <section className="panel onboarding-card">
          <div className="panel-head">
            <div>
              <span>Local dev</span>
              <strong>Privy env missing</strong>
            </div>
            <span className="readiness-pill amber">Paper-ready</span>
          </div>
          <div className="risk-copy-list">
            <p>
              Set <code>NEXT_PUBLIC_PRIVY_APP_ID</code> to enable wallet
              sign-in. Missing Privy configuration does not enable live trading
              or connector order submission.
            </p>
            <p>
              Current MVP connector flows are research and draft handoffs.
              Orders return to Agent.trade for eligibility checks, caps, risk
              acknowledgement, and explicit confirmation.
            </p>
          </div>
        </section>
      </main>
    </AppShell>
  );
}

function ApproveLegacyDisabled() {
  return (
    <AppShell>
      <main className="onboarding-page">
        <section className="onboarding-head">
          <div>
            <p className="at-kicker">Internal compatibility</p>
            <h1>Legacy wallet approvals are disabled</h1>
            <p>
              This environment keeps Agent.trade&apos;s current MVP model:
              assistants research, explain, and draft; orders return to the
              Agent.trade terminal for eligibility checks, caps, risk
              acknowledgement, and explicit confirmation.
            </p>
          </div>
          <div className="onboarding-actions">
            <Link className="secondary-action" href="/connectors">Connector overview</Link>
            <Link className="primary-link" href="/terminal">Open terminal</Link>
          </div>
        </section>
        <section className="panel onboarding-card">
          <div className="panel-head">
            <div>
              <span>Default-off safety gate</span>
              <strong>Compatibility approvals unavailable</strong>
            </div>
            <span className="readiness-pill amber">Draft-confirm only</span>
          </div>
          <div className="risk-copy-list">
            <p>
              <code>NEXT_PUBLIC_AGENT_TRADE_ENABLE_LEGACY_APPROVALS</code> is
              not enabled, so builder-fee approval and revoke actions are not
              rendered.
            </p>
            <p>
              <code>NEXT_PUBLIC_AGENT_TRADE_ENABLE_HL_BRIDGE_DEPOSIT</code> must
              also be explicitly enabled before any in-app Hyperliquid Bridge2
              deposit surface can appear.
            </p>
            <div className="onboarding-actions compact">
              <Link className="secondary-action" href="/onboarding">Account readiness</Link>
              <Link className="secondary-action" href="/connectors">Connectors</Link>
              <Link className="primary-link" href="/terminal">Terminal</Link>
            </div>
          </div>
        </section>
      </main>
    </AppShell>
  );
}

// ============================================================================
// State cards
// ============================================================================

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="approve-card">
      <header className="approve-head">
        <span className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/logo-brandmark-white.svg" alt="" />
          <span>Agent.trade wallet readiness</span>
        </span>
        <Link href="/onboarding" aria-label="Close" className="close">×</Link>
      </header>
      <div className="approve-body">{children}</div>
    </div>
  );
}

function WalletChip({
  address,
  onDisconnect,
}: {
  address: string;
  onDisconnect: () => void;
}) {
  return (
    <div className="wallet-chip">
      <span className="av"></span>
      <span>{shortAddr(address)}</span>
      <button className="dis" onClick={onDisconnect}>Disconnect</button>
    </div>
  );
}

function ConnectCard({ onLogin, ready }: { onLogin: () => void; ready: boolean }) {
  return (
    <CardShell>
      <h1 className="approve-title">Connect to continue.</h1>
      <p className="approve-sub">
        Sign in with email, Google, or an existing wallet. This legacy readiness
        surface checks whether your wallet has the builder-fee approval needed
        by older internal flows. The current Agent.trade MVP remains
        draft-confirm: the agent researches, explains, and drafts; orders return
        to Agent.trade for confirmation.
      </p>

      <button
        className="btn btn-primary btn-block"
        onClick={onLogin}
        disabled={!ready}
        style={{ marginBottom: 14 }}
      >
        {ready ? "Sign in" : "Initializing…"}
        <svg className="btn-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>

      <div className="explainer">
        Connecting only reads your address. Any approval is a separate typed-data
        signature you review in your wallet. It does not change the current MVP
        requirement that orders return to Agent.trade for confirmation.
      </div>

      <div className="card-foot">
        <span>EIP-712 typed-data signature</span>
        <Link href="/connectors">Connector safety model</Link>
      </div>
    </CardShell>
  );
}

function LegacyActionDisabledCard(props: {
  title: string;
  summary: string;
  userAddress: string;
  onDisconnect: () => void;
}) {
  return (
    <CardShell>
      <WalletChip address={props.userAddress} onDisconnect={props.onDisconnect} />
      <h1 className="approve-title">{props.title}</h1>
      <p className="approve-sub">{props.summary}</p>
      <div className="explainer">
        Current MVP connector flows are research and draft handoffs. Orders
        return to Agent.trade for eligibility checks, caps, risk
        acknowledgement, and explicit confirmation.
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        <Link className="btn btn-secondary btn-secondary-block" href="/onboarding">
          Account readiness
        </Link>
        <Link className="btn btn-secondary btn-secondary-block" href="/connectors">
          Connector overview
        </Link>
        <Link className="btn btn-primary btn-block" href="/terminal">
          Open terminal
        </Link>
      </div>
    </CardShell>
  );
}

function ReadyCard(props: {
  userAddress: string;
  isEmbedded: boolean;
  feeRate: string;
  setFeeRate: (s: string) => void;
  onApprove: () => void;
  onDisconnect: () => void;
  userDisplay: string;
  approvalLoading: boolean;
}) {
  return (
    <CardShell>
      <WalletChip address={props.userAddress} onDisconnect={props.onDisconnect} />

      <h1 className="approve-title">Review builder-fee approval.</h1>
      <p className="approve-sub">
        Signed in as {props.userDisplay}. This sets a ceiling on builder fees
        for compatibility with older Hyperliquid routing flows. It is not a
        grant for an assistant to place live orders without Agent.trade review.
        You can revoke it at any time with one signature.
      </p>

      <div className="field-group">
        <div className="field-label">
          <span className="lbl">Max fee rate</span>
          <span className="hint">Protocol max 0.1% perps · 1% spot</span>
        </div>
        <div className="fee-input">
          <input
            type="text"
            value={props.feeRate}
            onChange={(e) => props.setFeeRate(e.target.value)}
            inputMode="decimal"
          />
          <span className="suffix">%</span>
        </div>
        <div className="fee-meta">
          Actual fee per order: <strong>0.04% on perps · 0.05% on spot</strong>
        </div>
      </div>

      <button
        className="btn btn-primary btn-block"
        onClick={props.onApprove}
        disabled={props.approvalLoading}
      >
        {props.approvalLoading ? "Checking…" : "Approve builder-fee ceiling"}
        <svg className="btn-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>

      <div className="card-foot">
        <span>
          Wallet · {props.isEmbedded ? "Privy embedded" : "External"} · Arbitrum One
        </span>
        <Link href="/terminal">Open terminal</Link>
      </div>
    </CardShell>
  );
}

function ApprovedCard(props: {
  approval: ApprovalState;
  userAddress: string;
  isEmbedded: boolean;
  onRevoke: () => void;
  onDisconnect: () => void;
}) {
  const { approval } = props;
  return (
    <CardShell>
      <WalletChip address={props.userAddress} onDisconnect={props.onDisconnect} />

      <div className="approved-badge">
        <span className="check">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
        </span>
        <div>
          <div className="ttl">Approved up to {approval.maxFeeRate}</div>
          <div className="meta">
            {approval.canTradePerps ? "Perps: ready" : "Perps: cap too low"} ·{" "}
            {approval.canTradeSpot ? "Spot: ready" : "Spot: cap too low"}
          </div>
        </div>
      </div>

      <div className="kv-list">
        <div className="kv-row">
          <span className="k">Builder address</span>
          <span className="v">{shortAddr(BUILDER_ADDR || "0x0")}</span>
        </div>
        <div className="kv-row">
          <span className="k">Max fee rate</span>
          <span className="v">{approval.maxFeeRate}</span>
        </div>
        <div className="kv-row">
          <span className="k">Charged on perps</span>
          <span className="v success">
            {approval.feeBreakdown.configuredPerpsBps / 100}%
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Charged on spot</span>
          <span className="v success">
            {approval.feeBreakdown.configuredSpotBps / 100}%
          </span>
        </div>
      </div>

      <button className="btn btn-secondary btn-secondary-block" onClick={props.onRevoke}>
        Revoke
      </button>

      <div style={{ marginTop: 16 }}>
        <Link
          className="btn btn-secondary btn-secondary-block"
          href="/onboarding"
        >
          Continue account readiness
        </Link>
      </div>

      <div className="card-foot">
        <span>You can revoke any time. Current MVP orders require Agent.trade confirmation.</span>
        <Link href="/connectors">Connector setup</Link>
      </div>
    </CardShell>
  );
}

function PendingCard(props: {
  phase: Phase;
  userAddress: string;
  feeRate: string;
  onDisconnect: () => void;
}) {
  const titles: Record<Phase, string> = {
    idle: "",
    building: "Preparing the approval…",
    signing: "Confirm in your wallet…",
    sending: "Submitting to Hyperliquid…",
    refreshing: "Refreshing approval state…",
  };
  const subs: Record<Phase, string> = {
    idle: "",
    building: "Building the EIP-712 typed-data payload server-side.",
    signing: "Open your wallet (or the Privy modal) and approve the signature.",
    sending: "Forwarding your signed payload to Hyperliquid.",
    refreshing: "Reading the on-chain approval state back.",
  };
  return (
    <CardShell>
      <WalletChip address={props.userAddress} onDisconnect={props.onDisconnect} />

      <div className="pending-row">
        <span className="spinner"></span>
        <div className="txt">
          <div className="ttl">{titles[props.phase]}</div>
          <div className="sub">{subs[props.phase]}</div>
        </div>
      </div>

      <button className="btn btn-primary btn-block btn-disabled" aria-disabled="true">
        Awaiting signature
      </button>

      <details className="details">
        <summary>What you&apos;re signing</summary>
        <pre>
{`ApproveBuilderFee {
  builder:    "${shortAddr(BUILDER_ADDR || "0x0")}",
  maxFeeRate: "${props.feeRate}%",
  nonce:      ${Date.now()}
}

No transaction will be broadcast.
No funds move from this signature.`}
        </pre>
      </details>

      <div className="card-foot">
        <span>Arbitrum One · chainId 42161</span>
        <Link href="/onboarding">Account readiness</Link>
      </div>
    </CardShell>
  );
}

function ErrorCard(props: {
  error: ErrState;
  userAddress: string;
  feeRate: string;
  setFeeRate: (s: string) => void;
  onRetry: () => void;
  onDisconnect: () => void;
}) {
  return (
    <CardShell>
      <WalletChip address={props.userAddress} onDisconnect={props.onDisconnect} />

      <div className="error-banner">
        <span className="ic">!</span>
        <div>
          <div className="ttl">Something went wrong</div>
          <div>{props.error.guidance}</div>
          <div style={{ opacity: 0.7, marginTop: 4 }}>({props.error.message})</div>
        </div>
      </div>

      <div className="field-group">
        <div className="field-label">
          <span className="lbl">Max fee rate</span>
          <span className="hint">Protocol max 0.1% perps · 1% spot</span>
        </div>
        <div className="fee-input">
          <input
            type="text"
            value={props.feeRate}
            onChange={(e) => props.setFeeRate(e.target.value)}
            inputMode="decimal"
          />
          <span className="suffix">%</span>
        </div>
      </div>

      <button className="btn btn-primary btn-block" onClick={props.onRetry}>
        Try again
        <svg className="btn-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />
        </svg>
      </button>

      <div className="card-foot">
        <span>Arbitrum One · chainId 42161</span>
        <Link href="/connectors">Connector safety</Link>
      </div>
    </CardShell>
  );
}

function DepositCard(props: {
  error: ErrState;
  userAddress: string;
  isEmbedded: boolean;
  onDisconnect: () => void;
  onRetry: () => void;
  usdcBalance: number;
  depositAmount: string;
  setDepositAmount: (s: string) => void;
  depositPhase: "idle" | "submitting" | "confirming" | "done" | "error";
  depositTxHash: `0x${string}` | undefined;
  depositConfirming: boolean;
  depositError: string | null;
  onDeposit: () => void;
  onResetDeposit: () => void;
}) {
  // Server's guidance string carries the right HL deposit URL (mainnet vs
  // testnet). On testnet the deposit-via-bridge flow is different (faucet),
  // so we fall back to the external link there.
  const urlMatch = props.error.guidance.match(/https:\/\/[^\s)]+/);
  const externalUrl = urlMatch?.[0];
  const isTestnet = externalUrl?.includes("testnet") ?? false;

  const amountNum = Number(props.depositAmount);
  const amountOk = amountNum > 0 && amountNum <= props.usdcBalance;
  const inFlight = props.depositPhase === "submitting" || props.depositPhase === "confirming";

  return (
    <CardShell>
      <WalletChip address={props.userAddress} onDisconnect={props.onDisconnect} />

      <h1 className="approve-title">One step first: deposit USDC.</h1>
      <p className="approve-sub">
        Even gas-free actions like <code>approveBuilderFee</code> need a non-empty
        Hyperliquid account. {isTestnet
          ? "Claim testnet USDC at the link below, then come back and click Retry."
          : "Deposit USDC from this wallet into Hyperliquid, then click Retry."}
      </p>

      {/* Testnet path: external faucet link. Mainnet path: in-app deposit. */}
      {isTestnet ? (
        externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary btn-block"
            style={{ marginBottom: 14 }}
          >
            Open Hyperliquid testnet faucet
            <svg className="btn-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </a>
        )
      ) : (
        <>
          <div className="field-group">
            <div className="field-label">
              <span className="lbl">Amount to deposit</span>
              <span className="hint">Wallet balance: {props.usdcBalance.toFixed(2)} USDC</span>
            </div>
            <div className="fee-input">
              <input
                type="text"
                inputMode="decimal"
                value={props.depositAmount}
                onChange={(e) => props.setDepositAmount(e.target.value)}
                disabled={inFlight || props.depositPhase === "done"}
              />
              <span className="suffix">USDC</span>
            </div>
            <div className="fee-meta">
              Sends to Hyperliquid Bridge2 on Arbitrum.{" "}
              <a
                href={`https://arbiscan.io/address/${HL_BRIDGE_ARBITRUM}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Verify contract ↗
              </a>
            </div>
          </div>

          {(props.depositPhase === "idle" || props.depositPhase === "error") && (
            <button
              className={`btn btn-primary btn-block${amountOk ? "" : " btn-disabled"}`}
              onClick={props.onDeposit}
              disabled={!amountOk}
            >
              Deposit {props.depositAmount} USDC into Hyperliquid
              <svg className="btn-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          )}

          {props.depositPhase === "submitting" && (
            <div className="pending-row" style={{ marginBottom: 14 }}>
              <span className="spinner"></span>
              <div className="txt">
                <div className="ttl">Confirm in your wallet…</div>
                <div className="sub">Approve the USDC transfer to HL Bridge2.</div>
              </div>
            </div>
          )}

          {props.depositPhase === "confirming" && (
            <div className="pending-row" style={{ marginBottom: 14 }}>
              <span className="spinner"></span>
              <div className="txt">
                <div className="ttl">Waiting for Arbitrum confirmation…</div>
                <div className="sub">
                  {props.depositTxHash && (
                    <a
                      href={`https://arbiscan.io/tx/${props.depositTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View on Arbiscan ↗
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}

          {props.depositPhase === "done" && (
            <>
              <div className="approved-badge" style={{ marginBottom: 14 }}>
                <span className="check">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
                </span>
                <div>
                  <div className="ttl">Deposit confirmed</div>
                  <div className="meta">
                    {props.depositTxHash && (
                      <a
                        href={`https://arbiscan.io/tx/${props.depositTxHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        View tx ↗
                      </a>
                    )}
                  </div>
                </div>
              </div>
              <p style={{ fontSize: 12, color: "var(--fg-dim)", marginBottom: 14 }}>
                HL&apos;s indexer credits the account within ~3 seconds. Click Retry.
              </p>
            </>
          )}

          {props.depositPhase === "error" && props.depositError && (
            <div className="error-banner">
              <span className="ic">!</span>
              <div>
                <div className="ttl">Deposit failed</div>
                <div>{props.depositError}</div>
              </div>
            </div>
          )}
        </>
      )}

      {!isTestnet && props.usdcBalance < amountNum && (
        <a
          className="btn btn-secondary btn-secondary-block"
          href="https://app.uniswap.org/swap?chain=arbitrum&outputCurrency=0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
          target="_blank"
          rel="noopener noreferrer"
          style={{ marginBottom: 14, marginTop: 14 }}
        >
          Get USDC on Arbitrum ↗
        </a>
      )}

      <button
        className="btn btn-secondary btn-secondary-block"
        onClick={() => {
          if (props.depositPhase === "error") props.onResetDeposit();
          props.onRetry();
        }}
        style={{ marginTop: 14 }}
      >
        Retry approval
      </button>

      <p style={{ fontSize: 12, color: "var(--fg-dim)", marginTop: 14, lineHeight: 1.55 }}>
        {props.error.message}
      </p>

      <div className="card-foot">
        <span>{isTestnet ? "Hyperliquid testnet" : "Hyperliquid mainnet"}</span>
        <Link href="/onboarding">Account readiness</Link>
      </div>
    </CardShell>
  );
}

function BridgeDepositDisabledCard(props: {
  title: string;
  summary: string;
  error: ErrState;
  userAddress: string;
  onDisconnect: () => void;
  onRetry: () => void;
}) {
  return (
    <CardShell>
      <WalletChip address={props.userAddress} onDisconnect={props.onDisconnect} />
      <h1 className="approve-title">{props.title}</h1>
      <p className="approve-sub">{props.summary}</p>
      <div className="explainer">
        Funding a wallet is not the same as depositing into Hyperliquid.
        Return to account readiness for funding guidance. Restricted or unknown
        eligibility cannot use live funding or compatibility actions.
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        <Link className="btn btn-primary btn-block" href="/onboarding">
          Account readiness
        </Link>
        <Link className="btn btn-secondary btn-secondary-block" href="/terminal">
          Open terminal
        </Link>
        <button className="btn btn-secondary btn-secondary-block" onClick={props.onRetry}>
          Retry compatibility check
        </button>
      </div>
      <p style={{ fontSize: 12, color: "var(--fg-dim)", marginTop: 14, lineHeight: 1.55 }}>
        {props.error.message}
      </p>
    </CardShell>
  );
}

// ============================================================================
// TestTradeCard — flag-gated, internal smoke test
// ============================================================================

/**
 * Internal smoke-test surface. Not product UI. Rendered only when
 * NEXT_PUBLIC_ENABLE_TEST_TRADE=true (see top-of-file constant).
 *
 * Drives the same build → sign → send /exchange flow real callers use,
 * with sane defaults for a tiny BTC perp IOC order. Polls the builder's HL
 * balance before/after so you can visually confirm the fee credited.
 *
 * Order shape:
 *   { a: 0, b: true, p: "<high price>", s: <size>, r: false,
 *     t: { limit: { tif: "Ioc" } } }
 * For an IOC buy you set the limit *above* market so the order takes the ask
 * side and fills immediately. The fill price is whatever's on the book, not
 * the limit price.
 */
function TestTradeCard({ userAddress }: { userAddress: `0x${string}` }) {
  // Form state. Defaults: BTC perp, buy, 0.0002 BTC, IOC limit auto-derived
  // from live mark price below.
  const [asset, setAsset] = useState("0");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [size, setSize] = useState("0.0002");
  const [price, setPrice] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);

  // Live mark price + auto-set the IOC limit to a safe distance from market
  // (50% above mark for buys = safely takes the ask; 50% below for sells =
  // safely takes the bid). Re-fetches on side change or asset change.
  const [markPrice, setMarkPrice] = useState<number | null>(null);
  const fetchMarkPrice = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/markPrice?asset=${asset}`);
      if (!res.ok) return;
      const body = (await res.json()) as { mid: string };
      const mid = Number(body.mid);
      if (!Number.isFinite(mid)) return;
      setMarkPrice(mid);
      // Default the limit if user hasn't typed one yet; respect manual input.
      setPrice((cur) => {
        if (cur && cur.trim().length > 0) return cur;
        const safeLimit = side === "buy" ? mid * 1.5 : mid * 0.5;
        return safeLimit.toFixed(2);
      });
    } catch {
      // Non-blocking; user can type a limit manually.
    }
  }, [asset, side]);

  useEffect(() => {
    void fetchMarkPrice();
  }, [fetchMarkPrice]);

  const [phase, setPhase] = useState<"idle" | "building" | "signing" | "sending" | "done" | "error">("idle");
  const [result, setResult] = useState<SendResponse | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Builder's HL balance before/after — proof that the fee credited.
  const [builderBalanceBefore, setBuilderBalanceBefore] = useState<BalanceState | null>(null);
  const [builderBalanceAfter, setBuilderBalanceAfter] = useState<BalanceState | null>(null);

  // We need wallet.getEthereumProvider() because L1 order actions use HL's
  // phantom-agent envelope with chainId 1337 — wagmi's useSignTypedData
  // rejects domains whose chainId doesn't match the active chain (42161).
  // The EIP-1193 provider from each wallet (embedded or external) signs
  // whatever domain you hand it, no chain check.
  const { wallets } = useWallets();
  const activeWallet = wallets.find((w) => w.address.toLowerCase() === userAddress.toLowerCase());
  const builderAddr = BUILDER_ADDR as `0x${string}` | undefined;

  const runTrade = useCallback(async () => {
    setErrMsg(null);
    setResult(null);
    setBuilderBalanceAfter(null);
    if (!activeWallet) {
      setErrMsg("No active wallet found. Sign out and back in.");
      setPhase("error");
      return;
    }
    try {
      // Snapshot the builder's HL balance pre-trade so we can show the delta.
      if (builderAddr) {
        try {
          const before = await api.balance(builderAddr);
          setBuilderBalanceBefore(before);
        } catch {
          // Non-blocking — proceed without baseline.
        }
      }

      setPhase("building");
      const built = (await api.build({
        type: "order",
        grouping: "na",
        orders: [
          {
            a: Number(asset),
            b: side === "buy",
            p: price,
            s: size,
            r: reduceOnly,
            t: { limit: { tif: "Ioc" } },
          },
        ],
      })) as BuildResponse;
      if (!built.typedData) throw new Error("Server did not return typedData.");

      setPhase("signing");
      // Sign via EIP-1193 directly to bypass wagmi's chain-id enforcement.
      // The phantom-agent domain uses chainId 1337 by HL spec (not Arbitrum);
      // wagmi rejects domain.chainId ≠ active chain. Raw provider doesn't.
      // We must include EIP712Domain in `types` ourselves — wagmi adds it
      // implicitly but raw eth_signTypedData_v4 requires it explicit.
      const provider = await activeWallet.getEthereumProvider();
      const typedWithDomain = {
        domain: built.typedData.domain,
        primaryType: built.typedData.primaryType,
        message: built.typedData.message,
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          ...built.typedData.types,
        },
      };
      const sigHex = (await provider.request({
        method: "eth_signTypedData_v4",
        params: [activeWallet.address, JSON.stringify(typedWithDomain)],
      })) as `0x${string}`;
      const sig = splitHexSig(sigHex);

      setPhase("sending");
      const sent = (await api.send(built.action, built.nonce, sig)) as SendResponse;
      setResult(sent);
      setPhase("done");

      // Indexer needs a beat. Re-fetch builder balance after a short wait.
      if (builderAddr) {
        setTimeout(async () => {
          try {
            const after = await api.balance(builderAddr);
            setBuilderBalanceAfter(after);
          } catch {
            // ignore
          }
        }, 4000);
      }
    } catch (err) {
      const body = (err as { body?: { message?: string; guidance?: string } }).body;
      // Show both message + guidance — message is HL's literal reason, guidance
      // is ours. The literal reason is what tells you what's actually wrong.
      const parts: string[] = [];
      if (body?.message) parts.push(`HL: ${body.message}`);
      if (body?.guidance) parts.push(body.guidance);
      setErrMsg(parts.join("\n\n") || (err as Error).message);
      setPhase("error");
    }
  }, [asset, side, price, size, reduceOnly, activeWallet, builderAddr]);

  const inFlight = phase === "building" || phase === "signing" || phase === "sending";
  const phaseLabel: Record<typeof phase, string> = {
    idle: "",
    building: "Building order…",
    signing: "Confirm in Privy modal…",
    sending: "Submitting to Hyperliquid…",
    done: "",
    error: "",
  };

  // Estimated builder fee from the API's default config (perps = 4 bps).
  // Use mark price (live HL mid) for the estimate — the IOC limit is
  // intentionally distant from market and doesn't reflect the fill price.
  const sizeNum = Number(size);
  const notional = sizeNum > 0 && markPrice ? sizeNum * markPrice : 0;
  const estimatedBuilderFee = notional * 0.0004;

  // After a successful fill, expose a one-click "Close position" affordance:
  // flips side, checks reduce-only, swaps the IOC limit to the other side of
  // mark, leaves size as-is. Same trade in reverse — closes the perp position.
  const flipToClose = useCallback(() => {
    setSide((s) => (s === "buy" ? "sell" : "buy"));
    setReduceOnly(true);
    if (markPrice) {
      // Opposite side now → flip the safe-distance multiplier.
      const newSide = side === "buy" ? "sell" : "buy";
      setPrice((newSide === "buy" ? markPrice * 1.5 : markPrice * 0.5).toFixed(2));
    }
    setPhase("idle");
    setResult(null);
    setErrMsg(null);
  }, [markPrice, side]);

  // Manual refresh of the builder's HL balance — surfaces the actual fee
  // delta even if the auto-poll fired before HL's indexer caught up.
  const refreshBuilderBalance = useCallback(async () => {
    if (!builderAddr) return;
    try {
      const fresh = await api.balance(builderAddr);
      setBuilderBalanceAfter(fresh);
    } catch {
      // ignore
    }
  }, [builderAddr]);

  const deltaUsd =
    builderBalanceBefore && builderBalanceAfter
      ? Number(builderBalanceAfter.accountValue) - Number(builderBalanceBefore.accountValue)
      : null;

  return (
    <div className="approve-card" style={{ borderColor: "#5a4220" }}>
      <header className="approve-head" style={{ background: "rgba(255,193,77,0.08)" }}>
        <span className="brand">
          <span style={{ fontSize: 16 }}>🧪</span>
          <span>Test trade (internal, flag-gated)</span>
        </span>
      </header>
      <div className="approve-body">
        <p className="approve-sub" style={{ marginTop: 0 }}>
          <strong>Not product surface.</strong> Renders only when{" "}
          <code>NEXT_PUBLIC_ENABLE_TEST_TRADE=true</code>. Used to smoke-test the
          fee-earning loop end-to-end on mainnet from inside our app. Agents would call
          <code> POST /exchange</code> directly.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
          <label>
            <div style={{ fontSize: 12, color: "var(--fg-dim)", marginBottom: 4 }}>Asset index</div>
            <input
              value={asset}
              onChange={(e) => setAsset(e.target.value)}
              style={fieldStyle}
              disabled={inFlight}
            />
            <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 4 }}>
              0 = BTC perp, 1 = ETH perp, …
            </div>
          </label>
          <label>
            <div style={{ fontSize: 12, color: "var(--fg-dim)", marginBottom: 4 }}>Side</div>
            <select
              value={side}
              onChange={(e) => setSide(e.target.value as "buy" | "sell")}
              style={fieldStyle}
              disabled={inFlight}
            >
              <option value="buy">buy</option>
              <option value="sell">sell</option>
            </select>
          </label>
          <label>
            <div style={{ fontSize: 12, color: "var(--fg-dim)", marginBottom: 4 }}>Size (base)</div>
            <input
              value={size}
              onChange={(e) => setSize(e.target.value)}
              style={fieldStyle}
              disabled={inFlight}
            />
          </label>
          <label>
            <div style={{ fontSize: 12, color: "var(--fg-dim)", marginBottom: 4 }}>
              Limit price (IOC takes whatever's better)
            </div>
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              style={fieldStyle}
              disabled={inFlight}
            />
          </label>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={reduceOnly}
            onChange={(e) => setReduceOnly(e.target.checked)}
            disabled={inFlight}
          />
          Reduce-only (closes existing position; won't open a new one)
        </label>

        <div style={{ fontSize: 12, color: "var(--fg-dim)", marginBottom: 14, lineHeight: 1.6 }}>
          {markPrice ? (
            <>
              Mark price: <strong style={{ color: "var(--fg-muted)" }}>${markPrice.toLocaleString()}</strong>
              {" · "}
              Est. notional at mark: <strong style={{ color: "var(--fg-muted)" }}>${notional.toFixed(2)}</strong>
              {" · "}
              Est. builder fee (4 bps): <strong style={{ color: "var(--success-soft)" }}>${estimatedBuilderFee.toFixed(4)}</strong>
              {" · "}
              <button
                type="button"
                onClick={fetchMarkPrice}
                style={{ background: "none", border: 0, color: "var(--accent)", cursor: "pointer", padding: 0, fontSize: 11 }}
              >
                refresh
              </button>
            </>
          ) : (
            <>Loading mark price… (notional shown after price loads)</>
          )}
        </div>

        <button
          className={`btn btn-primary btn-block${inFlight ? " btn-disabled" : ""}`}
          onClick={runTrade}
          disabled={inFlight}
        >
          {inFlight ? phaseLabel[phase] : "Place test trade"}
        </button>

        {phase === "error" && errMsg && (
          <div className="error-banner" style={{ marginTop: 14 }}>
            <span className="ic">!</span>
            <div>
              <div className="ttl">Trade failed</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{errMsg}</div>
            </div>
          </div>
        )}

        {phase === "done" && result && (
          <div style={{ marginTop: 14 }}>
            <div className="approved-badge" style={{ marginBottom: 14 }}>
              <span className="check">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
              </span>
              <div>
                <div className="ttl">Trade submitted</div>
                <div className="meta">
                  Signer: {shortAddr(result.user)}
                  {deltaUsd !== null && (
                    <> · Builder Δ: <strong>${deltaUsd.toFixed(4)}</strong> {deltaUsd > 0 ? "✓" : "(awaiting fill / indexer)"}</>
                  )}
                </div>
              </div>
            </div>

            {/* Action row: close position + refresh balance */}
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              {!reduceOnly && (
                <button
                  className="btn btn-primary"
                  onClick={flipToClose}
                  style={{ flex: 1, justifyContent: "center" }}
                >
                  Close position (flip & retry)
                </button>
              )}
              <button
                className="btn btn-secondary"
                onClick={refreshBuilderBalance}
                style={{ flex: 1, justifyContent: "center" }}
              >
                Refresh builder balance
              </button>
            </div>

            <details className="details">
              <summary>HL response</summary>
              <pre>{JSON.stringify(result.exchangeResponse, null, 2)}</pre>
            </details>
            {builderBalanceBefore && (
              <details className="details" style={{ marginTop: 8 }}>
                <summary>Builder HL balance before / after</summary>
                <pre>
{`before: $${builderBalanceBefore.accountValue}
after:  ${builderBalanceAfter ? "$" + builderBalanceAfter.accountValue : "(polling…)"}
delta:  ${deltaUsd !== null ? "$" + deltaUsd.toFixed(6) : "—"}

Note: HL's accountValue may have limited precision. Sub-cent fee credits
on a $100 balance often surface as "100.0" exactly. Use a fresh curl to
api /balance for raw HL response if you need to see fractional builder fees.`}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(0,0,0,0.25)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "8px 10px",
  color: "var(--fg)",
  fontFamily: "var(--font-mono)",
  fontSize: 13,
};

// ============================================================================
// Helpers
// ============================================================================

function shortAddr(a: string): string {
  if (!a || a.length < 10) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function displayUser(
  user: ReturnType<typeof usePrivy>["user"],
  address?: string,
): string {
  return user?.email?.address ?? user?.google?.email ?? (address ? shortAddr(address) : "—");
}

function splitHexSig(hex: `0x${string}`): {
  r: `0x${string}`;
  s: `0x${string}`;
  v: number;
} {
  const stripped = hex.slice(2);
  if (stripped.length !== 130) {
    throw new Error(
      `Unexpected signature length ${stripped.length}; expected 130 hex chars.`,
    );
  }
  return {
    r: `0x${stripped.slice(0, 64)}` as `0x${string}`,
    s: `0x${stripped.slice(64, 128)}` as `0x${string}`,
    v: parseInt(stripped.slice(128, 130), 16),
  };
}

function extractApiError(err: unknown): ErrState {
  if (err && typeof err === "object" && "body" in err) {
    const body = (err as {
      body?: { error?: string; message?: string; guidance?: string };
    }).body;
    if (body?.guidance) {
      return {
        code: body.error,
        message: body.message ?? "Request failed.",
        guidance: body.guidance,
      };
    }
  }
  const message = (err as Error)?.message ?? "Something went wrong.";
  return {
    message,
    guidance: "Try again. If it keeps failing, check the browser console for details.",
  };
}
