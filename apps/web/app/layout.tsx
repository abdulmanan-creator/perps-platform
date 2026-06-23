import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Providers } from "./providers-client";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent.trade",
  description:
    "A Hyperliquid-first, agent-native trading terminal for market reads, ticket drafting, and controlled execution.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
