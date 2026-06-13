# Venues — build order

The platform was forked from the Hyperliquid builder-codes repo, so the HL
engine already exists (under `apps/api`). The work is to generalize it behind
the `Venue` interface (`src/types.ts`) and add the other two venues.

## Phase 0 — abstraction (this scaffold)
- [x] `Venue` interface with signing/settlement/capability unions
- [x] Registry + market-id namespacing (`<venue>:<symbol>`)
- [x] `HyperliquidVenue.listMarkets()` (real), capabilities for all three
- [ ] Extract `apps/api/src/helpers/{eip712,hash,builder,hlClient,verify}` into
      `packages/venues/hyperliquid/*`; re-point `apps/api/routes/exchange` to the
      adapter. Tests stay green. After this, `HyperliquidVenue` owns the full
      build-sign-send lifecycle and `buildOrder`/`submitOrder` are implemented.

## Phase 1 — Lighter (`signing: venueSig`, `settlement: sync`)
- [ ] L2 API-key registration + management
- [ ] Lighter signing scheme; map BuildOrderInput → its order payload
- [ ] `listMarkets`, `buildOrder`, `submitOrder`
- Revenue: no builder-code primitive — needs referral program or platform fee.

## Phase 2 — Ostium (`signing: evmTx`, `settlement: asyncOnchain`, `requiresGas`)
- [ ] Trading-contract calldata builder (open/close), oracle price plumbing
- [ ] `submitOrder` broadcasts an Arbitrum tx; `getOrderStatus` polls for the
      keeper-executed fill (the submit response is NOT the final state)
- [ ] Gas/custody decision: fund ETH on Arbitrum via the embedded wallet, or a
      relayer/paymaster to keep the gasless UX
- Revenue: no builder-code primitive.

## Cross-cutting
- [ ] Per-venue precision rules (HL: round size to `szDecimals` before submit)
- [ ] Unified error mapping into the shared `ErrorCode` contract
- [ ] Routing: v1 is "user picks venue". Smart cross-venue order routing
      (best execution) is a later, much larger effort — this is the core of
      what differentiates a liquid.trade competitor.
