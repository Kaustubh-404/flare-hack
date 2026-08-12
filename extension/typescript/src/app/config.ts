/**
 * ★ LATCH — operation identifiers and tuning.
 *
 * These strings MUST match the bytes32 constants in
 * contracts/LatchInstructionSender.sol exactly, or actions fall through to
 * "unsupported op type".
 */

export const VERSION = "0.1.0";

export const OP_TYPE_LATCH = "LATCH";

/** Store an encrypted intent. Arrives as a direct action — never on-chain. */
export const OP_COMMAND_ARM = "ARM";
/** Ask whether an intent is still waiting. Reveals nothing about its contents. */
export const OP_COMMAND_STATUS = "STATUS";
/** Revoke an intent before it fires. */
export const OP_COMMAND_CANCEL = "CANCEL";
/** Collect the released bytes. Only ever answers after the trigger has fired. */
export const OP_COMMAND_COLLECT = "COLLECT";

/**
 * How often the enclave re-reads the price feed.
 *
 * FTSO block-latency feeds update roughly every 1.8s, so polling faster buys
 * nothing. Nothing is emitted between ticks: an intent that has not fired
 * leaves no trace on-chain and nothing in a mempool, which is the property
 * that makes it un-frontrunnable.
 */
export const TICK_MS = Number(process.env.LATCH_TICK_MS ?? 3_000);

/** Coston2 RPC the enclave reads FTSO through. */
export const CHAIN_URL =
  process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

/** FtsoV2, resolved from the Flare contract registry at deploy time. */
export const FTSO_V2 =
  process.env.FTSO_V2 ?? "0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d";

/**
 * Hard ceiling on how long an intent may sit in enclave memory.
 *
 * An enclave that can hold an intent indefinitely is a censor. Every intent
 * carries a deadline, and this bounds it even if a caller asks for longer.
 */
export const MAX_DEADLINE_MS = Number(process.env.LATCH_MAX_DEADLINE_MS ?? 7 * 24 * 3600 * 1000);
