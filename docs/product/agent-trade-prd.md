# 🧭 Product Summary

## Product Name

Agent.trade

## One-Line Description

Agent.trade is a Hyperliquid-first, agent-native trading app that helps retail and crypto-native traders discover, understand, draft, and confirm real perp trades from a premium trading terminal.

## Product Thesis

Retail traders have access to powerful venues like Hyperliquid, but the workflow around finding trades is still fragmented. A trader has to watch charts, funding, open interest, liquidations, order books, news, portfolio exposure, and risk in separate places, then manually translate that context into an order.

Agent.trade puts an agent beside the terminal. The agent reads market context, explains setups, cites its evidence, annotates the chart, drafts order tickets, proposes baskets or strategies, and can say when no trade is worth taking. The user remains in control and must explicitly confirm every real order.

## MVP Objective

Ship a viable internal MVP trading product that the team can test against the raw Hyperliquid UI, with the goal of proving that Agent.trade is better for trade discovery, market understanding, and agent-assisted order drafting.

# 👥 Users

## Primary MVP Users

- AI-curious retail traders who want help finding trades.
- Crypto-native Hyperliquid traders who already understand perps and want faster idea discovery.

## Long-Term Audience

- Broader consumer traders who want a Robinhood-like trading experience, but agent-native.
- More advanced traders who may eventually want multi-venue routing, strategy tooling, and richer portfolio intelligence.

## User Jobs

- Find trade ideas without manually scanning every market.
- Understand why a setup may or may not be attractive.
- See the market data behind an agent recommendation.
- Convert an idea into a trade ticket quickly.
- Avoid trades when data is stale, risk is unclear, or the setup is weak.
- Track open positions, PnL, margin, liquidation risk, and portfolio exposure.

# 🧩 Positioning

## Product Positioning

Agent.trade is a premium agent-native trading platform for serious individual traders.

It should feel:

- Premium, polished, and data-rich.
- Serious enough for crypto-native Hyperliquid traders.
- Accessible enough for AI-curious retail traders.
- More product-led than SaaS-led.
- More controlled than "AI autopilot."

## What It Is Not

- Not an institutional compliance platform.
- Not an autonomous trading bot.
- Not a generic SaaS analytics dashboard.
- Not a builder-code marketing page.
- Not limited forever to Hyperliquid, even though MVP is Hyperliquid-first.

## Brand Notes

- Use `Agent.trade` as the product name.
- Do not use `hype.trade` in MVP product copy.
- Do not lead public positioning with "Hyperliquid-only."
- Do not promote builder codes or builder fees as a public marketing hook.
- Builder fee/routing details may appear in order confirmation, docs, or internal implementation notes if needed for transparency.

# 🎯 Goals

## Primary Goal

Prove that internal testers prefer Agent.trade over raw Hyperliquid UI for discovering and understanding trade ideas.

## Secondary Goals

- Let internal testers connect a wallet and view live Hyperliquid account and market state.
- Let users ask the embedded agent for trade ideas and receive useful, evidence-backed responses.
- Let the agent draft order tickets that users can review and confirm.
- Provide a premium terminal experience with chart, order book, ticket, positions, and agent in one coherent workspace.
- Support real trading only for eligible users in allowed jurisdictions.
- Provide paper trading or a blocked-state fallback for users who are not eligible for live trading.
- Create enough public landing and connector surface area to validate product positioning and support demos.

## Non-Goals

- Full institutional account management.
- Native mobile apps.
- Full multi-venue routing.
- Fully autonomous trading.
- Full rewards economics.
- Full fiat on-ramp parity with consumer brokerages.
- Production-grade prediction markets, vaults, or spot trading unless already available through existing infrastructure.
- Live trading for users in jurisdictions where Hyperliquid is unavailable or restricted.

# ✅ Success Metrics

## MVP Success Criteria

The MVP is successful if internal testers prefer Agent.trade over raw Hyperliquid UI for idea discovery and the app safely separates paper trading from eligible live trading.

## Workflow Validation Metrics

- Time to first useful trade idea: internal tester can get a useful agent-generated setup in under 2 minutes.
- Agent-to-ticket handoff: tester can send an agent proposal into a prefilled trade ticket.
- Confirmation clarity: tester understands order side, size, leverage, estimated liquidation, TP/SL, and risk before confirming.
- Trust response: tester can identify why the agent suggested a trade because receipts and market data are visible.
- No-trade trust: tester agrees that at least one "no clean setup" answer increases confidence in the agent.
- Preference: majority of internal testers say they would use Agent.trade before raw Hyperliquid UI when looking for trade ideas.
- Eligibility clarity: tester can tell whether they are in paper mode, live mode, or blocked from live trading.

## Agent Quality Validation Metrics

These metrics require real market data and should not be satisfied only with canned demo scenarios.

- Would-act signal: tester marks whether they would seriously consider acting on the agent's analysis.
- Would-fund signal: tester marks whether they would be comfortable using the agent-assisted workflow with real money after review.
- Repeat-use signal: tester returns to the agent to evaluate another market or setup.
- Analyst trust: tester can explain the agent's thesis, risk, and invalidation without needing external context.
- False-confidence check: tester can identify cases where the agent appropriately says no trade or lowers confidence.

## Instrumentation To Add If Practical

- Wallet connected.
- Market viewed.
- Agent prompt submitted.
- Agent proposal generated.
- Proposal sent to ticket.
- Confirmation modal opened.
- Eligibility gate viewed.
- Paper/live mode selected.
- Order confirmed.
- Order cancelled.
- No-trade response viewed.
- Stale-data state encountered.

# 🧱 MVP Scope

## In Scope

- Web app.
- Premium trading terminal.
- Embedded trading agent.
- Hyperliquid-first live market data.
- Real trading through Hyperliquid `/exchange` for eligible users in allowed jurisdictions.
- Paper trading or simulated-money mode for restricted, unknown, or non-funded users where feasible.
- Jurisdiction and live-trading eligibility gating.
- Wallet connection via Privy.
- Onboarding and deposit/funding guidance.
- Credit card/on-ramp entry point if feasible.
- Markets/opportunities page.
- Portfolio/risk page.
- Light rewards page.
- Public landing page.
- Connector landing/setup page.
- Claude/MCP connector surface where existing repo infra supports it.

## Out of Scope For MVP

- Native iOS or Android apps.
- Fully productionized fiat on-ramp if provider integration is not ready.
- Institutional team permissions.
- Advanced compliance reporting.
- Full multi-venue execution.
- Autonomous execution without user confirmation.
- Complex rewards economics or live airdrop mechanics.
- Full social/copy-trading system.
- Circumvention of Hyperliquid jurisdiction restrictions.

# 🖥️ Core Product Surfaces

## 1. Trading Terminal

The terminal is the primary app experience and the main proof of product quality.

Required elements:

- Market selector.
- Candlestick chart.
- Agent-driven chart annotations.
- Order book.
- Recent trades.
- Market stats: mark price, funding, open interest, 24h volume, 24h change.
- Order ticket.
- Positions/open orders/trade history area.
- Embedded agent panel.
- Account and wallet state.
- Data freshness indicator.

Terminal requirements:

- User can choose a market.
- User can view live or near-live market data.
- User can place real Hyperliquid perp orders through a confirmation flow.
- User can switch long/short.
- User can set market or limit order where supported.
- User can set size, leverage, margin mode, reduce-only, TP/SL where supported.
- User can see estimated liquidation/risk fields before confirming.
- User can see whether an order originated from an agent proposal.

## 2. Embedded Agent

The agent is the product differentiator. It should feel embedded in the trading workflow, not like a generic chatbot.

Agent MVP capabilities:

- Explain what is happening in a selected market.
- Generate trade ideas with receipts.
- Explain why a setup may be invalid.
- Say "no clean setup" when appropriate.
- Annotate the chart with levels such as liquidation clusters, invalidation levels, or breakout levels.
- Draft order tickets from trade ideas.
- Propose basket/strategy ideas where feasible.
- Surface risk notes before order confirmation.
- Refuse to draft trades when market data is stale.

Agent response requirements:

- Include named catalyst or reason when suggesting a trade.
- Include source/receipt chips where available.
- Include relevant data points such as funding, OI, order flow, liquidation zones, or price structure.
- Include "why this could be wrong."
- Include suggested side, size or sizing logic, leverage, entry, TP, SL, and invalidation where applicable.
- Include a clear no-trade state when the setup is weak.

Agent safety requirements:

- Agent cannot execute orders directly.
- Agent can draft an order ticket only.
- User must confirm every order.
- If data is stale, the agent should not draft a live trade.
- If the user requests unsafe leverage or unclear sizing, the agent should ask for confirmation or reduce confidence.

## 3. Markets / Opportunities

The markets page helps users find what to trade.

Required elements:

- Search and filters.
- Market categories: crypto first; optional future categories for equities, commodities, FX, or prediction-style markets.
- Market rows/cards with price, 24h change, volume, OI, funding, trend, and catalyst where available.
- Agent-suggested opportunities.
- Watchlist.
- "Ask agent about this market" action.

MVP requirements:

- User can scan active Hyperliquid markets.
- User can open a market in the terminal.
- User can ask the agent for a read on a selected market.
- Data should be consistent with terminal market data.

## 4. Portfolio / Risk

The portfolio page helps users understand account state and active risk.

Required elements:

- Account equity.
- Available balance.
- Margin usage.
- Open positions.
- Unrealized PnL.
- Liquidation prices.
- Funding exposure.
- Open orders.
- Recent fills.
- Risk summary.

MVP requirements:

- User can see live account state after wallet connection.
- User can identify risky positions.
- User can jump from a position to the terminal.
- User can ask the agent to explain portfolio risk.

## 5. Onboarding / Funding

Onboarding should make a DEX-style trading app feel approachable without hiding risk.

Required elements:

- Privy wallet connection.
- Existing wallet path.
- Embedded wallet path if Privy supports it.
- Deposit guidance for Hyperliquid.
- Credit card/on-ramp entry point if feasible.
- Risk acknowledgement before live trading.

MVP requirements:

- User can connect with Privy.
- User can understand whether they are ready to trade.
- User can see what is missing: wallet, funds, approvals, or permissions.
- User can access paper/demo mode if live funds are not available, eligibility is unknown, or jurisdiction blocks live trading.

## 6. Rewards

Rewards are a light MVP surface, not a complete economics system.

Required elements:

- Rewards page exists in app navigation.
- Shows placeholder or mock points.
- Shows potential actions: connect wallet, place first trade, invite a friend, use agent, complete profile.
- Clearly avoids overpromising any token or airdrop.

MVP requirements:

- Rewards page should look credible, but can use mocked data.
- Functional tracking is optional for MVP.

## 7. Public Landing Page

The landing page should validate positioning and support demos.

Required direction:

- Premium consumer trading feel.
- Product-led hero with real terminal visual.
- Agent is shown inside the market workflow.
- Avoid generic SaaS sections.
- Avoid builder-code marketing.
- Avoid overemphasizing Hyperliquid-only.

Core landing message:

- Agent.trade is where an agent watches the market with you.
- The agent reads market context, explains setups, drafts orders, and the user confirms.

## 8. Connector Page

The connector page explains how Agent.trade works from Claude/ChatGPT-style assistant surfaces.

Required direction:

- Connectors are important but not the only MVP wedge.
- Lead with magic, support with control.
- Show "trade from conversation, confirm in terminal."

Required elements:

- Claude/MCP-style conversation.
- Agent research response.
- Receipts and freshness indicators.
- "Send to Agent.trade" handoff.
- Terminal confirmation modal.
- Permission model.
- Stale-data refusal state.

# 🔁 Core User Journeys

## Journey 1: Discover And Draft A Trade

1. User lands in terminal or markets page.
2. User selects BTC or another active market.
3. User asks agent: "Should I long BTC here?"
4. Agent reads market data and returns a setup or no-trade answer.
5. If setup exists, agent includes thesis, receipts, risk note, and proposed order parameters.
6. User clicks "Send to ticket."
7. Order ticket is prefilled and marked "From Agent."
8. User reviews order details.
9. User opens confirmation modal.
10. User confirms risk acknowledgement.
11. If the user is live-trading eligible, app submits the real order through Hyperliquid `/exchange`.
12. If the user is in paper mode, app submits a simulated paper order without calling `/exchange`.
13. User sees order status and updated position/order state.

## Journey 2: No Clean Setup

1. User asks for a trade idea.
2. Agent identifies crowded funding, unclear price structure, stale data, or poor risk/reward.
3. Agent says no trade is recommended.
4. Agent explains why.
5. Agent offers follow-up actions: set alert, watch market, ask about another market.

## Journey 3: Portfolio Risk Read

1. User connects wallet.
2. User opens portfolio.
3. User asks agent: "What is my biggest risk right now?"
4. Agent reviews positions, margin, liquidation levels, and funding exposure.
5. Agent summarizes risk and suggests actions such as reduce size, add stop, or monitor a level.
6. Any trade action still requires user confirmation.

## Journey 4: Connector Handoff

1. User opens connector page and connects Claude/MCP-compatible client.
2. User asks from assistant surface: "Find a BTC setup with defined downside."
3. Agent returns research, receipts, and proposed order.
4. User sends draft to Agent.trade.
5. Agent.trade opens terminal with prefilled ticket.
6. User confirms manually.

# ⚙️ Functional Requirements

## Account And Authentication

- App must support wallet connection via Privy.
- App must show disconnected, connecting, connected, and error states.
- App must show account address and basic account readiness.
- App must support internal tester access without requiring native mobile.
- App must determine trading eligibility before enabling deposits, funding, live order drafting, or live order submission.
- App must show the user's current mode clearly: disconnected, paper, live eligible, restricted, or unknown eligibility.

## Market Data

- App must fetch and display Hyperliquid market data.
- App must expose data freshness state: live, delayed, stale, reconnecting.
- Terminal, markets, agent, and portfolio must use consistent data for the same market.
- If data is stale, agent must avoid drafting live trade proposals.

## Trading

- App must support real trading through Hyperliquid `/exchange` only for users who pass live-trading eligibility.
- App must support paper/simulated trading mode where feasible for users who cannot or should not trade live.
- If paper trading is not ready, restricted users must be blocked from app trading surfaces and shown an explanatory restricted-jurisdiction state.
- App must require explicit user confirmation before submitting any order.
- App must show a confirmation modal for live orders.
- Confirmation must include side, market, order type, size, leverage, margin mode, estimated liquidation/risk fields where available, TP/SL where set, and warnings.
- App must show order submission success/failure states.
- App must not allow the agent to bypass confirmation.
- App must never submit `/exchange` requests for users in restricted jurisdictions.
- Live trading restrictions must be enforced server-side as well as in the UI.
- App must include an operator kill switch that disables live trading globally or for a configured cohort during internal testing.

## Agent

- App must provide an embedded agent panel in the terminal.
- Agent must support deterministic demo-safe scenarios for internal testing where needed.
- Agent must support at least these prompt types:
  - Market read.
  - Trade idea.
  - No-trade evaluation.
  - Send proposal to ticket.
  - Portfolio risk explanation.
- Agent responses must include evidence, risk, and next action.
- Agent must not draft live orders for restricted users, unknown-eligibility users, or users in stale-data states.
- Agent may draft paper trades for restricted users only if the UI clearly labels them as paper/simulated.
- Agent output should include short risk/disclaimer language when giving sized trade ideas.

## Portfolio

- App must show positions, open orders, balances/equity where available, and recent fills.
- User must be able to navigate from a position to the corresponding market terminal.

## Onboarding

- App must present wallet connect as the primary path.
- App should include credit card/on-ramp entry if feasible.
- If credit card provider is not integrated for MVP, app should still show funding guidance and mark provider as TBD internally.
- Deposit and credit card/on-ramp CTAs must be hidden or disabled for restricted users.
- Users must accept terms and leveraged-perp risk acknowledgement before live trading.
- Unknown eligibility should default to paper mode or blocked state, not live trading.

## Rewards

- App must include a light rewards surface.
- Rewards may use mocked data for MVP.
- Rewards copy must not promise a token, airdrop, or guaranteed benefit.

## Public Pages

- Landing page and connector page must use final product direction.
- They should be production-quality enough for demos.
- They should not block trading MVP implementation.

# 🧪 Data And State Requirements

## Shared Data Model

Use one shared mock/live data layer per environment so values stay consistent across screens.

Examples:

- BTC price should match across terminal, markets, portfolio, and agent receipts.
- Funding and OI values shown by the agent should match terminal/market stats.
- Account balances should match portfolio and ticket available balance.

## Required States

- Disconnected wallet.
- Connected wallet with no funds.
- Connected wallet with funds.
- Eligibility loading.
- Live trading eligible.
- Restricted jurisdiction.
- Unknown eligibility.
- Paper trading mode.
- Live trading disabled by kill switch.
- Live market data.
- Stale market data.
- Agent thinking.
- Agent trade proposal.
- Agent no-trade answer.
- Ticket prefilled from agent.
- Confirmation pending.
- Live order blocked.
- Paper order submitted.
- Order submitting.
- Order success.
- Order failure.

# 🧰 Technical Direction

## Existing Repo Leverage

Use the existing `perps-platform` repo as a foundation where practical.

Likely reusable areas:

- API routes for Hyperliquid data and trading.
- `/exchange` order submission flow.
- SDK client.
- MCP server/connectors.
- Privy/delegated-agent auth patterns.
- Builder-code or fee injection plumbing if required by implementation.
- Tests around signing, exchange, auth, and order flow.

Likely rewrite areas:

- Main frontend product UI.
- Landing page.
- Connector page.
- Terminal layout.
- Agent-native product flows.
- Markets, portfolio, rewards, and onboarding UI.

## Venue Strategy

- MVP is Hyperliquid-first.
- Architecture should not hardcode permanent Hyperliquid-only positioning.
- Keep venue abstraction where it already exists, but do not let multi-venue complexity slow MVP.

## Trading Execution

- Use Hyperliquid `/exchange` for real trading.
- Preserve signing and safety patterns from the existing repo where possible.
- Live orders must be traceable from UI action to API call.
- UI must clearly distinguish draft, simulation, and live order submission.
- `/exchange` must check live-trading eligibility server-side before forwarding any real order.
- Paper orders must use a separate simulated path and must never hit Hyperliquid `/exchange`.
- The app should include a live-trading kill switch for internal testing.
- The jurisdiction eligibility layer should be reusable by web app routes, API routes, and connector/MCP flows.

## Agent Implementation

- MVP agent can combine live data, deterministic scenarios, and canned safe responses.
- The product should feel real, but correctness and safety matter more than model autonomy.
- Agent should not fabricate live data.
- Agent should cite timestamps/freshness for market data.

# 🎨 Design Requirements

## Overall Feel

Agent.trade should feel premium, serious, and alive.

Design references:

- Liquid.trade as a quality bar for confidence, polish, product-led storytelling, and memorable first impression, without copying its consumer-degen/hype framing.
- Hyperliquid for trading-native density.
- Modern fintech/trading tools for restraint, clarity, and credibility.

The target feel is serious retail/prosumer trading: institutional-grade craft and data credibility made accessible to individual traders. It should not imply an enterprise compliance product.

Avoid:

- Generic SaaS dashboard look.
- AI sparkle visuals.
- Decorative gradient blobs.
- Overly institutional compliance language.
- Retail leverage hype.
- Builder-code-focused marketing.

## Terminal Design Priorities

- Dense but legible.
- Chart and agent should feel integrated.
- The agent should drive the terminal through annotations and ticket handoff.
- Tables should avoid cramped horizontal scroll where possible.
- Risk information should be visible before confirmation.

## Landing And Connector Priorities

- Product visual should dominate the first viewport.
- Copy should be confident and simple.
- Connector story should be "agent drafts, user confirms."
- Safety should be visible but not scary.

# 🔐 Safety And Trust

## Mandatory Safety Principles

- User confirms every live order.
- Agent cannot execute independently.
- Stale data blocks live trade drafting.
- Restricted users cannot access live trading.
- Risk notes are shown with trade proposals.
- Liquidation and leverage warnings are shown before confirmation.
- No-trade recommendations are supported and treated as valuable output.

## Confirmation Requirements

Before live order submission, user must see:

- Market.
- Side.
- Size.
- Order type.
- Leverage.
- Margin mode.
- Estimated entry where available.
- Estimated liquidation or risk field where available.
- TP/SL if set.
- Agent-origin badge if drafted by agent.
- Risk acknowledgement for leveraged perp orders.

# 🌍 Regulatory, Jurisdiction, And Trading Eligibility

## Principle

Agent.trade must not enable real trading for users in countries, regions, or jurisdictions where Hyperliquid is unavailable or restricted.

## Source Of Truth

- The restricted-jurisdiction list should match Hyperliquid's current restrictions and be reviewed with legal before any external launch.
- Do not hardcode the list only in UI copy.
- Store the list/config in a maintainable server-side eligibility configuration.
- If the exact list is not yet finalized, block live trading for unknown eligibility rather than allowing it.

## Live Trading Eligibility

Before enabling deposits, funding, live order drafting, or `/exchange` order submission, the app must determine whether the user is eligible for live trading.

Eligibility inputs may include:

- IP geolocation.
- Wallet/account status.
- Accepted terms.
- Internal allowlist for testing.
- Kill switch or operator override.
- Any legal/compliance requirements added later.

## Restricted Jurisdiction Behavior

For restricted users:

- Do not allow live trading.
- Do not submit `/exchange` requests.
- Do not show deposit or credit card funding as available.
- Do not let the agent draft live orders.
- Do not let connectors create live trade drafts.
- Show a clear restricted-jurisdiction state.
- Allow paper trading only if paper mode is clearly separated from live trading.

If paper mode is too complex for MVP, restricted users should be geoblocked from app trading surfaces and only allowed to view public marketing pages.

## Paper Trading Mode

Paper trading is the preferred fallback for restricted, unknown, non-funded, or demo users when feasible.

Paper mode requirements:

- Must use fake money or simulated balance.
- Must be visually distinct from live mode.
- Must not call Hyperliquid `/exchange`.
- Must not show deposits or funding as required.
- May use live market data if allowed.
- Must label agent proposals and confirmations as paper/simulated.

## Server-Side Enforcement

Live-trading restrictions must be enforced on the backend.

The server must reject live order submission when:

- User is in a restricted jurisdiction.
- Eligibility is unknown.
- User has not accepted required terms/risk acknowledgements.
- Live trading kill switch is active.
- The request is coming from a connector flow that has not passed eligibility.

UI-only gating is insufficient.

## Connector Enforcement

Connectors must inherit the same restrictions as the web app.

- A connector can answer educational or market-read questions for restricted users if allowed.
- A connector cannot draft or send live orders for restricted users.
- A connector can draft paper trades only when paper mode is explicitly active.
- A connector must not route around the web app's confirmation flow.

# 🚀 Launch Plan

## Phase 1: Internal MVP

Build and test:

- Terminal.
- Embedded agent.
- Eligibility gating.
- Paper mode or restricted-user blocked state.
- Real Hyperliquid trading for eligible internal testers.
- Wallet connection.
- Markets.
- Portfolio.
- Light onboarding/funding.
- Light rewards as a secondary surface.
- Landing and connector pages as demo/support surfaces.

Target audience:

- Internal team.
- Trusted internal testers.
- Eligible users only for real trading.
- Restricted or unknown-eligibility testers use paper mode or blocked state.

Validation:

- Compare Agent.trade against raw Hyperliquid UI for idea discovery workflow.
- Separately evaluate agent analysis quality with real market data.
- Collect qualitative feedback from testers.
- Track agent-to-ticket usage.
- Verify restricted users cannot reach live trading or `/exchange`.

## Phase 2: Controlled External Alpha

Potential additions:

- More robust onboarding.
- Credit card/on-ramp provider.
- Connector setup polish.
- Better rewards tracking.
- Improved agent data coverage.
- Expanded market discovery.

## Phase 3: Broader Consumer Expansion

Potential additions:

- More venues.
- Mobile-first experience.
- More asset classes.
- Social/referral loops.
- Strategy templates.
- Richer portfolio intelligence.

# ⚠️ Risks And Mitigations

## Risk: Agent Feels Like Generic Chat

Mitigation:

- Agent must annotate charts, draft tickets, cite receipts, and react to data freshness.
- Keep agent visually embedded in terminal workflow.

## Risk: Trading Safety Concerns

Mitigation:

- Require confirmation for every order.
- Show clear risk fields and warnings.
- Block live drafts on stale data.
- Keep paper mode visually distinct from live mode.

## Risk: Restricted Users Access Live Trading

Mitigation:

- Match Hyperliquid/legal restricted-jurisdiction rules.
- Enforce eligibility checks server-side before `/exchange`.
- Default unknown eligibility to paper mode or blocked state.
- Hide deposits, funding, and live draft actions for restricted users.
- Add QA cases for restricted, allowed, and unknown eligibility states.

## Risk: Regulatory Exposure From Real-Money Internal Tests

Mitigation:

- Use paper mode by default when eligibility is unknown.
- Gate live trading to eligible internal testers.
- Require terms and risk acknowledgement before live mode.
- Add operator kill switch for live trading.
- Review jurisdiction and on-ramp behavior with legal before external alpha.

## Risk: MVP Becomes Too Broad

Mitigation:

- Prioritize terminal, agent, eligibility gating, real/paper trading modes, markets, and portfolio.
- Keep rewards light.
- Treat landing and connector pages as demo/support surfaces unless they are nearly free to ship.
- Keep multi-venue future-compatible but not required.

## Risk: Fiat Funding Delays MVP

Mitigation:

- Include credit card/on-ramp as desired path.
- Do not block MVP if provider is not ready.
- Provide wallet/deposit guidance.

## Risk: Public Pages Consume Too Much Build Time

Mitigation:

- Use Claude/design output as reference.
- Build landing and connector pages as polished but bounded surfaces.
- Do not let marketing pages outrank trading functionality.
- Do not block the core trading loop on connector-page polish.

## Risk: Existing Repo Does Not Match Product UI

Mitigation:

- Reuse backend/API/SDK/MCP where practical.
- Rewrite frontend product layer rather than forcing old UI patterns.

# ❓ Open Questions

- Which network should internal MVP default to: Hyperliquid mainnet with gated testers, testnet, or both?
- What is the exact restricted-jurisdiction source of truth, and who owns keeping it current?
- Is paper trading required for restricted users in v1, or is geoblocking restricted users from app trading surfaces acceptable for the first build?
- Which credit card/on-ramp provider should be used?
- Which connector should ship first: Claude only, or Claude plus generic MCP-compatible clients?
- How much of basket/strategy proposal execution should be live in v1 versus proposal-only?
- What exact rewards actions should be displayed in light MVP?
- What analytics stack should track MVP validation events?

# 📌 Decisions Locked

- Brand is Agent.trade.
- MVP is Hyperliquid-first, not Hyperliquid-only forever.
- Main wedge is premium trading terminal with embedded agent.
- Public builder-code marketing is out of scope.
- Real trading is in scope only for eligible users in allowed jurisdictions.
- Restricted or unknown-eligibility users must not be able to submit live orders.
- Paper mode is the preferred fallback for restricted/unknown users; if paper mode is too complex, geoblock app trading surfaces.
- Agent can draft but cannot execute without confirmation.
- Rewards are light MVP.
- Public landing and connector pages are included, but trading functionality is priority.
