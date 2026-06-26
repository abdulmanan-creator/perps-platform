/**
 * EIP-712 typed data for Hyperliquid's user-signed actions.
 *
 * Hyperliquid splits its signing into two schemes:
 *   - L1 actions (`order`, `cancel`, …)        → phantom-agent envelope (hash.ts)
 *   - User-signed actions (approveBuilderFee,
 *     approveAgent, withdraw3, …)              → direct EIP-712, this file
 *
 * For approveBuilderFee, the message the user signs is the action itself,
 * encoded as EIP-712 typed data. The signature chainId is *always* Arbitrum
 * mainnet (0xa4b1) even when the underlying Hyperliquid chain is testnet —
 * that's the chain MetaMask shows in the popup. The `hyperliquidChain` field
 * inside the message disambiguates mainnet vs testnet.
 */

import type {
  ApproveAgentAction,
  ApproveBuilderFeeAction,
  EIP712TypedData,
  PredictionUsdcTransferAction,
} from "@alchemy-hl/shared";

const ARBITRUM_MAINNET_CHAIN_ID_HEX = "0xa4b1" as const;
const ARBITRUM_MAINNET_CHAIN_ID = 42161;

const USER_SIGNED_DOMAIN = {
  name: "HyperliquidSignTransaction",
  version: "1",
  chainId: ARBITRUM_MAINNET_CHAIN_ID,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

const APPROVE_BUILDER_FEE_TYPES = {
  "HyperliquidTransaction:ApproveBuilderFee": [
    { name: "hyperliquidChain", type: "string" },
    { name: "maxFeeRate", type: "string" },
    { name: "builder", type: "address" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

const APPROVE_AGENT_TYPES = {
  "HyperliquidTransaction:ApproveAgent": [
    { name: "hyperliquidChain", type: "string" },
    { name: "agentAddress", type: "address" },
    { name: "agentName", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

const USD_CLASS_TRANSFER_TYPES = {
  "HyperliquidTransaction:UsdClassTransfer": [
    { name: "hyperliquidChain", type: "string" },
    { name: "amount", type: "string" },
    { name: "toPerp", type: "bool" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/**
 * Build the typed-data envelope + the final, fully-populated action that will
 * be POSTed to Hyperliquid /exchange in phase B.
 *
 * The server fills in `builder`, `nonce`, `hyperliquidChain`, `signatureChainId`
 * if the client didn't supply them. We always overwrite `builder` with our
 * own address to prevent any caller from approving fees for a different builder.
 */
export function buildApproveBuilderFeeTypedData(
  action: ApproveBuilderFeeAction,
  opts: { builder: `0x${string}`; isTestnet: boolean; nonce?: number },
): { typedData: EIP712TypedData; action: Required<ApproveBuilderFeeAction>; nonce: number } {
  const nonce = opts.nonce ?? Date.now();
  const hyperliquidChain: "Mainnet" | "Testnet" = opts.isTestnet ? "Testnet" : "Mainnet";

  const filled: Required<ApproveBuilderFeeAction> = {
    type: "approveBuilderFee",
    hyperliquidChain,
    maxFeeRate: action.maxFeeRate,
    builder: opts.builder,
    nonce,
    signatureChainId: ARBITRUM_MAINNET_CHAIN_ID_HEX,
  };

  const typedData: EIP712TypedData = {
    domain: { ...USER_SIGNED_DOMAIN },
    types: APPROVE_BUILDER_FEE_TYPES as unknown as EIP712TypedData["types"],
    primaryType: "HyperliquidTransaction:ApproveBuilderFee",
    message: {
      hyperliquidChain: filled.hyperliquidChain,
      maxFeeRate: filled.maxFeeRate,
      builder: filled.builder,
      nonce: filled.nonce,
    },
  };

  return { typedData, action: filled, nonce };
}

/**
 * Build the EIP-712 envelope for the user to sign approveAgent. Server fills
 * `agentAddress` (from deterministic derivation), `agentName` ("Alchemy"),
 * `nonce` (Date.now()), `hyperliquidChain`, `signatureChainId` if absent.
 *
 * Set `agentAddress` to all-zeros (`0x000…000`) to revoke an existing agent.
 */
export function buildApproveAgentTypedData(
  action: ApproveAgentAction,
  opts: {
    agentAddress: `0x${string}`;
    agentName?: string;
    isTestnet: boolean;
    nonce?: number;
  },
): {
  typedData: EIP712TypedData;
  action: Required<ApproveAgentAction>;
  nonce: number;
} {
  const nonce = opts.nonce ?? Date.now();
  const hyperliquidChain: "Mainnet" | "Testnet" = opts.isTestnet ? "Testnet" : "Mainnet";
  // Caller can pass an explicit agentAddress (e.g. zero address for revoke);
  // otherwise we use the server-derived value.
  const agentAddress = action.agentAddress ?? opts.agentAddress;
  const agentName = action.agentName ?? opts.agentName ?? "Alchemy";

  const filled: Required<ApproveAgentAction> = {
    type: "approveAgent",
    hyperliquidChain,
    agentAddress,
    agentName,
    nonce,
    signatureChainId: ARBITRUM_MAINNET_CHAIN_ID_HEX,
  };

  const typedData: EIP712TypedData = {
    domain: { ...USER_SIGNED_DOMAIN },
    types: APPROVE_AGENT_TYPES as unknown as EIP712TypedData["types"],
    primaryType: "HyperliquidTransaction:ApproveAgent",
    message: {
      hyperliquidChain: filled.hyperliquidChain,
      agentAddress: filled.agentAddress,
      agentName: filled.agentName,
      nonce: filled.nonce,
    },
  };

  return { typedData, action: filled, nonce };
}

export function buildUsdClassTransferTypedData(
  action: Pick<PredictionUsdcTransferAction, "amount" | "toPerp"> & Partial<PredictionUsdcTransferAction>,
  opts: { isTestnet: boolean; nonce?: number },
): {
  typedData: EIP712TypedData;
  action: PredictionUsdcTransferAction;
  nonce: number;
} {
  const nonce = opts.nonce ?? Date.now();
  const hyperliquidChain: "Mainnet" | "Testnet" = opts.isTestnet ? "Testnet" : "Mainnet";

  const filled: PredictionUsdcTransferAction = {
    type: "usdClassTransfer",
    hyperliquidChain,
    amount: action.amount,
    toPerp: false,
    nonce,
    signatureChainId: ARBITRUM_MAINNET_CHAIN_ID_HEX,
  };

  const typedData: EIP712TypedData = {
    domain: { ...USER_SIGNED_DOMAIN },
    types: USD_CLASS_TRANSFER_TYPES as unknown as EIP712TypedData["types"],
    primaryType: "HyperliquidTransaction:UsdClassTransfer",
    message: {
      hyperliquidChain: filled.hyperliquidChain,
      amount: filled.amount,
      toPerp: filled.toPerp,
      nonce: filled.nonce,
    },
  };

  return { typedData, action: filled, nonce };
}
