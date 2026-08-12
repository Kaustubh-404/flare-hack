/**
 * LATCH behaviour. Every assertion here is a property the pitch claims.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { keccak256 } from "viem";

import { bytesToHex } from "../base/encoding.js";
import {
  handleArm,
  handleCancel,
  handleCollect,
  handleStatus,
  peekState,
  reportState,
  resetState,
  tick,
} from "../app/handlers.js";
import { isTriggered, parseTrigger } from "../app/triggers.js";
import type { FeedReading } from "../app/triggers.js";

const USER_OP = "0xdeadbeefcafebabe1234567890abcdef";
const COMMITMENT = keccak256(USER_OP);
const FEED = `0x${"01".repeat(21)}`;

/** Handlers take hex-encoded UTF-8 JSON, matching the wire contract. */
const enc = (o: unknown) => bytesToHex(Buffer.from(JSON.stringify(o), "utf-8"));
const dec = (r: readonly [string | null, number, string | null]) =>
  r[0] ? JSON.parse(Buffer.from(r[0].replace(/^0x/, ""), "hex").toString("utf-8")) : null;

const armPayload = (over: Record<string, unknown> = {}) =>
  enc({
    userOpData: USER_OP,
    commitment: COMMITMENT,
    trigger: { kind: "PRICE", feedId: FEED, op: "GTE", value: "4200000000" },
    deadline: Date.now() + 3_600_000,
    ...over,
  });

const feed = (value: bigint): (() => Promise<FeedReading>) => async () => ({
  value,
  decimals: 8,
  timestamp: Math.floor(Date.now() / 1000),
});

beforeEach(() => resetState());

describe("ARM", () => {
  it("stores an intent and returns its commitment", () => {
    const res = handleArm(armPayload());
    expect(res[1]).toBe(1);
    expect(dec(res)).toMatchObject({ armed: true, commitment: COMMITMENT });
    expect(peekState(COMMITMENT)).toBe("armed");
  });

  it("recomputes the commitment instead of trusting the caller", () => {
    // Arming payload A under the commitment published for payload B would let
    // the enclave release bytes the user never signed over.
    const res = handleArm(armPayload({ commitment: keccak256("0x1234") }));
    expect(res[1]).toBe(0);
    expect(res[2]).toMatch(/commitment mismatch/);
  });

  it("is idempotent — re-arming the same operation is a retry", () => {
    handleArm(armPayload());
    const again = dec(handleArm(armPayload()));
    expect(again).toMatchObject({ armed: true, alreadyArmed: true });
    expect(reportState()).toMatchObject({ armed: 1 });
  });

  it("refuses a deadline in the past", () => {
    const res = handleArm(armPayload({ deadline: Date.now() - 1000 }));
    expect(res[1]).toBe(0);
    expect(res[2]).toMatch(/already in the past/);
  });

  it("refuses a deadline beyond the ceiling", () => {
    // An enclave that can hold an intent forever is a censor.
    const res = handleArm(armPayload({ deadline: Date.now() + 999 * 24 * 3600 * 1000 }));
    expect(res[1]).toBe(0);
    expect(res[2]).toMatch(/exceeds the maximum/);
  });

  it("rejects a malformed trigger", () => {
    expect(handleArm(armPayload({ trigger: { kind: "VIBES" } }))[1]).toBe(0);
    expect(handleArm(armPayload({ trigger: { kind: "PRICE", feedId: "0xzz" } }))[1]).toBe(0);
  });
});

describe("the bytes stay sealed until the trigger fires", () => {
  it("COLLECT refuses while the intent is armed", () => {
    handleArm(armPayload());
    const res = handleCollect(enc({ commitment: COMMITMENT }));
    expect(res[1]).toBe(0);
    expect(res[2]).toMatch(/not fired yet/);
  });

  it("STATUS never returns the operation", () => {
    handleArm(armPayload());
    const s = dec(handleStatus(enc({ commitment: COMMITMENT })));
    expect(s.state).toBe("armed");
    expect(JSON.stringify(s)).not.toContain(USER_OP.slice(2));
    expect(s.userOpData).toBeUndefined();
  });

  it("GET /state leaks neither commitments nor operations", () => {
    handleArm(armPayload());
    // This endpoint is reachable through the public proxy.
    const snapshot = JSON.stringify(reportState());
    expect(snapshot).not.toContain(USER_OP.slice(2));
    expect(snapshot).not.toContain(COMMITMENT.slice(2));
  });

  it("releases the bytes once fired, exactly once", async () => {
    handleArm(armPayload());
    await tick(Date.now(), (t, n) => isTriggered(t, n, feed(4_300_000_000n)));
    expect(peekState(COMMITMENT)).toBe("fired");

    const first = dec(handleCollect(enc({ commitment: COMMITMENT })));
    expect(first.userOpData).toBe(USER_OP);

    // A second collection is not a fresh release.
    expect(peekState(COMMITMENT)).toBe("collected");
  });
});

describe("trigger evaluation", () => {
  it("fires only when the price crosses the threshold", async () => {
    handleArm(armPayload());
    await tick(Date.now(), (t, n) => isTriggered(t, n, feed(4_100_000_000n)));
    expect(peekState(COMMITMENT)).toBe("armed");

    await tick(Date.now(), (t, n) => isTriggered(t, n, feed(4_200_000_000n)));
    expect(peekState(COMMITMENT)).toBe("fired");
  });

  it("does not fire when the feed cannot be read", async () => {
    // Firing on a failed read would let anyone able to disrupt the enclave's
    // RPC trigger every armed intent at once.
    handleArm(armPayload());
    await tick(Date.now(), (t, n) => isTriggered(t, n, async () => null));
    expect(peekState(COMMITMENT)).toBe("armed");
  });

  it("honours LTE as well as GTE", async () => {
    handleArm(
      armPayload({ trigger: { kind: "PRICE", feedId: FEED, op: "LTE", value: "1000" } }),
    );
    await tick(Date.now(), (t, n) => isTriggered(t, n, feed(2000n)));
    expect(peekState(COMMITMENT)).toBe("armed");
    await tick(Date.now(), (t, n) => isTriggered(t, n, feed(999n)));
    expect(peekState(COMMITMENT)).toBe("fired");
  });

  it("supports a time trigger with no oracle at all", async () => {
    const at = Date.now() + 60_000;
    handleArm(armPayload({ trigger: { kind: "TIME", notBefore: at } }));
    await tick(at - 1);
    expect(peekState(COMMITMENT)).toBe("armed");
    await tick(at);
    expect(peekState(COMMITMENT)).toBe("fired");
  });
});

describe("the user can always get out", () => {
  it("CANCEL revokes an armed intent and drops the bytes", () => {
    handleArm(armPayload());
    expect(dec(handleCancel(enc({ commitment: COMMITMENT })))).toMatchObject({ cancelled: true });
    expect(peekState(COMMITMENT)).toBe("cancelled");
    expect(handleCollect(enc({ commitment: COMMITMENT }))[2]).toMatch(/cancelled/);
  });

  it("expires at the deadline without firing", async () => {
    const deadline = Date.now() + 1000;
    handleArm(armPayload({ deadline }));
    await tick(deadline + 1, (t, n) => isTriggered(t, n, feed(0n)));
    expect(peekState(COMMITMENT)).toBe("expired");
    expect(handleCollect(enc({ commitment: COMMITMENT }))[2]).toMatch(/expired/);
  });

  it("an expired intent cannot later fire", async () => {
    const deadline = Date.now() + 1000;
    handleArm(armPayload({ deadline }));
    await tick(deadline + 1);
    // Even with the condition now satisfied.
    await tick(deadline + 2, (t, n) => isTriggered(t, n, feed(9_999_999_999n)));
    expect(peekState(COMMITMENT)).toBe("expired");
  });

  it("CANCEL refuses an intent that already fired", async () => {
    handleArm(armPayload());
    await tick(Date.now(), (t, n) => isTriggered(t, n, feed(4_300_000_000n)));
    expect(handleCancel(enc({ commitment: COMMITMENT }))[2]).toMatch(/is fired, not armed/);
  });
});

describe("parseTrigger", () => {
  it("accepts the two supported kinds", () => {
    expect(parseTrigger({ kind: "PRICE", feedId: FEED, op: "GTE", value: "1" })).toHaveProperty("trigger");
    expect(parseTrigger({ kind: "TIME", notBefore: Date.now() })).toHaveProperty("trigger");
  });

  it("rejects a non-decimal threshold", () => {
    expect(parseTrigger({ kind: "PRICE", feedId: FEED, op: "GTE", value: "4.2" })).toHaveProperty("error");
  });
});
