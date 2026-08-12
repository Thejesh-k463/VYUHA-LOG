// P0.4 — backup envelope format (PURE, no DB). Shared by the dump/restore engine
// and validated before any destructive restore.

// v3 (2026-08-12): four tables the list had silently fallen behind on —
// instrument_indices, mtf_margins, settings_baseline, panel_dismissals. A
// backup taken on v2 restored with every uploaded MTF margin list and all NSE
// index membership gone, and the guard test could not see it because it
// asserted a COUNT of 26 rather than the schema. v3 also redacts licence and
// trial state out of the settings row on dump (see lib/backup.ts).
export const BACKUP_VERSION = 3;

// Order is insert-order for restore (parents-ish first); delete runs in reverse.
export const BACKUP_TABLES = [
  "accounts",
  "settings",
  "settings_baseline",
  "charge_config",
  "risk_config",
  "capital_snapshots",
  "import_batches",
  "trades",
  "classification_overrides",
  "mtm_prices",
  "ipos",
  "restricted_securities",
  "ledger_entries",
  "audit_log",
  "trade_legs",
  "symbol_aliases",
  "benchmark_prices",
  "instruments",
  "instrument_indices",
  "mtf_margins",
  "price_history",
  "corporate_actions",
  "playbooks",
  "margin_config",
  "trade_attachments",
  "broker_connections",
  "trading_sessions",
  "regulatory_rule_packs",
  "panel_dismissals",
] as const;

/**
 * settings columns REDACTED on dump and PRESERVED through restore.
 *
 * A backup travels — that is its purpose — and these three are not journal
 * data: the licence key is the buyer's entitlement (a shared backup was a
 * shared key), and the trial/ratchet pair is security state (restoring an old
 * backup lowered the clock high-water mark, defeating the tamper ratchet).
 * `lib/domain/settings-baseline.ts` already excluded all three from "restore
 * defaults" for the same reason — the backup path was the one left unguarded.
 */
export const SETTINGS_MACHINE_COLUMNS = ["licenseKey", "trialStartedAt", "clockHighWaterMark", "revocationListIssuedAt"] as const;

/**
 * Broker credential columns, redacted from every dump for the same reason the
 * licence key is: a backup is a JOURNAL, and credentials belong to the
 * machine. Since v2.99.80 the stored values are vault ciphertext anyway —
 * unreadable off the machine — but carrying unreadable bytes into a backup
 * would only manufacture a "restore looks broken" report; a redacted column
 * plus a re-connect prompt is the honest shape. Rows redacted to "" are
 * DROPPED on restore: a connection without credentials is not a connection.
 */
export const BROKER_SECRET_COLUMNS = ["apiKey", "accessToken", "authJson"] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

export interface BackupEnvelope {
  vyuhaBackup: true;
  version: number;
  createdAt: string;
  counts: Record<string, number>;
  tables: Record<string, unknown[]>;
  attachments?: { storedName: string; mime: string; dataBase64: string }[];
}

/**
 * scrypt cost parameters.
 *
 * v1 envelopes carried none, because they were written with node's defaults
 * (N=16384) — light for a key that protects an entire trading history, since
 * the file is offline and an attacker can grind it at their leisure. v2 raises
 * the cost and WRITES THE PARAMETERS DOWN, so the cost can be raised again
 * later without stranding files already on a user's disk.
 */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Node's defaults — what every v1 envelope was sealed with. */
export const SCRYPT_PARAMS_V1: ScryptParams = { N: 16384, r: 8, p: 1 };

/** OWASP's baseline scrypt cost. ~134 MB of memory per derivation. */
export const SCRYPT_PARAMS_V2: ScryptParams = { N: 1 << 17, r: 8, p: 1 };

/** Memory ceiling for a derivation: 128 · N · r, plus headroom. */
export function scryptMaxmem(params: ScryptParams): number {
  return 128 * params.N * params.r * 2;
}

export const ENCRYPTED_BACKUP_VERSION = 2;

export interface EncryptedBackupEnvelope {
  vyuhaEncrypted: true;
  /** 1 = node-default scrypt cost (no kdfParams); 2 = cost recorded explicitly. */
  version: number;
  algorithm: "aes-256-gcm";
  kdf: "scrypt";
  /** Absent on v1 envelopes — read SCRYPT_PARAMS_V1 in that case. */
  kdfParams?: ScryptParams;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/** The cost an envelope was sealed with; v1 files predate the field. */
export function paramsOf(env: EncryptedBackupEnvelope): ScryptParams {
  const p = env.kdfParams;
  if (!p || typeof p.N !== "number" || typeof p.r !== "number" || typeof p.p !== "number") return SCRYPT_PARAMS_V1;
  return p;
}

export interface ValidationResult {
  ok: boolean;
  message: string;
  tables?: Record<string, unknown[]>;
}

/** Validate an untrusted object is a Vyuha backup before restoring from it. */
export function validateBackup(obj: unknown): ValidationResult {
  if (!obj || typeof obj !== "object") return { ok: false, message: "Not a JSON object." };
  const o = obj as Record<string, unknown>;
  if (o.vyuhaBackup !== true) return { ok: false, message: "Not a Vyuha backup (missing marker)." };
  if (typeof o.version !== "number") return { ok: false, message: "Backup is missing a version." };
  if (o.version > BACKUP_VERSION) return { ok: false, message: `Backup version ${o.version} is newer than this app supports (${BACKUP_VERSION}).` };
  if (!o.tables || typeof o.tables !== "object") return { ok: false, message: "Backup has no tables." };
  const tables = o.tables as Record<string, unknown[]>;
  for (const name of Object.keys(tables)) {
    if (!Array.isArray(tables[name])) return { ok: false, message: `Table "${name}" is not an array.` };
  }
  return { ok: true, message: "Valid Vyuha backup.", tables };
}

export function isEncryptedBackup(obj: unknown): obj is EncryptedBackupEnvelope {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return o.vyuhaEncrypted === true && o.algorithm === "aes-256-gcm" && o.kdf === "scrypt" &&
    [o.salt, o.iv, o.tag, o.ciphertext].every((v) => typeof v === "string");
}
