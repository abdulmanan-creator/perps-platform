"use client";

/**
 * /dashboard — explorer-style account dashboard (design option C).
 *
 * Address resolution, in priority order:
 *   1. ?user=0x... in the URL  (shareable explorer links, no auth needed)
 *   2. the Privy session wallet (silent — Privy restores sessions across visits)
 *   3. neither → an address prompt with an optional sign-in
 *
 * All read data comes from public endpoints keyed by address (HL state is
 * public on-chain anyway). Write actions (cancel order) render only when the
 * viewed address IS the session wallet:
 *   - connector compatibility path: one-click risk-reducing cancel via
 *     /agent/exchange with the Privy JWT. Sends an idempotencyKey so a
 *     double-click cannot double-submit.
 *   - wallet-signed path: build → sign (raw EIP-1193 — phantom-agent domain is
 *     chainId 1337, wagmi would reject it) → send, same as the /approve flow.
 */

import { Suspense, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { OpenOrder } from "@alchemy-hl/sdk-preview";

import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { api, API_BASE_URL } from "@/lib/api";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
function fmtUsd(v: string | number, opts: { sign?: boolean } = {}): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const sign = n < 0 ? "-" : opts.sign && n > 0 ? "+" : "";
  return `${sign}$${abs}`;
}
function fmtNum(v: string | number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function splitHexSig(hex: `0x${string}`) {
  const stripped = hex.replace(/^0x/, "");
  let v = parseInt(stripped.slice(128, 130), 16);
  if (v < 27) v += 27;
  return {
    r: `0x${stripped.slice(0, 64)}` as `0x${string}`,
    s: `0x${stripped.slice(64, 128)}` as `0x${string}`,
    v,
  };
}

export default function DashboardPage() {
  return (
    <>
      <Nav />
      <Suspense fallback={<main className="dash-shell" />}>
        <DashboardInner />
      </Suspense>
      <Footer />
    </>
  );
}

function DashboardInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();

  // Same wallet preference as /approve: Privy embedded first, else first linked.
  const sessionWallet = useMemo<ConnectedWallet | undefined>(() => {
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    return embedded ?? wallets[0];
  }, [wallets]);

  const paramUser = params.get("user");
  const viewed: `0x${string}` | null =
    paramUser && ADDR_RE.test(paramUser)
      ? (paramUser as `0x${string}`)
      : ready && authenticated && sessionWallet
        ? (sessionWallet.address as `0x${string}`)
        : null;

  const isOwner =
    !!viewed &&
    !!sessionWallet &&
    viewed.toLowerCase() === sessionWallet.address.toLowerCase();

  if (!viewed) {
    return (
      <AddressPrompt
        privyReady={ready}
        onLogin={login}
        onLookup={(addr) => router.push(`/dashboard?user=${addr}`)}
      />
    );
  }
  return <DashboardView address={viewed} isOwner={isOwner} sessionWallet={sessionWallet} />;
}

function AddressPrompt(props: {
  privyReady: boolean;
  onLogin: () => void;
  onLookup: (addr: string) => void;
}) {
  const [input, setInput] = useState("");
  const valid = ADDR_RE.test(input.trim());
  return (
    <main className="dash-shell">
      <div className="dash-connect">
        <h1>Account dashboard</h1>
        <p>
          Look up any wallet&apos;s Hyperliquid positions, orders, and fills —
          or sign in to see yours with one-click order management.
        </p>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="0x… wallet address"
          spellCheck={false}
        />
        <button
          className="btn btn-primary btn-block"
          disabled={!valid}
          onClick={() => props.onLookup(input.trim())}
        >
          View account
        </button>
        <div className="or">or</div>
        <button
          className="btn btn-secondary btn-secondary-block"
          disabled={!props.privyReady}
          onClick={props.onLogin}
        >
          {props.privyReady ? "Sign in with Privy" : "Initializing…"}
        </button>
      </div>
    </main>
  );
}

function DashboardView(props: {
  address: `0x${string}`;
  isOwner: boolean;
  sessionWallet: ConnectedWallet | undefined;
}) {
  const { address, isOwner } = props;

  const balance = useQuery({
    queryKey: ["balance", address],
    queryFn: () => api.balance(address),
    refetchInterval: 10_000,
  });
  const positions = useQuery({
    queryKey: ["positions", address],
    queryFn: () => api.positions(address),
    refetchInterval: 10_000,
  });
  const orders = useQuery({
    queryKey: ["openOrders", address],
    queryFn: () => api.openOrders(address),
    refetchInterval: 10_000,
  });
  const fills = useQuery({
    queryKey: ["fills", address],
    queryFn: () => api.userFills(address, 20),
    refetchInterval: 30_000,
  });
  const approval = useQuery({
    queryKey: ["approval", address],
    queryFn: () => api.approval(address),
    refetchInterval: 60_000,
  });
  const agent = useQuery({
    queryKey: ["agent", address],
    queryFn: () => api.agent(address),
    refetchInterval: 60_000,
    retry: false, // 422 when the deployment has no agent seed — don't hammer
  });
  const markets = useQuery({
    queryKey: ["markets"],
    queryFn: () => api.markets(),
    staleTime: 5 * 60_000,
  });

  const coinFor = useCallback(
    (assetIndex: number): string => {
      const perp = markets.data?.perps.find((p) => p.assetIndex === assetIndex);
      if (perp) return perp.name;
      const spot = markets.data?.spot.find((s) => s.assetIndex === assetIndex);
      return spot?.name ?? `#${assetIndex}`;
    },
    [markets.data],
  );

  const totalPnl = (positions.data?.positions ?? []).reduce(
    (acc, p) => acc + Number(p.unrealizedPnl),
    0,
  );

  return (
    <main className="dash-shell">
      <div className="dash-head">
        <div>
          <h1>Dashboard</h1>
          <div className="sub">
            Live Hyperliquid account state · refreshes automatically
          </div>
        </div>
        <span className="dash-addr">
          {shortAddr(address)}
          {isOwner && <span className="you">● your wallet</span>}
        </span>
      </div>

      <div className="dash-summary">
        <Stat label="Account value" value={balance.data ? fmtUsd(balance.data.accountValue) : "…"} />
        <Stat
          label="Unrealized PnL"
          value={positions.data ? fmtUsd(totalPnl, { sign: true }) : "…"}
          tone={totalPnl > 0 ? "pos" : totalPnl < 0 ? "neg" : undefined}
        />
        <Stat label="Margin used" value={balance.data ? fmtUsd(balance.data.marginUsed) : "…"} />
        <Stat label="Withdrawable" value={balance.data ? fmtUsd(balance.data.withdrawable) : "…"} />
      </div>

      <PositionsSection q={positions} />
      <OrdersSection
        q={orders}
        coinFor={coinFor}
        isOwner={isOwner}
        address={address}
        agentApproved={agent.data?.approved === true}
        sessionWallet={props.sessionWallet}
      />
      <FillsSection q={fills} />

      <div className="dash-section">
        <h2>Account status</h2>
        <div className="dash-status-grid">
          <div className="dash-status">
            <div className="ttl">Builder approval</div>
            <div className="row">
              <span>Approved</span>
              <span className="v">{approval.data ? (approval.data.approved ? "Yes" : "No") : "…"}</span>
            </div>
            <div className="row">
              <span>Max fee cap</span>
              <span className="v">{approval.data?.maxFeeRate ?? "…"}</span>
            </div>
            <div className="row">
              <span>Manage</span>
              <span className="v">
                <Link href="/approve">approve / revoke ↗</Link>
              </span>
            </div>
          </div>
          <div className="dash-status">
            <div className="ttl">AI trading agent</div>
            {agent.isError ? (
              <div className="row">
                <span>Not enabled on this deployment</span>
              </div>
            ) : (
              <>
                <div className="row">
                  <span>Delegated</span>
                  <span className="v">{agent.data ? (agent.data.approved ? "Yes" : "No") : "…"}</span>
                </div>
                <div className="row">
                  <span>Agent address</span>
                  <span className="v mono">
                    {agent.data ? shortAddr(agent.data.agentAddress) : "…"}
                  </span>
                </div>
                <div className="row">
                  <span>Connect an AI</span>
                  <span className="v">
                    <Link href="/connect/claude">Claude</Link>
                    {" · "}
                    <Link href="/connect/chatgpt">ChatGPT</Link>
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function Stat(props: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div className="dash-stat">
      <div className="k">{props.label}</div>
      <div className={`v ${props.tone === "pos" ? "pnl-pos" : props.tone === "neg" ? "pnl-neg" : ""}`}>
        {props.value}
      </div>
    </div>
  );
}

function PositionsSection(props: { q: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.positions>>>> }) {
  const { q } = props;
  const rows = q.data?.positions ?? [];
  return (
    <div className="dash-section">
      <h2>
        Positions <span className="count">{q.data ? `(${rows.length})` : ""}</span>
      </h2>
      <div className="dash-card">
        {q.isError ? (
          <div className="dash-empty">Couldn&apos;t load positions. Retrying…</div>
        ) : rows.length === 0 ? (
          <div className="dash-empty">{q.data ? "No open positions." : "Loading…"}</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th className="num">Size</th>
                  <th className="num">Entry</th>
                  <th className="num">Value</th>
                  <th className="num">Unrealized PnL</th>
                  <th className="num">Liq. price</th>
                  <th className="num">Leverage</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const pnl = Number(p.unrealizedPnl);
                  const roe = Number(p.returnOnEquity);
                  return (
                    <tr key={`${p.coin}-${p.side}`}>
                      <td>{p.coin}</td>
                      <td className={p.side === "long" ? "side-long" : "side-short"}>
                        {p.side}
                      </td>
                      <td className="num">{fmtNum(p.size)}</td>
                      <td className="num">{fmtNum(p.entryPx)}</td>
                      <td className="num">{fmtUsd(p.positionValue)}</td>
                      <td className={`num ${pnl > 0 ? "pnl-pos" : pnl < 0 ? "pnl-neg" : ""}`}>
                        {fmtUsd(pnl, { sign: true })}
                        {Number.isFinite(roe) && roe !== 0 && (
                          <span style={{ opacity: 0.65 }}> ({(roe * 100).toFixed(1)}%)</span>
                        )}
                      </td>
                      <td className="num">{p.liquidationPx ? fmtNum(p.liquidationPx) : "—"}</td>
                      <td className="num">
                        {p.leverage}x {p.leverageMode}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function OrdersSection(props: {
  q: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.openOrders>>>>;
  coinFor: (assetIndex: number) => string;
  isOwner: boolean;
  address: `0x${string}`;
  agentApproved: boolean;
  sessionWallet: ConnectedWallet | undefined;
}) {
  const { q, coinFor, isOwner } = props;
  const { getAccessToken } = usePrivy();
  const queryClient = useQueryClient();
  const [cancelling, setCancelling] = useState<number | null>(null);
  const [cancelErr, setCancelErr] = useState<string | null>(null);

  const cancelOrder = useCallback(
    async (order: OpenOrder) => {
      setCancelErr(null);
      setCancelling(order.oid);
      try {
        if (props.agentApproved) {
          // Connector compatibility path for risk-reducing cancels.
          // idempotencyKey makes a double-click or retry replay the original
          // response instead of submitting a second cancel.
          const jwt = await getAccessToken();
          if (!jwt) throw new Error("No session token — sign in again.");
          const res = await fetch(`${API_BASE_URL}/agent/exchange`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${jwt}`,
            },
            body: JSON.stringify({
              action: order.cancelAction,
              idempotencyKey: `dash-cancel-${props.address}-${order.oid}`,
            }),
          });
          const body = (await res.json()) as { message?: string; guidance?: string };
          if (!res.ok) throw new Error(body.message ?? "Cancel rejected.");
        } else {
          // User-signed path: build → raw EIP-1193 sign → send. The phantom-
          // agent domain pins chainId 1337 (HL spec), which wagmi's typed-data
          // hook refuses — so we sign via the provider directly and must
          // include EIP712Domain in types ourselves.
          const wallet = props.sessionWallet;
          if (!wallet) throw new Error("No connected wallet.");
          const built = await api.build(order.cancelAction);
          if (!built.typedData) throw new Error("Server did not return typedData.");
          const provider = await wallet.getEthereumProvider();
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
            params: [wallet.address, JSON.stringify(typedWithDomain)],
          })) as `0x${string}`;
          await api.send(built.action, built.nonce, splitHexSig(sigHex));
        }
        await queryClient.invalidateQueries({ queryKey: ["openOrders", props.address] });
      } catch (err) {
        const body = (err as { body?: { message?: string; guidance?: string } }).body;
        setCancelErr(body?.message ?? (err as Error).message);
      } finally {
        setCancelling(null);
      }
    },
    [props.agentApproved, props.address, props.sessionWallet, getAccessToken, queryClient],
  );

  const rows = q.data?.orders ?? [];
  return (
    <div className="dash-section">
      <h2>
        Open orders <span className="count">{q.data ? `(${rows.length})` : ""}</span>
      </h2>
      <div className="dash-card">
        {q.isError ? (
          <div className="dash-empty">Couldn&apos;t load orders. Retrying…</div>
        ) : rows.length === 0 ? (
          <div className="dash-empty">{q.data ? "No resting orders." : "Loading…"}</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th className="num">Limit price</th>
                  <th className="num">Remaining</th>
                  <th className="num">Original</th>
                  <th>Placed</th>
                  {isOwner && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.oid}>
                    <td>{coinFor(o.assetIndex)}</td>
                    <td className={o.side === "buy" ? "side-long" : "side-short"}>{o.side}</td>
                    <td className="num">{fmtNum(o.limitPx)}</td>
                    <td className="num">{fmtNum(o.sz)}</td>
                    <td className="num">{fmtNum(o.origSz)}</td>
                    <td>{timeAgo(o.timestamp)}</td>
                    {isOwner && (
                      <td className="num">
                        <button
                          className="btn-cancel"
                          disabled={cancelling !== null}
                          onClick={() => void cancelOrder(o)}
                        >
                          {cancelling === o.oid ? "Cancelling…" : "Cancel"}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cancelErr && <div className="dash-empty pnl-neg">Cancel failed: {cancelErr}</div>}
      </div>
    </div>
  );
}

function FillsSection(props: { q: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.userFills>>>> }) {
  const { q } = props;
  const rows = q.data?.fills ?? [];
  return (
    <div className="dash-section">
      <h2>
        Recent fills <span className="count">{q.data ? `(${rows.length})` : ""}</span>
      </h2>
      <div className="dash-card">
        {q.isError ? (
          <div className="dash-empty">Couldn&apos;t load fills. Retrying…</div>
        ) : rows.length === 0 ? (
          <div className="dash-empty">{q.data ? "No fills yet." : "Loading…"}</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Direction</th>
                  <th className="num">Price</th>
                  <th className="num">Size</th>
                  <th className="num">Closed PnL</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => {
                  const closed = Number(f.closedPnl ?? 0);
                  return (
                    <tr key={`${f.tid ?? f.oid}-${f.time}`}>
                      <td>{f.coin}</td>
                      <td className={f.side === "B" ? "side-long" : "side-short"}>
                        {f.dir ?? (f.side === "B" ? "buy" : "sell")}
                      </td>
                      <td className="num">{fmtNum(f.px)}</td>
                      <td className="num">{fmtNum(f.sz)}</td>
                      <td className={`num ${closed > 0 ? "pnl-pos" : closed < 0 ? "pnl-neg" : ""}`}>
                        {closed !== 0 ? fmtUsd(closed, { sign: true }) : "—"}
                      </td>
                      <td>{timeAgo(f.time)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
