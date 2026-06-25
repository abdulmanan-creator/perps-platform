"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  filterAndSortPredictionQuestions,
  formatProbability,
  formatSpread,
  loadPredictionQuestionOdds,
  loadPredictionQuestions,
  predictionCategoryLabel,
  predictionStatusLabel,
  summarizeQuestionOdds,
  type PredictionDiscoveryQuestion,
  type PredictionFilterKey,
  type PredictionSortKey,
} from "@/lib/agent-trade/predictions";

const filters: { key: PredictionFilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Live/open" },
  { key: "soon", label: "Resolving soon" },
  { key: "resolved", label: "Resolved" },
  { key: "sports", label: "Sports" },
  { key: "economics", label: "Economics" },
  { key: "crypto", label: "Crypto" },
  { key: "thin", label: "Empty books / thin liquidity" },
];

const sorts: { key: PredictionSortKey; label: string }[] = [
  { key: "default", label: "Default" },
  { key: "liquidity", label: "Liquidity/depth" },
  { key: "outcomes", label: "Outcome count" },
  { key: "name", label: "Name" },
];

export function PredictionsClient() {
  const [questions, setQuestions] = useState<PredictionDiscoveryQuestion[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PredictionFilterKey>("all");
  const [sort, setSort] = useState<PredictionSortKey>("default");
  const [isLoading, setIsLoading] = useState(true);
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsAttemptedIds, setOddsAttemptedIds] = useState<number[]>([]);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      try {
        const next = await loadPredictionQuestions();
        if (!cancelled) {
          setQuestions(next);
          setError(undefined);
        }
      } catch {
        if (!cancelled) {
          setQuestions([]);
          setError("Prediction markets are unavailable right now. Retry once the Hyperliquid read API responds.");
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
  }, []);

  const visibleQuestions = useMemo(
    () => filterAndSortPredictionQuestions({ questions, query, filter, sort }),
    [questions, query, filter, sort],
  );
  const oddsCandidateIds = useMemo(
    () => visibleQuestions.slice(0, 6).map((question) => question.questionId),
    [visibleQuestions],
  );

  useEffect(() => {
    const missingIds = oddsCandidateIds.filter((id) => {
      const question = questions.find((item) => item.questionId === id);
      return question && !question.oddsSummary && !oddsAttemptedIds.includes(id);
    });
    if (missingIds.length === 0) return;

    let cancelled = false;
    async function loadOdds() {
      setOddsLoading(true);
      setOddsAttemptedIds((current) => Array.from(new Set([...current, ...missingIds])));
      const summaries = await Promise.all(
        missingIds.map(async (questionId) => {
          try {
            return summarizeQuestionOdds(await loadPredictionQuestionOdds(questionId));
          } catch {
            return undefined;
          }
        }),
      );
      if (!cancelled) {
        setQuestions((current) =>
          current.map((question) => {
            const summary = summaries.find((item) => item?.questionId === question.questionId);
            return summary ? { ...question, oddsSummary: summary } : question;
          }),
        );
        setOddsLoading(false);
      }
    }

    void loadOdds();
    return () => {
      cancelled = true;
    };
  }, [oddsAttemptedIds, oddsCandidateIds.join(","), questions]);

  return (
    <main className="predictions-page">
      <section className="predictions-head">
        <div>
          <p className="at-kicker">Prediction markets</p>
          <h1>Predictions</h1>
          <p>
            Read-only HIP-4 event markets from Hyperliquid. This lane is separate from perps because pricing,
            risk, and settlement are different.
          </p>
        </div>
        <div className="predictions-health">
          <Link className="prediction-world-cup-chip" href="/predictions/32">
            World Cup
          </Link>
          <span className={error ? "state-pill stale" : "state-pill live"}>
            {error ? "Read unavailable" : "HIP-4 read-only"}
          </span>
          <span>{isLoading ? "Refreshing..." : `${questions.length} questions`}</span>
          <span>{oddsLoading ? "Loading odds..." : "Odds lazy-loaded"}</span>
        </div>
      </section>

      <section className="predictions-toolbar">
        <label>
          <span>Search</span>
          <input value={query} placeholder="World Cup, Fed, CPI..." onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="predictions-tabs">
          {filters.map((item) => (
            <button key={item.key} className={filter === item.key ? "active" : ""} onClick={() => setFilter(item.key)}>
              {item.label}
            </button>
          ))}
        </div>
        <label>
          <span>Sort</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as PredictionSortKey)}>
            {sorts.map((item) => (
              <option key={item.key} value={item.key}>{item.label}</option>
            ))}
          </select>
        </label>
      </section>

      {error ? <p className="market-notice">{error}</p> : null}

      <section className="predictions-grid" aria-label="Prediction market questions">
        {visibleQuestions.map((question) => (
          <PredictionQuestionCard key={question.questionId} question={question} />
        ))}
        {!isLoading && visibleQuestions.length === 0 ? (
          <div className="panel predictions-empty">
            <strong>No prediction questions match the current filters.</strong>
            <span>Clear search or choose another category.</span>
          </div>
        ) : null}
        {isLoading ? (
          <div className="panel predictions-empty">
            <strong>Loading prediction questions</strong>
            <span>Fetching HIP-4 metadata from the Agent.trade API.</span>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function PredictionQuestionCard({ question }: { question: PredictionDiscoveryQuestion }) {
  const odds = question.oddsSummary;
  const status = predictionStatusLabel(question);
  const spreadText = odds?.widestSpread === null || odds?.widestSpread === undefined
    ? "Spread pending"
    : `Widest spread ${formatSpread(odds.widestSpread)}`;
  const visibleOutcomes = odds?.visibleOutcomes.length
    ? odds.visibleOutcomes
    : question.namedOutcomes.slice(0, 4).map((outcome) => ({
      outcome: outcome.outcome,
      name: outcome.name,
      midpointProbability: null,
      bestBid: null,
      bestAsk: null,
      emptyBook: true,
    }));
  const liquidityLabel = odds
    ? odds.hasThinLiquidity
      ? "Thin liquidity"
      : `${Math.round(odds.totalDepth).toLocaleString()} contracts`
    : "Loading books";

  return (
    <Link className="panel prediction-card" href={`/predictions/${question.questionId}`}>
      <div className="prediction-card-top">
        <div>
          <span>{predictionCategoryLabel(question)}</span>
          <strong>{status}</strong>
        </div>
        <em>{(question.quoteToken ?? question.quoteTokens.join(", ")) || "Quote pending"}</em>
      </div>
      <h2>{question.name}</h2>
      <p>{question.criteria || question.description || "Resolution criteria unavailable from Hyperliquid metadata."}</p>
      <div className="prediction-card-marketline">
        <span>{question.namedOutcomes.length} outcomes</span>
        <span>{odds ? `${odds.nonEmptySideCount} active sides` : "Odds pending"}</span>
        <span>{liquidityLabel}</span>
      </div>
      <div className="prediction-outcome-strip">
        {visibleOutcomes.map((outcome) => {
          const probability = outcome.emptyBook ? null : outcome.midpointProbability;
          return (
            <span key={outcome.outcome}>
              <strong>{outcome.name}</strong>
              <em>{outcome.emptyBook ? "Empty" : formatProbability(probability)}</em>
              <b style={{ width: `${probabilityBarWidth(probability)}%` }} />
            </span>
          );
        })}
      </div>
      <div className="prediction-card-foot">
        <span>{spreadText}</span>
        <strong>Open paper terminal</strong>
      </div>
    </Link>
  );
}

function probabilityBarWidth(probability: number | null | undefined): number {
  if (probability === null || probability === undefined || !Number.isFinite(probability)) return 4;
  return Math.min(100, Math.max(4, probability * 100));
}
