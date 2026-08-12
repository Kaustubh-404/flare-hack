/**
 * FDC XRPPayment attestation: request → round finalisation → proof.
 *
 * This is the slowest and most failure-prone leg of the whole flow, so it is
 * written as explicit, resumable steps rather than one long await chain. A
 * round can take minutes; the DA layer lags finalisation; any step can be
 * retried without redoing the ones before it.
 *
 * Attestation type is `XRPPayment` (id 0x08), NOT the legacy generic `Payment`
 * (0x01) — they have different response shapes and AssetManagerFXRP only
 * accepts the former.
 */

import { decodeAbiParameters, toHex } from "viem";
import type {
  AbiParameter,
  Address,
  Account,
  Hex,
  PublicClient,
  WalletClient,
} from "viem";
import { coston2 } from "@flarenetwork/flare-wagmi-periphery-package";

import { FLARE_CONTRACT_REGISTRY } from "@onesig/sdk";

export const ATTESTATION_TYPE_XRP_PAYMENT = "XRPPayment";
/** Coston2 testnet source id. Mainnet uses "XRP". */
export const XRP_SOURCE_ID_TESTNET = "testXRP";

export const VERIFIER_BASE_TESTNET = "https://fdc-verifiers-testnet.flare.network";
export const DA_LAYER_COSTON2 = "https://ctn2-data-availability.flare.network";

/**
 * The testnet verifier accepts the placeholder key — verified with a live
 * request that returned HTTP 200 ("INVALID: TRANSACTION DOES NOT EXIST" for a
 * nonexistent tx, i.e. it authenticated and then evaluated). No credential
 * needs to be requested from anyone.
 */
export const VERIFIER_API_KEY_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

const REGISTRY_ABI = [
  {
    type: "function",
    name: "getContractAddressByName",
    stateMutability: "view",
    inputs: [{ name: "_name", type: "string" }],
    outputs: [{ type: "address" }],
  },
] as const;

/** The IXRPPayment.Response tuple, taken from the periphery ABI so it cannot drift. */
const xrpPaymentResponseParam = (
  coston2.ixrpPaymentVerificationAbi.find(
    (f) => f.type === "function" && "name" in f && f.name === "verifyXRPPayment",
  ) as { inputs: readonly { components?: readonly AbiParameter[] }[] } | undefined
)?.inputs?.[0]?.components?.[1];

export interface XrpPaymentProof {
  merkleProof: readonly Hex[];
  data: unknown;
}

export class FdcClient {
  readonly #public: PublicClient;
  readonly #wallet: WalletClient;
  readonly #account: Account;
  readonly #verifierBase: string;
  readonly #daLayer: string;
  readonly #apiKey: string;
  readonly #sourceId: string;
  #registryCache = new Map<string, Address>();

  constructor(opts: {
    publicClient: PublicClient;
    walletClient: WalletClient;
    /** The Account OBJECT. A bare address makes viem ask the node to sign. */
    account: Account;
    verifierBaseUrl?: string;
    daLayerUrl?: string;
    apiKey?: string;
    sourceId?: string;
  }) {
    this.#public = opts.publicClient;
    this.#wallet = opts.walletClient;
    this.#account = opts.account;
    this.#verifierBase = (opts.verifierBaseUrl ?? VERIFIER_BASE_TESTNET).replace(/\/$/, "");
    this.#daLayer = (opts.daLayerUrl ?? DA_LAYER_COSTON2).replace(/\/$/, "");
    this.#apiKey = opts.apiKey ?? VERIFIER_API_KEY_PLACEHOLDER;
    this.#sourceId = opts.sourceId ?? XRP_SOURCE_ID_TESTNET;
  }

  async resolve(name: string): Promise<Address> {
    const cached = this.#registryCache.get(name);
    if (cached) return cached;
    const address = await this.#public.readContract({
      address: FLARE_CONTRACT_REGISTRY,
      abi: REGISTRY_ABI,
      functionName: "getContractAddressByName",
      args: [name],
    });
    this.#registryCache.set(name, address);
    return address;
  }

  /**
   * Step 1 — ask the verifier to encode an attestation request.
   *
   * `proofOwner` is enforced on-chain by TransactionAttestation.verifyProofOwnership:
   * it must be either the zero address (proof usable by anyone) or the account
   * that will call executeDirectMintingWithData. Binding it to the executor
   * stops a third party from lifting the proof and finalising the mint first.
   */
  async prepareRequest(params: {
    xrplTransactionId: Hex;
    proofOwner?: Address;
  }): Promise<Hex> {
    const url = `${this.#verifierBase}/verifier/xrp/${ATTESTATION_TYPE_XRP_PAYMENT}/prepareRequest`;
    const body = {
      attestationType: toHex(ATTESTATION_TYPE_XRP_PAYMENT, { size: 32 }),
      sourceId: toHex(this.#sourceId, { size: 32 }),
      requestBody: {
        transactionId: params.xrplTransactionId,
        proofOwner: params.proofOwner ?? this.#account.address,
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": this.#apiKey },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`verifier HTTP ${res.status}: ${text}`);

    const parsed = JSON.parse(text) as {
      status?: string;
      abiEncodedRequest?: string;
      errorMessage?: string;
    };
    // A 200 with a non-OK status is the common case: the XRPL tx has not
    // reached the verifier's indexer yet. Surface it as retryable, not fatal.
    if (parsed.status && !parsed.status.startsWith("OK") && parsed.status !== "VALID") {
      throw new VerifierNotReadyError(parsed.status, parsed.errorMessage);
    }
    if (!parsed.abiEncodedRequest) {
      throw new Error(`verifier response missing abiEncodedRequest: ${text}`);
    }
    return parsed.abiEncodedRequest as Hex;
  }

  /** Step 2 — submit on-chain and derive the voting round from the block timestamp. */
  async submitRequest(abiEncodedRequest: Hex): Promise<{ roundId: number; txHash: Hex }> {
    const fdcHub = await this.resolve("FdcHub");

    const feeConfig = await this.#public.readContract({
      address: fdcHub,
      abi: coston2.iFdcHubAbi,
      functionName: "fdcRequestFeeConfigurations",
    });
    const fee = await this.#public.readContract({
      address: feeConfig,
      abi: coston2.iFdcRequestFeeConfigurationsAbi,
      functionName: "getRequestFee",
      args: [abiEncodedRequest],
    });

    const txHash = await this.#wallet.writeContract({
      account: this.#account,
      chain: null,
      address: fdcHub,
      abi: coston2.iFdcHubAbi,
      functionName: "requestAttestation",
      args: [abiEncodedRequest],
      value: fee,
    });
    const receipt = await this.#public.waitForTransactionReceipt({ hash: txHash });
    const block = await this.#public.getBlock({ blockNumber: receipt.blockNumber });

    const fsm = await this.resolve("FlareSystemsManager");
    const [firstRoundStartTs, epochDuration] = await Promise.all([
      this.#public.readContract({
        address: fsm,
        abi: coston2.iFlareSystemsManagerAbi,
        functionName: "firstVotingRoundStartTs",
      }),
      this.#public.readContract({
        address: fsm,
        abi: coston2.iFlareSystemsManagerAbi,
        functionName: "votingEpochDurationSeconds",
      }),
    ]);

    const roundId = Number((BigInt(block.timestamp) - firstRoundStartTs) / epochDuration);
    return { roundId, txHash };
  }

  /** Step 3 — has the round been finalised by the Relay yet? */
  async isRoundFinalized(roundId: number): Promise<boolean> {
    const [relay, fdcVerification] = await Promise.all([
      this.resolve("Relay"),
      this.resolve("FdcVerification"),
    ]);
    const protocolId = await this.#public.readContract({
      address: fdcVerification,
      abi: coston2.iFdcVerificationAbi,
      functionName: "fdcProtocolId",
    });
    return this.#public.readContract({
      address: relay,
      abi: coston2.iRelayAbi,
      functionName: "isFinalized",
      args: [BigInt(protocolId), BigInt(roundId)],
    });
  }

  /**
   * Step 4 — fetch the Merkle proof from the DA layer.
   *
   * The DA layer lags finalisation by a little, so a miss here is normal and
   * retryable rather than an error.
   */
  async fetchProof(abiEncodedRequest: Hex, roundId: number): Promise<XrpPaymentProof> {
    const res = await fetch(`${this.#daLayer}/api/v1/fdc/proof-by-request-round-raw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ votingRoundId: roundId, requestBytes: abiEncodedRequest }),
    });
    const text = await res.text();
    if (!res.ok) throw new DaLayerNotReadyError(`HTTP ${res.status}: ${text.slice(0, 200)}`);

    const raw = JSON.parse(text) as { response_hex?: string; proof?: readonly Hex[] };
    if (!raw.response_hex) throw new DaLayerNotReadyError("proof not published yet");

    if (!xrpPaymentResponseParam) {
      throw new Error("IXRPPayment.Response ABI not found in the periphery package");
    }
    const [decoded] = decodeAbiParameters(
      [xrpPaymentResponseParam],
      raw.response_hex as Hex,
    );
    return { merkleProof: raw.proof ?? [], data: decoded };
  }
}

/** The XRPL transaction has not reached the verifier's indexer yet. Retry. */
export class VerifierNotReadyError extends Error {
  constructor(
    readonly status: string,
    readonly detail?: string,
  ) {
    super(`verifier not ready: ${status}${detail ? ` (${detail})` : ""}`);
    this.name = "VerifierNotReadyError";
  }
}

/** The round finalised but the proof is not published yet. Retry. */
export class DaLayerNotReadyError extends Error {
  constructor(message: string) {
    super(`DA layer not ready: ${message}`);
    this.name = "DaLayerNotReadyError";
  }
}
