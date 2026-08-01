// P0.4 — backup envelope format (PURE, no DB). Shared by the dump/restore engine
// and validated before any destructive restore.

export const BACKUP_VERSION = 2;

// Order is insert-order for restore (parents-ish first); delete runs in reverse.
export const BACKUP_TABLES = [
  "accounts",
  "settings",
  "charge_config",
  "risk_config",
  "capital_snapshots",
  "import_batches",
  "trades",
  "positions",
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
  "price_history",
  "corporate_actions",
  "playbooks",
  "margin_config",
  "trade_attachments",
  "broker_connections",
  "trading_sessions",
  "regulatory_rule_packs",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

export interface BackupEnvelope {
  vyuhaBackup: true;
  version: number;
  createdAt: string;
  counts: Record<string, number>;
  tables: Record<string, unknown[]>;
  attachments?: { storedName: string; mime: string; dataBase64: string }[];
}

export interface EncryptedBackupEnvelope {
  vyuhaEncrypted: true;
  version: 1;
  algorithm: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
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
