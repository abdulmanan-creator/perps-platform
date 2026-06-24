/**
 * /connect/chatgpt - safe ChatGPT connector setup walkthrough.
 *
 * Same MCP server as Claude, framed for market reads, sourced context, and
 * draft handoff back to Agent.trade. Today's connector flow does not authorize
 * autonomous live trading.
 */

import Link from "next/link";

import { AppShell } from "@/components/agent-trade/AppShell";
import { CodeBlock } from "@/components/CodeBlock";

import { normalizeUrl } from "@/lib/api";

// Resolved at build time from NEXT_PUBLIC_MCP_URL (wired via render.yaml
// fromService → alchemy-hl-mcp host). Falls back to a placeholder if unset.
const MCP_URL = normalizeUrl(
  process.env.NEXT_PUBLIC_MCP_URL ?? "https://alchemy-hl-mcp.onrender.com",
);

export default function ConnectChatGptPage() {
  return (
    <AppShell>
      <main className="connectors-page connector-setup-page">
        <header className="connectors-hero connector-setup-hero">
          <div>
            <span className="at-kicker">AI Connector</span>
            <h1>Connect ChatGPT to Agent.trade</h1>
            <p>
              Use ChatGPT for Hyperliquid market reads, sourced context, and
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
                <span>ChatGPT handoff</span>
                <strong>Research and draft only</strong>
              </div>
            </div>
            <div className="connector-chat">
              <p>
                <strong>User</strong> Explain whether ETH has a clean setup.
              </p>
              <p>
                <strong>ChatGPT</strong> I can return sourced context and
                draft a proposal for Agent.trade review.
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
          <CodeBlock label="MCP server URL">{MCP_URL}</CodeBlock>
        </Step>

        <Step n={2} title="In ChatGPT, enable Developer mode for Apps">
          <p>
            ChatGPT Settings → Apps → Advanced → toggle Developer mode on.
            This unlocks &ldquo;Create new app.&rdquo;
          </p>
        </Step>

        <Step n={3} title='Create a new app named "Agent.trade"'>
          <p>
            Paste the URL into the Server URL field and save. ChatGPT does
            an MCP handshake and discovers tools for market context and draft
            handoff.
          </p>
        </Step>

        <Step n={4} title="Connect for research and draft handoff">
          <p>
            Click <strong>Connect</strong>. ChatGPT opens our auth page in a
            browser tab if the environment requires setup. Use{" "}
            <Link href="/onboarding">/onboarding</Link> to check wallet
            readiness, paper/live mode, and eligibility before attempting any
            live review flow.
          </p>
          <div className="callout">
            <strong>Connector boundary:</strong> ChatGPT can ask for market
            context, produce sourced reasoning, and draft a proposal. The
            draft must open in Agent.trade before any paper or live order is
            submitted.
          </div>
        </Step>

        <Step n={5} title="Ask for reads and proposals">
          <p>In ChatGPT, mention or @-tag the app:</p>
          <CodeBlock label="example prompts">
            {`"@Agent.trade read BTC funding, OI, and liquidity. Is there a clean setup?"

"@Agent.trade explain why ETH is or is not worth trading here."

"@Agent.trade draft a paper trade idea for SOL and send me to Agent.trade for review."

"@Agent.trade summarize my open risk and what would make this a no-trade."`}
          </CodeBlock>
        </Step>

        <section className="connector-setup-callout panel">
          <strong>Preview status:</strong> connector setup is intended for
          research and draft workflows in the MVP. Backend connector enforcement
          and production policy hardening are still separate follow-up work.
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
