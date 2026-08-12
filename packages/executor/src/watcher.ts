/**
 * Watches the FAssets Core Vault for XRPL payments carrying `0xFE` memos.
 *
 * The Core Vault is a shared, busy address — every FXRP direct mint on the
 * network lands there. So the filter is not "payments to the vault" but
 * "payments whose memo commits to a user operation this executor was told
 * about". An unregistered commitment is ignored rather than guessed at: the
 * executor cannot submit bytes it does not hold, and should not try.
 *
 * Polling `account_tx` rather than subscribing: the WebSocket path failed
 * intermittently against the public testnet cluster, and a watcher that
 * silently stops receiving is worse than one that polls a little slower.
 */

import { decodeMemo, OPCODE } from "@onesig/sdk";
import type { Hex } from "viem";

import type { PendingStore } from "./store.js";
import type { XrplHttpClient } from "./xrpl.js";

export interface ObservedPayment {
  xrplTxId: string;
  commitment: Hex;
  /** Drops. */
  amount: string;
  sender: string;
  ledgerIndex: number;
}

interface AccountTxEntry {
  hash?: string;
  ledger_index?: number;
  validated?: boolean;
  tx_json?: Record<string, unknown>;
  tx?: Record<string, unknown>;
  meta?: unknown;
}

/** Extract a 0xFE commitment from an XRPL Payment's memos, or null. */
export function commitmentFromMemos(tx: Record<string, unknown>): Hex | null {
  const memos = tx["Memos"];
  if (!Array.isArray(memos)) return null;

  for (const wrapper of memos) {
    const data = (wrapper as { Memo?: { MemoData?: string } })?.Memo?.MemoData;
    if (typeof data !== "string") continue;
    try {
      const bytes = Uint8Array.from(Buffer.from(data, "hex"));
      const decoded = decodeMemo(bytes);
      if (decoded.opcode === OPCODE.EXECUTE_COMMITTED) return decoded.userOpHash;
    } catch {
      // Not one of ours, or malformed. Either way, not our business.
    }
  }
  return null;
}

export class Watcher {
  #lastLedger = 0;

  constructor(
    private readonly xrpl: XrplHttpClient,
    private readonly store: PendingStore,
    private readonly coreVaultAddress: string,
    private readonly log: (msg: string) => void = console.log,
  ) {}

  /**
   * One polling pass. Returns payments to the Core Vault whose `0xFE`
   * commitment matches something registered with this executor.
   */
  async poll(limit = 30): Promise<ObservedPayment[]> {
    const res = await this.xrpl.call<{ transactions?: AccountTxEntry[] }>("account_tx", {
      account: this.coreVaultAddress,
      limit,
      ledger_index_min: this.#lastLedger > 0 ? this.#lastLedger : -1,
      ledger_index_max: -1,
      binary: false,
    });

    const found: ObservedPayment[] = [];
    for (const entry of res.transactions ?? []) {
      if (entry.validated === false) continue;
      const tx = entry.tx_json ?? entry.tx;
      if (!tx || tx["TransactionType"] !== "Payment") continue;

      const ledgerIndex = entry.ledger_index ?? 0;
      if (ledgerIndex > this.#lastLedger) this.#lastLedger = ledgerIndex;

      const commitment = commitmentFromMemos(tx);
      if (!commitment) continue;

      // The decisive filter: do we actually hold the bytes behind this hash?
      const pending = await this.store.get(commitment);
      if (!pending) continue;

      const hash = entry.hash ?? (tx["hash"] as string | undefined);
      if (!hash) continue;

      found.push({
        xrplTxId: hash,
        commitment,
        amount: String(tx["Amount"] ?? "0"),
        sender: String(tx["Account"] ?? ""),
        ledgerIndex,
      });
      this.log(`observed ${hash.slice(0, 8)}… → ${pending.label}`);
    }

    return found;
  }

  /** Only consider ledgers at or after this index. */
  setStartLedger(index: number): void {
    this.#lastLedger = index;
  }
}
