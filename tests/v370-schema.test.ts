import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { SETTINGS_MACHINE_COLUMNS } from "@/lib/backup-format";
import { BASELINE_SETTINGS_FIELDS } from "@/lib/domain/settings-baseline";
import { SLIM_TRADE_FIELDS } from "@/lib/domain/slim-trade";

/**
 * v3.7 wave 1 — the four schema migrations (0055–0058) and the promises their
 * comment blocks make that the DDL alone cannot enforce.
 *
 * Everything here runs against a REAL migrated SQLite file (helpers/temp-db):
 * a migration that is written but never journalled, an index that is created
 * non-unique when it should be unique, or a backfill whose WHERE clause drifts
 * are all invisible to a pure test. ONE temp database for the whole file —
 * lib/db caches its connection on globalThis (see the helper's header).
 *
 * ── How the BACKFILL halves are tested ──────────────────────────────────────
 *
 * A migrated temp database is EMPTY when the migrations run, so the backfills
 * had nothing to touch. Re-creating a pre-0055 database would mean replaying
 * fifty-four migrations by hand; instead these tests read the real .sql files
 * off disk, extract the backfill statement VERBATIM, and run it against rows
 * put into the pre-backfill state. Editing the WHERE clause in the migration
 * therefore reddens these tests — which is the point, and is why the SQL is
 * never retyped here.
 */

let t: TempDb;

const migrationsDir = path.join(process.cwd(), "drizzle");

/** The statements of one migration file, split on drizzle's breakpoint marker. */
function statementsOf(file: string): string[] {
  return fs
    .readFileSync(path.join(migrationsDir, file), "utf8")
    .split("--> statement-breakpoint")
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

/** The one statement in `file` that starts with the given SQL verb. */
function statementStartingWith(file: string, verb: string): string {
  const found = statementsOf(file).filter((s) => s.toUpperCase().startsWith(verb.toUpperCase()));
  expect(found, `${file} should carry exactly one ${verb} statement`).toHaveLength(1);
  return found[0];
}

const columnsOf = (table: string) =>
  (t.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

const indexesOf = (table: string) =>
  t.sqlite.prepare(`PRAGMA index_list(${table})`).all() as { name: string; unique: number }[];

/** The seeded value, read ONCE before any test mutates the settings row. */
let seededOnboardingFlag: string | null = null;

beforeAll(async () => {
  t = await openTempDb("v370", { seed: true });
  seededOnboardingFlag = (t.sqlite
    .prepare("SELECT onboarding_completed_at AS o FROM settings LIMIT 1")
    .get() as { o: string | null }).o;
});

afterAll(() => t?.cleanup());

describe("all four migrations apply to a fresh migrated database", () => {
  it("is journalled — every migration file has an entry drizzle actually runs", () => {
    // A hand-written migration with no _journal.json entry is silently skipped
    // (migrations 0027+ carry no drizzle-kit snapshot), so the file can look
    // present while no install ever applies it.
    const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string; version: string; breakpoints: boolean }[];
    };
    const expected = [
      [55, "0055_trade-reviewed-at"],
      [56, "0056_weekly-reviews"],
      [57, "0057_onboarding-flag"],
      [58, "0058_advance-tax-challans"],
    ] as const;
    for (const [idx, tag] of expected) {
      const entry = journal.entries.find((e) => e.tag === tag);
      expect(entry, `${tag} is not in _journal.json — nothing would apply it`).toBeTruthy();
      expect(entry!.idx).toBe(idx);
      expect(entry!.version).toBe("6");
      expect(entry!.breakpoints).toBe(true);
      expect(fs.existsSync(path.join(migrationsDir, `${tag}.sql`))).toBe(true);
    }
    // Journal order is what the migrator walks; a gap or a repeat reorders it.
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });

  it("0055 puts reviewed_at on trades", () => {
    expect(columnsOf("trades")).toContain("reviewed_at");
  });

  it("0056 creates weekly_reviews with a UNIQUE (account, week) index", () => {
    expect(columnsOf("weekly_reviews").sort()).toEqual(
      ["account_id", "completed_at", "created_at", "id", "note", "score_at_completion", "updated_at", "week_start"],
    );
    const uq = indexesOf("weekly_reviews").find((i) => i.name === "weekly_reviews_account_week_uq");
    expect(uq, "the (account, week) index is missing").toBeTruthy();
    expect(uq!.unique).toBe(1);
  });

  it("0057 puts onboarding_completed_at on settings", () => {
    expect(columnsOf("settings")).toContain("onboarding_completed_at");
  });

  it("0058 creates advance_tax_challans with a NON-unique (account, fy) index", () => {
    expect(columnsOf("advance_tax_challans").sort()).toEqual(
      ["account_id", "amount_paise", "bsr_code", "challan_serial", "created_at", "fy", "id", "note", "paid_on", "updated_at"],
    );
    const idx = indexesOf("advance_tax_challans").find((i) => i.name === "advance_tax_challans_account_fy_idx");
    expect(idx, "the (account, fy) lookup index is missing").toBeTruthy();
    // Deliberately NOT unique: a challan serial is unique only per BSR code and
    // both are optional, so two payments can look identical and both be real.
    expect(idx!.unique).toBe(0);
    expect(indexesOf("advance_tax_challans").some((i) => i.unique === 1)).toBe(false);
  });
});

describe("0055 backfill — evidence of a review, never an invented one", () => {
  /** The row's own last-touch, back-dated so "now" can never impersonate it. */
  const LONG_AGO = "2019-04-11 09:15:00";

  it("marks noted / mistake-tagged / exit-triggered CLOSED trades and leaves a bare one NULL", () => {
    t.db.delete(t.schema.trades).run();
    const ids = {
      noted: 0, tagged: 0, triggered: 0, bare: 0, emptyTags: 0, blankNote: 0,
      openNoted: 0, newlineNote: 0, tabNote: 0, crlfNote: 0, spacedEmptyTags: 0, newlineEmptyTags: 0,
    };
    const add = (over: Record<string, unknown>) =>
      t.db.insert(t.schema.trades).values(tradeRow({ isOpen: false, ...over }) as never)
        .returning({ id: t.schema.trades.id }).get()!.id;
    /** Write a text column verbatim — drizzle's JSON codec would re-serialise it. */
    const raw = (id: number, col: string, value: string) =>
      t.sqlite.prepare(`UPDATE trades SET ${col} = ? WHERE id = ?`).run(value, id);

    ids.noted = add({ symbol: "NOTED", notes: "Held through the gap; too big." });
    ids.tagged = add({ symbol: "TAGGED", mistakeTags: ["oversized"] });
    ids.triggered = add({ symbol: "TRIGGERED", exitTrigger: "panic" });
    ids.bare = add({ symbol: "BARE" });
    // The two shapes an imported book is full of, and which must NOT count as
    // evidence: an empty JSON array, and whitespace typed then deleted.
    ids.emptyTags = add({ symbol: "EMPTYTAGS", mistakeTags: [] });
    ids.blankNote = add({ symbol: "BLANKNOTE", notes: "   " });
    // A trade the user is STILL HOLDING, journalled with a thesis. Evidence of
    // journalling, but not of a review: the desk reviews finished trades, and
    // nothing clears the stamp when a position closes, so a stamp here would
    // delete this trade from the queue forever and count it in the Process
    // Score's `reviewed` component having never been reviewed.
    ids.openNoted = add({ symbol: "OPENNOTED", isOpen: true, notes: "Thesis: holding into the result." });
    // Whitespace that SQLite's one-argument trim() does NOT strip (it takes
    // U+0020 and nothing else). Unreachable from the app — the journal route
    // JS-trims and writes null for an empty array — so the exposure is a
    // hand-edited or restored envelope, which is exactly what a backfill meets.
    ids.newlineNote = add({ symbol: "NLNOTE" });
    raw(ids.newlineNote, "notes", "\n");
    ids.tabNote = add({ symbol: "TABNOTE" });
    raw(ids.tabNote, "notes", "\t");
    ids.crlfNote = add({ symbol: "CRLFNOTE" });
    raw(ids.crlfNote, "exit_trigger", "\r\n");
    ids.spacedEmptyTags = add({ symbol: "SPACEDTAGS" });
    raw(ids.spacedEmptyTags, "mistake_tags", "[ ]");
    ids.newlineEmptyTags = add({ symbol: "NLTAGS" });
    raw(ids.newlineEmptyTags, "mistake_tags", "[]\n");

    // Pre-backfill state (the migrated DB already added the column).
    t.sqlite.prepare("UPDATE trades SET reviewed_at = NULL").run();
    // Back-date every row's last-touch BEFORE running the backfill. Both
    // created_at and updated_at default to datetime('now') at SECOND
    // granularity and these rows were inserted in the same second the backfill
    // runs — so `SET reviewed_at = datetime('now')`, the exact thing the
    // migration header forbids, would satisfy r == u and the assertion below
    // would stay green on the broken statement. A fixed past literal is what
    // separates "the row's own last-touched time" from "the day of the
    // upgrade", and dating a years-old book to upgrade day is what marks a
    // whole book reviewed today and poisons the Process Score.
    t.sqlite.prepare("UPDATE trades SET updated_at = ?").run(LONG_AGO);
    t.sqlite.prepare(statementStartingWith("0055_trade-reviewed-at.sql", "UPDATE")).run();

    const at = (id: number) =>
      (t.sqlite.prepare("SELECT reviewed_at AS r, updated_at AS u, created_at AS c FROM trades WHERE id = ?").get(id) as
        { r: string | null; u: string | null; c: string | null });

    expect(at(ids.noted).r).toBeTruthy();
    expect(at(ids.tagged).r).toBeTruthy();
    expect(at(ids.triggered).r).toBeTruthy();
    // Blank means UNREVIEWED (invariant 6) — the queue is exactly these rows.
    expect(at(ids.bare).r).toBeNull();
    expect(at(ids.emptyTags).r).toBeNull();
    expect(at(ids.blankNote).r).toBeNull();
    // A review is of a FINISHED trade.
    expect(at(ids.openNoted).r, "an OPEN trade was stamped — it can never re-enter the queue").toBeNull();
    // Whitespace is not evidence, in every spelling SQLite's trim() misses.
    expect(at(ids.newlineNote).r, 'notes = "\\n" counted as journalling').toBeNull();
    expect(at(ids.tabNote).r, 'notes = "\\t" counted as journalling').toBeNull();
    expect(at(ids.crlfNote).r, 'exit_trigger = "\\r\\n" counted as journalling').toBeNull();
    expect(at(ids.spacedEmptyTags).r, "mistake_tags = '[ ]' counted as journalling").toBeNull();
    expect(at(ids.newlineEmptyTags).r, "mistake_tags = '[]\\n' counted as journalling").toBeNull();

    // The stamp is the row's OWN last-touched time, never "now": a migration
    // must not date years-old journalling to the day of the upgrade. Asserted
    // against the literal, not against `u` — see the back-dating note above.
    expect(at(ids.noted).r).toBe(LONG_AGO);
    expect(at(ids.tagged).r).toBe(LONG_AGO);
    expect(at(ids.triggered).r).toBe(LONG_AGO);
  });

  it("stamps a journalled position only once it CLOSES — it was never reviewed as a closed trade", () => {
    // The same row, before and after the close, through the real statement.
    t.db.delete(t.schema.trades).run();
    const id = t.db.insert(t.schema.trades)
      .values(tradeRow({ symbol: "STILLHELD", isOpen: true, notes: "sized for the gap" }) as never)
      .returning({ id: t.schema.trades.id }).get()!.id;
    const run = () => t.sqlite.prepare(statementStartingWith("0055_trade-reviewed-at.sql", "UPDATE")).run();
    const stamp = () =>
      (t.sqlite.prepare("SELECT reviewed_at AS r FROM trades WHERE id = ?").get(id) as { r: string | null }).r;

    t.sqlite.prepare("UPDATE trades SET reviewed_at = NULL, updated_at = ?").run(LONG_AGO);
    run();
    expect(stamp()).toBeNull();

    // The close writes is_open only — commit.ts and the close dialog never
    // touch reviewed_at, which is why the open row had to stay NULL.
    t.sqlite.prepare("UPDATE trades SET is_open = 0 WHERE id = ?").run(id);
    run();
    expect(stamp()).toBe(LONG_AGO);
  });

  it("does not re-stamp a row that already carries a review time", () => {
    t.db.delete(t.schema.trades).run();
    const id = t.db.insert(t.schema.trades).values(tradeRow({ symbol: "ALREADY", notes: "reviewed long ago" }) as never)
      .returning({ id: t.schema.trades.id }).get()!.id;
    t.sqlite.prepare("UPDATE trades SET reviewed_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(id);

    t.sqlite.prepare(statementStartingWith("0055_trade-reviewed-at.sql", "UPDATE")).run();

    expect((t.sqlite.prepare("SELECT reviewed_at AS r FROM trades WHERE id = ?").get(id) as { r: string }).r)
      .toBe("2026-01-01T00:00:00Z");
  });

  it("reviewedAt is on the /trades wire shape but NOT on the /lenses projection", async () => {
    // The marker renders on /trades without a fetch; /lenses groups and
    // aggregates and never shows a per-trade review state, and its projection
    // is being REDUCED in v3.7, not widened.
    expect(SLIM_TRADE_FIELDS as readonly string[]).toContain("reviewedAt");
    const lensSrc = fs.readFileSync(path.join(process.cwd(), "lib", "queries", "trades.ts"), "utf8");
    const lensBlock = lensSrc.slice(lensSrc.indexOf("const LENS_FIELDS"), lensSrc.indexOf("export type LensRowTrade"));
    expect(lensBlock).not.toContain("reviewedAt");
  });
});

describe("0057 backfill — a book means the wizard is owed to nobody", () => {
  const runBackfill = () => t.sqlite.prepare(statementStartingWith("0057_onboarding-flag.sql", "UPDATE")).run();
  const flag = () =>
    (t.sqlite.prepare("SELECT onboarding_completed_at AS o FROM settings LIMIT 1").get() as { o: string | null }).o;

  it("stamps an install that already holds trades", () => {
    t.db.delete(t.schema.trades).run();
    t.db.insert(t.schema.trades).values(tradeRow({ symbol: "HASBOOK" }) as never).run();
    t.sqlite.prepare("UPDATE settings SET onboarding_completed_at = NULL").run();

    runBackfill();
    expect(flag()).toBeTruthy();
  });

  it("leaves a zero-trade install NULL — the wizard is exactly who it is for", () => {
    t.db.delete(t.schema.trades).run();
    t.sqlite.prepare("UPDATE settings SET onboarding_completed_at = NULL").run();

    runBackfill();
    expect(flag()).toBeNull();
  });

  it("the dev/e2e seed profile stamps it, so a shared e2e database never blocks a spec", () => {
    // This database was seeded by openTempDb with VYUHA_SEED_CLEAN unset — the
    // dev/e2e profile. The DESKTOP TEMPLATE (CLEAN=1) must leave it NULL; that
    // branch is asserted at the source here because flipping the env would need
    // a module reset, which would rebind lib/db to a second connection (see
    // helpers/temp-db.ts). tests/onboarding.test.ts owns the live CLEAN case.
    // Read in beforeAll: the backfill tests above deliberately null the column.
    expect(seededOnboardingFlag).toBeTruthy();
    const src = fs.readFileSync(path.join(process.cwd(), "lib", "db", "seed-core.ts"), "utf8");
    expect(src).toContain("onboardingCompletedAt: CLEAN ? null :");
  });
});

describe("0056 weekly_reviews — one review per book per week", () => {
  it("rejects a second row for the same (account, week)", () => {
    t.db.delete(t.schema.weeklyReviews).run();
    t.db.insert(t.schema.weeklyReviews).values({ accountId: 1, weekStart: "2026-08-31", note: "first" }).run();

    // The week does not happen twice — a second write is an EDIT, and the
    // schema is what stops two rows from disagreeing about one week.
    expect(() =>
      t.db.insert(t.schema.weeklyReviews).values({ accountId: 1, weekStart: "2026-08-31", note: "second" }).run(),
    ).toThrow(/UNIQUE/i);

    // Same week, DIFFERENT book: two accounts each get their own review.
    t.db.insert(t.schema.accounts).values({ id: 2, name: "Swing", isDefault: false }).onConflictDoNothing().run();
    t.db.insert(t.schema.weeklyReviews).values({ accountId: 2, weekStart: "2026-08-31", note: "other book" }).run();
    expect(t.db.select().from(t.schema.weeklyReviews).all()).toHaveLength(2);
  });

  it("an open week is a row with no completion and no score — not a zero", () => {
    t.db.delete(t.schema.weeklyReviews).run();
    t.db.insert(t.schema.weeklyReviews).values({ accountId: 1, weekStart: "2026-09-07", note: "mid-week" }).run();
    const row = t.db.select().from(t.schema.weeklyReviews).all()[0];
    // Under the floor the Process Score refuses to exist; storing 0 would
    // fabricate a score the user was never shown (invariant 6).
    expect(row.completedAt).toBeNull();
    expect(row.scoreAtCompletion).toBeNull();
    expect(row.createdAt).toBeTruthy();
    expect(row.updatedAt).toBeTruthy();
  });
});

describe("0058 advance_tax_challans — no natural key, and paise at rest", () => {
  it("accepts two identical-looking rows, because both can be real payments", () => {
    t.db.delete(t.schema.advanceTaxChallans).run();
    const row = { accountId: 1, fy: "2026-27", paidOn: "2026-06-14", amount: 25000 };
    t.db.insert(t.schema.advanceTaxChallans).values(row).run();
    // A serial is unique only per BSR code and both are optional, so the schema
    // cannot refuse this; the EDITOR warns instead. A unique key here would
    // silently lose a second genuine payment of the same amount on the same day.
    expect(() => t.db.insert(t.schema.advanceTaxChallans).values(row).run()).not.toThrow();
    expect(t.db.select().from(t.schema.advanceTaxChallans).all()).toHaveLength(2);
  });

  it("stores money as INTEGER paise and reads it back as rupees (invariant 1)", () => {
    t.db.delete(t.schema.advanceTaxChallans).run();
    t.db.insert(t.schema.advanceTaxChallans).values({
      accountId: 1, fy: "2026-27", paidOn: "2026-09-15", amount: 45000.55,
    }).run();

    const raw = t.sqlite.prepare("SELECT amount_paise AS p FROM advance_tax_challans LIMIT 1").get() as { p: number };
    expect(raw.p).toBe(4500055);
    expect(Number.isInteger(raw.p)).toBe(true);
    // Converting again in application code is the 100× bug.
    expect(t.db.select().from(t.schema.advanceTaxChallans).all()[0].amount).toBe(45000.55);
  });

  it("refuses a row missing the facts that make it a payment", () => {
    // fy, paid_on and amount are NOT NULL: a challan without a date is not a
    // dated challan, and the whole point of the table is paid-AS-OF.
    expect(() =>
      t.sqlite.prepare("INSERT INTO advance_tax_challans (account_id, fy, amount_paise) VALUES (1, '2026-27', 100)").run(),
    ).toThrow(/NOT NULL/i);
  });
});

describe("the v3.7 tables follow the book through a merge, and a purge keeps the prose", () => {
  // Account deletion is where a new scoped table is most easily forgotten: the
  // rows simply stay behind, pointing at an account that no longer exists.
  const SRC = 10, TGT = 11, DOOMED = 12;

  it("merge: reviews and challans MOVE, and a week both books reviewed keeps the target's row with the source's note appended", async () => {
    const mod = await import("@/lib/queries/account-delete");
    t.db.delete(t.schema.weeklyReviews).run();
    t.db.delete(t.schema.advanceTaxChallans).run();
    t.db.insert(t.schema.accounts).values([{ id: SRC, name: "Source" }, { id: TGT, name: "Target" }]).run();

    t.db.insert(t.schema.weeklyReviews).values([
      { accountId: SRC, weekStart: "2026-08-31", note: "source note" },
      { accountId: TGT, weekStart: "2026-08-31", note: "target note", completedAt: "2026-09-06T00:00:00Z", scoreAtCompletion: 71 },
      { accountId: SRC, weekStart: "2026-08-24", note: "moves whole" },
    ]).run();
    t.db.insert(t.schema.advanceTaxChallans).values({ accountId: SRC, fy: "2026-27", paidOn: "2026-06-14", amount: 25000 }).run();

    const preview = mod.previewAccountDelete({ accountId: SRC, mode: "merge", targetId: TGT });
    expect(preview.counts!.weeklyReviews).toBe(2);
    expect(preview.counts!.advanceTaxChallans).toBe(1);
    expect(preview.warnings!.join(" ")).toMatch(/appended/i);

    const res = mod.deleteAccount({ accountId: SRC, mode: "merge", targetId: TGT, connections: "delete" });
    expect(res.ok).toBe(true);

    const rows = t.db.select().from(t.schema.weeklyReviews).all();
    expect(rows).toHaveLength(2); // the shared week collapsed into the target's row
    expect(rows.every((r) => r.accountId === TGT)).toBe(true);
    const shared = rows.find((r) => r.weekStart === "2026-08-31")!;
    // Neither sentence is lost — the target's own text stays, the source's is
    // appended under a dated header rather than dropped.
    expect(shared.note).toContain("target note");
    expect(shared.note).toContain("source note");
    // Completion and the score AS SEEN are facts about the surviving book's
    // owner, so the target's survive untouched.
    expect(shared.completedAt).toBe("2026-09-06T00:00:00Z");
    expect(shared.scoreAtCompletion).toBe(71);

    const challans = t.db.select().from(t.schema.advanceTaxChallans).all();
    expect(challans).toHaveLength(1);
    expect(challans[0].accountId).toBe(TGT);
    expect(challans[0].amount).toBe(25000); // money survives the move unscaled
  });

  it("purge: the weekly notes are snapshotted and restore; the challans are deleted and are NOT", async () => {
    const mod = await import("@/lib/queries/account-delete");
    const trash = await import("@/lib/trash");
    const { trashDir } = await import("@/lib/db");
    t.db.delete(t.schema.weeklyReviews).run();
    t.db.delete(t.schema.advanceTaxChallans).run();
    t.db.insert(t.schema.accounts).values({ id: DOOMED, name: "Doomed" }).run();
    t.db.insert(t.schema.weeklyReviews).values({
      accountId: DOOMED, weekStart: "2026-08-17", note: "prose worth keeping", completedAt: "2026-08-23T00:00:00Z", scoreAtCompletion: 55,
    }).run();
    t.db.insert(t.schema.advanceTaxChallans).values({ accountId: DOOMED, fy: "2026-27", paidOn: "2026-12-15", amount: 12000 }).run();

    const res = mod.deleteAccount({ accountId: DOOMED, mode: "purge", connections: "delete" });
    expect(res.ok).toBe(true);
    expect(t.db.select().from(t.schema.weeklyReviews).all()).toHaveLength(0);
    expect(t.db.select().from(t.schema.advanceTaxChallans).all()).toHaveLength(0);

    const env = JSON.parse(fs.readFileSync(path.join(trashDir, res.snapshotId!, "snapshot.json"), "utf8")) as {
      accountRows: Record<string, Record<string, unknown>[]>;
    };
    expect(env.accountRows.weeklyReviews).toHaveLength(1);
    expect(env.accountRows.weeklyReviews[0].note).toBe("prose worth keeping");
    // Challans follow the b/f-lot rule: deleted with the account and NOT
    // snapshotted — the user holds the receipts they were transcribed from.
    expect(JSON.stringify(env)).not.toContain("advanceTaxChallans");
    expect(JSON.stringify(env)).not.toContain("2026-12-15");

    const back = trash.restoreTrashSnapshot(res.snapshotId!);
    expect(back.ok).toBe(true);
    const restored = t.db.select().from(t.schema.weeklyReviews).all();
    expect(restored).toHaveLength(1);
    expect(restored[0].note).toBe("prose worth keeping");
    expect(restored[0].accountId).toBe(DOOMED);
    expect(restored[0].scoreAtCompletion).toBe(55);
  });
});

describe("onboarding_completed_at is machine state on both restore paths", () => {
  it("is excluded from the settings BASELINE and redacted from BACKUPS", () => {
    expect(BASELINE_SETTINGS_FIELDS as readonly string[]).not.toContain("onboardingCompletedAt");
    expect(SETTINGS_MACHINE_COLUMNS as readonly string[]).toContain("onboardingCompletedAt");
  });
});
