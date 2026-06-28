import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getPredictionLiveAvailability,
  PREDICTION_RISK_COPY,
} from "../components/agent-trade/PredictionDetailClient";
import {
  calculatePredictionTicketMath,
  buildPredictionUsdcTransfer,
  buildPredictionLiveOrderAction,
  clearPredictionStreamOutcomeOdds,
  enrichPredictionPaperPositions,
  filterAndSortPredictionQuestions,
  formatEmptyBook,
  formatProbability,
  formatProbabilityPrice,
  formatSpread,
  formatUsdc,
  formatPredictionLivePriceWire,
  getPredictionHip4EffectiveMinOrderCostUsd,
  getPredictionHip4MinOrderCostUsd,
  hasSufficientPredictionSpotBalance,
  hasValidPredictionTopOfBook,
  isResolvingSoon,
  isPredictionLiveTradingEnabled,
  isPredictionWorldCupStreamEnabled,
  loadPredictionBalance,
  loadPredictionDiscoveryOddsSummaries,
  mergePredictionL2BookUpdate,
  minimumPredictionContractsForCost,
  maxPayoutForContracts,
  normalizePredictionL2BookMessage,
  premiumForContracts,
  predictionPaperFillsForQuestion,
  predictionHip4Coin,
  predictionL2BookSubscription,
  predictionPaperPositionsForQuestion,
  predictionStreamStatusLabel,
  predictionUsdcTransferEndpoint,
  prioritizePredictionOutcomeIds,
  sendPredictionUsdcTransfer,
  shouldShowPredictionUsdcTransferCard,
  suggestPredictionUsdcTransferAmount,
  summarizePredictionLiveExchangeResult,
  summarizePredictionPortfolioExposure,
  summarizeQuestionOdds,
  submitPredictionPaperOrder,
  type PredictionDiscoveryQuestion,
} from "../lib/agent-trade/predictions";
import type { PredictionBalanceState, PredictionPaperAccount, PredictionQuestionOdds } from "@alchemy-hl/shared";

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

const paperFill = {
  id: "prediction_paper_test_1",
  mode: "paper" as const,
  questionId: 1,
  questionName: "World Cup Champion",
  outcome: 11,
  outcomeName: "France",
  side: 0 as const,
  sideName: "Yes",
  contracts: 10,
  limitProbability: 0.2,
  cost: 2,
  maxPayout: 10,
  maxProfit: 8,
  maxLoss: 2,
  breakEvenProbability: 0.2,
  currentProbability: 0.225,
  quoteToken: "USDC",
  timestamp: 1000,
  fromAgent: false,
};

const paperAccountWithFill: PredictionPaperAccount = {
  ...paperAccount,
  fills: [paperFill],
};

const liveEligible = {
  state: "liveEligible" as const,
  executionVenue: "hyperliquid-mainnet",
  mainnetExecutionEnabled: true,
  killSwitchEnabled: false,
  minOrderNotionalUsd: 10,
  orderNotionalCapUsd: 250,
  dailyNotionalCapUsd: 1000,
};

describe("Agent.trade prediction helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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
    expect(hasValidPredictionTopOfBook(undefined)).toBe(false);
    expect(hasValidPredictionTopOfBook(questionOdds.outcomes[0]?.sides[0])).toBe(true);
    expect(hasValidPredictionTopOfBook(questionOdds.outcomes[0]?.sides[1])).toBe(false);
  });

  it("summarizes odds for discovery cards", () => {
    const summary = summarizeQuestionOdds(questionOdds);
    expect(summary.questionId).toBe(1);
    expect(summary.nonEmptySideCount).toBe(1);
    expect(summary.totalDepth).toBe(50);
    expect(summary.widestSpread).toBe(0.05);
    expect(summary.visibleOutcomes[0]?.midpointProbability).toBe(0.225);
  });

  it("keeps discovery odds failures non-blocking", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    await expect(loadPredictionDiscoveryOddsSummaries({
      questionIds: [1, 2],
      timeoutMs: 10,
      concurrency: 1,
    })).resolves.toEqual([]);
  });

  it("prioritizes selected and known liquid World Cup outcomes", () => {
    const worldCup = {
      ...baseQuestions[1]!,
      questionId: 32,
      namedOutcomes: [
        ...baseQuestions[1]!.namedOutcomes,
        {
          outcome: 189,
          name: "France",
          description: "",
          quoteToken: "USDC",
          sides: [
            { side: 0 as const, name: "Yes", encoding: 1890, coin: "#1890", assetId: 100_001_890 },
            { side: 1 as const, name: "No", encoding: 1891, coin: "#1891", assetId: 100_001_891 },
          ],
        },
      ],
    };
    expect(prioritizePredictionOutcomeIds(worldCup, 12).slice(0, 2)).toEqual([12, 189]);
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

  it("builds HIP-4 live order actions with official asset encoding", () => {
    const action = buildPredictionLiveOrderAction({
      assetId: 100_001_890,
      order: {
        questionId: 32,
        outcome: 189,
        side: 0,
        action: "buy",
        contracts: 53,
        limitProbability: 0.1888,
        tif: "Ioc",
        criteriaAcknowledged: true,
        liveAcknowledged: true,
      },
    });
    expect(action).toEqual({
      type: "order",
      grouping: "na",
      orders: [{ a: 100_001_890, b: true, p: "0.1888", s: "53", r: false, t: { limit: { tif: "Ioc" } } }],
    });
  });

  it("gates HIP-4 prediction streaming to World Cup question 32", () => {
    expect(isPredictionWorldCupStreamEnabled(32)).toBe(true);
    expect(isPredictionWorldCupStreamEnabled(31)).toBe(false);
    expect(predictionStreamStatusLabel("live")).toBe("Live World Cup book");
    expect(predictionStreamStatusLabel("rest_fallback")).toBe("REST fallback");
    expect(predictionStreamStatusLabel("disconnected")).toBe("Stream disconnected");
  });

  it("maps selected outcome and side to one HIP-4 l2Book subscription coin", () => {
    expect(predictionHip4Coin(189, 0)).toBe("#1890");
    expect(predictionHip4Coin(189, 1)).toBe("#1891");

    const subscription = predictionL2BookSubscription(predictionHip4Coin(189, 0));
    expect(subscription).toEqual({
      method: "subscribe",
      subscription: { type: "l2Book", coin: "#1890", nSigFigs: 5, fast: true },
    });
    expect(JSON.stringify(subscription)).not.toContain("#1730");
    expect(Array.isArray(subscription)).toBe(false);
  });

  it("normalizes selected HIP-4 l2Book updates and ignores other coins", () => {
    const message = {
      channel: "l2Book",
      data: {
        coin: "#110",
        levels: [
          [{ px: "0.21", sz: "40" }],
          [{ px: "0.24", sz: "10" }],
        ],
      },
    };

    expect(normalizePredictionL2BookMessage({
      message,
      selectedCoin: "#111",
      now: 123,
    })).toBeUndefined();
    expect(normalizePredictionL2BookMessage({
      message,
      selectedCoin: "#110",
      now: 123,
    })).toEqual({
      coin: "#110",
      receivedAt: 123,
      bids: [{ px: "0.21", sz: "40" }],
      asks: [{ px: "0.24", sz: "10" }],
    });
  });

  it("merges a selected-side l2Book update into World Cup odds", () => {
    const worldCup = { ...baseQuestions[1]!, questionId: 32 };
    const update = normalizePredictionL2BookMessage({
      message: {
        channel: "l2Book",
        data: {
          coin: "#110",
          levels: [
            [{ px: "0.21", sz: "40" }],
            [{ px: "0.24", sz: "10" }],
          ],
        },
      },
      selectedCoin: "#110",
      now: 456,
    });
    if (!update) throw new Error("missing l2Book update");

    const merged = mergePredictionL2BookUpdate({
      current: undefined,
      question: worldCup,
      outcomeId: 11,
      sideIndex: 0,
      update,
    });
    const side = merged.outcomes[0]?.sides[0];
    expect(merged.outcomes).toHaveLength(1);
    expect(side).toMatchObject({
      bestBid: "0.21",
      bestAsk: "0.24",
      midpointProbability: 0.225,
      spread: 0.03,
      depth: { bidLevels: 1, askLevels: 1, bidSize: 40, askSize: 10, bidNotional: 8.4, askNotional: 2.4 },
      emptyBook: false,
      fetchedAt: 456,
    });
  });

  it("clears stale selected-outcome stream odds when the outcome changes", () => {
    const cleared = clearPredictionStreamOutcomeOdds(questionOdds, 11);
    expect(cleared?.outcomes).toHaveLength(0);
    expect(clearPredictionStreamOutcomeOdds(questionOdds, 999)?.outcomes).toHaveLength(1);
  });

  it("normalizes HIP-4 live order prices with Hyperliquid spot rules", () => {
    expect(formatPredictionLivePriceWire(0.18879)).toBe("0.1888");
    expect(formatPredictionLivePriceWire(0.188789123)).toBe("0.1888");
    expect(formatPredictionLivePriceWire(0.04002)).toBe("0.04");
    expect(formatPredictionLivePriceWire(0.037455)).toBe("0.0375");

    const action = buildPredictionLiveOrderAction({
      assetId: 100_002_170,
      order: {
        questionId: 32,
        outcome: 217,
        side: 0,
        action: "buy",
        contracts: 53,
        limitProbability: 0.037455,
        tif: "Ioc",
        criteriaAcknowledged: true,
        liveAcknowledged: true,
      },
    });
    expect(action.orders[0]).toMatchObject({ a: 100_002_170, p: "0.0375", s: "53" });
  });

  it("keeps HIP-4 live trading default-off, uses an $11 effective HIP-4 min, and summarizes nested exchange statuses", () => {
    expect(isPredictionLiveTradingEnabled(undefined)).toBe(false);
    expect(isPredictionLiveTradingEnabled("false")).toBe(false);
    expect(isPredictionLiveTradingEnabled("true")).toBe(true);
    expect(getPredictionHip4MinOrderCostUsd(undefined)).toBe(10);
    expect(getPredictionHip4MinOrderCostUsd("2.5")).toBe(2.5);
    expect(getPredictionHip4MinOrderCostUsd("bad")).toBe(10);
    expect(getPredictionHip4EffectiveMinOrderCostUsd(undefined, 10)).toBe(11);
    expect(getPredictionHip4EffectiveMinOrderCostUsd("12", 10)).toBe(12);
    expect(getPredictionHip4EffectiveMinOrderCostUsd("9", 10)).toBe(10);
    expect(getPredictionHip4EffectiveMinOrderCostUsd("bad", 10)).toBe(11);
    expect(minimumPredictionContractsForCost(0.243, 11)).toBe(46);
    expect(calculatePredictionTicketMath(42, 0.243).estimatedCost).toBe(10.206);
    expect(calculatePredictionTicketMath(46, 0.243).estimatedCost).toBe(11.178);
    expect(summarizePredictionLiveExchangeResult({
      exchangeResponse: { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 99 } }] } } },
    })).toEqual({ status: "resting", label: "Resting open order", oid: 99 });
    expect(summarizePredictionLiveExchangeResult({
      exchangeResponse: { status: "ok", response: { type: "order", data: { statuses: [{ error: "Bad order" }] } } },
    })).toEqual({ status: "rejected", label: "Rejected", reason: "Bad order" });
  });

  it("checks HIP-4 spot-style spendable balance before live review", async () => {
    const balance = {
      user: "0x0000000000000000000000000000000000000001" as const,
      source: "spotClearinghouseState" as const,
      spotUsdc: { coin: "USDC", token: 0, total: "11", hold: "1", available: "10", entryNtl: "0" },
      spotUsdcAvailable: "10",
      perpWithdrawable: "500",
      balances: [],
      outcomeBalances: [],
      fetchedAt: 123,
      guidance: "Prediction markets use Hyperliquid spot-style balance; perp margin balance may not be spendable here.",
    };
    expect(hasSufficientPredictionSpotBalance(balance, 9.99)).toBe(true);
    expect(hasSufficientPredictionSpotBalance(balance, 10)).toBe(true);
    expect(hasSufficientPredictionSpotBalance(balance, 10.01)).toBe(false);
    expect(hasSufficientPredictionSpotBalance(undefined, 1)).toBe(false);

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/prediction/balance");
      expect(url).toContain("user=0x0000000000000000000000000000000000000001");
      return new Response(JSON.stringify(balance), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    await expect(loadPredictionBalance("0x0000000000000000000000000000000000000001")).resolves.toMatchObject({
      spotUsdcAvailable: "10",
      perpWithdrawable: "500",
    });
  });

  it("shows prediction USDC transfer card only when live spot balance is short and perp withdrawable is available", () => {
    const shortBalance: PredictionBalanceState = {
      user: "0x0000000000000000000000000000000000000001",
      source: "spotClearinghouseState",
      spotUsdc: { coin: "USDC", token: 0, total: "0", hold: "0", available: "0", entryNtl: "0" },
      spotUsdcAvailable: "0",
      perpWithdrawable: "11.588513",
      balances: [],
      outcomeBalances: [],
      fetchedAt: 123,
      guidance: "Prediction markets use Hyperliquid spot-style balance; perp margin balance may not be spendable here.",
    };
    const fundedBalance = { ...shortBalance, spotUsdcAvailable: "12" };

    expect(shouldShowPredictionUsdcTransferCard({
      mode: "live",
      liveAllowed: true,
      balance: shortBalance,
      requiredCostUsd: 10.0064,
    })).toBe(true);
    expect(shouldShowPredictionUsdcTransferCard({
      mode: "live",
      liveAllowed: true,
      balance: fundedBalance,
      requiredCostUsd: 10.0064,
    })).toBe(false);
    expect(shouldShowPredictionUsdcTransferCard({
      mode: "paper",
      liveAllowed: true,
      balance: shortBalance,
      requiredCostUsd: 10.0064,
    })).toBe(false);
    expect(shouldShowPredictionUsdcTransferCard({
      mode: "live",
      liveAllowed: false,
      balance: shortBalance,
      requiredCostUsd: 10.0064,
    })).toBe(false);
    expect(suggestPredictionUsdcTransferAmount({
      requiredCostUsd: 10.0064,
      spotUsdcAvailable: 0,
      perpWithdrawable: 11.588513,
    })).toBe("10.26");
  });

  it("builds and sends prediction USDC transfers through the prediction endpoint", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toBe(predictionUsdcTransferEndpoint());
      expect(url).not.toContain("/agent-trade/exchange");
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if ("signature" in body) {
        expect(body.user).toBe("0x0000000000000000000000000000000000000001");
        return new Response(JSON.stringify({
          status: "submitted",
          state: "submitted",
          success: true,
          user: "0x0000000000000000000000000000000000000001",
          action: body.action,
          exchangeResponse: { status: "ok", response: { type: "usdClassTransfer" } },
          exchangeResult: { status: "accepted", label: "Accepted" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: "built",
        state: "built",
        hash: `0x${"11".repeat(32)}`,
        nonce: 123,
        amount: "10.26",
        direction: "perp_to_spot",
        action: {
          type: "usdClassTransfer",
          hyperliquidChain: "Mainnet",
          signatureChainId: "0xa4b1",
          amount: "10.26",
          toPerp: false,
          nonce: 123,
        },
        typedData: {
          domain: {
            name: "HyperliquidSignTransaction",
            version: "1",
            chainId: 42161,
            verifyingContract: "0x0000000000000000000000000000000000000000",
          },
          types: {
            "HyperliquidTransaction:UsdClassTransfer": [
              { name: "hyperliquidChain", type: "string" },
              { name: "amount", type: "string" },
              { name: "toPerp", type: "bool" },
              { name: "nonce", type: "uint64" },
            ],
          },
          primaryType: "HyperliquidTransaction:UsdClassTransfer",
          message: { hyperliquidChain: "Mainnet", amount: "10.26", toPerp: false, nonce: 123 },
        },
        balance: {},
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const built = await buildPredictionUsdcTransfer({
      user: "0x0000000000000000000000000000000000000001",
      amount: "10.26",
    });
    expect(built.action).toMatchObject({ type: "usdClassTransfer", toPerp: false, amount: "10.26" });

    const sent = await sendPredictionUsdcTransfer({
      user: "0x0000000000000000000000000000000000000001",
      action: built.action,
      nonce: built.nonce,
      signature: { r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, v: 27 },
    });
    expect(sent.exchangeResult).toEqual({ status: "accepted", label: "Accepted" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps flag-off, restricted, and unknown users paper-only", () => {
    expect(getPredictionLiveAvailability({
      flagEnabled: false,
      eligibility: liveEligible,
      walletReady: true,
      authenticated: true,
      walletAddress: "0xabc",
    })).toMatchObject({ allowed: false, pathVisible: false });

    for (const state of ["restricted", "unknown"] as const) {
      expect(getPredictionLiveAvailability({
        flagEnabled: true,
        eligibility: { ...liveEligible, state },
        walletReady: true,
        authenticated: true,
        walletAddress: "0xabc",
      })).toMatchObject({ allowed: false, pathVisible: false });
    }
  });

  it("shows the live prediction path for eligible flag-on users", () => {
    expect(getPredictionLiveAvailability({
      flagEnabled: true,
      eligibility: liveEligible,
      walletReady: true,
      authenticated: true,
      walletAddress: "0xabc",
    })).toMatchObject({
      allowed: true,
      pathVisible: true,
      reason: "Live prediction trading is available for this eligible wallet.",
    });

    expect(getPredictionLiveAvailability({
      flagEnabled: true,
      eligibility: liveEligible,
      walletReady: true,
      authenticated: false,
    })).toMatchObject({ allowed: false, pathVisible: true });
  });

  it("enriches paper portfolio exposure with current probabilities", () => {
    const positions = enrichPredictionPaperPositions(paperAccountWithFill, baseQuestions[1]!, questionOdds);
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

  it("filters detail-page paper prediction exposure and fills by question", () => {
    expect(predictionPaperPositionsForQuestion(paperAccountWithFill, 1)).toHaveLength(1);
    expect(predictionPaperFillsForQuestion(paperAccountWithFill, 1)).toEqual([paperFill]);
    expect(predictionPaperPositionsForQuestion(paperAccountWithFill, 999)).toEqual([]);
    expect(predictionPaperFillsForQuestion(paperAccountWithFill, 999)).toEqual([]);
  });

  it("submits paper prediction orders only to the paper endpoint", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/prediction/paper-orders");
      expect(url).not.toContain("/exchange");
      return new Response(JSON.stringify({
        id: "prediction_paper_test_1",
        status: "accepted",
        mode: "paper",
        account: paperAccountWithFill,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await submitPredictionPaperOrder({
      questionId: 1,
      questionName: "World Cup Champion",
      outcome: 11,
      outcomeName: "France",
      side: 0,
      sideName: "Yes",
      contracts: 10,
      limitProbability: 0.2,
      currentProbability: 0.225,
      quoteToken: "USDC",
      criteriaAcknowledged: true,
    }, "prediction-paper-web-test");

    expect(result.account.positions).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
    const clientSource = readFileSync(join(process.cwd(), "components/agent-trade/PredictionsClient.tsx"), "utf8");
    expect(source).toContain("PredictionsClient");
    expect(source).toContain("AppShell");
    expect(clientSource).toContain("loadPredictionQuestions");
    expect(clientSource).toContain("loadPredictionDiscoveryOddsSummaries");
    expect(clientSource).toContain("Question cards remain available");
  });

  it("wires the detail route to the prediction detail client", () => {
    const source = readFileSync(join(process.cwd(), "app/predictions/[questionId]/page.tsx"), "utf8");
    const detailSource = readFileSync(join(process.cwd(), "components/agent-trade/PredictionDetailClient.tsx"), "utf8");
    expect(source).toContain("PredictionDetailClient");
    expect(source).toContain("questionId");
    expect(detailSource).toContain("Odds load progressively after the shell appears");
    expect(detailSource).toContain("loadPredictionQuestionOddsProgressive");
    expect(detailSource).toContain("Refresh odds");
  });

  it("keeps the World Cup detail route graceful when live data is unavailable", () => {
    const source = readFileSync(join(process.cwd(), "components/agent-trade/PredictionDetailClient.tsx"), "utf8");
    expect(source).toContain("Live prediction data unavailable");
    expect(source).toContain("Back to predictions");
    expect(source).toContain("HIP-4 min target");
    expect(source).toContain("getPredictionHip4EffectiveMinOrderCostUsd");
    expect(source).toContain("Live review is locked until");
    expect(source).toContain("Wire price");
  });

  it("keeps prediction paper helpers away from exchange submission", () => {
    const source = readFileSync(join(process.cwd(), "lib/agent-trade/predictions.ts"), "utf8");
    const paperHelperSource = source.slice(
      source.indexOf("export async function loadPredictionPaperAccount"),
      source.indexOf("export function predictionLiveExchangeEndpoint"),
    );
    expect(paperHelperSource).toContain("/prediction/paper-orders");
    expect(paperHelperSource).toContain("/prediction/paper-account");
    expect(paperHelperSource).not.toContain("/exchange");
  });

  it("shows prediction-specific paper exposure panels in detail and portfolio pages", () => {
    const detailSource = readFileSync(join(process.cwd(), "components/agent-trade/PredictionDetailClient.tsx"), "utf8");
    const portfolioSource = readFileSync(join(process.cwd(), "components/agent-trade/PortfolioClient.tsx"), "utf8");

    expect(detailSource).toContain("Paper prediction portfolio");
    expect(detailSource).toContain("Paper prediction fill");
    expect(portfolioSource).toContain("portfolio-prediction-paper-panel");
    expect(portfolioSource).toContain("shown separately from perp margin/exposure");
  });

  it("gates live prediction confirmation behind flag and readiness checks", () => {
    const source = readFileSync(join(process.cwd(), "components/agent-trade/PredictionDetailClient.tsx"), "utf8");
    expect(source).toContain("Live HIP-4 prediction trading is disabled");
    expect(source).toContain("Confirm live prediction order");
    expect(source).toContain("predictionLiveExchangeEndpoint");
    expect(source).toContain("Review live order");
    expect(source).toContain("Prediction market order, not a leveraged perp.");
    expect(source).toContain("Selected outcome odds are loading");
    expect(source).toContain("Live review requires a valid two-sided top of book");
    expect(source).toContain("hasValidPredictionTopOfBook");
    expect(source).toContain("Prediction markets use Hyperliquid spot-style balance; perp margin balance may not be spendable here.");
    expect(source).toContain("loadPredictionBalance");
    expect(source).toContain("hasSufficientPredictionSpotBalance");
    expect(source).toContain("Move USDC into Hyperliquid spot balance before signing");
    expect(source).toContain("Move USDC to predictions balance");
    expect(source).toContain("buildPredictionUsdcTransfer");
    expect(source).toContain("sendPredictionUsdcTransfer");
    expect(source).toContain("refreshPredictionBalanceForWallet");
    expect(source).toContain("await refreshPredictionBalanceForWallet(props.activeWallet.address)");
  });

  it("gates World Cup selected-book streaming to question 32 with diagnostics", () => {
    const source = readFileSync(join(process.cwd(), "components/agent-trade/PredictionDetailClient.tsx"), "utf8");
    expect(source).toContain("isPredictionWorldCupStreamEnabled(questionId)");
    expect(source).toContain("predictionL2BookSubscription(selectedCoin)");
    expect(source).toContain("__agentTradePredictionStream");
    expect(source).toContain("clearPredictionStreamOutcomeOdds");
    expect(source).not.toContain("WORLD_CUP_PRIORITY_OUTCOMES.map");
  });

  it("renders technical details in the live prediction confirmation", () => {
    const source = readFileSync(join(process.cwd(), "components/agent-trade/PredictionDetailClient.tsx"), "utf8");
    for (const label of [
      "Question",
      "Outcome",
      "Side",
      "Buy/sell",
      "Contracts",
      "Wire price",
      "Max cost",
      "Effective minimum",
      "HIP-4 spendable",
      "Asset id",
      "Coin",
      "Acknowledgement",
    ]) {
      expect(source).toContain(`label="${label}"`);
    }
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
