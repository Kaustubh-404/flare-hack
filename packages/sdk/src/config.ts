/**
 * Coston2 (chainId 114) addresses.
 *
 * Every address below was resolved live from the chain, not copied from docs:
 *   - `registry` entries via FlareContractRegistry.getContractAddressByName()
 *   - `tee` entries from fce-extension-scaffold/config/coston2/deployed-addresses.json,
 *     cross-checked against tee-proxy's documented tee_manager address
 *
 * Prefer resolveContract() at runtime over the hardcoded values. They are kept
 * here so tests and scripts can run without a round trip, and so a drift shows
 * up as a failing assertion rather than a silent misroute.
 */

import type { Address } from "viem";

export const COSTON2 = {
  chainId: 114,
  rpcUrl: "https://coston2-api.flare.network/ext/C/rpc",
  explorer: "https://coston2-explorer.flare.network",
  faucet: "https://faucet.flare.network/coston2",
} as const;

export const XRPL_TESTNET = {
  rpcUrl: "https://s.altnet.rippletest.net:51234",
  wsUrl: "wss://s.altnet.rippletest.net:51233",
  explorer: "https://testnet.xrpl.org",
  faucet: "https://xrpl.org/resources/dev-tools/xrp-faucets",
} as const;

/** The one address you may hardcode. Everything else resolves through it. */
export const FLARE_CONTRACT_REGISTRY: Address =
  "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

/** Resolved via getContractAddressByName. Verified live on Coston2. */
export const CONTRACTS = {
  MasterAccountController: "0x434936d47503353f06750Db1A444DBDC5F0AD37c",
  AssetManagerFXRP: "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA",
  FtsoV2: "0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d",
  FeeCalculator: "0x88A9315f96c9b5518BBeC58dC6a914e13fAb13e2",
  FdcHub: "0x48aC463d7975828989331F4De43341627b9c5f1D",
  FdcVerification: "0x906507E0B64bcD494Db73bd0459d1C667e14B933",
  FlareSystemsManager: "0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52",
  Relay: "0xa10B672D1c62e5457b17af63d4302add6A99d7dE",
  VoterRegistry: "0x6a0AF07b7972177B176d3D422555cbc98DfDe914",
} as const satisfies Record<string, Address>;

/**
 * FCC contracts. Note these are NOT in the public FlareContractRegistry —
 * getContractAddressByName("TeeExtensionRegistry") returns address(0). The docs'
 * "TeeExtensionRegistry" and "TeeMachineRegistry" are facets of the
 * FlareTeeManager diamond, which is what you actually call.
 */
export const TEE = {
  /** The diamond. Matches tee-proxy's documented `tee_manager`. */
  FlareTeeManager: "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE",
  ExtensionManagerFacet: "0x13ebf34c3Fd436A657cb0f819c59790dF55CE14B",
  InstructionsFacet: "0xe0958De99d4C9Fcb960AEd936Ba5964506AA62Ff",
  MachineManagerFacet: "0xF40B9a2e70EE96042217F10D94A4B1eDf13096a8",
  VerificationFacet: "0x78203332236cF39A0079746385F33060aCC95778",
  /** Protocol Managed Wallet machinery — deployed and live on Coston2. */
  WalletManagerFacet: "0xcbf21163bC2A47E8a0FF69cC006C94684bC8Dc9b",
  WalletKeyManagerFacet: "0x9Aeb4C3959Ba15464241F7b8daf38Ac2Fa1Cca13",
  /** Next-gen TEE-signed FDC. */
  Fdc2Hub: "0x04dd3Ba33aC798d400bEc42A26F82f9812A421dc",
  Fdc2Verification: "0xA34Ff9be42b2C7782786270a51d33b1baC0462Cd",
} as const satisfies Record<string, Address>;

/** Public extension IDs start here; anything below is a system extension. */
export const FIRST_PUBLIC_EXTENSION_ID = 0x10000n;

/** Public FTDC proxy — already running, we never host this one. */
export const NORMAL_PROXY_URL = "https://tee-proxy-coston2-1.flare.rocks";

/**
 * Operator XRPL address(es) that accept Smart Account instructions.
 * Read live with MasterAccountController.getXrplProviderWallets(); this is the
 * value observed on Coston2 and is here as a fallback for offline tooling.
 */
export const OPERATOR_XRPL_ADDRESSES = ["rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq"] as const;

/**
 * Warning surfaced by the SDK when building a payment.
 * MemoInstructionsFacet credits the tag-holder on a tagged payment, which lets
 * an unrelated party front-run the user operation.
 */
export const NO_DESTINATION_TAG_REASON =
  "XRPL payments targeting a Flare Smart Account must not carry a destination tag: " +
  "a tag forces FAssets minting to credit the tag-holder, allowing an unrelated " +
  "party to front-run the user operation.";

/**
 * Contracts we deployed for the ONESIG demo. Source of truth is
 * packages/contracts/deployments/114.json, written by Deploy.s.sol.
 * Verified live on Coston2 at deploy time.
 */
export const DEPLOYED = {
  /** Gate 1 target. Records lastCaller so we can prove the call came via the PA. */
  Counter: "0x1612b980Ddb6c13c01039A712634035Cfb2367E8",
  /** 6-decimal FXRP stand-in. */
  MockFXRP: "0xA2c647c06a3014842e22a3f5C6F390A8d74a52ED",
  /** The deliberately XRPL-unaware demo dApp. */
  MockVault: "0x64b89db12C2D91410011ce1Fcb626C87620Db444",
  /** Human-readable instruction directory. */
  InstructionRegistry: "0x06cC2210f97387C0d1e03DD2ef6E80a02a244E10",
} as const satisfies Record<string, Address>;

/** Selectors registered in the directory at deploy time. */
export const SELECTORS = {
  /** MockVault.deposit(uint256) */
  deposit: "0xb6b55f25",
  /** Counter.increment() */
  increment: "0xd09de08a",
} as const;
