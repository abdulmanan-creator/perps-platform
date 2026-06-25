import type { FastifyInstance } from "fastify";
import type {
  PredictionPaperAccount,
  PredictionPaperFill,
  PredictionPaperOrderRequest,
  PredictionPaperPosition,
} from "@alchemy-hl/shared";
import { z, ZodError } from "zod";

import { ApiException } from "../errors.js";

const PredictionPaperOrderSchema = z.object({
  questionId: z.number().int().nonnegative(),
  questionName: z.string().min(1).max(240),
  outcome: z.number().int().nonnegative(),
  outcomeName: z.string().min(1).max(240),
  side: z.union([z.literal(0), z.literal(1)]),
  sideName: z.string().min(1).max(80),
  contracts: z.number().positive().max(1_000_000),
  limitProbability: z.number().min(0).max(1),
  currentProbability: z.number().min(0).max(1).nullable(),
  quoteToken: z.string().min(1).max(24),
  criteriaAcknowledged: z.literal(true),
  fromAgent: z.boolean().optional(),
});

interface PredictionPaperLedger {
  sessionId: string;
  nextSequence: number;
  updatedAt: number;
  positions: PredictionPaperPosition[];
  fills: PredictionPaperFill[];
}

const predictionPaperLedgers = new Map<string, PredictionPaperLedger>();

export async function predictionPaperRoute(app: FastifyInstance): Promise<void> {
  app.post("/prediction/paper-orders", async (req, reply) => {
    let body: PredictionPaperOrderRequest;
    try {
      body = PredictionPaperOrderSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.issues[0];
        throw new ApiException(
          "INVALID_PARAMS",
          `Bad prediction paper order: ${first?.path.join(".") ?? "(root)"} ${first?.message ?? "validation failed"}`,
          "Prediction paper orders are simulated only and never post to /exchange.",
        );
      }
      throw err;
    }

    const ledger = ledgerForSession(sessionIdForRequest(req));
    const fill = recordPredictionPaperFill(ledger, body);
    return reply.send({
      id: fill.id,
      status: "accepted",
      mode: "paper",
      fill,
      account: accountForLedger(ledger),
    });
  });

  app.get("/prediction/paper-account", async (req, reply) => {
    return reply.send(accountForLedger(ledgerForSession(sessionIdForRequest(req))));
  });
}

function sessionIdForRequest(req: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = req.headers["x-agent-trade-session-id"];
  const sessionId = Array.isArray(raw) ? raw[0] : raw;
  if (!sessionId || !/^[a-zA-Z0-9._:-]{8,96}$/u.test(sessionId)) {
    return "default-prediction-paper-session";
  }
  return sessionId;
}

function ledgerForSession(sessionId: string): PredictionPaperLedger {
  const existing = predictionPaperLedgers.get(sessionId);
  if (existing) return existing;
  const ledger: PredictionPaperLedger = {
    sessionId,
    nextSequence: 1,
    updatedAt: Date.now(),
    positions: [],
    fills: [],
  };
  predictionPaperLedgers.set(sessionId, ledger);
  return ledger;
}

function recordPredictionPaperFill(
  ledger: PredictionPaperLedger,
  order: PredictionPaperOrderRequest,
): PredictionPaperFill {
  const now = Date.now();
  const sequence = ledger.nextSequence++;
  ledger.updatedAt = now;
  const cost = round(order.contracts * order.limitProbability);
  const maxPayout = round(Math.floor(order.contracts));
  const maxProfit = round(maxPayout - cost);
  const maxLoss = cost;
  const fill: PredictionPaperFill = {
    id: `prediction_paper_${now.toString(36)}_${sequence.toString(36)}`,
    mode: "paper",
    questionId: order.questionId,
    questionName: order.questionName,
    outcome: order.outcome,
    outcomeName: order.outcomeName,
    side: order.side,
    sideName: order.sideName,
    contracts: round(order.contracts),
    limitProbability: round(order.limitProbability),
    cost,
    maxPayout,
    maxProfit,
    maxLoss,
    breakEvenProbability: round(order.limitProbability),
    currentProbability: order.currentProbability === null ? null : round(order.currentProbability),
    quoteToken: order.quoteToken,
    timestamp: now,
    fromAgent: order.fromAgent ?? false,
  };

  ledger.fills = [fill, ...ledger.fills].slice(0, 100);
  upsertPosition(ledger, fill);
  return fill;
}

function upsertPosition(ledger: PredictionPaperLedger, fill: PredictionPaperFill): void {
  const key = positionKey(fill);
  const existingIndex = ledger.positions.findIndex((position) => position.key === key);
  const existing = existingIndex >= 0 ? ledger.positions[existingIndex] : undefined;
  const contracts = round((existing?.contracts ?? 0) + fill.contracts);
  const totalCost = round((existing?.totalCost ?? 0) + fill.cost);
  const avgCost = contracts > 0 ? round(totalCost / contracts) : 0;
  const currentProbability = fill.currentProbability ?? existing?.currentProbability ?? null;
  const currentValue = currentProbability === null ? null : round(contracts * currentProbability);
  const maxPayout = round(Math.floor(contracts));
  const maxProfit = round(maxPayout - totalCost);
  const position: PredictionPaperPosition = {
    key,
    mode: "paper",
    questionId: fill.questionId,
    questionName: fill.questionName,
    outcome: fill.outcome,
    outcomeName: fill.outcomeName,
    side: fill.side,
    sideName: fill.sideName,
    contracts,
    avgCost,
    totalCost,
    currentProbability,
    currentValue,
    maxPayout,
    maxProfit,
    maxLoss: totalCost,
    unrealizedPnl: currentValue === null ? null : round(currentValue - totalCost),
    quoteToken: fill.quoteToken,
    resolutionStatus: "open",
    updatedAt: fill.timestamp,
  };

  if (existingIndex >= 0) {
    ledger.positions[existingIndex] = position;
  } else {
    ledger.positions.unshift(position);
  }
}

function accountForLedger(ledger: PredictionPaperLedger): PredictionPaperAccount {
  return {
    sessionId: ledger.sessionId,
    mode: "paper",
    ledgerRevision: ledger.nextSequence - 1,
    updatedAt: ledger.updatedAt,
    positions: ledger.positions,
    fills: ledger.fills,
  };
}

function positionKey(fill: Pick<PredictionPaperFill, "questionId" | "outcome" | "side">): string {
  return `${fill.questionId}:${fill.outcome}:${fill.side}`;
}

function round(value: number, decimals = 6): number {
  return Number(value.toFixed(decimals));
}
