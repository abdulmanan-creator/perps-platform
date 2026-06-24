"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { hexToSignature } from "viem";

import { API_BASE_URL } from "@/lib/api";
import { DeterministicAgentService, type AgentScenario } from "@/lib/agent-trade/agent-service";
import { fmtAgo, fmtCompactUsd, fmtNumber, fmtPct, fmtUsd } from "@/lib/agent-trade/format";
import { loadTradingSnapshot } from "@/lib/agent-trade/data";
import { MOCK_TRADING_SNAPSHOT } from "@/lib/agent-trade/mock-data";
import { normalizeSymbol } from "@/lib/agent-trade/markets";
import { buildHlOrderAction } from "@/lib/agent-trade/orders";
import { paperSessionHeaders } from "@/lib/agent-trade/paper";
import {
  calculateDraftImpact,
  calculatePortfolioExposure,
  classifyPortfolioRisk,
  estimateDraftLiquidation,
  type DraftImpact,
} from "@/lib/agent-trade/portfolio";
import {
  AGENT_PANEL_HEADING,
  applyManualDraftPatch,
  getConfirmationAckCopy,
  getTerminalEligibilityStatus,
  getTicketSource,
  paperOrderEndpoint,
  paperOrderFailureMessage,
} from "@/lib/agent-trade/terminal";
import type {
  AgentResponse,
  ChartAnnotation,
  EligibilityMode,
  MarginMode,
  OrderDraft,
  OrderType,
  SharedTradingSnapshot,
} from "@/lib/agent-trade/types";

interface EligibilityResponse {
  state: EligibilityMode;
  executionVenue: string;
  mainnetExecutionEnabled: boolean;
  killSwitchEnabled: boolean;
  orderNotionalCapUsd: number;
  dailyNotionalCapUsd: number;
}

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

interface BrowserWallet {
  ethereum?: Eip1193Provider;
}

const agentService = new DeterministicAgentService();

function buildDefaultDraft(snapshot: SharedTradingSnapshot): OrderDraft {
  const size = Number(
    Math.max(1 / 10 ** snapshot.market.szDecimals, Math.min(0.01, 1000 / snapshot.market.markPrice))
      .toFixed(snapshot.market.szDecimals),
  );
  return {
    symbol: snapshot.market.symbol,
    side: "long",
    orderType: "market",
    sizeBtc: size,
    leverage: 2,
    marginMode: "isolated",
    reduceOnly: false,
    fromAgent: false,
  };
}

export function TerminalClient() {
  const searchParams = useSearchParams();
  const requestedSymbol = normalizeSymbol(searchParams.get("symbol"));
  const [snapshot, setSnapshot] = useState<SharedTradingSnapshot>(MOCK_TRADING_SNAPSHOT);
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [eligibility, setEligibility] = useState<EligibilityResponse>({
    state: "loading",
    executionVenue: "hyperliquid-testnet",
    mainnetExecutionEnabled: false,
    killSwitchEnabled: false,
    orderNotionalCapUsd: 250,
    dailyNotionalCapUsd: 1000,
  });
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [isStale, setIsStale] = useState(false);
  const [draft, setDraft] = useState<OrderDraft>(() => buildDefaultDraft(MOCK_TRADING_SNAPSHOT));
  const [agent, setAgent] = useState<AgentResponse | undefined>();
  const [agentQuestion, setAgentQuestion] = useState<string | undefined>();
  const [annotations, setAnnotations] = useState<ChartAnnotation[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isAcked, setIsAcked] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitState, setSubmitState] = useState<string | undefined>();
  const [modalError, setModalError] = useState<string | undefined>();
  const [apiStatus, setApiStatus] = useState<"checking" | "ok" | "unavailable">("checking");
  const [marketNotice, setMarketNotice] = useState<string | undefined>();
  const [bottomTab, setBottomTab] = useState<"positions" | "orders" | "fills">("positions");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoadingData(true);
      const result = await loadTradingSnapshot(requestedSymbol);
      if (!cancelled) {
        const next = result.snapshot;
        setSnapshot(next);
        setDraft((current) =>
          current.symbol === next.market.symbol
            ? { ...current, symbol: next.market.symbol }
            : buildDefaultDraft(next),
        );
        setMarketNotice(
          result.usedFallback && requestedSymbol !== "BTC"
            ? `${result.requestedSymbol.toUpperCase()} is not available from /markets yet. Showing BTC instead.`
            : undefined,
        );
        setIsLoadingData(false);
      }
    }

    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [requestedSymbol]);

  useEffect(() => {
    let cancelled = false;
    async function loadEligibility() {
      try {
        const res = await fetch(`${API_BASE_URL}/agent-trade/eligibility`, { cache: "no-store" });
        if (!res.ok) {
          throw new Error("eligibility request failed");
        }
        const next = (await res.json()) as EligibilityResponse;
        if (!cancelled) {
          setEligibility(next);
          setApiStatus("ok");
          setMode(next.state === "liveEligible" ? "live" : "paper");
        }
      } catch {
        if (!cancelled) {
          setEligibility((current) => ({ ...current, state: "unknown" }));
          setApiStatus("unavailable");
          setMode("paper");
        }
      }
    }

    void loadEligibility();
    return () => {
      cancelled = true;
    };
  }, []);

  const entryPrice = draft.orderType === "limit" && draft.limitPrice ? draft.limitPrice : snapshot.market.markPrice;
  const notional = draft.sizeBtc * entryPrice;
  const marginRequired = notional / draft.leverage;
  const fees = notional * 0.00045;
  const liquidation = estimateDraftLiquidation({
    side: draft.side,
    entryPrice,
    leverage: draft.leverage,
  });
  const canLiveTrade = mode === "live" && eligibility.state === "liveEligible" && !isStale;
  const eligibilityStatus = getTerminalEligibilityStatus(eligibility.state);
  const draftImpact = useMemo(
    () => calculateDraftImpact({ account: snapshot.account, market: snapshot.market, draft, entryPrice }),
    [snapshot.account, snapshot.market, draft, entryPrice],
  );
  const portfolioExposure = useMemo(
    () => calculatePortfolioExposure(snapshot.account, snapshot.market.symbol),
    [snapshot.account, snapshot.market.symbol],
  );
  const portfolioRiskLabels = useMemo(
    () => classifyPortfolioRisk({
      account: snapshot.account,
      exposure: portfolioExposure,
      selectedSymbol: snapshot.market.symbol,
      mode,
    }),
    [snapshot.account, portfolioExposure, snapshot.market.symbol, mode],
  );

  const maxBookSize = useMemo(() => {
    const sizes = [...snapshot.orderBook.asks, ...snapshot.orderBook.bids].map((level) => level.size);
    return Math.max(...sizes, 1);
  }, [snapshot.orderBook]);

  async function runAgent(scenario: AgentScenario) {
    setIsThinking(true);
    setAgent(undefined);
    setAgentQuestion(undefined);
    setAnnotations([]);
    const response = await agentService.run({
      scenario,
      snapshot: isStale
        ? {
            ...snapshot,
            market: { ...snapshot.market, dataAgeSeconds: 46 },
          }
        : snapshot,
      isStale,
      mode,
    });
    setAgent(response);
    setAgentQuestion(response.question);
    setAnnotations(response.annotations);
    setIsThinking(false);
  }

  async function runTypedAgent(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }

    setIsThinking(true);
    setAgent(undefined);
    setAgentQuestion(trimmed);
    setAnnotations([]);
    const response = await agentService.runPrompt({
      prompt: trimmed,
      snapshot: isStale
        ? {
            ...snapshot,
            market: { ...snapshot.market, dataAgeSeconds: 46 },
          }
        : snapshot,
      isStale,
      mode,
    });
    setAgent(response);
    setAnnotations(response.annotations);
    setIsThinking(false);
  }

  function sendToTicket(orderDraft: OrderDraft) {
    setDraft({ ...orderDraft, fromAgent: true });
    setSubmitState("Agent proposal copied into the ticket.");
    setModalError(undefined);
  }

  function updateDraft(patch: Partial<OrderDraft>) {
    setDraft((current) => applyManualDraftPatch(current, patch));
    setModalError(undefined);
  }

  async function submitPaperOrder() {
    const endpoint = paperOrderEndpoint(API_BASE_URL);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...paperSessionHeaders() },
        body: JSON.stringify({ draft, estimatedEntry: entryPrice }),
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const error = (await res.json()) as { message?: string; guidance?: string };
          message = error.guidance ?? error.message ?? message;
        } catch {
          // Response was not JSON; keep status-based message.
        }
        throw new Error(message);
      }
      const json = (await res.json()) as { id: string; notionalUsd: number };
      setApiStatus("ok");
      const refreshed = await loadTradingSnapshot(snapshot.market.base);
      setSnapshot(refreshed.snapshot);
      setSubmitState(`Paper fill recorded. Position updated: ${json.id} (${fmtUsd(json.notionalUsd, 2)} notional).`);
    } catch (err) {
      setApiStatus("unavailable");
      throw new Error(paperOrderFailureMessage(err, endpoint));
    }
  }

  async function submitLiveOrder() {
    if (!canLiveTrade) {
      throw new Error("Live trading is not available for this account/state.");
    }
    const provider = (globalThis as unknown as BrowserWallet).ethereum;
    if (!provider) {
      throw new Error("Connect an EIP-1193 wallet or use paper mode for this local demo.");
    }
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
      throw new Error("Wallet did not return an account.");
    }
    const user = accounts[0] as `0x${string}`;
    const action = buildHlOrderAction(draft, snapshot.market);
    const headers = {
      "content-type": "application/json",
      "x-agent-trade-risk-accepted": "true",
      "x-agent-trade-terms-accepted": "true",
    };

    const buildRes = await fetch(`${API_BASE_URL}/agent-trade/exchange`, {
      method: "POST",
      headers,
      body: JSON.stringify({ user, action }),
    });
    if (!buildRes.ok) {
      const error = (await buildRes.json()) as { message?: string; guidance?: string };
      throw new Error(error.guidance ?? error.message ?? "Exchange build failed");
    }
    const built = (await buildRes.json()) as { typedData: unknown; nonce: number; action: unknown };
    const rawSignature = await provider.request({
      method: "eth_signTypedData_v4",
      params: [user, JSON.stringify(built.typedData)],
    });
    if (typeof rawSignature !== "string") {
      throw new Error("Wallet returned an invalid signature.");
    }
    const signature = hexToSignature(rawSignature as `0x${string}`);
    const sendRes = await fetch(`${API_BASE_URL}/agent-trade/exchange`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: built.action, nonce: built.nonce, signature }),
    });
    if (!sendRes.ok) {
      const error = (await sendRes.json()) as { message?: string; guidance?: string };
      throw new Error(error.guidance ?? error.message ?? "Exchange send failed");
    }
    setSubmitState("Live order forwarded to Hyperliquid after wallet signature.");
  }

  async function confirmOrder() {
    if (!isAcked) {
      return;
    }
    setIsConfirming(true);
    setSubmitState(undefined);
    setModalError(undefined);
    try {
      if (mode === "paper") {
        await submitPaperOrder();
      } else {
        await submitLiveOrder();
      }
      setModalOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Order submission failed.";
      setModalError(message);
      setSubmitState(message);
    } finally {
      setIsConfirming(false);
    }
  }

  return (
    <main className="terminal-page">
      <section className="terminal-head">
        <div>
          <p className="at-kicker">Hyperliquid terminal</p>
          <h1>{snapshot.market.symbol}</h1>
          <div className="terminal-market-line">
            <strong>{fmtUsd(snapshot.market.markPrice, 1)}</strong>
            <span className={snapshot.market.change24hPct >= 0 ? "pos" : "neg"}>
              {fmtPct(snapshot.market.change24hPct, 2)} ({fmtUsd(snapshot.market.change24hAbs, 1)})
            </span>
            <span>{snapshot.market.venue}</span>
          </div>
          {marketNotice ? <p className="market-notice">{marketNotice}</p> : null}
        </div>
        <div className="terminal-state-row">
          <button className={isStale ? "state-pill stale" : "state-pill live"} onClick={() => setIsStale((value) => !value)}>
            {isStale ? "Stale data: 46s" : `${snapshot.market.source === "live-mainnet" ? "Live mainnet read" : "Mock snapshot"}: ${snapshot.market.dataAgeSeconds}s`}
          </button>
          <ModeControl eligibility={eligibility} mode={mode} setMode={setMode} />
        </div>
      </section>
      {eligibilityStatus.visible || apiStatus !== "ok" ? (
        <TerminalStatusBanner
          eligibilityStatus={eligibilityStatus}
          apiStatus={apiStatus}
          apiBaseUrl={API_BASE_URL}
        />
      ) : null}

      <section className="terminal-grid">
        <div className="terminal-left">
          <StatsStrip snapshot={snapshot} isLoading={isLoadingData} />
          <ChartPanel snapshot={snapshot} annotations={annotations} />
          <BottomPanel
            snapshot={snapshot}
            bottomTab={bottomTab}
            setBottomTab={setBottomTab}
          />
        </div>
        <div className="terminal-mid">
          <BookPanel snapshot={snapshot} maxBookSize={maxBookSize} />
          <TradesPanel snapshot={snapshot} />
        </div>
        <div className="terminal-right">
          <AgentPanel
            base={snapshot.market.base}
            agent={agent}
            agentQuestion={agentQuestion}
            isThinking={isThinking}
            runAgent={runAgent}
            runTypedAgent={runTypedAgent}
            sendToTicket={sendToTicket}
            isStale={isStale}
          />
          <TicketPanel
            base={snapshot.market.base}
            symbol={snapshot.market.symbol}
            szDecimals={snapshot.market.szDecimals}
            maxLeverage={Math.min(10, snapshot.market.maxLeverage)}
            draft={draft}
            updateDraft={updateDraft}
            entryPrice={entryPrice}
            notional={notional}
            marginRequired={marginRequired}
            fees={fees}
            liquidation={liquidation}
            canLiveTrade={canLiveTrade}
            mode={mode}
            eligibility={eligibility}
            apiStatus={apiStatus}
            simulatedBalanceUsd={snapshot.account.simulatedBalanceUsd}
            openModal={() => {
              setIsAcked(false);
              setModalError(undefined);
              setModalOpen(true);
            }}
          />
          <ImpactPanel
            base={snapshot.market.base}
            impact={draftImpact}
            exposureLabels={portfolioRiskLabels}
          />
          {submitState ? <div className="submit-state">{submitState}</div> : null}
        </div>
      </section>

      {modalOpen ? (
        <ConfirmModal
          draft={draft}
          base={snapshot.market.base}
          szDecimals={snapshot.market.szDecimals}
          mode={mode}
          entryPrice={entryPrice}
          notional={notional}
          marginRequired={marginRequired}
          fees={fees}
          liquidation={liquidation}
          canLiveTrade={canLiveTrade}
          eligibility={eligibility}
          modalError={modalError}
          isAcked={isAcked}
          setIsAcked={setIsAcked}
          close={() => {
            setModalError(undefined);
            setModalOpen(false);
          }}
          confirm={confirmOrder}
          isConfirming={isConfirming}
        />
      ) : null}
    </main>
  );
}

function ModeControl({
  eligibility,
  mode,
  setMode,
}: {
  eligibility: EligibilityResponse;
  mode: "paper" | "live";
  setMode: (mode: "paper" | "live") => void;
}) {
  const liveDisabled = eligibility.state !== "liveEligible";
  return (
    <div className="mode-control" aria-label="Trading mode">
      <button className={mode === "paper" ? "active" : ""} onClick={() => setMode("paper")}>
        Paper
      </button>
      <button
        className={mode === "live" ? "active" : ""}
        disabled={liveDisabled}
        onClick={() => setMode("live")}
        title={liveDisabled ? `Live blocked: ${eligibility.state}` : "Live eligible"}
      >
        Live
      </button>
      <span>{eligibility.state}</span>
    </div>
  );
}

function TerminalStatusBanner({
  eligibilityStatus,
  apiStatus,
  apiBaseUrl,
}: {
  eligibilityStatus: ReturnType<typeof getTerminalEligibilityStatus>;
  apiStatus: "checking" | "ok" | "unavailable";
  apiBaseUrl: string;
}) {
  const showApi = apiStatus !== "ok";
  return (
    <section className={`terminal-status-banner ${eligibilityStatus.tone}`}>
      <div>
        {eligibilityStatus.visible ? (
          <>
            <strong>{eligibilityStatus.label}</strong>
            <span>{eligibilityStatus.message}</span>
          </>
        ) : (
          <>
            <strong>Terminal status</strong>
            <span>Live trading is available only after Agent.trade confirms eligibility and order confirmation.</span>
          </>
        )}
      </div>
      {showApi ? (
        <div className={`api-status ${apiStatus}`}>
          <strong>{apiStatus === "checking" ? "API checking" : "API unavailable"}</strong>
          <span>{apiBaseUrl}</span>
        </div>
      ) : null}
    </section>
  );
}

function StatsStrip({ snapshot, isLoading }: { snapshot: SharedTradingSnapshot; isLoading: boolean }) {
  const stats = [
    ["Funding", fmtPct(snapshot.market.fundingRatePct)],
    ["Open interest", fmtCompactUsd(snapshot.market.openInterestUsd)],
    ["OI 24h", snapshot.market.openInterestChangePct === null ? "--" : fmtPct(snapshot.market.openInterestChangePct, 1)],
    ["24h volume", fmtCompactUsd(snapshot.market.volume24hUsd)],
    ["Liquidity", fmtCompactUsd(snapshot.market.liquidityUsd)],
    ["Next funding", `${snapshot.market.nextFundingMinutes}m`],
  ];
  return (
    <div className="stats-strip">
      {stats.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{isLoading ? "..." : value}</strong>
        </div>
      ))}
    </div>
  );
}

function ChartPanel({
  snapshot,
  annotations,
}: {
  snapshot: SharedTradingSnapshot;
  annotations: ChartAnnotation[];
}) {
  const mark = snapshot.market.markPrice;
  const prices = [
    mark * 0.982,
    mark * 0.988,
    mark * 0.984,
    mark * 0.996,
    mark * 0.992,
    mark * 1.004,
    mark * 1.009,
    mark * 1.001,
    mark * 1.015,
    mark * 1.011,
    mark * 1.022,
    mark * 1.018,
  ];
  const allPrices = [...prices, ...annotations.map((a) => a.price)];
  const min = Math.min(...allPrices) * 0.998;
  const max = Math.max(...allPrices) * 1.002;
  const points = prices
    .map((price, index) => {
      const x = 24 + index * 62;
      const y = 260 - ((price - min) / (max - min)) * 210;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div className="panel chart-panel">
      <div className="panel-head">
        <div>
          <span>{snapshot.market.base} perpetual</span>
          <strong>Agent annotated chart</strong>
        </div>
        <div className="timeframes">
          {["1m", "5m", "15m", "1h", "4h"].map((tf) => (
            <button key={tf} className={tf === "15m" ? "active" : ""}>{tf}</button>
          ))}
        </div>
      </div>
      <svg className="chart-svg" viewBox="0 0 760 300" role="img" aria-label={`${snapshot.market.base} chart with agent annotations`}>
        <defs>
          <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(39, 214, 170, 0.28)" />
            <stop offset="100%" stopColor="rgba(39, 214, 170, 0)" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((line) => (
          <line key={line} x1="20" x2="735" y1={60 + line * 55} y2={60 + line * 55} className="chart-grid-line" />
        ))}
        <polyline points={`24,275 ${points} 706,250`} fill="url(#chartFill)" stroke="none" />
        <polyline points={points} fill="none" className="chart-line" />
        {annotations.map((annotation) => {
          const y = 260 - ((annotation.price - min) / (max - min)) * 210;
          return (
            <g key={annotation.id}>
              <line x1="24" x2="725" y1={y} y2={y} className={`annotation-line ${annotation.tone}`} />
              <text x="575" y={y - 7} className={`annotation-label ${annotation.tone}`}>
                {annotation.label} {fmtUsd(annotation.price, 0)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function BookPanel({
  snapshot,
  maxBookSize,
}: {
  snapshot: SharedTradingSnapshot;
  maxBookSize: number;
}) {
  return (
    <div className="panel compact-panel">
      <div className="panel-head tight"><strong>Order book</strong><span>{fmtUsd(snapshot.market.markPrice, 1)}</span></div>
      <div className="book-table">
        {[...snapshot.orderBook.asks].reverse().map((level) => (
          <BookRow key={`ask-${level.price}`} level={level} max={maxBookSize} side="ask" />
        ))}
        <div className="spread-row">
          Spread {fmtUsd(snapshot.orderBook.asks[0].price - snapshot.orderBook.bids[0].price, 1)}
        </div>
        {snapshot.orderBook.bids.map((level) => (
          <BookRow key={`bid-${level.price}`} level={level} max={maxBookSize} side="bid" />
        ))}
      </div>
    </div>
  );
}

function BookRow({ level, max, side }: { level: { price: number; size: number }; max: number; side: "bid" | "ask" }) {
  return (
    <div className={`book-row ${side}`}>
      <span className="depth" style={{ width: `${(level.size / max) * 100}%` }} />
      <strong>{fmtNumber(level.price, 1)}</strong>
      <span>{fmtNumber(level.size, 3)}</span>
    </div>
  );
}

function TradesPanel({ snapshot }: { snapshot: SharedTradingSnapshot }) {
  return (
    <div className="panel compact-panel trades-panel">
      <div className="panel-head tight"><strong>Recent trades</strong><span>{snapshot.market.base}</span></div>
      {snapshot.recentTrades.map((trade) => (
        <div key={`${trade.timestamp}-${trade.price}`} className={`trade-row ${trade.side}`}>
          <strong>{trade.side === "buy" ? "Buy" : "Sell"}</strong>
          <span>{fmtUsd(trade.price, 1)}</span>
          <span>{fmtNumber(trade.size, 4)}</span>
          <span>{fmtAgo(trade.timestamp, snapshot.asOf)}</span>
        </div>
      ))}
    </div>
  );
}

function TicketPanel(props: {
  base: string;
  symbol: string;
  szDecimals: number;
  maxLeverage: number;
  draft: OrderDraft;
  updateDraft: (patch: Partial<OrderDraft>) => void;
  entryPrice: number;
  notional: number;
  marginRequired: number;
  fees: number;
  liquidation: number;
  canLiveTrade: boolean;
  mode: "paper" | "live";
  eligibility: EligibilityResponse;
  apiStatus: "checking" | "ok" | "unavailable";
  simulatedBalanceUsd: number;
  openModal: () => void;
}) {
  const blocked = props.mode === "live" && !props.canLiveTrade;
  const source = getTicketSource(props.draft);
  const paperOnly = props.mode === "paper" || props.eligibility.state !== "liveEligible";
  const largePaperOrder = props.mode === "paper" && props.notional > props.simulatedBalanceUsd;
  return (
    <div className={`panel ticket-panel ${source === "agent" ? "from-agent" : ""}`}>
      <div className="panel-head">
        <div>
          <span>Order ticket</span>
          <strong>{source === "agent" ? "From Agent" : "Manual"}</strong>
        </div>
        <span className={props.mode === "paper" ? "paper-badge" : "live-badge"}>{props.mode}</span>
      </div>
      {paperOnly ? (
        <p className="ticket-mode-note">
          Paper mode active. Live trading is disabled until eligibility is confirmed.
        </p>
      ) : null}
      <div className="segmented">
        <button className={props.draft.side === "long" ? "active long" : ""} onClick={() => props.updateDraft({ side: "long" })}>Long</button>
        <button className={props.draft.side === "short" ? "active short" : ""} onClick={() => props.updateDraft({ side: "short" })}>Short</button>
      </div>
      <div className="segmented">
        {(["market", "limit"] as OrderType[]).map((type) => (
          <button key={type} className={props.draft.orderType === type ? "active" : ""} onClick={() => props.updateDraft({ orderType: type })}>{type}</button>
        ))}
      </div>
      <label className="field">
        <span>Size ({props.base})</span>
        <input
          value={props.draft.sizeBtc}
          type="number"
          min="0"
          step={1 / 10 ** props.szDecimals}
          onChange={(event) => props.updateDraft({ sizeBtc: Number(event.target.value) })}
        />
        <small>Base asset amount, not USD. Preview: {fmtUsd(props.notional, 2)} notional on {props.symbol}.</small>
      </label>
      {props.draft.orderType === "limit" ? (
        <label className="field">
          <span>Limit price</span>
          <input value={props.draft.limitPrice ?? ""} type="number" onChange={(event) => props.updateDraft({ limitPrice: Number(event.target.value) })} />
        </label>
      ) : null}
      <label className="field">
        <span>Leverage {props.draft.leverage}x</span>
        <input value={props.draft.leverage} type="range" min="1" max={props.maxLeverage} onChange={(event) => props.updateDraft({ leverage: Number(event.target.value) })} />
      </label>
      <div className="segmented">
        {(["isolated", "cross"] as MarginMode[]).map((marginMode) => (
          <button key={marginMode} className={props.draft.marginMode === marginMode ? "active" : ""} onClick={() => props.updateDraft({ marginMode })}>{marginMode}</button>
        ))}
      </div>
      <label className="check-row">
        <input type="checkbox" checked={props.draft.reduceOnly} onChange={(event) => props.updateDraft({ reduceOnly: event.target.checked })} />
        Reduce only
      </label>
      <div className="ticket-two">
        <label className="field">
          <span>Take profit</span>
          <input value={props.draft.takeProfit ?? ""} type="number" onChange={(event) => props.updateDraft({ takeProfit: Number(event.target.value) })} />
        </label>
        <label className="field">
          <span>Stop loss</span>
          <input value={props.draft.stopLoss ?? ""} type="number" onChange={(event) => props.updateDraft({ stopLoss: Number(event.target.value) })} />
        </label>
      </div>
      <div className="ticket-summary">
        <span>Source <strong>{source === "agent" ? "Agent draft" : "Manual input"}</strong></span>
        <span>Entry <strong>{fmtUsd(props.entryPrice, 1)}</strong></span>
        <span>Notional <strong>{fmtUsd(props.notional, 2)}</strong></span>
        <span>Margin <strong>{fmtUsd(props.marginRequired, 2)}</strong></span>
        <span>Est. liq <strong>{fmtUsd(props.liquidation, 1)}</strong></span>
        <span>Fees <strong>{fmtUsd(props.fees, 2)}</strong></span>
      </div>
      {blocked ? <p className="block-note">Live blocked by {props.eligibility.state}. Use paper mode.</p> : null}
      {largePaperOrder ? (
        <p className="paper-note">
          Large paper size: this order is above the simulated balance of {fmtUsd(props.simulatedBalanceUsd, 2)}.
        </p>
      ) : null}
      {props.apiStatus === "unavailable" ? (
        <p className="block-note">API unavailable. Paper submit will retry {API_BASE_URL}.</p>
      ) : null}
      <button className="primary-action" disabled={props.draft.sizeBtc <= 0 || blocked} onClick={props.openModal}>
        Review {props.mode} order
      </button>
    </div>
  );
}

function ImpactPanel(props: {
  base: string;
  impact: DraftImpact;
  exposureLabels: string[];
}) {
  return (
    <div className="panel impact-panel">
      <div className="panel-head tight">
        <div>
          <span>Impact on portfolio</span>
          <strong>Before confirmation</strong>
        </div>
      </div>
      <div className="impact-grid">
        <span>Est. notional <strong>{fmtUsd(props.impact.estimatedNotionalUsd, 2)}</strong></span>
        <span>Margin required <strong>{fmtUsd(props.impact.marginRequiredUsd, 2)}</strong></span>
        <span>Post-trade available <strong className={props.impact.postTradeAvailableUsd >= 0 ? "pos" : "neg"}>{fmtUsd(props.impact.postTradeAvailableUsd, 2)}</strong></span>
        <span>Added exposure <strong className={props.impact.addedExposureUsd >= 0 ? "pos" : "neg"}>{fmtUsd(props.impact.addedExposureUsd, 2)}</strong></span>
        <span>{props.base} concentration <strong>{fmtPct(props.impact.selectedMarketConcentrationPct, 1)}</strong></span>
        <span>Liq distance <strong>{fmtPct(props.impact.liquidationDistancePct, 1)}</strong></span>
      </div>
      <div className="risk-tags compact">
        {props.exposureLabels.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function AgentPanel(props: {
  base: string;
  agent: AgentResponse | undefined;
  agentQuestion: string | undefined;
  isThinking: boolean;
  runAgent: (scenario: AgentScenario) => void;
  runTypedAgent: (prompt: string) => void;
  sendToTicket: (draft: OrderDraft) => void;
  isStale: boolean;
}) {
  const [prompt, setPrompt] = useState("");

  function submitPrompt() {
    const next = prompt.trim();
    if (!next || props.isThinking) {
      return;
    }
    props.runTypedAgent(next);
    setPrompt("");
  }

  return (
    <div className="panel agent-panel">
      <div className="panel-head">
        <div>
          <span>{AGENT_PANEL_HEADING}</span>
          <strong>{props.isStale ? "Stale-data guard active" : "Agent market read"}</strong>
        </div>
      </div>
      <div className="prompt-chips">
        <button onClick={() => props.runAgent("long")}>Should I long {props.base}?</button>
        <button onClick={() => props.runAgent("explain")}>Explain funding + OI</button>
        <button onClick={() => props.runAgent("noTrade")}>Find cleaner setup</button>
      </div>
      <div className="agent-chat-box">
        <input
          aria-label="Ask Agent.trade"
          value={prompt}
          placeholder={`Ask about ${props.base} funding, OI, or a trade setup...`}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitPrompt();
            }
          }}
        />
        <button onClick={submitPrompt} disabled={!prompt.trim() || props.isThinking}>
          Send
        </button>
      </div>
      {props.agentQuestion ? (
        <div className="agent-user-message">
          <span>User</span>
          <p>{props.agentQuestion}</p>
        </div>
      ) : null}
      {props.isThinking ? <div className="thinking">Reading funding, OI, book pressure, and liquidation levels...</div> : null}
      {!props.isThinking && props.agent ? (
        <div className={`agent-answer ${props.agent.state}`}>
          <p className="agent-question">Agent.trade response</p>
          <h3>{props.agent.state === "noTrade" ? "No clean setup" : props.agent.state === "staleRefusal" ? "Refusing to draft" : "Market read"}</h3>
          <p>{props.agent.thesis}</p>
          <div className="receipt-row">
            {props.agent.receipts.map((item) => (
              <span key={item.label}>{item.label}: {item.value}</span>
            ))}
          </div>
          <div className="agent-risk">
            <strong>Risk</strong>
            <p>{props.agent.riskNote}</p>
            <strong>Why this could be wrong</strong>
            <p>{props.agent.whyWrong}</p>
          </div>
          {props.agent.orderDraft ? (
            <button className="secondary-action" onClick={() => props.sendToTicket(props.agent?.orderDraft as OrderDraft)}>
              Send to ticket
            </button>
          ) : null}
          {props.agent.followUps ? (
            <div className="prompt-chips followups">
              {props.agent.followUps.map((followUp) => <button key={followUp}>{followUp}</button>)}
            </div>
          ) : null}
        </div>
      ) : null}
      {!props.isThinking && !props.agent ? (
        <p className="agent-empty">Type a question or use a prompt chip for a setup, market explanation, or no-trade read. Outputs are structured and can drive chart annotations plus ticket prefill.</p>
      ) : null}
    </div>
  );
}

function BottomPanel(props: {
  snapshot: SharedTradingSnapshot;
  bottomTab: "positions" | "orders" | "fills";
  setBottomTab: (tab: "positions" | "orders" | "fills") => void;
}) {
  return (
    <div className="panel bottom-panel">
      <div className="bottom-tabs">
        <button className={props.bottomTab === "positions" ? "active" : ""} onClick={() => props.setBottomTab("positions")}>Positions</button>
        <button className={props.bottomTab === "orders" ? "active" : ""} onClick={() => props.setBottomTab("orders")}>Open orders</button>
        <button className={props.bottomTab === "fills" ? "active" : ""} onClick={() => props.setBottomTab("fills")}>Fills</button>
        <span>Equity {fmtUsd(props.snapshot.account.equityUsd, 2)} | Available {fmtUsd(props.snapshot.account.availableUsd, 2)}</span>
      </div>
      {props.bottomTab === "positions" ? (
        <div className="data-table">
          {props.snapshot.account.positions.map((position) => (
            <div key={positionRowKey(position)} className="data-row">
              <strong>{position.symbol}{position.mode === "paper" ? <span className="paper-ledger-badge">Paper</span> : null}</strong>
              <span className={position.side === "long" ? "pos" : "neg"}>{position.side} {position.size} {position.base}</span>
              <span>{position.leverage}x {position.marginMode}</span>
              <span>Entry {fmtUsd(position.entryPrice, 1)}</span>
              <span>PnL <b className={position.pnlUsd >= 0 ? "pos" : "neg"}>{fmtUsd(position.pnlUsd, 2)}</b></span>
              <span>Liq {fmtUsd(position.liquidationPrice, 1)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {props.bottomTab === "orders" ? (
        <div className="data-table">
          {props.snapshot.account.openOrders.map((order) => (
            <div key={`${order.mode ?? "demo"}-${order.symbol}-${order.side}-${order.timestamp}`} className="data-row">
              <strong>{order.symbol}{order.mode === "paper" ? <span className="paper-ledger-badge">Paper</span> : null}</strong>
              <span className={order.side === "buy" ? "pos" : "neg"}>{order.side}</span>
              <span>{order.type}</span>
              <span>{fmtUsd(order.price, 1)}</span>
              <span>{order.size}</span>
              <span>{order.reduceOnly ? "Reduce only" : "Open"}</span>
            </div>
          ))}
        </div>
      ) : null}
      {props.bottomTab === "fills" ? (
        <div className="data-table">
          {props.snapshot.account.fills.map((fill) => (
            <div key={fillRowKey(fill)} className="data-row">
              <strong>{fill.symbol}{fill.mode === "paper" ? <span className="paper-ledger-badge">Paper</span> : null}</strong>
              <span className={fill.side === "buy" ? "pos" : "neg"}>{fill.side}</span>
              <span>{fmtUsd(fill.price, 1)}</span>
              <span>{fill.size}</span>
              <span>Fee {fmtUsd(fill.feeUsd, 2)}</span>
              <span>{fmtAgo(fill.timestamp, props.snapshot.asOf)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function positionRowKey(position: SharedTradingSnapshot["account"]["positions"][number]): string {
  return [
    position.mode ?? "demo",
    position.symbol,
    position.side,
    position.lastFillId ?? position.updatedAt ?? position.entryPrice,
  ].join("-");
}

function fillRowKey(fill: SharedTradingSnapshot["account"]["fills"][number]): string {
  return [
    fill.mode ?? "demo",
    fill.symbol,
    fill.orderId ?? fill.timestamp,
    fill.side,
    fill.price,
    fill.size,
  ].join("-");
}

function ConfirmModal(props: {
  draft: OrderDraft;
  base: string;
  szDecimals: number;
  mode: "paper" | "live";
  entryPrice: number;
  notional: number;
  marginRequired: number;
  fees: number;
  liquidation: number;
  canLiveTrade: boolean;
  eligibility: EligibilityResponse;
  modalError: string | undefined;
  isAcked: boolean;
  setIsAcked: (value: boolean) => void;
  close: () => void;
  confirm: () => void;
  isConfirming: boolean;
}) {
  const liveBlocked = props.mode === "live" && !props.canLiveTrade;
  const source = getTicketSource(props.draft);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm order">
      <div className={`confirm-modal ${props.mode}`}>
        <div className="panel-head">
          <div>
            <span>{props.mode === "paper" ? "Paper confirmation" : "Live confirmation"}</span>
            <strong>{props.draft.symbol} {props.draft.side}</strong>
          </div>
          {source === "agent" ? <span className="from-agent-badge">From Agent</span> : null}
        </div>
        <div className="confirm-grid">
          <span>Market <strong>{props.draft.symbol}</strong></span>
          <span>Side <strong>{props.draft.side}</strong></span>
          <span>Source <strong>{source === "agent" ? "Agent draft" : "Manual input"}</strong></span>
          <span>Size <strong>{fmtNumber(props.draft.sizeBtc, props.szDecimals)} {props.base}</strong></span>
          <span>Order type <strong>{props.draft.orderType}</strong></span>
          <span>Leverage <strong>{props.draft.leverage}x</strong></span>
          <span>Margin mode <strong>{props.draft.marginMode}</strong></span>
          <span>Estimated entry <strong>{fmtUsd(props.entryPrice, 1)}</strong></span>
          <span>Est. liquidation <strong>{fmtUsd(props.liquidation, 1)}</strong></span>
          <span>TP <strong>{props.draft.takeProfit ? fmtUsd(props.draft.takeProfit, 1) : "Not set"}</strong></span>
          <span>SL <strong>{props.draft.stopLoss ? fmtUsd(props.draft.stopLoss, 1) : "Not set"}</strong></span>
          <span>Notional <strong>{fmtUsd(props.notional, 2)}</strong></span>
          <span>Est. fees <strong>{fmtUsd(props.fees, 2)}</strong></span>
        </div>
        <label className="ack-row">
          <input type="checkbox" checked={props.isAcked} onChange={(event) => props.setIsAcked(event.target.checked)} />
          {getConfirmationAckCopy(source)}
        </label>
        {props.mode === "paper" ? <p className="paper-note">Paper orders are simulated and never call /exchange.</p> : null}
        {liveBlocked ? <p className="block-note">Live blocked by {props.eligibility.state}.</p> : null}
        {props.modalError ? <p className="modal-error">{props.modalError}</p> : null}
        <div className="modal-actions">
          <button className="secondary-action" onClick={props.close}>Cancel</button>
          <button className="primary-action" disabled={!props.isAcked || liveBlocked || props.isConfirming} onClick={props.confirm}>
            {props.isConfirming ? "Submitting..." : `Confirm ${props.mode} order`}
          </button>
        </div>
      </div>
    </div>
  );
}
