# ONESIG

**One signature from an XRP wallet. Any Flare dApp.**

An XRP holder signs a single, ordinary XRPL payment — and a batch of contract calls
executes on Flare. No bridge, no second wallet, no FLR for gas, full self-custody.

> **Status: hackathon software.** Coston2 and XRPL testnet, test tokens only.
> Nothing here has touched real value. See [Limits](#limits) before trusting any of it.

| | |
|---|---|
| Live demo | `http://localhost:8787` after [local setup](#run-it-locally) |
| Pitch deck | [`docs/pitch-deck.html`](docs/pitch-deck.html) — six slides, arrow keys to advance |
| What changed, and why | [`docs/WHATS-NEW.md`](docs/WHATS-NEW.md) |
| Tests | 54 passing — 44 under `npm test`, plus 10 contract tests under `forge test` |

---

## The problem

Flare Smart Accounts already lets an XRPL payment drive contract calls on Flare. It
works today, on mainnet, in Xaman. So why can't an XRP holder use a Flare dApp?

Because using it means becoming a different kind of user first:

| | |
|---|---|
| **A second wallet** | An EVM wallet, installed and funded, before anything can be signed |
| **A gas token** | FLR acquired from somewhere, held only to pay for transacting |
| **A bridge** | Assets moved across, with the custody and timing risk that implies |
| **A new signing model** | EVM transactions to read and approve, in a format XRPL users have never seen |

Each is small. Together they are a wall between the largest retail holder base in
crypto and every application Flare has. **The user already has a wallet — it is
simply the wrong one.**

There is a second, subtler gap. The `0xFE` custom instruction is a general escape
hatch, but using it means hand-encoding 42-byte memos, assembling EIP-4337 user
operations, and running an always-on executor. Almost nobody will. **ONESIG is the
packaging that makes those primitives reachable from an ordinary dApp.**

---

## The idea: put the intent in 42 bytes

An XRPL payment can carry a memo, and a memo is small. A real operation — targets,
calldata, values, nonce, gas — is not. The demo batch encodes to **1024 bytes**.

So the ledger carries only a commitment, and the operation travels off-ledger:

```
[0xFE][walletId:1][executorFeeUBA:8][userOpHash:32]  =  42 bytes
```

| Field | Bytes | Meaning |
|---|---|---|
| `0xFE` | 1 | Opcode — committed execute |
| `walletId` | 1 | Which personal account acts |
| `executorFeeUBA` | 8 | What the executor is paid, `uint64` |
| `userOpHash` | 32 | `keccak256` of the operation — the commitment |

**The ledger carries one byte in twenty-four.**

The commitment is what makes this safe rather than merely compact. An executor that
submits anything other than the exact committed bytes produces a different hash, and
the contract rejects it. **The executor is paid to relay, never trusted to choose.**

---

## How it works

1. **A dApp describes what it wants** — ordinary EVM calls. It never learns XRPL is involved.
2. **The SDK assembles and commits** — calls become a `PackedUserOperation`; its hash goes into the memo.
3. **The user signs one payment** — in Xaman it looks like any payment: an amount and a destination.
4. **FAssets mints and dispatches** — direct minting turns the payment into FXRP *and* forwards the instruction.
5. **The Data Connector proves it** — an `XRPPayment` attestation finalises in a voting round; a Merkle proof is fetched.
6. **The operation executes** — `PersonalAccount.executeUserOp` checks the hash and runs the batch.

Step 5 is the load-bearing one. **Nobody has to trust the relay.** Flare verifies the
XRPL payment through its own oracle, and the commitment binds the relay to the exact
operation the user approved.

---

## Using the SDK

```ts
import { OneSigClient } from "@onesig/sdk";
import { encodeFunctionData } from "viem";

const onesig = new OneSigClient();

const req = await onesig.prepare({
  // The XRPL account that will sign. Its personal account on Flare is derived
  // from this address — it does not need to exist yet.
  xrplAddress: "rHfJXz...",

  // Runs in order; any revert unwinds the whole batch.
  calls: [
    { target: fxrp,  value: 0n, data: encodeFunctionData({ abi, functionName: "approve", args: [vault, amount] }) },
    { target: vault, value: 0n, data: encodeFunctionData({ abi, functionName: "deposit", args: [amount] }) },
  ],

  // Shown in the wallet instead of a bare hash.
  label: "Deposit 10 mFXRP into MockVault",

  // FXRP the user should END UP WITH, in drops. Minting and executor fees are
  // read from the AssetManager and added on top.
  netMintUBA: 1_000_000n,
});

// req.xrplPayment is signable as-is. The user never sees a memo.
```

> ### ⚠️ Read this before calling `prepare()`
>
> **Never guess `netMintUBA`.** It is the amount the user should receive, *net of
> fees* — the SDK reads the minting and executor fees from the AssetManager and adds
> them. A payment that fails to cover the minting fee **mints nothing, and the whole
> amount goes to the fee receiver, irreversibly.** There is no recovery path.

`prepare()` returns everything needed to drive the flow:

| Field | What it is |
|---|---|
| `xrplPayment` | The signable payment — hand it to Xaman |
| `memoHex` | The 42 bytes the ledger will carry |
| `userOpData` | The operation the executor delivers off-chain. Never published on XRPL |
| `userOpHash` | The commitment |
| `personalAccount` | Deterministic Flare address for this XRPL account |
| `calls` | Decoded, labelled calls — for showing the user what they are approving |

**Not yet published to npm.** The package is `private` and its entry point is
TypeScript source, so today it works inside this repo only. See [What it would take
to publish](#what-it-would-take-to-publish).

---

## Run it locally

Everything below has been run from a clean clone. Total time is about ten minutes,
most of it waiting on faucets.

### 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| **Node** | 20 or newer | The launch command uses `--env-file`, which needs Node 20+ |
| **Foundry** | any recent | Only if you want to compile or redeploy contracts |
| **A phone with [Xaman](https://xaman.app)** | — | To sign the XRPL payment. The demo shows a QR code |

```bash
node --version    # v20+
forge --version   # optional
```

Foundry, if you need it:

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

### 2. Clone and install

```bash
git clone git@github.com:Kaustubh-404/flare-hack.git
cd flare-hack
npm install          # npm workspaces — installs all packages
```

### 3. Create your environment file

```bash
cp .env.example .env    # .env is gitignored
```

Now fill it in. Each value and where it comes from:

**Flare side**

```bash
CHAIN_URL=https://coston2-api.flare.network/ext/C/rpc   # already set
CHAIN_ID=114                                            # already set
DEPLOYER_PRIVATE_KEY=    # 64 hex chars, NO 0x prefix
INITIAL_OWNER=           # the 0x address derived from that key
```

Generate a fresh key — never reuse one that has touched mainnet:

```bash
cast wallet new
# Address:     0x....   → INITIAL_OWNER
# Private key: 0x....   → DEPLOYER_PRIVATE_KEY (strip the 0x)
```

Fund it at the **[Coston2 faucet](https://faucet.flare.network/coston2)**. The
executor pays gas for every execution — a few C2FLR covers many runs.

**XRPL side**

```bash
XRPL_RPC_URL=https://s.altnet.rippletest.net:51234   # already set
XRPL_SEED=      # family seed, starts with s
XRPL_ADDRESS=   # the r... address for that seed
```

Get a funded testnet account from the
**[XRPL faucet](https://xrpl.org/resources/dev-tools/xrp-faucets)** — it hands you
both values. Each demo run costs 1.2 XRP, so the default 100 XRP is ample.

**Xaman (for the QR sign-in)**

```bash
XAMAN_API_KEY=
XAMAN_API_SECRET=
```

Free from **[apps.xumm.dev](https://apps.xumm.dev)** — sign in with GitHub and create
an application. **The secret is shown once.** It is backend-only; it must never reach
a browser.

**Contract addresses**

Already deployed on Coston2 — copy these in as-is:

```bash
COUNTER_ADDRESS=0x1612b980Ddb6c13c01039A712634035Cfb2367E8
MOCK_VAULT_ADDRESS=0x64b89db12C2D91410011ce1Fcb626C87620Db444
INSTRUCTION_REGISTRY_ADDRESS=0x06cC2210f97387C0d1e03DD2ef6E80a02a244E10
```

### 4. Check it before running anything

```bash
npm test                      # 44 passing, no network needed
./scripts/check-secrets.sh    # confirms .env is gitignored and no key is tracked
```

### 5. Start the executor

```bash
npx tsx --env-file=.env scripts/run-executor.ts
```

`--env-file` matters: **nothing loads `.env` automatically.** Without it you get
`DEPLOYER_PRIVATE_KEY not set` immediately.

You should see:

```
executor account : 0x08Db...
asset manager    : 0xc1Ca...
core vault       : rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p
executor listening on :8787
watching the Core Vault from ledger 19906778

  demo → http://localhost:8787
```

The executor does three jobs at once: it watches XRPL for payments to the Core Vault,
drives the FDC attestation pipeline, and serves the demo page.

### 6. Open the demo

Go to **`http://localhost:8787`** and:

1. Click **Sign in with Xaman**, scan the QR — this is free, not a ledger transaction
2. The page fills in the real 42-byte memo and seals the 1024-byte operation
3. Scan the second QR to sign the actual payment — **1.2 XRP**
4. Watch the pipeline: observed → attestation prepared → submitted → **round finalised** → proof → executed
5. Three explorer links fill in as each step is earned

**Step 4 includes a 3–5 minute wait** while the FDC voting round finalises. That is
the protocol, not a hang — the step list shows where it is the whole time.

### Optional: redeploy the contracts

Only if you want your own instances:

```bash
cd packages/contracts
forge test                                                  # 10 passing
forge script script/Deploy.s.sol --rpc-url $CHAIN_URL --broadcast
```

Then update the three addresses in `.env`.

### When it goes wrong

| Symptom | Cause |
|---|---|
| `DEPLOYER_PRIVATE_KEY not set` | Missing `--env-file=.env` on the command |
| `Xaman is not configured` | `XAMAN_API_KEY` / `XAMAN_API_SECRET` empty |
| QR expired | Xaman payloads live 10 minutes. Reload and start again — it costs nothing |
| `watcher error (will retry)` | Transient XRPL RPC failure. It retries; ignore unless it repeats |
| Pipeline stuck on *round finalised* | Normal for 3–5 minutes |
| Execution reverts, out of gas | Top up the deployer at the Coston2 faucet |
| Vault balance does not start at 0 | Expected after previous runs — the vault keeps its history |

---

## Repo layout

```
packages/sdk/         memo encoding, user operations, network config
packages/executor/    XRPL watcher → FDC proof → execution, and the demo page
packages/contracts/   Foundry — Counter, MockFXRP, MockVault, InstructionRegistry
packages/web/         reserved; currently empty
scripts/              run-executor, demos, deploy helpers, the secret audit
docs/                 pitch deck, and the record of what was found
extension/            LATCH — see below, not part of this submission
```

### Memo opcodes

Transcribed from `flare-smart-accounts/contracts/smartAccounts/library/MemoInstructions.sol`,
not from documentation. Every encoder asserts the exact byte length the contract's
`require()` enforces, so a malformed memo fails locally rather than after an XRPL
payment is signed and a nonce burned.

| Opcode | Bytes | Meaning |
|---|---|---|
| `0xFF` | 10 + N | Execute, user operation inline (bounded by XRPL's 1024-byte memo cap) |
| `0xFE` | 42 | Execute, commitment only — constant size, payload private on XRPL |
| `0xE0` | 42 | Ignore a stuck memo |
| `0xE1` | 42 | Fast-forward the nonce |
| `0xE2` | 50 | Bump a stuck executor fee |
| `0xD0` | 30 | Pin an executor |
| `0xD1` | 10 | Unpin |

**`0xE0`–`0xE2` and `0xD0`/`0xD1` are absent from the developer documentation.**

---

## Verified on Coston2

Every address resolved live from `FlareContractRegistry`
(`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`), never copied from docs.

| | |
|---|---|
| MasterAccountController | `0x434936d47503353f06750Db1A444DBDC5F0AD37c` |
| AssetManagerFXRP | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` |
| FtsoV2 | `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` |
| FdcHub | `0x48aC463d7975828989331F4De43341627b9c5f1D` |
| Operator XRPL address | `rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq` |

Ours:

| | |
|---|---|
| Counter | `0x1612b980Ddb6c13c01039A712634035Cfb2367E8` |
| MockFXRP | `0xA2c647c06a3014842e22a3f5C6F390A8d74a52ED` |
| MockVault | `0x64b89db12C2D91410011ce1Fcb626C87620Db444` |
| InstructionRegistry | `0x06cC2210f97387C0d1e03DD2ef6E80a02a244E10` |

### Proven end to end

One XRPL payment, signed once, executed a call on Flare from a personal account that
did not exist when the payment was signed.

| Stage | Evidence |
|---|---|
| XRPL payment | [`72641C74…4A2BF14E`](https://testnet.xrpl.org/transactions/72641C7489F785DE2F5BF5A166522431E8888793446AC2E143AB46094A2BF14E) — 1.2 XRP to the Core Vault <!-- public tx hash, not-a-secret --> |
| FDC voting round | [1423089](https://coston2-systems-explorer.flare.network/voting-round/1423089?tab=fdc) |
| Flare execution | [`0xc4b609f7…8cea9a35`](https://coston2-explorer.flare.network/tx/0xc4b609f7dc57bb2bb8b8e52519cc34f72be753f97521e5dd9d4fa6688cea9a35) — `Counter.count()` 0 → 1 |
| Batch execution | [`0x9c80b629…436a8b`](https://coston2-explorer.flare.network/tx/0x9c80b62922bb340c59d7a35a17a5614f0e7b5cf84b8280b3f6c2e7b73e436a8b) — `approve` + `deposit`, block 34051314 |

---

## Tests

```bash
npm test                                    # 44 — SDK 20, executor 24
cd packages/contracts && forge test         # 10 — needs Foundry
```

54 in total. No network access is required for any of them.

The three live tests under `extension/typescript` are skipped unless `LIVE=1`; they
read a real FTSO price from Coston2 and belong to LATCH, not ONESIG.

---

## Limits

Stated here rather than discovered later.

- **Testnet only.** Coston2 and XRPL testnet, test tokens. Nothing has touched real value.
- **`MockFXRP` and `MockVault` are demo targets**, not production contracts. The FAssets and Data Connector paths are real.
- **The executor is a single instance you run.** Making it a competitive market of relays is the obvious next step, and it is not built. Today, if your executor is down, nothing executes.
- **The SDK is not published.** See below.
- **Coston2 is the only configured network.** The architecture is not testnet-specific — contracts resolve from the registry and `rpcUrl` is overridable — but only Coston2 has been tested.

### What it would take to publish

The SDK is `private: true` with `main` pointing at TypeScript source, so it works
inside this repo only. To make it installable:

1. Add a build (`tsup` gives ESM + CJS + `.d.ts` in one step) and point `exports` at `dist/`
2. Drop `private`, add `files`, `license`, `repository`, `description`
3. Move `viem` to `peerDependencies` so consumers do not end up with two copies
4. Ship a package README carrying the `netMintUBA` warning above

None of that solves the real adoption question, which is **who runs the executor**.

---

## Security

**Never commit a key.** `.env` is gitignored and `./scripts/check-secrets.sh` runs
before every push — it scans tracked content and git history, and refuses the push if
anything looks like a key.

Flare's own `fce-sign` repo ships a live testnet private key in a committed
`.env.coston2`, and the extension scaffold's `.env.example` carries another. **If you
fork either, replace them** — everyone who has cloned those repos has those keys.

---

## Also in this repo: LATCH

`extension/` holds **LATCH**, a Flare Compute Extension that holds an intent inside a
TEE until a live FTSO price triggers it — so a conditional order has no mempool entry
and no on-chain state to front-run while it waits.

It is **registered on Coston2** (`InstructionSender`
`0x185280D93027E413C3d4f256FF294033F50a2b86`, extension ID `0x10280`) and has 59
passing tests, but **it is not part of this submission and not in the demo.** Its TEE
attestation runs in simulated mode — the machine is not a Confidential Space VM.

---

## Networks

Coston2 (chain 114) and XRPL testnet. Test tokens only.

- [Coston2 faucet](https://faucet.flare.network/coston2)
- [XRPL testnet faucet](https://xrpl.org/resources/dev-tools/xrp-faucets)

## License

MIT
