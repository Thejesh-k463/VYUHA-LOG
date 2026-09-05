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

    // Tables deliberately NOT in a backup. An entry here needs a written
    // reason, not just a name.
    //   data_fixes — machine-side marker ledger (v3.8, migration 0059): which
    //   post-migrate data fixes THIS database has already applied. A backup
    //   restored into another database must not carry the donor's markers,
    //   or a fix the target still needs would be skipped; restore re-runs the
    //   fixes instead (lib/backup.ts).
    //   atlas_daily / atlas_metric / atlas_staleness — the v4.0 market-context
    //   CACHE (migration 0065). Every row is recomputed from `price_history`
    //   rows the user already imported, so nothing the user typed lives here
    //   and a restore loses nothing by omitting them. Carrying them would be
    //   actively wrong: each snapshot is bound to its inputs by
    //   `input_checksum`, so a snapshot restored beside a different set of bars
    //   is stale EVIDENCE presented as data. The desk recomputes instead.
    const EXCLUDED: string[] = ["data_fixes", "atlas_daily", "atlas_metric", "atlas_staleness"];

    const expected = allTables.filter((n) => !EXCLUDED.includes(n)).sort();
    expect([...BACKUP_TABLES].sort()).toEqual(expected);
  });

  it("recognises the encrypted envelope without treating arbitrary JSON as encrypted", () => {
    expect(isEncryptedBackup({ vyuhaEncrypted:true, algorithm:"aes-256-gcm", kdf:"scrypt", salt:"a",iv:"b",tag:"c",ciphertext:"d" })).toBe(true);
    expect(isEncryptedBackup({ vyuhaEncrypted:true })).toBe(false);
  });
});
