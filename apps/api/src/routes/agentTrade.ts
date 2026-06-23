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

    const notionalUsd = body.draft.sizeBtc * body.estimatedEntry;
    return reply.send({
      id: `paper_${Date.now().toString(36)}`,
      status: "accepted",
      mode: "paper",
      notionalUsd,
      estimatedEntry: body.estimatedEntry,
      createdAt: Date.now(),
    });
  });
}
