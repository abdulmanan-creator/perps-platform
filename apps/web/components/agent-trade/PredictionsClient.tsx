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

  return (
    <Link className="panel prediction-card" href={`/predictions/${question.questionId}`}>
      <div className="prediction-card-top">
        <span className="state-pill account-warning">{status}</span>
        <span>{predictionCategoryLabel(question)}</span>
      </div>
      <h2>{question.name}</h2>
      <p>{question.criteria || question.description || "Resolution criteria unavailable from Hyperliquid metadata."}</p>
      <div className="prediction-card-stats">
        <span>{(question.quoteToken ?? question.quoteTokens.join(", ")) || "Quote pending"}</span>
        <span>{question.namedOutcomes.length} named outcomes</span>
        <span>{odds ? `${odds.nonEmptySideCount} active sides` : "Odds pending"}</span>
        <span>{odds ? `${Math.round(odds.totalDepth)} contracts depth` : spreadText}</span>
      </div>
      <div className="prediction-outcome-strip">
        {odds?.visibleOutcomes.length ? odds.visibleOutcomes.map((outcome) => (
          <span key={outcome.outcome}>
            <strong>{outcome.name}</strong>
            <em>{outcome.emptyBook ? "Empty" : formatProbability(outcome.midpointProbability)}</em>
          </span>
        )) : question.namedOutcomes.slice(0, 4).map((outcome) => (
          <span key={outcome.outcome}>
            <strong>{outcome.name}</strong>
            <em>Odds pending</em>
          </span>
        ))}
      </div>
      <div className="prediction-card-foot">
        <span>{spreadText}</span>
        <strong>Open detail</strong>
      </div>
    </Link>
  );
}
