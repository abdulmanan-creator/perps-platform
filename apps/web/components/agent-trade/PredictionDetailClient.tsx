"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";

import type {
  PredictionLiveOrderRequest,
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
  enrichPredictionPaperPositions,
  formatEmptyBook,
  formatProbability,
  formatProbabilityPrice,
  formatSpread,
  formatUsdc,
  buildPredictionLiveOrderAction,
  getPredictionHip4MinOrderCostUsd,
  isPredictionLiveTradingEnabled,
  loadPredictionQuestion,
  loadPredictionQuestionOdds,
  loadPredictionPaperAccount,
  predictionPaperFillsForQuestion,
  probabilityFromSide,
  predictionLiveExchangeEndpoint,
  predictionCategoryLabel,
  predictionStatusLabel,
  selectedOutcomeOdds,
  submitPredictionPaperOrder,
  summarizePredictionPortfolioExposure,
  summarizePredictionLiveExchangeResult,
} from "@/lib/agent-trade/predictions";
import { API_BASE_URL } from "@/lib/api";
import { DEFAULT_ELIGIBILITY_RESPONSE, normalizeEligibilityResponse } from "@/lib/agent-trade/eligibility";
import { hypurrscanAddressUrl } from "@/lib/agent-trade/hypurrscan";
import {
  normalizeHexSignature,
  withExplicitEip712Domain,
  type HyperliquidTypedData,
} from "@/lib/agent-trade/terminal";
import type { EligibilityResponse } from "@/lib/agent-trade/types";

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export function PredictionDetailClient({ questionId }: { questionId: number }) {
  const [question, setQuestion] = useState<PredictionQuestion | undefined>();
  const [odds, setOdds] = useState<PredictionQuestionOdds | undefined>();
  const [paperAccount, setPaperAccount] = useState<PredictionPaperAccount | undefined>();
  const [selectedOutcomeId, setSelectedOutcomeId] = useState<number | undefined>();
  const [selectedSideIndex, setSelectedSideIndex] = useState<0 | 1>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [eligibility, setEligibility] = useState<EligibilityResponse>(DEFAULT_ELIGIBILITY_RESPONSE);
  const { ready: privyReady, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const activeWallet = wallets[0];

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      try {
        const [nextQuestion, nextOdds, nextPaperAccount] = await Promise.all([
          loadPredictionQuestion(questionId),
          loadPredictionQuestionOdds(questionId),
          loadPredictionPaperAccount(),
        ]);
        if (!cancelled) {
          setQuestion(nextQuestion);
          setOdds(nextOdds);
          setPaperAccount(nextPaperAccount);
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
  const paperPositions = question ? enrichPredictionPaperPositions(paperAccount, question, odds) : [];
  const paperFills = question ? predictionPaperFillsForQuestion(paperAccount, question.questionId) : [];

  function refreshPaperAccount(nextAccount: PredictionPaperAccount) {
    setPaperAccount(nextAccount);
    void Promise.all([
      loadPredictionQuestionOdds(questionId),
      loadPredictionPaperAccount(),
    ]).then(([nextOdds, refreshedAccount]) => {
      setOdds(nextOdds);
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
          <p className="at-kicker">{question.questionId === 32 ? "World Cup" : `Question ${question.questionId}`}</p>
          <h1>{question.name}</h1>
          <p>{question.criteria || question.description || "Resolution criteria unavailable from Hyperliquid metadata."}</p>
        </div>
        <div className="prediction-detail-health">
          <span className="state-pill live">{predictionStatusLabel(question)}</span>
          <span>{predictionCategoryLabel(question)}</span>
          <span>{(question.quoteToken ?? question.quoteTokens.join(", ")) || "Quote token pending"}</span>
        </div>
      </section>

      <section className="prediction-terminal-grid">
        <aside className="prediction-terminal-left">
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
          <OrderBookPreview outcome={selectedOutcome} side={selectedSide} />
        </aside>
        <div className="prediction-terminal-center">
          <ProbabilitySnapshot
            question={question}
            odds={odds}
            selectedOutcomeId={selectedOutcomeId}
            onSelect={(outcomeId) => {
              setSelectedOutcomeId(outcomeId);
              setSelectedSideIndex(0);
            }}
          />
          <PredictionPaperPortfolio positions={paperPositions} fills={paperFills} />
          <div className="prediction-terminal-lower">
            <SettlementModule question={question} />
            <PredictionAgentPreview />
          </div>
        </div>
        <aside className="prediction-terminal-right">
          <PredictionPaperTicket
            question={question}
            selectedOutcomeId={selectedOutcomeId}
            selectedSideIndex={selectedSideIndex}
            selectedOutcome={selectedOutcome}
            selectedSide={selectedSide}
            hip4LiveFlagEnabled={isPredictionLiveTradingEnabled()}
            eligibility={eligibility}
            walletReady={privyReady}
            authenticated={authenticated}
            activeWallet={activeWallet}
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
  selectedOutcomeId: number | undefined;
  selectedSideIndex: 0 | 1;
  onSelect: (outcome: number, side: 0 | 1) => void;
}) {
  return (
    <section className="panel prediction-outcome-panel">
      <div className="panel-head">
        <div>
          <span>Outcome markets</span>
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

function ProbabilitySnapshot(props: {
  question: PredictionQuestion;
  odds: PredictionQuestionOdds | undefined;
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
        <span className="state-pill account-warning">Read-only live books</span>
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

function OrderBookPreview({ outcome, side }: { outcome: PredictionOutcome | undefined; side: PredictionSideOdds | undefined }) {
  return (
    <section className="panel prediction-book-panel">
      <div className="panel-head">
        <div>
          <span>Top of book</span>
          <strong>{outcome && side ? `${outcome.name} / ${side.name}` : "Select outcome"}</strong>
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

function PredictionPaperTicket(props: {
  question: PredictionQuestion;
  selectedOutcomeId: number | undefined;
  selectedSideIndex: 0 | 1;
  selectedOutcome: PredictionOutcome | undefined;
  selectedSide: PredictionSideOdds | undefined;
  hip4LiveFlagEnabled: boolean;
  eligibility: EligibilityResponse;
  walletReady: boolean;
  authenticated: boolean;
  activeWallet?: ConnectedWallet;
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

  useEffect(() => {
    if (!liveAvailable.pathVisible && mode === "live") setMode("paper");
  }, [liveAvailable.pathVisible, mode]);

  useEffect(() => {
    setLimitProbability(probabilityFromSide(props.selectedSide) ?? 0.5);
  }, [props.selectedSide?.coin]);

  const math = calculatePredictionTicketMath(contracts, limitProbability);
  const hip4MinOrderCostUsd = getPredictionHip4MinOrderCostUsd();
  const quoteToken = props.selectedOutcome?.quoteToken ?? props.question.quoteToken ?? props.question.quoteTokens[0] ?? "USDC";
  const liquidityWarning = paperLiquidityWarning(props.selectedSide);
  const selectedTechnical = props.selectedOutcome?.sides[props.selectedSideIndex];
  const canSubmit = Boolean(props.selectedOutcome && props.selectedSide && criteriaAcknowledged && math.contracts > 0);
  const canSubmitLive = canSubmit && liveAvailable.allowed && Boolean(selectedTechnical) && math.estimatedCost >= hip4MinOrderCostUsd;

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
        fromAgent: false,
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
        tif: "Ioc",
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

  return (
    <section className="panel prediction-ticket-preview" data-testid="prediction-ticket-preview">
      <div className="panel-head">
        <div>
          <span>Prediction ticket</span>
          <strong>{mode === "live" ? "Live Hyperliquid" : "Paper only"}</strong>
        </div>
      </div>
      <div className="prediction-ticket-form">
        <div className="prediction-ticket-side-picker">
          <span>Mode</span>
          <div>
            <button className={mode === "paper" ? "active" : ""} onClick={() => setMode("paper")}>Paper</button>
            {liveAvailable.pathVisible ? (
              <button
                className={mode === "live" ? "active" : ""}
                onClick={() => setMode("live")}
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
            onChange={(event) => props.onSelect(Number(event.target.value), props.selectedSideIndex)}
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
                onClick={() => props.selectedOutcome && props.onSelect(props.selectedOutcome.outcome, side.side)}
              >
                {side.name}
              </button>
            ))}
          </div>
        </div>
        <label>
          <span>{mode === "live" ? "Buy live contracts" : "Buy paper contracts"}</span>
          <input
            min="1"
            step="1"
            type="number"
            value={contracts}
            onChange={(event) => setContracts(Number(event.target.value))}
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
            onChange={(event) => setLimitProbability(Number(event.target.value))}
          />
        </label>
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
            <MetricCell label="HIP-4 min cost" value={formatUsdc(hip4MinOrderCostUsd)} />
          </div>
        ) : null}
        <p className="market-notice">{liquidityWarning}</p>
        {mode === "live" && math.estimatedCost < hip4MinOrderCostUsd ? (
          <p className="market-notice">Live HIP-4 cost must be at least {formatUsdc(hip4MinOrderCostUsd)}.</p>
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
              <MetricCell label="Contracts" value={math.contracts.toFixed(0)} />
              <MetricCell label="Limit probability" value={formatProbability(math.probability)} />
              <MetricCell label="Max cost" value={formatUsdc(math.estimatedCost)} />
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
  );
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
        Prediction-market agent support is paper-only in this lane. It may help draft simulated orders from the listed
        criteria and odds, but it will not submit live HIP-4 orders.
      </p>
    </section>
  );
}
