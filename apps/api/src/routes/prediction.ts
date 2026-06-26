import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";

import type {
  PredictionDepthSummary,
  PredictionOutcome,
  PredictionOutcomeOdds,
  PredictionOutcomeSide,
  PredictionQuestion,
  PredictionQuestionMetadata,
  PredictionQuestionOdds,
  PredictionSettlementState,
  PredictionSide,
  PredictionSideOdds,
} from "@alchemy-hl/shared";

import { ApiException } from "../errors.js";
import { HlClient } from "../helpers/hlClient.js";
import { hip4PredictionTechnicalDetails } from "../helpers/predictionHip4.js";
import { TtlCache, cachedAsync } from "../helpers/ttlCache.js";

const idParamsSchema = z.object({
  questionId: z.coerce.number().int().min(0).optional(),
  outcome: z.coerce.number().int().min(0).optional(),
});

/**
 * First-class, read-only HIP-4 prediction-market API.
 *
 * This preserves Hyperliquid's question grouping from outcomeMeta and keeps
 * outcome trading details strictly informational. All order submission remains
 * on existing exchange paths.
 */
export async function predictionRoute(app: FastifyInstance): Promise<void> {
  const hl = new HlClient({
    baseUrl: app.config.HYPERLIQUID_API_URL,
    logger: { warn: app.log.warn.bind(app.log) },
  });

  const metaCache = new TtlCache<Promise<PredictionMeta>>({ ttlMs: 60_000, maxEntries: 4 });

  app.get("/prediction/questions", async (_req, reply) => {
    const meta = await cachedAsync(metaCache, "prediction-meta", () => fetchPredictionMeta(hl));
    return reply.send({ questions: meta.questions });
  });

  app.get("/prediction/questions/:questionId", async (req, reply) => {
    const questionId = parseIdParam(req.params, "questionId");
    const meta = await cachedAsync(metaCache, "prediction-meta", () => fetchPredictionMeta(hl));
    const question = findQuestion(meta, questionId);
    return reply.send({ question });
  });

  app.get("/prediction/questions/:questionId/odds", async (req, reply) => {
    const questionId = parseIdParam(req.params, "questionId");
    const meta = await cachedAsync(metaCache, "prediction-meta", () => fetchPredictionMeta(hl));
    const question = findQuestion(meta, questionId);
    const fetchedAt = Date.now();
    const questionOutcomes = [
      ...(question.fallbackOutcome ? [question.fallbackOutcome] : []),
      ...question.namedOutcomes,
    ];
    const outcomes = await Promise.all(
      questionOutcomes.map((outcome) => fetchOutcomeOdds(hl, outcome, fetchedAt)),
    );
    const out: PredictionQuestionOdds = {
      questionId: question.questionId,
      name: question.name,
      fetchedAt,
      outcomes,
    };
    return reply.send(out);
  });

  app.get("/prediction/outcomes/:outcome/odds", async (req, reply) => {
    const outcomeId = parseIdParam(req.params, "outcome");
    const meta = await cachedAsync(metaCache, "prediction-meta", () => fetchPredictionMeta(hl));
    const outcome = findOutcome(meta, outcomeId);
    const out = await fetchOutcomeOdds(hl, outcome, Date.now());
    return reply.send(out);
  });

  app.get("/prediction/outcomes/:outcome/settlement", async (req, reply) => {
    const outcomeId = parseIdParam(req.params, "outcome");
    const meta = await cachedAsync(metaCache, "prediction-meta", () => fetchPredictionMeta(hl));
    findOutcome(meta, outcomeId);
    const raw = await hl.info<unknown>({ type: "settledOutcome", outcome: outcomeId });
    const out: PredictionSettlementState = normalizeSettlement(outcomeId, raw, Date.now());
    return reply.send(out);
  });
}

export async function fetchPredictionMeta(hl: HlClient): Promise<PredictionMeta> {
  const raw = await hl.info<HlOutcomeMeta>({ type: "outcomeMeta" });
  if (!raw || !Array.isArray(raw.outcomes) || !Array.isArray(raw.questions)) {
    throw new ApiException(
      "HL_EXCHANGE_REJECTED",
      "Hyperliquid returned an unexpected outcomeMeta response.",
      "Retry the request. If this persists, Hyperliquid may have changed the HIP-4 metadata schema.",
    );
  }

  const outcomes = raw.outcomes
    .filter((outcome) => typeof outcome?.outcome === "number" && Array.isArray(outcome.sideSpecs))
    .map(normalizeOutcome);
  const outcomesById = new Map(outcomes.map((outcome) => [outcome.outcome, outcome]));
  const questions = raw.questions
    .filter((question) => typeof question?.question === "number")
    .map((question) => normalizeQuestion(question, outcomesById));

  return { questions, outcomesById };
}

function normalizeQuestion(
  question: HlQuestion,
  outcomesById: Map<number, PredictionOutcome>,
): PredictionQuestion {
  const namedOutcomes = (question.namedOutcomes ?? [])
    .map((outcomeId) => outcomesById.get(outcomeId))
    .filter((outcome): outcome is PredictionOutcome => Boolean(outcome));
  const fallbackOutcome = outcomesById.get(question.fallbackOutcome ?? -1) ?? null;
  const settledNamedOutcomeIds = (question.settledNamedOutcomes ?? []).filter((id) =>
    namedOutcomes.some((outcome) => outcome.outcome === id),
  );
  const quoteTokens = Array.from(
    new Set(
      [...namedOutcomes, ...(fallbackOutcome ? [fallbackOutcome] : [])].map(
        (outcome) => outcome.quoteToken,
      ),
    ),
  ).sort();

  return {
    questionId: question.question,
    name: question.name ?? `Question ${question.question}`,
    description: question.description ?? "",
    criteria: stripMetadata(question.description ?? ""),
    metadata: parseMetadata(question.description ?? ""),
    quoteToken: quoteTokens.length === 1 ? quoteTokens[0]! : null,
    quoteTokens,
    fallbackOutcome,
    namedOutcomes,
    settlement: {
      state:
        settledNamedOutcomeIds.length === 0
          ? "open"
          : settledNamedOutcomeIds.length >= namedOutcomes.length
            ? "settled"
            : "partiallySettled",
      settledNamedOutcomeIds,
    },
  };
}

function normalizeOutcome(raw: HlOutcome): PredictionOutcome {
  const outcome = raw.outcome;
  const sideSpecs = raw.sideSpecs ?? [];
  const quoteToken = raw.quoteToken ?? "USDC";
  return {
    outcome,
    name: raw.name ?? `Outcome ${outcome}`,
    description: raw.description ?? "",
    quoteToken,
    sides: [
      makeOutcomeSide(outcome, 0, quoteToken, sideSpecs),
      makeOutcomeSide(outcome, 1, quoteToken, sideSpecs),
    ],
  };
}

function makeOutcomeSide(
  outcome: number,
  side: PredictionSide,
  quoteToken: string,
  sideSpecs: Array<{ name?: string }>,
): PredictionOutcomeSide {
  const technical = hip4PredictionTechnicalDetails(outcome, side, quoteToken);
  return {
    side,
    name: sideSpecs[side]?.name ?? (side === 0 ? "Yes" : "No"),
    encoding: technical.encoding,
    coin: technical.coin,
    assetId: technical.assetId,
  };
}

async function fetchOutcomeOdds(
  hl: HlClient,
  outcome: PredictionOutcome,
  fetchedAt: number,
): Promise<PredictionOutcomeOdds> {
  const sides = (await Promise.all(
    outcome.sides.map((side) => fetchSideOdds(hl, side, fetchedAt)),
  )) as [PredictionSideOdds, PredictionSideOdds];
  return {
    outcome: outcome.outcome,
    name: outcome.name,
    description: outcome.description,
    quoteToken: outcome.quoteToken,
    sides,
  };
}

async function fetchSideOdds(
  hl: HlClient,
  side: PredictionOutcomeSide,
  fetchedAt: number,
): Promise<PredictionSideOdds> {
  const book = await hl.info<HlL2Book>({ type: "l2Book", coin: side.coin });
  const bids = validLevels(book?.levels?.[0]);
  const asks = validLevels(book?.levels?.[1]);
  const bestBid = bids[0]?.px ?? null;
  const bestAsk = asks[0]?.px ?? null;
  const bid = parseProbability(bestBid);
  const ask = parseProbability(bestAsk);
  const midpointProbability = bid !== null && ask !== null ? (bid + ask) / 2 : null;
  const spread = bid !== null && ask !== null ? ask - bid : null;

  return {
    ...side,
    bestBid,
    bestAsk,
    midpointProbability,
    spread,
    depth: depthSummary(bids, asks),
    emptyBook: bids.length === 0 && asks.length === 0,
    fetchedAt,
  };
}

function validLevels(levels: Array<{ px?: string; sz?: string; n?: number }> | undefined): HlBookLevel[] {
  return (levels ?? [])
    .filter((level): level is HlBookLevel => typeof level.px === "string" && typeof level.sz === "string")
    .filter((level) => parseProbability(level.px) !== null && parsePositiveNumber(level.sz) !== null);
}

function depthSummary(bids: HlBookLevel[], asks: HlBookLevel[]): PredictionDepthSummary {
  return {
    bidLevels: bids.length,
    askLevels: asks.length,
    bidSize: sumSize(bids),
    askSize: sumSize(asks),
    bidNotional: sumNotional(bids),
    askNotional: sumNotional(asks),
  };
}

function sumSize(levels: HlBookLevel[]): number {
  return levels.reduce((sum, level) => sum + (parsePositiveNumber(level.sz) ?? 0), 0);
}

function sumNotional(levels: HlBookLevel[]): number {
  return levels.reduce((sum, level) => {
    const px = parseProbability(level.px) ?? 0;
    const sz = parsePositiveNumber(level.sz) ?? 0;
    return sum + px * sz;
  }, 0);
}

function parseProbability(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const n = Number(input);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function parsePositiveNumber(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const n = Number(input);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeSettlement(
  outcome: number,
  raw: unknown,
  fetchedAt: number,
): PredictionSettlementState {
  if (raw === null) {
    return {
      outcome,
      state: "unresolved",
      isResolved: false,
      resolvedSide: null,
      raw: null,
      fetchedAt,
    };
  }

  return {
    outcome,
    state: "resolved",
    isResolved: true,
    resolvedSide: extractResolvedSide(raw),
    raw,
    fetchedAt,
  };
}

function extractResolvedSide(raw: unknown): PredictionSide | null {
  if (!raw || typeof raw !== "object") return null;
  const maybeSide = (raw as { side?: unknown; resolvedSide?: unknown; winningSide?: unknown }).side ??
    (raw as { resolvedSide?: unknown }).resolvedSide ??
    (raw as { winningSide?: unknown }).winningSide;
  return maybeSide === 0 || maybeSide === 1 ? maybeSide : null;
}

function parseIdParam(params: unknown, field: "questionId" | "outcome"): number {
  try {
    const parsed = idParamsSchema.parse(params);
    const value = parsed[field];
    if (value === undefined) throw new Error("missing id");
    return value;
  } catch (err) {
    if (err instanceof ZodError || err instanceof Error) {
      throw new ApiException(
        "INVALID_PARAMS",
        `Bad path parameter: ${field} must be a non-negative integer.`,
        "Use an id returned by GET /prediction/questions.",
      );
    }
    throw err;
  }
}

export function findQuestion(meta: PredictionMeta, questionId: number): PredictionQuestion {
  const question = meta.questions.find((item) => item.questionId === questionId);
  if (!question) {
    throw new ApiException(
      "INVALID_PARAMS",
      `Unknown prediction question id ${questionId}.`,
      "Enumerate live prediction questions via GET /prediction/questions.",
    );
  }
  return question;
}

export function findOutcome(meta: PredictionMeta, outcomeId: number): PredictionOutcome {
  const outcome = meta.outcomesById.get(outcomeId);
  if (!outcome) {
    throw new ApiException(
      "INVALID_PARAMS",
      `Unknown prediction outcome id ${outcomeId}.`,
      "Enumerate live prediction questions via GET /prediction/questions and use a named outcome id.",
    );
  }
  return outcome;
}

function stripMetadata(description: string): string {
  return description.replace(/\s*metadata=[^\n\r]*$/u, "").trim();
}

function parseMetadata(description: string): PredictionQuestionMetadata | null {
  const match = description.match(/metadata=([^\n\r]*)$/u);
  if (!match) return null;
  const raw = match[1]!.trim();
  const out: PredictionQuestionMetadata = { raw };
  for (const part of raw.split("|")) {
    const [key, value] = part.split(":", 2);
    if (!key || value === undefined) continue;
    if (key === "category") out.category = value;
    if (key === "subCategory") out.subCategory = value;
  }
  return out;
}

export interface PredictionMeta {
  questions: PredictionQuestion[];
  outcomesById: Map<number, PredictionOutcome>;
}

interface HlOutcomeMeta {
  outcomes?: HlOutcome[];
  questions?: HlQuestion[];
}

interface HlOutcome {
  outcome: number;
  name?: string;
  description?: string;
  sideSpecs?: Array<{ name?: string }>;
  quoteToken?: string;
}

interface HlQuestion {
  question: number;
  name?: string;
  description?: string;
  fallbackOutcome?: number;
  namedOutcomes?: number[];
  settledNamedOutcomes?: number[];
}

interface HlBookLevel {
  px: string;
  sz: string;
  n?: number;
}

interface HlL2Book {
  levels?: [HlBookLevel[], HlBookLevel[]];
}
