/**
 * The one thing unit tests cannot fake: that our calldata matches the chain.
 *
 * readFeed fails closed — a bad selector reverts, it returns null, and
 * isTriggered reports "not fired". Nothing throws and nothing logs, so a typo
 * in the selector is invisible to every mocked test and would simply mean no
 * intent ever fires. That is exactly what happened: the selector was wrong
 * until this test existed.
 *
 * Skipped unless LIVE=1, so CI without network stays green.
 */

import { describe, expect, it } from "vitest";

import { FTSO_V2 } from "../app/config.js";
import { isTriggered, readFeed } from "../app/triggers.js";

const live = process.env["LIVE"] === "1";
const d = live ? describe : describe.skip;

/** 0x01 + ascii symbol, right-padded to 21 bytes. */
const feedId = (sym: string) =>
  `0x01${Buffer.from(sym, "utf-8").toString("hex").padEnd(40, "0")}`;

const FLR_USD = feedId("FLR/USD");

/** A uint256 ABI word. */
const word = (n: number) => n.toString(16).padStart(64, "0");

d("live FTSO read (LIVE=1)", () => {
  it("resolves a real price from Coston2", async () => {
    const r = await readFeed(FLR_USD);
    expect(r, "readFeed returned null — selector or address is wrong").not.toBeNull();
    expect(r!.value).toBeGreaterThan(0n);
    expect(r!.decimals).toBeGreaterThan(0);
    // Feed timestamps are seconds and recent; a stale one means we read a
    // different contract than we think.
    expect(r!.timestamp).toBeGreaterThan(Date.now() / 1000 - 3600);
  }, 20_000);

  it("fires when the threshold is already met, and not when it is not", async () => {
    const r = await readFeed(FLR_USD);
    expect(r).not.toBeNull();
    const v = r!.value;

    const below = await isTriggered({ kind: "PRICE", feedId: FLR_USD, op: "GTE", value: (v / 2n).toString() });
    expect(below.fired).toBe(true);

    const above = await isTriggered({ kind: "PRICE", feedId: FLR_USD, op: "GTE", value: (v * 4n).toString() });
    expect(above.fired).toBe(false);
  }, 20_000);

  it("uses the FtsoV2 address the contract registry resolves", async () => {
    const name = "FtsoV2";
    const res = await fetch("https://coston2-api.flare.network/ext/C/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{
          to: "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019",
          // getContractAddressByName("FtsoV2") — selector, then the ABI head
          // (offset, length, padded bytes) built rather than pasted, so the
          // words stay readable as what they are.
          data: `0x82760fca${word(32)}${word(name.length)}${Buffer.from(name).toString("hex").padEnd(64, "0")}`,
        }, "latest"],
      }),
    });
    const body = (await res.json()) as { result?: string };
    const resolved = `0x${body.result!.slice(-40)}`;
    expect(resolved.toLowerCase()).toBe(FTSO_V2.toLowerCase());
  }, 20_000);
});
