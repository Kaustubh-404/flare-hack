/**
 * ★ LATCH — the confidential executor.
 *
 * An intent lives here and nowhere else. The XRP Ledger carries a 32-byte
 * commitment; the operation itself sits in this enclave's memory until its
 * trigger fires. While it waits there is no mempool entry, no on-chain state,
 * and nothing in the proxy's logs — so there is nothing to front-run.
 *
 * Four commands:
 *   ARM      store an intent (direct action — never touches the chain)
 *   STATUS   is it still waiting? Answers about lifecycle only, never contents.
 *   CANCEL   revoke before firing
 *   COLLECT  release the bytes — only ever after the trigger has fired
 *
 * The state is deliberately in-memory. Persisting intents to disk would put
 * them somewhere the machine's operator could read after the fact, which is
 * the exact thing this is built to prevent. The cost is that a restart forgets
 * everything, and that is the correct trade: an intent that cannot be executed
 * is recoverable at its deadline, an intent that leaked is not.
 */

import { keccak256 } from "viem";

import { bytesToHex, hexToBytes } from "../base/encoding.js";
import type { Framework, HandlerResult } from "../base/types.js";

import {
  MAX_DEADLINE_MS,
  OP_COMMAND_ARM,
  OP_COMMAND_CANCEL,
  OP_COMMAND_COLLECT,
  OP_COMMAND_STATUS,
  OP_TYPE_LATCH,
} from "./config.js";
import { describeTrigger, isTriggered, parseTrigger, type Trigger } from "./triggers.js";

export type IntentState = "armed" | "fired" | "collected" | "cancelled" | "expired";

interface Intent {
  /** keccak256(userOpData) — the same commitment the XRPL memo publishes. */
  commitment: string;
  /** The operation. Released only after firing. */
  userOpData: string;
  trigger: Trigger;
  /** Unix ms. After this the intent expires unfired and the user reclaims. */
  deadline: number;
  state: IntentState;
  armedAt: number;
  firedAt?: number;
}

// Serialized by the framework; no locking needed.
const intents = new Map<string, Intent>();
let armedTotal = 0;
let firedTotal = 0;

/** Reset all state. Tests only; not part of the wire contract. */
export function resetState(): void {
  intents.clear();
  armedTotal = 0;
  firedTotal = 0;
}

export function register(framework: Framework): void {
  framework.handle(OP_TYPE_LATCH, OP_COMMAND_ARM, handleArm);
  framework.handle(OP_TYPE_LATCH, OP_COMMAND_STATUS, handleStatus);
  framework.handle(OP_TYPE_LATCH, OP_COMMAND_CANCEL, handleCancel);
  framework.handle(OP_TYPE_LATCH, OP_COMMAND_COLLECT, handleCollect);
}

/**
 * GET /state — counts and lifecycle only.
 *
 * Never a commitment, never a trigger, never an operation. This endpoint is
 * reachable through the public proxy, so anything it returns is public.
 */
export function reportState(): unknown {
  let armed = 0;
  let fired = 0;
  for (const i of intents.values()) {
    if (i.state === "armed") armed++;
    if (i.state === "fired") fired++;
  }
  return { armed, awaitingCollection: fired, armedTotal, firedTotal };
}

// ── helpers ────────────────────────────────────────────────────────────────

function decodeJson(msg: string): { value: Record<string, unknown> } | { error: string } {
  let raw: Uint8Array;
  try {
    raw = hexToBytes(msg);
  } catch (e) {
    return { error: `decoding request: invalid hex: ${String(e)}` };
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw).toString("utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "decoding request: expected a JSON object" };
    }
    return { value: parsed as Record<string, unknown> };
  } catch (e) {
    return { error: `decoding request: ${String(e)}` };
  }
}

const ok = (payload: unknown): HandlerResult => [
  bytesToHex(Buffer.from(JSON.stringify(payload), "utf-8")),
  1,
  null,
];

const fail = (message: string): HandlerResult => [null, 0, message];

// ── ARM ────────────────────────────────────────────────────────────────────

/**
 * LATCH/ARM — {"userOpData","commitment","trigger","deadline"}.
 *
 * The commitment is recomputed from the bytes rather than trusted. Accepting a
 * caller's claimed hash would let someone arm operation A under the commitment
 * the user published for operation B — the enclave would then release bytes the
 * user never signed over.
 */
export function handleArm(msg: string): HandlerResult {
  const decoded = decodeJson(msg);
  if ("error" in decoded) return fail(decoded.error);
  const req = decoded.value;

  const userOpData = req["userOpData"];
  if (typeof userOpData !== "string" || !/^0x[0-9a-fA-F]*$/.test(userOpData) || userOpData.length < 4) {
    return fail("userOpData must be non-empty 0x hex");
  }

  const commitment = keccak256(userOpData as `0x${string}`);
  const claimed = req["commitment"];
  if (typeof claimed === "string" && claimed.toLowerCase() !== commitment.toLowerCase()) {
    return fail(`commitment mismatch: claimed ${claimed}, keccak256(userOpData) is ${commitment}`);
  }

  const parsed = parseTrigger(req["trigger"]);
  if ("error" in parsed) return fail(parsed.error);

  const deadline = req["deadline"];
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) {
    return fail("deadline must be unix milliseconds");
  }
  const now = Date.now();
  if (deadline <= now) return fail("deadline is already in the past");
  if (deadline > now + MAX_DEADLINE_MS) {
    return fail(`deadline exceeds the maximum of ${MAX_DEADLINE_MS} ms`);
  }

  const existing = intents.get(commitment);
  if (existing && existing.state === "armed") {
    // Idempotent: re-arming the same operation is a retry, not a second intent.
    return ok({ armed: true, commitment, alreadyArmed: true });
  }

  intents.set(commitment, {
    commitment,
    userOpData,
    trigger: parsed.trigger,
    deadline,
    state: "armed",
    armedAt: now,
  });
  armedTotal++;

  // The log records that something was armed and on what condition — never
  // what it does. The trigger is not secret; the operation is.
  console.log(`[latch] armed ${commitment.slice(0, 12)}… on ${describeTrigger(parsed.trigger)}`);

  return ok({ armed: true, commitment });
}

// ── STATUS ─────────────────────────────────────────────────────────────────

/** LATCH/STATUS — {"commitment"}. Lifecycle only. */
export function handleStatus(msg: string): HandlerResult {
  const decoded = decodeJson(msg);
  if ("error" in decoded) return fail(decoded.error);

  const commitment = decoded.value["commitment"];
  if (typeof commitment !== "string") return fail("commitment must be a 0x hex string");

  const intent = intents.get(commitment.toLowerCase() as string) ?? intents.get(commitment);
  if (!intent) return ok({ state: "unknown" });

  return ok({
    state: intent.state,
    armedAt: intent.armedAt,
    deadline: intent.deadline,
    ...(intent.firedAt ? { firedAt: intent.firedAt } : {}),
    // Deliberately absent: userOpData, and anything derived from it.
  });
}

// ── CANCEL ─────────────────────────────────────────────────────────────────

/**
 * LATCH/CANCEL — {"commitment"}.
 *
 * Routed through the on-chain instruction path rather than a direct action, so
 * a revocation is publicly auditable. A user should be able to prove they told
 * the enclave to stop.
 */
export function handleCancel(msg: string): HandlerResult {
  const decoded = decodeJson(msg);
  if ("error" in decoded) return fail(decoded.error);

  const commitment = decoded.value["commitment"];
  if (typeof commitment !== "string") return fail("commitment must be a 0x hex string");

  const intent = intents.get(commitment);
  if (!intent) return fail("no such intent");
  if (intent.state !== "armed") return fail(`intent is ${intent.state}, not armed`);

  intent.state = "cancelled";
  // Drop the bytes immediately. A cancelled intent should not linger in memory.
  intent.userOpData = "0x";
  console.log(`[latch] cancelled ${commitment.slice(0, 12)}…`);

  return ok({ cancelled: true, commitment });
}

// ── COLLECT ────────────────────────────────────────────────────────────────

/**
 * LATCH/COLLECT — {"commitment"}. Releases the operation bytes.
 *
 * The single gate this whole design rests on: bytes come out only after the
 * trigger has fired. Before that, the answer is the state, never the payload.
 */
export function handleCollect(msg: string): HandlerResult {
  const decoded = decodeJson(msg);
  if ("error" in decoded) return fail(decoded.error);

  const commitment = decoded.value["commitment"];
  if (typeof commitment !== "string") return fail("commitment must be a 0x hex string");

  const intent = intents.get(commitment);
  if (!intent) return fail("no such intent");

  if (intent.state === "armed") {
    return fail("not fired yet — the trigger condition has not been met");
  }
  if (intent.state === "cancelled") return fail("intent was cancelled");
  if (intent.state === "expired") return fail("intent expired without firing");

  intent.state = "collected";
  return ok({ userOpData: intent.userOpData, firedAt: intent.firedAt ?? null });
}

// ── the tick ───────────────────────────────────────────────────────────────

/**
 * Evaluate every armed intent once.
 *
 * Exported so tests can step it deterministically instead of waiting on a
 * timer. Emits nothing for intents that do not fire — that silence is the
 * product.
 */
export async function tick(now = Date.now(), check = isTriggered): Promise<void> {
  for (const intent of intents.values()) {
    if (intent.state !== "armed") continue;

    if (now >= intent.deadline) {
      intent.state = "expired";
      intent.userOpData = "0x";
      console.log(`[latch] expired ${intent.commitment.slice(0, 12)}… unfired`);
      continue;
    }

    const { fired, reading } = await check(intent.trigger, now);
    if (!fired) continue;

    intent.state = "fired";
    intent.firedAt = now;
    firedTotal++;
    console.log(
      `[latch] fired ${intent.commitment.slice(0, 12)}… ` +
        `${describeTrigger(intent.trigger)}${reading ? ` (read ${reading.value})` : ""}`,
    );
  }
}

/** Test seam: inspect an intent's lifecycle without going through the wire. */
export function peekState(commitment: string): IntentState | null {
  return intents.get(commitment)?.state ?? null;
}
