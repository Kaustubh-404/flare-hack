import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";

import { ExecutorPipeline, normalizeXrplTxId, type Job } from "../src/pipeline.js";
import { DaLayerNotReadyError, VerifierNotReadyError } from "../src/fdc.js";

// A fabricated XRPL transaction hash, not a key. not-a-secret
const TX = "A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90"; // not-a-secret
const PA = "0x32d9D88C60E263241735adC87D957Db9cfBF7a39" as const;

describe("normalizeXrplTxId", () => {
  it("adds the 0x prefix and uppercases", () => {
    expect(normalizeXrplTxId(TX.toLowerCase())).toBe(`0x${TX}`);
  });

  it("accepts an already-prefixed hash", () => {
    expect(normalizeXrplTxId(`0x${TX}`)).toBe(`0x${TX}`);
  });

  it("rejects anything that is not 32 bytes", () => {
    expect(() => normalizeXrplTxId("0xdeadbeef")).toThrow(/32-byte/);
    expect(() => normalizeXrplTxId("not a hash")).toThrow(/32-byte/);
  });
});

describe("job persistence", () => {
  let dir: string;
  let pipeline: ExecutorPipeline;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "onesig-exec-"));
    pipeline = new ExecutorPipeline({
      // Steps are never invoked in these tests; only persistence is exercised.
      publicClient: {} as never,
      walletClient: {} as never,
      account: { address: PA } as never,
      fdc: {} as never,
      assetManager: PA,
      stateDir: dir,
      log: () => {},
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists a new job keyed by the XRPL tx id", async () => {
    const job = await pipeline.create({
      xrplTxId: TX,
      userOpData: "0xdeadbeef" as Hex,
      totalCallValue: 0n,
      personalAccount: PA,
      nonce: 0n,
    });
    expect(job.state).toBe("observed");

    const onDisk = JSON.parse(await readFile(join(dir, `${TX}.json`), "utf8")) as Job;
    expect(onDisk.xrplTxId).toBe(`0x${TX}`);
    expect(onDisk.userOpData).toBe("0xdeadbeef");
  });

  it("is idempotent — a repeated XRPL tx resumes rather than duplicating", async () => {
    const first = await pipeline.create({
      xrplTxId: TX,
      userOpData: "0xdeadbeef" as Hex,
      totalCallValue: 0n,
      personalAccount: PA,
      nonce: 0n,
    });
    first.state = "request_submitted";
    first.roundId = 4242;
    await pipeline.save(first);

    // A restart, or the watcher seeing the same payment twice.
    const second = await pipeline.create({
      xrplTxId: TX,
      userOpData: "0xdeadbeef" as Hex,
      totalCallValue: 0n,
      personalAccount: PA,
      nonce: 0n,
    });

    // Must NOT reset to "observed" — that would re-pay the attestation fee
    // and burn another round.
    expect(second.state).toBe("request_submitted");
    expect(second.roundId).toBe(4242);
  });

  it("returns null for an unknown job", async () => {
    expect(await pipeline.load("nope")).toBeNull();
  });
});

describe("retry classification", () => {
  let dir: string;
  let pipeline: ExecutorPipeline;
  let job: Job;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "onesig-exec-"));
    pipeline = new ExecutorPipeline({
      publicClient: {} as never,
      walletClient: {} as never,
      account: { address: PA } as never,
      assetManager: PA,
      stateDir: dir,
      log: () => {},
      fdc: {
        prepareRequest: async () => {
          throw new VerifierNotReadyError("INVALID: TRANSACTION DOES NOT EXIST");
        },
      } as never,
    });
    job = await pipeline.create({
      xrplTxId: TX,
      userOpData: "0x00" as Hex,
      totalCallValue: 0n,
      personalAccount: PA,
      nonce: 0n,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps retrying a lagging verifier instead of failing the job", async () => {
    // The XRPL tx routinely has not reached the verifier's indexer yet. Ten
    // consecutive misses must not mark the job failed — the money is already
    // at the Core Vault and the mint is still recoverable.
    for (let i = 0; i < 10; i++) job = await pipeline.step(job);
    expect(job.state).toBe("observed");
    expect(job.attempts).toBe(10);
    expect(job.lastError).toMatch(/verifier not ready/);
  });

  it("gives up on a non-retryable error after 5 attempts", async () => {
    const hard = new ExecutorPipeline({
      publicClient: {} as never,
      walletClient: {} as never,
      account: { address: PA } as never,
      assetManager: PA,
      stateDir: dir,
      log: () => {},
      fdc: {
        prepareRequest: async () => {
          throw new Error("verifier HTTP 500: upstream exploded");
        },
      } as never,
    });
    let j = await hard.create({
      xrplTxId: TX.replace(/^A1/, "B2"),
      userOpData: "0x00" as Hex,
      totalCallValue: 0n,
      personalAccount: PA,
      nonce: 0n,
    });
    for (let i = 0; i < 5; i++) j = await hard.step(j);
    expect(j.state).toBe("failed");
  });
});

describe("error types", () => {
  it("distinguishes retryable lag from real failure", () => {
    expect(new VerifierNotReadyError("INVALID: X")).toBeInstanceOf(Error);
    expect(new VerifierNotReadyError("INVALID: X").name).toBe("VerifierNotReadyError");
    expect(new DaLayerNotReadyError("not published").name).toBe("DaLayerNotReadyError");
  });
});
