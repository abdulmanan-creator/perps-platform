import { API_BASE_URL } from "../api";

import type { PaperAccountSnapshot, SharedTradingSnapshot } from "./types";

const PAPER_SESSION_STORAGE_KEY = "agent-trade-paper-session-id";

export function getPaperSessionId(): string {
  if (typeof window === "undefined") {
    return "server-paper-session";
  }

  const existing = window.localStorage.getItem(PAPER_SESSION_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const generated =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `paper-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(PAPER_SESSION_STORAGE_KEY, generated);
  return generated;
}

export function paperSessionHeaders(sessionId = getPaperSessionId()): Record<string, string> {
  return { "x-agent-trade-session-id": sessionId };
}

export async function loadPaperAccount(sessionId = getPaperSessionId()): Promise<PaperAccountSnapshot | undefined> {
  try {
    const res = await fetch(`${API_BASE_URL}/agent-trade/paper-account`, {
      cache: "no-store",
      headers: paperSessionHeaders(sessionId),
    });
    if (!res.ok) {
      return undefined;
    }
    return (await res.json()) as PaperAccountSnapshot;
  } catch {
    return undefined;
  }
}

export function mergePaperAccount(
  snapshot: SharedTradingSnapshot,
  paperAccount?: PaperAccountSnapshot,
): SharedTradingSnapshot {
  if (!paperAccount) {
    return snapshot;
  }

  const marginUsedUsd = snapshot.account.marginUsedUsd + paperAccount.marginUsedUsd;
  const unrealizedPnlUsd = snapshot.account.unrealizedPnlUsd + paperAccount.unrealizedPnlUsd;
  const equityUsd = snapshot.account.equityUsd + paperAccount.unrealizedPnlUsd;
  const availableUsd = Math.max(0, snapshot.account.availableUsd - paperAccount.marginUsedUsd);

  return {
    ...snapshot,
    account: {
      ...snapshot.account,
      equityUsd,
      availableUsd,
      marginUsedUsd,
      unrealizedPnlUsd,
      simulatedBalanceUsd: paperAccount.simulatedBalanceUsd,
      positions: [...paperAccount.positions, ...snapshot.account.positions],
      openOrders: [...paperAccount.openOrders, ...snapshot.account.openOrders],
      fills: [...paperAccount.fills, ...snapshot.account.fills],
    },
  };
}
