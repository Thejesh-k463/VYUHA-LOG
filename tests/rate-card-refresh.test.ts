import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import type * as TS from "typescript";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { chargeConfig } from "@/lib/db/schema";
import { buildChargeConfigSeed, STT_EPOCH_2024, STT_EPOCH_2026 } from "@/lib/db/seed-data";
import { findRates, ratesMapOf } from "@/lib/engine/rates";
import type { ChargeRates } from "@/lib/engine/types";
import { refreshRateCards } from "../scripts/rate-card-refresh.mjs";

/**
 * The desktop sidecar's rate-card refresh (scripts/rate-card-refresh.mjs).
 *
 * Plain temp files over better-sqlite3 — NOT lib/db — because the unit under
 * test takes a raw connection, exactly as scripts/desktop-server.mjs hands it
 * one. The template is built here the way build-desktop.mjs builds the real
 * one: every migration in drizzle/, then the canonical seed's charge rows.
 *
 * The defect this pins (v3.2.0 → v4.2): the refresh keyed on four columns while
 * charge_config_uq had become five (migration 0050 added effective_from), so on
 * every launch the UPDATE collided on the unique index after the INSERT had
 * already autocommitted — the owner's DB ended with 45 overlapping open-ended
 * 1970 F&O epochs carrying the post-2026 STT.
 *
 * Since C-7 (v4.3.0) each F&O key carries THREE epochs (1970, 2024-10-01,
 * 2026-04-01). The owner's real DB still holds the old two, so the planted
 * states below delete the 2024-10-01 epoch first, and the refresh must add it
 * with no change to scripts/rate-card-refresh.mjs.
 *
 * The behaviour is a list of SCENARIOS, run once against the real module and
 * again against every mutant in the table at the bottom of this file: each
 * mutant must fail a named scenario, so a scenario that stops pinning its line
 * turns the table red instead of leaving the line unguarded.
 */

type Result = { added?: number; refreshed?: number; skipped?: string };
type Refresh = (db: Database.Database, template?: string) => Result;
/** A refreshRateCards — the real one, or a mutant loaded from source — with logging off. */
const bind =
  (fn: typeof refreshRateCards): Refresh =>
  (db, template = TEMPLATE) =>
    fn(db, template, () => {}) as Result;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-rate-refresh-"));
const TEMPLATE = path.join(dir, "template.sqlite");
/** (f)'s template: one rate corrected inside one epoch. */
const CORRECTED = path.join(dir, "template-corrected.sqlite");
const opened: Database.Database[] = [];
let n = 0;

function open(file: string, readonly = false): Database.Database {
  const db = new Database(file, readonly ? { readonly: true } : {});
  opened.push(db);
  return db;
}
function userCopy(from = TEMPLATE): Database.Database {
  const file = path.join(dir, `user-${++n}.sqlite`);
  fs.copyFileSync(from, file);
  return open(file);
}

/** Every column but the surrogate id and the write stamp, in identity order. */
function snapshot(db: Database.Database, where = "1"): unknown[] {
  const cols = (db.prepare("PRAGMA table_info(charge_config)").all() as { name: string }[])
    .map((c) => c.name)
    .filter((c) => c !== "id" && c !== "updated_at");
  return db
    .prepare(
      `SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM charge_config WHERE ${where}
       ORDER BY broker, plan, segment, exchange, effective_from`,
    )
    .all();
}
const count = (db: Database.Database) =>
  (db.prepare("SELECT count(*) AS n FROM charge_config").get() as { n: number }).n;
/** Keys (broker/plan/segment/exchange) holding more than one open-ended epoch. */
const overlaps = (db: Database.Database) =>
  (
    db
      .prepare(
        `SELECT count(*) AS n FROM (SELECT 1 FROM charge_config WHERE effective_to IS NULL
           GROUP BY broker, plan, segment, exchange HAVING count(*) > 1)`,
      )
      .get() as { n: number }
  ).n;

/**
 * Back to the pre-C-7 two-epoch key: every 1970 epoch of a multi-epoch key
 * takes the STT of the epoch starting `sttFrom` and ends at `to` (NULL = open),
 * then the 2024-10-01 epoch is deleted. Returns the number of 1970 rows rewritten.
 */
function collapse(db: Database.Database, sttFrom: string, to: string | null): number {
  const same = `n.broker = t.broker AND n.plan = t.plan AND n.segment = t.segment
                AND n.exchange = t.exchange AND n.effective_from = '${sttFrom}'`;
  const changed = db
    .prepare(
      `UPDATE charge_config AS t SET
         stt_pct = (SELECT n.stt_pct FROM charge_config n WHERE ${same}),
         stt_side = (SELECT n.stt_side FROM charge_config n WHERE ${same}),
         effective_to = ?
       WHERE t.effective_from = '1970-01-01' AND EXISTS (SELECT 1 FROM charge_config n WHERE ${same})`,
    )
    .run(to).changes;
  expect(db.prepare(`DELETE FROM charge_config WHERE effective_from = '${STT_EPOCH_2024}'`).run().changes).toBe(45);
  return changed;
}
/**
 * The owner's real state: two epochs per F&O key (no 2024-10-01 epoch), every
 * 1970 epoch carrying the 2026 epoch's STT and an open effective_to.
 */
const plantOwnerState = (db: Database.Database) => collapse(db, STT_EPOCH_2026, null);
/** The CORRECT two-epoch state (the v3.2.0..v4.2 template): 1970 → 2026-04-01 at the FY25 STT. */
const plantFy25State = (db: Database.Database) => collapse(db, STT_EPOCH_2024, STT_EPOCH_2026);

type Key = { broker: string; plan: string; segment: string; exchange: string };
const DHAN: Key = { broker: "dhan", plan: "default", segment: "index_option", exchange: "NSE" };
const where = (k: Key, from?: string) =>
  `broker = '${k.broker}' AND plan = '${k.plan}' AND segment = '${k.segment}' AND exchange = '${k.exchange}'` +
  (from ? ` AND effective_from = '${from}'` : "");
const rowsOf = (db: Database.Database, k: Key, from?: string) =>
  db.prepare(`SELECT * FROM charge_config WHERE ${where(k, from)} ORDER BY effective_from`).all();

/**
 * The (e) shape: k's 1970 row becomes the user's own (user_edited, its window
 * ending at `to`, NULL = open) and k's later epochs (2024-10-01, 2026-04-01) are deleted.
 */
function ownThe1970Row(u: Database.Database, k: Key, to: string | null, extraSet = ""): void {
  expect(u.prepare(`DELETE FROM charge_config WHERE ${where(k)} AND effective_from > '1970-01-01'`).run().changes).toBe(2);
  const edited = u
    .prepare(`UPDATE charge_config SET user_edited = 1, effective_to = ?${extraSet} WHERE ${where(k, "1970-01-01")}`)
    .run(to).changes;
  expect(edited).toBe(1);
}

let tpl: Database.Database;
let corrected: Database.Database;
let correctedChanged = 0;

beforeAll(() => {
  const t = open(TEMPLATE);
  migrate(drizzle(t), { migrationsFolder: path.resolve(__dirname, "../drizzle") });
  const d = drizzle(t);
  for (const row of buildChargeConfigSeed()) d.insert(chargeConfig).values(row).run();
  t.close();
  tpl = open(TEMPLATE, true);

  fs.copyFileSync(TEMPLATE, CORRECTED);
  const c = open(CORRECTED);
  correctedChanged = c
    .prepare(
      `UPDATE charge_config SET exchange_txn_pct = 0.00012345 WHERE broker = 'zerodha' AND plan = 'default'
         AND segment = 'future' AND exchange = 'NSE' AND effective_from = '${STT_EPOCH_2026}'`,
    )
    .run().changes;
  c.close();
  corrected = open(CORRECTED, true);
});

afterAll(() => {
  for (const db of opened) if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The scenarios: one planted user database, one refresh, what must hold after.

type Scenario = { id: string; title: string; run: (refresh: Refresh) => void };

/**
 * Runs `s`, then closes and deletes every user copy it opened (the mutant
 * table replays the whole list once per mutant). A scenario opens user copies
 * only — the templates are opened once, in beforeAll.
 */
function play(s: Scenario, refresh: Refresh): void {
  const mark = opened.length;
  try {
    s.run(refresh);
  } finally {
    for (const db of opened.splice(mark)) {
      if (db.open) db.close();
      if (path.basename(db.name).startsWith("user-")) {
        for (const x of ["", "-wal", "-shm"]) fs.rmSync(db.name + x, { force: true });
      }
    }
  }
}

/**
 * The user-edit guard is scoped by all four of broker/plan/segment/exchange: a
 * sibling key that differs from the user-edited key in exactly ONE column is
 * not the user's, so it still gains its missing epoch and still gets its
 * stale rate corrected. dhan sells one plan, so the plan sibling is kotakneo's
 * Pro plan beside its default one.
 */
const SIBLINGS: { column: keyof Key; edited: Key; sibling: Key }[] = [
  { column: "broker", edited: DHAN, sibling: { ...DHAN, broker: "zerodha" } },
  { column: "plan", edited: { ...DHAN, broker: "kotakneo" }, sibling: { ...DHAN, broker: "kotakneo", plan: "pro" } },
  { column: "segment", edited: DHAN, sibling: { ...DHAN, segment: "stock_option" } },
  { column: "exchange", edited: DHAN, sibling: { ...DHAN, exchange: "BSE" } },
];

const SCENARIOS: Scenario[] = [
  {
    id: "(a)",
    title: "a fresh install (user = the template) refreshes nothing and does not throw",
    run: (refresh) => {
      const u = userCopy();
      expect(refresh(u)).toEqual({ added: 0, refreshed: 0 });
      expect(snapshot(u)).toEqual(snapshot(tpl));
    },
  },
  {
    id: "(b)",
    title:
      "the owner's real state (two epochs, 45 corrupted 1970 rows): the 2024 epoch is added, the 1970 rows corrected, overlaps gone, each era priced at its own STT",
    run: (refresh) => {
      const u = userCopy();
      expect(plantOwnerState(u)).toBe(45);
      expect(overlaps(u)).toBe(45); // the planted state really has the defect

      expect(refresh(u)).toEqual({ added: 45, refreshed: 45 });
      expect(snapshot(u)).toEqual(snapshot(tpl));
      expect(overlaps(u)).toBe(0);

      const tplStt = (from: string) => (rowsOf(tpl, DHAN, from)[0] as { stt_pct: number }).stt_pct;
      const oldStt = tplStt("1970-01-01");
      const fy25Stt = tplStt(STT_EPOCH_2024);
      const newStt = tplStt(STT_EPOCH_2026);
      expect(new Set([oldStt, fy25Stt, newStt]).size).toBe(3);

      const map = ratesMapOf(drizzle(u).select().from(chargeConfig).all() as unknown as ChargeRates[]);
      expect(findRates(map, "dhan", "index_option", "NSE", "2024-09-30").sttPct).toBe(oldStt);
      expect(findRates(map, "dhan", "index_option", "NSE", "2026-03-15").sttPct).toBe(fy25Stt);
      expect(findRates(map, "dhan", "index_option", "NSE", "2026-04-15").sttPct).toBe(newStt);
    },
  },
  {
    id: "(b2)",
    title: "the correct two-epoch state (1970 → 2026-04-01 at the FY25 STT): the 2024 epoch is added and the 1970 row split at 2024-10-01",
    run: (refresh) => {
      const u = userCopy();
      expect(plantFy25State(u)).toBe(45);
      expect(overlaps(u)).toBe(0);
      const was = rowsOf(u, DHAN, "1970-01-01") as { stt_pct: number; effective_to: string }[];
      expect(was).toMatchObject([{ effective_to: STT_EPOCH_2026 }]);

      expect(refresh(u)).toEqual({ added: 45, refreshed: 45 });
      expect(snapshot(u)).toEqual(snapshot(tpl));
      expect(overlaps(u)).toBe(0);
      // The FY25 rate the 1970 row carried now lives on the 2024 epoch.
      expect(rowsOf(u, DHAN, STT_EPOCH_2024)).toMatchObject([{ stt_pct: was[0].stt_pct, effective_to: STT_EPOCH_2026 }]);
      expect(rowsOf(u, DHAN, "1970-01-01")).toMatchObject([{ effective_to: STT_EPOCH_2024 }]);
    },
  },
  {
    id: "(c)",
    title: "the pre-v3.2 shape (one open 1970 row per key at current rates) gains both later epochs, no overlaps",
    run: (refresh) => {
      const u = userCopy();
      expect(plantOwnerState(u)).toBe(45);
      u.prepare(`DELETE FROM charge_config WHERE effective_from = '${STT_EPOCH_2026}'`).run();
      expect(count(u)).toBe(count(tpl) - 90);

      expect(refresh(u)).toEqual({ added: 90, refreshed: 45 });
      expect(snapshot(u)).toEqual(snapshot(tpl));
      expect(overlaps(u)).toBe(0);
    },
  },
  {
    id: "(d)",
    title: "is idempotent: a second launch refreshes nothing",
    run: (refresh) => {
      const u = userCopy();
      plantOwnerState(u);
      expect(refresh(u)).toEqual({ added: 45, refreshed: 45 });
      expect(refresh(u)).toEqual({ added: 0, refreshed: 0 });
      expect(snapshot(u)).toEqual(snapshot(tpl));
    },
  },
  {
    id: "(e)",
    title: "a user-edited open row stays byte-identical and no seed epoch is inserted beside it",
    run: (refresh) => {
      const u = userCopy();
      ownThe1970Row(u, DHAN, null, ", stt_pct = 0.0042");
      const before = rowsOf(u, DHAN);
      expect(before).toHaveLength(1);

      expect(refresh(u)).toEqual({ added: 0, refreshed: 0 });
      expect(rowsOf(u, DHAN)).toEqual(before);
    },
  },
  {
    id: "(e2)",
    title: "a non-edited epoch covered by a user-edited window is not refreshed either (seed-core parity)",
    run: (refresh) => {
      const u = userCopy();
      u.prepare(`UPDATE charge_config SET stt_pct = 0.0099 WHERE ${where(DHAN, STT_EPOCH_2026)}`).run();
      u.prepare(`UPDATE charge_config SET user_edited = 1, effective_to = NULL WHERE ${where(DHAN, "1970-01-01")}`).run();
      const before = rowsOf(u, DHAN);

      expect(refresh(u)).toEqual({ added: 0, refreshed: 0 });
      expect(rowsOf(u, DHAN)).toEqual(before);
    },
  },
  {
    id: "(e3)",
    title: "a CLOSED user-edited window is exclusive-to: the seed epoch starting on its effective_to is added",
    run: (refresh) => {
      const u = userCopy();
      ownThe1970Row(u, DHAN, STT_EPOCH_2026);
      const before = rowsOf(u, DHAN, "1970-01-01");

      expect(refresh(u)).toEqual({ added: 1, refreshed: 0 });
      expect(rowsOf(u, DHAN, "1970-01-01")).toEqual(before);
      expect(rowsOf(u, DHAN, STT_EPOCH_2024)).toHaveLength(0); // inside the user's window: theirs
      const epoch = where(DHAN, STT_EPOCH_2026);
      expect(snapshot(u, epoch)).toHaveLength(1);
      expect(snapshot(u, epoch)).toEqual(snapshot(tpl, epoch));
    },
  },
  {
    id: "(e4)",
    title: "a CLOSED user-edited window that COVERS the seed epoch owns it: nothing added, nothing refreshed",
    run: (refresh) => {
      const u = userCopy();
      ownThe1970Row(u, DHAN, "2026-06-01");
      const before = rowsOf(u, DHAN);
      expect(before).toHaveLength(1);

      expect(refresh(u)).toEqual({ added: 0, refreshed: 0 });
      expect(rowsOf(u, DHAN)).toEqual(before);
    },
  },
  {
    id: "(e5)",
    title: "a closed user-edited window that ENDED BEFORE the seed epoch does not own it: the epoch is added",
    run: (refresh) => {
      const u = userCopy();
      ownThe1970Row(u, DHAN, "2026-01-01");
      const before = rowsOf(u, DHAN, "1970-01-01");

      expect(refresh(u)).toEqual({ added: 1, refreshed: 0 });
      expect(rowsOf(u, DHAN, "1970-01-01")).toEqual(before);
      expect(rowsOf(u, DHAN, STT_EPOCH_2024)).toHaveLength(0); // starts inside the user's window: theirs
      const epoch = where(DHAN, STT_EPOCH_2026);
      expect(snapshot(u, epoch)).toHaveLength(1);
      expect(snapshot(u, epoch)).toEqual(snapshot(tpl, epoch));
    },
  },
  {
    id: "(e6)",
    title: "a user-edited row is never rewritten, even one whose own window is empty (effective_to = effective_from)",
    run: (refresh) => {
      const u = userCopy();
      const edited = u
        .prepare(
          `UPDATE charge_config SET user_edited = 1, stt_pct = 0.0042, effective_to = effective_from
           WHERE ${where(DHAN, STT_EPOCH_2026)}`,
        )
        .run().changes;
      expect(edited).toBe(1);
      const before = rowsOf(u, DHAN);

      expect(refresh(u)).toEqual({ added: 0, refreshed: 0 });
      expect(rowsOf(u, DHAN)).toEqual(before);
    },
  },
  ...SIBLINGS.map(
    ({ column, edited, sibling }): Scenario => ({
      id: `(e7-${column})`,
      title: `the user-edit guard is scoped by ${column}: a key differing from the user-edited one only in ${column} still gains its epoch and its correction`,
      run: (refresh) => {
        const differ = (Object.keys(edited) as (keyof Key)[]).filter((c) => edited[c] !== sibling[c]);
        expect(differ).toEqual([column]);
        for (const k of [edited, sibling]) expect(rowsOf(tpl, k), `${where(k)} in the template`).toHaveLength(3);

        const u = userCopy();
        ownThe1970Row(u, edited, null);
        const mine = rowsOf(u, edited);
        u.prepare(`DELETE FROM charge_config WHERE ${where(sibling, STT_EPOCH_2026)}`).run();
        const stale = u.prepare(`UPDATE charge_config SET stt_pct = 0.0099 WHERE ${where(sibling, "1970-01-01")}`).run();
        expect(stale.changes).toBe(1);

        expect(refresh(u)).toEqual({ added: 1, refreshed: 1 });
        expect(snapshot(u, where(sibling))).toEqual(snapshot(tpl, where(sibling)));
        expect(rowsOf(u, edited)).toEqual(mine);
      },
    }),
  ),
  {
    id: "(f)",
    title: "a correction inside one epoch refreshes exactly that row",
    run: (refresh) => {
      expect(correctedChanged).toBe(1);
      const u = userCopy();
      const was = snapshot(u) as Record<string, unknown>[];
      expect(refresh(u, CORRECTED)).toEqual({ added: 0, refreshed: 1 });
      const now = snapshot(u) as Record<string, unknown>[];
      const diff = now.filter((r, i) => JSON.stringify(r) !== JSON.stringify(was[i]));
      expect(diff).toHaveLength(1);
      expect(diff[0]).toMatchObject({ broker: "zerodha", segment: "future", exchange_txn_pct: 0.00012345 });
      expect(now).toEqual(snapshot(corrected));
    },
  },
  {
    id: "(g)",
    title: "is atomic: an UPDATE that aborts rolls the INSERT back too",
    run: (refresh) => {
      const u = userCopy();
      u.prepare(
        `DELETE FROM charge_config WHERE broker = 'groww' AND plan = 'default' AND segment = 'future'
           AND exchange = 'NSE' AND effective_from = '${STT_EPOCH_2026}'`,
      ).run();
      u.prepare(
        `UPDATE charge_config SET brokerage_pct = 0.5 WHERE broker = 'zerodha' AND segment = 'eq_delivery' AND exchange = 'NSE'`,
      ).run();
      u.exec(`CREATE TRIGGER planted_abort BEFORE UPDATE ON charge_config BEGIN SELECT RAISE(ABORT, 'planted abort'); END;`);
      const rows = count(u);

      expect(() => refresh(u)).toThrow(/planted abort/);
      expect(count(u)).toBe(rows);
      // The template was detached on the way out, so the next launch can attach it.
      const dbs = (u.prepare("PRAGMA database_list").all() as { name: string }[]).map((d) => d.name);
      expect(dbs).not.toContain("seedtpl");
    },
  },
  {
    id: "(j)",
    title: "KEY comes from charge_config_uq: no index means a skip, not a guess",
    run: (refresh) => {
      const u = userCopy();
      plantOwnerState(u);
      u.exec("DROP INDEX charge_config_uq");
      const rows = count(u);
      const was = snapshot(u);
      const r = refresh(u);
      expect(r.skipped).toMatch(/charge_config_uq/);
      expect(count(u)).toBe(rows);
      expect(snapshot(u)).toEqual(was);
    },
  },
  {
    id: "(j2)",
    title: "a user DB still on the pre-0050 4-column index skips rather than pick an arbitrary epoch",
    run: (refresh) => {
      const u = userCopy();
      expect(u.prepare(`DELETE FROM charge_config WHERE effective_from > '1970-01-01'`).run().changes).toBe(90);
      u.exec(
        "DROP INDEX charge_config_uq; CREATE UNIQUE INDEX charge_config_uq ON charge_config (broker, plan, segment, exchange)",
      );
      const was = snapshot(u);
      const r = refresh(u);
      expect(r.skipped).toMatch(/not unique/);
      expect(snapshot(u)).toEqual(was);
    },
  },
  {
    id: "(k)",
    title: "a difference that is only NULL against a value still counts (null-safe IS NOT): the row is refreshed",
    run: (refresh) => {
      const u = userCopy();
      const row = where(DHAN, "1970-01-01");
      expect(snapshot(tpl, row)).toMatchObject([{ effective_to: STT_EPOCH_2024 }]);
      expect(u.prepare(`UPDATE charge_config SET effective_to = NULL WHERE ${row}`).run().changes).toBe(1);

      expect(refresh(u)).toEqual({ added: 0, refreshed: 1 });
      expect(snapshot(u)).toEqual(snapshot(tpl));
    },
  },
  {
    id: "(l)",
    title: "rows that differ only in their write stamp (updated_at) are not rewritten",
    run: (refresh) => {
      const u = userCopy();
      u.prepare(`UPDATE charge_config SET updated_at = '2099-01-01 00:00:00'`).run();
      const stamps = () => u.prepare("SELECT id, updated_at FROM charge_config ORDER BY id").all();
      const was = stamps();

      expect(refresh(u)).toEqual({ added: 0, refreshed: 0 });
      expect(stamps()).toEqual(was);
    },
  },
  {
    id: "(m)",
    title: "the user DB numbers its rows its own way: rows match on the key, never on id, and every id stays put",
    run: (refresh) => {
      const u = userCopy();
      // Reverse the ids (1..N -> N..1): a real user DB's ids follow its own insert history.
      const max = (u.prepare("SELECT max(id) AS m FROM charge_config").get() as { m: number }).m;
      u.exec(`UPDATE charge_config SET id = -id; UPDATE charge_config SET id = ${max} + 1 + id;`);
      expect(plantOwnerState(u)).toBe(45);
      const ids = () =>
        u.prepare("SELECT id, broker, plan, segment, exchange, effective_from FROM charge_config ORDER BY id").all();
      const before = ids();

      expect(refresh(u)).toEqual({ added: 45, refreshed: 45 });
      // Every row that was there keeps its id; the 45 added 2024 epochs are the only new ones.
      const after = ids() as { effective_from: string }[];
      expect(after.filter((r) => r.effective_from !== STT_EPOCH_2024)).toEqual(before);
      expect(after.filter((r) => r.effective_from === STT_EPOCH_2024)).toHaveLength(45);
      expect(snapshot(u)).toEqual(snapshot(tpl));
    },
  },
];

const real = bind(refreshRateCards);

describe("the fixture is not vacuous", () => {
  it("the template holds 45 keys with three dated epochs (1970, 2024-10-01, 2026-04-01) and 72 with one, and the user index is 5 columns", () => {
    const shapes = tpl
      .prepare(
        `SELECT epochs, count(*) AS keys FROM (SELECT group_concat(effective_from, ' ') AS epochs FROM
           (SELECT * FROM charge_config ORDER BY effective_from) GROUP BY broker, plan, segment, exchange)
         GROUP BY epochs ORDER BY epochs`,
      )
      .all();
    expect(shapes).toEqual([
      { epochs: "1970-01-01", keys: 72 },
      { epochs: `1970-01-01 ${STT_EPOCH_2024} ${STT_EPOCH_2026}`, keys: 45 },
    ]);
    const idx = (tpl.prepare("PRAGMA index_info(charge_config_uq)").all() as { name: string }[]).map((c) => c.name);
    expect(idx).toEqual(["broker", "plan", "segment", "exchange", "effective_from"]);
  });
});

describe("refreshRateCards over epoch-dated rate cards", () => {
  for (const s of SCENARIOS) it(`${s.id} ${s.title}`, () => play(s, real));
});

// ---------------------------------------------------------------------------
// The launcher and the bundle, read as source (the sidecar cannot run here) —
// with comments stripped, so a commented-out call or copy line cannot satisfy a pin.

const root = path.resolve(__dirname, "..");
// Through Node's require, not an ESM import: vite would otherwise transform the
// 9 MB compiler bundle on every run (seconds, plus a missing-sourcemap error line).
const ts = createRequire(import.meta.url)("typescript") as typeof TS;

function parse(src: string): TS.SourceFile {
  return ts.createSourceFile("source.mjs", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}
const isJsDoc = (node: TS.Node) =>
  node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;

/**
 * Every comment in `src`, found by TypeScript's own lexer: the leading and
 * trailing trivia of every node AND token in the tree, deduped by position.
 * JSDoc nodes are not descended into — their positions lie inside a comment,
 * where scanning for trivia would read the comment's text as code.
 */
function commentRanges(src: string): TS.CommentRange[] {
  const sf = parse(src);
  const found = new Map<number, TS.CommentRange>();
  const visit = (node: TS.Node): void => {
    for (const r of ts.getLeadingCommentRanges(src, node.getFullStart()) ?? []) found.set(r.pos, r);
    for (const r of ts.getTrailingCommentRanges(src, node.getEnd()) ?? []) found.set(r.pos, r);
    for (const child of node.getChildren(sf)) if (!isJsDoc(child)) visit(child);
  };
  visit(sf);
  return [...found.values()].sort((a, b) => a.pos - b.pos);
}

/**
 * `src` with every comment blanked to spaces, newlines kept — so offsets and
 * line numbers are unchanged. Strings, template literals (nested ones too) and
 * regex literals are told apart by a real lexer, not a hand-written one: the
 * previous stripper flipped into string mode on a quote inside a regex literal.
 */
function stripComments(src: string): string {
  let out = "";
  let at = 0;
  for (const r of commentRanges(src)) {
    out += src.slice(at, r.pos) + src.slice(r.pos, r.end).replace(/[^\r\n]/g, " ");
    at = r.end;
  }
  return out + src.slice(at);
}

/** [start, end) of every string, template piece and regex literal in `src`. */
function literalSpans(src: string): [number, number][] {
  const sf = parse(src);
  const kinds = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.RegularExpressionLiteral,
  ]);
  const out: [number, number][] = [];
  const visit = (node: TS.Node): void => {
    if (kinds.has(node.kind)) out.push([node.getStart(sf), node.getEnd()]);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const rawLauncher = fs.readFileSync(path.join(root, "scripts", "desktop-server.mjs"), "utf8");
const rawBuilder = fs.readFileSync(path.join(root, "scripts", "build-desktop.mjs"), "utf8");
const launcher = stripComments(rawLauncher);
const builder = stripComments(rawBuilder);

describe("the comment stripper the (h) and (i) pins read through", () => {
  it("drops a commented-out call and keeps the live code and the line count around it", () => {
    const s = stripComments("a();\n// refreshRateCards(sqlite, seedTemplate);\nb(); // tail\n");
    expect(s).not.toMatch(/refreshRateCards|tail/);
    expect(s).toContain("a();");
    expect(s).toContain("b();");
    expect(s.split("\n")).toHaveLength(4);
  });

  it("keeps // and /* inside strings and template literals, escapes included", () => {
    const src = [
      `const u = "file://x";`,
      `const h = \`http://\${host}:\${port}/*not*/\`;`,
      `const e = 'it\\'s // still a string';`,
      `const q = "a \\" // b";`,
    ].join("\n");
    expect(stripComments(src)).toBe(src);
  });

  it("drops a block comment, keeping its newlines", () => {
    const s = stripComments("x = 1; /* one\n refreshRateCards(sqlite) */ y = 2;");
    expect(s).not.toMatch(/one|refreshRateCards/);
    expect(s).toMatch(/x = 1;\s+y = 2;/);
    expect(s.split("\n")).toHaveLength(2);
  });

  it("a quote-bearing regex literal does not flip it into string mode, and a backtick nested in ${} does not either", () => {
    const lines = [
      'const nm = String(dataDir).replace(/"/g, "");',
      "// refreshRateCards(sqlite, seedTemplate);",
      "const r = /[`'\"]/g; // tail",
      "const t = `a${`b // c`}d`;",
      "b();",
    ];
    const s = stripComments(lines.join("\n")).split("\n");
    expect(s).toHaveLength(5);
    expect(s[0]).toBe(lines[0]);
    expect(s[1].trim()).toBe("");
    expect(s[2].trimEnd()).toBe("const r = /[`'\"]/g;");
    expect(s[3]).toBe(lines[3]);
    expect(s[4]).toBe("b();");
  });

  it("the stripped launcher and builder keep their shape, hold no comment, and every // left sits inside a literal", () => {
    for (const [name, raw, stripped] of [
      ["launcher", rawLauncher, launcher],
      ["builder", rawBuilder, builder],
    ] as const) {
      expect(commentRanges(raw).length, `${name}: the raw file has comments to strip`).toBeGreaterThan(5);
      expect(stripped.length, name).toBe(raw.length);
      expect(stripped.split("\n").length, name).toBe(raw.split("\n").length);
      expect(commentRanges(stripped), `${name}: a comment survived stripping`).toEqual([]);
      const spans = literalSpans(stripped);
      for (const m of stripped.matchAll(/\/\/|\/\*/g)) {
        const inLiteral = spans.some(([a, b]) => m.index >= a && m.index < b);
        expect(inLiteral, `${name}: "${m[0]}" at offset ${m.index} is outside every literal`).toBe(true);
      }
    }
    // Not vacuous: the launcher's http:// template keeps a // that must be classed as a literal.
    expect(launcher).toContain("http://");
  });

  it("the stripped launcher and builder still hold the real call and the real copy line", () => {
    expect(launcher).toContain("refreshRateCards(sqlite, seedTemplate);");
    expect(launcher).toMatch(/console\.log\(`\[vyuha\] starting on http:\/\/\$\{process\.env\.HOSTNAME\}/);
    expect(builder).toContain(
      'fs.copyFileSync(path.join(root, "scripts", "rate-card-refresh.mjs"), path.join(dist, "rate-card-refresh.mjs"));',
    );
  });
});

/** Every try statement (from the parse tree): the try block's span, the whole statement's end, its catch and finally bodies. */
function tryStatements(src: string) {
  const sf = parse(src);
  const out: { start: number; end: number; stmtEnd: number; catchBody: string; finallyBody: string }[] = [];
  const visit = (node: TS.Node): void => {
    if (ts.isTryStatement(node)) {
      out.push({
        start: node.tryBlock.getStart(sf),
        end: node.tryBlock.getEnd(),
        stmtEnd: node.getEnd(),
        catchBody: node.catchClause?.block.getText(sf) ?? "",
        finallyBody: node.finallyBlock?.getText(sf) ?? "",
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("(h) the launcher isolates the refresh from the migration", () => {
  const stmts = tryStatements(launcher);
  const call = launcher.search(/refreshRateCards\(\s*sqlite/);
  const inside = (s: { start: number; end: number }) => call > s.start && call < s.end;
  const mig = stmts.filter((s) => s.catchBody.includes("migration step failed"));
  const own = stmts.filter((s) => s.catchBody.includes("rate-card refresh failed"));

  it("calls the refresh from the module, not an inline copy", () => {
    expect(call).toBeGreaterThan(-1);
    expect(launcher).not.toMatch(/function\s+refreshRateCards/);
  });

  it("the refresh call is NOT inside the try whose catch reports a migration failure", () => {
    expect(mig).toHaveLength(1);
    expect(inside(mig[0]), "refresh runs inside the migration try — its failure would be logged as a migration failure").toBe(false);
  });

  it("the refresh has its own catch, and sqlite.close() sits in a finally around it", () => {
    expect(own).toHaveLength(1);
    expect(inside(own[0])).toBe(true);
    const closer = stmts.filter((s) => s.finallyBody.includes("sqlite.close()"));
    expect(closer).toHaveLength(1);
    expect(inside(closer[0])).toBe(true);
  });

  it("the migration try ends before the refresh try begins — the refresh reads the migrated index", () => {
    expect(mig).toHaveLength(1);
    expect(own).toHaveLength(1);
    expect(mig[0].stmtEnd, "the refresh try sits above the migration try: it would key on an unmigrated charge_config_uq").toBeLessThan(
      own[0].start,
    );
  });
});

describe("(i) every module the launcher loads ships beside it", () => {
  it("build-desktop.mjs copies each relative .mjs the launcher imports", () => {
    const loaded = new Set<string>();
    for (const m of launcher.matchAll(/(?:from\s+|import\(\s*)["']\.\/([\w.-]+\.mjs)["']/g)) loaded.add(m[1]);
    for (const m of launcher.matchAll(/path\.join\(\s*here\s*,\s*["']([\w.-]+\.mjs)["']\s*\)/g)) loaded.add(m[1]);
    expect([...loaded]).toContain("rate-card-refresh.mjs");
    for (const f of loaded) {
      const esc = f.replace(/[.]/g, "\\.");
      const copy = new RegExp(
        `copyFileSync\\(\\s*path\\.join\\(root,\\s*"scripts",\\s*"${esc}"\\)\\s*,\\s*path\\.join\\(dist,\\s*"${esc}"\\)`,
      );
      expect(builder, `${f} is loaded by the launcher but not copied into desktop-dist`).toMatch(copy);
    }
  });

  it("an absolute path reaches import() only as a file:// URL — a bare one throws ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows", () => {
    const sf = parse(launcher);
    const specs: string[] = [];
    const bad: string[] = [];
    const visit = (node: TS.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const a = node.arguments[0];
        specs.push(a.getText(sf));
        const bareName = ts.isStringLiteral(a) && !/^([A-Za-z]:|[\\/])/.test(a.text);
        const fileUrl =
          ts.isPropertyAccessExpression(a) &&
          a.name.text === "href" &&
          ts.isCallExpression(a.expression) &&
          ts.isIdentifier(a.expression.expression) &&
          a.expression.expression.text === "pathToFileURL";
        if (!bareName && !fileUrl) bad.push(a.getText(sf));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(specs.some((s) => s.includes("rate-card-refresh.mjs")), specs.join(" | ")).toBe(true);
    expect(bad).toEqual([]);
    expect(launcher).toMatch(
      /await\s+import\(\s*pathToFileURL\(\s*path\.join\(\s*here\s*,\s*["']rate-card-refresh\.mjs["']\s*\)\s*\)\s*\.href\s*\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// The mutant table. Each mutant is one string replacement over the REAL source
// of scripts/rate-card-refresh.mjs; `from` must occur exactly once, so a
// refactor turns its row red instead of silently mutating nothing. The mutated
// module is written to the temp dir, imported, and replayed through every
// scenario above; it must fail the scenario named in `killedBy`.

type Mutant = { name: string; from: string; to: string };

const MUTANTS: (Mutant & { killedBy: string })[] = [
  { name: "guard: broker equality dropped", from: 'AND u."broker" = ${alias}."broker" AND', to: "AND", killedBy: "(e7-broker)" },
  { name: "guard: plan equality dropped", from: ' AND u."plan" IS ${alias}."plan"', to: "", killedBy: "(e7-plan)" },
  { name: "guard: segment equality dropped", from: 'AND u."segment" = ${alias}."segment" AND', to: "AND", killedBy: "(e7-segment)" },
  { name: "guard: exchange equality dropped", from: ' AND u."exchange" = ${alias}."exchange"', to: "", killedBy: "(e7-exchange)" },
  { name: "window: effective_to > becomes >=", from: 'u."effective_to" > ${alias}', to: 'u."effective_to" >= ${alias}', killedBy: "(e3)" },
  { name: "window: effective_to > becomes <", from: 'u."effective_to" > ${alias}', to: 'u."effective_to" < ${alias}', killedBy: "(e4)" },
  { name: "window: effective_to > becomes !=", from: 'u."effective_to" > ${alias}', to: 'u."effective_to" != ${alias}', killedBy: "(e5)" },
  { name: "window: the OR effective_to > from disjunct dropped", from: ' OR u."effective_to" > ${alias}."effective_from"', to: "", killedBy: "(e4)" },
  { name: "window: the effective_to IS NULL disjunct dropped", from: 'u."effective_to" IS NULL OR ', to: "", killedBy: "(e)" },
  { name: "guard: u.user_edited = 1 dropped", from: "u.user_edited = 1", to: "1 = 1", killedBy: "(b)" },
  { name: "update: t.user_edited = 0 dropped", from: "t.user_edited = 0", to: "1 = 1", killedBy: "(e6)" },
  { name: "differs: IS NOT becomes !=", from: "t.${q(c)} IS NOT s.${q(c)}", to: "t.${q(c)} != s.${q(c)}", killedBy: "(k)" },
  { name: "the transaction removed (INSERT and UPDATE run bare)", from: "sqlite.transaction(() => ({", to: "(() => ({", killedBy: "(g)" },
  { name: "the guard removed from the INSERT", from: 'WHERE ${guard("s")}', to: "WHERE 1", killedBy: "(e)" },
  { name: "the guard removed from the UPDATE", from: 'AND ${guard("t")}', to: "AND 1", killedBy: "(e2)" },
  {
    name: "KEY hard-coded to the old four columns",
    from: "const KEY = sqlite",
    to: 'const KEY = ["broker", "plan", "segment", "exchange"] || sqlite',
    killedBy: "(a)",
  },
  { name: "the ambiguity skip removed", from: "if (ambiguous > 0)", to: "if (false)", killedBy: "(j2)" },
  { name: "values: updated_at no longer excluded", from: ' && c !== "updated_at"', to: "", killedBy: "(l)" },
  { name: "shared: id no longer excluded", from: ' && c !== "id"', to: "", killedBy: "(m)" },
  { name: "DETACH removed from the finally", from: 'sqlite.prepare("DETACH seedtpl").run();', to: "void 0;", killedBy: "(d)" },
];

/**
 * Mutants no reachable state can tell apart from the original. Each still runs
 * the whole scenario list and must pass it — if a scenario ever kills one, the
 * claim was wrong and it belongs in MUTANTS.
 */
const EQUIVALENT: (Mutant & { reason: string })[] = [
  {
    name: "window: effective_from <= becomes <",
    from: 'u."effective_from" <= ${alias}',
    to: 'u."effective_from" < ${alias}',
    reason:
      "the boundary is a seed epoch with the SAME key and effective_from as a user-edited row — that is the row itself " +
      "(charge_config_uq covers all five columns, all NOT NULL): the INSERT is IGNOREd on the index and the UPDATE skips it by t.user_edited = 0",
  },
  {
    name: "guard: plan IS becomes =",
    from: 'u."plan" IS ${alias}',
    to: 'u."plan" = ${alias}',
    reason: "plan is NOT NULL in both databases, so IS and = agree on every row",
  },
  {
    name: "match: key IS becomes =",
    from: "`t.${q(k)} IS s.${q(k)}`",
    to: "`t.${q(k)} = s.${q(k)}`",
    reason: "every charge_config_uq column is NOT NULL in both databases, so IS and = agree on every row",
  },
];

describe("the mutant table: every mutant of rate-card-refresh.mjs fails a named scenario", () => {
  const src = fs.readFileSync(path.join(root, "scripts", "rate-card-refresh.mjs"), "utf8");
  const ids = SCENARIOS.map((s) => s.id);
  let loads = 0;

  async function load(code: string): Promise<Refresh> {
    const file = path.join(dir, `mutant-${++loads}.mjs`);
    fs.writeFileSync(file, code);
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
      refreshRateCards: typeof refreshRateCards;
    };
    return bind(mod.refreshRateCards);
  }
  function mutate(m: Mutant): string {
    expect(src.split(m.from).length - 1, `"${m.name}": its from-text must occur exactly once in the source`).toBe(1);
    const out = src.replace(m.from, () => m.to);
    expect(out, `"${m.name}" changes nothing`).not.toBe(src);
    return out;
  }
  function fails(s: Scenario, refresh: Refresh): boolean {
    try {
      play(s, refresh);
      return false;
    } catch {
      return true;
    }
  }
  /** The ids of every scenario this refresh fails. */
  const failing = (refresh: Refresh) => SCENARIOS.filter((s) => fails(s, refresh)).map((s) => s.id);

  it("control: the unmutated source, loaded the same way, passes every scenario", async () => {
    expect(failing(await load(src))).toEqual([]);
  });

  // The named scenario runs first; the full sweep runs only to say where a
  // mutant that escaped it IS killed, if anywhere — so the row can be corrected.
  it.each(MUTANTS)("$name -> killed by $killedBy", async (m) => {
    const named = SCENARIOS.find((s) => s.id === m.killedBy);
    expect(named, `${m.killedBy} names no scenario (ids: ${ids.join(" ")})`).toBeDefined();
    const refresh = await load(mutate(m));
    if (fails(named!, refresh)) return;
    const failed = failing(refresh);
    expect.fail(
      failed.length === 0
        ? `"${m.name}" SURVIVED every scenario`
        : `"${m.name}" survived ${m.killedBy}; it is killed by [${failed.join(", ")}] — correct the row`,
    );
  });

  it.each(EQUIVALENT)("equivalent: $name", async (m) => {
    expect(failing(await load(mutate(m))), `"${m.name}" was killed, so it is not equivalent: ${m.reason}`).toEqual([]);
  });
});
