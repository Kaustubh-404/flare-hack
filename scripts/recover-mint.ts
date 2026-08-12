/**
 * Recover a stuck direct mint with the `0xE0` skip-memo opcode.
 *
 *   npx tsx scripts/recover-mint.ts <stuckXrplTxHash>
 *
 * When a memo cannot be dispatched — a malformed user operation, or one
 * prepared for a different account, as happened here — `executeDirectMinting`
 * reverts atomically. No FXRP is minted and the underlying XRP stays at the
 * Core Vault. The payment is not lost, but it cannot complete as written: the
 * memo commits to a `userOp` hash, and changing the operation would break the
 * commitment.
 *
 * `0xE0` is the way out. The payer sends a second, small payment whose memo
 * names the stuck transaction. `handleMintedFAssets` checks `ignoreMemo`
 * *before* any memo validation, so on the retry the memo is skipped while
 * `_distributeFAssets` still runs — the FXRP mints, the broken instruction
 * does not.
 *
 * The flag is keyed by `(personalAccount, transactionId)` and deleted on use,
 * so it releases exactly one payment and only for the account that set it.
 */

import { createPublicClient, http } from "viem";
import type { Address, Hex } from "viem";

import { encodeIgnoreMemo, toXrplMemoHex, OneSigClient, dropsToXrp } from "../packages/sdk/src/index.js";
import { computePaymentAmount, readDirectMintingFees } from "../packages/sdk/src/fassets.js";
import { makeClients } from "../packages/executor/src/client.js";
import { FdcClient } from "../packages/executor/src/fdc.js";
import { ExecutorPipeline, normalizeXrplTxId } from "../packages/executor/src/pipeline.js";
import { XamanClient } from "../packages/executor/src/xaman.js";

const stuck = process.argv[2];
if (!stuck) {
  console.error("usage: npx tsx scripts/recover-mint.ts <stuckXrplTxHash>");
  process.exit(1);
}
const stuckTxId = normalizeXrplTxId(stuck);

const RPC = process.env["CHAIN_URL"] ?? "https://coston2-api.flare.network/ext/C/rpc";
const ACCOUNT = process.env["ONESIG_ACCOUNT"];
if (!ACCOUNT) throw new Error("set ONESIG_ACCOUNT to the XRPL account that made the stuck payment");

/** Just enough to clear the minting and executor fees. */
const RECOVERY_NET_UBA = 100_000n;

const log = (s = "") => console.log(s);
const rule = (t: string) => log(`\n─── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const onesig = new OneSigClient({ rpcUrl: RPC });
const xaman = new XamanClient();
const publicClient = createPublicClient({ transport: http(RPC) });
const { account, address: executorAddress, publicClient: pc, walletClient } = makeClients();

const assetManager = await onesig.assetManagerFXRP();
const coreVault = await onesig.directMintingPaymentAddress(assetManager);
const personalAccount = await onesig.getPersonalAccount(ACCOUNT);

rule("the stuck payment");
log(`XRPL tx          : ${stuckTxId}`);
log(`payer            : ${ACCOUNT}`);
log(`personal account : ${personalAccount}`);
log(`executor         : ${executorAddress}`);

const pipeline = new ExecutorPipeline({
  publicClient: pc,
  walletClient,
  account,
  fdc: new FdcClient({ publicClient: pc, walletClient, account }),
  assetManager,
  stateDir: ".executor-state",
});

// ── 1. the 0xE0 payment ───────────────────────────────────────────────────
rule("1. send a 0xE0 skip-memo naming the stuck transaction");

const fees = await readDirectMintingFees(publicClient, assetManager);
const payment = computePaymentAmount(RECOVERY_NET_UBA, fees);
const memo = encodeIgnoreMemo({ executorFeeUBA: 0n, targetTxId: stuckTxId });

log(`memo             : 0xE0 + targetTxId, ${memo.length} bytes`);
log(`cost             : ${dropsToXrp(payment.totalUBA)} XRP`);
log(`  ${dropsToXrp(payment.netMintUBA)} net + ${dropsToXrp(payment.mintingFeeUBA)} minting + ${dropsToXrp(payment.executorFeeUBA)} executor`);

const sign = await xaman.createSignRequest({
  account: ACCOUNT,
  signers: [ACCOUNT],
  destination: coreVault,
  amount: payment.totalUBA.toString(),
  memoData: toXrplMemoHex(memo),
  instruction: `Recover a stuck payment (${stuckTxId.slice(2, 10)}…)`,
  expireMinutes: 15,
});

log(`\n   ┌${"─".repeat(58)}┐`);
log(`   │  Sign on your phone to recover:                          │`);
log(`   │                                                          │`);
log(`   │  ${sign.next.padEnd(56)}│`);
log(`   └${"─".repeat(58)}┘`);
log(`\n   QR: ${sign.qrPng}`);
log(`\nwaiting for the signature…`);

let recoveryTxId: string | undefined;
const deadline = Date.now() + 15 * 60_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3_000));
  const st = await xaman.getSignRequest(sign.uuid);
  if (st.signed && st.txid) {
    recoveryTxId = st.txid;
    log(`\n✅ signed — ${recoveryTxId}`);
    break;
  }
  if (st.resolved && !st.signed) {
    log(`\n❌ rejected — nothing sent, nothing spent\n`);
    process.exit(1);
  }
  if (st.expired) {
    log(`\n❌ expired\n`);
    process.exit(1);
  }
}
if (!recoveryTxId) {
  log(`\n❌ timed out\n`);
  process.exit(1);
}

// ── 2. mint the 0xE0 payment so the flag is actually set ──────────────────
rule("2. execute the 0xE0 payment (this sets the flag on-chain)");
log(`_data is unused for 0xE0 — the memo is dispatched from its own bytes\n`);

const flagJob = await pipeline.create({
  xrplTxId: recoveryTxId,
  userOpData: "0x" as Hex,
  totalCallValue: 0n,
  personalAccount: personalAccount as Address,
  nonce: 0n,
});
const flagDone = await pipeline.run(flagJob, { pollMs: 15_000, timeoutMs: 25 * 60_000 });
if (flagDone.state !== "executed") {
  log(`\n❌ the 0xE0 payment did not execute (state=${flagDone.state}${flagDone.lastError ? `: ${flagDone.lastError}` : ""})\n`);
  process.exit(1);
}
log(`\n✅ ignoreMemo set for (${personalAccount}, ${stuckTxId.slice(0, 10)}…)`);

// ── 3. retry the stuck payment ────────────────────────────────────────────
rule("3. retry the stuck payment — the memo is now skipped");

const stuckJob = await pipeline.load(stuckTxId.slice(2));
if (!stuckJob) {
  log(`\n❌ no persisted job for ${stuckTxId} — cannot retry without its userOpData\n`);
  process.exit(1);
}
stuckJob.state = "observed";
stuckJob.attempts = 0;
delete stuckJob.lastError;
await pipeline.save(stuckJob);

const recovered = await pipeline.run(stuckJob, { pollMs: 15_000, timeoutMs: 25 * 60_000 });

rule("result");
log(`job state : ${recovered.state}`);
if (recovered.flareTxHash) {
  log(`flare tx  : ${recovered.flareTxHash}`);
  log(`explorer  : https://coston2-explorer.flare.network/tx/${recovered.flareTxHash}`);
}

const passed = recovered.state === "executed";
log(
  passed
    ? `\n✅ RECOVERED — the stuck XRP minted to ${personalAccount},\n` +
        `   with the broken instruction skipped rather than executed.\n`
    : `\n❌ still stuck (state=${recovered.state}${recovered.lastError ? `: ${recovered.lastError}` : ""})\n`,
);
process.exit(passed ? 0 : 1);
