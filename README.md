# ONESIG + LATCH

**Flare Summer Signal 2026** — two projects, one codebase.

| | | Track |
|---|---|---|
| **ONESIG** | Fifteen lines make any Flare dApp controllable from an XRP wallet | Bounty 1 — Interoperable Asset Products |
| **LATCH** | A private, conditional order placed from an XRP wallet that nobody can read until it fires | Bounty 2 — Confidential Compute Apps |

LATCH is built on ONESIG's plumbing: same memo encoding, same user operations, same relay path. The difference is who holds the intent — a server, or an attested TEE.

> **Status: early.** The XRPL→Flare foundation is in place and tested. Nothing here is production software.

---

## The problem

Flare Smart Accounts lets an XRP holder sign **one** ordinary XRPL payment and have arbitrary calls execute on Flare — no bridge, no FLR for gas, no second wallet, full self-custody. It works today, on mainnet, in Xaman.

Two gaps:

**1. It's practically a closed set.** Three instruction types exist — FXRP, Firelight, Upshift — each assigned by hand by the Flare Foundation. The `0xFE` custom instruction is a general escape hatch, but using it means hand-encoding 42-byte memos, assembling EIP-4337 user operations, and running an always-on executor. Almost nobody will.

**2. The executor sees everything.** The XRPL publishes only a 32-byte commitment; the actual calls travel off-chain to an executor that reads them in plaintext before submitting. It can front-run, censor, or vanish. XRP's whole premise is *don't trust custodians*, and the executor slot quietly reintroduces one.

ONESIG closes the first gap. LATCH closes the second.

---

## ONESIG

An SDK, a relay service, an instruction directory, and a QR component.

```ts
const req = await onesig.prepare({
  calls: [{ target: vault, value: 0n, data: encodeFunctionData({ abi, functionName: "deposit", args: [amount] }) }],
  label: "Deposit 100 XRP into MockVault",
  feeUBA: 1_000_000n,
});
```

Out comes a signable XRPL payment and a QR code. The relay earns `executorFeeUBA` — the fee is already part of the protocol, so it pays for itself rather than needing a grant.

The directory is a safety feature, not decoration: today an XRPL user signing a `0xFE` memo is blind-signing a hash. The directory renders *"Deposit 100 XRP into MockVault"* instead.

## LATCH

Put an attested TEE in the executor slot.

You encrypt your intent to hardware whose code hash is registered on-chain. The XRP Ledger records a hash. The enclave holds the plaintext and **waits** — for an FTSO price, a deadline, an FDC-proven event — then fires.

A private, self-custodial limit order, placed from a wallet that has never heard of a smart contract. While it waits there is no mempool entry and no on-chain state, so there is nothing to front-run.

**You can't get trapped.** `0xD0`/`0xD1` (set/remove executor) deliberately bypass the executor check — see `MemoInstructionsFacet`, line 63: `// check PA executor (0xD0/0xD1 bypass to prevent lock-out)`. Un-pinning is a protocol guarantee, not something LATCH has to promise.

---

## Repo

```
packages/sdk/         memo encoding, user operations, Coston2 config
packages/executor/    XRPL watcher → FDC proof → executeDirectMinting
packages/contracts/   Foundry — MockVault, InstructionRegistry, LatchRegistry
packages/web/         QR component, demo pages
extension/            LATCH TEE extension (fce-extension-scaffold)
```

### Memo opcodes

Transcribed from `flare-smart-accounts/contracts/smartAccounts/library/MemoInstructions.sol`, not from documentation. Each encoder asserts the exact byte length the contract's `require()` enforces, so a malformed memo fails locally rather than after an XRPL payment is already signed and a nonce burned.

| Opcode | Bytes | Meaning |
|---|---|---|
| `0xFF` | 10 + N | Execute, user operation inline (bounded by XRPL's 1024-byte memo cap) |
| `0xFE` | 42 | Execute, commitment only — constant size, payload private on XRPL |
| `0xE0` | 42 | Ignore a stuck memo |
| `0xE1` | 42 | Fast-forward the nonce |
| `0xE2` | 50 | Bump a stuck executor fee |
| `0xD0` | 30 | Pin an executor |
| `0xD1` | 10 | Unpin |

`0xE0`–`0xE2` and `0xD0`/`0xD1` are absent from the developer docs.

---

## Verified on Coston2

Resolved live from `FlareContractRegistry` (`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`), not copied from docs.

| | |
|---|---|
| MasterAccountController | `0x434936d47503353f06750Db1A444DBDC5F0AD37c` |
| AssetManagerFXRP | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` |
| FtsoV2 | `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` |
| FdcHub | `0x48aC463d7975828989331F4De43341627b9c5f1D` |
| FlareTeeManager (FCC diamond) | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` |
| Operator XRPL address | `rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq` |

`TeeExtensionRegistry` and `TeeMachineRegistry` are **not** in the public registry — `getContractAddressByName` returns `address(0)`. They are facets of the `FlareTeeManager` diamond.

---

## Develop

```bash
npm install
npm test              # 19 passing
npm run typecheck
cp .env.example .env  # fill in; .env is gitignored
```

**Never commit a key.** Flare's own `fce-sign` repo ships a live testnet private key in a committed `.env.coston2`, and `.env.example` in the scaffold carries another. If you fork either, replace them — everyone who has cloned those repos has those keys.

---

## Networks

Coston2 (chain 114) and XRPL testnet. Test tokens only — nothing here has value.

- Coston2 faucet — https://faucet.flare.network/coston2
- XRPL testnet faucet — https://xrpl.org/resources/dev-tools/xrp-faucets

## License

MIT
