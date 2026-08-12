import { describe, it, expect } from "vitest";
import { getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";
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

  it("covers EVERY table the schema defines — introspected, not counted", () => {
    // The previous version of this test asserted a count of 26 and a sample of
    // 8 names. Four tables (instrument_indices, mtf_margins, settings_baseline,
    // panel_dismissals) were then added to the schema and silently never backed
    // up — a restore lost every uploaded MTF margin list, and the "coverage"
    // test stayed green because 26 still equalled 26. Enumerating the schema
    // means table 31 cannot ship unbacked-up: someone must either add it here
    // or put it on the exclusion list below with a reason.
    const allTables = Object.values(schema)
      .filter((v) => is(v, SQLiteTable))
      .map((tbl) => getTableName(tbl as SQLiteTable));

    // Tables deliberately NOT in a backup. Currently none — every table
    // travels. An entry here needs a written reason, not just a name.
    const EXCLUDED: string[] = [];

    const expected = allTables.filter((n) => !EXCLUDED.includes(n)).sort();
    expect([...BACKUP_TABLES].sort()).toEqual(expected);
  });

  it("recognises the encrypted envelope without treating arbitrary JSON as encrypted", () => {
    expect(isEncryptedBackup({ vyuhaEncrypted:true, algorithm:"aes-256-gcm", kdf:"scrypt", salt:"a",iv:"b",tag:"c",ciphertext:"d" })).toBe(true);
    expect(isEncryptedBackup({ vyuhaEncrypted:true })).toBe(false);
  });
});
