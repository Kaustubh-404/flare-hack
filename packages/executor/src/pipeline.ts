/**
 * The executor pipeline: one XRPL payment → FXRP minted → user operation run.
 *
 * Written as a persisted state machine rather than a straight-line async
 * function, for three reasons that all show up in practice:
 *
 *   1. An FDC round takes minutes. A crash or restart mid-flight must not lose
 *      the request — resubmitting costs another fee and another round.
 *   2. Each step fails in its own retryable way. The verifier lags the XRPL
 *      ledger; the DA layer lags round finalisation. Neither is an error.
 *   3. Rate limits DELAY rather than reject. A delayed mint is resumed with the
 *      *same* proof once `executionAllowedAt` passes — never a second payment.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Account, Address, Hex, PublicClient, WalletClient } from "viem";
import { decodeEventLog } from "viem";
import { coston2 } from "@flarenetwork/flare-wagmi-periphery-package";

import { DaLayerNotReadyError, FdcClient, VerifierNotReadyError } from "./fdc.js";

/**
 * `PaymentAlreadyConfirmed()` — someone else finalised this mint first.
 *
 * The Core Vault is a shared, publicly executable queue: any pending payment
 * can be finalised by anyone willing to pay the gas, and they collect the
 * executor fee. Competing relayers are live on Coston2 and do exactly this.
 *
 * So losing the race is a normal outcome, not a failure. The user's operation
 * still executed — just at someone else's expense. Retrying is pointless and
 * only burns gas.
 *
 * An account that needs a specific relayer should pin one with the 0xD0 memo
 * opcode; `handleMintedFAssets` then reverts WrongExecutor for anyone else.
 */
const PAYMENT_ALREADY_CONFIRMED_SELECTOR = "0x18dce79f";

export type JobState =
  | "observed"
  | "request_prepared"
  | "request_submitted"
  | "round_finalized"
  | "proof_fetched"
  | "delayed"
  | "executed"
  | "failed";

export interface Job {
  id: string;
  state: JobState;
  /** XRPL transaction that carried the 0xFE memo. */
  xrplTxId: Hex;
  /** ABI-encoded PackedUserOperation. Never published on XRPL. */
  userOpData: Hex;
  /** Sum of call values; forwarded as msg.value. */
  totalCallValue: string;
  personalAccount: Address;
  nonce: string;
  abiEncodedRequest?: Hex;
  roundId?: number;
  flareTxHash?: Hex;
  /** Set when a rate limit delays the mint. Retry with the same proof after this. */
  executionAllowedAt?: number;
  attempts: number;
  lastError?: string;
  updatedAt: number;
}

export interface PipelineOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** The Account OBJECT, not an address — see ExecutorClients.account. */
  account: Account;
  fdc: FdcClient;
  assetManager: Address;
  /** Where jobs are persisted so a restart resumes instead of re-paying. */
  stateDir?: string;
  log?: (msg: string) => void;
}

/** Normalise an XRPL tx hash to the 0x-prefixed 32-byte form the verifier wants. */
export function normalizeXrplTxId(hash: string): Hex {
  const clean = hash.startsWith("0x") ? hash.slice(2) : hash;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`not a 32-byte XRPL transaction hash: ${hash}`);
  }
  return `0x${clean.toUpperCase()}` as Hex;
}

export class ExecutorPipeline {
  readonly #opts: Required<Pick<PipelineOptions, "stateDir" | "log">> & PipelineOptions;

  constructor(options: PipelineOptions) {
    this.#opts = {
      ...options,
      stateDir: options.stateDir ?? ".executor-state",
      log: options.log ?? ((m) => console.log(m)),
    };
  }

  #path(id: string): string {
    return join(this.#opts.stateDir, `${id}.json`);
  }

  async load(id: string): Promise<Job | null> {
    try {
      return JSON.parse(await readFile(this.#path(id), "utf8")) as Job;
    } catch {
      return null;
    }
  }

  async save(job: Job): Promise<void> {
    job.updatedAt = Date.now();
    const path = this.#path(job.id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(job, null, 2));
  }

  async create(params: {
    xrplTxId: string;
    userOpData: Hex;
    totalCallValue: bigint;
    personalAccount: Address;
    nonce: bigint;
  }): Promise<Job> {
    const xrplTxId = normalizeXrplTxId(params.xrplTxId);
    const existing = await this.load(xrplTxId.slice(2));
    if (existing) return existing;

    const job: Job = {
      id: xrplTxId.slice(2),
      state: "observed",
      xrplTxId,
      userOpData: params.userOpData,
      totalCallValue: params.totalCallValue.toString(),
      personalAccount: params.personalAccount,
      nonce: params.nonce.toString(),
      attempts: 0,
      updatedAt: Date.now(),
    };
    await this.save(job);
    return job;
  }

  /**
   * Advance one step. Returns the job. Callers loop until terminal.
   * Each transition is persisted before returning, so the next call resumes
   * exactly where this one stopped.
   */
  async step(job: Job): Promise<Job> {
    const { fdc, log } = this.#opts;

    try {
      switch (job.state) {
        case "observed": {
          log(`[${short(job.id)}] preparing attestation request…`);
          job.abiEncodedRequest = await fdc.prepareRequest({
            xrplTransactionId: job.xrplTxId,
            proofOwner: this.#opts.account.address,
          });
          job.state = "request_prepared";
          break;
        }

        case "request_prepared": {
          log(`[${short(job.id)}] submitting attestation request on-chain…`);
          const { roundId } = await fdc.submitRequest(job.abiEncodedRequest!);
          job.roundId = roundId;
          job.state = "request_submitted";
          log(
            `[${short(job.id)}] round ${roundId} — ` +
              `https://coston2-systems-explorer.flare.network/voting-round/${roundId}?tab=fdc`,
          );
          break;
        }

        case "request_submitted": {
          const finalized = await fdc.isRoundFinalized(job.roundId!);
          if (!finalized) {
            log(`[${short(job.id)}] round ${job.roundId} not finalised yet…`);
            return job; // no state change; caller waits and calls again
          }
          job.state = "round_finalized";
          log(`[${short(job.id)}] round ${job.roundId} finalised`);
          break;
        }

        case "round_finalized": {
          await fdc.fetchProof(job.abiEncodedRequest!, job.roundId!);
          job.state = "proof_fetched";
          log(`[${short(job.id)}] proof retrieved`);
          break;
        }

        case "delayed": {
          if (job.executionAllowedAt && Date.now() < job.executionAllowedAt) {
            const secs = Math.ceil((job.executionAllowedAt - Date.now()) / 1000);
            log(`[${short(job.id)}] rate-limited; ${secs}s until execution is allowed`);
            return job;
          }
          job.state = "proof_fetched"; // retry with the SAME proof
          break;
        }

        case "proof_fetched": {
          const proof = await fdc.fetchProof(job.abiEncodedRequest!, job.roundId!);
          log(`[${short(job.id)}] executeDirectMintingWithData…`);
          const hash = await this.#opts.walletClient.writeContract({
            account: this.#opts.account,
            chain: null,
            address: this.#opts.assetManager,
            abi: coston2.iDirectMintingAbi,
            functionName: "executeDirectMintingWithData",
            args: [proof as never, job.userOpData],
            value: BigInt(job.totalCallValue),
          });
          job.flareTxHash = hash;

          const receipt = await this.#opts.publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status === "reverted") {
            throw new Error(`executeDirectMintingWithData reverted (tx ${hash})`);
          }

          const delay = findDelayedEvent(receipt.logs);
          if (delay !== null) {
            job.executionAllowedAt = delay * 1000;
            job.state = "delayed";
            log(
              `[${short(job.id)}] mint DELAYED by rate limits until ` +
                `${new Date(delay * 1000).toISOString()} — this is not a failure, ` +
                `do not send another XRPL payment`,
            );
            break;
          }

          job.state = "executed";
          log(`[${short(job.id)}] ✅ executed — ${hash}`);
          break;
        }

        case "executed":
        case "failed":
          return job;
      }

      job.attempts = 0;
      delete job.lastError;
    } catch (error) {
      // Lost the race to another relayer. The mint happened; we simply did not
      // earn the fee. Confirm on-chain rather than trusting the revert reason.
      if (job.state === "proof_fetched" && isAlreadyConfirmed(error)) {
        const confirmed = await this.#isTransactionUsed(job.xrplTxId);
        if (confirmed) {
          job.state = "executed";
          delete job.lastError;
          this.#opts.log(
            `[${short(job.id)}] ✅ already finalised by another relayer — ` +
              `the operation ran, the executor fee went elsewhere`,
          );
          await this.save(job);
          return job;
        }
      }

      const retryable =
        error instanceof VerifierNotReadyError || error instanceof DaLayerNotReadyError;
      job.attempts += 1;
      job.lastError = error instanceof Error ? error.message : String(error);

      if (!retryable && job.attempts >= 5) {
        job.state = "failed";
        log(`[${short(job.id)}] ❌ failed after ${job.attempts} attempts: ${job.lastError}`);
      } else {
        log(`[${short(job.id)}] retryable (attempt ${job.attempts}): ${job.lastError}`);
      }
    }

    await this.save(job);
    return job;
  }

  /** Has the AssetManager already consumed this XRPL payment? */
  async #isTransactionUsed(xrplTxId: Hex): Promise<boolean> {
    try {
      return await this.#opts.publicClient.readContract({
        address: MASTER_ACCOUNT_CONTROLLER,
        abi: [
          {
            type: "function",
            name: "isTransactionIdUsed",
            stateMutability: "view",
            inputs: [{ name: "_transactionId", type: "bytes32" }],
            outputs: [{ type: "bool" }],
          },
        ] as const,
        functionName: "isTransactionIdUsed",
        args: [xrplTxId],
      });
    } catch {
      return false;
    }
  }

  /** Drive a job to a terminal state. */
  async run(job: Job, opts: { pollMs?: number; timeoutMs?: number } = {}): Promise<Job> {
    const pollMs = opts.pollMs ?? 15_000;
    const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
    let current = job;

    while (current.state !== "executed" && current.state !== "failed") {
      if (Date.now() > deadline) {
        this.#opts.log(`[${short(current.id)}] timed out in state ${current.state}`);
        return current;
      }
      const before = current.state;
      current = await this.step(current);
      if (current.state === before) await sleep(pollMs);
    }
    return current;
  }
}

/** Returns the unix seconds an execution becomes allowed, or null if not delayed. */
function findDelayedEvent(logs: readonly { data: Hex; topics: readonly Hex[] }[]): number | null {
  for (const entry of logs) {
    try {
      const decoded = decodeEventLog({
        abi: coston2.iDirectMintingAbi,
        data: entry.data,
        topics: entry.topics as [Hex, ...Hex[]],
      });
      if (
        decoded.eventName === "DirectMintingDelayed" ||
        decoded.eventName === "LargeDirectMintingDelayed"
      ) {
        const args = decoded.args as Record<string, unknown>;
        const at = args["executionAllowedAt"];
        if (typeof at === "bigint") return Number(at);
      }
    } catch {
      // not one of ours
    }
  }
  return null;
}

/** Same on every Flare network — see the Smart Accounts reference. */
const MASTER_ACCOUNT_CONTROLLER: Address = "0x434936d47503353f06750Db1A444DBDC5F0AD37c";

function isAlreadyConfirmed(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.toLowerCase().includes(PAYMENT_ALREADY_CONFIRMED_SELECTOR);
}

const short = (id: string) => id.slice(0, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
