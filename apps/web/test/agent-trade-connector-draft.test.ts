import { describe, expect, it } from "vitest";

import { encodeConnectorDraftParam, parseConnectorDraftParam } from "../lib/agent-trade/connector-draft";

describe("Agent.trade connector drafts", () => {
  it("parses a valid draft with explicit leverage", () => {
    const parsed = parseConnectorDraftParam(encodeConnectorDraftParam({
      v: 1,
      source: "claude",
      symbol: "BTC",
      side: "long",
      orderType: "market",
      sizeBtc: 0.01,
      leverage: 2,
      marginMode: "isolated",
    }));

    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") {
      throw new Error("expected valid connector draft");
    }
    expect(parsed.payload.leverage).toBe(2);
    expect(parsed.draft.leverage).toBe(2);
  });

  it("rejects missing leverage before a connector draft can prefill a ticket", () => {
    const parsed = parseConnectorDraftParam(
      encodeURIComponent(JSON.stringify({
        v: 1,
        symbol: "BTC",
        side: "long",
        orderType: "market",
        sizeBtc: 0.01,
        marginMode: "isolated",
      })),
    );

    expect(parsed).toMatchObject({
      status: "invalid",
      message: "Connector draft leverage must be an integer from 1 to 50.",
    });
  });
});
