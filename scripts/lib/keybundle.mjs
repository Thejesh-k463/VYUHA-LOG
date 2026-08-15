// Encrypted bundle of the vendor's two irreplaceable files — pure encrypt /
// decrypt, no argv, no prompts, so tests can round-trip it against temp files.
//
// Format (.vkb): a small JSON header, a newline, then the AES-256-GCM
// ciphertext of a JSON body {files:[{name, data(base64)}]}.
//   header = {v:1, kdf:"scrypt", N, r, p, salt, iv, tag, files:[{name,size}]}
// The header is also the GCM additional-authenticated-data, so a tampered
// header (say a swapped file list) fails the tag check rather than decrypting.
//
// scrypt N = 2^15 (r=8, p=1), NOT lib/backup-format's 2^17: that setting
// protects a whole trade database against offline guessing of a passphrase a
// user may have chosen weakly. This bundle protects two files the OWNER
// encrypts with a passphrase they choose deliberately, and it is created on
// every sales day — 2^15 (~32 MB, ~0.1 s) keeps the habit cheap enough to keep,
// while still costing an attacker ~30k× a bare hash per guess.
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";

export const KEYBUNDLE_SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const KEY_LEN = 32;
const MAGIC = "vyuha-keybundle";

function deriveKey(passphrase, salt, params) {
  return scryptSync(passphrase, salt, KEY_LEN, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * params.N * params.r * 2,
  });
}

/**
 * files: [{name, data: Buffer}] → Buffer of the .vkb bundle.
 * The passphrase must be non-empty; the caller decides how it is obtained.
 */
export function encryptBundle(files, passphrase, params = KEYBUNDLE_SCRYPT) {
  if (typeof passphrase !== "string" || passphrase.length === 0) throw new Error("passphrase required");
  if (!Array.isArray(files) || files.length === 0) throw new Error("no files to bundle");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, params);
  const body = Buffer.from(
    JSON.stringify({ files: files.map((f) => ({ name: f.name, data: Buffer.from(f.data).toString("base64") })) }),
    "utf8",
  );
  const headerNoTag = {
    magic: MAGIC,
    v: 1,
    kdf: "scrypt",
    N: params.N,
    r: params.r,
    p: params.p,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    files: files.map((f) => ({ name: f.name, size: Buffer.from(f.data).length })),
  };
  const aad = Buffer.from(JSON.stringify(headerNoTag), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = { ...headerNoTag, tag: tag.toString("base64") };
  return Buffer.concat([Buffer.from(JSON.stringify(header) + "\n", "utf8"), enc]);
}

/** Header only — what a bundle claims to hold, without needing the passphrase. */
export function readBundleHeader(buf) {
  const nl = buf.indexOf(0x0a);
  if (nl < 0) throw new Error("not a .vkb bundle (no header line)");
  let header;
  try { header = JSON.parse(buf.subarray(0, nl).toString("utf8")); } catch { throw new Error("not a .vkb bundle (header is not JSON)"); }
  if (header.magic !== MAGIC || header.v !== 1 || header.kdf !== "scrypt") throw new Error("not a v1 vyuha key bundle");
  return { header, bodyOffset: nl + 1 };
}

/** Buffer of a .vkb → [{name, data: Buffer}]. Wrong passphrase or tampering throws. */
export function decryptBundle(buf, passphrase) {
  if (typeof passphrase !== "string" || passphrase.length === 0) throw new Error("passphrase required");
  const { header, bodyOffset } = readBundleHeader(buf);
  const { tag, ...headerNoTag } = header;
  const key = deriveKey(passphrase, Buffer.from(header.salt, "base64"), { N: header.N, r: header.r, p: header.p });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.iv, "base64"));
  decipher.setAAD(Buffer.from(JSON.stringify(headerNoTag), "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  let plain;
  try {
    plain = Buffer.concat([decipher.update(buf.subarray(bodyOffset)), decipher.final()]);
  } catch {
    throw new Error("decryption failed — wrong passphrase or the bundle was altered");
  }
  const body = JSON.parse(plain.toString("utf8"));
  return body.files.map((f) => ({ name: f.name, data: Buffer.from(f.data, "base64") }));
}
