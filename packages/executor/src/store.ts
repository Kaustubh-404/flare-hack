/**
 * Pending user operations, keyed by their commitment.
 *
 * This store is the whole reason the `0xFE` flow is private. The dApp registers
 * the user-operation bytes here; the XRPL only ever carries
 * `keccak256(userOpData)`. Until the executor reveals them on Flare, the call
 * targets and calldata exist in exactly two places: the user's browser and this
 * store.
 *
 * Registration is verified, not trusted: the key is recomputed from the bytes,
 * so a caller cannot register payload A under commitment B and have the
 * executor submit something the user never signed over.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { keccak256 } from "viem";
import type { Address, Hex } from "viem";

export interface PendingUserOp {
  /** keccak256(userOpData) — the commitment published in the XRPL memo. */
  commitment: Hex;
  userOpData: Hex;
  personalAccount: Address;
  nonce: string;
  /** Sum of call values; the executor forwards this as msg.value. */
  totalCallValue: string;
  /** Human-readable summary, for logs and the dashboard. */
  label: string;
  registeredAt: number;
}

export class PendingStore {
  readonly #dir: string;
  readonly #memory = new Map<Hex, PendingUserOp>();

  constructor(dir = ".executor-state/pending") {
    this.#dir = dir;
  }

  /**
   * Register user-operation bytes ahead of the XRPL payment.
   *
   * Throws if the supplied commitment does not match the bytes — the executor
   * must never hold a payload whose hash it has not verified itself.
   */
  async register(entry: Omit<PendingUserOp, "commitment" | "registeredAt"> & { commitment?: Hex }): Promise<Hex> {
    const commitment = keccak256(entry.userOpData);
    if (entry.commitment && entry.commitment.toLowerCase() !== commitment.toLowerCase()) {
      throw new Error(
        `commitment mismatch: claimed ${entry.commitment}, keccak256(userOpData) is ${commitment}`,
      );
    }

    const record: PendingUserOp = {
      commitment,
      userOpData: entry.userOpData,
      personalAccount: entry.personalAccount,
      nonce: entry.nonce,
      totalCallValue: entry.totalCallValue,
      label: entry.label,
      registeredAt: Date.now(),
    };

    this.#memory.set(commitment.toLowerCase() as Hex, record);
    await mkdir(this.#dir, { recursive: true });
    await writeFile(join(this.#dir, `${commitment.slice(2)}.json`), JSON.stringify(record, null, 2));
    return commitment;
  }

  async get(commitment: Hex): Promise<PendingUserOp | null> {
    const key = commitment.toLowerCase() as Hex;
    const cached = this.#memory.get(key);
    if (cached) return cached;
    try {
      const raw = await readFile(join(this.#dir, `${commitment.slice(2)}.json`), "utf8");
      const record = JSON.parse(raw) as PendingUserOp;
      this.#memory.set(key, record);
      return record;
    } catch {
      return null;
    }
  }

  async list(): Promise<PendingUserOp[]> {
    try {
      const files = await readdir(this.#dir);
      const out: PendingUserOp[] = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        out.push(JSON.parse(await readFile(join(this.#dir, f), "utf8")) as PendingUserOp);
      }
      return out.sort((a, b) => b.registeredAt - a.registeredAt);
    } catch {
      return [];
    }
  }
}
