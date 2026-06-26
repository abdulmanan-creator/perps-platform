import type { FastifyInstance, FastifyRequest } from "fastify";
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { z, ZodError } from "zod";

import type {
  ErrorCode,
  PredictionUsdcTransferAction,
  PredictionUsdcTransferBuildResponse,
  PredictionUsdcTransferSendResponse,
  PredictionUsdcTransferState,
  Signature,
} from "@alchemy-hl/shared";

import { ApiException } from "../errors.js";
import type { Config } from "../config.js";
import { eligibilityForRequest } from "../helpers/agentTradeSafety.js";
import {
  recordAuditEvent,
  recordExchangeResponse,
  recordExchangeSubmission,
} from "../helpers/agentTradeAudit.js";
import { buildUsdClassTransferTypedData } from "../helpers/eip712.js";
import { classifyHlExchangeResponse, HlClient } from "../helpers/hlClient.js";
import { TtlCache } from "../helpers/ttlCache.js";
import { AddressSchema, SignatureSchema } from "../schemas.js";
import { WRITE_RATE_LIMIT } from "./exchange.js";
import { fetchPredictionBalanceState } from "./predictionBalance.js";

const ROUTE = "/prediction/usdc-transfer";
const TRANSFER_GUIDANCE =
  "Prediction markets use Hyperliquid spot-style USDC. Move USDC from perp margin to prediction balance before submitting live HIP-4 orders.";

class PredictionTransferException extends ApiException {
  constructor(
    code: ErrorCode,
    message: string,
    guidance: string,
    readonly state: PredictionUsdcTransferState,
  ) {
    super(code, message, guidance);
  }

  override toJSON() {
    return { ...super.toJSON(), state: this.state };
  }
}

const UsdcTransferActionSchema = z.object({
  type: z.literal("usdClassTransfer"),
  hyperliquidChain: z.enum(["Mainnet", "Testnet"]),
  signatureChainId: z.string().regex(/^0x[0-9a-fA-F]+$/u).transform((value) => value as `0x${string}`),
  amount: z.string(),
  toPerp: z.literal(false),
  nonce: z.number().int().min(0),
});

const PredictionUsdcTransferBodySchema = z.object({
  user: AddressSchema.optional(),
  amount: z.string().optional(),
  action: UsdcTransferActionSchema.optional(),
  nonce: z.number().int().min(0).optional(),
  signature: SignatureSchema.optional(),
});

export async function predictionUsdcTransferRoute(app: FastifyInstance): Promise<void> {
  const hl = new HlClient({
    baseUrl: app.config.HYPERLIQUID_API_URL,
    logger: {
      warn: (obj, msg) => app.log.warn(redactPredictionTransferLog(obj), msg),
    },
  });
  const seenSignatures = new TtlCache<true>({ ttlMs: 10 * 60_000, maxEntries: 50_000 });

  app.post(ROUTE, { config: { rateLimit: WRITE_RATE_LIMIT } }, async (req, reply) => {
    let body: z.infer<typeof PredictionUsdcTransferBodySchema>;
    try {
      body = PredictionUsdcTransferBodySchema.parse(req.body);
    } catch (err) {
      throw zodToApi(err);
    }

    if (body.signature) {
      if (!body.action || body.nonce === undefined) {
        throw new ApiException(
          "INVALID_PARAMS",
          "Send phase requires action, nonce, and signature.",
          "Submit the exact action and nonce returned by /prediction/usdc-transfer build, plus the wallet signature.",
        );
      }
      const sendBody = {
        ...body,
        action: body.action,
        nonce: body.nonce,
        signature: body.signature,
      };
      return reply.send(await sendTransfer({ app, hl, req, body: sendBody, seenSignatures }));
    }

    if (!body.user || !body.amount) {
      throw new ApiException(
        "INVALID_PARAMS",
        "Build phase requires user and amount.",
        "Send { user: 0x..., amount: \"10\" } to build a perp-to-spot USDC transfer for prediction markets.",
      );
    }
    return reply.send(await buildTransfer({ app, hl, req, user: body.user, amount: body.amount, nonce: body.nonce }));
  });
}

async function buildTransfer(args: {
  app: FastifyInstance;
  hl: HlClient;
  req: FastifyRequest;
  user: `0x${string}`;
  amount: string;
  nonce?: number;
}): Promise<PredictionUsdcTransferBuildResponse> {
  assertPredictionTransferAllowed(args.req, args.app.config);
  const amount = normalizeUsdcAmount(args.amount);
  const balance = await fetchTransferBalance(args.hl, args.user);
  assertPerpWithdrawableSufficient({ balance, amount });

  const { typedData, action, nonce } = buildUsdClassTransferTypedData(
    { type: "usdClassTransfer", amount, toPerp: false },
    { isTestnet: args.app.config.isTestnet, nonce: args.nonce },
  );
  const hash = hashTypedDataDigest(typedData);
  const payload = transferLogPayload({ user: args.user, action, balance });
  args.req.log.info(payload, "prediction_usdc_transfer_build");
  await recordExchangeSubmission({
    req: args.req,
    cfg: args.app.config,
    phase: "build",
    route: ROUTE,
    status: "built",
    user: args.user,
    nonce,
    redactedPayload: { ...payload, hash },
  });
  await recordAuditEvent({
    req: args.req,
    cfg: args.app.config,
    actorType: "wallet",
    actorId: args.user.toLowerCase(),
    walletAddress: args.user,
    route: ROUTE,
    eventType: "prediction.usdc_transfer.built",
    payload: { ...payload, hash },
  });

  return {
    status: "built",
    state: "built",
    hash,
    nonce,
    action,
    typedData,
    amount,
    direction: "perp_to_spot",
    balance,
  };
}

async function sendTransfer(args: {
  app: FastifyInstance;
  hl: HlClient;
  req: FastifyRequest;
  body: z.infer<typeof PredictionUsdcTransferBodySchema> & {
    action: PredictionUsdcTransferAction;
    nonce: number;
    signature: Signature;
  };
  seenSignatures: TtlCache<true>;
}): Promise<PredictionUsdcTransferSendResponse> {
  assertPredictionTransferAllowed(args.req, args.app.config);
  const action = normalizeTransferAction(args.body.action, args.app.config, args.body.nonce);
  const signer = await recoverTransferSigner(action, args.body.signature, args.app.config);
  if (args.body.user && args.body.user.toLowerCase() !== signer.toLowerCase()) {
    throw new ApiException(
      "SIGNATURE_INVALID",
      "Transfer signer does not match the requested wallet.",
      "Use the connected wallet that owns the prediction balance transfer request.",
    );
  }
  const amount = normalizeUsdcAmount(action.amount);
  const balance = await fetchTransferBalance(args.hl, signer);
  assertPerpWithdrawableSufficient({ balance, amount });

  const replayKey = `${args.body.signature.r}:${args.body.signature.s}:${args.body.signature.v}:${args.body.nonce}`;
  if (!args.seenSignatures.addIfAbsent(replayKey, true)) {
    throw new ApiException(
      "DUPLICATE_REQUEST",
      "This signed USDC transfer was already submitted.",
      "Check the refreshed prediction balance instead of retrying the same signature. Build and sign a fresh transfer if more USDC is needed.",
    );
  }

  const payload = transferLogPayload({ user: signer, action, balance });
  args.req.log.info(payload, "prediction_usdc_transfer_send");
  await recordExchangeSubmission({
    req: args.req,
    cfg: args.app.config,
    phase: "send",
    route: ROUTE,
    status: "started",
    signer,
    nonce: args.body.nonce,
    signature: args.body.signature,
    redactedPayload: payload,
  });
  await recordAuditEvent({
    req: args.req,
    cfg: args.app.config,
    actorType: "wallet",
    actorId: signer.toLowerCase(),
    walletAddress: signer,
    route: ROUTE,
    eventType: "prediction.usdc_transfer.send_started",
    payload,
  });

  const normalizedSignature = {
    r: args.body.signature.r,
    s: args.body.signature.s,
    v: args.body.signature.v < 27 ? args.body.signature.v + 27 : args.body.signature.v,
  };
  const startedAt = Date.now();
  let exchangeResponse: unknown;
  try {
    exchangeResponse = await args.hl.forwardExchange({
      action,
      nonce: args.body.nonce,
      signature: normalizedSignature,
    });
  } catch (err) {
    if (err instanceof ApiException && err.code === "HL_EXCHANGE_UNREACHABLE") {
      args.seenSignatures.delete(replayKey);
    }
    await recordExchangeSubmission({
      req: args.req,
      cfg: args.app.config,
      phase: "send",
      route: ROUTE,
      status: "failed",
      signer,
      nonce: args.body.nonce,
      signature: args.body.signature,
      error: err,
      redactedPayload: payload,
    });
    await recordExchangeResponse({
      req: args.req,
      cfg: args.app.config,
      walletAddress: signer,
      success: false,
      error: err,
      latencyMs: Date.now() - startedAt,
    });
    if (err instanceof ApiException && err.code === "HL_EXCHANGE_REJECTED") {
      throw new PredictionTransferException(err.code, err.message, err.guidance, "rejected");
    }
    throw err;
  }

  const latencyMs = Date.now() - startedAt;
  const submissionId = await recordExchangeSubmission({
    req: args.req,
    cfg: args.app.config,
    phase: "send",
    route: ROUTE,
    status: "forwarded",
    signer,
    nonce: args.body.nonce,
    signature: args.body.signature,
    redactedPayload: payload,
  });
  await recordExchangeResponse({
    req: args.req,
    cfg: args.app.config,
    exchangeSubmissionId: submissionId,
    walletAddress: signer,
    success: true,
    responsePayload: exchangeResponse,
    latencyMs,
  });
  await recordAuditEvent({
    req: args.req,
    cfg: args.app.config,
    actorType: "wallet",
    actorId: signer.toLowerCase(),
    walletAddress: signer,
    route: ROUTE,
    eventType: "prediction.usdc_transfer.forwarded",
    payload: { ...payload, latencyMs },
  });

  return {
    status: "submitted",
    state: "submitted",
    success: true,
    user: signer,
    action,
    exchangeResponse,
    exchangeResult: classifyHlExchangeResponse(exchangeResponse),
  };
}

function assertPredictionTransferAllowed(req: FastifyRequest, cfg: Config): void {
  if (!cfg.AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING) {
    throw new ApiException(
      "REGION_BLOCKED",
      "Live HIP-4 prediction trading is disabled.",
      "Enable AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING only after review; prediction balance transfers stay disabled with live HIP-4 off.",
    );
  }
  const eligibility = eligibilityForRequest(req, cfg);
  if (eligibility === "killSwitchDisabled") {
    throw new ApiException(
      "REGION_BLOCKED",
      "Live trading is disabled by the global Agent.trade kill switch.",
      "Prediction balance transfers are live trading preparation and require the kill switch to be clear.",
    );
  }
  if (eligibility === "restricted") {
    throw new ApiException(
      "REGION_BLOCKED",
      "This user is not eligible for live prediction balance transfers.",
      "Restricted jurisdictions cannot move USDC for live HIP-4 prediction trading through Agent.trade.",
    );
  }
  if (eligibility === "unknown") {
    throw new ApiException(
      "REGION_BLOCKED",
      "Live trading eligibility is unknown.",
      "The server could not verify an allowed jurisdiction. Prediction balance transfers require confirmed eligibility.",
    );
  }
  if (cfg.AGENT_TRADE_REQUIRE_RISK_ACK) {
    const riskAck = req.headers["x-agent-trade-risk-accepted"];
    const termsAck = req.headers["x-agent-trade-terms-accepted"];
    if (riskAck !== "true" || termsAck !== "true") {
      throw new ApiException(
        "INVALID_PARAMS",
        "Prediction balance transfers require explicit risk and terms acknowledgement.",
        "Send x-agent-trade-risk-accepted:true and x-agent-trade-terms-accepted:true only after the user confirms they are moving USDC to prediction balance.",
      );
    }
  }
  if (!cfg.isTestnet && !cfg.AGENT_TRADE_MAINNET_EXECUTION_ENABLED) {
    throw new ApiException(
      "REGION_BLOCKED",
      "Mainnet execution is disabled for Agent.trade.",
      "Prediction balance transfers are disabled until mainnet Agent.trade execution is explicitly enabled.",
    );
  }
}

async function fetchTransferBalance(hl: HlClient, user: `0x${string}`) {
  try {
    return await fetchPredictionBalanceState(hl, user);
  } catch {
    throw new PredictionTransferException(
      "HL_EXCHANGE_REJECTED",
      "Could not verify Hyperliquid perp withdrawable balance.",
      "Retry before signing. Agent.trade re-reads clearinghouseState.withdrawable before moving USDC to prediction balance.",
      "balance_unavailable",
    );
  }
}

function assertPerpWithdrawableSufficient(args: {
  balance: Awaited<ReturnType<typeof fetchPredictionBalanceState>>;
  amount: string;
}): void {
  if (args.balance.perpWithdrawable === null) {
    throw new PredictionTransferException(
      "INVALID_PARAMS",
      "Perp withdrawable balance is unavailable.",
      "Agent.trade could not read clearinghouseState.withdrawable, so it cannot build a prediction balance transfer.",
      "balance_unavailable",
    );
  }
  const amountUnits = parseUsdcUnits(args.amount);
  const withdrawableUnits = parseUsdcUnits(args.balance.perpWithdrawable);
  if (amountUnits > withdrawableUnits) {
    throw new PredictionTransferException(
      "INVALID_PARAMS",
      "Insufficient perp withdrawable balance for prediction USDC transfer.",
      `Available perp withdrawable is ${args.balance.perpWithdrawable} USDC. Enter an amount at or below that value.`,
      "insufficient_perp_balance",
    );
  }
}

function normalizeTransferAction(
  raw: PredictionUsdcTransferAction,
  cfg: Config,
  nonce: number,
): PredictionUsdcTransferAction {
  const amount = normalizeUsdcAmount(raw.amount);
  const { action } = buildUsdClassTransferTypedData(
    { type: "usdClassTransfer", amount, toPerp: false },
    { isTestnet: cfg.isTestnet, nonce },
  );
  if (raw.hyperliquidChain !== action.hyperliquidChain || raw.signatureChainId !== action.signatureChainId) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Transfer action chain fields do not match server configuration.",
      "Use the exact action returned by the build phase for send.",
    );
  }
  if (raw.nonce !== nonce || raw.nonce !== action.nonce) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Transfer action nonce does not match the signed nonce.",
      "Use the exact nonce returned by the build phase for send.",
    );
  }
  if (raw.toPerp !== false) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Prediction balance transfers must move USDC from perp to spot.",
      "Use toPerp:false for funding HIP-4 prediction markets.",
    );
  }
  return action;
}

async function recoverTransferSigner(
  action: PredictionUsdcTransferAction,
  sig: Signature,
  cfg: Config,
): Promise<`0x${string}`> {
  const { typedData } = buildUsdClassTransferTypedData(action, {
    isTestnet: cfg.isTestnet,
    nonce: action.nonce,
  });
  try {
    return await recoverTypedDataAddress({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature: packSig(sig),
    });
  } catch (err) {
    throw new ApiException(
      "SIGNATURE_INVALID",
      `Could not recover signer from prediction transfer signature: ${(err as Error).message}`,
      "Make sure the wallet signed the exact typedData returned by /prediction/usdc-transfer build.",
    );
  }
}

export function normalizeUsdcAmount(input: string): string {
  const units = parseUsdcUnits(input);
  if (units <= 0n) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Prediction balance transfer amount must be greater than 0.",
      "Enter a positive USDC amount with up to 6 decimals.",
    );
  }
  return formatUsdcUnits(units);
}

function parseUsdcUnits(input: string): bigint {
  const trimmed = input.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(trimmed)) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Prediction balance transfer amount must use sane USDC decimals.",
      "Enter a decimal USDC amount without commas or scientific notation, using at most 6 decimals.",
    );
  }
  const [whole, fraction = ""] = trimmed.split(".");
  return BigInt(whole ?? "0") * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function formatUsdcUnits(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function hashTypedDataDigest(td: import("@alchemy-hl/shared").EIP712TypedData): `0x${string}` {
  return hashTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: td.message,
  });
}

function packSig(sig: Signature): Hex {
  const r = sig.r.replace(/^0x/u, "").padStart(64, "0");
  const s = sig.s.replace(/^0x/u, "").padStart(64, "0");
  const v = sig.v.toString(16).padStart(2, "0");
  return `0x${r}${s}${v}` as Hex;
}

function transferLogPayload(args: {
  user: `0x${string}`;
  action: PredictionUsdcTransferAction;
  balance: Awaited<ReturnType<typeof fetchPredictionBalanceState>>;
}) {
  return {
    user: args.user,
    actionType: args.action.type,
    amount: args.action.amount,
    toPerp: args.action.toPerp,
    nonce: args.action.nonce,
    hip4SpendableBalance: args.balance.spotUsdcAvailable,
    perpWithdrawable: args.balance.perpWithdrawable,
  };
}

function redactPredictionTransferLog(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactPredictionTransferLog);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/signature|authorization|token|secret/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = redactPredictionTransferLog(item);
    }
  }
  return out;
}

function zodToApi(err: unknown): ApiException {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const path = first?.path.join(".") ?? "(root)";
    return new ApiException(
      "INVALID_PARAMS",
      `Bad shape at ${path}: ${first?.message ?? "validation failed"}`,
      "Send a prediction USDC transfer build payload { user, amount } or send payload { action, nonce, signature }.",
    );
  }
  return new ApiException(
    "INVALID_JSON",
    "Request body could not be parsed.",
    "Send a JSON object to /prediction/usdc-transfer.",
  );
}
