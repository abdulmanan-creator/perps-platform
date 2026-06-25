import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PREDICTION_RISK_COPY } from "../components/agent-trade/PredictionDetailClient";
import {
  calculatePredictionTicketMath,
  enrichPredictionPaperPositions,
  filterAndSortPredictionQuestions,
  formatEmptyBook,
  formatProbability,
  formatProbabilityPrice,
  formatSpread,
  formatUsdc,
  isResolvingSoon,
  maxPayoutForContracts,
  premiumForContracts,
  summarizePredictionPortfolioExposure,
  summarizeQuestionOdds,
  type PredictionDiscoveryQuestion,
} from "../lib/agent-trade/predictions";
import type { PredictionPaperAccount, PredictionQuestionOdds } from "@alchemy-hl/shared";

const baseQuestions: PredictionDiscoveryQuestion[] = [
  {
    questionId: 2,
    name: "July Fed funds decision",
    description: "Resolves on July 29, 2026. metadata=category:economics|subCategory:N/A",
    criteria: "Resolves on July 29, 2026.",
    metadata: { category: "economics", subCategory: "N/A", raw: "category:economics|subCategory:N/A" },
    quoteToken: "USDC",
    quoteTokens: ["USDC"],
    fallbackOutcome: null,
    namedOutcomes: [
      {
        outcome: 21,
        name: "No change",
        description: "",
        quoteToken: "USDC",
        sides: [
          { side: 0, name: "Yes", encoding: 210, coin: "#210", assetId: 100_000_210 },
          { side: 1, name: "No", encoding: 211, coin: "#211", assetId: 100_000_211 },
        ],
      },
    ],
    settlement: { state: "open", settledNamedOutcomeIds: [] },
    oddsSummary: {
      questionId: 2,
      fetchedAt: 1,
      outcomeCount: 1,
      visibleOutcomes: [],
      nonEmptySideCount: 2,
      totalDepth: 500,
      widestSpread: 0.02,
      hasThinLiquidity: false,
    },
  },
  {
    questionId: 1,
    name: "World Cup Champion",
    description: "metadata=category:sports|subCategory:football",
    criteria: "The winner is determined by the official result.",
    metadata: { category: "sports", subCategory: "football", raw: "category:sports|subCategory:football" },
    quoteToken: "USDC",
    quoteTokens: ["USDC"],
    fallbackOutcome: null,
    namedOutcomes: [
      {
        outcome: 11,
        name: "France",
        description: "",
        quoteToken: "USDC",
        sides: [
          { side: 0, name: "Yes", encoding: 110, coin: "#110", assetId: 100_000_110 },
          { side: 1, name: "No", encoding: 111, coin: "#111", assetId: 100_000_111 },
        ],
      },
      {
        outcome: 12,
        name: "Brazil",
        description: "",
        quoteToken: "USDC",
        sides: [
          { side: 0, name: "Yes", encoding: 120, coin: "#120", assetId: 100_000_120 },
          { side: 1, name: "No", encoding: 121, coin: "#121", assetId: 100_000_121 },
        ],
      },
    ],
    settlement: { state: "settled", settledNamedOutcomeIds: [11, 12] },
    oddsSummary: {
      questionId: 1,
      fetchedAt: 1,
      outcomeCount: 2,
      visibleOutcomes: [],
      nonEmptySideCount: 0,
      totalDepth: 0,
      widestSpread: null,
      hasThinLiquidity: true,
    },
  },
];

const questionOdds: PredictionQuestionOdds = {
  questionId: 1,
  name: "World Cup Champion",
  fetchedAt: 100,
  outcomes: [
    {
      outcome: 11,
      name: "France",
      description: "",
      quoteToken: "USDC",
      sides: [
        {
          side: 0,
          name: "Yes",
          encoding: 110,
          coin: "#110",
          assetId: 100_000_110,
          bestBid: "0.20",
          bestAsk: "0.25",
          midpointProbability: 0.225,
          spread: 0.05,
          depth: { bidLevels: 1, askLevels: 1, bidSize: 30, askSize: 20, bidNotional: 6, askNotional: 5 },
          emptyBook: false,
          fetchedAt: 100,
        },
        {
          side: 1,
          name: "No",
          encoding: 111,
          coin: "#111",
          assetId: 100_000_111,
          bestBid: null,
          bestAsk: null,
          midpointProbability: null,
          spread: null,
          depth: { bidLevels: 0, askLevels: 0, bidSize: 0, askSize: 0, bidNotional: 0, askNotional: 0 },
          emptyBook: true,
          fetchedAt: 100,
        },
      ],
    },
  ],
};

const paperAccount: PredictionPaperAccount = {
  sessionId: "prediction-paper-test",
  mode: "paper",
  ledgerRevision: 1,
  updatedAt: 1000,
  fills: [],
  positions: [
    {
      key: "1:11:0",
      mode: "paper",
      questionId: 1,
      questionName: "World Cup Champion",
      outcome: 11,
      outcomeName: "France",
      side: 0,
      sideName: "Yes",
      contracts: 10,
      avgCost: 0.2,
      totalCost: 2,
      currentProbability: 0.2,
      currentValue: 2,
      maxPayout: 10,
      maxProfit: 8,
      maxLoss: 2,
      unrealizedPnl: 0,
      quoteToken: "USDC",
      resolutionStatus: "open",
      updatedAt: 1000,
    },
  ],
};

describe("Agent.trade prediction helpers", () => {
  it("filters and sorts prediction questions by query, category, status, and liquidity", () => {
    expect(filterAndSortPredictionQuestions({
      questions: baseQuestions,
      query: "france",
      filter: "all",
      sort: "default",
    }).map((question) => question.questionId)).toEqual([1]);

    expect(filterAndSortPredictionQuestions({
      questions: baseQuestions,
      query: "",
      filter: "sports",
      sort: "default",
    }).map((question) => question.questionId)).toEqual([1]);

    expect(filterAndSortPredictionQuestions({
      questions: baseQuestions,
      query: "",
      filter: "resolved",
      sort: "default",
    }).map((question) => question.questionId)).toEqual([1]);

    expect(filterAndSortPredictionQuestions({
      questions: baseQuestions,
      query: "",
      filter: "all",
      sort: "liquidity",
    }).map((question) => question.questionId)).toEqual([2, 1]);
  });

  it("detects resolving-soon markets when criteria include a date", () => {
    expect(isResolvingSoon(baseQuestions[0]!, new Date("2026-07-20T00:00:00Z"))).toBe(true);
    expect(isResolvingSoon(baseQuestions[0]!, new Date("2026-06-20T00:00:00Z"))).toBe(false);
  });

  it("formats probabilities, prices, spreads, and empty-book states", () => {
    expect(formatProbability(0.225)).toBe("22.5%");
    expect(formatProbability(null)).toBe("--");
    expect(formatProbabilityPrice("0.2500")).toBe("0.25");
    expect(formatSpread(0.05)).toBe("5.0 pts");
    expect(formatEmptyBook({ emptyBook: true, bestBid: null, bestAsk: null })).toBe("Empty book");
    expect(formatEmptyBook({ emptyBook: false, bestBid: "0.2", bestAsk: null })).toBe("One-sided book");
  });

  it("summarizes odds for discovery cards", () => {
    const summary = summarizeQuestionOdds(questionOdds);
    expect(summary.questionId).toBe(1);
    expect(summary.nonEmptySideCount).toBe(1);
    expect(summary.totalDepth).toBe(50);
    expect(summary.widestSpread).toBe(0.05);
    expect(summary.visibleOutcomes[0]?.midpointProbability).toBe(0.225);
  });

  it("computes read-only ticket preview math", () => {
    expect(maxPayoutForContracts(10.9)).toBe(10);
    expect(premiumForContracts(10, 0.25)).toBe(2.5);
    expect(premiumForContracts(10, null)).toBeNull();
  });

  it("computes paper prediction ticket cost, payout, and break-even probability", () => {
    expect(calculatePredictionTicketMath(10.9, 0.25)).toEqual({
      contracts: 10,
      probability: 0.25,
      estimatedCost: 2.5,
      maxPayout: 10,
      maxProfit: 7.5,
      maxLoss: 2.5,
      breakEvenProbability: 0.25,
    });
    expect(formatUsdc(2.5)).toBe("2.50 USDC");
  });

  it("enriches paper portfolio exposure with current probabilities", () => {
    const positions = enrichPredictionPaperPositions(paperAccount, baseQuestions[1]!, questionOdds);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      currentProbability: 0.225,
      currentValue: 2.25,
      unrealizedPnl: 0.25,
      resolutionStatus: "settled",
    });

    expect(summarizePredictionPortfolioExposure(positions)).toEqual({
      positionCount: 1,
      totalContracts: 10,
      totalCost: 2,
      currentValue: 2.25,
      maxPayout: 10,
      unrealizedPnl: 0.25,
    });
  });
});

describe("prediction route smoke", () => {
  it("adds Predictions and World Cup app-shell navigation entries", () => {
    const source = readFileSync(join(process.cwd(), "components/agent-trade/AppShell.tsx"), "utf8");
    expect(source).toContain("Predictions");
    expect(source).toContain("World Cup");
    expect(source).toContain("/predictions/32");
  });

  it("wires the /predictions route to the prediction client", () => {
    const source = readFileSync(join(process.cwd(), "app/predictions/page.tsx"), "utf8");
    expect(source).toContain("PredictionsClient");
    expect(source).toContain("AppShell");
  });

  it("wires the detail route to the prediction detail client", () => {
    const source = readFileSync(join(process.cwd(), "app/predictions/[questionId]/page.tsx"), "utf8");
    expect(source).toContain("PredictionDetailClient");
    expect(source).toContain("questionId");
  });

  it("keeps the World Cup detail route graceful when live data is unavailable", () => {
    const source = readFileSync(join(process.cwd(), "components/agent-trade/PredictionDetailClient.tsx"), "utf8");
    expect(source).toContain("Live prediction data unavailable");
    expect(source).toContain("Back to predictions");
  });

  it("keeps prediction paper helpers away from exchange submission", () => {
    const source = readFileSync(join(process.cwd(), "lib/agent-trade/predictions.ts"), "utf8");
    expect(source).toContain("/prediction/paper-orders");
    expect(source).toContain("/prediction/paper-account");
    expect(source).not.toContain("/exchange");
  });
});

describe("prediction UI copy", () => {
  it("does not include perp-only concepts as standalone ticket/risk terms", () => {
    const source = readFileSync(join(process.cwd(), "components/agent-trade/PredictionDetailClient.tsx"), "utf8");
    const copy = `${PREDICTION_RISK_COPY.join(" ")} ${source}`.toLowerCase();
    expect(copy).not.toMatch(/\bliquidation\b/u);
    expect(copy).not.toMatch(/\bfunding\b/u);
    expect(copy).not.toMatch(/\bleverage\b/u);
    expect(copy).not.toMatch(/\bmargin mode\b/u);
  });
});
