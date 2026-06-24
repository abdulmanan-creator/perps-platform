"use client";

/**
 * /oauth/authorize — the user-facing landing page in our OAuth flow.
 *
 * Claude Web / ChatGPT Apps redirect users here with OAuth params. The page:
 *   1. Validates required params (client_id, redirect_uri)
 *   2. Shows Privy sign-in if not already authenticated
 *   3. Walks the user through builder-fee and legacy connector compatibility
 *      signatures when this OAuth path requires them
 *   4. Calls POST /oauth/issue-code with the user's Privy JWT → gets an
 *      auth code bound to client_id + redirect_uri + PKCE challenge
 *   5. Redirects to `${redirect_uri}?code=${code}&state=${state}` so Claude
 *      can exchange it for an access token at /oauth/token
 *
 * Failure handling:
 *   - Missing required params before we know redirect_uri → inline error
 *   - User aborts / API errors with redirect_uri known → redirect with
 *     ?error=access_denied&error_description=... per OAuth spec
 *
 * Wagmi/Privy sync, signature splitting, error extraction — all reused from
 * /approve. Different state machine for the OAuth-specific flow.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import {
  usePrivy,
  useWallets,
  type ConnectedWallet,
} from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { useSignTypedData } from "wagmi";

import { AppShell } from "@/components/agent-trade/AppShell";
import { getOAuthCompatibilityDecision } from "@/lib/agent-trade/legacy-safety";
import type { EligibilityMode } from "@/lib/agent-trade/types";
import { API_BASE_URL as API_URL } from "@/lib/api";

const HAS_PRIVY = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
const OAUTH_COMPAT_APPROVALS_ENABLED =
  process.env.NEXT_PUBLIC_AGENT_TRADE_ENABLE_OAUTH_COMPAT_APPROVALS === "true";

type Step =
  | "init"
  | "loading-state"
  | "need-builder"
  | "signing-builder"
  | "need-agent"
  | "signing-agent"
  | "issuing"
  | "redirecting"
  | "error";

interface ErrState {
  message: string;
  guidance?: string;
  /** OAuth-spec error code we'd redirect with if redirect_uri is known. */
  oauthCode?:
    | "access_denied"
    | "invalid_request"
    | "server_error"
    | "temporarily_unavailable";
}

export default function AuthorizePage() {
  return (
    <AppShell>
      <Suspense fallback={<LoadingShell />}>
        <AuthorizeFlow />
      </Suspense>
    </AppShell>
  );
}

function LoadingShell() {
  return (
    <main className="onboarding-page">
      <header className="onboarding-head">
        <h1>Connecting…</h1>
      </header>
    </main>
  );
}

function AuthorizeFlow() {
  if (!OAUTH_COMPAT_APPROVALS_ENABLED) {
    return <OAuthCompatibilityDisabled />;
  }
  if (!HAS_PRIVY) {
    return <AuthorizeMissingPrivy />;
  }
  return <AuthorizeFlowWithPrivy />;
}

function AuthorizeFlowWithPrivy() {
  const params = useSearchParams();

  // OAuth params from the redirect that landed us here.
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const state = params.get("state") ?? "";
  const codeChallenge = params.get("code_challenge") ?? undefined;
  const codeChallengeMethod = (params.get("code_challenge_method") ?? undefined) as
    | "S256"
    | undefined;
  const scope = params.get("scope") ?? "trade";

  const { ready, authenticated, login, logout, user, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { signTypedDataAsync } = useSignTypedData();

  // Prefer Privy embedded wallet — matches /approve's selection logic.
  const activeWallet = useMemo<ConnectedWallet | undefined>(() => {
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    return embedded ?? wallets[0];
  }, [wallets]);
  const userAddress = activeWallet?.address as `0x${string}` | undefined;

  // Keep wagmi's signer in sync with Privy's active wallet so signTypedDataAsync
  // signs with the right key (matches /approve's wagmi sync fix).
  useEffect(() => {
    if (activeWallet) void setActiveWallet(activeWallet);
  }, [activeWallet, setActiveWallet]);

  const [step, setStep] = useState<Step>("init");
  const [errorState, setErrorState] = useState<ErrState | null>(null);
  const [agentAddress, setAgentAddress] = useState<`0x${string}` | null>(null);
  const [eligibilityState, setEligibilityState] = useState<EligibilityMode>("loading");
  const oauthDecision = getOAuthCompatibilityDecision({
    featureEnabled: OAUTH_COMPAT_APPROVALS_ENABLED,
    eligibilityState,
  });

  // ---- Param validation (hard fail if missing) -----------------------------

  const paramsValid = !!clientId && !!redirectUri && isValidUrl(redirectUri);
  const paramsErrorMessage = !clientId
    ? "Missing required OAuth parameter: client_id."
    : !redirectUri
    ? "Missing required OAuth parameter: redirect_uri."
    : !isValidUrl(redirectUri)
    ? "redirect_uri must be a valid absolute URL."
    : null;

  // ---- Helpers -------------------------------------------------------------

  /**
   * Redirect back to the OAuth client. Used both on success (with code) and on
   * recoverable failure (with error). For unrecoverable failures before we
   * know a valid redirect_uri, render inline instead.
   */
  const redirectTo = useCallback(
    (queryParams: Record<string, string>) => {
      const url = new URL(redirectUri!);
      for (const [k, v] of Object.entries(queryParams)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
      }
      if (state) url.searchParams.set("state", state);
      window.location.href = url.toString();
    },
    [redirectUri, state],
  );

  const failWithError = useCallback(
    (oauthCode: ErrState["oauthCode"], message: string, guidance?: string) => {
      setErrorState({ message, guidance, oauthCode });
      setStep("error");
    },
    [],
  );

  /** Sign + submit any user-signed action via POST /exchange. */
  const signAndSubmit = useCallback(
    async (
      action: { type: string; [k: string]: unknown },
      opts: { user?: `0x${string}` } = {},
    ) => {
      const decision = getOAuthCompatibilityDecision({
        featureEnabled: OAUTH_COMPAT_APPROVALS_ENABLED,
        eligibilityState,
      });
      if (!decision.allowed) {
        throw new Error(decision.summary);
      }
      // Phase A — build typed data.
      const buildRes = await fetch(`${API_URL}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...(opts.user ? { user: opts.user } : {}) }),
      });
      if (!buildRes.ok) throw await asApiError(buildRes);
      const built = (await buildRes.json()) as {
        action: typeof action;
        nonce: number;
        typedData?: {
          domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
          types: Record<string, { name: string; type: string }[]>;
          primaryType: string;
          message: Record<string, unknown>;
        };
      };
      if (!built.typedData) throw new Error("Backend did not return typedData for build phase.");

      // Phase B — sign via wagmi. These compatibility actions use chainId
      // 42161, so wagmi's chain-id enforcement is satisfied.
      const sigHex = await signTypedDataAsync({
        domain: built.typedData.domain,
        types: built.typedData.types,
        primaryType: built.typedData.primaryType,
        message: built.typedData.message,
      });
      const signature = splitHexSig(sigHex as `0x${string}`);

      const sendRes = await fetch(`${API_URL}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: built.action, nonce: built.nonce, signature }),
      });
      if (!sendRes.ok) throw await asApiError(sendRes);
    },
    [eligibilityState, signTypedDataAsync],
  );

  // ---- Step transitions ----------------------------------------------------

  // Load builder-approval state + agent address once authenticated.
  useEffect(() => {
    if (step !== "init") return;
    if (!paramsValid) return;
    if (!ready) return;
    if (!authenticated) return;
    if (!userAddress) return;
    if (eligibilityState === "loading") return;
    if (!oauthDecision.allowed) {
      failWithError("access_denied", oauthDecision.title, oauthDecision.summary);
      return;
    }

    setStep("loading-state");
    (async () => {
      try {
        const [approval, agent] = await Promise.all([
          fetch(`${API_URL}/approval?user=${userAddress}`).then((r) => r.json()),
          fetch(`${API_URL}/agent?user=${userAddress}`).then((r) => r.json()),
        ]);
        if (!agent?.agentAddress) {
          failWithError(
            "server_error",
            "Server is not configured for connector compatibility.",
            "Internal connector compatibility configuration is missing on the API service. Set it and restart.",
          );
          return;
        }
        setAgentAddress(agent.agentAddress);

        // Step transitions, in order of precedence:
        //   1. Builder fee not yet approved → need-builder
        //   2. Compatibility wallet already approved on HL (e.g. user
        //      previously OAuth'd from Claude and is now coming through
        //      ChatGPT) → skip the compatibility signature and issue the
        //      OAuth code. Re-approving the same agent address fails on
        //      HL with "Extra agent already used".
        //   3. Otherwise → need-agent, prompt the signature.
        if (!approval?.approved) {
          setStep("need-builder");
        } else if (agent.approved) {
          setStep("issuing");
        } else {
          setStep("need-agent");
        }
      } catch (err) {
        failWithError("server_error", `Could not load auth state: ${(err as Error).message}`);
      }
    })();
  }, [step, paramsValid, ready, authenticated, userAddress, eligibilityState, oauthDecision.allowed, oauthDecision.summary, oauthDecision.title, failWithError]);

  useEffect(() => {
    if (!ready || !authenticated || !userAddress) {
      setEligibilityState("loading");
      return;
    }

    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/agent-trade/eligibility`, { cache: "no-store" });
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

  // Reset the state machine when the user signs out (e.g., via the "Switch
  // account" button). Without this, step would stay at "need-agent" and the
  // loading effect above would skip re-fetching on re-login with a different
  // wallet, leaving the page showing stale state.
  useEffect(() => {
    if (ready && !authenticated) {
      setStep("init");
      setAgentAddress(null);
      setErrorState(null);
    }
  }, [ready, authenticated]);

  // ---- Sign actions --------------------------------------------------------

  const runApproveBuilder = useCallback(async () => {
    if (!oauthDecision.allowed) {
      failWithError("access_denied", oauthDecision.title, oauthDecision.summary);
      return;
    }
    setStep("signing-builder");
    try {
      await signAndSubmit({ type: "approveBuilderFee", maxFeeRate: "1%" });
      setStep("need-agent");
    } catch (err) {
      const e = err as { message?: string; guidance?: string };
      failWithError("access_denied", e.message ?? "approveBuilderFee failed.", e.guidance);
    }
  }, [oauthDecision.allowed, oauthDecision.summary, oauthDecision.title, signAndSubmit, failWithError]);

  const runApproveAgent = useCallback(async () => {
    if (!userAddress) return;
    if (!oauthDecision.allowed) {
      failWithError("access_denied", oauthDecision.title, oauthDecision.summary);
      return;
    }
    setStep("signing-agent");
    try {
      await signAndSubmit({ type: "approveAgent" }, { user: userAddress });
      setStep("issuing");
    } catch (err) {
      const e = err as { message?: string; guidance?: string };
      failWithError("access_denied", e.message ?? "Connector compatibility approval failed.", e.guidance);
    }
  }, [oauthDecision.allowed, oauthDecision.summary, oauthDecision.title, signAndSubmit, userAddress, failWithError]);

  // ---- Issue code + redirect -----------------------------------------------

  useEffect(() => {
    if (step !== "issuing") return;
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error("Privy session has no access token.");
        const res = await fetch(`${API_URL}/oauth/issue-code`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            client_id: clientId,
            redirect_uri: redirectUri,
            code_challenge: codeChallenge,
            code_challenge_method: codeChallengeMethod,
          }),
        });
        if (!res.ok) throw await asApiError(res);
        const body = (await res.json()) as { code: string };
        setStep("redirecting");
        redirectTo({ code: body.code });
      } catch (err) {
        const e = err as { message?: string; guidance?: string };
        failWithError(
          "server_error",
          e.message ?? "Failed to issue authorization code.",
          e.guidance,
        );
      }
    })();
  }, [step, clientId, redirectUri, codeChallenge, codeChallengeMethod, getAccessToken, redirectTo, failWithError]);

  // ---- Render --------------------------------------------------------------

  // Hard fail: invalid params before we know where to redirect → inline.
  if (!paramsValid) {
    return (
      <main className="connect-shell">
        <div className="approve-card">
          <div className="approve-body">
            <h1 className="approve-title">Invalid OAuth request</h1>
            <p className="approve-sub">{paramsErrorMessage}</p>
            <div className="callout warn">
              The connector that sent you here didn&apos;t include the required
              parameters. Try removing and re-adding the connector in Claude /
              ChatGPT, or contact your AI client&apos;s support.
            </div>
          </div>
        </div>
      </main>
    );
  }

  // Error after redirect_uri is known: redirect with OAuth-spec error.
  if (step === "error" && errorState?.oauthCode && redirectUri) {
    return (
      <main className="connect-shell">
        <div className="approve-card">
          <div className="approve-body">
            <h1 className="approve-title">Authorization failed</h1>
            <p className="approve-sub">{errorState.message}</p>
            {errorState.guidance && (
              <p style={{ fontSize: 13, color: "var(--fg-dim)", marginBottom: 18 }}>
                {errorState.guidance}
              </p>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn btn-secondary"
                onClick={() =>
                  redirectTo({
                    error: errorState.oauthCode ?? "access_denied",
                    error_description: errorState.message,
                  })
                }
              >
                Return to client with error
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setErrorState(null);
                  setStep("init");
                }}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="connect-shell">
      <header className="connect-head">
        <span className="eyebrow">Authorize connector</span>
        <h1>Connect Agent.trade</h1>
        <p>
          This connector flow lets an assistant request Agent.trade market
          context and draft proposals. In the current MVP flow, orders return
          to Agent.trade for eligibility checks, caps, risk acknowledgement,
          and explicit confirmation.
        </p>
      </header>

      {/* Client info */}
      <div className="callout">
        Connecting:{" "}
        <strong style={{ fontFamily: "var(--font-mono)" }}>{clientId}</strong>
        {" · "}
        Returns to: <code style={{ fontSize: 12 }}>{redirectUri}</code>
      </div>

      {/* --- Step rendering --- */}
      {!ready && <p style={{ marginTop: 24, opacity: 0.6 }}>Loading…</p>}

      {ready && !authenticated && (
        <div style={{ marginTop: 28 }}>
          <button className="btn btn-primary btn-block" onClick={() => login()}>
            Sign in to authorize
          </button>
          <p style={{ fontSize: 12, color: "var(--fg-dim)", marginTop: 12 }}>
            Sign in with email, Google, or an existing wallet. Wallet connection
            does not bypass Agent.trade confirmation.
          </p>
        </div>
      )}

      {ready && authenticated && userAddress && (
        <div style={{ marginTop: 28 }}>
          <div
            className="callout"
            style={{
              marginBottom: 24,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <strong>Signed in as:</strong>{" "}
              {user?.email?.address ??
                (user?.google as { email?: string } | undefined)?.email ??
                shortAddr(userAddress)}{" "}
              ·{" "}
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {shortAddr(userAddress)}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: 13, padding: "6px 12px" }}
              onClick={async () => {
                try {
                  await logout();
                } catch (err) {
                  // Logout shouldn't fail in practice; if it does, the
                  // page state still resets because Privy clears local
                  // session synchronously before the promise settles.
                  console.warn("logout failed", err);
                }
              }}
            >
              Switch account
            </button>
          </div>

          {step === "loading-state" && (
            <p style={{ opacity: 0.6 }}>Checking your authorization state…</p>
          )}

          {step === "need-builder" && (
            <div className="step">
              <div className="step-num">1</div>
              <div className="step-body">
                <h3>Review builder-fee compatibility</h3>
                <p>
                  One-time signature setting a <strong>1%</strong> ceiling
                  on builder fees for legacy Hyperliquid routing compatibility.
                  The actual fee is{" "}
                  <strong>0.04% on perps</strong> and{" "}
                  <strong>0.05% on spot</strong>. This does not change the
                  current MVP confirmation requirement.
                </p>
                <button className="btn btn-primary" onClick={runApproveBuilder}>
                  Sign compatibility approval
                </button>
              </div>
            </div>
          )}

          {step === "signing-builder" && (
            <p style={{ opacity: 0.7 }}>Confirm in your wallet…</p>
          )}

          {step === "need-agent" && agentAddress && (
            <div className="step">
              <div className="step-num">2</div>
              <div className="step-body">
                <h3>Review legacy connector compatibility</h3>
                <p>
                  This OAuth path may request a Hyperliquid compatibility
                  signature used by older connector infrastructure. Current
                  Agent.trade connectors are research and draft handoffs:
                  restricted or unknown eligibility cannot submit live orders,
                  and every live order still returns to Agent.trade for review
                  and explicit confirmation.
                </p>
                <div className="callout" style={{ marginBottom: 14 }}>
                  Compatibility address:{" "}
                  <code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                    {agentAddress}
                  </code>
                </div>
                <button className="btn btn-primary" onClick={runApproveAgent}>
                  Sign compatibility approval
                </button>
                <p style={{ fontSize: 12, color: "var(--fg-dim)", marginTop: 12 }}>
                  Permissioned agent execution is future roadmap work with
                  user-defined scopes, caps, revocation, eligibility checks,
                  audit logs, and kill switches.
                </p>
              </div>
            </div>
          )}

          {step === "signing-agent" && (
            <p style={{ opacity: 0.7 }}>Confirm in your wallet…</p>
          )}

          {(step === "issuing" || step === "redirecting") && (
            <p style={{ opacity: 0.7 }}>Returning you to the connector…</p>
          )}

          {/* Inline error for the "no redirect_uri yet" case is handled above. */}
          {step === "error" && !errorState?.oauthCode && (
            <div className="callout warn" style={{ marginTop: 24 }}>
              <strong>Something went wrong:</strong> {errorState?.message}
            </div>
          )}
        </div>
      )}
    </main>
  );
}

function OAuthCompatibilityDisabled() {
  return (
    <main className="onboarding-page">
      <section className="onboarding-head">
        <div>
          <p className="at-kicker">Connector compatibility</p>
          <h1>Compatibility approvals disabled</h1>
          <p>
            Agent.trade&apos;s current MVP connector flow is research and draft
            handoff only. Assistants can request market context and draft trade
            proposals, but orders return to Agent.trade for review,
            eligibility checks, caps, risk acknowledgement, and explicit
            confirmation.
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
            <strong>OAuth compatibility unavailable</strong>
          </div>
          <span className="readiness-pill amber">Draft-confirm only</span>
        </div>
        <div className="risk-copy-list">
          <p>
            <code>NEXT_PUBLIC_AGENT_TRADE_ENABLE_OAUTH_COMPAT_APPROVALS</code>{" "}
            is not enabled, so this route will not request builder-fee or
            agent compatibility signatures through <code>/exchange</code>.
          </p>
          <p>
            Permissioned agent execution remains future roadmap work with
            user-defined scopes, caps, revocation, eligibility checks, audit
            logs, and kill switches.
          </p>
        </div>
      </section>
    </main>
  );
}

function AuthorizeMissingPrivy() {
  return (
    <main className="onboarding-page">
      <section className="onboarding-head">
        <div>
          <p className="at-kicker">Authorize connector</p>
          <h1>Connector authorization unavailable</h1>
          <p>
            Privy is not configured in this environment, so connector OAuth
            setup is disabled. Current Agent.trade connector flows are research
            and draft handoffs; orders return to Agent.trade for confirmation
            when live readiness is configured.
          </p>
        </div>
        <div className="onboarding-actions">
          <Link className="secondary-action" href="/connectors">Connector overview</Link>
          <Link className="primary-link" href="/onboarding">Account readiness</Link>
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
            Set <code>NEXT_PUBLIC_PRIVY_APP_ID</code> to enable wallet sign-in
            for connector authorization. Restricted or unknown eligibility
            cannot submit live orders.
          </p>
          <p>
            Permissioned agent execution is future roadmap work with
            user-defined scopes, caps, revocation, eligibility checks, audit
            logs, and kill switches.
          </p>
        </div>
      </section>
    </main>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function isValidUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

function shortAddr(a: string): string {
  if (!a || a.length < 10) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function splitHexSig(hex: `0x${string}`): {
  r: `0x${string}`;
  s: `0x${string}`;
  v: number;
} {
  const stripped = hex.replace(/^0x/, "");
  if (stripped.length !== 130) {
    throw new Error(`Unexpected sig length ${stripped.length}; expected 130.`);
  }
  let v = parseInt(stripped.slice(128, 130), 16);
  if (v < 27) v += 27;
  return {
    r: `0x${stripped.slice(0, 64)}` as `0x${string}`,
    s: `0x${stripped.slice(64, 128)}` as `0x${string}`,
    v,
  };
}

async function asApiError(res: Response): Promise<Error> {
  const text = await res.text().catch(() => "");
  let body: { message?: string; guidance?: string } | null = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  const err = new Error(body?.message ?? res.statusText ?? "API error") as Error & {
    message: string;
    guidance?: string;
  };
  if (body?.guidance) err.guidance = body.guidance;
  return err;
}
