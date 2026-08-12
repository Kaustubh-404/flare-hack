/**
 * Verify the Xaman credentials and create one real testnet sign request.
 *
 *   npx tsx scripts/verify-xaman.ts
 *
 * Creates a payload for the actual ONESIG deposit and prints the QR URL.
 * Nothing is signed or spent unless you scan it.
 */
import { XamanClient } from "../packages/executor/src/xaman.js";
import { OneSigClient, DEPLOYED, dropsToXrp } from "../packages/sdk/src/index.js";
import { encodeFunctionData } from "viem";
import type { Address } from "viem";
import { Wallet } from "xrpl";

const xaman = new XamanClient();
const ping = await xaman.ping();
console.log(`\nXaman API   : ${ping.pong ? "✅ authenticated" : "❌"}  (app "${ping.application?.name}")`);

const seed = process.env["XRPL_SEED"];
if (!seed) throw new Error("XRPL_SEED not set");
const wallet = Wallet.fromSeed(seed);

const onesig = new OneSigClient();
const req = await onesig.prepare({
  xrplAddress: wallet.address,
  calls: [{
    target: DEPLOYED.MockVault as Address,
    value: 0n,
    data: encodeFunctionData({
      abi: [{ type: "function", name: "deposit", inputs: [{ name: "_amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" }],
      functionName: "deposit", args: [10_000_000n],
    }),
  }],
  label: "Deposit 10 mFXRP into MockVault",
  netMintUBA: 1_000_000n,
});

const sign = await xaman.createSignRequest({
  account: wallet.address,
  destination: req.xrplPayment.Destination,
  amount: req.xrplPayment.Amount,
  memoData: req.xrplPayment.Memos[0].Memo.MemoData,
  instruction: req.label,
  identifier: req.userOpHash,
  expireMinutes: 10,
});

console.log(`\nsign request: ${sign.uuid}`);
console.log(`amount      : ${dropsToXrp(req.payment.totalUBA)} XRP → ${req.xrplPayment.Destination}`);
console.log(`shown as    : "${req.label}"`);
console.log(`memo        : ${req.xrplPayment.Memos[0].Memo.MemoData.length / 2} bytes (user never sees this)`);
console.log(`\nopen on this device : ${sign.next}`);
console.log(`scan from a phone   : ${sign.qrPng}`);

const status = await xaman.getSignRequest(sign.uuid);
console.log(`\nstatus      : resolved=${status.resolved} signed=${status.signed}`);
console.log("\n✅ Xaman is wired end to end — scan the QR to sign it for real\n");
