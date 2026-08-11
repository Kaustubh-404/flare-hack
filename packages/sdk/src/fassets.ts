/**
 * FAssets direct-minting: destination and fee arithmetic.
 *
 * The XRPL payment for a Smart Accounts custom instruction goes to the FAssets
 * **Core Vault**, not to the operator wallet returned by
 * `getXrplProviderWallets()`. Those are two different flows:
 *
 *   proof-based (payment reference) -> operator wallet, 32-byte reference
 *   direct-minting (memo, 0xFE/0xFF) -> Core Vault, memo instruction
 *
 * The memo opcodes this SDK builds belong to the second flow: the AssetManager
 * mints FXRP and calls MasterAccountController.handleMintedFAssets, which
 * dispatches the memo. Sending to the operator wallet silently does nothing.
 *
 * Confirmed against flare-viem-starter/src/utils/smart-accounts.ts
 * (`sendHashInstruction` -> `getDirectMintingPaymentAddress`).
 */

import type { Address, PublicClient } from "viem";

export const DIRECT_MINTING_ABI = [
  {
    type: "function",
    name: "directMintingPaymentAddress",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

export const DIRECT_MINTING_SETTINGS_ABI = [
  {
    type: "function",
    name: "getDirectMintingExecutorFeeUBA",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getDirectMintingFeeBIPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getDirectMintingMinimumFeeUBA",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getDirectMintingHourlyLimitUBA",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getDirectMintingDailyLimitUBA",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** XRP has 6 decimals; 1 XRP = 1,000,000 drops (UBA). */
export const DROPS_PER_XRP = 1_000_000n;

export interface DirectMintingFees {
  /** Flat fee paid to whoever finalises the mint. */
  executorFeeUBA: bigint;
  /** Proportional minting fee, in basis points. */
  feeBIPS: bigint;
  /** Floor under the proportional fee. */
  minimumFeeUBA: bigint;
}

export interface PaymentBreakdown {
  netMintUBA: bigint;
  mintingFeeUBA: bigint;
  executorFeeUBA: bigint;
  /** What the XRPL payment must actually carry. */
  totalUBA: bigint;
}

export async function readDirectMintingFees(
  client: PublicClient,
  assetManager: Address,
): Promise<DirectMintingFees> {
  const [executorFeeUBA, feeBIPS, minimumFeeUBA] = await Promise.all([
    client.readContract({
      address: assetManager,
      abi: DIRECT_MINTING_SETTINGS_ABI,
      functionName: "getDirectMintingExecutorFeeUBA",
    }),
    client.readContract({
      address: assetManager,
      abi: DIRECT_MINTING_SETTINGS_ABI,
      functionName: "getDirectMintingFeeBIPS",
    }),
    client.readContract({
      address: assetManager,
      abi: DIRECT_MINTING_SETTINGS_ABI,
      functionName: "getDirectMintingMinimumFeeUBA",
    }),
  ]);
  return { executorFeeUBA, feeBIPS, minimumFeeUBA };
}

/**
 * Fees are deducted *from* the payment, so they must be added on top of the
 * amount the user wants to end up with.
 *
 * If the payment does not even cover the minting fee, no FAssets are minted and
 * the whole payment goes to the fee receiver — an irreversible loss. That is why
 * this is computed rather than guessed.
 */
export function computePaymentAmount(netMintUBA: bigint, fees: DirectMintingFees): PaymentBreakdown {
  const proportionalFeeUBA = (netMintUBA * fees.feeBIPS) / 10_000n;
  const mintingFeeUBA =
    proportionalFeeUBA > fees.minimumFeeUBA ? proportionalFeeUBA : fees.minimumFeeUBA;
  return {
    netMintUBA,
    mintingFeeUBA,
    executorFeeUBA: fees.executorFeeUBA,
    totalUBA: netMintUBA + mintingFeeUBA + fees.executorFeeUBA,
  };
}

export const xrpToDrops = (xrp: number): bigint =>
  BigInt(Math.round(xrp * Number(DROPS_PER_XRP)));

export const dropsToXrp = (drops: bigint): number => Number(drops) / Number(DROPS_PER_XRP);

/**
 * The two AssetManager entry points an executor may call.
 * `0xFE` (hash commitment) requires WithData; `0xFF` (inline) uses the plain one.
 */
export const EXECUTE_DIRECT_MINTING_ABI = [
  {
    type: "function",
    name: "executeDirectMintingWithData",
    stateMutability: "payable",
    inputs: [
      { name: "_payment", type: "tuple", components: [
        { name: "merkleProof", type: "bytes32[]" },
        { name: "data", type: "tuple", components: [
          { name: "attestationType", type: "bytes32" },
          { name: "sourceId", type: "bytes32" },
          { name: "votingRound", type: "uint64" },
          { name: "lowestUsedTimestamp", type: "uint64" },
          { name: "requestBody", type: "tuple", components: [
            { name: "transactionId", type: "bytes32" },
            { name: "inUtxo", type: "uint256" },
            { name: "utxo", type: "uint256" },
          ]},
          { name: "responseBody", type: "tuple", components: [
            { name: "blockNumber", type: "uint64" },
            { name: "blockTimestamp", type: "uint64" },
            { name: "sourceAddressHash", type: "bytes32" },
            { name: "sourceAddressesRoot", type: "bytes32" },
            { name: "receivingAddressHash", type: "bytes32" },
            { name: "intendedReceivingAddressHash", type: "bytes32" },
            { name: "spentAmount", type: "int256" },
            { name: "intendedSpentAmount", type: "int256" },
            { name: "receivedAmount", type: "int256" },
            { name: "intendedReceivedAmount", type: "int256" },
            { name: "standardPaymentReference", type: "bytes32" },
            { name: "oneToOne", type: "bool" },
            { name: "status", type: "uint8" },
          ]},
        ]},
      ]},
      { name: "_data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;
