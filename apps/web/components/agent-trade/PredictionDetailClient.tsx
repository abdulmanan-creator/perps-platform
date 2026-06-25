"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type { PredictionOutcome, PredictionQuestion, PredictionQuestionOdds, PredictionSideOdds } from "@alchemy-hl/shared";

import {
  formatEmptyBook,
  formatProbability,
  formatProbabilityPrice,
  formatSpread,
  loadPredictionQuestion,
  loadPredictionQuestionOdds,
  maxPayoutForContracts,
  premiumForContracts,
  predictionCategoryLabel,
  predictionStatusLabel,
  selectedOutcomeOdds,
} from "@/lib/agent-trade/predictions";

export function PredictionDetailClient({ questionId }: { questionId: number }) {
  const [question, setQuestion] = useState<PredictionQuestion | undefined>();
  const [odds, setOdds] = useState<PredictionQuestionOdds | undefined>();
  const [selectedOutcomeId, setSelectedOutcomeId] = useState<number | undefined>();
  const [selectedSideIndex, setSelectedSideIndex] = useState<0 | 1>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      try {
        const [nextQuestion, nextOdds] = await Promise.all([
          loadPredictionQuestion(questionId),
          loadPredictionQuestionOdds(questionId),
        ]);
        if (!cancelled) {
          setQuestion(nextQuestion);
          setOdds(nextOdds);
          setSelectedOutcomeId(nextQuestion.namedOutcomes[0]?.outcome ?? nextQuestion.fallbackOutcome?.outcome);
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

  const selectedOdds = selectedOutcomeId === undefined ? undefined : selectedOutcomeOdds(odds, selectedOutcomeId);
  const selectedSide = selectedOdds?.sides[selectedSideIndex];
  const selectedOutcome = useMemo<PredictionOutcome | undefined>(
    () => {
      if (!question) return undefined;
      return question.namedOutcomes.find((outcome) => outcome.outcome === selectedOutcomeId) ??
        (question.fallbackOutcome?.outcome === selectedOutcomeId ? question.fallbackOutcome ?? undefined : undefined);
    },
    [question, selectedOutcomeId],
  );

  if (error) {
    return (
      <main className="predictions-page">
        <section className="panel predictions-empty">
          <strong>Prediction detail unavailable</strong>
          <span>{error}</span>
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
          <span>Fetching read-only HIP-4 metadata and odds.</span>
        </section>
      </main>
    );
  }

  return (
    <main className="predictions-page">
      <section className="prediction-detail-head">
        <div>
          <Link className="prediction-back-link" href="/predictions">Predictions</Link>
          <p className="at-kicker">Question {question.questionId}</p>
          <h1>{question.name}</h1>
          <p>{question.criteria || question.description || "Resolution criteria unavailable from Hyperliquid metadata."}</p>
        </div>
        <div className="prediction-detail-health">
          <span className="state-pill live">{predictionStatusLabel(question)}</span>
          <span>{predictionCategoryLabel(question)}</span>
          <span>{(question.quoteToken ?? question.quoteTokens.join(", ")) || "Quote token pending"}</span>
        </div>
      </section>

      <section className="prediction-detail-grid">
        <div className="prediction-detail-main">
          <OutcomeGrid
            question={question}
            odds={odds}
            selectedOutcomeId={selectedOutcomeId}
            selectedSideIndex={selectedSideIndex}
            onSelect={(outcomeId, side) => {
              setSelectedOutcomeId(outcomeId);
              setSelectedSideIndex(side);
            }}
          />
          <SettlementModule question={question} />
        </div>
        <aside className="prediction-detail-side">
          <OrderBookPreview outcome={selectedOutcome} side={selectedSide} />
          <ReadOnlyTicketPreview outcome={selectedOutcome} side={selectedSide} />
          <PredictionRiskCopy />
          <PredictionAgentPreview />
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
  selectedOutcomeId: number | undefined;
  selectedSideIndex: 0 | 1;
  onSelect: (outcome: number, side: 0 | 1) => void;
}) {
  return (
    <section className="panel prediction-outcome-panel">
      <div className="panel-head">
        <div>
          <span>Outcome grid</span>
          <strong>{props.question.namedOutcomes.length} named outcomes</strong>
        </div>
      </div>
      <div className="prediction-outcome-grid">
        {props.question.namedOutcomes.map((outcome) => {
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
                  return (
                    <button
                      key={side.side}
                      className={active ? "active" : ""}
                      onClick={() => props.onSelect(outcome.outcome, side.side)}
                    >
                      <span>{side.name}</span>
                      <strong>{formatProbability(odds?.midpointProbability)}</strong>
                      <em>{formatEmptyBook(odds ?? { emptyBook: true, bestBid: null, bestAsk: null })}</em>
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

function OrderBookPreview({ outcome, side }: { outcome: PredictionOutcome | undefined; side: PredictionSideOdds | undefined }) {
  return (
    <section className="panel prediction-book-panel">
      <div className="panel-head">
        <div>
          <span>Read-only book</span>
          <strong>{outcome ? outcome.name : "Select outcome"}</strong>
        </div>
      </div>
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

function ReadOnlyTicketPreview({ outcome, side }: { outcome: PredictionOutcome | undefined; side: PredictionSideOdds | undefined }) {
  const contracts = 10;
  const premium = premiumForContracts(contracts, side?.midpointProbability);
  const payout = maxPayoutForContracts(contracts);
  return (
    <section className="panel prediction-ticket-preview" data-testid="prediction-ticket-preview">
      <div className="panel-head">
        <div>
          <span>Ticket preview</span>
          <strong>Read-only</strong>
        </div>
      </div>
      <div className="prediction-ticket-body">
        <div>
          <span>Outcome</span>
          <strong>{outcome ? outcome.name : "Select an outcome"}</strong>
        </div>
        <div>
          <span>Side</span>
          <strong>{side ? side.name : "--"}</strong>
        </div>
        <div>
          <span>Example premium</span>
          <strong>{premium === null ? "--" : `${premium.toFixed(2)} USDC`}</strong>
        </div>
        <div>
          <span>Example max payout</span>
          <strong>{payout.toFixed(2)} USDC</strong>
        </div>
        <button disabled>Trading coming soon</button>
      </div>
    </section>
  );
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

function PredictionAgentPreview() {
  return (
    <section className="panel prediction-agent-panel">
      <div className="panel-head">
        <div>
          <span>Agent research</span>
          <strong>Preview</strong>
        </div>
      </div>
      <p className="prediction-panel-copy">
        Prediction-market agent support is coming. This preview will use resolution criteria, odds, and cited sources;
        it will not draft live trades from this read-only page.
      </p>
    </section>
  );
}
