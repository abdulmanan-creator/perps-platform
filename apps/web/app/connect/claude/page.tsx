/**
 * /connect/claude - safe connector setup walkthrough for Claude.
 *
 * Agent.trade connectors are for research, sourced context, and draft handoff.
 * Live orders still return to the Agent.trade terminal for all checks and
 * explicit user confirmation.
 */

import Link from "next/link";

import { AppShell } from "@/components/agent-trade/AppShell";
import { CodeBlock } from "@/components/CodeBlock";

import { normalizeUrl } from "@/lib/api";

// Resolved at build time from NEXT_PUBLIC_MCP_URL (wired via render.yaml
// fromService → alchemy-hl-mcp host). Falls back to a placeholder if unset
// so dev / preview environments still render the page.
const MCP_URL = normalizeUrl(
  process.env.NEXT_PUBLIC_MCP_URL ?? "https://alchemy-hl-mcp.onrender.com",
);

export default function ConnectClaudePage() {
  return (
    <AppShell>
      <main className="connectors-page connector-setup-page">
        <header className="connectors-hero connector-setup-hero">
          <div>
            <span className="at-kicker">AI Connector</span>
            <h1>Connect Claude to Agent.trade</h1>
            <p>
              Use Claude for Hyperliquid market reads, sourced context, and
              draft trade proposals. In the current MVP connector flow, the
              assistant researches, explains, and drafts. Orders return to
              Agent.trade for confirmation.
            </p>
            <div className="public-cta-row">
              <Link className="primary-link" href="/onboarding">
                Check readiness
              </Link>
              <Link className="secondary-action compact-button" href="/connectors">
                Connector overview
              </Link>
            </div>
          </div>
          <div className="connector-preview panel">
            <div className="panel-head">
              <div>
                <span>Claude handoff</span>
                <strong>Research and draft only</strong>
              </div>
            </div>
            <div className="connector-chat">
              <p>
                <strong>User</strong> Read BTC funding, OI, and liquidity.
              </p>
              <p>
                <strong>Claude</strong> I can explain the setup and draft a
                proposal for Agent.trade review.
              </p>
              <p>
                <strong>Agent.trade</strong> Eligibility, caps,
                acknowledgement, and confirmation stay in the terminal.
              </p>
            </div>
          </div>
        </header>

        <section className="connector-setup-callout panel">
          <strong>Safety model:</strong> every order returns to the Agent.trade
          terminal for review, risk acknowledgement, eligibility checks, caps,
          and explicit confirmation. Restricted or unknown eligibility cannot
          submit live orders; paper mode remains available where routing
          permits.
        </section>

        <section className="connector-setup-callout panel">
          <strong>Roadmap:</strong> permissioned agent execution is planned for
          a later mode with user-defined scopes, caps, revocation, eligibility
          checks, audit logs, and kill switches. Today&apos;s connector flow
          does not authorize autonomous live trading.
        </section>

        <Step n={1} title="Copy the MCP URL">
          <p>
            This is the URL you&apos;ll paste into Claude as a custom MCP
            server.
          </p>
          <CodeBlock label="MCP server URL">{MCP_URL}</CodeBlock>
        </Step>

        <Step n={2} title="Open the connector dialog in Claude Web">
          <p>
            One click opens the &ldquo;Add custom connector&rdquo; modal
            directly in Claude Web (skips the Settings → Connectors menu
            dive). Claude desktop users with Developer mode enabled can use
            the same flow there.
          </p>
          <div style={{ marginTop: 14 }}>
            <a
              className="btn btn-primary"
              href="https://claude.ai/customize/connectors?modal=add-custom-connector"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in Claude Web
              <svg className="btn-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </a>
          </div>
          <div className="callout warn" style={{ marginTop: 14 }}>
            <strong>If the connector option isn&apos;t visible:</strong> custom
            connectors are a beta feature gated by Anthropic. Most work / team
            accounts have it disabled by org policy. For testing today, use a
            personal Claude.ai Pro account; for users at locked-down orgs,
            we&apos;ll route them to ChatGPT Apps or the local Claude desktop
            install as alternatives.
          </div>
        </Step>

        <Step n={3} title='Set Name to "Agent.trade", paste the URL'>
          <p>
            Paste the URL from step 1 into &ldquo;Remote MCP server URL&rdquo;
            and save. Claude fetches the connector tool list for market
            context and draft handoff.
          </p>
        </Step>

        <Step n={4} title="Connect for research and draft handoff">
          <p>
            Click <strong>Connect</strong> next to the new connector. Claude
            may open an Agent.trade auth or setup page depending on the
            environment. Use <Link href="/onboarding">/onboarding</Link> to
            check wallet readiness, paper/live mode, and eligibility before
            attempting any live review flow.
          </p>
          <div className="callout">
            <strong>Connector boundary:</strong> Claude can ask for market
            context, produce sourced reasoning, and draft a proposal. The
            draft must open in Agent.trade before any paper or live order is
            submitted.
          </div>
        </Step>

        <Step n={5} title="Ask for reads and proposals">
          <p>Open a new conversation in Claude and try:</p>
          <CodeBlock label="example prompts">
            {`"Read BTC funding, OI, and liquidity. Is there a clean setup?"

"Explain why ETH is or is not worth trading here."

"Draft a paper trade idea for SOL and send me to Agent.trade for review."

"Summarize my open risk and what would make this a no-trade."`}
          </CodeBlock>
        </Step>

        <section className="connector-setup-callout panel">
          <strong>Preview status:</strong> connector setup is intended for
          research and draft workflows in the MVP. Backend connector enforcement
          and production policy hardening are still separate follow-up work.
        </section>

        <section className="connector-setup-callout panel">
          <strong>Troubleshooting:</strong> if Claude can&apos;t reach the
          connector after &ldquo;Add,&rdquo; check the server is up at{" "}
          <code>{MCP_URL}/healthz</code>. For wallet, funding, paper mode, or
          eligibility state, visit <Link href="/onboarding">/onboarding</Link>.
        </section>
      </main>
    </AppShell>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <article className="connector-setup-step panel">
      <div className="connector-step-num">{String(n).padStart(2, "0")}</div>
      <div className="connector-step-body">
        <h3>{title}</h3>
        {children}
      </div>
    </article>
  );
}
