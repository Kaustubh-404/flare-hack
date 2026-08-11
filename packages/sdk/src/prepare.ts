/**
 * The ONESIG public API.
 *
 * A dApp describes what it wants; this returns a signable XRPL payment. Every
 * footgun the Smart Accounts flow has is handled here rather than documented:
 * deterministic account resolution, exact nonce reads, byte-correct memos, and
 * a hard refusal to attach a destination tag.
 */

import { createPublicClient, http } from "viem";
import type { Address, Hex, PublicClient } from "viem";

import { COSTON2, FLARE_CONTRACT_REGISTRY, NO_DESTINATION_TAG_REASON } from "./config.js";
import { encodeExecuteCommittedMemo, toXrplMemoHex } from "./memo.js";
import { prepareUserOp, type Call } from "./userop.js";
import type { PackedUserOperation } from "./userop.js";

const REGISTRY_ABI = [
  {
    type: "function",
    name: "getContractAddressByName",
    stateMutability: "view",
    inputs: [{ name: "_name", type: "string" }],
    outputs: [{ type: "address" }],
  },
] as const;

const MASTER_ACCOUNT_CONTROLLER_ABI = [
  {
    type: "function",
    name: "getPersonalAccount",
    stateMutability: "view",
    inputs: [{ name: "_xrplAddress", type: "string" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getNonce",
    stateMutability: "view",
    inputs: [{ name: "_personalAccount", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getExecutor",
    stateMutability: "view",
    inputs: [{ name: "_personalAccount", type: "address" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getXrplProviderWallets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string[]" }],
  },
] as const;

export interface OneSigClientOptions {
  rpcUrl?: string;
  /** Override contract discovery. Leave unset to resolve from the registry. */
  masterAccountController?: Address;
}

export interface PrepareParams {
  /** The XRPL account that will sign — its personal account is derived from this. */
  xrplAddress: string;
  /** The batch to run. Executes in order; any revert unwinds all of it. */
  calls: readonly Call[];
  /** Human-readable summary shown in the wallet. */
  label: string;
  /** Executor fee in the FAsset's smallest unit. */
  feeUBA: bigint;
  /** Wallet identifier assigned by the Flare Foundation; 0 if unregistered. */
  walletId?: number;
  /** XRP to send, in drops. Must cover the FAssets mint plus the executor fee. */
  amountDrops: string;
}

export interface PreparedRequest {
  /** Deterministic personal account for this XRPL address. */
  personalAccount: Address;
  nonce: bigint;
  userOp: PackedUserOperation;
  /** Bytes the executor delivers off-chain. Never published on XRPL. */
  userOpData: Hex;
  /** The 32-byte commitment. This is all XRPL sees. */
  userOpHash: Hex;
  label: string;
  /** An executor pinned via 0xD0, or null if anyone may relay. */
  pinnedExecutor: Address | null;
  /** Ready to sign. Deliberately has no DestinationTag field. */
  xrplPayment: {
    TransactionType: "Payment";
    Account: string;
    Destination: string;
    Amount: string;
    Memos: [{ Memo: { MemoData: string } }];
  };
}

export class OneSigClient {
  readonly #client: PublicClient;
  #mac: Address | undefined;

  constructor(options: OneSigClientOptions = {}) {
    this.#client = createPublicClient({
      transport: http(options.rpcUrl ?? COSTON2.rpcUrl),
    });
    this.#mac = options.masterAccountController;
  }

  /** Resolve MasterAccountController from the registry. Never hardcode it. */
  async masterAccountController(): Promise<Address> {
    if (this.#mac) return this.#mac;
    const resolved = await this.#client.readContract({
      address: FLARE_CONTRACT_REGISTRY,
      abi: REGISTRY_ABI,
      functionName: "getContractAddressByName",
      args: ["MasterAccountController"],
    });
    this.#mac = resolved;
    return resolved;
  }

  /** Deterministic — resolvable before the account is deployed. */
  async getPersonalAccount(xrplAddress: string): Promise<Address> {
    return this.#client.readContract({
      address: await this.masterAccountController(),
      abi: MASTER_ACCOUNT_CONTROLLER_ABI,
      functionName: "getPersonalAccount",
      args: [xrplAddress],
    });
  }

  async getNonce(personalAccount: Address): Promise<bigint> {
    return this.#client.readContract({
      address: await this.masterAccountController(),
      abi: MASTER_ACCOUNT_CONTROLLER_ABI,
      functionName: "getNonce",
      args: [personalAccount],
    });
  }

  /** address(0) means unpinned — anyone may relay. */
  async getExecutor(personalAccount: Address): Promise<Address> {
    return this.#client.readContract({
      address: await this.masterAccountController(),
      abi: MASTER_ACCOUNT_CONTROLLER_ABI,
      functionName: "getExecutor",
      args: [personalAccount],
    });
  }

  /** XRPL addresses that accept Smart Account instructions. */
  async getOperatorXrplAddresses(): Promise<readonly string[]> {
    return this.#client.readContract({
      address: await this.masterAccountController(),
      abi: MASTER_ACCOUNT_CONTROLLER_ABI,
      functionName: "getXrplProviderWallets",
    });
  }

  /**
   * Turn a batch of Flare calls into an XRPL payment the user can sign.
   *
   * The nonce is read immediately before the memo is built. Two payments in
   * flight from one XRPL account will collide on nonce — serialise per account.
   */
  async prepare(params: PrepareParams): Promise<PreparedRequest> {
    const {
      xrplAddress,
      calls,
      label,
      feeUBA,
      walletId = 0,
      amountDrops,
    } = params;

    const [personalAccount, operators] = await Promise.all([
      this.getPersonalAccount(xrplAddress),
      this.getOperatorXrplAddresses(),
    ]);

    const destination = operators[0];
    if (!destination) {
      throw new Error("no operator XRPL address registered on MasterAccountController");
    }

    const [nonce, executor] = await Promise.all([
      this.getNonce(personalAccount),
      this.getExecutor(personalAccount),
    ]);

    const { userOp, userOpData, userOpHash } = prepareUserOp({
      sender: personalAccount,
      nonce,
      calls,
    });

    const memo = encodeExecuteCommittedMemo({
      walletId,
      executorFeeUBA: feeUBA,
      userOpHash,
    });

    const ZERO = "0x0000000000000000000000000000000000000000";

    return {
      personalAccount,
      nonce,
      userOp,
      userOpData,
      userOpHash,
      label,
      pinnedExecutor: executor === ZERO ? null : executor,
      // No DestinationTag, by construction. See NO_DESTINATION_TAG_REASON.
      xrplPayment: {
        TransactionType: "Payment",
        Account: xrplAddress,
        Destination: destination,
        Amount: amountDrops,
        Memos: [{ Memo: { MemoData: toXrplMemoHex(memo) } }],
      },
    };
  }
}

export { NO_DESTINATION_TAG_REASON };
