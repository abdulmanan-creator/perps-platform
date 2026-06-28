"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";

import type {
  PredictionLiveOrderRequest,
  PredictionBalanceState,
  PredictionOutcome,
  PredictionPaperAccount,
  PredictionPaperFill,
  PredictionPaperPosition,
  PredictionQuestion,
  PredictionQuestionOdds,
  PredictionSideOdds,
} from "@alchemy-hl/shared";

import {
  calculatePredictionTicketMath,
  buildPredictionAgentInput,
  buildPredictionUsdcTransfer,
  classifyPredictionLiveOrder,
  clearPredictionStreamOutcomeOdds,
  enrichPredictionPaperPositions,
  formatEmptyBook,
  formatProbability,
  formatProbabilityPrice,
  formatPredictionLivePriceWire,
  formatSpread,
  formatUsdc,
  formatUsdcExact,
  buildPredictionLiveOrderAction,
  getPredictionHip4EffectiveMinOrderCostUsd,
  getPredictionHip4MinOrderCostUsd,
  hasSufficientPredictionSpotBalance,
  hasValidPredictionTopOfBook,
  isPredictionBookStale,
  isPredictionLiveTradingEnabled,
  isPredictionWorldCupStreamEnabled,
  loadPredictionQuestion,
  loadPredictionOutcomeOdds,
  loadPredictionQuestionOddsProgressive,
  loadPredictionPaperAccount,
  loadPredictionBalance,
  marketablePredictionLimitFromAsk,
  mergePredictionL2BookUpdate,
  mergePredictionOutcomeOdds,
  minimumPredictionContractsForCost,
  maxTransferablePredictionUsdc,
  normalizePredictionL2BookMessage,
  predictionPaperFillsForQuestion,
  predictionHyperliquidWsUrl,
  predictionL2BookSubscription,
  predictionL2BookUnsubscribe,
  predictionStreamStatusLabel,
  predictionWorldCupStreamCoins,
  probabilityFromSide,
  predictionLiveExchangeEndpoint,
  predictionCategoryLabel,
  predictionStatusLabel,
  predictionUsdcTransferValidationMessage,
  selectedOutcomeOdds,
  sendPredictionUsdcTransfer,
  shouldShowPredictionUsdcTransferCard,
  suggestPredictionUsdcTransferAmount,
  isPredictionUsdcTransferAmountValid,
  submitPredictionPaperOrder,
  sortPredictionOutcomesForTerminal,
  summarizePredictionPortfolioExposure,
  summarizePredictionLiveExchangeResult,
  type PredictionStreamStatus,
} from "@/lib/agent-trade/predictions";
import { agentProviderDisplay } from "@/lib/agent-trade/agent-ux";
import { API_BASE_URL } from "@/lib/api";
import { DEFAULT_ELIGIBILITY_RESPONSE, normalizeEligibilityResponse } from "@/lib/agent-trade/eligibility";
import { hypurrscanAddressUrl } from "@/lib/agent-trade/hypurrscan";
import { DeterministicAgentService } from "@/lib/agent-trade/agent-service";
import { invalidAgentOutputRefusal, parseAgentAnalysis } from "@/lib/agent-trade/agent-validation";
import {
  normalizeHexSignature,
  withExplicitEip712Domain,
  type HyperliquidTypedData,
} from "@/lib/agent-trade/terminal";
import type { EligibilityResponse } from "@/lib/agent-trade/types";
import type { AgentAnalysis, AgentInput, AgentPredictionDraft } from "@/lib/agent-trade/agent-provider";

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

interface PredictionSideStreamState {
  coin?: string;
  status: PredictionStreamStatus;
  lastBookAt?: number;
}

interface PredictionTwoSideStreamState {
  yes: PredictionSideStreamState;
  no: PredictionSideStreamState;
}

const INITIAL_PREDICTION_STREAM_STATE: PredictionTwoSideStreamState = {
  yes: { status: "idle" },
  no: { status: "idle" },
};

export function PredictionDetailClient({ questionId }: { questionId: number }) {
  const [question, setQuestion] = useState<PredictionQuestion | undefined>();
  const [odds, setOdds] = useState<PredictionQuestionOdds | undefined>();
  const [paperAccount, setPaperAccount] = useState<PredictionPaperAccount | undefined>();
  const [selectedOutcomeId, setSelectedOutcomeId] = useState<number | undefined>();
  const [selectedSideIndex, setSelectedSideIndex] = useState<0 | 1>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [oddsStatus, setOddsStatus] = useState<"idle" | "loading" | "partial" | "ready" | "failed">("idle");
  const [oddsError, setOddsError] = useState<string | undefined>();
  const [oddsRefreshNonce, setOddsRefreshNonce] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [eligibility, setEligibility] = useState<EligibilityResponse>(DEFAULT_ELIGIBILITY_RESPONSE);
  const [predictionStreamState, setPredictionStreamState] =
    useState<PredictionTwoSideStreamState>(INITIAL_PREDICTION_STREAM_STATE);
  const previousStreamOutcomeRef = useRef<number | undefined>();
  const { ready: privyReady, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const activeWallet = wallets[0];

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      try {
        const nextQuestion = await loadPredictionQuestion(questionId);
        if (!cancelled) {
          setQuestion(nextQuestion);
          setOdds(undefined);
          setOddsStatus("idle");
          setOddsError(undefined);
          setSelectedOutcomeId(defaultPredictionOutcomeId(nextQuestion));
          setError(undefined);
        }
      } catch {
        if (!cancelled) {
          setQuestion(undefined);
          setOdds(undefined);
          setError("Prediction question is unavailable right now. Retry once the read API responds.");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [questionId]);

  useEffect(() => {
    let cancelled = false;
    async function loadPaperAccount() {
      const nextPaperAccount = await loadPredictionPaperAccount();
      if (!cancelled) setPaperAccount(nextPaperAccount);
    }
    void loadPaperAccount();
    return () => {
      cancelled = true;
    };
  }, [questionId]);

  useEffect(() => {
    if (!question) return;
    let cancelled = false;
    const activeQuestion = question;

    async function loadOdds() {
      setOddsStatus((current) => current === "partial" ? "partial" : "loading");
      setOddsError(undefined);
      try {
        const nextOdds = await loadPredictionQuestionOddsProgressive({
          question: activeQuestion,
          selectedOutcomeId,
          limit: activeQuestion.questionId === 32 ? 10 : 8,
          concurrency: 2,
          timeoutMs: 4_500,
          onOutcome: (outcomeOdds) => {
            if (cancelled) return;
            setOdds((current) => mergePredictionOutcomeOdds(current, activeQuestion, outcomeOdds));
            setOddsStatus("partial");
          },
        });
        if (!cancelled) {
          setOdds(nextOdds);
          setOddsStatus("ready");
          setOddsError(undefined);
        }
      } catch {
        if (!cancelled) {
          setOddsStatus((current) => current === "partial" ? "partial" : "failed");
          setOddsError("Odds timed out or were rate-limited. The market shell remains usable; refresh odds to retry.");
        }
      }
    }

    void loadOdds();
    return () => {
      cancelled = true;
    };
  }, [question, selectedOutcomeId, oddsRefreshNonce]);

  useEffect(() => {
    let cancelled = false;
    async function loadEligibility() {
      try {
        const res = await fetch(`${API_BASE_URL}/agent-trade/eligibility`, { cache: "no-store" });
        const next = await normalizeEligibilityResponse(res);
        if (!cancelled) setEligibility(next);
      } catch {
        if (!cancelled) setEligibility(DEFAULT_ELIGIBILITY_RESPONSE);
      }
    }
    void loadEligibility();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isPredictionWorldCupStreamEnabled(questionId) || !question || selectedOutcomeId === undefined) {
      setPredictionStreamState(INITIAL_PREDICTION_STREAM_STATE);
      return;
    }

    const streamCoins = predictionWorldCupStreamCoins(selectedOutcomeId);
    const sideByCoin = new Map<string, 0 | 1>([
      [streamCoins.yesCoin, 0],
      [streamCoins.noCoin, 1],
    ]);
    setPredictionStreamState({
      yes: { coin: streamCoins.yesCoin, status: "connecting" },
      no: { coin: streamCoins.noCoin, status: "connecting" },
    });
    setOdds((current) => {
      const previousOutcome = previousStreamOutcomeRef.current;
      previousStreamOutcomeRef.current = selectedOutcomeId;
      return previousOutcome !== undefined && previousOutcome !== selectedOutcomeId
        ? clearPredictionStreamOutcomeOdds(current, previousOutcome)
        : current;
    });

    if (typeof WebSocket === "undefined") {
      setPredictionStreamState({
        yes: { coin: streamCoins.yesCoin, status: "rest_fallback" },
        no: { coin: streamCoins.noCoin, status: "rest_fallback" },
      });
      return;
    }

    let closed = false;
    const socket = new WebSocket(predictionHyperliquidWsUrl());

    const sendJson = (payload: unknown) => {
      socket.send(JSON.stringify(payload));
    };

    socket.onopen = () => {
      if (closed) return;
      for (const coin of streamCoins.activeSubscriptions) {
        sendJson(predictionL2BookSubscription(coin));
      }
    };
    socket.onmessage = (event) => {
      if (closed) return;
      try {
        const update = normalizePredictionL2BookMessage({
          message: JSON.parse(String(event.data)),
          selectedCoins: streamCoins.activeSubscriptions,
        });
        if (!update) return;
        const sideIndex = sideByCoin.get(update.coin);
        if (sideIndex === undefined) return;
        setOdds((current) => mergePredictionL2BookUpdate({
          current,
          question,
          outcomeId: selectedOutcomeId,
          sideIndex,
          update,
        }));
        setPredictionStreamState((current) => ({
          ...current,
          [sideIndex === 0 ? "yes" : "no"]: {
            coin: update.coin,
            status: "live",
            lastBookAt: update.receivedAt,
          },
        }));
      } catch {
        setPredictionStreamState({
          yes: { coin: streamCoins.yesCoin, status: "rest_fallback" },
          no: { coin: streamCoins.noCoin, status: "rest_fallback" },
        });
      }
    };
    socket.onerror = () => {
      if (!closed) {
        setPredictionStreamState({
          yes: { coin: streamCoins.yesCoin, status: "rest_fallback" },
          no: { coin: streamCoins.noCoin, status: "rest_fallback" },
        });
      }
    };
    socket.onclose = () => {
      if (!closed) {
        setPredictionStreamState({
          yes: { coin: streamCoins.yesCoin, status: "disconnected" },
          no: { coin: streamCoins.noCoin, status: "disconnected" },
        });
      }
    };

    return () => {
      closed = true;
      if (socket.readyState === WebSocket.OPEN) {
        for (const coin of streamCoins.activeSubscriptions) {
          sendJson(predictionL2BookUnsubscribe(coin));
        }
      }
      socket.close();
    };
  }, [questionId, question, selectedOutcomeId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const target = window as typeof window & {
      __agentTradePredictionStream?: {
        questionId: number;
        selectedOutcome: number | null;
        yesCoin: string | null;
        noCoin: string | null;
        activeSubscriptions: string[];
        lastBookUpdate: number | null;
        streamStatus: {
          yes: PredictionStreamStatus;
          no: PredictionStreamStatus;
        };
      };
    };
    if (process.env.NODE_ENV === "production") {
      delete target.__agentTradePredictionStream;
      return;
    }
    const activeSubscriptions = [predictionStreamState.yes.coin, predictionStreamState.no.coin]
      .filter((coin): coin is string => Boolean(coin));
    target.__agentTradePredictionStream = {
      questionId,
      selectedOutcome: selectedOutcomeId ?? null,
      yesCoin: predictionStreamState.yes.coin ?? null,
      noCoin: predictionStreamState.no.coin ?? null,
      activeSubscriptions,
      lastBookUpdate: Math.max(predictionStreamState.yes.lastBookAt ?? 0, predictionStreamState.no.lastBookAt ?? 0) || null,
      streamStatus: {
        yes: predictionStreamState.yes.status,
        no: predictionStreamState.no.status,
      },
    };
    return () => {
      delete target.__agentTradePredictionStream;
    };
  }, [questionId, selectedOutcomeId, predictionStreamState]);

  const selectedOdds = selectedOutcomeId === undefined ? undefined : selectedOutcomeOdds(odds, selectedOutcomeId);
  const selectedSide = selectedOdds?.sides[selectedSideIndex];
  const oppositeSide = selectedOdds?.sides.find((side) => side.side !== selectedSideIndex);
  const selectedOutcome = useMemo<PredictionOutcome | undefined>(
    () => {
      if (!question) return undefined;
      return question.namedOutcomes.find((outcome) => outcome.outcome === selectedOutcomeId) ??
        (question.fallbackOutcome?.outcome === selectedOutcomeId ? question.fallbackOutcome ?? undefined : undefined);
    },
    [question, selectedOutcomeId],
  );
  const paperPositions = question ? enrichPredictionPaperPositions(paperAccount, question, odds) : [];
  const paperFills = question ? predictionPaperFillsForQuestion(paperAccount, question.questionId) : [];
  const selectedSideLoading = Boolean(question && selectedOutcomeId !== undefined && !selectedSide && oddsStatus !== "failed");
  const selectedSideStream = selectedSideIndex === 0 ? predictionStreamState.yes : predictionStreamState.no;
  const combinedStreamStatus = combinedPredictionStreamStatus(predictionStreamState);

  function refreshPaperAccount(nextAccount: PredictionPaperAccount) {
    setPaperAccount(nextAccount);
    void Promise.all([
      selectedOutcomeId !== undefined ? loadPredictionOutcomeOdds(selectedOutcomeId) : Promise.resolve(undefined),
      loadPredictionPaperAccount(),
    ]).then(([nextOutcomeOdds, refreshedAccount]) => {
      if (nextOutcomeOdds && question) {
        setOdds((current) => mergePredictionOutcomeOdds(current, question, nextOutcomeOdds));
      }
      if (refreshedAccount) {
        setPaperAccount(refreshedAccount);
      }
    }).catch(() => {
      setPaperAccount(nextAccount);
    });
  }

  if (error) {
    return (
      <main className="predictions-page">
        <section className="panel predictions-empty prediction-detail-unavailable">
          <strong>Live prediction data unavailable</strong>
          <span>
            {error} Question {questionId} may not be listed in the current Hyperliquid HIP-4 metadata.
          </span>
          <Link href="/predictions">Back to predictions</Link>
        </section>
      </main>
    );
  }

  if (isLoading || !question) {
    return (
      <main className="predictions-page">
        <section className="panel predictions-empty">
          <strong>Loading prediction question</strong>
          <span>Fetching read-only HIP-4 metadata. Odds load progressively after the shell appears.</span>
        </section>
      </main>
    );
  }

  return (
    <main className="predictions-page">
      <section className="prediction-detail-head">
        <div>
          <Link className="prediction-back-link" href="/predictions">Predictions</Link>
          <p className="at-kicker">{question.questionId === 32 ? "World Cup" : `Question ${question.questionId}`}</p>
          <h1>{question.name}</h1>
          <p>{question.criteria || question.description || "Resolution criteria unavailable from Hyperliquid metadata."}</p>
        </div>
        <div className="prediction-detail-health">
          <span className="state-pill live">{predictionStatusLabel(question)}</span>
          {isPredictionWorldCupStreamEnabled(question.questionId) ? (
            <span className="state-pill account-warning">{predictionStreamStatusLabel(combinedStreamStatus)}</span>
          ) : null}
          <span>{predictionCategoryLabel(question)}</span>
          <span>{(question.quoteToken ?? question.quoteTokens.join(", ")) || "Quote token pending"}</span>
        </div>
      </section>

      <section className="prediction-terminal-grid">
        <aside className="prediction-terminal-left">
          <OutcomeGrid
            question={question}
            odds={odds}
            oddsStatus={oddsStatus}
            oddsError={oddsError}
            selectedOutcomeId={selectedOutcomeId}
            selectedSideIndex={selectedSideIndex}
            streamState={predictionStreamState}
            onRefresh={() => {
              setOdds(undefined);
              setOddsStatus("idle");
              setOddsError(undefined);
              setOddsRefreshNonce((value) => value + 1);
            }}
            onSelect={(outcomeId, side) => {
              setSelectedOutcomeId(outcomeId);
              setSelectedSideIndex(side);
            }}
          />
          <OrderBookPreview
            outcome={selectedOutcome}
            side={selectedSide}
            stream={selectedSideStream}
            isLoading={selectedSideLoading}
            error={oddsError}
          />
        </aside>
        <div className="prediction-terminal-center">
          <ProbabilitySnapshot
            question={question}
            odds={odds}
            oddsStatus={oddsStatus}
            selectedOutcomeId={selectedOutcomeId}
            onSelect={(outcomeId) => {
              setSelectedOutcomeId(outcomeId);
              setSelectedSideIndex(0);
            }}
          />
          <PredictionPaperPortfolio positions={paperPositions} fills={paperFills} />
          <PredictionLiveActivityPanel />
          <div className="prediction-terminal-lower">
            <SettlementModule question={question} />
          </div>
        </div>
        <aside className="prediction-terminal-right">
          <PredictionPaperTicket
            question={question}
            selectedOutcomeId={selectedOutcomeId}
            selectedSideIndex={selectedSideIndex}
            selectedOutcome={selectedOutcome}
            selectedSide={selectedSide}
            oppositeSide={oppositeSide}
            selectedSideStream={selectedSideStream}
            hip4LiveFlagEnabled={isPredictionLiveTradingEnabled()}
            eligibility={eligibility}
            walletReady={privyReady}
            authenticated={authenticated}
            activeWallet={activeWallet}
            selectedSideLoading={selectedSideLoading}
            onLogin={login}
            onSelect={(outcomeId, side) => {
              setSelectedOutcomeId(outcomeId);
              setSelectedSideIndex(side);
            }}
            onPaperAccount={refreshPaperAccount}
          />
          <PredictionRiskCopy />
        </aside>
      </section>
    </main>
  );
}

export const PREDICTION_RISK_COPY = [
  "This is a binary event contract, not a leveraged perp.",
  "You can lose the full premium paid.",
  "Resolution depends on the listed criteria and source.",
  "Prices are market-implied probabilities, not guarantees.",
  "Liquidity may be thin; wide spreads can materially affect entry and exit.",
] as const;

function OutcomeGrid(props: {
  question: PredictionQuestion;
  odds: PredictionQuestionOdds | undefined;
  oddsStatus: "idle" | "loading" | "partial" | "ready" | "failed";
  oddsError?: string;
  selectedOutcomeId: number | undefined;
  selectedSideIndex: 0 | 1;
  streamState: PredictionTwoSideStreamState;
  onRefresh: () => void;
  onSelect: (outcome: number, side: 0 | 1) => void;
}) {
  const [query, setQuery] = useState("");
  const isLoadingOdds = props.oddsStatus === "loading" || props.oddsStatus === "partial";
  const rows = sortPredictionOutcomesForTerminal(props.question, props.odds)
    .filter((outcome) => outcome.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <section className="panel prediction-outcome-panel">
      <div className="panel-head">
        <div>
          <span>World Cup markets</span>
          <strong>{props.question.namedOutcomes.length} named outcomes</strong>
        </div>
        <button type="button" onClick={props.onRefresh}>
          {isLoadingOdds ? "Refreshing..." : "Refresh odds"}
        </button>
      </div>
      <label className="prediction-outcome-search">
        <span>Search team</span>
        <input
          type="search"
          placeholder="France, Brazil, USA..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {props.oddsError ? <p className="market-notice">{props.oddsError}</p> : null}
      {isLoadingOdds ? <p className="market-notice">Loading priority outcome books first. Other markets remain selectable.</p> : null}
      <div className="prediction-outcome-grid">
        {rows.map((outcome) => {
          const outcomeOdds = selectedOutcomeOdds(props.odds, outcome.outcome);
          return (
            <article key={outcome.outcome} className="prediction-outcome-card">
              <div>
                <span>Outcome {outcome.outcome}</span>
                <strong>{outcome.name}</strong>
              </div>
              <div className="prediction-side-grid">
                {outcome.sides.map((side, index) => {
                  const odds = outcomeOdds?.sides[index];
                  const active = props.selectedOutcomeId === outcome.outcome && props.selectedSideIndex === index;
                  const stream = props.selectedOutcomeId === outcome.outcome
                    ? (side.side === 0 ? props.streamState.yes : props.streamState.no)
                    : undefined;
                  return (
                    <button
                      key={side.side}
                      className={active ? "active" : ""}
                      onClick={() => props.onSelect(outcome.outcome, side.side)}
                    >
                      <span>{side.name}<i>{stream ? predictionStreamStatusLabel(stream.status) : "REST"}</i></span>
                      <strong>{formatProbability(odds?.midpointProbability)}</strong>
                      <em>{odds ? formatEmptyBook(odds) : "Loading odds"}</em>
                      <small>
                        Bid {formatProbabilityPrice(odds?.bestBid)} / Ask {formatProbabilityPrice(odds?.bestAsk)}
                      </small>
                      <small>Spread {formatSpread(odds?.spread)}</small>
                    </button>
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ProbabilitySnapshot(props: {
  question: PredictionQuestion;
  odds: PredictionQuestionOdds | undefined;
  oddsStatus: "idle" | "loading" | "partial" | "ready" | "failed";
  selectedOutcomeId: number | undefined;
  onSelect: (outcomeId: number) => void;
}) {
  const rows = props.question.namedOutcomes.slice(0, 8).map((outcome) => {
    const outcomeOdds = selectedOutcomeOdds(props.odds, outcome.outcome);
    const yesSide = outcomeOdds?.sides[0];
    const probability = probabilityFromSide(yesSide);
    const depth = yesSide ? yesSide.depth.bidSize + yesSide.depth.askSize : 0;
    return {
      outcome,
      probability,
      depth,
      emptyBook: yesSide?.emptyBook ?? true,
    };
  });
  const selected = rows.find((row) => row.outcome.outcome === props.selectedOutcomeId) ?? rows[0];
  const selectedProbability = selected?.probability ?? null;
  const chartWidth = probabilityBarWidth(selectedProbability);

  return (
    <section className="panel prediction-probability-panel">
      <div className="panel-head">
        <div>
          <span>Implied probability snapshot</span>
          <strong>{selected ? selected.outcome.name : "Select outcome"}</strong>
        </div>
        <span className="state-pill account-warning">
          {props.oddsStatus === "loading" ? "Loading books" : props.oddsStatus === "partial" ? "Partial books" : "Read-only live books"}
        </span>
      </div>
      <div className="prediction-probability-stage">
        <div className="prediction-chart-head">
          <span>0%</span>
          <strong>{formatProbability(selectedProbability)}</strong>
          <span>100%</span>
        </div>
        <div className="prediction-chart-surface" aria-label="Current implied probability visualization">
          <i style={{ width: `${chartWidth}%` }} />
          <b style={{ left: `${chartWidth}%` }} />
        </div>
        <div className="prediction-chart-scale">
          <span>Low probability</span>
          <span>Market-implied, not guaranteed</span>
          <span>High probability</span>
        </div>
      </div>
      <div className="prediction-probability-list">
        {rows.map((row) => (
          <button
            key={row.outcome.outcome}
            className={props.selectedOutcomeId === row.outcome.outcome ? "active" : ""}
            onClick={() => props.onSelect(row.outcome.outcome)}
          >
            <span>{row.outcome.name}</span>
            <em>{row.emptyBook ? "Empty book" : formatProbability(row.probability)}</em>
            <strong style={{ width: `${probabilityBarWidth(row.probability)}%` }} />
            <small>{row.depth > 0 ? `${Math.round(row.depth).toLocaleString()} contracts depth` : "No visible depth"}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function OrderBookPreview({
  outcome,
  side,
  stream,
  isLoading,
  error,
}: {
  outcome: PredictionOutcome | undefined;
  side: PredictionSideOdds | undefined;
  stream: PredictionSideStreamState;
  isLoading: boolean;
  error?: string;
}) {
  const lastUpdate = formatBookUpdateAge(stream.lastBookAt);
  return (
    <section className="panel prediction-book-panel">
      <div className="panel-head">
        <div>
          <span>Selected book</span>
          <strong>{outcome && side ? `${outcome.name} / ${side.name}` : "Select outcome"}</strong>
        </div>
        <span className="state-pill account-warning">{predictionStreamStatusLabel(stream.status)}</span>
      </div>
      {error ? <p className="market-notice">{error}</p> : null}
      {isLoading ? <p className="market-notice">Selected outcome book is loading. Live submit stays disabled until bid and ask are available.</p> : null}
      {side ? (
        <div className="prediction-book-body">
          <div className="prediction-probability-rail" aria-label="Probability rail">
            <span>0</span>
            <div>
              <em style={{ left: `${Math.min(100, Math.max(0, (side.midpointProbability ?? 0) * 100))}%` }} />
            </div>
            <span>1</span>
          </div>
          <div className="prediction-book-levels">
            <div>
              <span>Best bid</span>
              <strong>{formatProbabilityPrice(side.bestBid)}</strong>
            </div>
            <div>
              <span>Best ask</span>
              <strong>{formatProbabilityPrice(side.bestAsk)}</strong>
            </div>
            <div>
              <span>Midpoint</span>
              <strong>{formatProbability(side.midpointProbability)}</strong>
            </div>
            <div>
              <span>Spread</span>
              <strong>{formatSpread(side.spread)}</strong>
            </div>
          </div>
          <div className="prediction-depth-readout">
            <span>{side.depth.bidLevels} bid levels / {Math.round(side.depth.bidSize)} contracts</span>
            <span>{side.depth.askLevels} ask levels / {Math.round(side.depth.askSize)} contracts</span>
            <span>Last update {lastUpdate}</span>
          </div>
          <div className="prediction-book-ladder">
            <div>
              <span>Bid px</span>
              <span>Bid size</span>
              {(side.topBidLevels ?? []).slice(0, 5).map((level) => (
                <div key={`bid-${level.px}-${level.sz}`}>
                  <strong>{formatProbabilityPrice(level.px)}</strong>
                  <em>{formatContractSize(level.sz)}</em>
                </div>
              ))}
            </div>
            <div>
              <span>Ask px</span>
              <span>Ask size</span>
              {(side.topAskLevels ?? []).slice(0, 5).map((level) => (
                <div key={`ask-${level.px}-${level.sz}`}>
                  <strong>{formatProbabilityPrice(level.px)}</strong>
                  <em>{formatContractSize(level.sz)}</em>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <p className="prediction-panel-copy">Select an outcome side to inspect top-of-book probability data.</p>
      )}
    </section>
  );
}

function SettlementModule({ question }: { question: PredictionQuestion }) {
  const settled = new Set(question.settlement.settledNamedOutcomeIds);
  return (
    <section className="panel prediction-settlement-panel">
      <div className="panel-head">
        <div>
          <span>Settlement</span>
          <strong>{predictionStatusLabel(question)}</strong>
        </div>
      </div>
      <div className="prediction-settlement-body">
        <div>
          <span>Fallback outcome</span>
          <strong>{question.fallbackOutcome ? question.fallbackOutcome.name : "None listed"}</strong>
          <em>{question.fallbackOutcome ? `Outcome ${question.fallbackOutcome.outcome}` : "No fallback in metadata"}</em>
        </div>
        <div>
          <span>Named outcomes</span>
          <strong>{question.namedOutcomes.length}</strong>
          <em>{question.settlement.settledNamedOutcomeIds.length} settled</em>
        </div>
        <div>
          <span>Resolution state</span>
          <strong>{question.settlement.state === "open" ? "Unresolved" : predictionStatusLabel(question)}</strong>
          <em>Resolution depends on the listed criteria and source.</em>
        </div>
      </div>
      <div className="prediction-settlement-list">
        {question.namedOutcomes.slice(0, 12).map((outcome) => (
          <span key={outcome.outcome} className={settled.has(outcome.outcome) ? "settled" : ""}>
            {outcome.name}
          </span>
        ))}
      </div>
    </section>
  );
}

function PredictionPaperTicket(props: {
  question: PredictionQuestion;
  selectedOutcomeId: number | undefined;
  selectedSideIndex: 0 | 1;
  selectedOutcome: PredictionOutcome | undefined;
  selectedSide: PredictionSideOdds | undefined;
  oppositeSide: PredictionSideOdds | undefined;
  selectedSideStream: PredictionSideStreamState;
  hip4LiveFlagEnabled: boolean;
  eligibility: EligibilityResponse;
  walletReady: boolean;
  authenticated: boolean;
  activeWallet?: ConnectedWallet;
  selectedSideLoading: boolean;
  onLogin: () => void;
  onSelect: (outcomeId: number, side: 0 | 1) => void;
  onPaperAccount: (account: PredictionPaperAccount) => void;
}) {
  const initialProbability = probabilityFromSide(props.selectedSide) ?? 0.5;
  const liveAvailable = getPredictionLiveAvailability({
    flagEnabled: props.hip4LiveFlagEnabled,
    eligibility: props.eligibility,
    walletReady: props.walletReady,
    authenticated: props.authenticated,
    walletAddress: props.activeWallet?.address,
  });
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [tif, setTif] = useState<"Ioc" | "Gtc">("Ioc");
  const [contracts, setContracts] = useState(10);
  const [limitProbability, setLimitProbability] = useState(initialProbability);
  const [criteriaAcknowledged, setCriteriaAcknowledged] = useState(false);
  const [submitState, setSubmitState] = useState<"idle" | "submitting" | "accepted" | "failed">("idle");
  const [liveConfirmOpen, setLiveConfirmOpen] = useState(false);
  const [liveState, setLiveState] = useState<
    "idle" | "building" | "signing" | "submitting" | "accepted" | "rejected" | "failed"
  >("idle");
  const [liveMessage, setLiveMessage] = useState<string | undefined>();
  const [liveProofUrl, setLiveProofUrl] = useState<string | null>(null);
  const [predictionBalance, setPredictionBalance] = useState<PredictionBalanceState | undefined>();
  const [predictionBalanceStatus, setPredictionBalanceStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [predictionBalanceError, setPredictionBalanceError] = useState<string | undefined>();
  const [transferAmount, setTransferAmount] = useState("");
  const [transferState, setTransferState] = useState<
    "idle" | "building" | "signing" | "submitting" | "accepted" | "rejected" | "failed"
  >("idle");
  const [transferMessage, setTransferMessage] = useState<string | undefined>();
  const [agentAnalysis, setAgentAnalysis] = useState<AgentAnalysis | undefined>();
  const [agentQuestion, setAgentQuestion] = useState<string | undefined>();
  const [agentThinking, setAgentThinking] = useState(false);
  const [agentDraftApplied, setAgentDraftApplied] = useState(false);

  useEffect(() => {
    if (!liveAvailable.pathVisible && mode === "live") setMode("paper");
  }, [liveAvailable.pathVisible, mode]);

  useEffect(() => {
    setLimitProbability(probabilityFromSide(props.selectedSide) ?? 0.5);
    setAgentDraftApplied(false);
  }, [props.selectedSide?.coin]);

  async function refreshPredictionBalanceForWallet(wallet: string, cancelled?: () => boolean) {
    setPredictionBalanceStatus("loading");
    setPredictionBalanceError(undefined);
    try {
      const balance = await loadPredictionBalance(wallet);
      if (cancelled?.()) return;
      setPredictionBalance(balance);
      setPredictionBalanceStatus("ready");
    } catch {
      if (cancelled?.()) return;
      setPredictionBalance(undefined);
      setPredictionBalanceStatus("failed");
      setPredictionBalanceError("Could not verify Hyperliquid spot-style prediction balance. Retry before signing live HIP-4 orders.");
    }
  }

  useEffect(() => {
    let cancelled = false;
    const wallet = props.activeWallet?.address;
    if (!liveAvailable.pathVisible || !wallet) {
      setPredictionBalance(undefined);
      setPredictionBalanceStatus("idle");
      setPredictionBalanceError(undefined);
      return;
    }
    void refreshPredictionBalanceForWallet(wallet, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [liveAvailable.pathVisible, props.activeWallet?.address]);

  const math = calculatePredictionTicketMath(contracts, limitProbability);
  const hip4MinOrderCostUsd = getPredictionHip4MinOrderCostUsd();
  const hip4EffectiveMinOrderCostUsd = getPredictionHip4EffectiveMinOrderCostUsd(undefined, hip4MinOrderCostUsd);
  const minimumLiveContracts = minimumPredictionContractsForCost(limitProbability, hip4EffectiveMinOrderCostUsd);
  const minimumLiveCost = calculatePredictionTicketMath(minimumLiveContracts, limitProbability).estimatedCost;
  const liveWirePrice = formatPredictionLivePriceWire(math.probability);
  const quoteToken = props.selectedOutcome?.quoteToken ?? props.question.quoteToken ?? props.question.quoteTokens[0] ?? "USDC";
  const liquidityWarning = paperLiquidityWarning(props.selectedSide);
  const selectedTechnical = props.selectedOutcome?.sides[props.selectedSideIndex];
  const canSubmit = Boolean(props.selectedOutcome && props.selectedSide && criteriaAcknowledged && math.contracts > 0);
  const selectedTopOfBookReady = hasValidPredictionTopOfBook(props.selectedSide);
  const selectedBookStale = isPredictionWorldCupStreamEnabled(props.question.questionId)
    ? props.selectedSideStream.status !== "live" || isPredictionBookStale(props.selectedSideStream.lastBookAt)
    : false;
  const orderClassification = classifyPredictionLiveOrder({
    mode,
    tif,
    limitProbability: math.probability,
    selectedSide: props.selectedSide,
    isBookStale: selectedBookStale,
  });
  const liveBookAllowsReview = mode !== "live" || orderClassification.kind !== "unavailable";
  const liveRequiredCostUsd = mode === "live" ? Math.max(math.estimatedCost, hip4EffectiveMinOrderCostUsd) : math.estimatedCost;
  const predictionBalanceSufficient = hasSufficientPredictionSpotBalance(predictionBalance, liveRequiredCostUsd);
  const maxTransferableUsdc = maxTransferablePredictionUsdc(predictionBalance);
  const transferSuggestion = suggestPredictionUsdcTransferAmount({
    requiredCostUsd: liveRequiredCostUsd,
    spotUsdcAvailable: predictionBalance?.spotUsdcAvailable ?? "0",
    maxTransferableUsdc,
  });
  const showTransferCard = shouldShowPredictionUsdcTransferCard({
    mode,
    liveAllowed: liveAvailable.allowed,
    balance: predictionBalance,
    requiredCostUsd: liveRequiredCostUsd,
  });
  const transferAmountToSubmit = transferAmount || transferSuggestion;
  const transferAmountValid = isPredictionUsdcTransferAmountValid({
    amount: transferAmountToSubmit,
    maxTransferableUsdc,
  });
  const transferValidationMessage = predictionUsdcTransferValidationMessage({
    amount: transferAmountToSubmit,
    maxTransferableUsdc,
  });
  const canSubmitLive =
    canSubmit &&
    liveAvailable.allowed &&
    Boolean(selectedTechnical) &&
    selectedTopOfBookReady &&
    liveBookAllowsReview &&
    math.estimatedCost >= hip4EffectiveMinOrderCostUsd &&
    predictionBalanceStatus === "ready" &&
    predictionBalanceSufficient;
  const liveDisabledReasons = liveReviewDisabledReasons({
    mode,
    walletConnected: Boolean(props.activeWallet?.address),
    liveAvailable,
    selectedSideLoading: props.selectedSideLoading,
    selectedTechnical: Boolean(selectedTechnical),
    selectedTopOfBookReady,
    selectedBookStale,
    orderClassificationReason: orderClassification.reason,
    criteriaAcknowledged,
    contracts: math.contracts,
    estimatedCost: math.estimatedCost,
    effectiveMinCost: hip4EffectiveMinOrderCostUsd,
    predictionBalanceStatus,
    predictionBalanceSufficient,
  });

  useEffect(() => {
    if (showTransferCard && !transferAmount && transferSuggestion) {
      setTransferAmount(transferSuggestion);
    }
  }, [showTransferCard, transferAmount, transferSuggestion]);

  async function submitPaperOrder() {
    if (!props.selectedOutcome || !props.selectedSide || !canSubmit) return;
    setSubmitState("submitting");
    try {
      const result = await submitPredictionPaperOrder({
        questionId: props.question.questionId,
        questionName: props.question.name,
        outcome: props.selectedOutcome.outcome,
        outcomeName: props.selectedOutcome.name,
        side: props.selectedSide.side,
        sideName: props.selectedSide.name,
        contracts: math.contracts,
        limitProbability: math.probability,
        currentProbability: probabilityFromSide(props.selectedSide),
        quoteToken,
        criteriaAcknowledged,
        fromAgent: agentDraftApplied,
      });
      props.onPaperAccount(result.account);
      setSubmitState("accepted");
    } catch {
      setSubmitState("failed");
    }
  }

  async function submitLiveOrder() {
    if (!props.selectedOutcome || !props.selectedSide || !selectedTechnical || !props.activeWallet?.address || !canSubmitLive) return;
    setLiveState("building");
    setLiveMessage(undefined);
    setLiveProofUrl(null);
    try {
      const provider = await props.activeWallet.getEthereumProvider() as Eip1193Provider;
      const prediction: PredictionLiveOrderRequest = {
        questionId: props.question.questionId,
        outcome: props.selectedOutcome.outcome,
        side: props.selectedSide.side,
        action: "buy",
        contracts: math.contracts,
        limitProbability: math.probability,
        tif,
        criteriaAcknowledged,
        liveAcknowledged: true,
      };
      const action = buildPredictionLiveOrderAction({ order: prediction, assetId: selectedTechnical.assetId });
      const headers = {
        "content-type": "application/json",
        "x-agent-trade-risk-accepted": "true",
        "x-agent-trade-terms-accepted": "true",
      };
      const buildRes = await fetch(predictionLiveExchangeEndpoint(), {
        method: "POST",
        headers,
        body: JSON.stringify({ user: props.activeWallet.address, prediction, action }),
      });
      if (!buildRes.ok) {
        throw new Error(predictionLiveOrderErrorMessage(await readPredictionLiveError(buildRes, "Prediction exchange build failed")));
      }
      const built = (await buildRes.json()) as { typedData?: HyperliquidTypedData; nonce: number; action: unknown };
      if (!built.typedData) throw new Error("Prediction exchange build did not return typed data for wallet signing.");

      setLiveState("signing");
      const rawSignature = await provider.request({
        method: "eth_signTypedData_v4",
        params: [props.activeWallet.address, JSON.stringify(withExplicitEip712Domain(built.typedData))],
      });
      if (typeof rawSignature !== "string") throw new Error("Wallet returned an invalid signature.");

      setLiveState("submitting");
      const signature = normalizeHexSignature(rawSignature as `0x${string}`);
      const sendRes = await fetch(predictionLiveExchangeEndpoint(), {
        method: "POST",
        headers,
        body: JSON.stringify({ prediction, action: built.action, nonce: built.nonce, signature }),
      });
      if (!sendRes.ok) {
        throw new Error(predictionLiveOrderErrorMessage(await readPredictionLiveError(sendRes, "Prediction exchange send failed")));
      }
      const sent = await readJsonOrEmpty(sendRes);
      const result = summarizePredictionLiveExchangeResult(sent);
      setLiveState(result.status === "rejected" ? "rejected" : "accepted");
      setLiveMessage(result.reason ? `${result.label}: ${result.reason}` : `${result.label}. Hyperliquid response captured.`);
      setLiveProofUrl(hypurrscanAddressUrl(props.activeWallet.address));
      setLiveConfirmOpen(false);
    } catch (err) {
      setLiveState("failed");
      setLiveMessage(err instanceof Error ? err.message : "Live prediction order failed.");
    }
  }

  async function submitPredictionBalanceTransfer() {
    if (!props.activeWallet?.address || !showTransferCard || !transferAmountValid) return;
    const amount = transferAmountToSubmit;
    setTransferState("building");
    setTransferMessage(undefined);
    try {
      const provider = await props.activeWallet.getEthereumProvider() as Eip1193Provider;
      const built = await buildPredictionUsdcTransfer({
        user: props.activeWallet.address,
        amount,
      });
      if (!built.typedData) throw new Error("Prediction balance transfer did not return typed data for wallet signing.");

      setTransferState("signing");
      const rawSignature = await provider.request({
        method: "eth_signTypedData_v4",
        params: [props.activeWallet.address, JSON.stringify(withExplicitEip712Domain(built.typedData))],
      });
      if (typeof rawSignature !== "string") throw new Error("Wallet returned an invalid signature.");

      setTransferState("submitting");
      const signature = normalizeHexSignature(rawSignature as `0x${string}`);
      const sent = await sendPredictionUsdcTransfer({
        user: props.activeWallet.address,
        action: built.action,
        nonce: built.nonce,
        signature,
      });
      const rejected = sent.exchangeResult.status === "rejected";
      setTransferState(rejected ? "rejected" : "accepted");
      setTransferMessage(
        rejected
          ? `Transfer rejected: ${sent.exchangeResult.reason ?? "Hyperliquid rejected the transfer."}`
          : "USDC transfer submitted. Refreshing prediction balance.",
      );
      await refreshPredictionBalanceForWallet(props.activeWallet.address);
    } catch (err) {
      setTransferState("failed");
      setTransferMessage(err instanceof Error ? err.message : "Prediction balance transfer failed.");
    }
  }

  async function runPredictionAgent(prompt: string) {
    if (!props.selectedOutcome || !props.selectedSide || agentThinking) return;
    setAgentQuestion(prompt);
    setAgentThinking(true);
    try {
      const input = buildPredictionAgentInput({
        prompt,
        question: props.question,
        selectedOutcome: props.selectedOutcome,
        selectedSide: props.selectedSide,
        oppositeSide: props.oppositeSide,
        streamStatus: props.selectedSideStream.status,
        streamLastBookAt: props.selectedSideStream.lastBookAt,
        streamFreshnessLabel: formatBookUpdateAge(props.selectedSideStream.lastBookAt),
        mode,
        eligibilityState: props.eligibility.state,
        liveAllowed: liveAvailable.allowed,
        hip4Spendable: predictionBalance?.spotUsdcAvailable,
        perpWithdrawable: predictionBalance?.perpWithdrawable ?? maxTransferableUsdc ?? undefined,
        balanceStatus: predictionBalanceStatus,
        ticket: {
          contracts,
          limitProbability,
          tif,
          criteriaAcknowledged,
        },
      });
      setAgentAnalysis(await requestPredictionAgentAnalysis(input));
    } finally {
      setAgentThinking(false);
    }
  }

  function applyPredictionDraftToTicket(draft: AgentPredictionDraft) {
    props.onSelect(draft.outcome, draft.side);
    setContracts(draft.contracts);
    setLimitProbability(draft.limitProbability);
    setTif(draft.tif);
    if (draft.paperOnly) {
      setMode("paper");
    }
    setAgentDraftApplied(true);
  }

  function markManualTicketEdit() {
    setAgentDraftApplied(false);
  }

  return (
    <>
      <PredictionAgentPanel
        analysis={agentAnalysis}
        agentQuestion={agentQuestion}
        isThinking={agentThinking}
        mode={mode}
        liveAllowed={liveAvailable.allowed}
        selectedOutcome={props.selectedOutcome}
        selectedSide={props.selectedSide}
        onPrompt={runPredictionAgent}
        onApplyDraft={applyPredictionDraftToTicket}
      />
      <section className="panel prediction-ticket-preview" data-testid="prediction-ticket-preview">
        <div className="panel-head">
          <div>
            <span>Prediction ticket</span>
            <strong>{mode === "live" ? "Live Hyperliquid" : "Paper only"}</strong>
          </div>
          {agentDraftApplied ? <span className="from-agent-badge">From Agent</span> : null}
        </div>
        <div className="prediction-ticket-form">
        <div className="prediction-ticket-side-picker">
          <span>Mode</span>
          <div>
            <button className={mode === "paper" ? "active" : ""} onClick={() => { setMode("paper"); markManualTicketEdit(); }}>Paper</button>
            {liveAvailable.pathVisible ? (
              <button
                className={mode === "live" ? "active" : ""}
                onClick={() => { setMode("live"); markManualTicketEdit(); }}
              >
                Live
              </button>
            ) : null}
          </div>
        </div>
        {!liveAvailable.allowed ? <p className="market-notice">{liveAvailable.reason}</p> : null}
        <label>
          <span>Outcome</span>
          <select
            value={props.selectedOutcomeId ?? ""}
            onChange={(event) => {
              props.onSelect(Number(event.target.value), props.selectedSideIndex);
              markManualTicketEdit();
            }}
          >
            {props.question.namedOutcomes.map((outcome) => (
              <option key={outcome.outcome} value={outcome.outcome}>{outcome.name}</option>
            ))}
          </select>
        </label>
        <div className="prediction-ticket-side-picker">
          <span>Yes/No side</span>
          <div>
            {props.selectedOutcome?.sides.map((side) => (
              <button
                key={side.side}
                className={props.selectedSideIndex === side.side ? "active" : ""}
                onClick={() => {
                  if (props.selectedOutcome) {
                    props.onSelect(props.selectedOutcome.outcome, side.side);
                    markManualTicketEdit();
                  }
                }}
              >
                {side.name}
              </button>
            ))}
          </div>
        </div>
        <label>
          <span>Time in force</span>
          <select
            value={tif}
            onChange={(event) => {
              setTif(event.target.value === "Gtc" ? "Gtc" : "Ioc");
              markManualTicketEdit();
            }}
          >
            <option value="Ioc">IOC</option>
            <option value="Gtc">GTC</option>
          </select>
        </label>
        <label>
          <span>{mode === "live" ? "Buy live contracts" : "Buy paper contracts"}</span>
          <input
            min="1"
            step="1"
            type="number"
            value={contracts}
            onChange={(event) => {
              setContracts(Number(event.target.value));
              markManualTicketEdit();
            }}
          />
        </label>
        <label>
          <span>Limit probability</span>
          <input
            min="0"
            max="1"
            step="0.001"
            type="number"
            value={limitProbability}
            onChange={(event) => {
              setLimitProbability(Number(event.target.value));
              markManualTicketEdit();
            }}
          />
        </label>
        {mode === "live" ? (
          <div className="prediction-ticket-book-actions">
            <button
              type="button"
              disabled={!props.selectedSide?.bestAsk}
              onClick={() => {
                if (props.selectedSide?.bestAsk) {
                  setLimitProbability(Number(props.selectedSide.bestAsk));
                  markManualTicketEdit();
                }
              }}
            >
              Use best ask
            </button>
            <button
              type="button"
              disabled={!props.selectedSide?.bestAsk}
              onClick={() => {
                const marketable = marketablePredictionLimitFromAsk(props.selectedSide?.bestAsk);
                if (marketable !== null) {
                  setTif("Ioc");
                  setLimitProbability(marketable);
                  markManualTicketEdit();
                }
              }}
            >
              Marketable IOC
            </button>
          </div>
        ) : null}
        <div className="prediction-ticket-body">
          <MetricCell label={mode === "live" ? "Max cost" : "Estimated cost"} value={formatUsdc(math.estimatedCost)} />
          <MetricCell label="Max payout" value={formatUsdc(math.maxPayout)} />
          <MetricCell label="Max profit" value={formatUsdc(math.maxProfit)} />
          <MetricCell label="Max loss" value={formatUsdc(math.maxLoss)} />
          <MetricCell label="Break-even probability" value={formatProbability(math.breakEvenProbability)} />
          <MetricCell label="Current probability" value={formatProbability(probabilityFromSide(props.selectedSide))} />
        </div>
        {mode === "live" && selectedTechnical ? (
          <div className="prediction-ticket-body prediction-ticket-technical">
            <MetricCell label="Asset id" value={String(selectedTechnical.assetId)} />
            <MetricCell label="Coin" value={selectedTechnical.coin} />
            <MetricCell label="HIP-4 min target" value={formatUsdc(hip4EffectiveMinOrderCostUsd)} />
            <MetricCell label="Best ask" value={formatProbabilityPrice(props.selectedSide?.bestAsk)} />
            <MetricCell label="Order type" value={orderClassification.label} />
            <MetricCell label="Book updated" value={formatBookUpdateAge(props.selectedSideStream.lastBookAt)} />
          </div>
        ) : null}
        {mode === "live" ? (
          <div className="prediction-balance-diagnostic">
            <div className="prediction-ticket-body prediction-ticket-technical">
              <MetricCell
                label="HIP-4 spendable"
                value={predictionBalanceStatus === "ready" ? formatUsdcExact(predictionBalance?.spotUsdcAvailable) : "--"}
              />
              <MetricCell
                label="Perp withdrawable"
                value={predictionBalanceStatus === "ready" ? formatUsdcExact(maxTransferableUsdc) : "--"}
              />
            </div>
            <p className="market-notice">
              Prediction markets use Hyperliquid spot-style balance; perp margin balance may not be spendable here.
            </p>
            {predictionBalanceStatus === "loading" ? (
              <p className="market-notice">Checking HIP-4 spendable balance before live signing.</p>
            ) : null}
            {predictionBalanceStatus === "failed" ? (
              <p className="market-notice">{predictionBalanceError}</p>
            ) : null}
            {showTransferCard ? (
              <div className="prediction-transfer-card">
                <div className="panel-head">
                  <div>
                    <span>Prediction balance</span>
                    <strong>Move USDC to predictions balance</strong>
                  </div>
                </div>
                <p className="market-notice">
                  Prediction markets use Hyperliquid spot-style USDC. This moves USDC from perp margin to prediction balance.
                </p>
                <div className="prediction-ticket-body prediction-ticket-technical">
                  <MetricCell label="HIP-4 spendable" value={formatUsdcExact(predictionBalance?.spotUsdcAvailable)} />
                  <MetricCell label="Available transfer" value={formatUsdcExact(maxTransferableUsdc)} />
                  <MetricCell label="Suggested transfer" value={formatUsdcExact(transferSuggestion)} />
                </div>
                <label>
                  <span>Transfer amount</span>
                  <div className="prediction-transfer-input-row">
                    <input
                      min="0"
                      max={maxTransferableUsdc ?? undefined}
                      step="0.000001"
                      type="number"
                      value={transferAmount}
                      onChange={(event) => setTransferAmount(event.target.value)}
                    />
                    <button
                      type="button"
                      disabled={!maxTransferableUsdc}
                      onClick={() => setTransferAmount(maxTransferableUsdc ?? "")}
                    >
                      Max
                    </button>
                  </div>
                </label>
                {transferValidationMessage ? (
                  <p className="market-notice">{transferValidationMessage}</p>
                ) : null}
                <button
                  type="button"
                  disabled={transferState === "building" || transferState === "signing" || transferState === "submitting" || !transferAmountValid}
                  onClick={submitPredictionBalanceTransfer}
                >
                  {transferState === "building" || transferState === "signing" || transferState === "submitting"
                    ? "Moving USDC..."
                    : "Move USDC to predictions balance"}
                </button>
                {transferMessage ? (
                  <p className={transferState === "failed" || transferState === "rejected" ? "prediction-ticket-status error" : "prediction-ticket-status"}>
                    {transferMessage}
                  </p>
                ) : null}
              </div>
            ) : null}
            {predictionBalanceStatus === "ready" && !predictionBalanceSufficient ? (
              <p className="market-notice">
                Move USDC into Hyperliquid spot balance before signing. Use the prediction balance move flow here or Hyperliquid Portfolio transfer from Perps to Spot, then retry.
              </p>
            ) : null}
          </div>
        ) : null}
        <p className="market-notice">{liquidityWarning}</p>
        {mode === "live" && props.selectedSideLoading ? (
          <p className="market-notice">Selected outcome odds are loading. Live review unlocks after bid and ask are available.</p>
        ) : null}
        {mode === "live" && props.selectedSide && !selectedTopOfBookReady ? (
          <p className="market-notice">Live review requires a valid two-sided top of book for the selected outcome side.</p>
        ) : null}
        {mode === "live" && orderClassification.reason ? (
          <p className="market-notice">{orderClassification.reason}</p>
        ) : null}
        {mode === "live" && math.estimatedCost < hip4EffectiveMinOrderCostUsd ? (
          <div className="market-notice prediction-min-order-notice">
            <span>
              Live HIP-4 cost must target at least {formatUsdc(hip4EffectiveMinOrderCostUsd)} so Hyperliquid&apos;s 10 USDC minimum clears venue-side checks.
            </span>
            {minimumLiveContracts > math.contracts ? (
              <button type="button" onClick={() => setContracts(minimumLiveContracts)}>
                Use {minimumLiveContracts} contracts ({formatUsdc(minimumLiveCost)})
              </button>
            ) : null}
          </div>
        ) : null}
        <label className="prediction-ack-row">
          <input
            type="checkbox"
            checked={criteriaAcknowledged}
            onChange={(event) => setCriteriaAcknowledged(event.target.checked)}
          />
          <span>I acknowledge this {mode} order resolves only under the listed criteria.</span>
        </label>
        {mode === "paper" ? (
          <button disabled={!canSubmit || submitState === "submitting"} onClick={submitPaperOrder}>
            {submitState === "submitting" ? "Recording paper order..." : "Submit paper order"}
          </button>
        ) : (
          <button disabled={!canSubmitLive || liveState === "building" || liveState === "signing" || liveState === "submitting"} onClick={() => setLiveConfirmOpen(true)}>
            {liveState === "building" || liveState === "signing" || liveState === "submitting" ? "Submitting live order..." : "Review live order"}
          </button>
        )}
        {mode === "live" && !canSubmitLive && liveState !== "building" && liveState !== "signing" && liveState !== "submitting" ? (
          <div className="market-notice prediction-live-disabled-reasons">
            <span>Live review is locked until:</span>
            <ul>
              {liveDisabledReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {liveAvailable.pathVisible && !props.authenticated && props.walletReady ? (
          <button type="button" onClick={props.onLogin}>Connect wallet for live</button>
        ) : null}
        {submitState === "accepted" ? <p className="prediction-ticket-status">Paper order recorded.</p> : null}
        {submitState === "failed" ? <p className="prediction-ticket-status error">Paper order failed. Retry after the API responds.</p> : null}
        {liveMessage ? (
          <p className={liveState === "failed" || liveState === "rejected" ? "prediction-ticket-status error" : "prediction-ticket-status"}>
            {liveMessage}
            {liveProofUrl ? <> <a href={liveProofUrl} target="_blank" rel="noreferrer">Hypurrscan account proof</a></> : null}
          </p>
        ) : null}
        </div>
        {liveConfirmOpen && props.selectedOutcome && props.selectedSide && selectedTechnical ? (
        <div className="prediction-confirm-backdrop" role="dialog" aria-modal="true" aria-label="Confirm live prediction order">
          <div className="panel prediction-confirm-modal">
            <div className="panel-head">
              <div>
                <span>Live confirmation</span>
                <strong>Prediction market order, not a leveraged perp.</strong>
              </div>
            </div>
            <div className="prediction-ticket-body">
              <MetricCell label="Question" value={props.question.name} />
              <MetricCell label="Outcome" value={props.selectedOutcome.name} />
              <MetricCell label="Side" value={props.selectedSide.name} />
              <MetricCell label="Buy/sell" value="Buy" />
              <MetricCell label="Time in force" value={tif} />
              <MetricCell label="Best ask" value={formatProbabilityPrice(props.selectedSide.bestAsk)} />
              <MetricCell label="Selected limit" value={formatProbabilityPrice(liveWirePrice)} />
              <MetricCell label="Classification" value={orderClassification.label} />
              <MetricCell label="Contracts" value={math.contracts.toFixed(0)} />
              <MetricCell label="Wire price" value={liveWirePrice} />
              <MetricCell label="Max cost" value={formatUsdc(math.estimatedCost)} />
              <MetricCell label="Effective minimum" value={formatUsdc(hip4EffectiveMinOrderCostUsd)} />
              <MetricCell label="HIP-4 spendable" value={formatUsdc(Number(predictionBalance?.spotUsdcAvailable ?? 0))} />
              <MetricCell label="Asset id" value={String(selectedTechnical.assetId)} />
              <MetricCell label="Coin" value={selectedTechnical.coin} />
              <MetricCell label="Acknowledgement" value="Criteria and live risk accepted" />
            </div>
            <p className="market-notice">
              You are signing and submitting a live Hyperliquid prediction market order. You can lose the full premium paid.
            </p>
            <div className="prediction-confirm-actions">
              <button onClick={() => setLiveConfirmOpen(false)}>Cancel</button>
              <button
                disabled={liveState === "building" || liveState === "signing" || liveState === "submitting"}
                onClick={submitLiveOrder}
              >
                {liveState === "building" || liveState === "signing" || liveState === "submitting"
                  ? "Submitting live order..."
                  : "Sign and submit live order"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </section>
    </>
  );
}

const PREDICTION_AGENT_PROMPTS = [
  "Should I buy this outcome?",
  "Find the cleanest World Cup setup",
  "Explain this odds move",
  "What could make this wrong?",
  "Draft a marketable order",
] as const;

function PredictionAgentPanel(props: {
  analysis: AgentAnalysis | undefined;
  agentQuestion: string | undefined;
  isThinking: boolean;
  mode: "paper" | "live";
  liveAllowed: boolean;
  selectedOutcome: PredictionOutcome | undefined;
  selectedSide: PredictionSideOdds | undefined;
  onPrompt: (prompt: string) => void;
  onApplyDraft: (draft: AgentPredictionDraft) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const provider = agentProviderDisplay(props.analysis);
  const paperOnly = props.mode === "paper" || !props.liveAllowed;

  return (
    <section className="panel prediction-agent-panel" data-testid="prediction-agent-panel">
      <div className="panel-head">
        <div>
          <span>Ask Agent.trade</span>
          <strong>{props.selectedOutcome && props.selectedSide ? `${props.selectedOutcome.name} / ${props.selectedSide.name}` : "Select outcome"}</strong>
        </div>
        <button type="button" onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>
      {!collapsed ? (
        <>
          <div className="receipt-row" style={{ padding: "10px 12px 0" }}>
            <span className="from-agent-badge">{provider.label}</span>
            <span>{provider.detail}</span>
            <span>Agent drafts; you confirm.</span>
          </div>
          {paperOnly ? (
            <p className="paper-note">Paper draft only. Live prediction trading remains gated by Agent.trade eligibility and confirmation.</p>
          ) : null}
          <div className="prompt-chips">
            {PREDICTION_AGENT_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                disabled={!props.selectedOutcome || !props.selectedSide || props.isThinking}
                onClick={() => props.onPrompt(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
          {props.agentQuestion ? (
            <div className="agent-user-message">
              <span>User</span>
              <p>{props.agentQuestion}</p>
            </div>
          ) : null}
          {props.isThinking ? (
            <div className="thinking">Reading question criteria, selected outcome, Yes/No book, freshness, balances, and ticket context...</div>
          ) : null}
          {!props.isThinking && props.analysis ? (
            <div className={`agent-answer ${props.analysis.responseType === "trade_proposal" ? "tradeProposal" : props.analysis.responseType === "no_trade" ? "noTrade" : props.analysis.responseType === "refusal" ? "staleRefusal" : "answered"}`}>
              <p className="agent-question">Agent.trade response</p>
              <h3>{props.analysis.responseType === "trade_proposal" ? "Prediction draft" : props.analysis.responseType === "no_trade" ? "No clean setup" : props.analysis.responseType === "refusal" ? "Refusing to draft" : "Market read"}</h3>
              <div className="receipt-row">
                <span>{provider.label}</span>
                <span>Confidence {Math.round(props.analysis.confidence * 100)}%</span>
                <span>{paperOnly ? "Paper mode" : "Live eligible"}</span>
              </div>
              <p>{props.analysis.thesis}</p>
              <div className="receipt-row">
                {props.analysis.receipts.map((item) => (
                  <span key={`${item.label}-${item.timestamp}`}>{item.label}: {item.value}</span>
                ))}
              </div>
              <div className="agent-risk">
                <strong>Risk</strong>
                <p>{props.analysis.riskNote}</p>
                <strong>Why this could be wrong</strong>
                <p>{props.analysis.whyWrong}</p>
              </div>
              {props.analysis.predictionDraft ? (
                <div className="agent-risk">
                  <p>Send to prediction ticket copies this draft only. Agent.trade cannot submit it directly.</p>
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={() => props.onApplyDraft(props.analysis?.predictionDraft as AgentPredictionDraft)}
                  >
                    Send to prediction ticket
                  </button>
                </div>
              ) : null}
              {props.analysis.followUps ? (
                <div className="prompt-chips followups">
                  {props.analysis.followUps.map((followUp) => (
                    <button key={followUp} type="button" onClick={() => props.onPrompt(followUp)}>
                      {followUp}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {!props.isThinking && !props.analysis ? (
            <p className="agent-empty">Ask for a World Cup market read or a draft. The draft can prefill the ticket, but you still confirm normally.</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

async function requestPredictionAgentAnalysis(input: AgentInput): Promise<AgentAnalysis> {
  try {
    const response = await fetch("/api/agent-trade/agent-analysis", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, provider: "auto" }),
    });
    if (!response.ok) {
      return await fallbackPredictionAgentAnalysis(input, `Agent analysis route returned HTTP ${response.status}.`);
    }
    return parseAgentAnalysis(await response.json()) ?? invalidAgentOutputRefusal(input);
  } catch {
    return await fallbackPredictionAgentAnalysis(input, "Agent analysis route unavailable; using deterministic fallback.");
  }
}

async function fallbackPredictionAgentAnalysis(input: AgentInput, reason: string): Promise<AgentAnalysis> {
  const analysis = await new DeterministicAgentService().analyzeMarket(input);
  return {
    ...analysis,
    warnings: [...analysis.warnings, reason],
    provider: {
      ...analysis.provider,
      fallbackReason: reason,
    },
  };
}

function PredictionPaperPortfolio({ positions, fills }: { positions: PredictionPaperPosition[]; fills: PredictionPaperFill[] }) {
  const exposure = summarizePredictionPortfolioExposure(positions);
  return (
    <section className="panel prediction-paper-portfolio" data-testid="prediction-paper-portfolio">
      <div className="panel-head">
        <div>
          <span>Paper prediction portfolio</span>
          <strong>{positions.length} exposures / {fills.length} fills</strong>
        </div>
      </div>
      <div className="prediction-paper-summary">
        <MetricCell label="Contracts" value={exposure.totalContracts.toFixed(0)} />
        <MetricCell label="Cost basis" value={formatUsdc(exposure.totalCost)} />
        <MetricCell label="Current value" value={formatUsdc(exposure.currentValue)} />
        <MetricCell label="Unrealized PnL" value={formatUsdc(exposure.unrealizedPnl)} />
      </div>
      <div className="prediction-paper-table">
        <div className="prediction-paper-row prediction-paper-row-head">
          <span>Event/question</span>
          <span>Outcome</span>
          <span>Contracts</span>
          <span>Avg cost</span>
          <span>Current probability</span>
          <span>Current value</span>
          <span>Max payout</span>
          <span>Unrealized PnL</span>
          <span>Resolution</span>
        </div>
        {positions.map((position) => (
          <div key={position.key} className="prediction-paper-row">
            <strong>{position.questionName}<em>Paper prediction</em></strong>
            <span>{position.outcomeName} / {position.sideName}</span>
            <span>{position.contracts.toFixed(0)}</span>
            <span>{formatUsdc(position.avgCost)}</span>
            <span>{formatProbability(position.currentProbability)}</span>
            <span>{formatUsdc(position.currentValue)}</span>
            <span>{formatUsdc(position.maxPayout)}</span>
            <span>{formatUsdc(position.unrealizedPnl)}</span>
            <span>{position.resolutionStatus}</span>
          </div>
        ))}
        {positions.length === 0 ? (
          <div className="prediction-paper-empty">
            No paper prediction exposure for this question yet.
          </div>
        ) : null}
      </div>
      <div className="prediction-paper-fill-table">
        <div className="prediction-paper-fill-row prediction-paper-row-head">
          <span>Paper prediction fill</span>
          <span>Outcome</span>
          <span>Contracts</span>
          <span>Limit probability</span>
          <span>Cost</span>
          <span>Current probability</span>
        </div>
        {fills.map((fill) => (
          <div key={fill.id} className="prediction-paper-fill-row">
            <strong>{fill.id}<em>Paper prediction</em></strong>
            <span>{fill.outcomeName} / {fill.sideName}</span>
            <span>{fill.contracts.toFixed(0)}</span>
            <span>{formatProbability(fill.limitProbability)}</span>
            <span>{formatUsdc(fill.cost)}</span>
            <span>{formatProbability(fill.currentProbability)}</span>
          </div>
        ))}
        {fills.length === 0 ? (
          <div className="prediction-paper-empty">
            No paper prediction fills for this question yet.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PredictionLiveActivityPanel() {
  return (
    <section className="panel prediction-live-activity-panel">
      <div className="panel-head">
        <div>
          <span>Live orders and fills</span>
          <strong>Proof after submit</strong>
        </div>
      </div>
      <p className="prediction-panel-copy">
        Live HIP-4 order status and Hypurrscan account proof appear after a signed submission. Selected-coin trades
        streaming is not shown yet because this pass only subscribes to outcome l2Book data.
      </p>
    </section>
  );
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function paperLiquidityWarning(side: PredictionSideOdds | undefined): string {
  if (!side) return "Select an outcome side before recording a paper order.";
  if (side.emptyBook) return "Paper pricing is based on your limit probability because this book is empty.";
  if (!side.bestBid || !side.bestAsk) return "This book is one-sided; paper exits may differ from the displayed probability.";
  if (side.spread !== null && side.spread >= 0.1) return "Wide spreads can materially affect entry and exit in live markets.";
  return "Spread check: paper fills use your limit probability while market depth may differ.";
}

export function getPredictionLiveAvailability(input: {
  flagEnabled: boolean;
  eligibility: EligibilityResponse;
  walletReady: boolean;
  authenticated: boolean;
  walletAddress?: string;
}): { allowed: boolean; pathVisible: boolean; reason: string } {
  if (!input.flagEnabled) {
    return {
      allowed: false,
      pathVisible: false,
      reason: "Live HIP-4 prediction trading is disabled in this environment. Paper mode remains available.",
    };
  }
  if (input.eligibility.killSwitchEnabled || input.eligibility.state === "killSwitchDisabled") {
    return {
      allowed: false,
      pathVisible: false,
      reason: "Live trading is disabled by the Agent.trade kill switch. Paper mode remains available.",
    };
  }
  if (input.eligibility.state !== "liveEligible") {
    return {
      allowed: false,
      pathVisible: false,
      reason: "Live prediction trading requires confirmed eligible jurisdiction. Paper mode remains available.",
    };
  }
  if (!input.eligibility.mainnetExecutionEnabled) {
    return {
      allowed: false,
      pathVisible: false,
      reason: "Mainnet execution is disabled for Agent.trade. Paper mode remains available.",
    };
  }
  if (!input.walletReady) {
    return {
      allowed: false,
      pathVisible: true,
      reason: "Wallet readiness is loading. Paper mode remains available.",
    };
  }
  if (!input.authenticated || !input.walletAddress) {
    return {
      allowed: false,
      pathVisible: true,
      reason: "Connect a wallet to submit live prediction orders. Paper mode remains available.",
    };
  }
  return { allowed: true, pathVisible: true, reason: "Live prediction trading is available for this eligible wallet." };
}

function liveReviewDisabledReasons(input: {
  mode: "paper" | "live";
  walletConnected: boolean;
  liveAvailable: { allowed: boolean; reason: string };
  selectedSideLoading: boolean;
  selectedTechnical: boolean;
  selectedTopOfBookReady: boolean;
  selectedBookStale: boolean;
  orderClassificationReason?: string;
  criteriaAcknowledged: boolean;
  contracts: number;
  estimatedCost: number;
  effectiveMinCost: number;
  predictionBalanceStatus: "idle" | "loading" | "ready" | "failed";
  predictionBalanceSufficient: boolean;
}): string[] {
  if (input.mode !== "live") return [];
  const reasons: string[] = [];
  if (!input.walletConnected) reasons.push("Connect an eligible wallet.");
  if (!input.liveAvailable.allowed) reasons.push(input.liveAvailable.reason);
  if (input.selectedSideLoading) reasons.push("Selected odds finish loading.");
  if (!input.selectedTechnical) reasons.push("Selected outcome technical details are available.");
  if (!input.selectedTopOfBookReady) reasons.push("Selected outcome has a valid two-sided top of book.");
  if (input.selectedBookStale) reasons.push("Selected live book is connected and fresh.");
  if (input.orderClassificationReason) reasons.push(input.orderClassificationReason);
  if (!input.criteriaAcknowledged) reasons.push("Resolution criteria are acknowledged.");
  if (input.contracts <= 0) reasons.push("Contracts are a positive whole number.");
  if (input.estimatedCost < input.effectiveMinCost) {
    reasons.push(`Max cost reaches the ${formatUsdc(input.effectiveMinCost)} HIP-4 effective minimum.`);
  }
  if (input.predictionBalanceStatus === "loading") reasons.push("HIP-4 spendable balance check completes.");
  if (input.predictionBalanceStatus === "failed") reasons.push("HIP-4 spendable balance can be verified.");
  if (input.predictionBalanceStatus === "ready" && !input.predictionBalanceSufficient) {
    reasons.push("HIP-4 spendable balance covers the live order max cost and effective minimum.");
  }
  return reasons.length > 0 ? reasons : ["Live ticket readiness checks pass."];
}

async function readPredictionLiveError(
  response: Response,
  fallback: string,
): Promise<{ message?: string; guidance?: string; code?: string }> {
  try {
    const body = await response.json();
    if (body && typeof body === "object") return body as { message?: string; guidance?: string; code?: string };
  } catch {
    // Non-JSON error responses fall through to the fallback.
  }
  return { message: fallback };
}

function predictionLiveOrderErrorMessage(error: { message?: string; guidance?: string; code?: string }): string {
  return [error.code, error.guidance, error.message].filter(Boolean).join(" ") || "Prediction live order failed.";
}

async function readJsonOrEmpty(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function probabilityBarWidth(probability: number | null | undefined): number {
  if (probability === null || probability === undefined || !Number.isFinite(probability)) return 4;
  return Math.min(100, Math.max(4, probability * 100));
}

function combinedPredictionStreamStatus(state: PredictionTwoSideStreamState): PredictionStreamStatus {
  if (state.yes.status === "live" && state.no.status === "live") return "live";
  if (state.yes.status === "connecting" || state.no.status === "connecting") return "connecting";
  if (state.yes.status === "rest_fallback" || state.no.status === "rest_fallback") return "rest_fallback";
  if (state.yes.status === "disconnected" || state.no.status === "disconnected") return "disconnected";
  return "idle";
}

function formatBookUpdateAge(lastBookAt: number | undefined, now = Date.now()): string {
  if (lastBookAt === undefined) return "--";
  const seconds = Math.max(0, Math.round((now - lastBookAt) / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function formatContractSize(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed).toLocaleString() : value;
}

function defaultPredictionOutcomeId(question: PredictionQuestion): number | undefined {
  if (question.questionId === 32) {
    const france = question.namedOutcomes.find((outcome) => outcome.outcome === 189);
    if (france) return france.outcome;
  }
  return question.namedOutcomes[0]?.outcome ?? question.fallbackOutcome?.outcome;
}

function PredictionRiskCopy() {
  return (
    <section className="panel prediction-risk-panel" data-testid="prediction-risk-copy">
      <div className="panel-head">
        <div>
          <span>Risk</span>
          <strong>Event contract</strong>
        </div>
      </div>
      <div className="prediction-risk-list">
        {PREDICTION_RISK_COPY.map((line) => <p key={line}>{line}</p>)}
      </div>
    </section>
  );
}
