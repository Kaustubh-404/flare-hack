/** Mint MockFXRP to an address so the demo deposit has something to move. */
import { encodeFunctionData } from "viem";
import type { Address } from "viem";
import { DEPLOYED } from "../packages/sdk/src/index.js";
import { makeClients } from "../packages/executor/src/client.js";

const to = process.argv[2] as Address | undefined;
if (!to) { console.error("usage: npx tsx scripts/seed-mock-fxrp.ts <address>"); process.exit(1); }

const { account, publicClient, walletClient } = makeClients();
const ABI = [
  { type: "function", name: "mint", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

const hash = await walletClient.writeContract({
  account, chain: null,
  address: DEPLOYED.MockFXRP as Address,
  abi: ABI, functionName: "mint", args: [to, 1_000_000_000n],
});
await publicClient.waitForTransactionReceipt({ hash });
const bal = await publicClient.readContract({
  address: DEPLOYED.MockFXRP as Address, abi: ABI, functionName: "balanceOf", args: [to],
});
console.log(`minted → ${to}: ${Number(bal) / 1e6} mFXRP  (${hash})`);
