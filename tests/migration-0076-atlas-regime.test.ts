import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { BASELINE_SETTINGS_FIELDS } from "@/lib/domain/settings-baseline";
import { SETTINGS_MACHINE_COLUMNS } from "@/lib/backup-format";
import { DEFAULT_REGIME_THRESHOLDS } from "@/lib/atlas/regime";
import { parseRegimeThresholds } from "@/lib/atlas/regime-thresholds";

/**
 * Migration 0076 — `settings.atlas_regime_thresholds` (v4.6.0 W5, owner ruling
 * AQ13). On the pattern of tests/migration-0075-telegram-send-time.test.ts:
 *
 *   1. registered in the journal with a matching .sql file;
 *   2. the column exists, nullable, no default — NULL means the shipped defaults;
 *   3. a freshly seeded settings row reads as the defaults;
 *   4. a per-journal CHOICE: in BASELINE_SETTINGS_FIELDS, not a machine column,
 *      and the backup test's CONSENT_LIKE pattern does not catch it (so no
 *      allowlist entry is needed there either).
 *
 * ONE temp database per file.
 */

let t: TempDb;
const MIGRATION = path.join(process.cwd(), "drizzle", "0076_atlas-regime-thresholds.sql");

beforeAll(async () => {
  t = await openTempDb("migration-0076", { seed: true });
});
afterAll(() => t?.cleanup());

describe("migration 0076 — atlas_regime_thresholds", () => {
  it("is registered in the journal with a matching .sql file, right after 0075", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const entry = journal.entries.find((e) => e.idx === 76);
    expect(entry?.tag).toBe("0076_atlas-regime-thresholds");
    const prev = journal.entries.find((e) => e.idx === 75)!;
    expect(entry!.when).toBeGreaterThan(prev.when);
    expect(fs.existsSync(MIGRATION)).toBe(true);
    expect(fs.readFileSync(MIGRATION, "utf8")).toContain("ALTER TABLE `settings` ADD COLUMN `atlas_regime_thresholds` text;");
  });

  it("adds a nullable text column with no default", () => {
    const col = (t.sqlite.prepare("PRAGMA table_info(settings)").all() as { name: string; type: string; notnull: number; dflt_value: string | null }[]).find(
      (c) => c.name === "atlas_regime_thresholds",
    );
    expect(col).toBeDefined();
    expect(col!.type.toLowerCase()).toBe("text");
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
  });

  it("a freshly seeded settings row holds NULL, which reads as the shipped defaults", () => {
    const row = t.sqlite.prepare("SELECT atlas_regime_thresholds AS v FROM settings").get() as { v: string | null };
    expect(row.v).toBeNull();
    expect(parseRegimeThresholds(row.v) ?? DEFAULT_REGIME_THRESHOLDS).toEqual(DEFAULT_REGIME_THRESHOLDS);
  });

  it("is a per-journal CHOICE: baseline field, not a machine column, and not consent-like", () => {
    expect(BASELINE_SETTINGS_FIELDS as readonly string[]).toContain("atlasRegimeThresholds");
    expect(SETTINGS_MACHINE_COLUMNS as readonly string[]).not.toContain("atlasRegimeThresholds");
    // tests/backup-format.test.ts's pattern, verbatim: the column must not look like a consent or a credential.
    const CONSENT_LIKE = /ack|consent|enabled|token|secret|key|machine|device|trial|licen[cs]e/i;
    expect(CONSENT_LIKE.test("atlasRegimeThresholds")).toBe(false);
  });

  it("the schema declares it, so drizzle reads and writes it through the table object", () => {
    const schema = fs.readFileSync(path.join(process.cwd(), "lib", "db", "schema.ts"), "utf8");
    expect(schema).toContain('atlasRegimeThresholds: text("atlas_regime_thresholds")');
  });
});
