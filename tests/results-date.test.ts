import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { daysToResults, isIsoDate } from "@/lib/live/results-date";
import { resultsChip, DESK_COPY } from "@/components/live/desk-copy";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * `instruments.results_date` (owner ruling Q-9, migration 0068) end to end:
 * the migration that adds the column, the pure distance arithmetic, and the
 * copy that renders it.
 *
 * ONE temp database for the whole file — `lib/db` caches its connection on
 * globalThis, so a second `openTempDb()` here would silently reuse this one
 * (AGENTS.md, Testing).
 */

let t: TempDb;

const cols = (table: string) =>
  t.sqlite.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];

beforeAll(async () => {
  t = await openTempDb("results-date");
});
afterAll(() => t?.cleanup());

describe("0068 — instruments gains results_date", () => {
  it("is journalled, and every journal tag still has its .sql file", () => {
    // A hand-written migration with no _journal.json entry is silently skipped
    // (0027+ carry no drizzle-kit snapshot), so the file can look present while
    // no install ever applies it.
    const dir = path.join(process.cwd(), "drizzle");
    const journal = JSON.parse(fs.readFileSync(path.join(dir, "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string; version: string; when: number; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.tag === "0068_instruments-results-date");
    expect(entry, "0068 is not in _journal.json — nothing would apply it").toBeTruthy();
    expect(entry!.idx).toBe(68);
    expect(entry!.version).toBe("6");
    expect(entry!.breakpoints).toBe(true);
    // The migrator walks the journal in order; a `when` at or before 0067's
    // reorders the two.
    const prev = journal.entries.find((e) => e.tag === "0067_live-feed")!;
    expect(entry!.when).toBeGreaterThan(prev.when);
    for (const e of journal.entries) {
      expect(fs.existsSync(path.join(dir, `${e.tag}.sql`)), `${e.tag}.sql is missing`).toBe(true);
    }
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
  });

  it("the column exists on a freshly migrated database", () => {
    expect(cols("instruments").map((c) => c.name)).toContain("results_date");
  });

  it("is a NULLABLE text column with no default — 'not recorded' is the shipped state", () => {
    const col = cols("instruments").find((c) => c.name === "results_date")!;
    expect(col.type.toLowerCase()).toBe("text");
    expect(col.notnull, "a NOT NULL results date would demand a date nobody has").toBe(0);
    expect(col.dflt_value, "a defaulted date is a claim about a company (invariant 6)").toBeNull();
  });

  it("keeps every pre-existing column — the migration is purely additive", () => {
    expect(cols("instruments").map((c) => c.name)).toEqual(
      expect.arrayContaining(["id", "symbol", "name", "isin", "sector", "lot_size", "expiry", "created_at", "updated_at"]),
    );
  });

  it("a row inserted without one reads back null, and a date round-trips", () => {
    t.sqlite.prepare("INSERT INTO instruments (symbol) VALUES ('RELIANCE')").run();
    expect(
      (t.sqlite.prepare("SELECT results_date AS d FROM instruments WHERE symbol='RELIANCE'").get() as { d: string | null }).d,
    ).toBeNull();
    t.sqlite.prepare("UPDATE instruments SET results_date='2026-10-14' WHERE symbol='RELIANCE'").run();
    expect(
      (t.sqlite.prepare("SELECT results_date AS d FROM instruments WHERE symbol='RELIANCE'").get() as { d: string }).d,
    ).toBe("2026-10-14");
  });

  it("travels in a backup by construction — instruments is dumped whole, not column by column", () => {
    // `lib/backup.ts` dumps `db.select().from(TABLE_MAP[name])`, so every
    // SCHEMA column travels and no list enumerates instrument columns. The
    // guard here is that `instruments` is still in BACKUP_TABLES and that the
    // results date is NOT machine state: it is the user's own record, like the
    // sector tags they typed, so it must never join SETTINGS_MACHINE_COLUMNS.
    const src = fs.readFileSync(path.join(process.cwd(), "lib", "backup-format.ts"), "utf8");
    expect(src).toContain('"instruments"');
    expect(src).not.toContain("resultsDate");
    expect(src).not.toContain("results_date");
  });
});

describe("daysToResults — a distance in days, never a negative one", () => {
  it("0 for today, 1 for tomorrow, N for N days out", () => {
    expect(daysToResults("2026-09-06", "2026-09-06")).toBe(0);
    expect(daysToResults("2026-09-07", "2026-09-06")).toBe(1);
    expect(daysToResults("2026-09-18", "2026-09-06")).toBe(12);
  });

  it("null for a PAST date — the date stays on the record, nothing renders", () => {
    expect(daysToResults("2026-09-05", "2026-09-06")).toBeNull();
    expect(daysToResults("2020-01-01", "2026-09-06")).toBeNull();
  });

  it("null when no date is recorded", () => {
    expect(daysToResults(null, "2026-09-06")).toBeNull();
    expect(daysToResults(undefined, "2026-09-06")).toBeNull();
    expect(daysToResults("", "2026-09-06")).toBeNull();
  });

  it("crosses a month and a year boundary as whole days", () => {
    expect(daysToResults("2026-10-01", "2026-09-30")).toBe(1);
    expect(daysToResults("2027-01-01", "2026-12-31")).toBe(1);
    // 2028 is a leap year: Feb has 29 days, so 01 Feb → 01 Mar is 29.
    expect(daysToResults("2028-03-01", "2028-02-01")).toBe(29);
    expect(daysToResults("2026-03-01", "2026-02-01")).toBe(28);
  });

  it("is timezone-proof: it reads the two ISO strings and never `new Date()`", () => {
    // Both sides are midnight UTC, so no DST shift and no local offset can
    // turn 1 day into 0 or 2. India has no DST, but the desktop app runs on
    // whatever machine the user has.
    // Comment-stripped: the header explains why `new Date()` is absent, which
    // is a sentence containing the very call the guard looks for.
    const src = fs
      .readFileSync(path.join(process.cwd(), "lib", "live", "results-date.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/new Date\(\s*\)/);
    expect(daysToResults("2026-03-30", "2026-03-29"), "the European DST Sunday").toBe(1);
    expect(daysToResults("2026-11-02", "2026-11-01"), "the US DST Sunday").toBe(1);
  });

  it("refuses a malformed or impossible date rather than guessing", () => {
    expect(daysToResults("14-10-2026", "2026-09-06")).toBeNull();
    expect(daysToResults("2026-10-14T00:00:00Z", "2026-09-06")).toBeNull();
    expect(daysToResults("2026-2-3", "2026-09-06")).toBeNull();
    // Date.UTC would roll this forward to 02 March and answer "176 days".
    expect(daysToResults("2026-02-30", "2026-09-06")).toBeNull();
    expect(daysToResults("2026-13-01", "2026-09-06")).toBeNull();
    expect(daysToResults("2026-10-14", "not-a-day")).toBeNull();
  });
});

describe("isIsoDate — the same guard the route validates with", () => {
  it("accepts a real calendar day", () => {
    expect(isIsoDate("2026-10-14")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true); // leap year
  });

  it("rejects a well-shaped string that is not a day", () => {
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-00-10")).toBe(false);
    expect(isIsoDate("2027-02-29")).toBe(false); // not a leap year
  });

  it("rejects everything that is not a `YYYY-MM-DD` string", () => {
    for (const bad of ["", "2026-10-14 ", "2026/10/14", 20261014, null, undefined, {}]) {
      expect(isIsoDate(bad), String(bad)).toBe(false);
    }
  });
});

describe("the chip states a distance and stops", () => {
  it("spells out today and tomorrow", () => {
    expect(resultsChip(0)).toBe("Results today");
    expect(resultsChip(1)).toBe("Results tomorrow");
  });

  it("counts days beyond that", () => {
    expect(resultsChip(2)).toBe("Results in 2 days");
    expect(resultsChip(12)).toBe("Results in 12 days");
  });

  it("never follows the date with an instruction", () => {
    // The SEBI line the whole desk is held to (tests/live-tracker-copy.test.ts).
    // A date fact is exactly a date fact.
    const BANNED = /\b(recommend|suggest|advice|should|consider|buy|sell|trim|book|exit|hold)\b/i;
    for (const s of [resultsChip(0), resultsChip(1), resultsChip(7), DESK_COPY.resultsMissing, DESK_COPY.resultsPast]) {
      expect(BANNED.test(s), s).toBe(false);
    }
    // Every string is a noun phrase — no verb of instruction, no "before".
    expect(resultsChip(3)).not.toMatch(/before|ahead of|ahead/i);
  });
});
