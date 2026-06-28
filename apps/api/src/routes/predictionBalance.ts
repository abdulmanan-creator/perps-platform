import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { PredictionBalanceState, PredictionSpotBalance } from "@alchemy-hl/shared";

import { ApiException } from "../errors.js";
import { HlClient } from "../helpers/hlClient.js";
import { ApprovalQuerySchema } from "../schemas.js";

export const PREDICTION_BALANCE_GUIDANCE =
  "Prediction markets use Hyperliquid spot-style balance; perp margin balance may not be spendable here. Move USDC from perp to spot on Hyperliquid before signing live HIP-4 prediction orders.";

export async function predictionBalanceRoute(app: FastifyInstance): Promise<void> {
  const hl = new HlClient({
    baseUrl: app.config.HYPERLIQUID_API_URL,
    logger: { warn: app.log.warn.bind(app.log) },
  });

  app.get("/prediction/balance", async (req, reply) => {
    let q;
    try {
      q = ApprovalQuerySchema.parse(req.query);
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.issues[0];
        throw new ApiException(
          "INVALID_PARAMS",
          `Bad query: ${first?.path.join(".") ?? "(root)"}: ${first?.message ?? "validation failed"}`,
          "Provide ?user=0x... for the wallet whose HIP-4 spot balance you want to read.",
        );
      }
      throw err;
    }

    return reply.send(await fetchPredictionBalanceState(hl, q.user));
  });
}

export async function fetchPredictionBalanceState(
  hl: HlClient,
  user: `0x${string}`,
): Promise<PredictionBalanceState> {
  const [spotState, perpState] = await Promise.all([
    hl.info<HlSpotClearinghouseState>({ type: "spotClearinghouseState", user }),
    hl.info<HlClearinghouseState>({ type: "clearinghouseState", user }).catch(() => undefined),
  ]);
  const balances = (spotState?.balances ?? []).map(normalizeSpotBalance);
  const spotUsdc = balances.find((balance) => balance.coin === "USDC") ?? emptySpotUsdcBalance();
  const perpWithdrawable = perpState?.withdrawable === undefined ? null : String(perpState.withdrawable);
  return {
    user,
    source: "spotClearinghouseState",
    spotUsdc,
    spotUsdcAvailable: spotUsdc.available,
    perpWithdrawable,
    maxTransferableUsdc: normalizeTransferableUsdc(perpWithdrawable),
    balances,
    outcomeBalances: balances.filter(isOutcomeBalance),
    fetchedAt: Date.now(),
    guidance: PREDICTION_BALANCE_GUIDANCE,
  };
}

export function assertPredictionSpotBalanceSufficient(args: {
  balance: PredictionBalanceState;
  requiredCostUsd: number;
}): void {
  const available = Number(args.balance.spotUsdcAvailable);
  if (!Number.isFinite(available) || available + 1e-9 < args.requiredCostUsd) {
    throw new ApiException(
      "INVALID_PARAMS",
      `Insufficient HIP-4 prediction spot balance. Available ${formatUsdc(available)} USDC, required ${formatUsdc(args.requiredCostUsd)} USDC.`,
      PREDICTION_BALANCE_GUIDANCE,
    );
  }
}

function normalizeSpotBalance(raw: HlSpotBalance): PredictionSpotBalance {
  const total = numericString(raw.total);
  const hold = numericString(raw.hold);
  return {
    coin: String(raw.coin ?? ""),
    token: raw.token ?? null,
    total,
    hold,
    available: formatBalance(Math.max(0, Number(total) - Number(hold))),
    entryNtl: raw.entryNtl === undefined ? null : String(raw.entryNtl),
  };
}

function emptySpotUsdcBalance(): PredictionSpotBalance {
  return {
    coin: "USDC",
    token: 0,
    total: "0",
    hold: "0",
    available: "0",
    entryNtl: "0",
  };
}

function isOutcomeBalance(balance: PredictionSpotBalance): boolean {
  return balance.coin.startsWith("+") || balance.coin.startsWith("#");
}

function numericString(value: string | number | undefined): string {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? formatBalance(parsed) : "0";
}

function formatBalance(value: number): string {
  return value.toFixed(8).replace(/0+$/u, "").replace(/\.$/u, "");
}

function normalizeTransferableUsdc(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const units = BigInt(whole ?? "0") * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  const normalizedWhole = units / 1_000_000n;
  const normalizedFraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole.toString();
}

function formatUsdc(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  return value.toFixed(2);
}

interface HlSpotClearinghouseState {
  balances?: HlSpotBalance[];
}

interface HlSpotBalance {
  coin?: string;
  token?: number | string;
  total?: string | number;
  hold?: string | number;
  entryNtl?: string | number;
}

interface HlClearinghouseState {
  withdrawable?: string | number;
}
