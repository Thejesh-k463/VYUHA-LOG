import { describe, it, expect } from "vitest";
import { getTableName, is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";
import {
  validateBackup,
  BACKUP_VERSION,
  BACKUP_TABLES,
  SETTINGS_MACHINE_COLUMNS,
  isEncryptedBackup,
  settingsMachineBlank,
} from "@/lib/backup-format";

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
    //   angelone_instrument_tokens — the v4.2 symbol → Angel One exchange-token
    //   CACHE (migration 0070), the same kind of row as the atlas_* three. Every
    //   entry is re-derived from Angel One's own `searchScrip` on demand and the
    //   whole book refills in about a minute, nothing the user typed lives here
    //   (exchange, symbol, the broker's tradingsymbol and its numeric token),
    //   and it carries no `account_id` — it is a fact about the BROKER's
    //   instrument master, not about anybody's journal. Carrying it would also
    //   be the wrong direction: a token restored from a donor file is the
    //   donor's snapshot of a master that changes on corporate actions, and a
    //   stale token prices the wrong scrip silently. The adapter re-resolves.
    const EXCLUDED: string[] = [
      "data_fixes",
      "atlas_daily",
      "atlas_metric",
      "atlas_staleness",
      "angelone_instrument_tokens",
    ];

    const expected = allTables.filter((n) => !EXCLUDED.includes(n)).sort();
    expect([...BACKUP_TABLES].sort()).toEqual(expected);
  });

  it("keeps every JOB-BOOKKEEPING stamp on the machine that earned it", () => {
    // A "last done on" stamp describes THIS installation's jobs. Restored from
    // someone else's file — or from your own, taken later the same IST day — it
    // suppresses a run that has not happened here. `last_live_mark_date` is the
    // "exactly one persisted mark per position per day" guard (migration 0067,
    // whose header names this list by name); without it here, a restore hands
    // the desk a stamp for today and persist-mark.ts refuses today's mark.
    for (const col of ["lastTelegramSentDate", "lastAutoPullDate", "lastLiveMarkDate"]) {
      expect(SETTINGS_MACHINE_COLUMNS as readonly string[], col).toContain(col);
    }
    // …and every one of them is a real settings column, not a typo that would
    // silently redact nothing.
    const declared = getTableConfig(schema.settings).columns.map((c) => c.name);
    const byProp = new Set(Object.keys(schema.settings));
    for (const col of SETTINGS_MACHINE_COLUMNS) {
      expect(byProp, `${col} is not a column on settings`).toContain(col);
    }
    expect(declared.length).toBeGreaterThan(0);
  });

  it("EXHAUSTIVE: every consent / credential / machine-state settings column is redacted or allowlisted", () => {
    // SETTINGS_MACHINE_COLUMNS is a REDACTION ALLOWLIST, and until this test it
    // had no exhaustiveness check: nothing went red when a new consent column
    // was added and forgotten, and the failure mode is silent — someone else's
    // acceptance of a live broker feed riding into your install inside a file
    // that is supposed to carry a journal. So the schema is enumerated (like
    // the BACKUP_TABLES test above) and every column whose NAME says "consent,
    // credential or machine identity" must be either redacted or listed here
    // with a written reason.
    //
    // The pattern is deliberately name-based and deliberately over-inclusive:
    // it can only ever ask a question, and the answer is two lines of prose.
    // Job-bookkeeping stamps (`last…Date`) are NOT in it — they are covered by
    // the test above, which names all three.
    const CONSENT_LIKE = /ack|consent|enabled|token|secret|key|machine|device|trial|licen[cs]e/i;

    // A column that MATCHES the pattern and is deliberately NOT redacted.
    // An entry needs a reason, not just a name.
    const TRAVELS_ON_PURPOSE: Record<string, string> = {
      autoMtmEnabled:
        "A PREFERENCE, not a consent: it is the only 'enabled' flag inside BASELINE_SETTINGS_FIELDS " +
        "(lib/domain/settings-baseline.ts), it holds no credential and it switches on a download of a " +
        "PUBLIC NSE bhavcopy — nothing personal leaves the machine. It travels so that a restore returns " +
        "the user to the configuration they backed up. NOTE for whoever changes this: hasBackfillConsent() " +
        "(lib/jobs/bhavcopy-backfill.ts) reads it as consent for the 252-file backfill, so a restored true " +
        "does grant that; raised in v4.2 and left alone, because moving it would also have to move it out " +
        "of the baseline, and that is an owner decision.",
    };

    const props = Object.keys(schema.settings).filter((p) => /^[a-z]/.test(p));
    expect(props.length, "settings introspection returned nothing").toBeGreaterThan(20);
    expect(props, "the v4.2 consent column is not on the settings table").toContain("liveFeedAckJson");

    const redacted = new Set<string>(SETTINGS_MACHINE_COLUMNS as readonly string[]);
    const matched = props.filter((p) => CONSENT_LIKE.test(p));
    const unaccounted = matched.filter((p) => !redacted.has(p) && !(p in TRAVELS_ON_PURPOSE));
    expect(
      unaccounted,
      `settings column(s) that look like consent/credential/machine state and are neither redacted in ` +
        `SETTINGS_MACHINE_COLUMNS nor allowlisted with a reason: ${unaccounted.join(", ")}`,
    ).toEqual([]);

    // The pattern really fires — a rule that matches nothing proves nothing.
    expect(matched.length).toBeGreaterThan(5);
    expect(matched).toContain("liveFeedAckJson");
    expect(CONSENT_LIKE.test("angeloneAckVersion")).toBe(true);
    expect(CONSENT_LIKE.test("upstoxTokenEnc")).toBe(true);

    // …and the allowlist may not rot: every entry is still a real column and
    // still carries a reason.
    for (const [col, why] of Object.entries(TRAVELS_ON_PURPOSE)) {
      expect(props, `${col} is allowlisted but is no longer a settings column`).toContain(col);
      expect(why.length, `${col} is allowlisted without a reason`).toBeGreaterThan(40);
    }
  });

  it("the live-feed consent never travels in a backup, and blanks to null", () => {
    // v4.2, migration 0069: one JSON cell, provider id → accepted disclosure
    // version. Exactly the openalgoEnabled/openalgoAckVersion pair's rule.
    expect(SETTINGS_MACHINE_COLUMNS as readonly string[]).toContain("liveFeedAckJson");
    expect(SETTINGS_MACHINE_COLUMNS as readonly string[]).toContain("openalgoAckVersion");
    // Nullable column ⇒ the blank is null; a NOT NULL one would need a safe
    // value in SETTINGS_MACHINE_BLANKS or the restore INSERT fails.
    const col = getTableConfig(schema.settings).columns.find((c) => c.name === "live_feed_ack_json");
    expect(col, "live_feed_ack_json is not on the settings table").toBeDefined();
    expect(col!.notNull, "a NOT NULL machine column needs a SETTINGS_MACHINE_BLANKS entry").toBe(false);
    expect(settingsMachineBlank("liveFeedAckJson")).toBe(null);
  });

  it("recognises the encrypted envelope without treating arbitrary JSON as encrypted", () => {
    expect(isEncryptedBackup({ vyuhaEncrypted:true, algorithm:"aes-256-gcm", kdf:"scrypt", salt:"a",iv:"b",tag:"c",ciphertext:"d" })).toBe(true);
    expect(isEncryptedBackup({ vyuhaEncrypted:true })).toBe(false);
  });
});
