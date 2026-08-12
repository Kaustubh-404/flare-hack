/**
 * Xaman (XUMM) sign requests.
 *
 * The user signs on their phone, in the wallet XRP holders already use, and
 * never sees a memo or a hex string — `custom_meta.instruction` shows them what
 * the operation actually does. That is the instruction directory's whole
 * purpose arriving at the place it matters.
 *
 * The API secret lives here and only here. It never reaches a browser: anyone
 * holding it can create sign requests branded as this application.
 */

import type { Hex } from "viem";

export const XAMAN_API = "https://xumm.app/api/v1/platform";

/**
 * `custom_meta.identifier` is capped at 40 characters.
 *
 * Undocumented — established by bisecting the live API: 40 succeeds, 41 fails
 * with the opaque `{"error":{"code":413}}`. A full 0x-prefixed commitment is 66
 * characters, so it must be truncated. 40 hex characters is 160 bits, which is
 * ample for correlating a sign request back to a registered user operation
 * (the authoritative binding is the memo the user actually signs, not this).
 */
export const XAMAN_IDENTIFIER_MAX = 40;

/** Truncate a commitment to something Xaman will accept as an identifier. */
export function toXamanIdentifier(commitment: Hex): string {
  return commitment.replace(/^0x/, "").slice(0, XAMAN_IDENTIFIER_MAX);
}

export interface SignRequestInput {
  account?: string;
  destination: string;
  /** Drops, as a string. */
  amount: string;
  /** Uppercase hex, no 0x prefix. */
  memoData: string;
  /** Shown to the user in Xaman instead of the raw memo. */
  instruction: string;
  /** Ties the request back to a registered user operation. */
  identifier?: Hex;
  expireMinutes?: number;
}

export interface SignRequest {
  uuid: string;
  /** Universal link — opens Xaman on the same device. */
  next: string;
  /** QR image to scan from another device. */
  qrPng: string;
  /** Push-to-device succeeded (only possible with a known user token). */
  pushed: boolean;
}

export interface SignRequestStatus {
  uuid: string;
  resolved: boolean;
  signed: boolean;
  cancelled: boolean;
  expired: boolean;
  /** Present once signed and submitted. */
  txid?: string;
  account?: string;
}

export class XamanClient {
  readonly #key: string;
  readonly #secret: string;
  readonly #base: string;

  constructor(opts: { apiKey?: string; apiSecret?: string; baseUrl?: string } = {}) {
    const key = opts.apiKey ?? process.env["XAMAN_API_KEY"];
    const secret = opts.apiSecret ?? process.env["XAMAN_API_SECRET"];
    if (!key || !secret) {
      throw new Error(
        "XAMAN_API_KEY / XAMAN_API_SECRET not set — get them free from https://apps.xumm.dev",
      );
    }
    this.#key = key;
    this.#secret = secret;
    this.#base = (opts.baseUrl ?? XAMAN_API).replace(/\/$/, "");
  }

  /** True when credentials are present, so callers can degrade rather than crash. */
  static isConfigured(): boolean {
    return Boolean(process.env["XAMAN_API_KEY"] && process.env["XAMAN_API_SECRET"]);
  }

  async #call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.#base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.#key,
        "x-api-secret": this.#secret,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Xaman ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async ping(): Promise<{ pong: boolean; application?: { name?: string } }> {
    const r = await this.#call<{ pong: boolean; auth?: { application?: { name?: string } } }>(
      "POST",
      "/ping",
      {},
    );
    return { pong: r.pong, ...(r.auth?.application ? { application: r.auth.application } : {}) };
  }

  /**
   * Create a sign request.
   *
   * `Account`, `Fee` and `Sequence` are deliberately omitted — Xaman fills them
   * at signing time from the account the user picks.
   *
   * `force_network: TESTNET` matters: without it a user whose app is on
   * mainnet would be shown a mainnet payment to the testnet Core Vault address.
   */
  async createSignRequest(input: SignRequestInput): Promise<SignRequest> {
    const payload = {
      txjson: {
        TransactionType: "Payment",
        Destination: input.destination,
        Amount: input.amount,
        // No DestinationTag — a tag credits the tag-holder and lets an
        // unrelated party front-run the user operation.
        Memos: [{ Memo: { MemoData: input.memoData } }],
        ...(input.account ? { Account: input.account } : {}),
      },
      options: {
        submit: true,
        expire: input.expireMinutes ?? 10,
        force_network: "TESTNET",
      },
      custom_meta: {
        instruction: input.instruction,
        ...(input.identifier ? { identifier: toXamanIdentifier(input.identifier) } : {}),
      },
    };

    const r = await this.#call<{
      uuid: string;
      next: { always: string };
      refs: { qr_png: string };
      pushed: boolean;
    }>("POST", "/payload", payload);

    return { uuid: r.uuid, next: r.next.always, qrPng: r.refs.qr_png, pushed: r.pushed };
  }

  async getSignRequest(uuid: string): Promise<SignRequestStatus> {
    const r = await this.#call<{
      meta: { resolved: boolean; signed: boolean; cancelled: boolean; expired: boolean };
      response: { txid?: string | null; account?: string | null };
    }>("GET", `/payload/${uuid}`);

    return {
      uuid,
      resolved: r.meta.resolved,
      signed: r.meta.signed,
      cancelled: r.meta.cancelled,
      expired: r.meta.expired,
      ...(r.response.txid ? { txid: r.response.txid } : {}),
      ...(r.response.account ? { account: r.response.account } : {}),
    };
  }
}
