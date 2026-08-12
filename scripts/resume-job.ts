/**
 * Resume a persisted executor job.
 *
 *   npx tsx scripts/resume-job.ts <xrplTxHash>
 *
 * The XRPL payment has already been made and the XRP is already at the Core
 * Vault. Everything the executor needs — the user operation bytes, the nonce,
 * the personal account — was persisted when the job was created, so a code fix
 * plus this script finishes the mint without a second payment.
 *
 * This is the whole reason the pipeline is a state machine rather than a
 * straight-line async function.
 */

import { createPublicClient, http } from "viem";
import type { Address } from "viem";

import { OneSigClient, DEPLOYED } from "../packages/sdk/src/index.js";
import { makeClients } from "../packages/executor/src/client.js";
import { FdcClient } from "../packages/executor/src/fdc.js";
import { ExecutorPipeline, normalizeXrplTxId } from "../packages/executor/src/pipeline.js";

const COUNTER_ABI = [
  { type: "function", name: "count", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "lastCaller", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
] as const;

const arg = process.argv[2];
if (!arg) {
  console.error("usage: npx tsx scripts/resume-job.ts <xrplTxHash>");
  process.exit(1);
}
const id = normalizeXrplTxId(arg).slice(2);

const RPC = process.env["CHAIN_URL"] ?? "https://coston2-api.flare.network/ext/C/rpc";
const { account, address, publicClient: pc, walletClient } = makeClients();
const onesig = new OneSigClient({ rpcUrl: RPC });
const publicClient = createPublicClient({ transport: http(RPC) });

const pipeline = new ExecutorPipeline({
  publicClient: pc,
  walletClient,
  account,
  fdc: new FdcClient({ publicClient: pc, walletClient, account }),
  assetManager: await onesig.assetManagerFXRP(),
  stateDir: ".executor-state",
});

const job = await pipeline.load(id);
if (!job) {
  console.error(`no persisted job for ${id}`);
  process.exit(1);
}

console.log(`\njob        : ${job.id.slice(0, 8)}`);
console.log(`state      : ${job.state}`);
console.log(`executor   : ${address}`);
console.log(`personal   : ${job.personalAccount}`);
console.log(`userOpData : ${(job.userOpData.length - 2) / 2} bytes (persisted, never re-derived)\n`);

if (job.state === "failed") {
  // Clear the terminal state so the fixed code can drive it again. Preparing
  // the attestation request is free and idempotent, so restarting from
  // "observed" costs nothing.
  job.state = "observed";
  job.attempts = 0;
  delete job.lastError;
  await pipeline.save(job);
  console.log("reset failed → observed, resuming with the same XRPL payment\n");
}

const countBefore = await publicClient.readContract({
  address: DEPLOYED.Counter as Address,
  abi: COUNTER_ABI,
  functionName: "count",
});

const finished = await pipeline.run(job, { pollMs: 15_000, timeoutMs: 25 * 60_000 });

console.log(`\njob state  : ${finished.state}`);
if (finished.flareTxHash) {
  console.log(`flare tx   : ${finished.flareTxHash}`);
  console.log(`explorer   : https://coston2-explorer.flare.network/tx/${finished.flareTxHash}`);
}

const countAfter = await publicClient.readContract({
  address: DEPLOYED.Counter as Address,
  abi: COUNTER_ABI,
  functionName: "count",
});
const lastCaller = await publicClient.readContract({
  address: DEPLOYED.Counter as Address,
  abi: COUNTER_ABI,
  functionName: "lastCaller",
});

console.log(`\nCounter.count(): ${countBefore} → ${countAfter}`);
console.log(`lastCaller     : ${lastCaller}`);

const passed =
  finished.state === "executed" &&
  countAfter > countBefore &&
  (lastCaller as string).toLowerCase() === job.personalAccount.toLowerCase();

console.log(
  passed
    ? "\n✅ GATE 1 PASSED — one XRPL signature executed a call on Flare,\n" +
        "   from a personal account that did not exist when it was signed.\n"
    : `\n❌ not yet (state=${finished.state}${finished.lastError ? `, ${finished.lastError}` : ""})\n`,
);
process.exit(passed ? 0 : 1);
