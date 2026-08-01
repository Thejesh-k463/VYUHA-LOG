import { describe, it, expect } from "vitest";
import { validateBackup, BACKUP_VERSION, BACKUP_TABLES, isEncryptedBackup } from "@/lib/backup-format";

describe("validateBackup", () => {
  it("accepts a well-formed envelope", () => {
    const v = validateBackup({ vyuhaBackup: true, version: 1, createdAt: "x", counts: {}, tables: { trades: [] } });
    expect(v.ok).toBe(true);
    expect(v.tables).toEqual({ trades: [] });
  });

  it("rejects non-objects and foreign files", () => {
    expect(validateBackup(null).ok).toBe(false);
    expect(validateBackup("nope").ok).toBe(false);
    expect(validateBackup({ hello: "world" }).ok).toBe(false); // missing marker
  });

  it("rejects a missing version or tables", () => {
    expect(validateBackup({ vyuhaBackup: true, tables: {} }).ok).toBe(false);
    expect(validateBackup({ vyuhaBackup: true, version: 1 }).ok).toBe(false);
  });

  it("rejects a future backup version", () => {
    const v = validateBackup({ vyuhaBackup: true, version: BACKUP_VERSION + 5, tables: {} });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/newer/i);
  });

  it("rejects a table that is not an array", () => {
    expect(validateBackup({ vyuhaBackup: true, version: 1, tables: { trades: 42 } }).ok).toBe(false);
  });

  it("covers every v2 operational table, including legs and attachments", () => {
    expect(BACKUP_TABLES).toEqual(expect.arrayContaining(["accounts", "trade_legs", "playbooks", "price_history", "trade_attachments", "broker_connections", "trading_sessions", "regulatory_rule_packs"]));
    expect(BACKUP_TABLES).toHaveLength(26);
  });

  it("recognises the encrypted envelope without treating arbitrary JSON as encrypted", () => {
    expect(isEncryptedBackup({ vyuhaEncrypted:true, algorithm:"aes-256-gcm", kdf:"scrypt", salt:"a",iv:"b",tag:"c",ciphertext:"d" })).toBe(true);
    expect(isEncryptedBackup({ vyuhaEncrypted:true })).toBe(false);
  });
});
