/**
 * PackedUserOperation assembly for Flare Smart Accounts.
 *
 * The controller does exactly this (MemoInstructions.execute):
 *   userOp = abi.decode(_data, (PackedUserOperation))
 *   require(userOp.sender == personalAccount)      -> InvalidSender
 *   require(userOp.nonce  == state.nonces[pa])     -> InvalidNonce
 *   personalAccount.call{value: msg.value}(userOp.callData)
 *
 * Only sender / nonce / callData are validated. The remaining EIP-4337 fields
 * exist so the struct decodes, and are left zeroed.
 */

import { encodeAbiParameters, encodeFunctionData, keccak256 } from "viem";
import type { Address, Hex } from "viem";

/** IPersonalAccount.Call — one entry in a batch. */
export interface Call {
  target: Address;
  value: bigint;
  data: Hex;
}

/** EIP-4337 v0.7 PackedUserOperation (OpenZeppelin draft-IERC4337). */
export interface PackedUserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;

export const PACKED_USER_OPERATION_ABI = [
  {
    type: "tuple",
    components: [
      { name: "sender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "initCode", type: "bytes" },
      { name: "callData", type: "bytes" },
      { name: "accountGasLimits", type: "bytes32" },
      { name: "preVerificationGas", type: "uint256" },
      { name: "gasFees", type: "bytes32" },
      { name: "paymasterAndData", type: "bytes" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

/** IPersonalAccount.executeUserOp(Call[]) — the only callData the PA accepts. */
export const EXECUTE_USER_OP_ABI = [
  {
    type: "function",
    name: "executeUserOp",
    stateMutability: "payable",
    inputs: [
      {
        name: "_calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

/**
 * Encode a batch into the callData the controller invokes on the personal
 * account. Anything other than executeUserOp is rejected by onlyController.
 */
export function encodeCallBatch(calls: readonly Call[]): Hex {
  if (calls.length === 0) throw new RangeError("call batch must not be empty");
  return encodeFunctionData({
    abi: EXECUTE_USER_OP_ABI,
    functionName: "executeUserOp",
    args: [calls.map((c) => ({ target: c.target, value: c.value, data: c.data }))],
  });
}

/** Build a PackedUserOperation with the three meaningful fields set. */
export function buildUserOp(params: {
  sender: Address;
  nonce: bigint;
  calls: readonly Call[];
}): PackedUserOperation {
  return {
    sender: params.sender,
    nonce: params.nonce,
    initCode: "0x",
    callData: encodeCallBatch(params.calls),
    accountGasLimits: ZERO_BYTES32,
    preVerificationGas: 0n,
    gasFees: ZERO_BYTES32,
    paymasterAndData: "0x",
    signature: "0x",
  };
}

/** abi.encode(userOp) — the bytes the executor delivers as `_data`. */
export function encodeUserOp(userOp: PackedUserOperation): Hex {
  return encodeAbiParameters(PACKED_USER_OPERATION_ABI, [userOp]);
}

/** keccak256(abi.encode(userOp)) — the 32-byte commitment carried in a 0xFE memo. */
export function hashUserOp(userOp: PackedUserOperation): Hex {
  return keccak256(encodeUserOp(userOp));
}

/** Convenience: build, encode, and hash in one step. */
export function prepareUserOp(params: {
  sender: Address;
  nonce: bigint;
  calls: readonly Call[];
}): { userOp: PackedUserOperation; userOpData: Hex; userOpHash: Hex } {
  const userOp = buildUserOp(params);
  const userOpData = encodeUserOp(userOp);
  return { userOp, userOpData, userOpHash: keccak256(userOpData) };
}
