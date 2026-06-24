import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Live trading unavailable - Agent.trade",
  robots: { index: false, follow: false },
};

export default function RestrictedPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      <div
        style={{
          maxWidth: 520,
          width: "100%",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-lg)",
          padding: "40px 36px",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: 24, marginBottom: 12 }}>Live trading unavailable</h1>
        <p style={{ color: "var(--fg-muted)", lineHeight: 1.6, marginBottom: 16 }}>
          Agent.trade cannot offer live leveraged-perp trading where
          eligibility is restricted or cannot be verified. Paper mode may remain
          available where routing permits, but restricted or unknown eligibility
          cannot submit live orders.
        </p>
        <p style={{ color: "var(--fg-dim)", fontSize: 14, lineHeight: 1.6 }}>
          Attempting to bypass eligibility checks is a violation of the terms.
          Live trading also remains subject to caps, acknowledgements,
          allowlists, and kill switches.
        </p>
      </div>
    </main>
  );
}
