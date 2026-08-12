/**
 * Trigger evaluation.
 *
 * The enclave decides when an intent fires. That decision has to rest on
 * something the user can audit *before* arming — otherwise "the box decides"
 * is just a different trusted party. So the only price source is FTSO, Flare's
 * enshrined oracle, read directly from the chain. No API keys, no operator
 * feed, nothing the machine's owner can tilt.
 */

import { CHAIN_URL, FTSO_V2 } from "./config.js";

export type TriggerKind = "PRICE" | "TIME";
export type Comparator = "GTE" | "LTE";

export interface PriceTrigger {
  kind: "PRICE";
  /** FTSO feed id, e.g. 0x01585250...  (21 bytes, hex). */
  feedId: string;
  op: Comparator;
  /** Threshold as a decimal string, in the feed's own units. */
  value: string;
}

export interface TimeTrigger {
  kind: "TIME";
  /** Unix milliseconds. Fires at or after this instant. */
  notBefore: number;
}

export type Trigger = PriceTrigger | TimeTrigger;

export interface FeedReading {
  /** Price scaled by 10^decimals. */
  value: bigint;
  decimals: number;
  timestamp: number;
}

/** Parse and validate a trigger from untrusted input. */
export function parseTrigger(raw: unknown): { trigger: Trigger } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "trigger must be an object" };
  const t = raw as Record<string, unknown>;

  if (t["kind"] === "PRICE") {
    const feedId = t["feedId"];
    const op = t["op"];
    const value = t["value"];
    if (typeof feedId !== "string" || !/^0x[0-9a-fA-F]{42}$/.test(feedId)) {
      return { error: "trigger.feedId must be a 21-byte hex feed id" };
    }
    if (op !== "GTE" && op !== "LTE") return { error: "trigger.op must be GTE or LTE" };
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      return { error: "trigger.value must be a decimal string in the feed's units" };
    }
    return { trigger: { kind: "PRICE", feedId, op, value } };
  }

  if (t["kind"] === "TIME") {
    const notBefore = t["notBefore"];
    if (typeof notBefore !== "number" || !Number.isFinite(notBefore) || notBefore <= 0) {
      return { error: "trigger.notBefore must be unix milliseconds" };
    }
    return { trigger: { kind: "TIME", notBefore } };
  }

  return { error: `unsupported trigger kind: ${String(t["kind"])}` };
}

/** eth_call FtsoV2.getFeedById(bytes21) → (uint256 value, int8 decimals, uint64 timestamp). */
export async function readFeed(feedId: string, now = Date.now()): Promise<FeedReading | null> {
  // getFeedById(bytes21) selector
  const selector = "0xc59d4847";
  const arg = feedId.replace(/^0x/, "").padEnd(64, "0");

  try {
    const res = await fetch(CHAIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: FTSO_V2, data: `${selector}${arg}` }, "latest"],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (!body.result || body.result === "0x") return null;

    const hex = body.result.replace(/^0x/, "");
    if (hex.length < 192) return null;

    const value = BigInt(`0x${hex.slice(0, 64)}`);
    // int8, two's complement in a 32-byte word
    const rawDecimals = BigInt(`0x${hex.slice(64, 128)}`);
    const decimals = rawDecimals > 0x7fn ? Number(rawDecimals - (1n << 256n)) : Number(rawDecimals);
    const timestamp = Number(BigInt(`0x${hex.slice(128, 192)}`));

    return { value, decimals, timestamp: timestamp || Math.floor(now / 1000) };
  } catch {
    // A transient RPC failure must not fire or expire anything. Silence here
    // means "no reading this tick", never "condition met".
    return null;
  }
}

/**
 * Has the condition been met?
 *
 * Returns false when a price cannot be read. Firing on a failed read would let
 * anyone who can disrupt the enclave's RPC trigger every armed intent at once.
 */
export async function isTriggered(
  trigger: Trigger,
  now = Date.now(),
  read = readFeed,
): Promise<{ fired: boolean; reading?: FeedReading }> {
  if (trigger.kind === "TIME") {
    return { fired: now >= trigger.notBefore };
  }

  const reading = await read(trigger.feedId, now);
  if (!reading) return { fired: false };

  const threshold = BigInt(trigger.value);
  const fired =
    trigger.op === "GTE" ? reading.value >= threshold : reading.value <= threshold;
  return { fired, reading };
}

/** Human-readable, for logs. Never includes intent contents. */
export function describeTrigger(t: Trigger): string {
  return t.kind === "TIME"
    ? `TIME >= ${new Date(t.notBefore).toISOString()}`
    : `PRICE ${t.feedId.slice(0, 12)}… ${t.op} ${t.value}`;
}
