"use client";

/**
 * Client-side providers: Privy + Privy's wagmi adapter + React Query.
 *
 * Privy handles two onboarding surfaces in one modal:
 *   - Email/Google login → auto-creates an embedded Arbitrum wallet (default
 *     for non-crypto-native users)
 *   - External wallet (MetaMask, Coinbase, Phantom, WalletConnect) for users
 *     who already have a wallet
 *
 * Both produce a normal Ethereum address that signs EIP-712 typed data the
 * same way, so the backend's signature verification is identical.
 *
 * Chain pinned to Arbitrum One (42161) — that's Hyperliquid's signature
 * domain. Switching chains is intentionally not allowed.
 */

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import { http } from "wagmi";
import { arbitrum } from "wagmi/chains";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

const wagmiConfig = createConfig({
  chains: [arbitrum],
  transports: {
    [arbitrum.id]: http(),
  },
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  if (!PRIVY_APP_ID) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "google", "wallet"],
        appearance: {
          theme: "dark",
          accentColor: "#0052ff",
          logo: "/assets/logo-brandmark-white.svg",
          showWalletLoginFirst: false,
        },
        embeddedWallets: {
          createOnLogin: "users-without-wallets",
          requireUserPasswordOnCreate: false,
          noPromptOnSignature: false,
        },
        defaultChain: arbitrum,
        supportedChains: [arbitrum],
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
