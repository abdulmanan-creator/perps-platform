import type { Hex, TypedDataDomain } from "viem";

import type { EligibilityMode } from "./types";

export const ARBITRUM_CHAIN_ID = 42161;
export const HL_BRIDGE_ARBITRUM = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7" as const;
export const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const MIN_HL_DEPOSIT_USDC_UNITS = 5_000_000n;
export const MIN_AGENT_TRADE_ORDER_NOTIONAL_USD = 10;

export type GaslessDepositPhase =
  | "idle"
  | "signing"
  | "signed"
  | "submitting"
  | "submitted"
  | "polling"
  | "confirmed"
  | "error";

export interface GaslessDepositStatus {
  enabled: boolean;
  reason: string;
  allowed?: boolean;
  bridge: `0x${string}`;
  token: `0x${string}`;
  minDepositUsdc: number;
  chainId: number;
  eligibilityState: EligibilityMode;
  liveEligible: boolean;
  mainnetExecutionEnabled: boolean;
  killSwitchEnabled: boolean;
  minOrderNotionalUsd: number;
}

export interface PermitTypedDataInput {
  owner: `0x${string}`;
  spender: `0x${string}`;
  token: `0x${string}`;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}

export function buildUsdcPermitTypedData(input: PermitTypedDataInput): {
  domain: TypedDataDomain;
  types: {
    Permit: [
      { name: "owner"; type: "address" },
      { name: "spender"; type: "address" },
      { name: "value"; type: "uint256" },
      { name: "nonce"; type: "uint256" },
      { name: "deadline"; type: "uint256" },
    ];
  };
  primaryType: "Permit";
  message: {
    owner: `0x${string}`;
    spender: `0x${string}`;
    value: bigint;
    nonce: bigint;
    deadline: bigint;
  };
} {
  return {
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: ARBITRUM_CHAIN_ID,
      verifyingContract: input.token,
    },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: {
      owner: input.owner,
      spender: input.spender,
      value: input.value,
      nonce: input.nonce,
      deadline: input.deadline,
    },
  };
}

export function splitPermitSignature(signature: Hex): { r: Hex; s: Hex; v: number } {
  const stripped = signature.replace(/^0x/u, "");
  let v = parseInt(stripped.slice(128, 130), 16);
  if (v < 27) {
    v += 27;
  }
  return {
    r: `0x${stripped.slice(0, 64)}` as Hex,
    s: `0x${stripped.slice(64, 128)}` as Hex,
    v,
  };
}

export function validateGaslessDepositAmount(input: {
  amount: string;
  walletUsdcUnits: bigint;
}): { ok: true; amountUnits: bigint } | { ok: false; message: string } {
  const trimmed = input.amount.trim();
  if (!/^\d+(\.\d{0,6})?$/u.test(trimmed)) {
    return { ok: false, message: "Enter a USDC amount with up to 6 decimals." };
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const amountUnits = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (amountUnits < MIN_HL_DEPOSIT_USDC_UNITS) {
    const shortfall = MIN_HL_DEPOSIT_USDC_UNITS - amountUnits;
    return {
      ok: false,
      message: `Hyperliquid minimum deposit is 5 USDC. Add at least ${formatUsdc(shortfall)} more USDC.`,
    };
  }
  if (amountUnits > input.walletUsdcUnits) {
    return {
      ok: false,
      message: "Deposit amount exceeds native Arbitrum USDC in this wallet.",
    };
  }
  return { ok: true, amountUnits };
}

export function getGaslessDepositUi(input: {
  frontendEnabled: boolean;
  backendStatus?: GaslessDepositStatus;
  walletConnected: boolean;
  eligibilityState: EligibilityMode;
  walletUsdcUnits: bigint;
  baseUsdcUnits?: bigint;
  hlAccountValueUsd: number;
  amount: string;
}): {
  title: string;
  summary: string;
  ctaLabel: string;
  ctaEnabled: boolean;
  amountError?: string;
  readyToTrade: boolean;
} {
  if (!input.frontendEnabled) {
    return {
      title: "Gasless deposit not enabled",
      summary: "Native Arbitrum USDC deposits stay hidden until the product flag and backend relayer are enabled.",
      ctaLabel: "Deposit disabled",
      ctaEnabled: false,
      readyToTrade: false,
    };
  }
  if (!input.backendStatus?.enabled) {
    return {
      title: "Gasless deposit not enabled",
      summary: input.backendStatus?.reason ?? "Backend relayer status is unavailable.",
      ctaLabel: "Deposit disabled",
      ctaEnabled: false,
      readyToTrade: false,
    };
  }
  if (!input.walletConnected) {
    return {
      title: "Connect wallet first",
      summary: "A connected Privy wallet is required before signing a USDC permit.",
      ctaLabel: "Connect wallet",
      ctaEnabled: false,
      readyToTrade: false,
    };
  }
  if (input.eligibilityState !== "liveEligible") {
    return {
      title: "Live eligibility required",
      summary: "Restricted, unknown, paper-only, or kill-switch states cannot relay deposits.",
      ctaLabel: "Deposit disabled",
      ctaEnabled: false,
      readyToTrade: false,
    };
  }
  if (input.hlAccountValueUsd >= MIN_AGENT_TRADE_ORDER_NOTIONAL_USD) {
    return {
      title: "Ready to trade",
      summary: "Hyperliquid trading balance is at or above Agent.trade's $10 minimum order notional.",
      ctaLabel: "Ready to trade",
      ctaEnabled: false,
      readyToTrade: true,
    };
  }
  const amount = validateGaslessDepositAmount({
    amount: input.amount,
    walletUsdcUnits: input.walletUsdcUnits,
  });
  if (!amount.ok) {
    const hasBaseUsdcOnly = input.walletUsdcUnits === 0n && (input.baseUsdcUnits ?? 0n) > 0n;
    return {
      title: "Wallet funded, Hyperliquid not funded",
      summary: hasBaseUsdcOnly
        ? "Base USDC detected; bridge to Arbitrum first. Agent.trade does not yet bridge Base deposits."
        : input.walletUsdcUnits > 0n
        ? "Native Arbitrum USDC is in the wallet, but it is not yet deposited into Hyperliquid."
        : "No native Arbitrum USDC is available in this wallet. If your provider sent Base USDC, bridge it to Arbitrum first.",
      ctaLabel: "Deposit to Hyperliquid",
      ctaEnabled: false,
      amountError: amount.message,
      readyToTrade: false,
    };
  }
  return {
    title: "Wallet funded, Hyperliquid not funded",
    summary: input.hlAccountValueUsd >= 5
      ? "Deposited, but below Agent.trade's $10 minimum order notional."
      : "Native Arbitrum USDC is ready to deposit into Hyperliquid with a gasless permit.",
    ctaLabel: "Deposit to Hyperliquid",
    ctaEnabled: true,
    readyToTrade: false,
  };
}

export function formatUsdc(units: bigint): string {
  const sign = units < 0n ? "-" : "";
  const abs = units < 0n ? -units : units;
  const whole = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}
