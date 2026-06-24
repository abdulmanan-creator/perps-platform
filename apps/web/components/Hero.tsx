"use client";

import { useState } from "react";
import Link from "next/link";

type Lang = "python" | "ts" | "rust" | "go";

// TypeScript ships as a full SDK. Other languages integrate over the same
// REST API: POST /exchange to build (server injects the builder fee +
// returns EIP-712 typed data), sign locally with any EIP-712 library, POST
// back to send. Keys never leave the caller's machine in any language.
const SNIPPETS: Record<Lang, string> = {
  ts: `import { Alchemy } from "@alchemy-hl/sdk";
const sdk = new Alchemy({ privateKey: process.env.PK });
// Build a BTC order locally, sign it yourself, then submit it explicitly.
const order = await sdk.marketBuy("BTC", { notional: 100 });
console.log(\`Filled \${order.filledSize} @ $\${order.avgPrice}\`);`,
  python: `import requests
from eth_account import Account

API = "https://alchemy-hl-api.onrender.com"
order = {"type": "order", "grouping": "na", "orders": [
  {"a": 0, "b": True, "p": "105000", "s": "0.001", "r": False,
   "t": {"limit": {"tif": "Ioc"}}}]}

# Build (server injects builder fee) -> sign locally -> send
built = requests.post(f"{API}/exchange", json={"action": order}).json()
signed = Account.sign_typed_data(PK, full_message=built["typedData"])
requests.post(f"{API}/exchange", json={
  "action": built["action"], "nonce": built["nonce"],
  "signature": {"r": hex(signed.r), "s": hex(signed.s), "v": signed.v}})`,
  rust: `// REST + any EIP-712 signer (alloy / ethers)
let built: Build = http.post(format!("{API}/exchange"))
    .json(&json!({ "action": order })).send().await?.json().await?;
// Sign locally — the key never leaves this process
let sig = wallet.sign_typed_data(&built.typed_data).await?;
http.post(format!("{API}/exchange"))
    .json(&json!({ "action": built.action, "nonce": built.nonce,
                   "signature": sig })).send().await?;`,
  go: `// REST + go-ethereum apitypes for EIP-712
built := postJSON(API+"/exchange", M{"action": order})
// Sign locally — the key never leaves this process
sig := signTypedData(pk, built.TypedData)
postJSON(API+"/exchange", M{
    "action": built.Action, "nonce": built.Nonce, "signature": sig,
})`,
};

export function Hero() {
  const [lang, setLang] = useState<Lang>("ts");
  const [copied, setCopied] = useState(false);

  function onCopy() {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(SNIPPETS[lang]).catch(() => {});
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1000);
  }

  return (
    <section className="hero">
      <div className="hero-inner narrow">
        <div className="hero-eyebrow">
          <span className="hero-eyebrow-tag">New</span>
          Built on Alchemy infrastructure
        </div>

        <h1>
          One line to trade <span className="hl">Hyperliquid.</span>
        </h1>
        <p className="hero-sub">
          Your keys never leave your machine. Build with the SDK, sign locally, send through Alchemy.
        </p>

        <div className="hero-ctas">
          <a className="btn btn-primary btn-lg" href="#quickstart">
            Get Started
            <svg className="btn-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </a>
          <Link className="btn btn-secondary btn-lg" href="/approve">
            Approve via Wallet
          </Link>
        </div>

        <div className="hero-pills">
          <span className="pill blue">TypeScript SDK + REST</span>
          <span className="pill">Zero custody</span>
          <span className="pill cyan">Perps &amp; Spot</span>
          <span className="pill violet">HIP-3 &amp; HIP-4 Markets</span>
        </div>

        <div className="codeblock" id="quickstart">
          <div className="code-tabs" role="tablist">
            {(["python", "ts", "rust", "go"] as Lang[]).map((l) => (
              <button
                key={l}
                className={`code-tab${lang === l ? " active" : ""}`}
                role="tab"
                onClick={() => setLang(l)}
              >
                {l === "ts" ? "typescript" : l}
              </button>
            ))}
            <div className="code-traffic" aria-hidden="true"><span></span><span></span><span></span></div>
          </div>
          <div className="code-body">
            <button
              className={`code-copy${copied ? " ok" : ""}`}
              aria-label="Copy code"
              onClick={onCopy}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="ic-copy" style={{ display: copied ? "none" : undefined }}>
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15V5a2 2 0 0 1 2-2h10" />
              </svg>
              <svg viewBox="0 0 24 24" aria-hidden="true" className="ic-check" style={{ display: copied ? undefined : "none" }}>
                <path d="M5 12l5 5L20 7" />
              </svg>
            </button>
            <pre>
              <code>{SNIPPETS[lang]}</code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
