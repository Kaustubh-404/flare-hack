/**
 * The ONESIG executor service.
 *
 * Three loops in one process:
 *
 *   intake   POST /register   a dApp hands over user-operation bytes before the
 *                             user signs. The XRPL only ever carries the hash.
 *   watch                     poll the Core Vault for payments whose commitment
 *                             we hold bytes for.
 *   drive                     advance every live job one step per tick.
 *
 * Jobs are advanced by repeated `step()` rather than an await-chain per job, so
 * one slow FDC round cannot stall the others and a restart resumes everything
 * from disk.
 *
 * The service earns `executorFeeUBA` on each mint it finalises — the fee is
 * part of the protocol, so this pays for itself rather than needing a subsidy.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Address, Hex } from "viem";

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ExecutorPipeline, type Job } from "./pipeline.js";
import { PendingStore } from "./store.js";
import { Watcher } from "./watcher.js";
import { XrplHttpClient } from "./xrpl.js";
import { XamanClient } from "./xaman.js";

export interface ServiceOptions {
  pipeline: ExecutorPipeline;
  xrpl: XrplHttpClient;
  coreVaultAddress: string;
  store?: PendingStore;
  port?: number;
  pollMs?: number;
  log?: (msg: string) => void;
  /** Builds an operation for a given XRPL account. Injected to keep the SDK out of here. */
  prepare?: (xrplAddress: string) => Promise<PreparedForWeb>;
  /** Reads a Flare view function for the dashboard. */
  readVaultBalance?: (personalAccount: string) => Promise<string>;
}

/** What the demo page needs to render an operation before it is signed. */
export interface PreparedForWeb {
  personalAccount: string;
  nonce: string;
  label: string;
  userOpData: string;
  userOpHash: string;
  totalCallValue: string;
  memoHex: string;
  destination: string;
  amountDrops: string;
  calls: { target: string; label: string; selector: string }[];
}

export class ExecutorService {
  readonly #pipeline: ExecutorPipeline;
  readonly #store: PendingStore;
  readonly #watcher: Watcher;
  readonly #port: number;
  readonly #pollMs: number;
  readonly #log: (msg: string) => void;
  readonly #live = new Map<string, Job>();
  readonly #xrpl: XrplHttpClient;
  readonly #coreVaultAddress: string;
  readonly #prepare: ServiceOptions["prepare"];
  readonly #readVaultBalance: ServiceOptions["readVaultBalance"];
  #xaman: XamanClient | undefined;
  #server: Server | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(opts: ServiceOptions) {
    this.#pipeline = opts.pipeline;
    this.#store = opts.store ?? new PendingStore();
    this.#log = opts.log ?? ((m) => console.log(m));
    this.#xrpl = opts.xrpl;
    this.#coreVaultAddress = opts.coreVaultAddress;
    this.#watcher = new Watcher(opts.xrpl, this.#store, opts.coreVaultAddress, this.#log);
    this.#port = opts.port ?? 8787;
    this.#pollMs = opts.pollMs ?? 10_000;
    this.#prepare = opts.prepare;
    this.#readVaultBalance = opts.readVaultBalance;
    if (XamanClient.isConfigured()) this.#xaman = new XamanClient();
  }

  get store(): PendingStore {
    return this.#store;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      void this.#handle(req, res).catch((e: unknown) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      });
    });

    await new Promise<void>((resolve) => this.#server!.listen(this.#port, resolve));
    this.#log(`executor listening on :${this.#port}`);

    // Only look forward. The Core Vault is shared and busy; replaying its whole
    // history on boot would mean re-examining mints other executors already
    // finalised.
    const startLedger = await this.#xrpl.currentLedger();
    this.#watcher.setStartLedger(startLedger);
    this.#log(`watching the Core Vault from ledger ${startLedger}`);

    this.#timer = setInterval(() => void this.#tick(), this.#pollMs);
    void this.#tick();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#server) await new Promise<void>((r) => this.#server!.close(() => r()));
  }

  async #handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    const url = new URL(req.url ?? "/", `http://localhost:${this.#port}`);

    if (req.method === "POST" && url.pathname === "/register") {
      const body = (await readBody(req)) as {
        userOpData?: Hex;
        commitment?: Hex;
        personalAccount?: Address;
        nonce?: string;
        totalCallValue?: string;
        label?: string;
      };
      if (!body.userOpData || !body.personalAccount) {
        return json(400, { error: "userOpData and personalAccount are required" });
      }
      // register() recomputes the commitment and rejects a mismatch.
      const commitment = await this.#store.register({
        userOpData: body.userOpData,
        personalAccount: body.personalAccount,
        nonce: body.nonce ?? "0",
        totalCallValue: body.totalCallValue ?? "0",
        label: body.label ?? "(unlabelled)",
        ...(body.commitment ? { commitment: body.commitment } : {}),
      });
      this.#log(`registered ${commitment.slice(0, 10)}… — ${body.label ?? "(unlabelled)"}`);
      return json(200, { commitment });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      const id = url.searchParams.get("tx");
      if (!id) return json(400, { error: "tx query parameter is required" });
      const job = await this.#pipeline.load(id.replace(/^0x/, "").toUpperCase());
      if (!job) return json(404, { error: "no job for that XRPL transaction" });
      return json(200, {
        state: job.state,
        roundId: job.roundId,
        flareTxHash: job.flareTxHash,
        executionAllowedAt: job.executionAllowedAt,
        lastError: job.lastError,
      });
    }

    if (req.method === "GET" && url.pathname === "/pending") {
      const pending = await this.#store.list();
      return json(200, {
        // Deliberately does not return userOpData: the point of this service is
        // that the payload stays unread until it executes.
        pending: pending.map((p) => ({
          commitment: p.commitment,
          label: p.label,
          personalAccount: p.personalAccount,
          registeredAt: p.registeredAt,
        })),
      });
    }

    // ── demo page ─────────────────────────────────────────────────────────
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const here = dirname(fileURLToPath(import.meta.url));
      try {
        const html = await readFile(join(here, "..", "public", "index.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      } catch {
        return json(404, { error: "demo page not found" });
      }
    }

    if (req.method === "GET" && url.pathname === "/config") {
      return json(200, {
        xamanConfigured: Boolean(this.#xaman),
        coreVault: this.#coreVaultAddress,
      });
    }

    // ── Xaman: identify, then sign ────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/signin") {
      if (!this.#xaman) return json(503, { error: "Xaman is not configured on this executor" });
      const r = await this.#xaman.createSignInRequest("Sign in to ONESIG");
      return json(200, { uuid: r.uuid, next: r.next, qr: r.qrPng });
    }

    if (req.method === "GET" && url.pathname.startsWith("/xaman/")) {
      if (!this.#xaman) return json(503, { error: "Xaman is not configured on this executor" });
      const uuid = url.pathname.slice("/xaman/".length);
      return json(200, await this.#xaman.getSignRequest(uuid));
    }

    if (req.method === "POST" && url.pathname === "/prepare") {
      if (!this.#prepare) return json(503, { error: "prepare is not wired on this executor" });
      const body = (await readBody(req)) as { xrplAddress?: string };
      if (!body.xrplAddress) return json(400, { error: "xrplAddress is required" });

      const prepared = await this.#prepare(body.xrplAddress);
      // Hold the bytes now, so the XRPL only ever carries their hash.
      await this.#store.register({
        userOpData: prepared.userOpData as `0x${string}`,
        commitment: prepared.userOpHash as `0x${string}`,
        personalAccount: prepared.personalAccount as Address,
        nonce: prepared.nonce,
        totalCallValue: prepared.totalCallValue,
        label: prepared.label,
      });

      if (!this.#xaman) return json(200, { prepared, sign: null });
      const sign = await this.#xaman.createSignRequest({
        account: body.xrplAddress,
        signers: [body.xrplAddress],
        destination: prepared.destination,
        amount: prepared.amountDrops,
        memoData: prepared.memoHex,
        instruction: prepared.label,
        identifier: prepared.userOpHash as `0x${string}`,
        expireMinutes: 15,
      });
      return json(200, {
        prepared,
        sign: { uuid: sign.uuid, next: sign.next, qr: sign.qrPng },
      });
    }

    if (req.method === "GET" && url.pathname === "/vault") {
      if (!this.#readVaultBalance) return json(503, { error: "vault reads are not wired" });
      const pa = url.searchParams.get("account");
      if (!pa) return json(400, { error: "account query parameter is required" });
      return json(200, { balance: await this.#readVaultBalance(pa) });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true, live: this.#live.size });
    }

    return json(404, { error: "not found" });
  }

  async #tick(): Promise<void> {
    try {
      for (const observed of await this.#watcher.poll()) {
        if (this.#live.has(observed.xrplTxId)) continue;
        const pending = await this.#store.get(observed.commitment);
        if (!pending) continue;

        const job = await this.#pipeline.create({
          xrplTxId: observed.xrplTxId,
          userOpData: pending.userOpData,
          totalCallValue: BigInt(pending.totalCallValue),
          personalAccount: pending.personalAccount,
          nonce: BigInt(pending.nonce),
        });
        this.#live.set(observed.xrplTxId, job);
        this.#log(`job ${job.id.slice(0, 8)}… created — ${pending.label}`);
      }
    } catch (e) {
      this.#log(`watcher error (will retry): ${e instanceof Error ? e.message : String(e)}`);
    }

    // Advance each job one step. A slow round on one must not block the rest.
    for (const [id, job] of this.#live) {
      try {
        const next = await this.#pipeline.step(job);
        this.#live.set(id, next);
        if (next.state === "executed" || next.state === "failed") this.#live.delete(id);
      } catch (e) {
        this.#log(`job ${id.slice(0, 8)}… step error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
