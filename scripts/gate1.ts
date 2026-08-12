/**
 * GATE 1 — the end-to-end proof.
 *
 * One XRPL payment carrying a 42-byte 0xFE memo causes Counter.increment() to
 * run on Coston2, called by a personal account that did not exist when the
 * payment was signed.
 *
 *   npx tsx scripts/gate1.ts --dry-run   # build and validate, broadcast nothing
 *   npx tsx scripts/gate1.ts             # for real
 *
 * Everything before the XRPL submit is free and reversible. The script asserts
 * as much as it can up front so a mistake costs nothing.
 */

import { Wallet } from "xrpl";
import { createPublicClient, encodeFunctionData, http } from "viem";
import type { Address, Hex } from "viem";

import { OneSigClient, DEPLOYED, dropsToXrp, decodeMemo, OPCODE } from "../packages/sdk/src/index.js";
import { makeClients } from "../packages/executor/src/client.js";
import { FdcClient } from "../packages/executor/src/fdc.js";
import { ExecutorPipeline } from "../packages/executor/src/pipeline.js";
import { XrplHttpClient } from "../packages/executor/src/xrpl.js";

const DRY_RUN = process.argv.includes("--dry-run");

const COUNTER_ABI = [
  { type: "function", name: "increment", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "count", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "lastCaller", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
] as const;

const XRPL_RPC = process.env["XRPL_RPC_URL"] ?? "https://s.altnet.rippletest.net:51234/";
const RPC = process.env["CHAIN_URL"] ?? "https://coston2-api.flare.network/ext/C/rpc";
/** 1 XRP net. Total lands at 1.2 XRP with fees — small enough to fail cheaply. */
const NET_MINT_UBA = 1_000_000n;

const seed = process.env["XRPL_SEED"];
if (!seed) throw new Error("XRPL_SEED not set — source scripts/env.sh");

const line = (s = "") => console.log(s);
const rule = (t: string) => line(`\n─── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const wallet = Wallet.fromSeed(seed);
const publicClient = createPublicClient({ transport: http(RPC) });
const onesig = new OneSigClient({ rpcUrl: RPC });

rule("1. build the request");
line(`XRPL account   : ${wallet.address}`);

const req = await onesig.prepare({
  xrplAddress: wallet.address,
  calls: [
    {
      target: DEPLOYED.Counter as Address,
      value: 0n,
      data: encodeFunctionData({ abi: COUNTER_ABI, functionName: "increment" }),
    },
  ],
  label: "Increment the Gate 1 counter",
  netMintUBA: NET_MINT_UBA,
});

line(`personal acct  : ${req.personalAccount}`);
line(`nonce          : ${req.nonce}`);
line(`destination    : ${req.xrplPayment.Destination}  (FAssets Core Vault)`);
line(
  `amount         : ${dropsToXrp(req.payment.totalUBA)} XRP ` +
    `(${dropsToXrp(req.payment.netMintUBA)} net + ` +
    `${dropsToXrp(req.payment.mintingFeeUBA)} minting + ` +
    `${dropsToXrp(req.payment.executorFeeUBA)} executor)`,
);
line(`memo           : ${req.xrplPayment.Memos[0].Memo.MemoData}`);
line(`userOpData     : ${(req.userOpData.length - 2) / 2} bytes — off-chain only`);

rule("2. pre-flight assertions (free)");
let bad = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) bad++;
  line(`  ${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
};

const memoBytes = Buffer.from(req.xrplPayment.Memos[0].Memo.MemoData, "hex");
const decoded = decodeMemo(new Uint8Array(memoBytes));
check("memo is 42 bytes", memoBytes.length === 42, `(${memoBytes.length})`);
check("opcode is 0xFE", decoded.opcode === OPCODE.EXECUTE_COMMITTED);
check(
  "commitment matches userOpData",
  decoded.opcode === OPCODE.EXECUTE_COMMITTED && decoded.userOpHash === req.userOpHash,
);
check("no DestinationTag", !("DestinationTag" in req.xrplPayment));
check("destination is the Core Vault", req.xrplPayment.Destination === (await onesig.directMintingPaymentAddress()));
check("sender binds to the personal account", req.userOp.sender === req.personalAccount);
check("call value is zero (no PA funding needed)", req.totalCallValue === 0n);

const countBefore = await publicClient.readContract({
  address: DEPLOYED.Counter as Address,
  abi: COUNTER_ABI,
  functionName: "count",
});
line(`\n  Counter.count() before : ${countBefore}`);

if (bad > 0) {
  line(`\n❌ ${bad} pre-flight assertion(s) failed — not broadcasting\n`);
  process.exit(1);
}

if (DRY_RUN) {
  line("\n✅ dry run complete — nothing broadcast, nothing spent\n");
  process.exit(0);
}

rule("3. submit the XRPL payment");
const xrpl = new XrplHttpClient(XRPL_RPC);

const { balanceDrops } = await xrpl.accountInfo(wallet.address);
const balance = Number(balanceDrops) / 1e6;
line(`XRP balance    : ${balance}`);
if (BigInt(balanceDrops) < req.payment.totalUBA + 1_000_000n) {
  throw new Error(`insufficient XRP: have ${balance}, need ${dropsToXrp(req.payment.totalUBA)} + reserve`);
}

const submitted = await xrpl.submitPayment(
  {
    account: wallet.address,
    destination: req.xrplPayment.Destination,
    amount: req.xrplPayment.Amount,
    memoData: req.xrplPayment.Memos[0].Memo.MemoData,
  },
  wallet,
);

line(`XRPL tx        : ${submitted.hash}`);
line(`result         : ${submitted.engineResult}${submitted.validated ? " (validated)" : " (NOT validated)"}`);
line(`explorer       : https://testnet.xrpl.org/transactions/${submitted.hash}`);

if (!submitted.validated || submitted.engineResult !== "tesSUCCESS") {
  line(`\n❌ XRPL payment did not validate (${submitted.engineResult})\n`);
  process.exit(1);
}
const xrplTxHash = submitted.hash;

rule("4. executor: FDC attestation → mint → user operation");
const { account, address: executorAddress, publicClient: pc, walletClient } = makeClients();
line(`executor       : ${executorAddress}`);

const fdc = new FdcClient({ publicClient: pc, walletClient, account });
const pipeline = new ExecutorPipeline({
  publicClient: pc,
  walletClient,
  account,
  fdc,
  assetManager: await onesig.assetManagerFXRP(),
  stateDir: ".executor-state",
});

const job = await pipeline.create({
  xrplTxId: xrplTxHash,
  userOpData: req.userOpData,
  totalCallValue: req.totalCallValue,
  personalAccount: req.personalAccount,
  nonce: req.nonce,
});

const finished = await pipeline.run(job, { pollMs: 15_000, timeoutMs: 25 * 60_000 });

rule("5. result");
line(`job state      : ${finished.state}`);
if (finished.flareTxHash) {
  line(`flare tx       : ${finished.flareTxHash}`);
  line(`explorer       : https://coston2-explorer.flare.network/tx/${finished.flareTxHash}`);
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

line(`\nCounter.count(): ${countBefore} → ${countAfter}`);
line(`lastCaller     : ${lastCaller}`);

const passed =
  finished.state === "executed" &&
  countAfter === countBefore + 1n &&
  (lastCaller as string).toLowerCase() === req.personalAccount.toLowerCase();

line(
  passed
    ? "\n✅ GATE 1 PASSED — one XRPL signature executed a call on Flare,\n" +
        "   from a personal account that did not exist when it was signed.\n"
    : `\n❌ GATE 1 FAILED (state=${finished.state}${finished.lastError ? `, ${finished.lastError}` : ""})\n`,
);
process.exit(passed ? 0 : 1);
