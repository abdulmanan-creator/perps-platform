# perps-platform

A multi-venue perpetuals trading platform — a liquid.trade competitor — that
routes orders across **Hyperliquid, Lighter, and Ostium** behind one trading UI
and one API.

> **Origin:** This repo was forked from the Hyperliquid **builder-codes** repo
> (`hyperliquid-builder-api`) so it inherits the full Hyperliquid engine —
> EIP-712 phantom-agent signing, builder-fee injection, the HL client, the
> jurisdiction gate, and all its tests. Hyperliquid is therefore the platform's
> first venue adapter, not a rewrite. The builder-codes repo stays single-venue
> and developer/agent-facing; **venue-agnostic and aggregation work happens
> here.**

## What's different from the builder repo

| | `hyperliquid-builder-api` | `perps-platform` (this repo) |
|---|---|---|
| Audience | Developers / agents integrating HL | Retail traders |
| Venues | Hyperliquid only | Hyperliquid + Lighter + Ostium |
| Product | REST builder API + SDK + MCP | Trading app + aggregating API |
| HL revenue | Builder fee | Builder fee (kept — routing into HL still earns) |

## The venue abstraction

The core new piece is `packages/venues` — a `Venue` interface that hides the
fact that the three launch venues share neither a signing model nor a settlement
model:

- **Hyperliquid** — `eip712` signing, `sync` settlement, earns a builder fee.
- **Lighter** — `venueSig` (L2 API-key) signing, `sync` settlement.
- **Ostium** — `evmTx` (Arbitrum tx) signing, `asyncOnchain` settlement, needs gas.

The app/API layer talks to venues only through the registry
(`getVenue`, `listVenues`). Adding a venue is one registration plus one adapter
file. See `packages/venues/ROADMAP.md` for the build order — the next concrete
step is extracting the HL helpers out of `apps/api` into the `HyperliquidVenue`
adapter so it owns the full lifecycle.

## Open product decisions (gate the build)

1. **Revenue on non-HL venues** — Lighter/Ostium have no builder-code primitive.
   Coverage-only, or a referral/fee-wrapper for monetization?
2. **Ostium gas/custody** — fund ETH on Arbitrum via the embedded wallet, or add
   a relayer/paymaster to preserve the gasless feel?
3. **Routing scope** — v1 "user picks venue" vs. smart cross-venue best
   execution (the larger, more differentiating effort).

## Local dev

```bash
cp .env.example .env
npm install
npm run build
npm test
```

Everything inherited from the builder repo (the `apps/api` relay, `apps/web`,
the SDK/MCP packages) still works; this repo adds `packages/venues` on top. As
the platform specializes, the builder-codes-specific surfaces (SDK-as-product,
MCP, the `/approve` marketing flow) can be pruned — tracked as follow-up, not
done yet so the build stays green.
