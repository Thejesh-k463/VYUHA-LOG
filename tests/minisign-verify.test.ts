import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
// Plain .mjs helper, shared with scripts/verify-release-signatures.mjs.
import { verifyMinisign, sigBlobOf, pubBlobOf, keyIdOfBlob } from "../scripts/minisign-verify.mjs";

/**
 * The release script's key-id check proves a signature was MADE by the right
 * key. --deep proves it VERIFIES over the published bytes. That second claim is
 * the one v2.98.0 failed, so the code making it has to be tested — and it cannot
 * be tested by running the release script, which needs a live release.
 *
 * So: generate a real Ed25519 keypair here, build blobs in minisign's layout,
 * and exercise the verifier against them.
 */

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const KEY_ID = Buffer.from("0123456789abcdef", "hex"); // 8 bytes, stored little-endian

function makeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(ED25519_SPKI_PREFIX.length);
  return { publicKey, privateKey, raw };
}

/** Wrap a blob the way a .sig / pubkey file does: two lines, then base64 again. */
function wrap(blob: Buffer): string {
  const file = `untrusted comment: test\n${blob.toString("base64")}\n`;
  return Buffer.from(file, "utf8").toString("base64");
}

function pubFile(raw: Buffer, keyId = KEY_ID): string {
  return wrap(Buffer.concat([Buffer.from("Ed", "latin1"), keyId, raw]));
}

function sigFile(privateKey: crypto.KeyObject, payload: Buffer, alg: "ED" | "Ed", keyId = KEY_ID): string {
  const signed = alg === "ED" ? crypto.createHash("blake2b512").update(payload).digest() : payload;
  const sig = crypto.sign(null, signed, privateKey);
  return wrap(Buffer.concat([Buffer.from(alg, "latin1"), keyId, sig]));
}

describe("verifyMinisign", () => {
  const payload = Buffer.from("pretend this is a 35 MB installer");

  it("verifies a prehashed (ED) signature — the format Tauri actually emits", () => {
    const { privateKey, raw } = makeKeypair();
    const r = verifyMinisign(pubBlobOf(pubFile(raw)), sigBlobOf(sigFile(privateKey, payload, "ED")), payload);
    expect(r.ok).toBe(true);
    expect(r.prehashed).toBe(true);
  });

  it("verifies a pure (Ed) signature too", () => {
    const { privateKey, raw } = makeKeypair();
    const r = verifyMinisign(pubBlobOf(pubFile(raw)), sigBlobOf(sigFile(privateKey, payload, "Ed")), payload);
    expect(r.ok).toBe(true);
    expect(r.prehashed).toBe(false);
  });

  // THE TRAP. Reading "ED" as pure (or "Ed" as prehashed) makes a good release
  // report as broken — the most expensive false alarm available on release day.
  // These two pin that the algorithm byte actually selects the mode.
  it("an ED signature does NOT verify if treated as pure", () => {
    const { privateKey, raw } = makeKeypair();
    // Sign prehashed, then relabel the blob as pure: verification must fail.
    const blob = sigBlobOf(sigFile(privateKey, payload, "ED"));
    blob.write("Ed", 0, "latin1");
    expect(verifyMinisign(pubBlobOf(pubFile(raw)), blob, payload).ok).toBe(false);
  });

  it("an Ed signature does NOT verify if treated as prehashed", () => {
    const { privateKey, raw } = makeKeypair();
    const blob = sigBlobOf(sigFile(privateKey, payload, "Ed"));
    blob.write("ED", 0, "latin1");
    expect(verifyMinisign(pubBlobOf(pubFile(raw)), blob, payload).ok).toBe(false);
  });

  it("fails when the bytes are tampered with — one flipped byte is enough", () => {
    const { privateKey, raw } = makeKeypair();
    const sig = sigBlobOf(sigFile(privateKey, payload, "ED"));
    const tampered = Buffer.from(payload);
    tampered[0] ^= 0x01;
    const r = verifyMinisign(pubBlobOf(pubFile(raw)), sig, tampered);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not verify/);
  });

  it("fails when signed by a DIFFERENT key carrying the same key id", () => {
    // The nightmare case the key-id check alone cannot see: right id, wrong key.
    const a = makeKeypair();
    const b = makeKeypair();
    const r = verifyMinisign(pubBlobOf(pubFile(a.raw)), sigBlobOf(sigFile(b.privateKey, payload, "ED")), payload);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not verify/);
  });

  it("reports a key-id mismatch distinctly from a bad signature", () => {
    const { privateKey, raw } = makeKeypair();
    const other = Buffer.from("fedcba9876543210", "hex");
    const r = verifyMinisign(pubBlobOf(pubFile(raw)), sigBlobOf(sigFile(privateKey, payload, "ED", other)), payload);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/key id/);
  });

  it("rejects an unknown algorithm rather than guessing", () => {
    const { privateKey, raw } = makeKeypair();
    const blob = sigBlobOf(sigFile(privateKey, payload, "ED"));
    blob.write("XX", 0, "latin1");
    const r = verifyMinisign(pubBlobOf(pubFile(raw)), blob, payload);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown signature algorithm/);
  });

  it("prints key ids little-endian, the way minisign does", () => {
    const { raw } = makeKeypair();
    // Stored 0123456789abcdef → displayed reversed.
    expect(keyIdOfBlob(pubBlobOf(pubFile(raw)))).toBe("EFCDAB8967452301");
  });
});
