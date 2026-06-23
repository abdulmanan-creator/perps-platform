import type { OrderDraft } from "./types";

export interface MarketOrderMeta {
  assetIndex: number;
  markPrice: number;
  szDecimals: number;
}

function formatOrderSize(size: number, szDecimals: number): string {
  return size.toFixed(Math.max(0, szDecimals));
}

function formatOrderPrice(price: number): string {
  if (price >= 10_000) {
    return price.toFixed(1);
  }
  if (price >= 1_000) {
    return price.toFixed(2);
  }
  if (price >= 1) {
    return price.toFixed(4);
  }
  return price.toFixed(6);
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
        p: formatOrderPrice(price),
        s: formatOrderSize(draft.sizeBtc, market.szDecimals),
        r: draft.reduceOnly,
        t: { limit: { tif: draft.orderType === "market" ? "Ioc" as const : "Gtc" as const } },
      },
    ],
  };
}

