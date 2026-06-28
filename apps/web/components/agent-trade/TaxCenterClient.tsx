"use client";

import { useMemo, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";

import {
  AWAKEN_URL,
  buildAgentTradeTaxCsv,
  buildHyperliquidFillsCsv,
  csvFileName,
  fetchTaxFills,
  isValidTaxWallet,
  taxYearOptions,
  type TaxFillsApiResponse,
} from "@/lib/agent-trade/tax";

const HAS_PRIVY = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

export function TaxCenterClient() {
  if (HAS_PRIVY) {
    return <PrivyTaxCenter />;
  }
  return <TaxCenterSurface connectedWallet={null} localDev />;
}

function PrivyTaxCenter() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const connectedWallet = wallets[0]?.address ?? null;

  return (
    <TaxCenterSurface
      connectedWallet={authenticated ? connectedWallet : null}
      walletStatus={
        !ready
          ? "Checking wallet session..."
          : authenticated
            ? "Wallet connected for read-only export."
            : "Connect wallet to export your Hyperliquid activity."
      }
      walletAction={
        authenticated
          ? { label: "Disconnect", onClick: logout }
          : { label: "Connect wallet", onClick: login }
      }
    />
  );
}

function TaxCenterSurface(props: {
  connectedWallet: string | null;
  localDev?: boolean;
  walletStatus?: string;
  walletAction?: { label: string; onClick: () => void };
}) {
  const years = useMemo(() => taxYearOptions(), []);
  const [selectedYear, setSelectedYear] = useState(years[0] ?? new Date().getUTCFullYear());
  const [manualWallet, setManualWallet] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<TaxFillsApiResponse | null>(null);
  const wallet = (props.connectedWallet ?? manualWallet).trim();
  const walletValid = isValidTaxWallet(wallet);

  async function download(kind: "agent-trade" | "hyperliquid-fills") {
    setError(null);
    setStatus(null);
    if (!walletValid) {
      setError("Enter or connect a valid 0x wallet address before exporting.");
      return;
    }

    try {
      setStatus("Fetching read-only Hyperliquid fills...");
      const result = await fetchTaxFills({ wallet, year: selectedYear });
      setLastResult(result);
      const csv = kind === "agent-trade"
        ? buildAgentTradeTaxCsv({ wallet, fills: result.fills })
        : buildHyperliquidFillsCsv({ wallet, fills: result.fills });
      downloadCsv(csv, csvFileName({ kind, wallet, year: selectedYear }));
      setStatus(
        result.fills.length === 0
          ? `No fills found for ${selectedYear}. Downloaded a header-only CSV.`
          : `Downloaded ${result.fills.length} fill${result.fills.length === 1 ? "" : "s"} for ${selectedYear}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tax export failed.");
      setStatus(null);
    }
  }

  async function copyWallet() {
    if (!walletValid) {
      setError("Enter or connect a valid 0x wallet address before copying.");
      return;
    }
    await navigator.clipboard.writeText(wallet);
    setStatus("Wallet address copied.");
    setError(null);
  }

  return (
    <main className="tax-center-page">
      <section className="tax-hero">
        <div>
          <p className="eyebrow">Export-first tax center</p>
          <h1>Prepare Agent.trade and Hyperliquid activity for tax software.</h1>
          <p>
            Download read-only fill history by wallet and tax year. Agent.trade does not calculate taxes,
            classify gains, or provide tax advice.
          </p>
        </div>
        <div className="tax-wallet-card">
          <span>Wallet</span>
          <strong>{walletValid ? shortenWallet(wallet) : "No wallet selected"}</strong>
          <p>
            {props.localDev
              ? "Privy is not configured locally. Paste a wallet address to export read-only fills."
              : props.walletStatus ?? "Connect a wallet to export read-only fills."}
          </p>
          {props.walletAction ? (
            <button type="button" className="secondary" onClick={props.walletAction.onClick}>
              {props.walletAction.label}
            </button>
          ) : null}
        </div>
      </section>

      <section className="tax-grid">
        <div className="tax-panel">
          <div className="tax-panel-head">
            <div>
              <p className="eyebrow">Export setup</p>
              <h2>Choose wallet and tax year</h2>
            </div>
            <span className="tax-source-pill">Read-only Hyperliquid data</span>
          </div>

          {!props.connectedWallet ? (
            <label className="tax-field">
              <span>Wallet address</span>
              <input
                value={manualWallet}
                onChange={(event) => setManualWallet(event.target.value)}
                placeholder="0x..."
                spellCheck={false}
              />
            </label>
          ) : null}

          <label className="tax-field">
            <span>Tax year</span>
            <select value={selectedYear} onChange={(event) => setSelectedYear(Number(event.target.value))}>
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </label>

          <div className="tax-actions">
            <button type="button" onClick={() => void download("agent-trade")} disabled={!walletValid}>
              Download Agent.trade CSV
            </button>
            <button type="button" className="secondary" onClick={() => void download("hyperliquid-fills")} disabled={!walletValid}>
              Download Hyperliquid fills CSV
            </button>
            <a className="button-link secondary" href={AWAKEN_URL} target="_blank" rel="noreferrer">
              Open Awaken
            </a>
            <button type="button" className="secondary" onClick={() => void copyWallet()} disabled={!walletValid}>
              Copy wallet address
            </button>
          </div>

          {status ? <p className="tax-status success">{status}</p> : null}
          {error ? <p className="tax-status error">{error}</p> : null}
        </div>

        <div className="tax-panel tax-info-panel">
          <p className="eyebrow">What is included</p>
          <h2>Fills, fees, builder fees, and outcome coins</h2>
          <ul>
            <li>Perps, spot, and HIP-4 outcome coins such as #1890 when returned by Hyperliquid fills.</li>
            <li>Fee, builder fee, closed PnL, transaction hash, order id, and trade id columns.</li>
            <li>Agent.trade request reconciliation columns are present; v1 leaves them blank when audit joins are unavailable.</li>
            <li>Internal transfers are marked only when identifiable from the source record.</li>
          </ul>
          <p className="tax-disclaimer">
            Agent.trade provides exports only. Consult a qualified tax professional and verify imports in
            your tax software before filing.
          </p>
        </div>
      </section>

      <section className="tax-panel tax-preview-panel">
        <div className="tax-panel-head">
          <div>
            <p className="eyebrow">Latest fetch</p>
            <h2>Export preview</h2>
          </div>
          {lastResult ? <span className="tax-source-pill">{lastResult.fills.length} fills</span> : null}
        </div>
        {lastResult ? (
          <div className="tax-preview">
            <span>Year {lastResult.year}</span>
            <span>{new Date(lastResult.startTime).toISOString().slice(0, 10)} to {new Date(lastResult.endTime).toISOString().slice(0, 10)}</span>
            <span>Audit reconciliation: {lastResult.audit.reconciliation.replace("_", " ")}</span>
            <span>Source: Hyperliquid userFillsByTime</span>
          </div>
        ) : (
          <p className="tax-empty">Run an export to preview the selected year. Empty years still download a header-only CSV.</p>
        )}
      </section>
    </main>
  );
}

function downloadCsv(csv: string, fileName: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function shortenWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}
