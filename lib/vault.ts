import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { db, vaultKeyFile as VAULT_KEY_PATH } from "@/lib/db";
import { settings, brokerConnections } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  VAULT_VERSION,
  isVaultCiphertext,
  parseVaultString,
  formatVaultString,
  validateVaultKeyFile,
  type SecretRead,
  type VaultKeyFile,
  type VaultProvider,
} from "./vault-format";
import { getMachineId } from "./machine-id.server";

/**
 * SECRETS AT REST — envelope encryption for the credentials this app holds.
 *
 * ── The scheme ──────────────────────────────────────────────────────────────
 *
 * One random 32-byte data-encryption key (DEK) encrypts every secret with
 * AES-256-GCM. The DEK itself never touches the database: it lives WRAPPED in
 * `vault.key` beside the DB file, and how it is wrapped depends on what the
 * machine offers:
 *
 *   - **Windows: DPAPI (CurrentUser).** The OS binds the wrap to this user's
 *     profile — another user, or the file copied to another machine, cannot
 *     unwrap. Invoked through PowerShell so no native npm module is needed
 *     (this repo's lockfile rules make "no new dependency" a design input,
 *     and machine-id.server.ts set the precedent of shelling out to the OS).
 *   - **macOS / Linux / DPAPI failure: scrypt over the machine identity**
 *     (lib/machine-id.server.ts) with a random salt. Weaker than DPAPI — the
 *     machine id is readable by any local process — but it still makes the
 *     database file USELESS OFF THE MACHINE, which is the attack this vault
 *     exists to stop: a copied .sqlite, a shared backup, a synced drive.
 *
 * ── What this deliberately does NOT claim ───────────────────────────────────
 *
 * No design running as the user defends secrets from other code running as
 * the same user — the OS keychain included. The claim here is narrower and
 * honest: secrets at rest are bound to this machine and user, so the database
 * alone carries nothing usable. Stronger custody (the Tauri shell brokering
 * an OS keychain over IPC) is a recorded upgrade path, not a silent promise.
 *
 * ── Failure posture ─────────────────────────────────────────────────────────
 *
 * An unreadable vault (new machine, moved profile, tampered file) NEVER
 * throws into a caller. Reads come back `{ ok: false, reason }`; the licence
 * simply reads as unlicensed with the reason shown, and a broker pull says
 * "re-enter the credential". Losing the decryption key must cost the user a
 * re-paste, never a crash and never their journal.
 */

// ---------------------------------------------------------------------------
// DEK lifecycle
// ---------------------------------------------------------------------------

type DekState =
  | { state: "ok"; dek: Buffer; provider: VaultProvider }
  | { state: "unreadable"; reason: string };

// Cached across dev hot-reloads, like the DB connection.
const globalForVault = globalThis as unknown as { __vyuhaVaultDek?: DekState };

const AAD = Buffer.from("vyuha-vault-v1");

function dpapiRun(op: "Protect" | "Unprotect", data: Buffer, entropy: Buffer): Buffer {
  // The blobs travel as base64 in ENVIRONMENT VARIABLES, not in the command
  // string — nothing user-controlled is interpolated into the script, so
  // there is nothing to inject into. (Not argv: Windows PowerShell's
  // `-Command` glues every following token into the command line rather than
  // populating $args — measured, it was how the first version silently fell
  // back to the machine wrap on every Windows box.)
  const script = [
    "Add-Type -AssemblyName System.Security;",
    "$d=[Convert]::FromBase64String($env:VYUHA_DPAPI_DATA);",
    "$e=[Convert]::FromBase64String($env:VYUHA_DPAPI_ENTROPY);",
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($d,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser))`,
  ].join(" ");
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 15_000,
    windowsHide: true,
    encoding: "utf8",
    env: { ...process.env, VYUHA_DPAPI_DATA: data.toString("base64"), VYUHA_DPAPI_ENTROPY: entropy.toString("base64") },
  });
  return Buffer.from(out.trim(), "base64");
}

function wrapDek(dek: Buffer): VaultKeyFile {
  const salt = randomBytes(16);
  // VYUHA_VAULT_PROVIDER=machine forces the KDF wrap — the test suite uses it
  // so every run exercises the same provider on every OS (a DPAPI round-trip
  // shells out to PowerShell per call, and CI has no DPAPI at all). One
  // win32-only test covers the DPAPI path explicitly.
  if (process.platform === "win32" && process.env.VYUHA_VAULT_PROVIDER !== "machine") {
    try {
      const wrapped = dpapiRun("Protect", dek, salt);
      return {
        vyuhaVault: true, v: VAULT_VERSION, provider: "dpapi",
        salt: salt.toString("base64"), wrapped: wrapped.toString("base64"),
        createdAt: new Date().toISOString(),
      };
    } catch {
      // PowerShell constrained/missing — the machine wrap below still holds
      // the off-machine guarantee, which is the load-bearing one.
    }
  }
  const kek = scryptSync(getMachineId(), salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  cipher.setAAD(AAD);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  return {
    vyuhaVault: true, v: VAULT_VERSION, provider: "machine",
    salt: salt.toString("base64"), wrapped: wrapped.toString("base64"),
    iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
    createdAt: new Date().toISOString(),
  };
}

function unwrapDek(file: VaultKeyFile): Buffer {
  const salt = Buffer.from(file.salt, "base64");
  const wrapped = Buffer.from(file.wrapped, "base64");
  if (file.provider === "dpapi") {
    return dpapiRun("Unprotect", wrapped, salt);
  }
  const kek = scryptSync(getMachineId(), salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(file.iv!, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(file.tag!, "base64"));
  return Buffer.concat([decipher.update(wrapped), decipher.final()]);
}

function loadDek(): DekState {
  if (globalForVault.__vyuhaVaultDek) return globalForVault.__vyuhaVaultDek;

  let state: DekState;
  try {
    if (fs.existsSync(VAULT_KEY_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(VAULT_KEY_PATH, "utf8")) as VaultKeyFile;
      const check = validateVaultKeyFile(parsed);
      if (!check.ok) {
        state = { state: "unreadable", reason: check.error! };
      } else {
        const dek = unwrapDek(parsed);
        if (dek.length !== 32) throw new Error("unwrapped key has the wrong length");
        state = { state: "ok", dek, provider: parsed.provider };
      }
    } else {
      // First run: mint the DEK. 0o600 where the OS honours modes; Windows
      // ACLs already scope %APPDATA% to the user.
      const dek = randomBytes(32);
      const file = wrapDek(dek);
      fs.mkdirSync(path.dirname(VAULT_KEY_PATH), { recursive: true });
      fs.writeFileSync(VAULT_KEY_PATH, JSON.stringify(file), { mode: 0o600 });
      state = { state: "ok", dek, provider: file.provider };
    }
  } catch (e) {
    state = {
      state: "unreadable",
      reason: `the vault key cannot be opened on this machine (${e instanceof Error ? e.message.split("\n")[0] : "unknown error"})`,
    };
  }

  globalForVault.__vyuhaVaultDek = state;
  return state;
}

/** Test seam — forces the next call to re-open vault.key. */
export function resetVaultCache(): void {
  globalForVault.__vyuhaVaultDek = undefined;
}

export function vaultStatus(): { ok: boolean; provider?: VaultProvider; reason?: string } {
  const s = loadDek();
  return s.state === "ok" ? { ok: true, provider: s.provider } : { ok: false, reason: s.reason };
}

// ---------------------------------------------------------------------------
// Secret encrypt / read
// ---------------------------------------------------------------------------

/**
 * Encrypt a secret for storage. Throws only when the vault is unreadable —
 * callers writing a NEW secret should surface that, because storing plaintext
 * beside a broken vault would silently downgrade the guarantee.
 */
export function encryptSecret(plain: string): string {
  const s = loadDek();
  if (s.state !== "ok") throw new Error(`Cannot store the secret: ${s.reason}.`);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", s.dek, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return formatVaultString(iv.toString("base64url"), ct.toString("base64url"), cipher.getAuthTag().toString("base64url"));
}

/**
 * Read a stored secret that may be ciphertext OR pre-vault plaintext.
 * Never throws: an unreadable value comes back as `{ ok: false, reason }`.
 */
export function readSecret(stored: string | null | undefined): SecretRead {
  if (stored == null || stored === "") return { ok: true, value: "", wasPlaintext: true };
  if (!isVaultCiphertext(stored)) return { ok: true, value: stored, wasPlaintext: true };

  const parsed = parseVaultString(stored);
  if (!parsed) return { ok: false, reason: "the stored secret is malformed" };
  const s = loadDek();
  if (s.state !== "ok") return { ok: false, reason: s.reason };
  try {
    const decipher = createDecipheriv("aes-256-gcm", s.dek, Buffer.from(parsed.iv, "base64url"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
    const value = Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, "base64url")), decipher.final()]).toString("utf8");
    return { ok: true, value, wasPlaintext: false };
  } catch {
    return { ok: false, reason: "the stored secret does not decrypt with this machine's vault key" };
  }
}

/** Constant-time equality for two secrets already in memory. */
export function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// The plaintext sweep
// ---------------------------------------------------------------------------

let sweptThisProcess = false;

/**
 * Upgrade any pre-vault PLAINTEXT secret to ciphertext, in place.
 *
 * Lazy (first entitlement/broker read) rather than a SQL migration, because
 * SQLite cannot run the crypto: encryption is an application-layer act, and a
 * migration file claiming to have done it would be a lie in the journal.
 * Idempotent, once per process, and best-effort — a broken vault skips the
 * sweep (there is nothing safe to encrypt WITH) rather than failing reads.
 */
export function sweepPlaintextSecrets(): void {
  if (sweptThisProcess) return;
  sweptThisProcess = true;
  if (loadDek().state !== "ok") return;

  try {
    const s = db.select({ id: settings.id, licenseKey: settings.licenseKey }).from(settings).get();
    if (s?.licenseKey && !isVaultCiphertext(s.licenseKey)) {
      db.update(settings).set({ licenseKey: encryptSecret(s.licenseKey) }).where(eq(settings.id, s.id)).run();
    }
    for (const row of db.select().from(brokerConnections).all()) {
      const needsKey = !!row.apiKey && !isVaultCiphertext(row.apiKey);
      const needsToken = !!row.accessToken && !isVaultCiphertext(row.accessToken);
      if (!needsKey && !needsToken) continue;
      db.update(brokerConnections)
        .set({
          ...(needsKey ? { apiKey: encryptSecret(row.apiKey) } : {}),
          ...(needsToken ? { accessToken: encryptSecret(row.accessToken) } : {}),
        })
        .where(eq(brokerConnections.id, row.id))
        .run();
    }
  } catch {
    // Best-effort by design: the values are still readable as plaintext and
    // the next process start retries. Failing a READ over an upgrade write
    // would invert the priorities.
  }
}

/** Test seam. */
export function resetSweepFlag(): void {
  sweptThisProcess = false;
}
