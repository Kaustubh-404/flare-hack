import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import type { Hex } from "viem";

import { encodeExecuteCommittedMemo, encodeSetExecutorMemo, toXrplMemoHex } from "@onesig/sdk";
import { commitmentFromMemos, Watcher } from "../src/watcher.js";
import { PendingStore } from "../src/store.js";

const PA = "0x32d9D88C60E263241735adC87D957Db9cfBF7a39" as const;
const USER_OP: Hex = "0xdeadbeefcafebabe";
const COMMITMENT = keccak256(USER_OP);

const memoTx = (memoHex: string) => ({
  TransactionType: "Payment",
  Memos: [{ Memo: { MemoData: memoHex } }],
});

describe("commitmentFromMemos", () => {
  it("extracts the commitment from a 0xFE memo", () => {
    const memo = encodeExecuteCommittedMemo({ executorFeeUBA: 0n, userOpHash: COMMITMENT });
    expect(commitmentFromMemos(memoTx(toXrplMemoHex(memo)))).toBe(COMMITMENT);
  });

  it("ignores a memo that is not 0xFE", () => {
    const memo = encodeSetExecutorMemo({ executorFeeUBA: 0n, executor: PA });
    expect(commitmentFromMemos(memoTx(toXrplMemoHex(memo)))).toBeNull();
  });

  it("ignores a payment with no memos at all", () => {
    expect(commitmentFromMemos({ TransactionType: "Payment" })).toBeNull();
  });

  it("ignores garbage memo data without throwing", () => {
    expect(commitmentFromMemos(memoTx("not hex at all"))).toBeNull();
    expect(commitmentFromMemos(memoTx("FF00"))).toBeNull();
  });
});

describe("PendingStore", () => {
  let dir: string;
  let store: PendingStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "onesig-store-"));
    store = new PendingStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keys entries by keccak256 of the bytes", async () => {
    const commitment = await store.register({
      userOpData: USER_OP,
      personalAccount: PA,
      nonce: "0",
      totalCallValue: "0",
      label: "test",
    });
    expect(commitment).toBe(COMMITMENT);
    expect((await store.get(COMMITMENT))?.userOpData).toBe(USER_OP);
  });

  it("refuses a payload registered under someone else's commitment", async () => {
    // Without this, a caller could get the executor to submit bytes the user
    // never committed to in their XRPL memo.
    await expect(
      store.register({
        commitment: keccak256("0x1234"),
        userOpData: USER_OP,
        personalAccount: PA,
        nonce: "0",
        totalCallValue: "0",
        label: "malicious",
      }),
    ).rejects.toThrow(/commitment mismatch/);
  });

  it("returns null for an unknown commitment", async () => {
    expect(await store.get(keccak256("0xabcd"))).toBeNull();
  });
});

describe("Watcher", () => {
  let dir: string;
  let store: PendingStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "onesig-watch-"));
    store = new PendingStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fakeXrpl = (transactions: unknown[]) =>
    ({ call: async () => ({ transactions }) }) as never;

  const payment = (memoHex: string, hash: string) => ({
    hash,
    ledger_index: 100,
    validated: true,
    tx_json: {
      TransactionType: "Payment",
      Account: "rSender",
      Amount: "1200000",
      Memos: [{ Memo: { MemoData: memoHex } }],
    },
  });

  it("picks up a payment whose commitment is registered", async () => {
    await store.register({
      userOpData: USER_OP,
      personalAccount: PA,
      nonce: "0",
      totalCallValue: "0",
      label: "Increment the counter",
    });
    const memo = toXrplMemoHex(
      encodeExecuteCommittedMemo({ executorFeeUBA: 0n, userOpHash: COMMITMENT }),
    );

    const watcher = new Watcher(fakeXrpl([payment(memo, "ABC123")]), store, "rCoreVault", () => {});
    const observed = await watcher.poll();

    expect(observed).toHaveLength(1);
    expect(observed[0]!.xrplTxId).toBe("ABC123");
    expect(observed[0]!.commitment).toBe(COMMITMENT);
  });

  it("ignores a 0xFE payment it was never told about", async () => {
    // The Core Vault is shared: every FXRP direct mint on the network lands
    // there. Reacting to a commitment we hold no bytes for would be guessing.
    const otherCommitment = keccak256("0xfeedface");
    const memo = toXrplMemoHex(
      encodeExecuteCommittedMemo({ executorFeeUBA: 0n, userOpHash: otherCommitment }),
    );

    const watcher = new Watcher(fakeXrpl([payment(memo, "OTHER")]), store, "rCoreVault", () => {});
    expect(await watcher.poll()).toHaveLength(0);
  });

  it("ignores unvalidated transactions", async () => {
    await store.register({
      userOpData: USER_OP,
      personalAccount: PA,
      nonce: "0",
      totalCallValue: "0",
      label: "test",
    });
    const memo = toXrplMemoHex(
      encodeExecuteCommittedMemo({ executorFeeUBA: 0n, userOpHash: COMMITMENT }),
    );
    const unvalidated = { ...payment(memo, "PENDING"), validated: false };

    const watcher = new Watcher(fakeXrpl([unvalidated]), store, "rCoreVault", () => {});
    expect(await watcher.poll()).toHaveLength(0);
  });
});

describe("Watcher — no repeat reporting", () => {
  let dir: string;
  let store: PendingStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "onesig-repeat-"));
    store = new PendingStore(dir);
    await store.register({
      userOpData: USER_OP,
      personalAccount: PA,
      nonce: "0",
      totalCallValue: "0",
      label: "test",
    });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a payment once even though ledger_index_min is inclusive", async () => {
    const memo = toXrplMemoHex(
      encodeExecuteCommittedMemo({ executorFeeUBA: 0n, userOpHash: COMMITMENT }),
    );
    const tx = {
      hash: "REPEATED",
      ledger_index: 100,
      validated: true,
      tx_json: {
        TransactionType: "Payment",
        Account: "rSender",
        Amount: "1200000",
        Memos: [{ Memo: { MemoData: memo } }],
      },
    };
    // The same transaction is returned by every poll, exactly as the real
    // account_tx endpoint does once the cursor sits on its ledger.
    const watcher = new Watcher(
      { call: async () => ({ transactions: [tx] }) } as never,
      store,
      "rCoreVault",
      () => {},
    );

    expect(await watcher.poll()).toHaveLength(1);
    expect(await watcher.poll()).toHaveLength(0);
    expect(await watcher.poll()).toHaveLength(0);
    expect(watcher.seenCount).toBe(1);
  });
});
