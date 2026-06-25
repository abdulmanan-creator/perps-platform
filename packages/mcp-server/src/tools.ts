/**
 * MCP tool definitions for the Alchemy Hyperliquid connector.
 *
 * Each tool's handler receives (args, auth):
 *   - args: zod-validated tool arguments
 *   - auth: per-request auth context. agentJwt populated in http transport
 *           mode when the Authorization header is present; empty otherwise.
 *
 * Draft mode is the default hosted connector stance: tools can research and
 * create Agent.trade review links, but cannot submit orders. Legacy execution
 * tools remain behind MCP_TOOL_MODE=legacy-execution for inherited builder-code
 * compatibility.
 *
 * Legacy write tools pick the right SDK instance:
 *   - If agentJwt is present → agent-mode SDK that POSTs /agent/exchange.
 *     The user signed approveAgent in advance; server signs each trade.
 *   - Else if ALCHEMY_HL_TRADE_KEY is set → hot-key SDK signs locally.
 *     This is the stdio / single-user path.
 *   - Else → tool returns a "no signer" stub message.
 *
 * Read-only tools (get_*) use a no-auth read SDK and ignore auth context.
 */

import { z } from "zod";
import { Alchemy, AlchemyHlError } from "@alchemy-hl/sdk";

import type { Config } from "./config.js";

/**
 * Per-request auth context. In stdio mode this is always empty (single-tenant,
 * uses the process-level hot key). In http mode the transport extracts a
 * Bearer token from the Authorization header and passes it in.
 */
export interface AuthContext {
  /** Privy JWT, set in http mode when Authorization: Bearer ... is present. */
  agentJwt?: string;
  /**
   * User's wallet address, extracted from the OAuth JWT's `sub` claim by the
   * http transport. Used by read tools (get_balance, get_open_orders,
   * get_approval) as the default `user` arg so callers don't have to repeat
   * their own address on every call.
   */
  userAddress?: `0x${string}`;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (args: unknown, auth: AuthContext) => Promise<string>;
}

export function buildTools(cfg: Config): Tool[] {
  // Hot-key SDK: one per process if a key is configured. Used in stdio mode
  // and as a fallback in http mode when a request arrives without auth.
  const hotSdk = cfg.ALCHEMY_HL_TRADE_KEY
    ? new Alchemy({
        baseUrl: cfg.ALCHEMY_HL_API_URL,
        privateKey: cfg.ALCHEMY_HL_TRADE_KEY as `0x${string}`,
      })
    : null;

  // Read-only SDK: no signer, no JWT — used by get_* tools so reads work in
  // any transport without auth.
  const readSdk = new Alchemy({ baseUrl: cfg.ALCHEMY_HL_API_URL });

  /** Pick the SDK for a write tool based on the request auth. */
  function sdkForWrite(auth: AuthContext): Alchemy | null {
    if (auth.agentJwt) {
      return new Alchemy({
        baseUrl: cfg.ALCHEMY_HL_API_URL,
        agentJwt: auth.agentJwt,
      });
    }
    return hotSdk;
  }

  const requireSigner = (toolName: string, auth: AuthContext): string | null => {
    if (auth.agentJwt || cfg.hasSigner) return null;
    return `Cannot execute ${toolName}: no auth available. In http transport mode, the calling host (Claude/ChatGPT) must pass Authorization: Bearer <privy-jwt>. In stdio mode, set ALCHEMY_HL_TRADE_KEY on the server. Read-only tools still work.`;
  };

  const draftTradeProposalSchema = z.object({
    symbol: z.string().describe("Perp market symbol like BTC, ETH, or SOL."),
    side: z.enum(["long", "short"]).describe("Proposed position direction."),
    orderType: z.enum(["market", "limit"]).default("market"),
    sizeBtc: z.number().positive().describe("Order size in base units. For ETH this is ETH, for SOL this is SOL, etc."),
    leverage: z.number().int().min(1).max(50),
    marginMode: z.enum(["isolated", "cross"]).default("isolated"),
    reduceOnly: z.boolean().default(false),
    limitPrice: z.number().positive().optional().describe("Required when orderType is limit."),
    takeProfit: z.number().positive().optional(),
    stopLoss: z.number().positive().optional(),
    rationale: z.string().max(1_000).optional().describe("Brief reasoning for the proposal."),
  });

  const safeTools: Tool[] = [
    // ========================================================================
    // Read-only tools
    // ========================================================================

    {
      name: "get_markets",
      description:
        "List all tradable markets on Hyperliquid. Returns perpetual futures (perps) and spot pairs with their asset indices, size-decimal precision, and (for perps) max leverage. Use this to discover available symbols before placing trades, or to look up an asset's index when the user asks about a specific coin.",
      inputSchema: z.object({
        type: z
          .enum(["perp", "spot", "all"])
          .default("all")
          .describe("Filter to perps only, spot only, or both. Default: all."),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Cap how many markets to return per category (perps + spot)."),
      }),
      async handler(rawArgs) {
        const args = z
          .object({ type: z.enum(["perp", "spot", "all"]).default("all"), limit: z.number().int().positive().max(500).optional() })
          .parse(rawArgs ?? {});
        const m = await readSdk.markets();
        const out: Record<string, unknown> = {};
        if (args.type === "perp" || args.type === "all") {
          out.perps = (args.limit ? m.perps.slice(0, args.limit) : m.perps).map((p) => ({
            symbol: p.name,
            assetIndex: p.assetIndex,
            maxLeverage: p.maxLeverage,
            szDecimals: p.szDecimals,
          }));
        }
        if (args.type === "spot" || args.type === "all") {
          out.spot = (args.limit ? m.spot.slice(0, args.limit) : m.spot).map((s) => ({
            symbol: s.name,
            base: s.base,
            quote: s.quote,
            assetIndex: s.assetIndex,
            szDecimals: s.szDecimals,
          }));
        }
        return JSON.stringify(out, null, 2);
      },
    },

    {
      name: "get_market_price",
      description:
        "Get the current mid market price for an asset by symbol (e.g. 'BTC', 'ETH'). Returns the latest mid in USD. Use before computing position sizing from a notional.",
      inputSchema: z.object({
        symbol: z.string().describe("Asset symbol like 'BTC' or 'ETH'."),
      }),
      async handler(rawArgs) {
        const { symbol } = z.object({ symbol: z.string() }).parse(rawArgs);
        const asset = await readSdk.resolveAsset(symbol);
        const mp = await readSdk.markPrice(asset.assetIndex);
        return JSON.stringify({ symbol: mp.coin, mid: mp.mid }, null, 2);
      },
    },

    {
      name: "get_balance",
      description:
        "Read a wallet's Hyperliquid perp account balance. Returns total account value in USD, withdrawable amount, margin in use, and count of open positions. If `user` is omitted, defaults to the wallet configured as the server's trading key.",
      inputSchema: z.object({
        user: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/)
          .optional()
          .describe("0x-prefixed wallet address. Optional."),
      }),
      async handler(rawArgs, auth) {
        const { user } = z
          .object({ user: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() })
          .parse(rawArgs ?? {});
        const effectiveUser = (user as `0x${string}` | undefined) ?? auth.userAddress;
        if (effectiveUser) {
          const bal = await readSdk.balance(effectiveUser);
          return JSON.stringify(bal, null, 2);
        }
        // No explicit user, no OAuth-derived user → fall back to hot signer.
        if (hotSdk) {
          const bal = await hotSdk.balance();
          return JSON.stringify(bal, null, 2);
        }
        return JSON.stringify(
          { error: "Pass `user` explicitly — no auth context to default from." },
          null,
          2,
        );
      },
    },

    {
      name: "get_open_orders",
      description:
        "List a wallet's resting (open, unfilled) orders on Hyperliquid. Each order in the response includes a pre-built cancel action that can be passed to cancel_order. If `user` is omitted, defaults to the authenticated wallet (from the OAuth session) or the server's trading key.",
      inputSchema: z.object({
        user: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      }),
      async handler(rawArgs, auth) {
        const { user } = z
          .object({ user: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() })
          .parse(rawArgs ?? {});
        const effectiveUser = (user as `0x${string}` | undefined) ?? auth.userAddress;
        if (effectiveUser) {
          const orders = await readSdk.openOrders(effectiveUser);
          return JSON.stringify(orders, null, 2);
        }
        if (hotSdk) {
          const orders = await hotSdk.openOrders();
          return JSON.stringify(orders, null, 2);
        }
        return JSON.stringify(
          { error: "Pass `user` explicitly — no auth context to default from." },
          null,
          2,
        );
      },
    },

    {
      name: "get_approval",
      description:
        "Check whether a wallet has approved Alchemy as a Hyperliquid builder, and at what max fee rate. Returns { approved, maxFeeRate, canTradePerps, canTradeSpot }. Use this before placing trades — if approved=false, the user needs to call approve_builder first. Defaults to the authenticated wallet.",
      inputSchema: z.object({
        user: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      }),
      async handler(rawArgs, auth) {
        const { user } = z
          .object({ user: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() })
          .parse(rawArgs ?? {});
        const effectiveUser = (user as `0x${string}` | undefined) ?? auth.userAddress;
        if (effectiveUser) {
          const approval = await readSdk.approval(effectiveUser);
          return JSON.stringify(approval, null, 2);
        }
        if (hotSdk) {
          const approval = await hotSdk.approval();
          return JSON.stringify(approval, null, 2);
        }
        return JSON.stringify(
          { error: "Pass `user` explicitly — no auth context to default from." },
          null,
          2,
        );
      },
    },

    {
      name: "get_positions",
      description:
        "List a wallet's open perpetual positions on Hyperliquid with live PnL. Each entry includes side (long/short), size, entry price, current value, unrealized PnL with return-on-equity, liquidation price, and leverage. Use this to answer 'what am I holding?', before closing positions, or to size take-profit/stop-loss orders. Defaults to the authenticated wallet.",
      inputSchema: z.object({
        user: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      }),
      async handler(rawArgs, auth) {
        const { user } = z
          .object({ user: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() })
          .parse(rawArgs ?? {});
        const effectiveUser = (user as `0x${string}` | undefined) ?? auth.userAddress;
        if (effectiveUser) {
          return JSON.stringify(await readSdk.positions(effectiveUser), null, 2);
        }
        if (hotSdk) {
          return JSON.stringify(await hotSdk.positions(), null, 2);
        }
        return JSON.stringify(
          { error: "Pass `user` explicitly — no auth context to default from." },
          null,
          2,
        );
      },
    },

    {
      name: "get_fills",
      description:
        "Recent trade fills (executions) for a wallet, newest first. Each fill includes symbol, price, size, direction (Open Long / Close Short / ...), fee paid, closed PnL when the fill reduced a position, and timestamp. Use to answer 'what did I trade recently?' or to confirm an order actually executed. Defaults to the authenticated wallet.",
      inputSchema: z.object({
        user: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .default(20)
          .describe("How many fills to return (newest first). Default 20."),
      }),
      async handler(rawArgs, auth) {
        const args = z
          .object({
            user: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
            limit: z.number().int().positive().max(100).default(20),
          })
          .parse(rawArgs ?? {});
        const effectiveUser = (args.user as `0x${string}` | undefined) ?? auth.userAddress;
        if (effectiveUser) {
          return JSON.stringify(await readSdk.userFills(effectiveUser, args.limit), null, 2);
        }
        if (hotSdk) {
          return JSON.stringify(await hotSdk.userFills(undefined, args.limit), null, 2);
        }
        return JSON.stringify(
          { error: "Pass `user` explicitly — no auth context to default from." },
          null,
          2,
        );
      },
    },

    {
      name: "get_prediction_markets",
      description:
        "List HIP-4 outcome (prediction) markets currently live on Hyperliquid — e.g. Fed rate decisions, sports championships, election outcomes. Each market has two named sides (not always Yes/No — could be 'Change'/'No Change' or team names) and an `outcome` id used by get_prediction_odds and trade_prediction_market. Descriptions are truncated here; get_prediction_odds returns the full resolution criteria.",
      inputSchema: z.object({
        search: z
          .string()
          .optional()
          .describe("Case-insensitive substring filter on market names (e.g. 'Fed', 'NBA')."),
        limit: z.number().int().positive().max(200).default(50),
      }),
      async handler(rawArgs) {
        const args = z
          .object({ search: z.string().optional(), limit: z.number().int().positive().max(200).default(50) })
          .parse(rawArgs ?? {});
        const { outcomes } = await readSdk.outcomes();
        const needle = args.search?.toLowerCase();
        const filtered = needle
          ? outcomes.filter((o) => o.name.toLowerCase().includes(needle))
          : outcomes;
        return JSON.stringify(
          {
            total: filtered.length,
            markets: filtered.slice(0, args.limit).map((o) => ({
              outcome: o.outcome,
              name: o.name,
              sides: o.sides.map((s) => ({ side: s.side, name: s.name })),
              quoteToken: o.quoteToken,
              description:
                o.description.length > 160 ? `${o.description.slice(0, 160)}…` : o.description,
            })),
          },
          null,
          2,
        );
      },
    },

    {
      name: "get_prediction_odds",
      description:
        "Live implied probabilities for one prediction market, derived from its order-book midpoints, plus the full resolution criteria. `probability` is 0–1 (0.25 = market prices a 25% chance); null means an empty book. Use the per-side bestBid/bestAsk to choose a realistic limit price before trading.",
      inputSchema: z.object({
        outcome: z.number().int().min(0).describe("Outcome id from get_prediction_markets."),
      }),
      async handler(rawArgs) {
        const { outcome } = z.object({ outcome: z.number().int().min(0) }).parse(rawArgs);
        const [odds, { outcomes }] = await Promise.all([
          readSdk.outcomeOdds(outcome),
          readSdk.outcomes(),
        ]);
        const meta = outcomes.find((o) => o.outcome === outcome);
        return JSON.stringify(
          { ...odds, resolutionCriteria: meta?.description ?? null },
          null,
          2,
        );
      },
    },

    {
      name: "draft_trade_proposal",
      description:
        "Create a draft-only Agent.trade review link for a proposed perp order. This tool does not place, submit, sign, or confirm trades. The user must open Agent.trade, review eligibility/caps/risk, sign with their wallet when required, and explicitly confirm before any live order can be submitted.",
      inputSchema: draftTradeProposalSchema,
      async handler(rawArgs) {
        const args = draftTradeProposalSchema.parse(rawArgs ?? {});
        if (args.orderType === "limit" && args.limitPrice === undefined) {
          return JSON.stringify(
            { ok: false, error: "LIMIT_PRICE_REQUIRED", message: "Limit drafts require limitPrice." },
            null,
            2,
          );
        }
        const draft = normalizeConnectorDraft(args);
        return JSON.stringify(
          {
            ok: true,
            type: "connector_draft",
            draft,
            reviewUrl: connectorDraftReviewUrl(cfg.WEB_PUBLIC_URL, draft),
            safety:
              "Draft only. Agent.trade will not submit this proposal until the user reviews the ticket and explicitly confirms inside Agent.trade.",
            rationale: args.rationale ?? null,
          },
          null,
          2,
        );
      },
    },

    // ========================================================================
    // Legacy execution tools — hidden unless MCP_TOOL_MODE=legacy-execution.
    // ========================================================================
  ];

  if (cfg.MCP_TOOL_MODE === "draft") {
    return safeTools;
  }

  const executionTools: Tool[] = [

    {
      name: "trade_prediction_market",
      description:
        "Place a limit order on a HIP-4 prediction market. `price` IS the implied probability (exclusive 0–1): buying 25 contracts of a side at price 0.30 costs 7.50 quote tokens and pays 25 if that side wins, 0 otherwise. Sizes are whole contracts. Check get_prediction_odds first and price near the book (a buy far above bestAsk overpays; far below never fills). Selling contracts you hold exits the position early at the current market-implied probability.",
      inputSchema: z.object({
        outcome: z.number().int().min(0).describe("Outcome id from get_prediction_markets."),
        side: z
          .union([z.literal(0), z.literal(1)])
          .describe("Which side of the market (0 or 1 — names per get_prediction_markets)."),
        action: z.enum(["buy", "sell"]),
        contracts: z.number().int().positive().describe("Whole contracts; each pays 1 quote token if the side wins."),
        price: z
          .number()
          .gt(0)
          .lt(1)
          .describe("Limit price as a probability, e.g. 0.25 = 25%."),
        tif: z.enum(["Gtc", "Ioc", "Alo"]).default("Gtc"),
      }),
      async handler(rawArgs, auth) {
        const lock = requireSigner("trade_prediction_market", auth);
        if (lock) return lock;
        const args = z
          .object({
            outcome: z.number().int().min(0),
            side: z.union([z.literal(0), z.literal(1)]),
            action: z.enum(["buy", "sell"]),
            contracts: z.number().int().positive(),
            price: z.number().gt(0).lt(1),
            tif: z.enum(["Gtc", "Ioc", "Alo"]).default("Gtc"),
          })
          .parse(rawArgs);
        const sdk = sdkForWrite(auth)!;
        try {
          const result = await sdk.outcomeOrder({
            outcome: args.outcome,
            side: args.side,
            action: args.action,
            contracts: args.contracts,
            price: args.price,
            tif: args.tif,
          });
          if (result.error) {
            return JSON.stringify({ ok: false, error: result.error }, null, 2);
          }
          return JSON.stringify(
            {
              ok: true,
              filled: result.filled,
              filledContracts: result.filledSize,
              avgPrice: result.avgPrice,
              oid: result.oid,
              restingOid: result.restingOid,
              maxPayout: args.contracts, // quote tokens if the side wins
              cost: +(args.contracts * args.price).toFixed(4),
              user: result.user,
            },
            null,
            2,
          );
        } catch (err) {
          return errToMessage(err);
        }
      },
    },

    {
      name: "close_position",
      description:
        "Close an open perpetual position with a reduce-only market order. Looks up the current position to determine direction; closes the full size unless `size` is given (partial close). Safe by construction — reduce-only orders can never open or flip a position. Returns the fill details. If there's no open position for the symbol, returns an error explaining that.",
      inputSchema: z.object({
        symbol: z.string().describe("Asset symbol of the position to close, like 'BTC'."),
        size: z
          .number()
          .positive()
          .optional()
          .describe("Partial close size in base units. Omit to close the full position."),
      }),
      async handler(rawArgs, auth) {
        const lock = requireSigner("close_position", auth);
        if (lock) return lock;
        const args = z
          .object({ symbol: z.string(), size: z.number().positive().optional() })
          .parse(rawArgs);
        const sdk = sdkForWrite(auth)!;
        try {
          const result = await sdk.closePosition(args.symbol, { size: args.size });
          if (result.error) {
            return JSON.stringify({ ok: false, error: result.error }, null, 2);
          }
          return JSON.stringify(
            {
              ok: true,
              closed: result.filled,
              filledSize: result.filledSize,
              avgPrice: result.avgPrice,
              oid: result.oid,
              user: result.user,
            },
            null,
            2,
          );
        } catch (err) {
          return errToMessage(err);
        }
      },
    },

    {
      name: "place_trigger_order",
      description:
        "Place a take-profit or stop-loss trigger order on Hyperliquid. The order fires when the mark price crosses `triggerPrice`, then executes as a market order. Reduce-only by default — it protects an existing position and can never open a new one. Direction and size default from the open position (the closing direction, full size); pass `side`/`size` explicitly to override. Example: long 0.5 BTC from $97k → place_trigger_order(symbol='BTC', kind='sl', triggerPrice=90000) sells the whole position if BTC drops to $90k.",
      inputSchema: z.object({
        symbol: z.string().describe("Asset symbol like 'BTC'."),
        kind: z.enum(["tp", "sl"]).describe("'tp' = take-profit, 'sl' = stop-loss."),
        triggerPrice: z.number().positive().describe("Mark price that fires the trigger."),
        size: z.number().positive().optional().describe("Base-unit size. Defaults to the full open position."),
        side: z
          .enum(["buy", "sell"])
          .optional()
          .describe("Defaults to the closing direction of the open position."),
      }),
      async handler(rawArgs, auth) {
        const lock = requireSigner("place_trigger_order", auth);
        if (lock) return lock;
        const args = z
          .object({
            symbol: z.string(),
            kind: z.enum(["tp", "sl"]),
            triggerPrice: z.number().positive(),
            size: z.number().positive().optional(),
            side: z.enum(["buy", "sell"]).optional(),
          })
          .parse(rawArgs);
        const sdk = sdkForWrite(auth)!;
        try {
          const fn = args.kind === "tp" ? sdk.takeProfit.bind(sdk) : sdk.stopLoss.bind(sdk);
          const result = await fn(args.symbol, {
            triggerPrice: args.triggerPrice,
            size: args.size,
            side: args.side,
          });
          if (result.error) {
            return JSON.stringify({ ok: false, error: result.error }, null, 2);
          }
          return JSON.stringify(
            {
              ok: true,
              kind: args.kind,
              triggerPrice: args.triggerPrice,
              // Trigger orders rest until fired — restingOid is the handle
              // for cancel_order.
              restingOid: result.restingOid ?? result.oid,
              user: result.user,
            },
            null,
            2,
          );
        } catch (err) {
          return errToMessage(err);
        }
      },
    },

    {
      name: "place_market_order",
      description:
        "Place a marketable IOC (immediate-or-cancel) order on Hyperliquid. Pass either `notional` (USD) OR `size` (in base asset units), not both. The order takes whatever's on the book up to a price 5% beyond the current mark — typically fills at the best ask (for buys) or best bid (for sells). Returns the fill details: filledSize, avgPrice, oid.",
      inputSchema: z.object({
        symbol: z.string().describe("Asset symbol like 'BTC' or 'ETH'."),
        side: z.enum(["buy", "sell"]),
        notional: z.number().positive().optional().describe("USD notional to fill. Mutually exclusive with `size`."),
        size: z.number().positive().optional().describe("Order size in base units. Mutually exclusive with `notional`."),
        reduceOnly: z
          .boolean()
          .optional()
          .describe("If true, this order can only reduce an existing position. Use for closing trades."),
      }),
      async handler(rawArgs, auth) {
        const lock = requireSigner("place_market_order", auth);
        if (lock) return lock;
        const args = z
          .object({
            symbol: z.string(),
            side: z.enum(["buy", "sell"]),
            notional: z.number().positive().optional(),
            size: z.number().positive().optional(),
            reduceOnly: z.boolean().optional(),
          })
          .parse(rawArgs);
        const sdk = sdkForWrite(auth)!;
        try {
          const fn = args.side === "buy" ? sdk.marketBuy.bind(sdk) : sdk.marketSell.bind(sdk);
          const result = await fn(args.symbol, {
            notional: args.notional,
            size: args.size,
            reduceOnly: args.reduceOnly,
          });
          if (result.error) {
            return JSON.stringify({ ok: false, error: result.error, raw: result.raw }, null, 2);
          }
          return JSON.stringify(
            {
              ok: true,
              filled: result.filled,
              filledSize: result.filledSize,
              avgPrice: result.avgPrice,
              oid: result.oid,
              user: result.user,
            },
            null,
            2,
          );
        } catch (err) {
          return errToMessage(err);
        }
      },
    },

    {
      name: "place_limit_order",
      description:
        "Place a limit order on Hyperliquid. The order rests on the book at the specified price until filled, cancelled, or expired. `tif` (time-in-force) defaults to 'Gtc' (good-til-cancelled); 'Ioc' for immediate-or-cancel (fills what it can right now, cancels rest); 'Alo' for add-liquidity-only (post-only, never takes liquidity).",
      inputSchema: z.object({
        symbol: z.string(),
        side: z.enum(["buy", "sell"]),
        size: z.number().positive(),
        price: z.number().positive(),
        tif: z.enum(["Gtc", "Ioc", "Alo"]).default("Gtc"),
        reduceOnly: z.boolean().optional(),
      }),
      async handler(rawArgs, auth) {
        const lock = requireSigner("place_limit_order", auth);
        if (lock) return lock;
        const args = z
          .object({
            symbol: z.string(),
            side: z.enum(["buy", "sell"]),
            size: z.number().positive(),
            price: z.number().positive(),
            tif: z.enum(["Gtc", "Ioc", "Alo"]).default("Gtc"),
            reduceOnly: z.boolean().optional(),
          })
          .parse(rawArgs);
        const sdk = sdkForWrite(auth)!;
        try {
          const result = await sdk.limitOrder({
            symbol: args.symbol,
            side: args.side,
            size: args.size,
            price: args.price,
            tif: args.tif,
            reduceOnly: args.reduceOnly,
          });
          return JSON.stringify(
            {
              ok: !result.error,
              filled: result.filled,
              filledSize: result.filledSize,
              avgPrice: result.avgPrice,
              oid: result.oid,
              restingOid: result.restingOid,
              error: result.error,
            },
            null,
            2,
          );
        } catch (err) {
          return errToMessage(err);
        }
      },
    },

    {
      name: "cancel_order",
      description:
        "Cancel an existing open order by its order id (oid). Identify the market by `symbol` (perps/spot like 'BTC') OR `assetId` (for prediction-market orders, the side's assetId from get_prediction_markets). Idempotent — cancelling an already-filled or cancelled order returns a status, not an error.",
      inputSchema: z.object({
        symbol: z.string().optional().describe("Perp/spot symbol like 'BTC'. Use assetId for prediction markets."),
        assetId: z.number().int().min(0).optional().describe("Raw asset id — required for prediction-market orders."),
        oid: z.number().int().positive(),
      }),
      async handler(rawArgs, auth) {
        const lock = requireSigner("cancel_order", auth);
        if (lock) return lock;
        const args = z
          .object({
            symbol: z.string().optional(),
            assetId: z.number().int().min(0).optional(),
            oid: z.number().int().positive(),
          })
          .parse(rawArgs);
        if (!args.symbol && args.assetId === undefined) {
          return JSON.stringify(
            { ok: false, error: "Pass either `symbol` or `assetId` to identify the market." },
            null,
            2,
          );
        }
        const sdk = sdkForWrite(auth)!;
        try {
          const result = await sdk.cancel(
            args.assetId !== undefined
              ? { assetId: args.assetId, oid: args.oid }
              : { symbol: args.symbol!, oid: args.oid },
          );
          // cancel returns SendResponse (no per-order fill data to parse).
          return JSON.stringify(
            { ok: result.success, user: result.user, exchangeResponse: result.exchangeResponse },
            null,
            2,
          );
        } catch (err) {
          return errToMessage(err);
        }
      },
    },

    {
      name: "set_leverage",
      description:
        "Set the leverage multiplier for an asset on the trading wallet's Hyperliquid account. Higher leverage means less margin required per dollar of notional but proportionally larger PnL swings. Persists across trades until changed. Default mode is 'cross' (recommended); 'isolated' margins the position separately. The server enforces a hard cap on the agent-authed path — exceeding it returns INVALID_PARAMS with the cap value. When suggesting leverage to the user, mention the risk: 10x leverage means a 10% price move against the position liquidates it.",
      inputSchema: z.object({
        symbol: z.string().describe("Asset symbol like 'BTC' or 'ETH'."),
        leverage: z
          .number()
          .int()
          .min(1)
          .max(50)
          .describe("Integer leverage multiplier (1 to 50)."),
        mode: z
          .enum(["cross", "isolated"])
          .default("cross")
          .describe("Margin mode. 'cross' shares margin across positions; 'isolated' margins per-position."),
      }),
      async handler(rawArgs, auth) {
        const lock = requireSigner("set_leverage", auth);
        if (lock) return lock;
        const args = z
          .object({
            symbol: z.string(),
            leverage: z.number().int().min(1).max(50),
            mode: z.enum(["cross", "isolated"]).default("cross"),
          })
          .parse(rawArgs);
        const sdk = sdkForWrite(auth)!;
        try {
          const result = await sdk.setLeverage(args.symbol, args.leverage, args.mode);
          return JSON.stringify(
            {
              ok: result.success,
              symbol: args.symbol,
              leverage: args.leverage,
              mode: args.mode,
              user: result.user,
            },
            null,
            2,
          );
        } catch (err) {
          return errToMessage(err);
        }
      },
    },

    {
      name: "approve_builder",
      description:
        "Sign the one-time `approveBuilderFee` action authorizing Alchemy as a builder for the trading wallet. After this lands, all subsequent orders this wallet places auto-include the builder fee within the approved ceiling. `maxFeeRate` is a percent string like '1%' or '0.04%'. Call once during setup, before placing trades. Pass `maxFeeRate: '0%'` to revoke.",
      inputSchema: z.object({
        maxFeeRate: z
          .string()
          .regex(/^\d+(\.\d+)?%$/)
          .describe("Percent string like '1%' or '0.04%'. Pass '0%' to revoke."),
      }),
      async handler(rawArgs, auth) {
        const lock = requireSigner("approve_builder", auth);
        if (lock) return lock;
        // approveBuilderFee MUST come from the user's primary signature —
        // refuse the agent-mode path explicitly with a clear message.
        if (auth.agentJwt) {
          return JSON.stringify(
            {
              ok: false,
              error: "approve_builder requires the user's primary wallet signature. From an agent-authed connector this isn't possible — direct the user to the web /approve page to sign approveBuilderFee there.",
            },
            null,
            2,
          );
        }
        const { maxFeeRate } = z
          .object({ maxFeeRate: z.string().regex(/^\d+(\.\d+)?%$/) })
          .parse(rawArgs);
        const sdk = hotSdk!;
        try {
          const result = await sdk.approveBuilder({ maxFeeRate });
          // approveBuilder returns SendResponse (no fill data).
          return JSON.stringify(
            { ok: result.success, user: result.user, exchangeResponse: result.exchangeResponse },
            null,
            2,
          );
        } catch (err) {
          return errToMessage(err);
        }
      },
    },
  ];

  return [...safeTools, ...executionTools];
}

interface ConnectorDraftToolArgs {
  symbol: string;
  side: "long" | "short";
  orderType: "market" | "limit";
  sizeBtc: number;
  leverage: number;
  marginMode: "isolated" | "cross";
  reduceOnly: boolean;
  limitPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
}

interface ConnectorDraftPayload extends ConnectorDraftToolArgs {
  v: 1;
  source: "mcp";
}

function normalizeConnectorDraft(args: ConnectorDraftToolArgs): ConnectorDraftPayload {
  const draft: ConnectorDraftPayload = {
    v: 1,
    source: "mcp",
    symbol: normalizePerpSymbol(args.symbol),
    side: args.side,
    orderType: args.orderType,
    sizeBtc: args.sizeBtc,
    leverage: args.leverage,
    marginMode: args.marginMode,
    reduceOnly: args.reduceOnly,
    takeProfit: args.takeProfit,
    stopLoss: args.stopLoss,
  };
  if (args.orderType === "limit") {
    draft.limitPrice = args.limitPrice;
  }
  return draft;
}

function connectorDraftReviewUrl(webPublicUrl: string, draft: ConnectorDraftPayload): string {
  const base = webPublicUrl.replace(/\/+$/u, "");
  const symbol = draft.symbol.replace(/-USD$/u, "");
  return `${base}/terminal?symbol=${encodeURIComponent(symbol)}&draft=${encodeURIComponent(JSON.stringify(draft))}`;
}

function normalizePerpSymbol(input: string): string {
  const normalized = input.trim().toUpperCase().replace(/\s+/gu, "").replace(/\//gu, "-");
  if (!normalized) {
    return "BTC-USD";
  }
  if (normalized.endsWith("-USD")) {
    return normalized;
  }
  if (normalized.endsWith("USD")) {
    return `${normalized.slice(0, -3)}-USD`;
  }
  return `${normalized}-USD`;
}

function errToMessage(err: unknown): string {
  if (err instanceof AlchemyHlError) {
    return JSON.stringify(
      {
        ok: false,
        error: err.code,
        message: err.message,
        guidance: err.guidance,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      ok: false,
      error: "SDK_ERROR",
      message: (err as Error)?.message ?? String(err),
    },
    null,
    2,
  );
}
