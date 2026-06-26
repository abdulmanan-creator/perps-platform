/**
 * Thin fetch wrapper for Hyperliquid's REST endpoints.
 *
 *   POST <base>/exchange   — submit a signed action
 *   POST <base>/info       — read endpoints (meta, spotMeta, maxBuilderFee, …)
 *
 * We expose two methods: forwardExchange (used by /exchange Phase B) and
 * info (used by /approval, /markets, /openOrders, /orderStatus).
 */

import { ApiException } from "../errors.js";

export interface HlClientOptions {
  baseUrl: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Logger for outbound requests. */
  logger?: { warn: (obj: unknown, msg?: string) => void };
}

export interface ExchangePayload {
  action: unknown;
  nonce: number;
  signature: { r: `0x${string}`; s: `0x${string}`; v: number };
  vaultAddress?: `0x${string}`;
}

export type HlOrderResultStatus = "filled" | "resting" | "accepted" | "rejected";

export interface HlExchangeResult {
  status: HlOrderResultStatus;
  label: string;
  reason?: string;
}

export class HlClient {
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly logger?: HlClientOptions["logger"];

  constructor(opts: HlClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl;
    this.logger = opts.logger;
  }

  /** Resolve fetch at call-time so test-side vi.spyOn(globalThis, "fetch") takes effect. */
  private get fetcher(): typeof fetch {
    return this.fetchImpl ?? globalThis.fetch;
  }

  /** POST a signed action to /exchange. */
  forwardExchange(payload: ExchangePayload): Promise<unknown> {
    return this.post("/exchange", payload);
  }

  /** POST a query to /info. The shape of `body` depends on the `type`. */
  info<T = unknown>(body: { type: string; [k: string]: unknown }): Promise<T> {
    return this.post<T>("/info", body);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger?.warn({ err, path }, "hl_unreachable");
      throw new ApiException(
        "HL_EXCHANGE_UNREACHABLE",
        "Could not reach Hyperliquid.",
        "Network error talking to api.hyperliquid.xyz. Retry — if it persists, check Hyperliquid status.",
      );
    }

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Hyperliquid sometimes returns plain text on protocol errors.
      parsed = { raw: text };
    }

    if (!res.ok) {
      // On rejection log the exact request body too, so we can diff our wire
      // format against HL's expectations. Captured on warn so this only
      // surfaces on failure, not for every successful call.
      this.logger?.warn(
        { status: res.status, body: parsed, path, sentBody: body },
        "hl_rejected",
      );
      throw new ApiException(
        "HL_EXCHANGE_REJECTED",
        `Hyperliquid rejected the request (HTTP ${res.status}).`,
        "Check the upstream error in the response body. Common causes: insufficient margin, bad price tick, asset not tradable.",
      );
    }

    // /exchange responses look like:
    //   { status: "ok", response: { type: "order"|"cancel"|..., data: ... } }
    //   { status: "err", response: "human readable reason" }
    if (
      path === "/exchange" &&
      typeof parsed === "object" &&
      parsed !== null &&
      "status" in parsed &&
      (parsed as { status: unknown }).status === "err"
    ) {
      const reason = (parsed as { response?: unknown }).response;
      this.logger?.warn({ reason }, "hl_rejected_application");
      const reasonStr = typeof reason === "string" ? reason : "Hyperliquid rejected the action.";

      // Specific case: HL refuses *any* user-signed action (including
      // approveBuilderFee) until the wallet has deposited into Hyperliquid.
      // Surface a targeted code so the UI can render a deposit affordance
      // instead of the generic error banner.
      if (/Must deposit before performing actions/i.test(reasonStr)) {
        const isTestnet = this.baseUrl.includes("testnet");
        const depositUrl = isTestnet
          ? "https://app.hyperliquid-testnet.xyz/drip"
          : "https://app.hyperliquid.xyz/portfolio";
        throw new ApiException(
          "NEEDS_DEPOSIT",
          reasonStr,
          isTestnet
            ? `Claim testnet USDC at ${depositUrl}, then retry.`
            : `Deposit USDC into your Hyperliquid account at ${depositUrl}, then retry. Even gas-free actions like approveBuilderFee require a funded account.`,
        );
      }

      throw new ApiException(
        "HL_EXCHANGE_REJECTED",
        reasonStr,
        "Hyperliquid returned an application-level error. Inspect the action — common causes include insufficient margin, bad tick size, or unapproved builder fee.",
      );
    }

    if (path === "/exchange") {
      const exchangeResult = classifyHlExchangeResponse(parsed);
      if (exchangeResult.status === "rejected") {
        const reason = exchangeResult.reason ?? "Hyperliquid rejected the order.";
        this.logger?.warn({ reason }, "hl_rejected_order_status");
        throw new ApiException(
          "HL_EXCHANGE_REJECTED",
          `Hyperliquid rejected the order: ${reason}`,
          reason,
        );
      }
    }

    return parsed as T;
  }
}

export function classifyHlExchangeResponse(response: unknown): HlExchangeResult {
  const inner = response && typeof response === "object"
    ? (response as { response?: unknown }).response
    : undefined;
  if (!inner || typeof inner !== "object") {
    return { status: "accepted", label: "Accepted" };
  }

  const exchangeResponse = inner as { type?: unknown; data?: unknown };
  if (exchangeResponse.type !== "order") {
    return { status: "accepted", label: "Accepted" };
  }

  const statuses = exchangeResponse.data && typeof exchangeResponse.data === "object"
    ? (exchangeResponse.data as { statuses?: unknown }).statuses
    : undefined;
  if (!Array.isArray(statuses)) {
    return { status: "accepted", label: "Accepted" };
  }

  for (const status of statuses) {
    const error = orderStatusError(status);
    if (error) {
      return { status: "rejected", label: "Rejected", reason: error };
    }
  }

  if (statuses.some((status) => hasOrderStatusKey(status, "filled"))) {
    return { status: "filled", label: "Filled" };
  }
  if (statuses.some((status) => hasOrderStatusKey(status, "resting"))) {
    return { status: "resting", label: "Resting open order" };
  }

  return { status: "accepted", label: "Accepted" };
}

function orderStatusError(status: unknown): string | undefined {
  if (!status || typeof status !== "object") {
    return undefined;
  }

  const error = (status as { error?: unknown }).error;
  if (typeof error !== "string") {
    return undefined;
  }

  const safe = error.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return safe.slice(0, 500) || "Hyperliquid rejected the order.";
}

function hasOrderStatusKey(status: unknown, key: "filled" | "resting"): boolean {
  return Boolean(status && typeof status === "object" && key in status);
}
