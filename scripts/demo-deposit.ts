/**
 * The ONESIG flow as a dApp actually uses it.
 *
 *   npx tsx scripts/demo-deposit.ts [--dry-run]
 *
 * Unlike gate1.ts, this does NOT drive the executor. It registers the user
 * operation, sends the XRPL payment, and then waits — the running executor
 * service is expected to notice the payment on its own and finish the job.
 * That separation is the point: the dApp and the executor are different actors.
 *
 * The batch is two calls (approve + deposit), which is the thing a one-signature
 * flow makes possible and a naive bridge does not.
 */

import { Wallet } from "xrpl";
import { createPublicClient, encodeFunctionData, http } from "viem";
import type { Address } from "viem";

import { OneSigClient, DEPLOYED, dropsToXrp } from "../packages/sdk/src/index.js";
import { XrplHttpClient } from "../packages/executor/src/xrpl.js";

const DRY_RUN = process.argv.includes("--dry-run");
const RPC = process.env["CHAIN_URL"] ?? "https://coston2-api.flare.network/ext/C/rpc";
const XRPL_RPC = process.env["XRPL_RPC_URL"] ?? "https://s.altnet.rippletest.net:51234/";
const EXECUTOR = process.env["EXECUTOR_URL"] ?? "http://localhost:8787";

const VAULT_ABI = [
  { type: "function", name: "deposit", inputs: [{ name: "_amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;
const ERC20_ABI = [
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "mint", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

const DEPOSIT = 25_000_000n; // 25 mFXRP (6 decimals)

const seed = process.env["XRPL_SEED"];
if (!seed) throw new Error("XRPL_SEED not set — source scripts/env.sh");

const wallet = Wallet.fromSeed(seed);
const onesig = new OneSigClient({ rpcUrl: RPC });
const publicClient = createPublicClient({ transport: http(RPC) });

const log = (s = "") => console.log(s);

log(`\nXRPL account : ${wallet.address}`);

// ── what a dApp writes ────────────────────────────────────────────────────
// This is the entire integration: describe the calls, get a signable payment.
const req = await onesig.prepare({
  xrplAddress: wallet.address,
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
// ──────────────────────────────────────────────────────────────────────────

log(`personal acct: ${req.personalAccount}`);
log(`nonce        : ${req.nonce}`);
log(`label        : ${req.label}`);
log(`calls        : 2 (approve + deposit) in one signature`);
log(`userOpData   : ${(req.userOpData.length - 2) / 2} bytes off-chain`);
log(`XRPL memo    : ${(req.xrplPayment.Memos[0].Memo.MemoData.length) / 2} bytes on-ledger`);
log(`payment      : ${dropsToXrp(req.payment.totalUBA)} XRP → ${req.xrplPayment.Destination}`);

const vaultBefore = await publicClient.readContract({
  address: DEPLOYED.MockVault as Address,
  abi: VAULT_ABI,
  functionName: "balanceOf",
  args: [req.personalAccount],
});
log(`vault balance: ${Number(vaultBefore) / 1e6} mFXRP (before)`);

if (DRY_RUN) {
  log("\n✅ dry run — nothing registered, nothing sent\n");
  process.exit(0);
}

// The personal account needs mFXRP to deposit. On a real deployment this would
// be the FXRP the mint itself produces; MockFXRP is a testnet stand-in, so seed
// it directly.
const balance = await publicClient.readContract({
  address: DEPLOYED.MockFXRP as Address,
  abi: ERC20_ABI,
  functionName: "balanceOf",
  args: [req.personalAccount],
});
if (balance < DEPOSIT) {
  log(`\n⚠️  personal account holds ${Number(balance) / 1e6} mFXRP, needs ${Number(DEPOSIT) / 1e6}`);
  log(`   run: npx tsx scripts/seed-mock-fxrp.ts ${req.personalAccount}\n`);
  process.exit(1);
}

// 1. hand the bytes to the executor — the XRPL will only carry their hash
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
  throw new Error(`executor rejected registration: ${await registration.text()}`);
}
log(`\nregistered with the executor: ${req.userOpHash.slice(0, 18)}…`);

// 2. the user signs one XRPL payment
const xrpl = new XrplHttpClient(XRPL_RPC);
const submitted = await xrpl.submitPayment(
  {
    account: wallet.address,
    destination: req.xrplPayment.Destination,
    amount: req.xrplPayment.Amount,
    memoData: req.xrplPayment.Memos[0].Memo.MemoData,
  },
  wallet,
);
log(`XRPL tx      : ${submitted.hash}  ${submitted.engineResult}`);
log(`explorer     : https://testnet.xrpl.org/transactions/${submitted.hash}`);

if (!submitted.validated || submitted.engineResult !== "tesSUCCESS") {
  log(`\n❌ payment did not validate\n`);
  process.exit(1);
}

// 3. the dApp does nothing further — the executor takes it from here
log(`\nwaiting for the executor to notice and finalise…`);
const deadline = Date.now() + 20 * 60_000;
let state = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10_000));
  try {
    const res = await fetch(`${EXECUTOR}/status?tx=${submitted.hash}`);
    if (res.ok) {
      const s = (await res.json()) as { state: string; flareTxHash?: string };
      if (s.state !== state) {
        state = s.state;
        log(`  ${state}${s.flareTxHash ? ` — ${s.flareTxHash}` : ""}`);
      }
      if (s.state === "executed" || s.state === "failed") break;
    }
  } catch {
    // executor may not be up yet
  }
}

const vaultAfter = await publicClient.readContract({
  address: DEPLOYED.MockVault as Address,
  abi: VAULT_ABI,
  functionName: "balanceOf",
  args: [req.personalAccount],
});

log(`\nvault balance: ${Number(vaultBefore) / 1e6} → ${Number(vaultAfter) / 1e6} mFXRP`);
const passed = vaultAfter > vaultBefore;
log(
  passed
    ? "\n✅ two contract calls executed on Flare from one XRPL signature,\n" +
        "   relayed by an executor the dApp never spoke to again.\n"
    : `\n❌ deposit did not land (state=${state})\n`,
);
process.exit(passed ? 0 : 1);
