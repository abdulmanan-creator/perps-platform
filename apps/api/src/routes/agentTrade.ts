import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";

import { ApiException } from "../errors.js";
import {
  assertAgentTradeExchangeAllowed,
  eligibilityForRequest,
  recordAgentTradeNotional,
} from "../helpers/agentTradeSafety.js";
import { registerExchangeEndpoint } from "./exchange.js";

const PaperOrderSchema = z.object({
  draft: z.object({
    symbol: z.string().min(1),
    side: z.enum(["long", "short"]),
    orderType: z.enum(["market", "limit"]),
    sizeBtc: z.number().positive(),
    leverage: z.number().int().min(1).max(50),
    marginMode: z.enum(["isolated", "cross"]),
    reduceOnly: z.boolean(),
    limitPrice: z.number().positive().optional(),
    takeProfit: z.number().positive().optional(),
    stopLoss: z.number().positive().optional(),
    fromAgent: z.boolean(),
    scenarioId: z.string().optional(),
  }),
  estimatedEntry: z.number().positive(),
});

const PAPER_STARTING_BALANCE_USD = 50_000;

type PaperSide = "long" | "short";
type PaperOrderSide = "buy" | "sell";

interface PaperPosition {
  symbol: string;
  base: string;
  mode: "paper";
  side: PaperSide;
  updatedAt: number;
  orderCount: number;
  lastFillId: string;
  size: number;
  leverage: number;
  marginMode: "isolated" | "cross";
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  pnlUsd: number;
  pnlPct: number;
  marginUsd: number;
  fundingUsd: number;
  takeProfit?: number;
  stopLoss?: number;
}

interface PaperFill {
  symbol: string;
  side: PaperOrderSide;
  mode: "paper";
  price: number;
  size: number;
  feeUsd: number;
  timestamp: number;
  orderId: string;
  fromAgent: boolean;
}

interface PaperOpenOrder {
  symbol: string;
  side: PaperOrderSide;
  type: "market" | "limit";
  mode: "paper";
  price: number;
  size: number;
  reduceOnly: boolean;
  timestamp: number;
}

interface PaperLedger {
  sessionId: string;
  nextSequence: number;
  updatedAt: number;
  positions: PaperPosition[];
  fills: PaperFill[];
  openOrders: PaperOpenOrder[];
}

const paperLedgers = new Map<string, PaperLedger>();

function sessionIdForRequest(req: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = req.headers["x-agent-trade-session-id"];
  const sessionId = Array.isArray(raw) ? raw[0] : raw;
  if (!sessionId || !/^[a-zA-Z0-9._:-]{8,96}$/.test(sessionId)) {
    return "default-paper-session";
  }
  return sessionId;
}

function ledgerForSession(sessionId: string): PaperLedger {
  const existing = paperLedgers.get(sessionId);
  if (existing) return existing;
  const ledger: PaperLedger = { sessionId, nextSequence: 1, updatedAt: Date.now(), positions: [], fills: [], openOrders: [] };
  paperLedgers.set(sessionId, ledger);
  return ledger;
}

function baseFromSymbol(symbol: string): string {
  return symbol.replace(/-USD$/u, "").replace(/\/USD$/u, "") || symbol;
}

function round(value: number, decimals = 6): number {
  return Number(value.toFixed(decimals));
}

function liquidationPrice(side: PaperSide, entryPrice: number, leverage: number): number {
  const maintenance = 0.006;
  const price = side === "long"
    ? entryPrice * (1 - 1 / leverage + maintenance)
    : entryPrice * (1 + 1 / leverage - maintenance);
  return round(Math.max(price, 0), 2);
}

function decoratePosition(position: PaperPosition, markPrice: number): PaperPosition {
  const direction = position.side === "long" ? 1 : -1;
  const pnlUsd = (markPrice - position.entryPrice) * position.size * direction;
  const notionalUsd = Math.abs(position.size * markPrice);
  return {
    ...position,
    markPrice,
    liquidationPrice: liquidationPrice(position.side, position.entryPrice, position.leverage),
    pnlUsd: round(pnlUsd, 2),
    pnlPct: position.entryPrice > 0 ? round((pnlUsd / Math.max(1, position.entryPrice * position.size)) * 100, 2) : 0,
    marginUsd: round(notionalUsd / position.leverage, 2),
    fundingUsd: 0,
  };
}

function accountForLedger(ledger: PaperLedger) {
  const marginUsedUsd = round(ledger.positions.reduce((sum, position) => sum + position.marginUsd, 0), 2);
  const unrealizedPnlUsd = round(ledger.positions.reduce((sum, position) => sum + position.pnlUsd, 0), 2);
  const equityUsd = round(PAPER_STARTING_BALANCE_USD + unrealizedPnlUsd, 2);
  return {
    sessionId: ledger.sessionId,
    ledgerRevision: ledger.nextSequence - 1,
    updatedAt: ledger.updatedAt,
    equityUsd,
    availableUsd: round(equityUsd - marginUsedUsd, 2),
    marginUsedUsd,
    unrealizedPnlUsd,
    simulatedBalanceUsd: PAPER_STARTING_BALANCE_USD,
    positions: ledger.positions,
    fills: ledger.fills,
    openOrders: ledger.openOrders,
  };
}

function recordPaperMarketOrder(
  ledger: PaperLedger,
  body: z.infer<typeof PaperOrderSchema>,
) {
  const now = Date.now();
  const { draft } = body;
  const fillPrice = body.estimatedEntry;
  const fillSize = draft.sizeBtc;
  const fillSide: PaperOrderSide = draft.side === "long" ? "buy" : "sell";
  const sequence = ledger.nextSequence++;
  ledger.updatedAt = now;
  const orderId = `paper_${now.toString(36)}_${sequence.toString(36)}`;
  const feeUsd = round(fillPrice * fillSize * 0.00045, 2);
  const fill: PaperFill = {
    symbol: draft.symbol,
    side: fillSide,
    mode: "paper",
    price: fillPrice,
    size: fillSize,
    feeUsd,
    timestamp: now,
    orderId,
    fromAgent: draft.fromAgent,
  };

  ledger.fills = [fill, ...ledger.fills].slice(0, 50);

  const existingIndex = ledger.positions.findIndex((position) => position.symbol === draft.symbol);
  const existingPosition = existingIndex >= 0 ? ledger.positions[existingIndex] : undefined;
  const signedExisting = existingPosition
    ? existingPosition.size * (existingPosition.side === "long" ? 1 : -1)
    : 0;
  const signedFill = fillSize * (draft.side === "long" ? 1 : -1);
  const signedNext = signedExisting + signedFill;

  if (Math.abs(signedNext) < 1e-12) {
    if (existingIndex >= 0) {
      ledger.positions.splice(existingIndex, 1);
    }
  } else {
    const nextSide: PaperSide = signedNext > 0 ? "long" : "short";
    const nextSize = round(Math.abs(signedNext), 8);
    const sameDirection = signedExisting === 0 || Math.sign(signedExisting) === Math.sign(signedFill);
    const flippedDirection = signedExisting !== 0 && Math.sign(signedExisting) !== Math.sign(signedNext);
    const entryPrice = sameDirection && existingPosition
      ? round(((existingPosition.entryPrice * existingPosition.size) + (fillPrice * fillSize)) / (existingPosition.size + fillSize), 2)
      : flippedDirection || !existingPosition
        ? fillPrice
        : existingPosition.entryPrice;
    const leverage = sameDirection || !existingPosition ? draft.leverage : existingPosition.leverage;
    const marginMode = sameDirection || !existingPosition ? draft.marginMode : existingPosition.marginMode;

    const nextPosition = decoratePosition({
      symbol: draft.symbol,
      base: baseFromSymbol(draft.symbol),
      mode: "paper",
      side: nextSide,
      updatedAt: now,
      orderCount: (existingPosition?.orderCount ?? 0) + 1,
      lastFillId: orderId,
      size: nextSize,
      leverage,
      marginMode,
      entryPrice,
      markPrice: fillPrice,
      liquidationPrice: liquidationPrice(nextSide, entryPrice, leverage),
      pnlUsd: 0,
      pnlPct: 0,
      marginUsd: round((nextSize * fillPrice) / leverage, 2),
      fundingUsd: 0,
      takeProfit: draft.takeProfit ?? existingPosition?.takeProfit,
      stopLoss: draft.stopLoss ?? existingPosition?.stopLoss,
    }, fillPrice);

    if (existingIndex >= 0) {
      ledger.positions[existingIndex] = nextPosition;
    } else {
      ledger.positions.unshift(nextPosition);
    }
  }

  return { orderId, fill, account: accountForLedger(ledger) };
}

export async function agentTradeRoute(app: FastifyInstance): Promise<void> {
  await registerExchangeEndpoint(app, {
    path: "/agent-trade/exchange",
    metricRoute: "/agent-trade/exchange",
    hooks: {
      beforeBuild: ({ req, body }) => {
        assertAgentTradeExchangeAllowed({
          req,
          cfg: app.config,
          action: body.action,
          user: body.user,
        });
      },
      beforeSend: ({ req, body, signer }) => {
        assertAgentTradeExchangeAllowed({
          req,
          cfg: app.config,
          action: body.action,
          user: signer,
        });
      },
      afterSend: ({ req, body, signer }) => {
        recordAgentTradeNotional({
          req,
          action: body.action,
          user: signer,
        });
      },
    },
  });

  app.get("/agent-trade/eligibility", async (req, reply) => {
    const state = eligibilityForRequest(req, app.config);
    return reply.send({
      state,
      executionVenue: app.config.isTestnet ? "hyperliquid-testnet" : "hyperliquid-mainnet",
      mainnetExecutionEnabled: app.config.AGENT_TRADE_MAINNET_EXECUTION_ENABLED,
      killSwitchEnabled: app.config.AGENT_TRADE_LIVE_TRADING_KILL_SWITCH,
      minOrderNotionalUsd: app.config.AGENT_TRADE_MIN_ORDER_NOTIONAL_USD,
      orderNotionalCapUsd: app.config.AGENT_TRADE_ORDER_NOTIONAL_CAP_USD,
      dailyNotionalCapUsd: app.config.AGENT_TRADE_DAILY_NOTIONAL_CAP_USD,
    });
  });

  app.post("/agent-trade/paper-orders", async (req, reply) => {
    let body: z.infer<typeof PaperOrderSchema>;
    try {
      body = PaperOrderSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.issues[0];
        throw new ApiException(
          "INVALID_PARAMS",
          `Bad paper order: ${first?.path.join(".") ?? "(root)"} ${first?.message ?? "validation failed"}`,
          "Paper orders use the simulated Agent.trade path and must not be posted to /exchange.",
        );
      }
      throw err;
    }

    if (body.draft.orderType === "limit") {
      throw new ApiException(
        "INVALID_PARAMS",
        "Paper limit orders are not simulated yet.",
        "Use a paper market order for the MVP paper ledger. Limit-order simulation will be added later.",
      );
    }

    const sessionId = sessionIdForRequest(req);
    const ledger = ledgerForSession(sessionId);
    const recorded = recordPaperMarketOrder(ledger, body);
    const notionalUsd = body.draft.sizeBtc * body.estimatedEntry;
    return reply.send({
      id: recorded.orderId,
      status: "accepted",
      mode: "paper",
      notionalUsd,
      estimatedEntry: body.estimatedEntry,
      createdAt: recorded.fill.timestamp,
      fill: recorded.fill,
      account: recorded.account,
    });
  });

  app.get("/agent-trade/paper-account", async (req, reply) => {
    const sessionId = sessionIdForRequest(req);
    const ledger = ledgerForSession(sessionId);
    return reply.send(accountForLedger(ledger));
  });
}
