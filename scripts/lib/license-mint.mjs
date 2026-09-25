// The signing and ledger core shared by license-issue.mjs and
// license-upgrade.mjs. Pure functions plus two file helpers — no argv parsing,
// no process.exit, so the callers own every refusal and the tests can drive
// this against a throwaway keypair.
//
// PATHS. `defaultPemPath()` / `defaultLedgerPath()` resolve to the repo root
// (license-private.pem / license-ledger.jsonl) UNLESS the env overrides
// VYUHA_LICENSE_PEM / VYUHA_LICENSE_LEDGER are set. Since 2026-09-22 the REAL
// key and ledger live outside the repo (T:\Thejesh\vyuha-secrets\) and the
// owner's User-level env vars point there; tests set their own throwaway
// overrides per process. The scripts print which paths they used.
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

/**
 * `YYYY-MM-DD` + N calendar months, for the monthly plan (owner ruling
 * 2026-09-18) — pure, so the month-end rule is pinned by a test rather than
 * discovered on a sale.
 *
 * ROLL FORWARD, never clamp: 2026-01-31 + 1 month is 2026-03-03, because there
 * is no 31 February. That is JavaScript's own Date arithmetic and the same
 * style `--years` already uses (29 Feb + 1 year → 1 March), and it errs in the
 * BUYER's favour — a month they paid for is never cut to 28 days. UTC
 * throughout, so the result never shifts with the machine's timezone.
 */
export function addMonths(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`addMonths: bad date "${iso}"`);
  if (!Number.isInteger(n) || n < 1) throw new Error(`addMonths: months must be a whole number >= 1, got "${n}"`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
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
 * A creator's referral code as the ledger stores it (v4.6.0 W6): trimmed and
 * upper-cased; blank or `NONE` (any case) means no referrer → null. One code
 * per CREATOR — the same string docs/owner/forms/referral-form.gs hands out.
 * It lives in the ledger only, never in the signed key: the app never sees it.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normaliseRef(raw) {
  if (raw == null) return null;
  const code = String(raw).trim().toUpperCase();
  return code === "" || code === "NONE" ? null : code;
}

/**
 * The ledger record for one minted key. Shape is frozen — license-list.mjs
 * and license-upgrade.mjs read it — so add fields, never rename them.
 * `note` is the payment reference (UTR) or the reason there is none.
 * `ref` (added v4.6.0 W6, AFTER note) is the referring creator's code or null;
 * lines written before it existed have no `ref` and readLedger reads them as null.
 * @param {{keyId: string, email: string, sku: string, issued: string, expires?: string|null, machine?: string|null, key: string, note?: string|null, ref?: string|null}} r
 */
export function ledgerLine({ keyId, email, sku, issued, expires = null, machine = null, key, note = null, ref = null }) {
  return {
    keyId,
    email,
    sku,
    issued,
    expires: expires ?? null,
    machine: machine ?? null,
    key,
    note: note ?? null,
    ref: normaliseRef(ref),
  };
}

/** Append one ledger record as a JSON line. Creates the file if missing. */
export function appendLedger(ledgerPath, line) {
  appendFileSync(ledgerPath, JSON.stringify(line) + "\n");
}

/**
 * Every ledger record, oldest first. A missing ledger reads as empty. A line
 * written before `ref` existed reads with `ref: null` — the JSONL is
 * append-only, so old lines are tolerated here and never rewritten.
 */
export function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => withRef(JSON.parse(l)));
}

/** A parsed ledger record with `ref` present (null when the line predates it). */
export function withRef(r) {
  return r && typeof r === "object" && !("ref" in r) ? { ...r, ref: null } : r;
}

/**
 * Per-referrer sales summary for `license-list.mjs --by-ref` — pure, so the
 * counts are pinned by a test rather than eyeballed on a payout day.
 *
 *   keys     every key the referrer's code is on
 *   active   not expired as of `today` (the app's own isKeyExpired rule: valid
 *            through the expiry date) and not revoked; lifetime never expires
 *   lifetime keys with no expiry
 *   yearly   keys WITH an expiry — every term key (annual, monthly on request,
 *            custom), since the ledger records the date, not the plan asked for
 *   latest   the newest `issued` date
 *
 * Unreferred keys group under ref null (printed "(none)"). Sorted by keys
 * desc, then code ascending so the output is deterministic.
 * @param {Array<{keyId: string, issued: string, expires?: string|null, ref?: string|null}>} records
 * @param {{today?: Date, revoked?: readonly string[]}} [opts]
 */
export function summariseByRef(records, { today = new Date(), revoked = [] } = {}) {
  /** @type {Map<string|null, {ref: string|null, keys: number, active: number, lifetime: number, yearly: number, latest: string}>} */
  const by = new Map();
  for (const r of records) {
    const ref = normaliseRef(r.ref);
    let s = by.get(ref);
    if (!s) { s = { ref, keys: 0, active: 0, lifetime: 0, yearly: 0, latest: "" }; by.set(ref, s); }
    s.keys += 1;
    if (r.expires) s.yearly += 1;
    else s.lifetime += 1;
    const expired = !!r.expires && today.getTime() > new Date(r.expires + "T23:59:59").getTime();
    if (!expired && !revoked.includes(r.keyId)) s.active += 1;
    if (r.issued && r.issued > s.latest) s.latest = r.issued;
  }
  const label = (/** @type {string|null} */ ref) => ref ?? "(none)";
  return [...by.values()].sort((a, b) => b.keys - a.keys || (label(a.ref) < label(b.ref) ? -1 : label(a.ref) > label(b.ref) ? 1 : 0));
}

/**
 * One summary line: `CODE  keys N  active N  lifetime N  yearly N  latest YYYY-MM-DD`.
 * @param {ReturnType<typeof summariseByRef>[number]} s
 */
export function formatByRefLine(s) {
  return `${(s.ref ?? "(none)").padEnd(14)}  keys ${s.keys}  active ${s.active}  lifetime ${s.lifetime}  yearly ${s.yearly}  latest ${s.latest || "-"}`;
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
export function archiveFileBody({ key, keyId, email, sku, issued, expires = null, machine = null, note = null, ref = null }) {
  return [
    key,
    `key id : ${keyId}`,
    `plan   : ${expires ? `Pro — Annual, expires ${expires}` : "Journal — Lifetime"} (sku ${sku})`,
    `buyer  : ${email}`,
    `issued : ${issued}`,
    `expires: ${expires ?? "never (lifetime)"}`,
    `machine: ${machine ?? "unbound"}`,
    `note   : ${note ?? "—"}`,
    `ref    : ${ref ?? "none"}`,
    "",
  ].join("\n");
}
