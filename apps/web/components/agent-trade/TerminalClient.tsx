"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { hexToSignature } from "viem";
import type { Time } from "lightweight-charts";

import { API_BASE_URL } from "@/lib/api";
import {
  getAccountReadinessDisplay,
  type AccountReadinessDisplay,
  type WalletReadinessSummary,
} from "@/lib/agent-trade/account-readiness";
import { DeterministicAgentService, type AgentScenario } from "@/lib/agent-trade/agent-service";
import { fmtAgo, fmtCompactUsd, fmtNumber, fmtPct, fmtUsd } from "@/lib/agent-trade/format";
import { loadTerminalCandles, loadTradingSnapshot } from "@/lib/agent-trade/data";
import { MOCK_TRADING_SNAPSHOT } from "@/lib/agent-trade/mock-data";
import { loadMarketDiscoverySnapshot, normalizeSymbol } from "@/lib/agent-trade/markets";
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
  annotationPriceLineTitle,
  buildFallbackTerminalChartData,
  getConfirmationAckCopy,
  getLiveDisabledReason,
  getTerminalFreshness,
  getTerminalEligibilityStatus,
  getTicketSource,
  paperOrderEndpoint,
  paperOrderFailureMessage,
  resolveTypedPromptMarket,
  terminalChartLabel,
  TERMINAL_CHART_INTERVALS,
  type TerminalChartData,
  type TerminalFreshness,
  type TerminalChartInterval,
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
const HAS_PRIVY = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
const LOCAL_DEV_WALLET: WalletReadinessSummary = { status: "local-dev" };

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
  if (HAS_PRIVY) {
    return <PrivyTerminalClient />;
  }
  return <TerminalExperience wallet={LOCAL_DEV_WALLET} />;
}

function PrivyTerminalClient() {
  const wallet = useTerminalWalletSummary();
  return <TerminalExperience wallet={wallet} />;
}

function useTerminalWalletSummary(): WalletReadinessSummary {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const activeWallet = useMemo(() => {
    const embedded = wallets.find((wallet) => wallet.walletClientType === "privy");
    return embedded ?? wallets[0];
  }, [wallets]);

  if (!ready) {
    return { status: "loading" };
  }
  if (authenticated && activeWallet) {
    return {
      status: "connected",
      address: activeWallet.address,
    };
  }
  return { status: "not-connected" };
}

function buildUnsupportedPromptMarketResponse(
  prompt: string,
  mentionedSymbol: string,
  snapshot: SharedTradingSnapshot,
): AgentResponse {
  return {
    id: `unsupported-${mentionedSymbol.toLowerCase()}-typed-market`,
    state: "noTrade",
    question: prompt,
    thesis:
      `${mentionedSymbol} is not available in the supported Hyperliquid market list for this terminal session. ` +
      `I am staying on ${snapshot.market.symbol} and will not draft an order for an unsupported symbol.`,
    receipts: [
      { label: "Requested market", value: mentionedSymbol, timestamp: snapshot.asOf },
      { label: "Active market", value: snapshot.market.symbol, timestamp: snapshot.asOf },
    ],
    riskNote: "No ticket draft was created. Open Markets or ask about the currently selected market.",
    whyWrong: "Ticker symbols can be ambiguous; Agent.trade only drafts against markets resolved from the shared market metadata.",
    annotations: [],
    followUps: [`Should I long ${snapshot.market.base}?`, `Should I short ${snapshot.market.base}?`, "Open Markets"],
  };
}

function TerminalExperience({ wallet }: { wallet: WalletReadinessSummary }) {
  const router = useRouter();
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
  const [now, setNow] = useState(() => Date.now());
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
  const [chartData, setChartData] = useState<TerminalChartData>(() =>
    buildFallbackTerminalChartData(MOCK_TRADING_SNAPSHOT.market, "15m", "Waiting for Hyperliquid candles."),
  );
  const [isLoadingCandles, setIsLoadingCandles] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoadingData(true);
      const result = await loadTradingSnapshot(requestedSymbol, {
        accountAddress: wallet.status === "connected" ? wallet.address : undefined,
      });
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
  }, [requestedSymbol, wallet.address, wallet.status]);

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
  const freshness = useMemo(
    () => getTerminalFreshness({
      now,
      marketAsOf: snapshot.asOf,
      candlesFetchedAt: chartData.fetchedAt,
      candlesFallback: chartData.isFallback,
      candlesError: chartData.error,
      accountUpdatedAt: snapshot.account.updatedAt,
      accountUnavailable: snapshot.account.liveAccountDataUnavailable,
      isLoadingMarket: isLoadingData,
      isLoadingCandles,
      apiStatus,
    }),
    [
      apiStatus,
      chartData.error,
      chartData.fetchedAt,
      chartData.isFallback,
      isLoadingCandles,
      isLoadingData,
      now,
      snapshot.account.liveAccountDataUnavailable,
      snapshot.account.updatedAt,
      snapshot.asOf,
    ],
  );
  const canLiveTrade = mode === "live" && eligibility.state === "liveEligible" && freshness.isDraftSafe;
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
      snapshot: {
        ...snapshot,
        market: { ...snapshot.market, dataAgeSeconds: freshness.marketAgeSeconds },
      },
      isStale: !freshness.isDraftSafe,
      accountFreshnessWarning: freshness.accountFreshness.warning,
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
    setMarketNotice(undefined);
    let agentSnapshot = snapshot;
    let agentFreshness = freshness;

    try {
      const discovery = await loadMarketDiscoverySnapshot();
      const promptMarket = resolveTypedPromptMarket({
        prompt: trimmed,
        currentSymbol: snapshot.market.symbol,
        supportedSymbols: discovery.markets.map((market) => market.symbol),
      });

      if (promptMarket.unsupported && promptMarket.mentionedSymbol) {
        setAgent(buildUnsupportedPromptMarketResponse(trimmed, promptMarket.mentionedSymbol, snapshot));
        setAnnotations([]);
        setIsThinking(false);
        return;
      }

      if (promptMarket.resolvedSymbol && !promptMarket.isCurrentMarket) {
        setIsLoadingData(true);
        const result = await loadTradingSnapshot(promptMarket.resolvedSymbol, {
          accountAddress: wallet.status === "connected" ? wallet.address : undefined,
        });
        if (result.usedFallback || normalizeSymbol(result.resolvedSymbol) !== promptMarket.resolvedSymbol) {
          setAgent(buildUnsupportedPromptMarketResponse(trimmed, promptMarket.resolvedSymbol, snapshot));
          setAnnotations([]);
          setIsLoadingData(false);
          setIsThinking(false);
          return;
        }

        const nextSnapshot = result.snapshot;
        setIsLoadingCandles(true);
        const nextChartData = await loadTerminalCandles(nextSnapshot.market, chartData.interval);
        const nextNow = Date.now();
        agentSnapshot = nextSnapshot;
        agentFreshness = getTerminalFreshness({
          now: nextNow,
          marketAsOf: nextSnapshot.asOf,
          candlesFetchedAt: nextChartData.fetchedAt,
          candlesFallback: nextChartData.isFallback,
          candlesError: nextChartData.error,
          accountUpdatedAt: nextSnapshot.account.updatedAt,
          accountUnavailable: nextSnapshot.account.liveAccountDataUnavailable,
          apiStatus: "ok",
        });

        setNow(nextNow);
        setSnapshot(nextSnapshot);
        setChartData(nextChartData);
        setDraft(buildDefaultDraft(nextSnapshot));
        setApiStatus("ok");
        setIsLoadingData(false);
        setIsLoadingCandles(false);
        router.replace(`/terminal?symbol=${encodeURIComponent(result.resolvedSymbol)}`, { scroll: false });
      }
    } catch {
      const mentionedSymbol = resolveTypedPromptMarket({
        prompt: trimmed,
        currentSymbol: snapshot.market.symbol,
        supportedSymbols: [snapshot.market.base],
      }).mentionedSymbol;
      if (mentionedSymbol) {
        setAgent(buildUnsupportedPromptMarketResponse(trimmed, mentionedSymbol, snapshot));
        setAnnotations([]);
        setIsLoadingData(false);
        setIsLoadingCandles(false);
        setIsThinking(false);
        return;
      }
      setIsLoadingData(false);
      setIsLoadingCandles(false);
    }

    const response = await agentService.runPrompt({
      prompt: trimmed,
      snapshot: {
        ...agentSnapshot,
        market: { ...agentSnapshot.market, dataAgeSeconds: agentFreshness.marketAgeSeconds },
      },
      isStale: !agentFreshness.isDraftSafe,
      accountFreshnessWarning: agentFreshness.accountFreshness.warning,
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
      const refreshed = await loadTradingSnapshot(snapshot.market.base, {
        accountAddress: wallet.status === "connected" ? wallet.address : undefined,
      });
      setSnapshot(refreshed.snapshot);
      setSubmitState(`Paper fill recorded. Position updated: ${json.id} (${fmtUsd(json.notionalUsd, 2)} notional).`);
    } catch (err) {
      setApiStatus("unavailable");
      throw new Error(paperOrderFailureMessage(err, endpoint));
    }
  }

  const accountReadiness = getAccountReadinessDisplay({
    wallet,
    eligibilityState: eligibility.state,
    accountValueKind: snapshot.account.valueKind,
    liveAccountDataLoaded: snapshot.account.liveAccountDataLoaded,
    liveAccountDataUnavailable: snapshot.account.liveAccountDataUnavailable,
  });

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
    <div className="terminal-shell">
      <TerminalRail />
      <main className="terminal-workspace">
        <TerminalMarketHeader
          snapshot={snapshot}
          eligibility={eligibility}
          eligibilityStatus={eligibilityStatus}
          mode={mode}
          setMode={setMode}
          apiStatus={apiStatus}
          freshness={freshness}
          isLoadingData={isLoadingData}
          marketNotice={marketNotice}
          accountReadiness={accountReadiness}
        />
        {apiStatus !== "ok" ? (
          <TerminalStatusBanner
            eligibilityStatus={eligibilityStatus}
            apiStatus={apiStatus}
            apiBaseUrl={API_BASE_URL}
          />
        ) : null}

        <section className="terminal-grid">
          <div className="terminal-chart-stack">
            <ChartPanel
              snapshot={snapshot}
              annotations={annotations}
              chartData={chartData}
              setChartData={setChartData}
              isLoadingCandles={isLoadingCandles}
              setIsLoadingCandles={setIsLoadingCandles}
            />
            <BottomPanel
              snapshot={snapshot}
              bottomTab={bottomTab}
              setBottomTab={setBottomTab}
            />
          </div>
          <div className="terminal-book-stack">
            <BookPanel snapshot={snapshot} maxBookSize={maxBookSize} />
            <TradesPanel snapshot={snapshot} />
          </div>
          <div className="terminal-ticket-stack">
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
              accountReadiness={accountReadiness}
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
          <div className="terminal-agent-stack">
            <AgentPanel
              base={snapshot.market.base}
              agent={agent}
              agentQuestion={agentQuestion}
              isThinking={isThinking}
              runAgent={runAgent}
              runTypedAgent={runTypedAgent}
              sendToTicket={sendToTicket}
              freshness={freshness}
            />
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
    </div>
  );
}

function TerminalRail() {
  const items = [
    { href: "/terminal", label: "Terminal", active: true },
    { href: "/markets", label: "Markets" },
    { href: "/portfolio", label: "Portfolio" },
    { href: "/rewards", label: "Strategy Builder" },
    { href: "/settings", label: "Settings" },
  ];

  return (
    <aside className="terminal-rail" aria-label="Agent.trade terminal navigation">
      <Link href="/" className="terminal-rail-brand">
        <span>AT</span>
        <strong>Agent.trade</strong>
      </Link>
      <nav>
        {items.map((item) => (
          <Link key={item.label} href={item.href} className={item.active ? "active" : ""}>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="terminal-rail-note">
        <span>Execution</span>
        <strong>Testnet default</strong>
        <p>Mainnet execution remains disabled unless explicitly enabled and allowlisted.</p>
      </div>
    </aside>
  );
}

function TerminalMarketHeader({
  snapshot,
  eligibility,
  eligibilityStatus,
  mode,
  setMode,
  apiStatus,
  freshness,
  isLoadingData,
  marketNotice,
  accountReadiness,
}: {
  snapshot: SharedTradingSnapshot;
  eligibility: EligibilityResponse;
  eligibilityStatus: ReturnType<typeof getTerminalEligibilityStatus>;
  mode: "paper" | "live";
  setMode: (mode: "paper" | "live") => void;
  apiStatus: "checking" | "ok" | "unavailable";
  freshness: TerminalFreshness;
  isLoadingData: boolean;
  marketNotice: string | undefined;
  accountReadiness: AccountReadinessDisplay;
}) {
  const marketStats = [
    ["Mark", fmtUsd(snapshot.market.markPrice, 1)],
    ["Oracle", fmtUsd(snapshot.market.oraclePrice, 1)],
    ["24h", `${fmtPct(snapshot.market.change24hPct, 2)} ${fmtUsd(snapshot.market.change24hAbs, 1)}`],
    ["Volume", fmtCompactUsd(snapshot.market.volume24hUsd)],
    ["Open interest", fmtCompactUsd(snapshot.market.openInterestUsd)],
    ["OI 24h", snapshot.market.openInterestChangePct === null ? "--" : fmtPct(snapshot.market.openInterestChangePct, 1)],
    ["Funding", fmtPct(snapshot.market.fundingRatePct, 4)],
    ["Next", `${snapshot.market.nextFundingMinutes}m`],
  ];
  const accountLabelPrefix = accountReadiness.accountValueKind === "real" || accountReadiness.accountValueKind === "hybrid"
    ? "Account"
    : "Paper";
  const accountStats = [
    [`${accountLabelPrefix} equity`, fmtUsd(snapshot.account.equityUsd, 2)],
    [`${accountLabelPrefix} available`, fmtUsd(snapshot.account.availableUsd, 2)],
    ["Unrealized", fmtUsd(snapshot.account.unrealizedPnlUsd, 2)],
  ];

  return (
    <header className="terminal-market-header">
      <div className="terminal-pair-block">
        <span className="terminal-venue">{snapshot.market.venue}</span>
        <h1>{snapshot.market.symbol}</h1>
        <div className="terminal-pair-subline">
          <span className={snapshot.market.change24hPct >= 0 ? "pos" : "neg"}>{fmtPct(snapshot.market.change24hPct, 2)} 24h</span>
          <span>{snapshot.market.source === "live-mainnet" ? "Mainnet read-only market data" : "Deterministic market snapshot"}</span>
        </div>
        {marketNotice ? <p className="market-notice">{marketNotice}</p> : null}
      </div>
      <div className="terminal-header-stats" aria-label="Market stats">
        {marketStats.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{isLoadingData ? "..." : value}</strong>
          </div>
        ))}
      </div>
      <div className="terminal-account-strip" aria-label="Account state">
        <div className="account-source-cell">
          <span>{accountReadiness.label}</span>
          <strong>{compactAccountValueLabel(accountReadiness)}</strong>
        </div>
        {accountStats.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong className={label === "Unrealized" && snapshot.account.unrealizedPnlUsd < 0 ? "neg" : ""}>{value}</strong>
          </div>
        ))}
      </div>
      <div className="terminal-header-actions">
        <span
          className={freshness.marketFreshness.state === "fresh" ? "state-pill live" : "state-pill stale"}
          title={freshness.marketFreshness.detail}
        >
          {freshness.label}
        </span>
        {freshness.accountFreshness.warning ? (
          <span className="state-pill account-warning" title={freshness.accountFreshness.detail}>
            Account values may be stale
          </span>
        ) : null}
        <ModeControl eligibility={eligibility} mode={mode} setMode={setMode} />
        <span className={`terminal-eligibility-pill ${eligibilityStatus.tone}`}>
          {apiStatus === "unavailable" ? "API unavailable" : accountReadiness.summary}
        </span>
      </div>
    </header>
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
        title={liveDisabled ? getLiveDisabledReason(eligibility.state) : "Live eligible"}
      >
        Live
      </button>
    </div>
  );
}

function compactAccountValueLabel(readiness: AccountReadinessDisplay): string {
  switch (readiness.accountValueKind) {
    case "paper":
      return "Simulated";
    case "real":
      return "Read-only live";
    case "hybrid":
      return "Live + paper";
    case "unavailable":
      return "Unavailable";
    default:
      return assertNeverAccountValueKind(readiness.accountValueKind);
  }
}

function assertNeverAccountValueKind(value: never): never {
  throw new Error(`Unexpected account value kind: ${String(value)}`);
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
  chartData,
  setChartData,
  isLoadingCandles,
  setIsLoadingCandles,
}: {
  snapshot: SharedTradingSnapshot;
  annotations: ChartAnnotation[];
  chartData: TerminalChartData;
  setChartData: (data: TerminalChartData) => void;
  isLoadingCandles: boolean;
  setIsLoadingCandles: (value: boolean) => void;
}) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const [interval, setInterval] = useState<TerminalChartInterval>("15m");
  const candles = chartData.candles;

  useEffect(() => {
    let cancelled = false;

    async function loadCandles() {
      setIsLoadingCandles(true);
      const next = await loadTerminalCandles(snapshot.market, interval);
      if (!cancelled) {
        setChartData(next);
        setIsLoadingCandles(false);
      }
    }

    void loadCandles();
    return () => {
      cancelled = true;
    };
  }, [interval, snapshot.market]);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    async function renderChart() {
      const container = chartRef.current;
      if (!container) {
        return;
      }
      const { createChart, CrosshairMode } = await import("lightweight-charts");
      if (disposed || !chartRef.current) {
        return;
      }

      const chart = createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
        autoSize: true,
        layout: {
          background: { color: "#070a12" },
          textColor: "#8f9bb7",
          fontFamily: "Inter, system-ui, sans-serif",
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: "rgba(255,255,255,0.045)" },
          horzLines: { color: "rgba(255,255,255,0.06)" },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: "rgba(180,190,255,0.35)", labelBackgroundColor: "#1c2440" },
          horzLine: { color: "rgba(180,190,255,0.35)", labelBackgroundColor: "#1c2440" },
        },
        rightPriceScale: {
          borderColor: "rgba(255,255,255,0.08)",
          scaleMargins: { top: 0.08, bottom: 0.24 },
        },
        timeScale: {
          borderColor: "rgba(255,255,255,0.08)",
          timeVisible: true,
          secondsVisible: false,
        },
      });

      const candleSeries = chart.addCandlestickSeries({
        upColor: "#27d6aa",
        downColor: "#ff5c6c",
        borderUpColor: "#27d6aa",
        borderDownColor: "#ff5c6c",
        wickUpColor: "#27d6aa",
        wickDownColor: "#ff5c6c",
      });
      candleSeries.setData(
        candles.map((candle) => ({
          time: candle.time as Time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        })),
      );
      annotations.forEach((annotation) => {
        candleSeries.createPriceLine({
          price: annotation.price,
          color: annotationToneColor(annotation.tone),
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: annotationPriceLineTitle(annotation),
        });
      });

      const volumeSeries = chart.addHistogramSeries({
        color: "rgba(91,99,255,0.32)",
        priceFormat: { type: "volume" },
        priceScaleId: "",
      });
      volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.78, bottom: 0 },
      });
      volumeSeries.setData(
        candles.map((candle) => ({
          time: candle.time as Time,
          value: candle.volume,
          color: candle.close >= candle.open ? "rgba(39,214,170,0.24)" : "rgba(255,92,108,0.24)",
        })),
      );

      chart.timeScale().fitContent();
      cleanup = () => chart.remove();
    }

    void renderChart();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [annotations, candles]);

  const sourceLabel = terminalChartLabel(chartData);

  return (
    <div className="panel chart-panel">
      <div className="panel-head">
        <div>
          <span>{snapshot.market.base} perpetual</span>
          <strong>{chartData.source === "hyperliquid" ? `${interval} Hyperliquid candles` : `${interval} fallback candles`}</strong>
        </div>
        <div className="timeframes">
          {TERMINAL_CHART_INTERVALS.map((tf) => (
            <button key={tf} className={tf === interval ? "active" : ""} onClick={() => setInterval(tf)}>
              {tf}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-canvas" ref={chartRef} role="img" aria-label={`${snapshot.market.base} candlestick chart with agent annotations`} />
      <div className="chart-disclaimer">
        <span>{isLoadingCandles ? `Loading ${interval} Hyperliquid candles...` : sourceLabel}</span>
        {chartData.error ? <span className="chart-degraded-note">{chartData.error}</span> : null}
        {annotations.length > 0 ? <strong>{annotations.length} agent annotation{annotations.length === 1 ? "" : "s"}</strong> : null}
      </div>
    </div>
  );
}

function annotationToneColor(tone: ChartAnnotation["tone"]): string {
  switch (tone) {
    case "green":
      return "#27d6aa";
    case "red":
      return "#ff5c6c";
    case "amber":
      return "#f0a23a";
    case "blue":
    default:
      return "#5b63ff";
  }
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
  accountReadiness: AccountReadinessDisplay;
  openModal: () => void;
}) {
  const blocked = props.mode === "live" && !props.canLiveTrade;
  const source = getTicketSource(props.draft);
  const largePaperOrder = props.mode === "paper" && props.notional > props.simulatedBalanceUsd;
  const liveDisabledReason = getLiveDisabledReason(props.eligibility.state);
  return (
    <div className={`panel ticket-panel ${source === "agent" ? "from-agent" : ""}`}>
      <div className="panel-head">
        <div>
          <span>Order ticket</span>
          <strong>{source === "agent" ? "From Agent" : "Manual"}</strong>
        </div>
        <span className={props.mode === "paper" ? "paper-badge" : "live-badge"}>{props.mode}</span>
      </div>
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
        <div className="input-with-action">
          <input
            value={props.draft.sizeBtc}
            type="number"
            min="0"
            step={1 / 10 ** props.szDecimals}
            onChange={(event) => props.updateDraft({ sizeBtc: Number(event.target.value) })}
          />
          <button
            type="button"
            onClick={() =>
              props.updateDraft({
                sizeBtc: Number(Math.max(1 / 10 ** props.szDecimals, props.simulatedBalanceUsd / props.entryPrice / props.draft.leverage).toFixed(props.szDecimals)),
              })
            }
          >
            Max
          </button>
        </div>
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
        <span>Account <strong>{props.accountReadiness.accountValueKind === "real" ? "Read-only live" : props.accountReadiness.accountValueKind === "hybrid" ? "Live + paper" : "Paper"}</strong></span>
        <span>Entry <strong>{fmtUsd(props.entryPrice, 1)}</strong></span>
        <span>Notional <strong>{fmtUsd(props.notional, 2)}</strong></span>
        <span>Margin <strong>{fmtUsd(props.marginRequired, 2)}</strong></span>
        <span>Est. liq <strong>{fmtUsd(props.liquidation, 1)}</strong></span>
        <span>Fees <strong>{fmtUsd(props.fees, 2)}</strong></span>
      </div>
      {blocked ? <p className="block-note">{liveDisabledReason} Use paper mode.</p> : null}
      <p className="account-mode-note">{props.accountReadiness.summary}</p>
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
  freshness: TerminalFreshness;
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
          <strong>{props.freshness.isDraftSafe ? "Agent market read" : "Drafting paused for market refresh"}</strong>
        </div>
      </div>
      <div className="prompt-chips">
        <button onClick={() => props.runAgent("long")}>Should I long {props.base}?</button>
        <button onClick={() => props.runAgent("short")}>Should I short {props.base}?</button>
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
        <p className="agent-empty">Ask about setups, funding, OI, liquidations, or risk. I can annotate the chart and prefill the ticket.</p>
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
        {liveBlocked ? <p className="block-note">{getLiveDisabledReason(props.eligibility.state)}</p> : null}
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
