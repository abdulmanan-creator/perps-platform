import Link from "next/link";

const connectorCards = [
  {
    name: "Claude",
    href: "/connect/claude",
    status: "Setup available",
    body: "Use Claude to request a market read, then return to Agent.trade for ticket review and confirmation.",
  },
  {
    name: "ChatGPT",
    href: "/connect/chatgpt",
    status: "Setup available",
    body: "Connect the same Agent.trade workflow to ChatGPT for sourced context and terminal handoff.",
  },
  {
    name: "Messaging surfaces",
    href: "",
    status: "Future",
    body: "Future connector targets will inherit the same eligibility, paper mode, and confirmation rules.",
  },
];

const pathSteps = [
  "Ask the assistant for a trade read.",
  "Agent.trade returns sourced market context.",
  "The agent drafts a trade proposal.",
  "User opens Agent.trade to review and confirm.",
];

export function ConnectorsPage() {
  return (
    <main className="connectors-page">
      <section className="connectors-hero">
        <div>
          <p className="at-kicker">Agent.trade connectors</p>
          <h1>Trade reads can start in conversation. Confirmation stays in the terminal.</h1>
          <p>
            Connectors let Claude, ChatGPT, and future assistants ask Agent.trade for market context and draft proposals.
            They do not bypass eligibility, caps, acknowledgements, or user confirmation.
          </p>
          <div className="public-cta-row">
            <Link className="primary-link" href="/connect/claude">Connect Claude</Link>
            <Link className="secondary-action compact-button" href="/connect/chatgpt">Connect ChatGPT</Link>
          </div>
        </div>
        <div className="connector-preview panel">
          <div className="panel-head">
            <div>
              <span>Conversation handoff</span>
              <strong>Assistant to terminal</strong>
            </div>
          </div>
          <div className="connector-chat">
            <p><strong>User</strong> Is BTC setting up for a long?</p>
            <p><strong>Agent.trade</strong> Funding is positive but controlled, OI is expanding, and price is near range highs. I can draft a paper proposal for terminal review.</p>
            <p><strong>Terminal</strong> Open Agent.trade to inspect receipts, chart annotations, risk impact, and confirmation.</p>
          </div>
        </div>
      </section>

      <section className="connector-grid">
        {connectorCards.map((card) => (
          <article key={card.name} className={`connector-card panel ${card.href ? "" : "disabled"}`}>
            <div className="panel-head">
              <div>
                <span>{card.status}</span>
                <strong>{card.name}</strong>
              </div>
            </div>
            <p>{card.body}</p>
            {card.href ? <Link href={card.href}>Open setup</Link> : <span>Coming soon</span>}
          </article>
        ))}
      </section>

      <section className="connector-path panel">
        <div className="panel-head">
          <div>
            <span>Golden path</span>
            <strong>From prompt to controlled ticket</strong>
          </div>
        </div>
        <div className="connector-steps">
          {pathSteps.map((step, index) => (
            <div key={step}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{step}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="connector-safety">
        <article className="panel">
          <div className="panel-head">
            <div>
              <span>Safety model</span>
              <strong>Connector actions inherit Agent.trade restrictions</strong>
            </div>
          </div>
          <div className="risk-copy-list">
            <p>Paper mode remains available for product testing where routing permits.</p>
            <p>Live trading requires eligible jurisdiction, wallet readiness, caps, acknowledgements, and explicit confirmation.</p>
            <p>Restricted or unknown eligibility cannot submit live orders.</p>
            <p>
              In the current MVP connector flow, the assistant researches,
              explains, and drafts. Orders return to Agent.trade for
              confirmation.
            </p>
            <p>
              Permissioned agent execution is planned for a later mode with
              user-defined scopes, caps, revocation, eligibility checks, audit
              logs, and kill switches.
            </p>
            <p>
              Today&apos;s connector flow requires Agent.trade confirmation for
              orders.
            </p>
          </div>
        </article>
        <article className="panel">
          <div className="panel-head">
            <div>
              <span>Terminal handoff</span>
              <strong>Review before any order</strong>
            </div>
          </div>
          <div className="connector-ticket">
            <span>Draft proposal</span>
            <strong>Long BTC · paper-ready</strong>
            <p>Receipts, chart annotations, TP/SL, portfolio impact, and risk acknowledgement stay inside Agent.trade.</p>
            <Link className="secondary-action compact-button" href="/terminal">Open terminal</Link>
          </div>
        </article>
      </section>
    </main>
  );
}
