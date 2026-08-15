import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, type TempDb } from "../helpers/temp-db";
import { countStatements, report, rng, time } from "./helpers/measure";

/**
 * B5 — the /backup page's row counts, and the restore path, at scale.
 *
 * `dbCounts()` renders on every `/backup` visit (force-dynamic) purely to
 * show "trades: 25,000 · audit: 100,000". Its implementation was
 * `db.select().from(table).all().length` for all 29 tables — every row of the
 * whole database materialised through Drizzle and thrown away for a number
 * SQLite can answer from the B-tree. Statement COUNT cannot see this (29
 * either way), so the instrument here is ROWS MATERIALISED: patch
 * better-sqlite3's `Statement#all` and total what comes back. `COUNT(*)`
 * materialises one row per table; `SELECT *` materialises the book.
 *
 * Seeded by raw SQL in one transaction (paise on the wire; nothing here is a
 * money assertion so the values are only plausible, not meaningful).
 */

let t: TempDb;
let backup: typeof import("@/lib/backup");

const TRADES = 25_000;
const AUDIT = 100_000;

beforeAll(async () => {
  t = await openTempDb("b5-backup", { seed: true });
  backup = await import("@/lib/backup");

  const rand = rng(0xb5);
  const insTrade = t.sqlite.prepare(
    `insert into trades (account_id, broker, bucket, segment, instrument_type, exchange, symbol, tradingsymbol, dedup_hash,
       buy_date, sell_date, is_open, net_pnl_paise, gross_pnl_paise, charges_total_paise)
     values (1, 'dhan', 'equity', 'eq_delivery', 'equity', 'NSE', ?, ?, ?, '2026-07-01', '2026-07-10', 0, ?, ?, ?)`,
  );
  const insAudit = t.sqlite.prepare(`insert into audit_log (entity, action, summary) values ('trade', 'update', ?)`);
  t.sqlite.transaction(() => {
    for (let i = 0; i < TRADES; i++) {
      const gross = Math.round((rand() - 0.45) * 1_000_000);
      insTrade.run(`S${i % 500}`, `S${i % 500}`, `b5-${i}`, gross - 1200, gross, 1200);
    }
    for (let i = 0; i < AUDIT; i++) insAudit.run(`edit ${i}`);
  })();
});
afterAll(() => t?.cleanup());

/** Total rows returned by every `Statement#all` while `fn` runs. */
function rowsMaterialised(fn: () => void): number {
  const stmtProto = Object.getPrototypeOf(t.sqlite.prepare("select 1")) as {
    all: (...a: unknown[]) => unknown[];
    get: (...a: unknown[]) => unknown;
  };
  const originalAll = stmtProto.all;
  const originalGet = stmtProto.get;
  let rows = 0;
  stmtProto.all = function patchedAll(this: unknown, ...args: unknown[]) {
    const out = originalAll.apply(this, args);
    rows += Array.isArray(out) ? out.length : 0;
    return out;
  };
  stmtProto.get = function patchedGet(this: unknown, ...args: unknown[]) {
    const out = originalGet.apply(this, args);
    if (out != null) rows += 1;
    return out;
  };
  try {
    fn();
  } finally {
    stmtProto.all = originalAll;
    stmtProto.get = originalGet;
  }
  return rows;
}

describe("B5 · /backup counts and restore at HEAVY tier", () => {
  it("dbCounts() does not materialise the book to take its length", () => {
    // Warm once so the first-call statement compile is not in the timing.
    backup.dbCounts();
    let counts: Record<string, number> = {};
    let rows = 0;
    const timing = time("dbCounts (25k trades + 100k audit)", TRADES + AUDIT, () => {
      rows = rowsMaterialised(() => { counts = backup.dbCounts(); });
    });
    const { statements } = countStatements(t.sqlite, () => backup.dbCounts());
    report(timing, { test: "b5-counts", rowsMaterialised: rows, statements });
    console.log(`    dbCounts: ${rows.toLocaleString()} rows materialised, ${statements} statements, ${timing.ms.toFixed(0)} ms`);

    expect(counts.trades).toBe(TRADES);
    expect(counts.audit_log).toBe(AUDIT);
    // One row per table is what a COUNT(*) costs; the number of tables is
    // whatever the format says, so allow a little slack above it.
    expect(
      rows,
      `dbCounts() materialised ${rows.toLocaleString()} rows to produce ${Object.keys(counts).length} numbers — it SELECTs every row of every table and takes .length, on every /backup render.`,
    ).toBeLessThan(Object.keys(counts).length * 2);
  });

  it("reports what a dump + restore of the same book costs (statements per row is the restore's shape)", () => {
    const dumpTiming = time("dumpDatabase (25k trades + 100k audit)", TRADES + AUDIT, () => backup.dumpDatabase(false));
    report(dumpTiming, { test: "b5-dump" });
    const dump = backup.dumpDatabase(false);
    let res: ReturnType<typeof backup.restoreDatabase> | null = null;
    let statements = 0;
    const restoreTiming = time("restoreDatabase (25k trades + 100k audit)", TRADES + AUDIT, () => {
      ({ statements } = countStatements(t.sqlite, () => { res = backup.restoreDatabase(dump); }));
    });
    report(restoreTiming, { test: "b5-restore", statements });
    console.log(`    dump ${dumpTiming.ms.toFixed(0)} ms · restore ${restoreTiming.ms.toFixed(0)} ms, ${statements.toLocaleString()} statements`);
    expect(res!.ok, res!.message).toBe(true);
    expect(backup.dbCounts().trades).toBe(TRADES);
    expect(backup.dbCounts().audit_log).toBe(AUDIT);
    // Restore is one transaction (invariant 10) — the per-row insert is a
    // statement per row by construction and is reported, not asserted: it is
    // linear and correct, and the seconds it costs are spent once, deliberately.
  });
});
