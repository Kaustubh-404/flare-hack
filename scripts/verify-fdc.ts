/**
 * Live, read-only check of the FDC verifier leg.
 *
 *   npx tsx scripts/verify-fdc.ts <xrplTxHash>
 *
 * Broadcasts nothing and spends nothing — it only asks the verifier to encode
 * an attestation request for a real XRPL transaction. If this passes, the
 * slowest and most failure-prone part of the executor is known-good before
 * Gate 1 costs any XRP.
 */

import { toHex } from "viem";
import {
  ATTESTATION_TYPE_XRP_PAYMENT,
  VERIFIER_API_KEY_PLACEHOLDER,
  VERIFIER_BASE_TESTNET,
  XRP_SOURCE_ID_TESTNET,
} from "../packages/executor/src/fdc.js";
import { normalizeXrplTxId } from "../packages/executor/src/pipeline.js";

const hash = process.argv[2];
if (!hash) {
  console.error("usage: npx tsx scripts/verify-fdc.ts <xrplTxHash>");
  process.exit(1);
}

const txId = normalizeXrplTxId(hash);
console.log(`\nXRPL transaction : ${txId}`);
console.log(`attestation type : ${ATTESTATION_TYPE_XRP_PAYMENT} (0x08 — not the legacy Payment)`);
console.log(`source id        : ${XRP_SOURCE_ID_TESTNET}`);
console.log(`verifier         : ${VERIFIER_BASE_TESTNET}\n`);

const res = await fetch(
  `${VERIFIER_BASE_TESTNET}/verifier/xrp/${ATTESTATION_TYPE_XRP_PAYMENT}/prepareRequest`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": VERIFIER_API_KEY_PLACEHOLDER,
    },
    body: JSON.stringify({
      attestationType: toHex(ATTESTATION_TYPE_XRP_PAYMENT, { size: 32 }),
      sourceId: toHex(XRP_SOURCE_ID_TESTNET, { size: 32 }),
      requestBody: {
        transactionId: txId,
        // Zero = proof usable by anyone. The executor binds it to itself.
        proofOwner: "0x0000000000000000000000000000000000000000",
      },
    }),
  },
);

const text = await res.text();
const parsed = JSON.parse(text) as {
  status?: string;
  abiEncodedRequest?: string;
  errorMessage?: string;
};

console.log(`HTTP ${res.status}`);
console.log(`status: ${parsed.status ?? "(none)"}`);

const ok =
  res.status === 200 &&
  typeof parsed.abiEncodedRequest === "string" &&
  parsed.abiEncodedRequest.length > 2;

if (ok) {
  console.log(`abiEncodedRequest: ${parsed.abiEncodedRequest!.slice(0, 66)}…`);
  console.log(`                   (${(parsed.abiEncodedRequest!.length - 2) / 2} bytes)`);
  console.log("\n✅ verifier accepted a real XRPL transaction with the placeholder API key");
  console.log("   the FDC leg needs no credential from anyone\n");
} else {
  console.log(`body: ${text.slice(0, 400)}`);
  console.log("\n❌ verifier did not return an encoded request\n");
}

process.exit(ok ? 0 : 1);
