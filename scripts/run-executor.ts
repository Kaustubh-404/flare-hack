/**
 * Run the ONESIG executor service.
 *
 *   npx tsx scripts/run-executor.ts
 *
 * Listens on :8787 for dApps to register user operations, watches the FAssets
 * Core Vault for the matching XRPL payments, and drives each mint to completion.
 */

import { OneSigClient } from "../packages/sdk/src/index.js";
import { makeClients } from "../packages/executor/src/client.js";
import { FdcClient } from "../packages/executor/src/fdc.js";
import { ExecutorPipeline } from "../packages/executor/src/pipeline.js";
import { ExecutorService } from "../packages/executor/src/service.js";
import { XrplHttpClient } from "../packages/executor/src/xrpl.js";

const RPC = process.env["CHAIN_URL"] ?? "https://coston2-api.flare.network/ext/C/rpc";
const XRPL_RPC = process.env["XRPL_RPC_URL"] ?? "https://s.altnet.rippletest.net:51234/";
const PORT = Number(process.env["EXECUTOR_PORT"] ?? 8787);

const { account, address, publicClient, walletClient } = makeClients();
const onesig = new OneSigClient({ rpcUrl: RPC });
const assetManager = await onesig.assetManagerFXRP();
const coreVault = await onesig.directMintingPaymentAddress(assetManager);

console.log(`executor account : ${address}`);
console.log(`asset manager    : ${assetManager}`);
console.log(`core vault       : ${coreVault}`);

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
});

await service.start();

const shutdown = async () => {
  console.log("\nshutting down…");
  await service.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
