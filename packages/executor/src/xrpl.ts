/**
 * XRPL access over HTTP JSON-RPC.
 *
 * xrpl.js's Client is WebSocket-only, and its default 5s connect timeout fails
 * intermittently on the public testnet cluster. That is an acceptable risk when
 * reading, and an unacceptable one when submitting a payment: a submit that
 * fails ambiguously can leave you unsure whether money moved.
 *
 * So the submit path is explicit — sign offline, POST the blob, poll for
 * validation. Every step is separately retryable and the transaction is signed
 * before anything is sent, so its hash is known in advance and a lost response
 * is recoverable by hash rather than by guesswork.
 */

import { Wallet, encode } from "xrpl";

export const XRPL_TESTNET_JSONRPC = "https://s.altnet.rippletest.net:51234/";

export interface XrplPaymentInput {
  account: string;
  destination: string;
  /** Drops, as a string. */
  amount: string;
  /** Hex, no 0x prefix, uppercase. */
  memoData: string;
}

export interface SubmittedPayment {
  hash: string;
  engineResult: string;
  validated: boolean;
  ledgerIndex?: number;
}

export class XrplHttpClient {
  constructor(
    private readonly url: string = XRPL_TESTNET_JSONRPC,
    private readonly timeoutMs = 20_000,
  ) {}

  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params: [params] }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`XRPL HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T & { error?: string; error_message?: string } };
    const result = body.result;
    if (!result) throw new Error(`XRPL response missing result`);
    if (result.error) {
      throw new Error(`XRPL ${method}: ${result.error_message ?? result.error}`);
    }
    return result;
  }

  async accountInfo(address: string): Promise<{ sequence: number; balanceDrops: string }> {
    const r = await this.call<{ account_data: { Sequence: number; Balance: string } }>(
      "account_info",
      { account: address, ledger_index: "validated" },
    );
    return { sequence: r.account_data.Sequence, balanceDrops: r.account_data.Balance };
  }

  async currentLedger(): Promise<number> {
    const r = await this.call<{ ledger_current_index: number }>("ledger_current", {});
    return r.ledger_current_index;
  }

  /** Sign locally, submit the blob, then poll until the ledger validates it. */
  async submitPayment(
    input: XrplPaymentInput,
    wallet: Wallet,
    opts: { pollMs?: number; maxPolls?: number } = {},
  ): Promise<SubmittedPayment> {
    const [{ sequence }, currentLedger] = await Promise.all([
      this.accountInfo(input.account),
      this.currentLedger(),
    ]);

    const tx = {
      TransactionType: "Payment" as const,
      Account: input.account,
      Destination: input.destination,
      Amount: input.amount,
      // No DestinationTag: a tag credits the tag-holder and lets an unrelated
      // party front-run the user operation.
      Memos: [{ Memo: { MemoData: input.memoData } }],
      Fee: "12",
      Sequence: sequence,
      // Bounds how long this can sit in the network; past it, the tx can never
      // succeed, which makes "did it land?" answerable rather than open-ended.
      LastLedgerSequence: currentLedger + 20,
      SigningPubKey: wallet.publicKey,
    };

    const signed = wallet.sign(tx as never);

    const submitted = await this.call<{ engine_result: string; tx_json?: { hash?: string } }>(
      "submit",
      { tx_blob: signed.tx_blob },
    );

    const hash = signed.hash;
    // tesSUCCESS here means "provisionally applied", not final. Only the
    // validated ledger is authoritative, so poll rather than trust this.
    if (!submitted.engine_result.startsWith("tes") && !submitted.engine_result.startsWith("ter")) {
      return { hash, engineResult: submitted.engine_result, validated: false };
    }

    const pollMs = opts.pollMs ?? 3_000;
    const maxPolls = opts.maxPolls ?? 30;
    for (let i = 0; i < maxPolls; i++) {
      await sleep(pollMs);
      try {
        const r = await this.call<{
          validated?: boolean;
          meta?: { TransactionResult?: string };
          ledger_index?: number;
        }>("tx", { transaction: hash, binary: false });
        if (r.validated) {
          return {
            hash,
            engineResult: r.meta?.TransactionResult ?? submitted.engine_result,
            validated: true,
            ...(r.ledger_index !== undefined ? { ledgerIndex: r.ledger_index } : {}),
          };
        }
      } catch {
        // "txnNotFound" until it is in a ledger — expected, keep polling.
      }
    }

    return { hash, engineResult: submitted.engine_result, validated: false };
  }
}

/** Re-exported so callers need only one import for the signing side. */
export { Wallet, encode };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
