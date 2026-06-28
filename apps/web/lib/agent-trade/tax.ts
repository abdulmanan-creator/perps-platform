import type { UserFill } from "@alchemy-hl/shared";

import { API_BASE_URL } from "../api";

export const AWAKEN_URL = "https://awaken.tax/";

export const TAX_CSV_COLUMNS = [
  "timestamp",
  "wallet",
  "venue",
  "market",
  "coin",
  "side",
  "direction",
  "price",
  "size",
  "notional",
  "fee",
  "builderFee",
  "feeToken",
  "closedPnl",
  "hash",
  "oid",
  "tid",
  "source",
  "requestId",
  "route",
] as const;

export type TaxCsvColumn = (typeof TAX_CSV_COLUMNS)[number];
export type TaxCsvSource = "hyperliquid" | "hyperliquid_audit_unavailable";

export interface TaxFillsApiResponse {
  user: `0x${string}`;
  year: number;
  startTime: number;
  endTime: number;
  fills: UserFill[];
  source: "hyperliquid";
  audit: {
    enabled: boolean;
    reconciliation: "unavailable" | "not_joined";
  };
}

export type TaxCsvRow = Record<TaxCsvColumn, string>;

export interface TaxCsvBuildInput {
  wallet: string;
  fills: UserFill[];
  source: TaxCsvSource;
}

export function taxYearOptions(now = new Date()): number[] {
  const current = now.getUTCFullYear();
  return [current, current - 1, current - 2, current - 3, current - 4];
}

export function isValidTaxWallet(input: string): input is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(input.trim());
}

export function buildTaxFillsUrl(args: { wallet: string; year: number }, apiBaseUrl = API_BASE_URL): string {
  const url = new URL(`${apiBaseUrl}/agent-trade/tax/fills`);
  url.searchParams.set("user", args.wallet.trim());
  url.searchParams.set("year", String(args.year));
  return url.toString();
}

export async function fetchTaxFills(args: { wallet: string; year: number }): Promise<TaxFillsApiResponse> {
  const res = await fetch(buildTaxFillsUrl(args), { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Tax export fetch failed with HTTP ${res.status}`);
  }
  return await res.json() as TaxFillsApiResponse;
}

export function buildAgentTradeTaxCsv(input: Omit<TaxCsvBuildInput, "source">): string {
  return buildTaxCsv({ ...input, source: "hyperliquid_audit_unavailable" });
}

export function buildHyperliquidFillsCsv(input: Omit<TaxCsvBuildInput, "source">): string {
  return buildTaxCsv({ ...input, source: "hyperliquid" });
}

export function buildTaxCsv(input: TaxCsvBuildInput): string {
  const rows = input.fills.map((fill) => normalizeTaxFill(fill, input.wallet, input.source));
  return [
    TAX_CSV_COLUMNS.join(","),
    ...rows.map((row) => TAX_CSV_COLUMNS.map((column) => csvEscape(row[column])).join(",")),
  ].join("\n");
}

export function normalizeTaxFill(fill: UserFill, wallet: string, source: TaxCsvSource): TaxCsvRow {
  const direction = fill.dir ?? "";
  const rowSource = isInternalTransferLikeFill(fill) ? `${source}:internal_transfer` : source;
  return {
    timestamp: timestampIso(fill.time),
    wallet: wallet.trim().toLowerCase(),
    venue: "Hyperliquid",
    market: marketLabel(fill.coin),
    coin: fill.coin,
    side: sideLabel(fill.side),
    direction,
    price: fill.px,
    size: fill.sz,
    notional: decimalProduct(fill.px, fill.sz),
    fee: fill.fee ?? "",
    builderFee: fill.builderFee ?? "",
    feeToken: "USDC",
    closedPnl: fill.closedPnl ?? "",
    hash: fill.hash ?? "",
    oid: fill.oid == null ? "" : String(fill.oid),
    tid: fill.tid == null ? "" : String(fill.tid),
    source: rowSource,
    requestId: "",
    route: "",
  };
}

export function marketLabel(coin: string): string {
  if (/^#\d+$/.test(coin)) {
    return `HIP-4 outcome ${coin}`;
  }
  if (coin.includes("/")) {
    return coin;
  }
  if (coin.endsWith("-USD") || coin.endsWith("-USDC")) {
    return coin;
  }
  return `${coin}-USD`;
}

export function sideLabel(side: UserFill["side"]): "buy" | "sell" {
  return side === "B" ? "buy" : "sell";
}

export function csvFileName(args: { kind: "agent-trade" | "hyperliquid-fills"; wallet: string; year: number }): string {
  const suffix = args.wallet.trim().slice(0, 10).toLowerCase();
  return `${args.kind}-${args.year}-${suffix}.csv`;
}

function timestampIso(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "";
  }
  return new Date(ms).toISOString();
}

function csvEscape(input: string): string {
  if (!/[",\n\r]/.test(input)) {
    return input;
  }
  return `"${input.replace(/"/g, '""')}"`;
}

function decimalProduct(left: string, right: string): string {
  const product = Number(left) * Number(right);
  if (!Number.isFinite(product)) {
    return "";
  }
  return trimDecimal(product.toFixed(12));
}

function trimDecimal(input: string): string {
  return input.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function isInternalTransferLikeFill(fill: UserFill): boolean {
  return /transfer|deposit|withdraw/i.test(fill.dir ?? "");
}
