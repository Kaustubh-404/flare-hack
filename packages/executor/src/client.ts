/** Shared viem clients for the executor, wired from .env. */

import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { COSTON2 } from "@onesig/sdk";

export interface ExecutorClients {
  account: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

// The explicit return type is required: viem's inferred client types reference
// internal module paths that cannot be named from here (TS2742).
export function makeClients(
  opts: { rpcUrl?: string; privateKey?: string } = {},
): ExecutorClients {
  const rpcUrl = opts.rpcUrl ?? process.env["CHAIN_URL"] ?? COSTON2.rpcUrl;
  const raw = opts.privateKey ?? process.env["DEPLOYER_PRIVATE_KEY"];
  if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY not set — copy .env.example to .env");

  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  const account = privateKeyToAccount(key);

  return {
    account: account.address,
    publicClient: createPublicClient({ transport: http(rpcUrl) }),
    walletClient: createWalletClient({ account, transport: http(rpcUrl) }),
  };
}
