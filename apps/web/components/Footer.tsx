import Link from "next/link";

export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-inner">
          <div className="footer-brand">
            <div className="footer-brand-row">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/assets/logo-wordmark-white.svg" alt="Agent.trade" />
              <span>Agent.trade</span>
            </div>
            <p className="footer-disclaimer">
              Agent.trade is not affiliated with Hyperliquid Corp or the Hyper
              Foundation. Crypto trading involves risk of loss. In the current
              MVP flow, the agent researches, explains, and drafts; orders
              return to Agent.trade for confirmation.
            </p>
          </div>

          <div className="footer-links">
            <div className="footer-col">
              <span className="head">Product</span>
              <Link href="/terminal">Terminal</Link>
              <Link href="/onboarding">Account readiness</Link>
              <Link href="/connectors">Connectors</Link>
              <Link href="/approve">Wallet readiness</Link>
            </div>
            <div className="footer-col">
              <span className="head">Community</span>
              <a
                href="https://www.alchemy.com/discord"
                target="_blank"
                rel="noopener noreferrer"
              >
                Discord
              </a>
              <a href="/llms.txt">llms.txt</a>
              <a
                href="https://www.alchemy.com/support"
                target="_blank"
                rel="noopener noreferrer"
              >
                Support
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
