/**
 * THE DEMO — one signature on a phone, two contract calls on Flare.
 *
 *   npx tsx scripts/run-executor.ts      # terminal 1
 *   npx tsx scripts/demo-xaman.ts        # terminal 2
 *
 * Three steps, in this order for a reason:
 *
 *   1. IDENTIFY — a free SignIn request tells us which XRPL account will sign.
 *      The personal account and the nonce both derive from it, so the user
 *      operation cannot be built before this is known. Guessing produces an
 *      InvalidSender revert with the XRP already sitting at the Core Vault.
 *   2. PREPARE  — build the operation for that account and hand the bytes to
 *      the executor. The XRPL only ever carries their hash.
 *   3. SIGN     — one payment, with options.signers pinned to the identified
 *      account so a different one cannot be substituted.
 *
 * The user never sees a memo, a hex string, or the word "Flare".
 */

import { createPublicClient, encodeFunctionData, http } from "viem";
import type { Address } from "viem";

import { OneSigClient, DEPLOYED, dropsToXrp } from "../packages/sdk/src/index.js";
import { XamanClient } from "../packages/executor/src/xaman.js";

const RPC = process.env["CHAIN_URL"] ?? "https://coston2-api.flare.network/ext/C/rpc";
const EXECUTOR = process.env["EXECUTOR_URL"] ?? "http://localhost:8787";
const DEPOSIT = 10_000_000n; // 10 mFXRP

const VAULT_ABI = [
  { type: "function", name: "deposit", inputs: [{ name: "_amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;
const ERC20_ABI = [
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
] as const;

const onesig = new OneSigClient({ rpcUrl: RPC });
const publicClient = createPublicClient({ transport: http(RPC) });
const xaman = new XamanClient();

const log = (s = "") => console.log(s);
const rule = (t: string) => log(`\n─── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const box = (lines: string[]) => {
  const w = 58;
  log(`\n   ┌${"─".repeat(w)}┐`);
  for (const l of lines) log(`   │ ${l.padEnd(w - 2)} │`);
  log(`   └${"─".repeat(w)}┘\n`);
};

// ── 1. IDENTIFY ───────────────────────────────────────────────────────────
// Skip with ONESIG_ACCOUNT=r... once the address is known.
let xrplAddress = process.env["ONESIG_ACCOUNT"];

if (!xrplAddress) {
  rule("1. who is signing?");
  const signIn = await xaman.createSignInRequest("Sign in to ONESIG");
  box(["Open on your phone to identify yourself:", "", signIn.next, "", "(free — SignIn is not a ledger transaction)"]);
  log(`   QR: ${signIn.qrPng}`);
  log(`\nwaiting…`);

  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    const st = await xaman.getSignRequest(signIn.uuid);
    if (st.signed && st.account) {
      xrplAddress = st.account;
      log(`\n✅ identified: ${xrplAddress}`);
      break;
    }
    if (st.resolved && !st.signed) {
      log(`\n❌ sign-in rejected\n`);
      process.exit(1);
    }
  }
  if (!xrplAddress) {
    log(`\n❌ timed out waiting for sign-in\n`);
    process.exit(1);
  }
} else {
  log(`\nXRPL account: ${xrplAddress}  (from ONESIG_ACCOUNT)`);
}

rule("2. what the dApp asks for");

const req = await onesig.prepare({
  xrplAddress,
  calls: [
    {
      target: DEPLOYED.MockFXRP as Address,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [DEPLOYED.MockVault as Address, DEPOSIT],
      }),
    },
    {
      target: DEPLOYED.MockVault as Address,
      value: 0n,
      data: encodeFunctionData({ abi: VAULT_ABI, functionName: "deposit", args: [DEPOSIT] }),
    },
  ],
  label: `Deposit ${Number(DEPOSIT) / 1e6} mFXRP into MockVault`,
  netMintUBA: 1_000_000n,
});

log(`personal account : ${req.personalAccount}`);
log(`calls            : 2 (approve + deposit), one signature`);
log(`user operation   : ${(req.userOpData.length - 2) / 2} bytes — never touches XRPL`);
log(`XRPL memo        : ${req.xrplPayment.Memos[0].Memo.MemoData.length / 2} bytes`);
log(`payment          : ${dropsToXrp(req.payment.totalUBA)} XRP`);

const before = await publicClient.readContract({
  address: DEPLOYED.MockVault as Address,
  abi: VAULT_ABI,
  functionName: "balanceOf",
  args: [req.personalAccount],
});
log(`vault balance    : ${Number(before) / 1e6} mFXRP`);

rule("3. hand the bytes to the executor");
const registration = await fetch(`${EXECUTOR}/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    userOpData: req.userOpData,
    commitment: req.userOpHash,
    personalAccount: req.personalAccount,
    nonce: req.nonce.toString(),
    totalCallValue: req.totalCallValue.toString(),
    label: req.label,
  }),
});
if (!registration.ok) {
  log(`\n❌ executor not reachable at ${EXECUTOR} — is scripts/run-executor.ts running?\n`);
  process.exit(1);
}
log(`registered ${req.userOpHash.slice(0, 18)}…`);

rule("4. sign on the phone");
const sign = await xaman.createSignRequest({
  account: xrplAddress,
  // Pin the signer. txjson.Account is advisory; this is what enforces it.
  signers: [xrplAddress],
  destination: req.xrplPayment.Destination,
  amount: req.xrplPayment.Amount,
  memoData: req.xrplPayment.Memos[0].Memo.MemoData,
  instruction: req.label,
  identifier: req.userOpHash,
  expireMinutes: 15,
});

log(``);
log(`   ┌${"─".repeat(58)}┐`);
log(`   │  Open on your phone:                                     │`);
log(`   │                                                          │`);
log(`   │  ${sign.next.padEnd(56)}│`);
log(`   │                                                          │`);
log(`   │  Xaman will show: "${req.label}"`.padEnd(61) + `│`);
log(`   └${"─".repeat(58)}┘`);
log(``);
log(`   QR image: ${sign.qrPng}`);
log(`\nwaiting for the signature (15 min)…`);

let txid: string | undefined;
const signDeadline = Date.now() + 15 * 60_000;
while (Date.now() < signDeadline) {
  await new Promise((r) => setTimeout(r, 3_000));
  const status = await xaman.getSignRequest(sign.uuid);
  if (status.signed && status.txid) {
    txid = status.txid;
    log(`\n✅ signed by ${status.account}`);
    log(`XRPL tx : ${txid}`);
    log(`explorer: https://testnet.xrpl.org/transactions/${txid}`);
    break;
  }
  if (status.resolved && !status.signed) {
    log(`\n❌ rejected in the app — nothing was sent, nothing spent\n`);
    process.exit(1);
  }
  if (status.expired) {
    log(`\n❌ sign request expired\n`);
    process.exit(1);
  }
}
if (!txid) {
  log(`\n❌ timed out waiting for a signature\n`);
  process.exit(1);
}

rule("5. the executor takes over");
log(`the dApp is done — it never speaks to the executor again\n`);

let state = "";
const execDeadline = Date.now() + 20 * 60_000;
while (Date.now() < execDeadline) {
  await new Promise((r) => setTimeout(r, 8_000));
  try {
    const res = await fetch(`${EXECUTOR}/status?tx=${txid}`);
    if (!res.ok) continue;
    const s = (await res.json()) as { state: string; flareTxHash?: string; roundId?: number };
    if (s.state !== state) {
      state = s.state;
      const extra = s.flareTxHash ?? (s.roundId ? `round ${s.roundId}` : "");
      log(`  ${state}${extra ? ` — ${extra}` : ""}`);
    }
    if (s.state === "executed" || s.state === "failed") break;
  } catch {
    // executor still starting, or a transient network blip
  }
}

rule("6. result");
const after = await publicClient.readContract({
  address: DEPLOYED.MockVault as Address,
  abi: VAULT_ABI,
  functionName: "balanceOf",
  args: [req.personalAccount],
});
log(`vault balance: ${Number(before) / 1e6} → ${Number(after) / 1e6} mFXRP`);

const passed = after > before;
log(
  passed
    ? `\n✅ Two contract calls ran on Flare from one signature on a phone.\n` +
        `   No bridge. No FLR. No wallet switch. The user never saw a memo.\n`
    : `\n❌ deposit did not land (state=${state})\n`,
);
process.exit(passed ? 0 : 1);
