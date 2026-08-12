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

**LATCH is a registered Flare Compute Extension on Coston2.**

| | |
|---|---|
| InstructionSender | `0x185280D93027E413C3d4f256FF294033F50a2b86` |
| Extension ID | `0x10280` (66,176) |

Verified independently — `FlareTeeManager.getTeeExtensionInstructionsSender(66176)`
returns our contract. Public extension IDs start at `0x10000`, so this is a real
entry in Flare's live FCC registry alongside every other extension on the
network.

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

6. **Xaman's `custom_meta.identifier` is capped at 40 characters**, and says so
   nowhere. Over the cap you get `{"error":{"code":413}}` with no field named.
   Established by bisecting the live API: 40 succeeds, 41 fails. A full
   `0x`-prefixed commitment is 66 characters, so it has to be truncated.

7. **`txjson.Account` does not enforce who signs — `options.signers` does.**
   Setting `Account` in a Xaman payload is advisory: the user may still sign
   with a different account they hold. This is not a cosmetic difference. A
   personal account and its nonce both derive from *whoever paid*, so a user
   operation prepared for account A and paid for by account B reverts with
   `InvalidSender`, atomically, with the XRP already sitting at the Core Vault.
   Found the expensive way (see below).

   The structural fix is not the flag. A dApp cannot build a user operation
   before it knows which account will sign, so the flow has to be:

   ```
   IDENTIFY (free SignIn payload) → PREPARE for that account → SIGN with
   options.signers pinned to it
   ```

   `options.signers` is then a guard rail rather than the mechanism.

8. **The Core Vault is a shared, publicly executable queue, and competing
   relayers are live on Coston2.** Any pending direct mint can be finalised by
   anyone willing to pay the gas, and they collect `executorFeeUBA`. We lost
   that race twice in a row during the recovery below, reverting with
   `0x18dce79f` — `PaymentAlreadyConfirmed()`, a selector absent from every ABI
   in the periphery package.

   Three consequences:

   - `PaymentAlreadyConfirmed` is a **normal outcome, not an error**. The
     pipeline now confirms `isTransactionIdUsed` on-chain and marks the job
     executed rather than retrying. Flare's own reference implementation
     carries a `reuseExistingMint` flag for exactly this.
   - **The executor's fee revenue is contested.** "The protocol pays the
     executor, so it funds itself" is true only when the executor wins the
     race. Stated plainly rather than overclaimed.
   - **This is what `getExecutor` pinning is for.** Pin an executor with the
     `0xD0` memo and `handleMintedFAssets` reverts `WrongExecutor` for anyone
     else. We had understood pinning as a privacy mechanism for LATCH; it is
     equally an economic one. Losing the race is what surfaced that.

9. **Three supposed blockers were not blockers.**
   - The Coston2 indexer DB is a copy of *public* C-chain logs; the indexer that
     fills it is open source and its default config points at localhost. Flare's
     shared instance is a convenience, not a gate.
   - `NORMAL_PROXY_URL` (the FTDC proxy) is already public and running.
   - The FDC testnet verifier accepts the placeholder API key — verified live,
     HTTP 200, `status: VALID`.

## Gate 1 — proven end to end on Coston2

One XRPL payment, signed once, executed a call on Flare from a personal account
that did not exist when the payment was signed.

| | |
|---|---|
| XRPL payment | [`72641C74…4A2BF14E`](https://testnet.xrpl.org/transactions/72641C7489F785DE2F5BF5A166522431E8888793446AC2E143AB46094A2BF14E) — 1.2 XRP to the Core Vault <!-- public tx hash, not-a-secret --> |
| Memo | 42 bytes, `0xFE` + commitment. The 737-byte user operation never touched XRPL |
| FDC voting round | [1423089](https://coston2-systems-explorer.flare.network/voting-round/1423089?tab=fdc) |
| Flare execution | [`0xc4b609f7…8cea9a35`](https://coston2-explorer.flare.network/tx/0xc4b609f7dc57bb2bb8b8e52519cc34f72be753f97521e5dd9d4fa6688cea9a35) |

Verified independently by reading the chain, not by trusting the script:

```
Counter.count()       0 → 1
Counter.lastCaller()  0x32d9D88C60E263241735adC87D957Db9cfBF7a39   (the personal account)
personal account      585 bytes of code — deployed BY this mint; it was empty before
nonce                 0 → 1
```

`lastCaller` is the load-bearing assertion: it proves the call arrived through
`PersonalAccount.executeUserOp`, not from an EOA calling the contract directly.

## The full ONESIG flow — dApp and executor as separate actors

Gate 1 drove the executor from the same script. This run did not: a standalone
executor service was already running, and the dApp registered its user
operation and then never spoke to it again. The service noticed the XRPL
payment on its own.

| | |
|---|---|
| XRPL payment | [`9EA8E3FB…FFD3CC15`](https://testnet.xrpl.org/transactions/9EA8E3FB0C610FFD2EDBAF8ACED7DB9CEC42921A288E4BFEDC250AA7FFD3CC15) <!-- public tx hash, not-a-secret --> |
| FDC voting round | [1423121](https://coston2-systems-explorer.flare.network/voting-round/1423121?tab=fdc) |
| Flare execution | [`0x6ede7868…bba8ffbef`](https://coston2-explorer.flare.network/tx/0x6ede7868d12f4384d965f9792fec3be7c6dedf3726a735920157b42bba8ffbef) <!-- public tx hash, not-a-secret --> |

**Two contract calls — `approve` then `deposit` — from one XRPL signature.**
Verified on-chain:

```
MockVault.balanceOf(PA)   0 → 25000000     (25 mFXRP)
MockVault.totalDeposits   0 → 25000000
MockFXRP.balanceOf(PA)    1000 → 975 mFXRP
personal account nonce    1 → 2
```

The service log shows the handover:

```
registered 0x8ea78145… — Deposit 25 mFXRP into MockVault
observed 9EA8E3FB… → Deposit 25 mFXRP into MockVault
job 9EA8E3FB… created
[9EA8E3FB] retryable (attempt 1): verifier not ready: INVALID: TRANSACTION DOES NOT EXIST
[9EA8E3FB] round 1423121 — …
[9EA8E3FB] round 1423121 finalised
[9EA8E3FB] proof retrieved
[9EA8E3FB] ✅ executed
```

That first line is the verifier lagging the XRP Ledger, retried automatically —
the exact case the retry classification exists for.

## Signed on a phone, in Xaman

The motion the product is actually for: open a link, read one sentence, slide
to sign. No memo, no hash, no bridge, no FLR, no wallet switch.

| | |
|---|---|
| XRPL payment | [`AE1F4945…7C39DFEA`](https://testnet.xrpl.org/transactions/AE1F4945B2119CA9F125F43F99209407B9748B0BDF2EF3D4102F13BD7C39DFEA) <!-- public tx hash, not-a-secret --> |
| Signed by | `rDBiAgjPGzbzRpvwJETAbFjuZ4hmZrAEx` — a real Xaman account on a real iPhone |
| Shown in the app | **"Deposit 10 mFXRP into MockVault"** |
| FDC voting round | [1423151](https://coston2-systems-explorer.flare.network/voting-round/1423151?tab=fdc) |
| Flare execution | [`0xd160a19f…17ae9d52`](https://coston2-explorer.flare.network/tx/0xd160a19fd52b261aa2f31a899afde2ac84c8b80ee520a27a57f41f3317ae9d52) <!-- public tx hash, not-a-secret --> |

Verified on-chain:

```
MockVault.balanceOf(PA)      0 → 10000000     (10 mFXRP)
MockFXRP.balanceOf(PA)       1000 → 990 mFXRP
personal account nonce       0 → 1
personal account             585 bytes — deployed by this mint, empty before
MockFXRP.allowance(PA→vault) 0
```

That last line is the one that proves it. `approve(vault, 10)` set the allowance
to 10; `deposit(10)` consumed exactly that. **Both calls ran, in order,
atomically.** A vault balance alone could have come from a single call — a spent
allowance could not.

### What it took

Three attempts, two of them our bugs:

1. Rejected in the app by mistake — which incidentally proved the phone loop worked.
2. Signed by a different account than the operation was prepared for. See
   finding 7: `txjson.Account` is advisory. Cost 1.2 XRP, still at the Core
   Vault and recoverable via the `0xE0` skip-memo path.
3. Signed after restructuring to identify-first.

The second was worth having. The fix was not a flag — it was recognising that a
dApp *cannot* build a user operation before it knows who will sign, because both
the personal account and the nonce derive from the payer.

### Why this batch needs `0xFE`

The two-call batch ABI-encodes to **1024 bytes**. The inline `0xFF` variant
would need `10 + 1024 = 1034` bytes of XRPL memo against a **1024-byte cap** —
so this batch is *impossible* to express inline. With `0xFE` the memo is 42
bytes, and would still be 42 bytes for a fifty-call batch. Asserted as a test
in `packages/sdk/test/memo.test.ts`.

### What the first attempt cost

The first run failed, and the state machine earned its keep. The XRPL payment
succeeded and the verifier returned `VALID`; the failure was ours — viem's
`writeContract` was handed the account as an address string, so it asked the
public RPC to sign (`eth_sendTransaction`) and got "unknown account". The job
gave up after five attempts, as designed, with the XRP already at the Core
Vault.

Because every transition was persisted, the fix plus `scripts/resume-job.ts`
finished the same mint — same user operation bytes, same nonce, same XRPL
payment. **No second payment.** A straight-line async function would have lost
the request and needed another 1.2 XRP and another round.

## Recovering a stuck mint with `0xE0`

The signer bug (finding 7) left 1.2 XRP at the Core Vault: the memo committed to
a `userOp` whose sender was wrong for the payer, so `executeDirectMintingWithData`
reverted atomically. The payment could never complete as written — changing the
operation would break the commitment.

`0xE0` is the documented way out, and the contract states the intent directly:

```solidity
// check ignoreMemo first — before any memo validation
// allows recovery from malformed memos (length < 6, bad instruction ID,
//                                       malformed UserOp, ...)
```

`memoIgnored` short-circuits `MemoInstructions.execute`, so the failing
instruction never runs — while `_distributeFAssets` still does, so the FXRP
mints. The flag is keyed by `(personalAccount, transactionId)` and deleted on
use: it releases exactly one payment, only for the account that set it.

One signature, 0.3 XRP:

```
0xE0 payment used?  true
stuck payment used? true
FXRP balance of PA: 1.1 → 2.3   (+1.2)
```

Reconciling the delta confirms both mints landed:

| Payment | Total | Minting fee | Executor fee | To the account |
|---|---|---|---|---|
| `0xE0` recovery | 0.3 | 0.1 | 0.1 | 0.1 FXRP |
| the stuck payment | 1.2 | 0.1 | 0.0 | 1.1 FXRP |
| | | | | **1.2 FXRP** |

**Our executor did not do this.** A competing relayer finalised both — see
finding 8. The recovery mechanism is sound; the race is a separate lesson, and
a more valuable one.

## Running the FCC stack: what actually cost time

Recorded because none of it is in the guides, and all of it looked like
something else while it was happening.

1. **The Docker CLI can point at a socket that does not exist.** `docker
   --version` works (it never contacts a daemon) while every real command hangs.
   Here the default context was `desktop-linux` →
   `~/.docker/desktop/docker.sock`, with a perfectly healthy system daemon at
   `/var/run/docker.sock`. `docker context use default` was the whole fix. A
   hang reads like a wedged daemon; it was a wrong address.

2. **A TCP connect proves a listener, not the service you want.** Host port 3306
   was already held by an unrelated MySQL on the machine, so our container's
   traffic never arrived. Every check said "port open" because the connect
   succeeded — but no MySQL handshake ever came, and the indexer hung silently
   at database connect, *before its first log line*. Publishing on 3307 fixed
   it instantly. Test the protocol handshake, not the socket.

3. **`eth_getLogs` limits vary by an order of magnitude per endpoint.** The
   public Flare RPC caps at **30 blocks**; Ankr serves **1000**. The indexer's
   own example config suggests 1000–10000. Exceeding the cap does not degrade —
   the request fails, the backoff exhausts, and the indexer restarts having
   written nothing.

4. **`history_drop` has a 2-day floor**, rejected at startup below that. Setting
   `history_drop = 0` and an explicit `start_index` bypasses it, which matters
   when a 2-day backfill against a rate-limited endpoint takes hours. Coston2
   reward epochs are 21600 s and tee-proxy reaches back two of them, so a much
   shorter window is sufficient.

5. **`start_index` only applies to an empty database.** Otherwise the indexer
   resumes after the last indexed block and silently ignores it.

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
