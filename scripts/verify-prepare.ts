/**
 * Read-only verification of the ONESIG prepare() path against live Coston2.
 *
 * Needs no funds and broadcasts nothing — it proves account derivation, nonce
 * reads, memo encoding and the destination-tag refusal all agree with the chain
 * before we spend anything on Gate 1.
 *
 *   npx tsx scripts/verify-prepare.ts [xrplAddress]
 */

import { encodeFunctionData } from "viem";
import { OneSigClient } from "../packages/sdk/src/prepare.js";
import { decodeMemo, fromXrplMemoHex, OPCODE } from "../packages/sdk/src/memo.js";
import { dropsToXrp } from "../packages/sdk/src/fassets.js";

const XRPL = process.argv[2] ?? "rHfJXzJFt1d1r9VAQdVokWZYtm5hq7P56o";

const ok = (b: boolean) => (b ? "✅" : "❌");
let failures = 0;
function check(label: string, passed: boolean, detail = "") {
  if (!passed) failures++;
  console.log(`  ${ok(passed)} ${label}${detail ? `  ${detail}` : ""}`);
}

const client = new OneSigClient();

console.log(`\nXRPL account: ${XRPL}\n`);

const mac = await client.masterAccountController();
console.log(`MasterAccountController (from registry): ${mac}`);

const req = await client.prepare({
  xrplAddress: XRPL,
  calls: [
    {
      target: "0x0000000000000000000000000000000000000001",
      value: 0n,
      data: encodeFunctionData({
        abi: [
          { type: "function", name: "increment", inputs: [], outputs: [], stateMutability: "nonpayable" },
        ],
        functionName: "increment",
      }),
    },
  ],
  label: "Increment the Gate 1 counter",
  netMintUBA: 10_000_000n, // 10 XRP net
});

console.log(`personal account : ${req.personalAccount}`);
console.log(`nonce            : ${req.nonce}`);
console.log(`pinned executor  : ${req.pinnedExecutor ?? "(none — anyone may relay)"}`);
console.log(`userOpHash       : ${req.userOpHash}`);
console.log(`userOpData       : ${(req.userOpData.length - 2) / 2} bytes, delivered off-chain`);
console.log(
  `payment          : ${dropsToXrp(req.payment.netMintUBA)} net + ` +
    `${dropsToXrp(req.payment.mintingFeeUBA)} minting fee + ` +
    `${dropsToXrp(req.payment.executorFeeUBA)} executor fee = ` +
    `${dropsToXrp(req.payment.totalUBA)} XRP\n`,
);

console.log("XRPL payment to sign:");
console.log(JSON.stringify(req.xrplPayment, null, 2));

console.log("\nAssertions:");
check("no DestinationTag on the payment", !("DestinationTag" in req.xrplPayment));

const memo = fromXrplMemoHex(req.xrplPayment.Memos[0].Memo.MemoData);
check("memo is exactly 42 bytes", memo.length === 42, `(got ${memo.length})`);

const decoded = decodeMemo(memo);
check("opcode is 0xFE", decoded.opcode === OPCODE.EXECUTE_COMMITTED);
check(
  "memo commitment matches userOpHash",
  decoded.opcode === OPCODE.EXECUTE_COMMITTED && decoded.userOpHash === req.userOpHash,
);
check("executor fee round-trips", decoded.executorFeeUBA === 0n);
const coreVault = await client.directMintingPaymentAddress();
check(
  "destination is the FAssets Core Vault, not the operator wallet",
  req.xrplPayment.Destination === coreVault,
  `(${req.xrplPayment.Destination})`,
);
const operators = await client.getOperatorXrplAddresses();
check(
  "destination is NOT the proof-flow operator wallet",
  req.xrplPayment.Destination !== operators[0],
  `(operator is ${operators[0]})`,
);
check(
  "payment covers net mint + all fees",
  BigInt(req.xrplPayment.Amount) ===
    req.payment.netMintUBA + req.payment.mintingFeeUBA + req.payment.executorFeeUBA,
);
check(
  "XRPL sees only the commitment, not the calldata",
  !req.xrplPayment.Memos[0].Memo.MemoData.toLowerCase().includes(
    req.userOpData.slice(2, 40).toLowerCase(),
  ),
);
check("sender binds to the derived personal account", req.userOp.sender === req.personalAccount);
check("nonce in userOp matches the on-chain nonce", req.userOp.nonce === req.nonce);

console.log(
  failures === 0
    ? "\n✅ all assertions passed — prepare() agrees with live Coston2\n"
    : `\n❌ ${failures} assertion(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
