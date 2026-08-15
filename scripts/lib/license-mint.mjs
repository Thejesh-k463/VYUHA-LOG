// The signing and ledger core shared by license-issue.mjs and
// license-upgrade.mjs. Pure functions plus two file helpers — no argv parsing,
// no process.exit, so the callers own every refusal and the tests can drive
// this against a throwaway keypair.
//
// PATHS. `defaultPemPath()` / `defaultLedgerPath()` resolve to the repo root
// (license-private.pem / license-ledger.jsonl) UNLESS the env overrides
// VYUHA_LICENSE_PEM / VYUHA_LICENSE_LEDGER are set. The overrides exist so
// tests and smoke runs never touch the real vendor key or the real ledger.
// Leave them unset in production; the scripts print which paths they used.
import { sign, createPrivateKey, createHash } from "node:crypto";
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function defaultPemPath() {
  return process.env.VYUHA_LICENSE_PEM || path.join(root, "license-private.pem");
}
export function defaultLedgerPath() {
  return process.env.VYUHA_LICENSE_LEDGER || path.join(root, "license-ledger.jsonl");
}
export function repoRoot() {
  return root;
}

/** Short, stable ID — must match lib/license.ts#licenseKeyId exactly. */
export function keyIdOf(key) {
  const hex = createHash("sha256").update(key.trim()).digest("hex").slice(0, 10).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 10)}`;
}

/**
 * Sign {email, sku, issued, expires?, machine?} with the vendor's Ed25519 key.
 * `expires` null/undefined = lifetime (the entitlement engine reads only the
 * expiry). `issued` defaults to today (YYYY-MM-DD) and is exposed for tests.
 * Returns {key, keyId, payload}; payload is the object that was signed.
 * @param {{email: string, sku: string, expires?: string|null, machine?: string|null, pemPath?: string, issued?: string}} opts
 * @returns {{key: string, keyId: string, payload: {email: string, sku: string, issued: string, expires?: string, machine?: string}}}
 */
export function mintKey({ email, sku, expires = null, machine = null, pemPath = defaultPemPath(), issued = undefined }) {
  if (!email || !email.includes("@")) throw new Error("mintKey: email required");
  if (!sku) throw new Error("mintKey: sku required");
  const privPem = readFileSync(pemPath, "utf8");
  /** @type {{email: string, sku: string, issued: string, expires?: string, machine?: string}} */
  const payload = { email, sku, issued: issued ?? new Date().toISOString().slice(0, 10) };
  if (expires) payload.expires = expires;
  if (machine) payload.machine = machine;
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(null, bytes, createPrivateKey(privPem));
  const key = `VYUHA-${bytes.toString("base64url")}.${signature.toString("base64url")}`;
  return { key, keyId: keyIdOf(key), payload };
}

/**
 * The ledger record for one minted key. Shape is frozen — license-list.mjs
 * and license-upgrade.mjs read it — so add fields, never rename them.
 * `note` is the payment reference (UTR) or the reason there is none.
 * @param {{keyId: string, email: string, sku: string, issued: string, expires?: string|null, machine?: string|null, key: string, note?: string|null}} r
 */
export function ledgerLine({ keyId, email, sku, issued, expires = null, machine = null, key, note = null }) {
  return {
    keyId,
    email,
    sku,
    issued,
    expires: expires ?? null,
    machine: machine ?? null,
    key,
    note: note ?? null,
  };
}

/** Append one ledger record as a JSON line. Creates the file if missing. */
export function appendLedger(ledgerPath, line) {
  appendFileSync(ledgerPath, JSON.stringify(line) + "\n");
}

/** Every ledger record, oldest first. A missing ledger reads as empty. */
export function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** `<keyId>_<email with @ and dots as _>.txt` — the archive filename for a key. */
export function archiveFileName(keyId, email) {
  return `${keyId}_${email.replace(/[@.]/g, "_")}.txt`;
}

/**
 * Archive one minted key into `dir` (--save-dir / VYUHA_KEY_ARCHIVE_DIR):
 * writes archiveFileName(...) with archiveFileBody(...) — REFUSING to overwrite
 * an existing file, because a second key with the same id and email is not a
 * thing that happens by accident — and copies the ledger beside it as
 * `license-ledger.<YYYY-MM-DD>.jsonl` (the same-day snapshot is overwritten;
 * it is the newer state of the same file). Returns the two paths.
 * @param {{dir: string, record: ReturnType<typeof ledgerLine>, ledgerPath?: string, today?: Date}} opts
 */
export function archiveKey({ dir, record, ledgerPath = defaultLedgerPath(), today = new Date() }) {
  mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, archiveFileName(record.keyId, record.email));
  if (existsSync(keyFile)) throw new Error(`Refusing to overwrite existing key archive ${keyFile}`);
  writeFileSync(keyFile, archiveFileBody(record), { flag: "wx" });
  const snapshot = path.join(dir, `license-ledger.${today.toISOString().slice(0, 10)}.jsonl`);
  if (existsSync(ledgerPath)) copyFileSync(ledgerPath, snapshot);
  return { keyFile, snapshot };
}

/**
 * Body of the archive file: the key alone on line 1, then human-readable facts.
 * @param {ReturnType<typeof ledgerLine>} r
 */
export function archiveFileBody({ key, keyId, email, sku, issued, expires = null, machine = null, note = null }) {
  return [
    key,
    `key id : ${keyId}`,
    `plan   : ${expires ? `Pro — Annual, expires ${expires}` : "Journal — Lifetime"} (sku ${sku})`,
    `buyer  : ${email}`,
    `issued : ${issued}`,
    `expires: ${expires ?? "never (lifetime)"}`,
    `machine: ${machine ?? "unbound"}`,
    `note   : ${note ?? "—"}`,
    "",
  ].join("\n");
}
