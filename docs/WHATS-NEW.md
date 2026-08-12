# What was built during the hackathon

Flare Summer Signal runs 29 June – 14 August 2026. Everything in this repository
was written during the program. There is no pre-existing product underneath it —
the first commit is the first line of code.

Each entry below is checkable: `git show <hash>`.

## Timeline

| Date | Commit | What |
|---|---|---|
| 2026-08-11 | `c531884` | Memo encoder for all 7 opcodes + `PackedUserOperation` assembly |
| 2026-08-11 | `7de47f7` | Fix: tsconfig `rootDir` was excluding tests from the typecheck |
| 2026-08-11 | `750baa5` | README with Coston2 addresses resolved live from the registry |
| 2026-08-11 | `b3ccd3b` | Contracts: `Counter`, `MockVault`, `MockFXRP`, `InstructionRegistry` |
| 2026-08-11 | `50cb6e7` | `OneSigClient.prepare()` — dApp intent → signable XRPL payment |
| 2026-08-11 | `180b40a` | Deployed the demo surface to Coston2 |
| 2026-08-11 | `8267244` | Fix: payments must go to the FAssets Core Vault, not the operator wallet |
| 2026-08-12 | `c383b0f` | Executor: FDC attestation pipeline as a resumable state machine |

## Built new

**`packages/sdk`** — the ONESIG SDK.

- `memo.ts` — encoders and decoders for every Smart Accounts memo opcode:
  `0xFF`, `0xFE`, `0xE0`, `0xE1`, `0xE2`, `0xD0`, `0xD1`. Byte layouts are
  transcribed from `MemoInstructions.sol`, and every encoder asserts the exact
  length the contract's `require()` enforces, so a malformed memo fails locally
  instead of after an XRPL payment is signed and a nonce burned.
  **Five of these seven opcodes are absent from the developer documentation.**
- `userop.ts` — `PackedUserOperation` assembly and the `keccak256` commitment.
- `fassets.ts` — direct-minting destination and fee arithmetic, read live from
  the AssetManager.
- `prepare.ts` — the public API: a dApp describes calls, gets back a signable
  XRPL payment.
- `config.ts` — Coston2 addresses, all resolved from `FlareContractRegistry`
  rather than copied from documentation.

**`packages/executor`** — the relay.

- `fdc.ts` — FDC `XRPPayment` attestation: verifier request, on-chain submit
  with the voting round derived from the block timestamp, `Relay` finalisation
  check, DA-layer proof fetch.
- `pipeline.ts` — a persisted state machine, not a straight-line async function.
  An FDC round takes minutes, so a crash mid-flight must not lose the request:
  resubmitting costs another fee and another round. Verifier lag and DA-layer
  lag retry indefinitely; genuine errors give up after five attempts. Rate
  limits *delay* rather than reject, so a delayed mint resumes with the same
  proof after `executionAllowedAt` — never a second XRPL payment.
- `xrpl.ts` — HTTP JSON-RPC client. Sign offline, submit the blob, poll for
  validation.

**`packages/contracts`** — deployed to Coston2.

- `Counter.sol` records `lastCaller`, so Gate 1 proves the call arrived through
  the personal account rather than from an EOA.
- `MockVault.sol` is deliberately XRPL-unaware: the "dApp that has never heard
  of the XRP Ledger" in the demo.
- `InstructionRegistry.sol` maps `(target, selector)` to human-readable text so
  users stop blind-signing a 32-byte commitment. Advisory by construction — it
  can change what a user *sees*, never what executes.

## Integrated (existing Flare infrastructure, not written by us)

| Component | How it is used |
|---|---|
| Flare Smart Accounts | `0xFE` custom instruction; `MasterAccountController`; `PersonalAccount.executeUserOp` |
| FAssets v1.3 direct minting | One XRPL payment to the Core Vault → FXRP + dispatched memo |
| Flare Data Connector | `XRPPayment` attestation (type `0x08`) proves the XRPL payment |
| `FlareContractRegistry` | Every address resolved at runtime |
| `@flarenetwork/flare-wagmi-periphery-package` | ABIs, so they cannot drift from on-chain |

## Deployed

Coston2 (chain 114):

| Contract | Address |
|---|---|
| Counter | `0x1612b980Ddb6c13c01039A712634035Cfb2367E8` |
| MockFXRP | `0xA2c647c06a3014842e22a3f5C6F390A8d74a52ED` |
| MockVault | `0x64b89db12C2D91410011ce1Fcb626C87620Db444` |
| InstructionRegistry | `0x06cC2210f97387C0d1e03DD2ef6E80a02a244E10` |

## Things we found that the documentation does not say

These cost real debugging time and are recorded so the next person does not pay
for them twice.

1. **Two flows, two XRPL destinations.** The Smart Accounts overview leads with
   `getXrplProviderWallets()` — the operator wallet for the *proof-based*
   payment-reference flow. The memo opcodes (`0xFE`/`0xFF`) belong to the
   *direct-minting* flow and must be paid to the **Core Vault**, from
   `AssetManager.directMintingPaymentAddress()`. Paid to the operator wallet,
   the memo is never dispatched: no revert, no error, just silence. Fixed in
   `8267244`.

2. **Fees are deducted from the payment, not added by the protocol.** A payment
   that fails to cover the minting fee mints nothing and forwards the entire
   amount to the fee receiver, irreversibly. The amount must be computed:
   `net + max(net × feeBIPS / 10000, minimumFee) + executorFee`.

3. **`0xFE` finalises through `executeDirectMintingWithData`,** not
   `executeDirectMinting` — the latter is only for inline `0xFF`. And `msg.value`
   on that call must carry the batch's total call value.

4. **The attestation type is `XRPPayment` (`0x08`),** not the legacy generic
   `Payment` (`0x01`). Different response shape; the AssetManager accepts only
   the former.

5. **`0xD0`/`0xD1` deliberately bypass the executor check.** From
   `MemoInstructionsFacet` line 63: `// check PA executor (0xD0/0xD1 bypass to
   prevent lock-out)`. A user can always un-pin an executor, whatever that
   executor does. This is a protocol-level guarantee, which matters a great deal
   for LATCH's trust story.

6. **Three supposed blockers were not blockers.**
   - The Coston2 indexer DB is a copy of *public* C-chain logs; the indexer that
     fills it is open source and its default config points at localhost. Flare's
     shared instance is a convenience, not a gate.
   - `NORMAL_PROXY_URL` (the FTDC proxy) is already public and running.
   - The FDC testnet verifier accepts the placeholder API key — verified live,
     HTTP 200, `status: VALID`.

## Verification

Nothing above is asserted without a check that can be re-run:

```bash
npm test                                    # 19 SDK + 9 executor
cd packages/contracts && forge test         # 10 contracts
npx tsx scripts/verify-prepare.ts           # 11 assertions vs live Coston2, free
npx tsx scripts/verify-fdc.ts <xrplTxHash>  # verifier leg, free
npx tsx scripts/gate1.ts --dry-run          # full build + preflight, spends nothing
./scripts/check-secrets.sh                  # pre-push audit
```
