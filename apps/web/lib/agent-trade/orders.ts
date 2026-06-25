import type { OrderDraft } from "./types";

export interface MarketOrderMeta {
  assetIndex: number;
  markPrice: number;
  szDecimals: number;
  isSpot?: boolean;
}

function toDecString(value: string | number): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Number.isFinite(value)) {
    throw new Error(`Non-finite number: ${value}`);
  }
  return value.toFixed(10).replace(/\.?0+$/u, "");
}

export function formatOrderSize(size: string | number, szDecimals: number): string {
  const value = typeof size === "number" ? size : Number(size);
  if (!Number.isFinite(value)) {
    throw new Error(`Non-finite size: ${size}`);
  }
  const factor = 10 ** szDecimals;
  const truncated = Math.trunc(value * factor) / factor;
  return toDecString(truncated);
}

const MAX_PRICE_DECIMALS_PERPS = 6;
const MAX_PRICE_DECIMALS_SPOT = 8;
const MAX_PRICE_SIG_FIGS = 5;

export function formatOrderPrice(price: string | number, szDecimals: number, isSpot = false): string {
  const value = typeof price === "number" ? price : Number(price);
  if (!Number.isFinite(value)) {
    throw new Error(`Non-finite price: ${price}`);
  }
  if (value === 0) {
    return "0";
  }

  // Mirrors packages/sdk/src/actions.ts: Hyperliquid caps price decimals by
  // asset size precision and then applies a five-significant-figure ceiling.
  const maxDecimals = isSpot ? MAX_PRICE_DECIMALS_SPOT : MAX_PRICE_DECIMALS_PERPS;
  const decimalsAllowed = Math.max(0, maxDecimals - szDecimals);
  const decimalRounded = Number(value.toFixed(decimalsAllowed));
  const exp = Math.floor(Math.log10(Math.abs(decimalRounded)));
  const decimalsForSigFigs = Math.max(0, MAX_PRICE_SIG_FIGS - 1 - exp);
  const finalDecimals = Math.min(decimalsAllowed, decimalsForSigFigs);
  const rounded = Number(decimalRounded.toFixed(finalDecimals));
  return toDecString(rounded);
}

export function buildHlOrderAction(draft: OrderDraft, market: MarketOrderMeta) {
  const isBuy = draft.side === "long";
  const price =
    draft.orderType === "limit" && draft.limitPrice
      ? draft.limitPrice
      : isBuy
        ? market.markPrice * 1.005
        : market.markPrice * 0.995;

  return {
    type: "order" as const,
    grouping: "na" as const,
    orders: [
      {
        a: market.assetIndex,
        b: isBuy,
        p: formatOrderPrice(price, market.szDecimals, market.isSpot),
        s: formatOrderSize(draft.sizeBtc, market.szDecimals),
        r: draft.reduceOnly,
        t: { limit: { tif: draft.orderType === "market" ? "Ioc" as const : "Gtc" as const } },
      },
    ],
  };
}
