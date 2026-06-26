import { createPublicClient, createWalletClient, erc20Abi, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import type { FastifyRequest } from "fastify";

import type { Config } from "../config.js";
import { ApiException } from "../errors.js";
import { eligibilityForRequest } from "./agentTradeSafety.js";

export const GASLESS_HL_DEPOSIT_MIN_USDC_UNITS = 5_000_000n;
export const GASLESS_HL_DEPOSIT_MAX_DEADLINE_SECONDS = 30 * 60;
export const GASLESS_HL_DEPOSIT_CHAIN_ID = 42161;

export interface GaslessDepositSignature {
  r: Hex;
  s: Hex;
  v: number;
}

export interface GaslessDepositPermitPayload {
  owner: `0x${string}`;
  token: `0x${string}`;
  spender: `0x${string}`;
  amount: string;
  deadline: number;
  signature: GaslessDepositSignature;
}

export interface GaslessDepositRuntime {
  readUsdcBalance(args: {
    cfg: Config;
    owner: `0x${string}`;
  }): Promise<bigint>;
  submitBridgeDeposit(args: {
    cfg: Config;
    owner: `0x${string}`;
    amount: bigint;
    deadline: bigint;
    signature: GaslessDepositSignature;
  }): Promise<Hex>;
  nowSeconds(): number;
}

let runtimeOverride: GaslessDepositRuntime | undefined;

export function setGaslessDepositRuntimeForTests(runtime: GaslessDepositRuntime | undefined): void {
  runtimeOverride = runtime;
}

export function gaslessDepositStatus(cfg: Config): {
  enabled: boolean;
  reason: string;
  bridge: `0x${string}`;
  token: `0x${string}`;
  minDepositUsdc: number;
  chainId: number;
} {
  const relayerConfigured = Boolean(cfg.AGENT_TRADE_DEPOSIT_RELAYER_PRIVATE_KEY);
  const mainnetReady = cfg.AGENT_TRADE_MAINNET_EXECUTION_ENABLED && !cfg.isTestnet;
  const enabled = cfg.AGENT_TRADE_ENABLE_GASLESS_HL_DEPOSIT && relayerConfigured && mainnetReady;
  const reason = (() => {
    if (!cfg.AGENT_TRADE_ENABLE_GASLESS_HL_DEPOSIT) {
      return "Gasless deposit not enabled.";
    }
    if (!relayerConfigured) {
      return "Gasless deposit relayer is not configured.";
    }
    if (cfg.isTestnet) {
      return "Gasless deposit is only wired for Hyperliquid mainnet Bridge2.";
    }
    if (!cfg.AGENT_TRADE_MAINNET_EXECUTION_ENABLED) {
      return "Mainnet execution policy is disabled.";
    }
    return "Gasless deposit enabled.";
  })();

  return {
    enabled,
    reason,
    bridge: cfg.AGENT_TRADE_HL_BRIDGE_ARBITRUM,
    token: cfg.AGENT_TRADE_USDC_ARBITRUM,
    minDepositUsdc: 5,
    chainId: GASLESS_HL_DEPOSIT_CHAIN_ID,
  };
}

export async function validateAndRelayGaslessDeposit(args: {
  cfg: Config;
  req: FastifyRequest;
  authWallet: `0x${string}`;
  payload: GaslessDepositPermitPayload;
}): Promise<{ txHash: Hex; amount: string; owner: `0x${string}` }> {
  const runtime = runtimeOverride ?? defaultRuntime;
  const normalizedOwner = getAddress(args.payload.owner);
  const authWallet = getAddress(args.authWallet);
  const token = getAddress(args.payload.token);
  const spender = getAddress(args.payload.spender);

  assertGaslessDepositPolicy({
    cfg: args.cfg,
    req: args.req,
    owner: normalizedOwner,
    authWallet,
    token,
    spender,
    deadline: args.payload.deadline,
    nowSeconds: runtime.nowSeconds(),
  });

  const amount = parseUsdcUnits(args.payload.amount);
  if (amount < GASLESS_HL_DEPOSIT_MIN_USDC_UNITS) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Hyperliquid minimum deposit is 5 USDC.",
      "Increase the deposit amount to at least 5 native Arbitrum USDC.",
    );
  }

  const balance = await runtime.readUsdcBalance({ cfg: args.cfg, owner: normalizedOwner });
  if (amount > balance) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Deposit amount exceeds native Arbitrum USDC balance.",
      "Reduce the amount or add more native Arbitrum USDC to this wallet.",
    );
  }

  const txHash = await runtime.submitBridgeDeposit({
    cfg: args.cfg,
    owner: normalizedOwner,
    amount,
    deadline: BigInt(args.payload.deadline),
    signature: args.payload.signature,
  });

  return {
    txHash,
    amount: amount.toString(),
    owner: normalizedOwner,
  };
}

function assertGaslessDepositPolicy(args: {
  cfg: Config;
  req: FastifyRequest;
  owner: `0x${string}`;
  authWallet: `0x${string}`;
  token: `0x${string}`;
  spender: `0x${string}`;
  deadline: number;
  nowSeconds: number;
}): void {
  const status = gaslessDepositStatus(args.cfg);
  if (!status.enabled) {
    throw new ApiException(
      "INVALID_PARAMS",
      status.reason,
      "Gasless deposits stay disabled until product flag, relayer key, mainnet policy, and production QA are all configured.",
    );
  }

  if (args.owner.toLowerCase() !== args.authWallet.toLowerCase()) {
    throw new ApiException(
      "NOT_APPROVED",
      "Deposit owner does not match the authenticated wallet.",
      "Sign in with the wallet that owns the native Arbitrum USDC, then retry.",
    );
  }

  if (args.token.toLowerCase() !== args.cfg.AGENT_TRADE_USDC_ARBITRUM.toLowerCase()) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Unsupported deposit token.",
      "Only native Circle USDC on Arbitrum is accepted for this gasless Hyperliquid deposit path.",
    );
  }

  if (args.spender.toLowerCase() !== args.cfg.AGENT_TRADE_HL_BRIDGE_ARBITRUM.toLowerCase()) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Unsupported permit spender.",
      "The permit spender must be the configured Hyperliquid Bridge2 contract.",
    );
  }

  const state = eligibilityForRequest(args.req, args.cfg);
  if (state !== "liveEligible") {
    throw new ApiException(
      "REGION_BLOCKED",
      "Live eligibility is required for gasless Hyperliquid deposits.",
      "Restricted, unknown, paper-only, or kill-switch states cannot relay deposits.",
    );
  }

  if (args.deadline <= args.nowSeconds) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Permit deadline has expired.",
      "Refresh the page and sign a new short-lived permit.",
    );
  }

  if (args.deadline > args.nowSeconds + GASLESS_HL_DEPOSIT_MAX_DEADLINE_SECONDS) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Permit deadline is too far in the future.",
      "Use a permit deadline no more than 30 minutes from now.",
    );
  }
}

function parseUsdcUnits(value: string): bigint {
  if (!/^[0-9]+$/u.test(value)) {
    throw new ApiException(
      "INVALID_PARAMS",
      "Deposit amount must be an integer USDC base-unit string.",
      "Build the permit for native Arbitrum USDC using 6 decimals and send the integer amount.",
    );
  }
  return BigInt(value);
}

const bridge2Abi = [
  {
    type: "function",
    name: "batchedDepositWithPermit",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "deposits",
        type: "tuple[]",
        components: [
          { name: "user", type: "address" },
          { name: "usd", type: "uint64" },
          { name: "deadline", type: "uint64" },
          {
            name: "signature",
            type: "tuple",
            components: [
              { name: "r", type: "bytes32" },
              { name: "s", type: "bytes32" },
              { name: "v", type: "uint8" },
            ],
          },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const defaultRuntime: GaslessDepositRuntime = {
  nowSeconds() {
    return Math.floor(Date.now() / 1000);
  },
  async readUsdcBalance(args) {
    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(args.cfg.AGENT_TRADE_ARBITRUM_RPC_URL),
    });
    return await publicClient.readContract({
      abi: erc20Abi,
      address: args.cfg.AGENT_TRADE_USDC_ARBITRUM,
      functionName: "balanceOf",
      args: [args.owner],
    });
  },
  async submitBridgeDeposit(args) {
    if (!args.cfg.AGENT_TRADE_DEPOSIT_RELAYER_PRIVATE_KEY) {
      throw new ApiException(
        "INVALID_PARAMS",
        "Gasless deposit relayer is not configured.",
        "Set AGENT_TRADE_DEPOSIT_RELAYER_PRIVATE_KEY only after funding the relayer with Arbitrum ETH.",
      );
    }
    const relayer = privateKeyToAccount(args.cfg.AGENT_TRADE_DEPOSIT_RELAYER_PRIVATE_KEY as Hex);
    const walletClient = createWalletClient({
      account: relayer,
      chain: arbitrum,
      transport: http(args.cfg.AGENT_TRADE_ARBITRUM_RPC_URL),
    });
    return await walletClient.writeContract({
      address: args.cfg.AGENT_TRADE_HL_BRIDGE_ARBITRUM,
      abi: bridge2Abi,
      functionName: "batchedDepositWithPermit",
      args: [[{
        user: args.owner,
        usd: args.amount,
        deadline: args.deadline,
        signature: args.signature,
      }]],
    });
  },
};
