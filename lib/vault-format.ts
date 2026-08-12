// THE SECRETS-AT-REST ENVELOPE (PURE — no crypto, no fs, no DB).
//
// Until 2026-08-12 every secret this app held sat in SQLite as plaintext: the
// licence key in `settings.license_key`, and live broker API credentials in
// `broker_connections.api_key` / `access_token`. For daily-expiry tokens that
// was defensible; it stops being defensible the moment longer-lived
// credentials arrive (a TOTP secret is a *permanent second factor*), and the
// broker-API roadmap makes those arrivals a matter of time. Encryption at
// rest is the prerequisite, built BEFORE the first such credential field
// exists — retrofitting later would mean a migration over live secrets.
//
// This module defines only the SHAPES: the string envelope a ciphertext wears
// inside a DB column, and the key-file envelope the wrapped data-encryption
// key lives in. The crypto itself is in `lib/vault.ts` (server-only), so this
// file stays importable anywhere — including the pure test suite — and the
// format can be validated without touching a key.
//
// ── The column envelope ─────────────────────────────────────────────────────
//
//   venc:1:<iv>:<ciphertext>:<tag>          (base64url fields, AES-256-GCM)
//
// A prefixed string, not a new column type, so every existing column can hold
// either form during the transition: reads detect the prefix, plaintext
// values are swept into ciphertext on first touch, and a pre-vault backup
// restores without ceremony. GCM's tag makes tampering detectable — a
// modified ciphertext decrypts to an error, never to a silently different
// secret.

/** Marks a column value as vault ciphertext. */
export const VAULT_PREFIX = "venc:";

export const VAULT_VERSION = 1;

/** How the data-encryption key is wrapped in the key file. */
export type VaultProvider =
  /** Windows DPAPI (CurrentUser) — the OS binds the key to this user profile. */
  | "dpapi"
  /** scrypt over the machine identity — for macOS/Linux and DPAPI failure. */
  | "machine";

/** The `vault.key` file beside the database. Wrapped DEK only — never raw. */
export interface VaultKeyFile {
  vyuhaVault: true;
  v: number;
  provider: VaultProvider;
  /** Random salt: scrypt salt for "machine", extra entropy for "dpapi". */
  salt: string; // base64
  /** The wrapped 32-byte DEK, per provider. */
  wrapped: string; // base64
  /** GCM pieces for the "machine" provider (absent for "dpapi"). */
  iv?: string; // base64
  tag?: string; // base64
  createdAt: string;
}

export function isVaultCiphertext(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(VAULT_PREFIX);
}

export interface ParsedVaultString {
  v: number;
  iv: string;
  ciphertext: string;
  tag: string;
}

/** Parse a column envelope. Null for anything malformed — the caller decides
 *  whether malformed-but-prefixed means "unreadable secret" (it does). */
export function parseVaultString(value: string): ParsedVaultString | null {
  if (!isVaultCiphertext(value)) return null;
  const parts = value.split(":");
  if (parts.length !== 5) return null;
  const v = Number(parts[1]);
  if (!Number.isInteger(v) || v < 1) return null;
  const [iv, ciphertext, tag] = [parts[2], parts[3], parts[4]];
  if (!iv || !ciphertext || !tag) return null;
  const B64URL = /^[A-Za-z0-9_-]+$/;
  if (!B64URL.test(iv) || !B64URL.test(ciphertext) || !B64URL.test(tag)) return null;
  return { v, iv, ciphertext, tag };
}

export function formatVaultString(iv: string, ciphertext: string, tag: string): string {
  return `${VAULT_PREFIX}${VAULT_VERSION}:${iv}:${ciphertext}:${tag}`;
}

export function validateVaultKeyFile(x: unknown): { ok: boolean; error?: string } {
  if (!x || typeof x !== "object") return { ok: false, error: "Not a vault key file." };
  const f = x as Partial<VaultKeyFile>;
  if (f.vyuhaVault !== true) return { ok: false, error: "Not a Vyuha vault key file." };
  if (typeof f.v !== "number" || f.v < 1) return { ok: false, error: "The vault file has no version." };
  if (f.v > VAULT_VERSION) return { ok: false, error: `Written by a newer Vyuha (vault v${f.v}; this build reads v${VAULT_VERSION}).` };
  if (f.provider !== "dpapi" && f.provider !== "machine") return { ok: false, error: "Unknown vault provider." };
  if (typeof f.salt !== "string" || typeof f.wrapped !== "string") return { ok: false, error: "The vault file is incomplete." };
  if (f.provider === "machine" && (typeof f.iv !== "string" || typeof f.tag !== "string")) {
    return { ok: false, error: "The vault file is missing its unwrap parameters." };
  }
  return { ok: true };
}

/** What a read of a stored secret can come back as. */
export type SecretRead =
  /** A usable value. `wasPlaintext` marks a pre-vault row the caller should
   *  let the sweep upgrade. */
  | { ok: true; value: string; wasPlaintext: boolean }
  /** Ciphertext this machine cannot open (moved profile, changed machine,
   *  tampered bytes). The secret is not gone — it is unreadable HERE, and the
   *  honest response is to say so and ask for the credential again. */
  | { ok: false; reason: string };
