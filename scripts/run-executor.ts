/**
 * Run the ONESIG executor — and serve the demo at the same address.
 *
 *   npx tsx scripts/run-executor.ts     →  http://localhost:8787
 *
 * One command gives a judge the whole thing: the relay, the HTTP API, and the
 * page. No second install, no second terminal.
 */

import { createPublicClient, encodeFunctionData, http } from "viem";
import type { Address } from "viem";

import { OneSigClient, DEPLOYED, toXrplMemoHex, encodeExecuteCommittedMemo } from "../packages/sdk/src/index.js";
import { makeClients } from "../packages/executor/src/client.js";
import { FdcClient } from "../packages/executor/src/fdc.js";
import { ExecutorPipeline } from "../packages/executor/src/pipeline.js";
import { ExecutorService, type PreparedForWeb } from "../packages/executor/src/service.js";
import { XrplHttpClient } from "../packages/executor/src/xrpl.js";

const RPC = process.env["CHAIN_URL"] ?? "https://coston2-api.flare.network/ext/C/rpc";
const XRPL_RPC = process.env["XRPL_RPC_URL"] ?? "https://s.altnet.rippletest.net:51234/";
const PORT = Number(process.env["EXECUTOR_PORT"] ?? 8787);

/** What the demo asks for: approve, then deposit. Two calls, one signature. */
const DEPOSIT = 10_000_000n;

const VAULT_ABI = [
  { type: "function", name: "deposit", inputs: [{ name: "_amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;
const ERC20_ABI = [
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
] as const;

const { account, address, publicClient, walletClient } = makeClients();
const onesig = new OneSigClient({ rpcUrl: RPC });
const reader = createPublicClient({ transport: http(RPC) });

const assetManager = await onesig.assetManagerFXRP();
const coreVault = await onesig.directMintingPaymentAddress(assetManager);

console.log(`executor account : ${address}`);
console.log(`asset manager    : ${assetManager}`);
console.log(`core vault       : ${coreVault}`);

async function prepare(xrplAddress: string): Promise<PreparedForWeb> {
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

  const memoHex = toXrplMemoHex(
    encodeExecuteCommittedMemo({ executorFeeUBA: 0n, userOpHash: req.userOpHash }),
  );

  return {
    personalAccount: req.personalAccount,
    nonce: req.nonce.toString(),
    label: req.label,
    userOpData: req.userOpData,
    userOpHash: req.userOpHash,
    totalCallValue: req.totalCallValue.toString(),
    memoHex,
    destination: req.xrplPayment.Destination,
    amountDrops: req.xrplPayment.Amount,
    calls: [
      { target: DEPLOYED.MockFXRP, label: `approve(MockVault, ${Number(DEPOSIT) / 1e6})`, selector: "0x095ea7b3" },
      { target: DEPLOYED.MockVault, label: `deposit(${Number(DEPOSIT) / 1e6})`, selector: "0xb6b55f25" },
    ],
  };
}

async function readVaultBalance(personalAccount: string): Promise<string> {
  const bal = await reader.readContract({
    address: DEPLOYED.MockVault as Address,
    abi: VAULT_ABI,
    functionName: "balanceOf",
    args: [personalAccount as Address],
  });
  return bal.toString();
}

const service = new ExecutorService({
  pipeline: new ExecutorPipeline({
    publicClient,
    walletClient,
    account,
    fdc: new FdcClient({ publicClient, walletClient, account }),
    assetManager,
  }),
  xrpl: new XrplHttpClient(XRPL_RPC),
  coreVaultAddress: coreVault,
  port: PORT,
  pollMs: 8_000,
  prepare,
  readVaultBalance,
});

await service.start();
console.log(`\n  demo → http://localhost:${PORT}\n`);

const shutdown = async () => {
  console.log("\nshutting down…");
  await service.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
