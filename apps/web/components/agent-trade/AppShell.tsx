"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const navItems = [
  { href: "/onboarding", label: "Onboarding" },
  { href: "/terminal", label: "Terminal" },
  { href: "/markets", label: "Markets" },
  { href: "/predictions", label: "Predictions", exact: true },
  { href: "/predictions/32", label: "World Cup", exact: true },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/tax", label: "Tax" },
  { href: "/connectors", label: "Connectors" },
  { href: "/rewards", label: "Rewards" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="at-app">
      <header className="at-topbar">
        <Link className="at-brand" href="/terminal">
          <span className="at-brand-mark">A</span>
          <span>
            <strong>Agent.trade</strong>
            <small>Hyperliquid-first terminal</small>
          </span>
        </Link>
        <nav className="at-nav" aria-label="Primary navigation">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={
                pathname === item.href ||
                (!item.exact && item.href !== "/" && pathname.startsWith(`${item.href}/`)) ||
                (pathname === "/" && item.href === "/terminal")
                  ? "active"
                  : ""
              }
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="at-top-actions">
          <span className="at-env-pill">Market data: mainnet read</span>
          <span className="at-env-pill testnet">Execution: testnet default</span>
        </div>
      </header>
      {children}
    </div>
  );
}
