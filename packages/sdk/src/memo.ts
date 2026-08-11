/**
 * XRPL memo encoding for Flare Smart Accounts.
 *
 * Byte layouts here are transcribed from the authoritative Solidity, not the docs:
 *   flare-smart-accounts/contracts/smartAccounts/library/MemoInstructions.sol
 *   flare-smart-accounts/contracts/smartAccounts/facets/MemoInstructionsFacet.sol
 *
 * Every layout is asserted against the exact `require(_memoData.length == N)` the
 * contract enforces, so a malformed memo fails here rather than after an XRPL
 * payment has already been signed and burned a nonce.
 */

import type { Address, Hex } from "viem";
import { isAddress, isHex } from "viem";

// ─── Opcodes ──────────────────────────────────────────────────────────────
// Dispatch table: MemoInstructionsFacet.handleMintedFAssets, lines 84-97.

export const OPCODE = {
  /** Execute: PackedUserOperation ABI-encoded inline, after the 10-byte header. */
  EXECUTE_INLINE: 0xff,
  /** Execute: memo carries only keccak256(userOpData); executor delivers the bytes. */
  EXECUTE_COMMITTED: 0xfe,
  /** Mark a target XRPL txId's memo as ignored (recovery from a stuck memo). */
  IGNORE_MEMO: 0xe0,
  /** Fast-forward the personal account nonce. */
  SET_NONCE: 0xe1,
  /** Override the executor fee for a target txId (fee bump). */
  SET_REPLACEMENT_FEE: 0xe2,
  /** Pin an executor. Only this address may relay afterwards. */
  SET_EXECUTOR: 0xd0,
  /** Unpin the executor. */
  REMOVE_EXECUTOR: 0xd1,
} as const;

export type Opcode = (typeof OPCODE)[keyof typeof OPCODE];

/** Exact memo lengths the contract requires, in bytes. */
export const MEMO_LENGTH = {
  [OPCODE.EXECUTE_COMMITTED]: 42,
  [OPCODE.IGNORE_MEMO]: 42,
  [OPCODE.SET_NONCE]: 42,
  [OPCODE.SET_REPLACEMENT_FEE]: 50,
  [OPCODE.SET_EXECUTOR]: 30,
  [OPCODE.REMOVE_EXECUTOR]: 10,
} as const;

/** Shared header: [opcode:1][walletId:1][executorFeeUBA:8]. */
export const HEADER_BYTES = 10;

/** XRPL caps a single memo field at 1024 bytes. Only 0xFF can approach it. */
export const XRPL_MEMO_MAX_BYTES = 1024;

// ─── Header ───────────────────────────────────────────────────────────────

export interface MemoHeader {
  /** Wallet identifier assigned by the Flare Foundation; 0 if unregistered. */
  walletId?: number;
  /** Executor fee in the FAsset's smallest unit (UBA), big-endian uint64. */
  executorFeeUBA: bigint;
}

function encodeHeader(opcode: Opcode, { walletId = 0, executorFeeUBA }: MemoHeader): Uint8Array {
  if (!Number.isInteger(walletId) || walletId < 0 || walletId > 0xff) {
    throw new RangeError(`walletId must be a uint8, got ${walletId}`);
  }
  if (executorFeeUBA < 0n || executorFeeUBA > 0xffffffffffffffffn) {
    throw new RangeError(`executorFeeUBA must fit in uint64, got ${executorFeeUBA}`);
  }

  const header = new Uint8Array(HEADER_BYTES);
  header[0] = opcode;
  header[1] = walletId;
  // uint64 big-endian at offset 2
  new DataView(header.buffer).setBigUint64(2, executorFeeUBA, false);
  return header;
}

function hexToBytes(hex: Hex, expectedBytes?: number): Uint8Array {
  if (!isHex(hex)) throw new TypeError(`expected 0x-prefixed hex, got ${String(hex)}`);
  const body = hex.slice(2);
  if (body.length % 2 !== 0) throw new TypeError(`hex has odd length: ${hex}`);
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw new RangeError(`expected ${expectedBytes} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Assert the encoded memo matches the length the contract requires. */
function assertLength(opcode: keyof typeof MEMO_LENGTH, memo: Uint8Array): Uint8Array {
  const expected = MEMO_LENGTH[opcode];
  if (memo.length !== expected) {
    throw new RangeError(
      `opcode 0x${opcode.toString(16)} requires exactly ${expected} bytes, built ${memo.length}. ` +
        `The contract reverts with InvalidMemoData().`,
    );
  }
  return memo;
}

// ─── 0xFE — committed execute (the recommended path) ──────────────────────

/**
 * [0xFE][walletId:1][executorFeeUBA:8][userOpHash:32] = 42 bytes
 *
 * The memo publishes only a commitment. The PackedUserOperation bytes travel
 * off-chain to the executor, which means the call targets and calldata stay
 * private on XRPL until the executor submits them. This is the property LATCH
 * is built on.
 */
export function encodeExecuteCommittedMemo(
  header: MemoHeader & { userOpHash: Hex },
): Uint8Array {
  const memo = concat(
    encodeHeader(OPCODE.EXECUTE_COMMITTED, header),
    hexToBytes(header.userOpHash, 32),
  );
  return assertLength(OPCODE.EXECUTE_COMMITTED, memo);
}

// ─── 0xFF — inline execute ────────────────────────────────────────────────

/**
 * [0xFF][walletId:1][executorFeeUBA:8][abi.encode(PackedUserOperation)]
 *
 * Single-actor variant: no executor required, but the whole user operation
 * rides in the memo and is therefore public on XRPL and bounded by the
 * 1024-byte cap.
 */
export function encodeExecuteInlineMemo(
  header: MemoHeader & { userOpData: Hex },
): Uint8Array {
  const memo = concat(
    encodeHeader(OPCODE.EXECUTE_INLINE, header),
    hexToBytes(header.userOpData),
  );
  if (memo.length > XRPL_MEMO_MAX_BYTES) {
    throw new RangeError(
      `memo is ${memo.length} bytes, over the XRPL cap of ${XRPL_MEMO_MAX_BYTES}. ` +
        `Use encodeExecuteCommittedMemo (0xFE) — its size is constant regardless of batch size.`,
    );
  }
  return memo;
}

// ─── 0xD0 / 0xD1 — executor pinning ───────────────────────────────────────

/**
 * [0xD0][walletId:1][executorFeeUBA:8][executor:20] = 30 bytes
 *
 * Pins an executor: afterwards `handleMintedFAssets` reverts with
 * WrongExecutor() for anyone else. This is how a user hands exclusive relay
 * rights to an attested TEE.
 */
export function encodeSetExecutorMemo(
  header: MemoHeader & { executor: Address },
): Uint8Array {
  if (!isAddress(header.executor)) {
    throw new TypeError(`invalid executor address: ${header.executor}`);
  }
  if (/^0x0{40}$/i.test(header.executor)) {
    throw new RangeError(`executor must not be the zero address (contract reverts AddressZero())`);
  }
  const memo = concat(
    encodeHeader(OPCODE.SET_EXECUTOR, header),
    hexToBytes(header.executor as Hex, 20),
  );
  return assertLength(OPCODE.SET_EXECUTOR, memo);
}

/**
 * [0xD1][walletId:1][executorFeeUBA:8] = 10 bytes
 *
 * Unpins. Note that 0xD0 and 0xD1 deliberately bypass the executor check
 * (MemoInstructionsFacet line 63-66) so a user can never be locked out by the
 * executor they pinned. That guarantee is protocol-level, not something LATCH
 * has to promise.
 */
export function encodeRemoveExecutorMemo(header: MemoHeader): Uint8Array {
  const memo = encodeHeader(OPCODE.REMOVE_EXECUTOR, header);
  return assertLength(OPCODE.REMOVE_EXECUTOR, memo);
}

// ─── 0xE0 / 0xE1 / 0xE2 — recovery ────────────────────────────────────────

/** [0xE0][walletId:1][fee:8][targetTxId:32] = 42 bytes — skip a stuck memo. */
export function encodeIgnoreMemo(header: MemoHeader & { targetTxId: Hex }): Uint8Array {
  const memo = concat(encodeHeader(OPCODE.IGNORE_MEMO, header), hexToBytes(header.targetTxId, 32));
  return assertLength(OPCODE.IGNORE_MEMO, memo);
}

/** [0xE1][walletId:1][fee:8][newNonce:32] = 42 bytes — fast-forward the nonce. */
export function encodeSetNonceMemo(header: MemoHeader & { newNonce: bigint }): Uint8Array {
  if (header.newNonce < 0n || header.newNonce > (1n << 256n) - 1n) {
    throw new RangeError(`newNonce must fit in uint256`);
  }
  const nonceBytes = new Uint8Array(32);
  let n = header.newNonce;
  for (let i = 31; i >= 0; i--) {
    nonceBytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  const memo = concat(encodeHeader(OPCODE.SET_NONCE, header), nonceBytes);
  return assertLength(OPCODE.SET_NONCE, memo);
}

/** [0xE2][walletId:1][fee:8][targetTxId:32][newFee:8] = 50 bytes — bump a stuck fee. */
export function encodeReplacementFeeMemo(
  header: MemoHeader & { targetTxId: Hex; newFeeUBA: bigint },
): Uint8Array {
  if (header.newFeeUBA < 0n || header.newFeeUBA > 0xffffffffffffffffn) {
    throw new RangeError(`newFeeUBA must fit in uint64`);
  }
  const feeBytes = new Uint8Array(8);
  new DataView(feeBytes.buffer).setBigUint64(0, header.newFeeUBA, false);
  const memo = concat(
    encodeHeader(OPCODE.SET_REPLACEMENT_FEE, header),
    hexToBytes(header.targetTxId, 32),
    feeBytes,
  );
  return assertLength(OPCODE.SET_REPLACEMENT_FEE, memo);
}

// ─── XRPL wire format ─────────────────────────────────────────────────────

/** XRPL MemoData is uppercase hex without a 0x prefix. */
export function toXrplMemoHex(memo: Uint8Array): string {
  return Array.from(memo, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function fromXrplMemoHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return hexToBytes(`0x${clean}` as Hex);
}

// ─── Decoding (tests, debugging, the human-readable directory) ────────────

export type DecodedMemo =
  | { opcode: 0xff; walletId: number; executorFeeUBA: bigint; userOpData: Hex }
  | { opcode: 0xfe; walletId: number; executorFeeUBA: bigint; userOpHash: Hex }
  | { opcode: 0xe0; walletId: number; executorFeeUBA: bigint; targetTxId: Hex }
  | { opcode: 0xe1; walletId: number; executorFeeUBA: bigint; newNonce: bigint }
  | { opcode: 0xe2; walletId: number; executorFeeUBA: bigint; targetTxId: Hex; newFeeUBA: bigint }
  | { opcode: 0xd0; walletId: number; executorFeeUBA: bigint; executor: Address }
  | { opcode: 0xd1; walletId: number; executorFeeUBA: bigint };

const toHex = (b: Uint8Array): Hex =>
  `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;

export function decodeMemo(memo: Uint8Array): DecodedMemo {
  if (memo.length < HEADER_BYTES) {
    throw new RangeError(`memo shorter than the ${HEADER_BYTES}-byte header`);
  }
  const opcode = memo[0] as Opcode;
  const walletId = memo[1]!;
  const executorFeeUBA = new DataView(memo.buffer, memo.byteOffset).getBigUint64(2, false);
  const base = { walletId, executorFeeUBA };

  switch (opcode) {
    case OPCODE.EXECUTE_INLINE:
      return { opcode, ...base, userOpData: toHex(memo.slice(10)) };
    case OPCODE.EXECUTE_COMMITTED:
      assertLength(opcode, memo);
      return { opcode, ...base, userOpHash: toHex(memo.slice(10, 42)) };
    case OPCODE.IGNORE_MEMO:
      assertLength(opcode, memo);
      return { opcode, ...base, targetTxId: toHex(memo.slice(10, 42)) };
    case OPCODE.SET_NONCE: {
      assertLength(opcode, memo);
      return { opcode, ...base, newNonce: BigInt(toHex(memo.slice(10, 42))) };
    }
    case OPCODE.SET_REPLACEMENT_FEE: {
      assertLength(opcode, memo);
      const view = new DataView(memo.buffer, memo.byteOffset);
      return {
        opcode,
        ...base,
        targetTxId: toHex(memo.slice(10, 42)),
        newFeeUBA: view.getBigUint64(42, false),
      };
    }
    case OPCODE.SET_EXECUTOR:
      assertLength(opcode, memo);
      return { opcode, ...base, executor: toHex(memo.slice(10, 30)) as Address };
    case OPCODE.REMOVE_EXECUTOR:
      assertLength(opcode, memo);
      return { opcode, ...base };
    default:
      throw new RangeError(
        `unknown instruction id 0x${(opcode as number).toString(16)} ` +
          `(contract reverts InvalidInstructionId)`,
      );
  }
}
