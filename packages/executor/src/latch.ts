/**
 * LATCH, driven in-process for the demo surface.
 *
 * This is not a reimplementation. It imports the extension's own Server and
 * handlers and speaks the real tee-node wire format at them — the same code
 * path the registered container runs, with the same envelope, the same
 * commitment recomputation and the same fail-closed price read. The only thing
 * missing is the chain → proxy → tee-node transport in front of it.
 *
 * Keeping one implementation matters more than the transport: a demo that
 * drove a parallel copy of the logic would prove nothing about the extension
 * that is actually registered on Coston2.
 */

import { bytesToHex, stringToBytes32Hex } from "../../../extension/typescript/src/base/encoding.js";
import { Server } from "../../../extension/typescript/src/base/server.js";
import {
  OP_COMMAND_ARM,
  OP_COMMAND_CANCEL,
  OP_COMMAND_COLLECT,
  OP_COMMAND_STATUS,
  OP_TYPE_LATCH,
  TICK_MS,
  VERSION,
} from "../../../extension/typescript/src/app/config.js";
import * as handlers from "../../../extension/typescript/src/app/handlers.js";
import { readFeed } from "../../../extension/typescript/src/app/triggers.js";

/** 0x01 + ascii symbol, right-padded to 21 bytes — the FTSO feed id scheme. */
export const feedId = (symbol: string): string =>
  `0x01${Buffer.from(symbol, "utf-8").toString("hex").padEnd(40, "0")}`;

export interface LatchReply {
  status: number;
  ok: boolean;
  log: string;
  payload: unknown;
}

export class Latch {
  readonly #server: Server;
  #timer: NodeJS.Timeout | null = null;
  #seq = 0;

  constructor() {
    // Ports 0/0: this instance never binds a socket. Requests arrive through
    // handleRequest, exactly as the container's HTTP layer delivers them.
    this.#server = new Server(0, 0, VERSION, handlers.register, handlers.reportState);
  }

  /** Start the trigger loop. The enclave re-reads FTSO on this cadence. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void handlers.tick().catch(() => {
        // A tick that throws must not kill the loop; the next one re-reads.
      });
    }, TICK_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Force one evaluation now, so a demo does not wait out the interval. */
  async tickNow(): Promise<void> {
    await handlers.tick();
  }

  /** Live FTSO reading, for the price display. Null when the read fails. */
  async feed(id: string): Promise<{ value: string; decimals: number; timestamp: number } | null> {
    const r = await readFeed(id);
    return r ? { value: r.value.toString(), decimals: r.decimals, timestamp: r.timestamp } : null;
  }

  /** GET /state — whatever this returns is public by definition. */
  async state(): Promise<unknown> {
    const [, body] = await this.#server.handleRequest("GET", "/state", "");
    return body;
  }

  arm(payload: unknown): Promise<LatchReply> {
    return this.#action(OP_COMMAND_ARM, payload);
  }
  status(commitment: string): Promise<LatchReply> {
    return this.#action(OP_COMMAND_STATUS, { commitment });
  }
  collect(commitment: string): Promise<LatchReply> {
    return this.#action(OP_COMMAND_COLLECT, { commitment });
  }
  cancel(commitment: string): Promise<LatchReply> {
    return this.#action(OP_COMMAND_CANCEL, { commitment });
  }

  /** Build a tee-node action envelope and run it through the real server. */
  async #action(command: string, payload: unknown): Promise<LatchReply> {
    const original = Buffer.from(JSON.stringify(payload), "utf-8");
    const id = `0x${(++this.#seq).toString(16).padStart(64, "0")}`;

    const dataFixed = {
      instructionId: id,
      teeId: `0x${"22".repeat(20)}`,
      timestamp: Math.floor(Date.now() / 1000),
      rewardEpochId: 0,
      opType: stringToBytes32Hex(OP_TYPE_LATCH),
      opCommand: stringToBytes32Hex(command),
      cosigners: [],
      cosignersThreshold: 0,
      originalMessage: bytesToHex(new Uint8Array(original)),
      additionalFixedMessage: "0x",
    };

    const body = JSON.stringify({
      data: {
        id,
        type: "instruction",
        submissionTag: "submit",
        message: bytesToHex(Buffer.from(JSON.stringify(dataFixed), "utf-8")),
      },
      additionalVariableMessages: [],
      timestamps: [],
      additionalActionData: "0x",
      signatures: [],
    });

    const [status, res] = await this.#server.handleRequest("POST", "/action", body);
    if (typeof res !== "object" || res === null) {
      return { status, ok: false, log: String(res), payload: null };
    }

    const r = res as Record<string, unknown>;
    const dataHex = typeof r["data"] === "string" ? r["data"] : "0x";
    let payloadOut: unknown = null;
    if (dataHex !== "0x") {
      try {
        payloadOut = JSON.parse(Buffer.from(dataHex.slice(2), "hex").toString("utf-8"));
      } catch {
        payloadOut = dataHex;
      }
    }

    // status 1 = handler succeeded. A refusal is HTTP 200 with status 0 and a
    // reason in log — the wire contract has no other failure channel.
    return {
      status,
      ok: r["status"] === 1,
      log: String(r["log"] ?? ""),
      payload: payloadOut,
    };
  }
}
