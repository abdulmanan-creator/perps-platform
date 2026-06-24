"use client";

import { useState } from "react";
import Link from "next/link";

const ITEMS: { q: string; a: React.ReactNode }[] = [
  {
    q: "What is Agent.trade?",
    a: "A Hyperliquid-first, agent-native trading app. The current MVP helps users discover market context, review sourced agent drafts, and confirm orders inside Agent.trade.",
  },
  {
    q: "How does the build-sign-send pattern work?",
    a: (
      <>
        First, you call a <code>build*</code> endpoint to get an EIP-712 typed-data payload. Then you sign it locally — either in a hardware wallet, browser wallet, or with a local key the SDK manages. Finally you call the matching <code>send*</code> endpoint with the signature. Alchemy verifies the signature, attaches the builder fee within your approved ceiling, and forwards to Hyperliquid.
      </>
    ),
  },
  {
    q: "Is this custodial?",
    a: "No. Never. Alchemy sees signed payloads and routes them — your keys never leave your machine and we have no way to move funds without a signature you produce.",
  },
  {
    q: "What are the trading fees?",
    a: "Two layers. Alchemy charges a builder fee — 0.04% on perpetuals, 0.05% on spot — within a ceiling you approve once. Hyperliquid itself charges the exchange fee: 0.045% taker / 0.015% maker on perps, 0.070% taker / 0.040% maker on spot. There are no monthly platform fees.",
  },
  {
    q: "What is a builder fee on Hyperliquid?",
    a: "Hyperliquid lets any registered \"builder\" attach a small fee to orders they route to the matcher, capped by a user-signed approval. Alchemy is a builder. The protocol enforces a maximum of 0.1% on perps and 1% on spot; the user signs a ceiling at or below that, and Alchemy charges below the ceiling on every order.",
  },
  {
    q: "How do I approve / revoke?",
    a: (
      <>
        Visit <Link href="/approve">/approve</Link>, sign in (email, Google, or a wallet), and sign a single EIP-712 message setting your <code>maxFeeRate</code>. Revoking is symmetric — return to the same page and click &quot;Revoke&quot; to publish a revocation payload. Either action takes one signature.
      </>
    ),
  },
  {
    q: "What markets can I trade?",
    a: (
      <>
        Every perp and spot pair on Hyperliquid mainnet, plus markets on any HIP-3 dex and assets staged for HIP-4 launches. The SDK addresses HIP-3 markets with a <code>dex:SYMBOL</code> namespace so the call signature stays the same: <code>sdk.buy(&quot;xyz:SILVER&quot;, {`{ notional: 11 }`})</code>.
      </>
    ),
  },
  {
    q: "Do I need to share my private key?",
    a: "No. The SDK signs locally — either with a hot key you supply (kept in memory), an injected browser wallet, or a hardware signer. Alchemy receives signed payloads, never raw keys.",
  },
];

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section className="section" id="faq">
      <div className="container">
        <div className="section-header">
          <span className="eyebrow">FAQ</span>
          <h2>Questions, answered.</h2>
        </div>

        <div className="faq">
          {ITEMS.map((it, i) => (
            <div className={`faq-item${open === i ? " open" : ""}`} key={i}>
              <button
                className="faq-q"
                onClick={() => setOpen(open === i ? null : i)}
              >
                {it.q}
                <span className="chev"></span>
              </button>
              <div className="faq-a">{it.a}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
