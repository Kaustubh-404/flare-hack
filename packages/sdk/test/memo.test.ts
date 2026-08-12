/**
 * Every assertion here mirrors a `require()` in MemoInstructions.sol.
 * If one of these fails, an XRPL payment built by the SDK would revert
 * on-chain after the user already signed and paid — so these run first.
 */

import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import type { Address, Hex } from "viem";

import {
  HEADER_BYTES,
  MEMO_LENGTH,
  OPCODE,
  decodeMemo,
  encodeExecuteCommittedMemo,
  encodeExecuteInlineMemo,
  encodeIgnoreMemo,
  encodeRemoveExecutorMemo,
  encodeReplacementFeeMemo,
  encodeSetExecutorMemo,
  encodeSetNonceMemo,
  fromXrplMemoHex,
  toXrplMemoHex,
} from "../src/memo.js";
import { encodeUserOp, hashUserOp, prepareUserOp, type Call } from "../src/userop.js";

const HASH32: Hex = `0x${"ab".repeat(32)}`;
const EXECUTOR: Address = "0xE74686Fd89ACB480B3903724C367395d86ED4519";
const FEE = 1_000_000n;

describe("header layout [opcode:1][walletId:1][executorFeeUBA:8]", () => {
  it("places opcode, walletId and a big-endian uint64 fee", () => {
    const memo = encodeExecuteCommittedMemo({
      walletId: 0x2a,
      executorFeeUBA: 0x0102030405060708n,
      userOpHash: HASH32,
    });
    expect(memo[0]).toBe(OPCODE.EXECUTE_COMMITTED);
    expect(memo[1]).toBe(0x2a);
    // big-endian: most significant byte first
    expect(Array.from(memo.slice(2, 10))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("defaults walletId to 0 when unregistered", () => {
    const memo = encodeExecuteCommittedMemo({ executorFeeUBA: FEE, userOpHash: HASH32 });
    expect(memo[1]).toBe(0);
  });

  it("rejects a walletId outside uint8", () => {
    expect(() =>
      encodeExecuteCommittedMemo({ walletId: 256, executorFeeUBA: FEE, userOpHash: HASH32 }),
    ).toThrow(/uint8/);
  });

  it("rejects a fee outside uint64", () => {
    expect(() =>
      encodeExecuteCommittedMemo({ executorFeeUBA: 1n << 64n, userOpHash: HASH32 }),
    ).toThrow(/uint64/);
  });
});

describe("exact lengths the contract requires", () => {
  it("0xFE committed execute is exactly 42 bytes", () => {
    const memo = encodeExecuteCommittedMemo({ executorFeeUBA: FEE, userOpHash: HASH32 });
    expect(memo.length).toBe(42);
    expect(memo.length).toBe(MEMO_LENGTH[OPCODE.EXECUTE_COMMITTED]);
  });

  it("0xD0 setExecutor is exactly 30 bytes", () => {
    const memo = encodeSetExecutorMemo({ executorFeeUBA: FEE, executor: EXECUTOR });
    expect(memo.length).toBe(30);
  });

  it("0xD1 removeExecutor is exactly the 10-byte header", () => {
    const memo = encodeRemoveExecutorMemo({ executorFeeUBA: FEE });
    expect(memo.length).toBe(10);
    expect(memo.length).toBe(HEADER_BYTES);
  });

  it("0xE0 ignoreMemo is exactly 42 bytes", () => {
    expect(encodeIgnoreMemo({ executorFeeUBA: FEE, targetTxId: HASH32 }).length).toBe(42);
  });

  it("0xE1 setNonce is exactly 42 bytes", () => {
    expect(encodeSetNonceMemo({ executorFeeUBA: FEE, newNonce: 7n }).length).toBe(42);
  });

  it("0xE2 replacementFee is exactly 50 bytes", () => {
    const memo = encodeReplacementFeeMemo({
      executorFeeUBA: FEE,
      targetTxId: HASH32,
      newFeeUBA: 42n,
    });
    expect(memo.length).toBe(50);
  });
});

describe("0xFE size is constant regardless of batch size", () => {
  it("a 1-call and a 50-call batch produce identical memo lengths", () => {
    const call = {
      target: EXECUTOR,
      value: 0n,
      data: "0xd09de08a" as Hex, // increment()
    };
    const one = prepareUserOp({ sender: EXECUTOR, nonce: 0n, calls: [call] });
    const fifty = prepareUserOp({
      sender: EXECUTOR,
      nonce: 0n,
      calls: Array.from({ length: 50 }, () => call),
    });

    const memoOne = encodeExecuteCommittedMemo({
      executorFeeUBA: FEE,
      userOpHash: one.userOpHash,
    });
    const memoFifty = encodeExecuteCommittedMemo({
      executorFeeUBA: FEE,
      userOpHash: fifty.userOpHash,
    });

    expect(memoOne.length).toBe(memoFifty.length);
    expect(memoOne.length).toBe(42);
    // ...while the inline variant grows past the XRPL cap
    expect(fifty.userOpData.length / 2).toBeGreaterThan(1024);
  });

  it("the real 2-call demo batch cannot fit in an inline 0xFF memo", () => {
    // approve + deposit — the batch scripts/demo-deposit.ts actually sends.
    const approve: Call = {
      target: EXECUTOR,
      value: 0n,
      data: ("0x095ea7b3" + "00".repeat(64)) as Hex,
    };
    const deposit: Call = {
      target: EXECUTOR,
      value: 0n,
      data: ("0xb6b55f25" + "00".repeat(32)) as Hex,
    };
    const { userOpData } = prepareUserOp({ sender: EXECUTOR, nonce: 1n, calls: [approve, deposit] });
    const userOpBytes = (userOpData.length - 2) / 2;

    // 0xFF would have to carry the whole thing after a 10-byte header.
    expect(HEADER_BYTES + userOpBytes).toBeGreaterThan(1024);
    expect(() => encodeExecuteInlineMemo({ executorFeeUBA: FEE, userOpData })).toThrow(
      /over the XRPL cap/,
    );

    // 0xFE carries it in 42 bytes regardless.
    const memo = encodeExecuteCommittedMemo({
      executorFeeUBA: FEE,
      userOpHash: keccak256(userOpData),
    });
    expect(memo.length).toBe(42);
  });

  it("0xFF refuses to build past the 1024-byte XRPL cap", () => {
    const big: Hex = `0x${"00".repeat(1100)}`;
    expect(() => encodeExecuteInlineMemo({ executorFeeUBA: FEE, userOpData: big })).toThrow(
      /over the XRPL cap/,
    );
  });
});

describe("round-trip", () => {
  it("decodes a 0xFE memo back to its commitment", () => {
    const memo = encodeExecuteCommittedMemo({
      walletId: 3,
      executorFeeUBA: FEE,
      userOpHash: HASH32,
    });
    const decoded = decodeMemo(memo);
    expect(decoded).toEqual({
      opcode: OPCODE.EXECUTE_COMMITTED,
      walletId: 3,
      executorFeeUBA: FEE,
      userOpHash: HASH32,
    });
  });

  it("decodes a pinned executor back to a checksummed address", () => {
    const memo = encodeSetExecutorMemo({ executorFeeUBA: FEE, executor: EXECUTOR });
    const decoded = decodeMemo(memo);
    if (decoded.opcode !== OPCODE.SET_EXECUTOR) throw new Error("wrong opcode");
    expect(decoded.executor.toLowerCase()).toBe(EXECUTOR.toLowerCase());
  });

  it("survives the XRPL hex wire format", () => {
    const memo = encodeExecuteCommittedMemo({ executorFeeUBA: FEE, userOpHash: HASH32 });
    const wire = toXrplMemoHex(memo);
    expect(wire).toMatch(/^[0-9A-F]+$/); // XRPL wants uppercase, no 0x
    expect(wire.length).toBe(42 * 2);
    expect(Array.from(fromXrplMemoHex(wire))).toEqual(Array.from(memo));
  });

  it("rejects an unknown opcode the way the contract does", () => {
    const bogus = new Uint8Array(42);
    bogus[0] = 0x99;
    expect(() => decodeMemo(bogus)).toThrow(/InvalidInstructionId/);
  });
});

describe("userOp commitment", () => {
  it("hash equals keccak256 of the encoded struct", () => {
    const { userOp, userOpData, userOpHash } = prepareUserOp({
      sender: EXECUTOR,
      nonce: 0n,
      calls: [{ target: EXECUTOR, value: 0n, data: "0xd09de08a" }],
    });
    expect(encodeUserOp(userOp)).toBe(userOpData);
    expect(hashUserOp(userOp)).toBe(userOpHash);
    expect(userOpHash).toBe(keccak256(userOpData));
  });

  it("a different nonce yields a different commitment", () => {
    const call = { target: EXECUTOR, value: 0n, data: "0xd09de08a" as Hex };
    const a = prepareUserOp({ sender: EXECUTOR, nonce: 0n, calls: [call] });
    const b = prepareUserOp({ sender: EXECUTOR, nonce: 1n, calls: [call] });
    expect(a.userOpHash).not.toBe(b.userOpHash);
  });

  it("refuses an empty batch", () => {
    expect(() => prepareUserOp({ sender: EXECUTOR, nonce: 0n, calls: [] })).toThrow(/not be empty/);
  });
});
