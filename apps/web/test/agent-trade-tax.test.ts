import { describe, expect, it } from "vitest";

import type { UserFill } from "@alchemy-hl/shared";

import {
  buildAgentTradeTaxCsv,
  buildHyperliquidFillsCsv,
  buildTaxFillsUrl,
  isValidTaxWallet,
  marketLabel,
  normalizeTaxFill,
  TAX_CSV_COLUMNS,
} from "../lib/agent-trade/tax";

const wallet = "0x4da360ca0da696ba4d56d94c3ef2d4ba4f26cb43";

const hip4Fill: UserFill = {
  coin: "#1890",
  px: "0.6400",
  sz: "10",
  side: "B",
  time: Date.UTC(2026, 5, 1, 12, 0, 0),
  oid: 101,
  tid: 202,
  hash: "0xabc",
  dir: "Open Long",
  fee: "0.0100",
  builderFee: "0.0025",
  closedPnl: "0.0",
};

describe("Agent.trade tax export helpers", () => {
  it("normalizes HIP-4 outcome fills without losing fees", () => {
    const row = normalizeTaxFill(hip4Fill, wallet, "hyperliquid_audit_unavailable");

    expect(row).toMatchObject({
      timestamp: "2026-06-01T12:00:00.000Z",
      wallet,
      venue: "Hyperliquid",
      market: "HIP-4 outcome #1890",
      coin: "#1890",
      side: "buy",
      direction: "Open Long",
      price: "0.6400",
      size: "10",
      notional: "6.4",
      fee: "0.0100",
      builderFee: "0.0025",
      feeToken: "USDC",
      closedPnl: "0.0",
      hash: "0xabc",
      oid: "101",
      tid: "202",
      source: "hyperliquid_audit_unavailable",
    });
  });

  it("builds an Agent.trade CSV with stable columns", () => {
    const csv = buildAgentTradeTaxCsv({ wallet, fills: [hip4Fill] });
    const [header, row] = csv.split("\n");

    expect(header).toBe(TAX_CSV_COLUMNS.join(","));
    expect(row).toContain("HIP-4 outcome #1890");
    expect(row).toContain("0.0100");
    expect(row).toContain("0.0025");
    expect(row).toContain("hyperliquid_audit_unavailable");
  });

  it("builds a Hyperliquid-only CSV and preserves an empty year as header-only", () => {
    const csv = buildHyperliquidFillsCsv({ wallet, fills: [] });

    expect(csv).toBe(TAX_CSV_COLUMNS.join(","));
  });

  it("labels perps and validates wallet URLs", () => {
    expect(marketLabel("HYPE")).toBe("HYPE-USD");
    expect(isValidTaxWallet(wallet)).toBe(true);
    expect(isValidTaxWallet("nope")).toBe(false);
    expect(buildTaxFillsUrl({ wallet, year: 2026 }, "http://localhost:8080")).toBe(
      `http://localhost:8080/agent-trade/tax/fills?user=${wallet}&year=2026`,
    );
  });
});
