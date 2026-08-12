import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { toXamanIdentifier, XAMAN_IDENTIFIER_MAX } from "../src/xaman.js";

describe("Xaman identifier", () => {
  it("fits the undocumented 40-character cap", () => {
    // A full commitment is 66 chars with the 0x prefix. Xaman rejects anything
    // over 40 with an opaque {"error":{"code":413}} — established by bisecting
    // the live API, not from documentation.
    const commitment = keccak256("0xdeadbeef");
    expect(commitment.length).toBe(66);
    const id = toXamanIdentifier(commitment);
    expect(id.length).toBe(XAMAN_IDENTIFIER_MAX);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(id.startsWith("0x")).toBe(false);
  });

  it("keeps enough entropy to correlate distinct operations", () => {
    const a = toXamanIdentifier(keccak256("0x01"));
    const b = toXamanIdentifier(keccak256("0x02"));
    expect(a).not.toBe(b);
  });
});
