/**
 * Minisign verification, with no dependencies — Node's own crypto does all of it.
 *
 * ── Why this exists separately from key-id decoding ───────────────────────
 *
 * Decoding a signature's key id proves it was MADE by the right key. It does not
 * prove the signature VERIFIES over the bytes a user will download. Those are
 * different claims, and the gap between them is exactly where v2.98.0 fell: the
 * build reported "signed", every key id was plausible, and every installed copy
 * rejected the update anyway.
 *
 * These helpers close that gap. They are in their own module so they can be
 * unit-tested against a keypair generated inside the test — the verification
 * logic is the part that must not be wrong, and it cannot be exercised by
 * running the release script.
 *
 * ── The trap, stated once so nobody re-learns it ──────────────────────────
 *
 * minisign's two-byte algorithm code is easy to invert:
 *
 *     "Ed"  PureEdDSA  — Ed25519 over the file bytes
 *     "ED"  HashEdDSA  — Ed25519 over a BLAKE2b-512 prehash of the file
 *
 * Tauri emits "ED". Reading it as "Ed" makes a perfectly good release report
 * SIGNATURE DOES NOT VERIFY, which is the most expensive possible false alarm
 * on release day — it invites deleting and re-cutting a release that was fine.
 * `tests/minisign-verify.test.ts` pins both directions.
 *
 * ── Blob layouts ──────────────────────────────────────────────────────────
 *
 *   public key : [ alg(2) | key id(8, little-endian) | ed25519 public key(32) ]
 *   signature  : [ alg(2) | key id(8, little-endian) | ed25519 signature(64) ]
 *
 * Both arrive base64-encoded inside a two-line file (line 0 is an untrusted
 * comment), and that whole file is itself base64-encoded in tauri.conf.json and
 * in the .sig assets.
 */

import crypto from "node:crypto";

/** DER SPKI prefix for an Ed25519 public key — lets node import 32 raw bytes. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The blob out of a base64-wrapped, two-line minisign file. */
function innerBlob(base64File) {
  const text = Buffer.from(String(base64File).trim(), "base64").toString("utf8");
  const line = text.split("\n").find((l) => l && !l.startsWith("untrusted"));
  if (!line) throw new Error("minisign file carries no blob line");
  return Buffer.from(line.trim(), "base64");
}

export const pubBlobOf = innerBlob;
export const sigBlobOf = innerBlob;

/** Key id as minisign prints it — the stored bytes are little-endian. */
export function keyIdOfBlob(blob) {
  return Buffer.from(blob.subarray(2, 10)).reverse().toString("hex").toUpperCase();
}

/**
 * Verify `bytes` against a minisign signature blob under a public key blob.
 *
 * Returns { ok, reason, prehashed, keyId } rather than throwing, because the
 * caller reports on every asset before deciding the release's fate — one bad
 * signature should not hide the state of the others.
 */
export function verifyMinisign(pubBlob, sigBlob, bytes) {
  const keyId = keyIdOfBlob(sigBlob);
  if (keyIdOfBlob(pubBlob) !== keyId) {
    return { ok: false, reason: "key id does not match the app's pubkey", keyId, prehashed: null };
  }

  const alg = sigBlob.subarray(0, 2).toString("latin1");
  if (alg !== "ED" && alg !== "Ed") {
    return { ok: false, reason: `unknown signature algorithm ${JSON.stringify(alg)}`, keyId, prehashed: null };
  }
  const prehashed = alg === "ED";
  const signed = prehashed ? crypto.createHash("blake2b512").update(bytes).digest() : bytes;

  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, pubBlob.subarray(10, 42)]),
    format: "der",
    type: "spki",
  });

  const ok = crypto.verify(null, signed, key, sigBlob.subarray(10, 74));
  return { ok, reason: ok ? null : "signature does not verify over these bytes", keyId, prehashed };
}
