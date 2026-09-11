import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { chargeConfig } from "@/lib/db/schema";
import { buildChargeConfigSeed, STT_EPOCH_2026 } from "@/lib/db/seed-data";
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
 */

type Result = { added?: number; refreshed?: number; skipped?: string };
const refresh = (db: Database.Database, template = TEMPLATE): Result =>
  refreshRateCards(db, template, () => {}) as Result;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-rate-refresh-"));
const TEMPLATE = path.join(dir, "template.sqlite");
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
function snapshot(db: Database.Database): unknown[] {
  const cols = (db.prepare("PRAGMA table_info(charge_config)").all() as { name: string }[])
    .map((c) => c.name)
    .filter((c) => c !== "id" && c !== "updated_at");
  return db
    .prepare(
      `SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM charge_config
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
 * The owner's real state: every 1970 epoch of a two-epoch key carries the
 * 2026 epoch's STT and an open effective_to. Returns the number of rows planted.
 */
function plantOwnerState(db: Database.Database): number {
  const same = `n.broker = t.broker AND n.plan = t.plan AND n.segment = t.segment
                AND n.exchange = t.exchange AND n.effective_from = '${STT_EPOCH_2026}'`;
  return db
    .prepare(
      `UPDATE charge_config AS t SET
         stt_pct = (SELECT n.stt_pct FROM charge_config n WHERE ${same}),
         stt_side = (SELECT n.stt_side FROM charge_config n WHERE ${same}),
         effective_to = NULL
       WHERE t.effective_from = '1970-01-01' AND EXISTS (SELECT 1 FROM charge_config n WHERE ${same})`,
    )
    .run().changes;
}

let tpl: Database.Database;

beforeAll(() => {
  const t = new Database(TEMPLATE);
  migrate(drizzle(t), { migrationsFolder: path.resolve(__dirname, "../drizzle") });
  const d = drizzle(t);
  for (const row of buildChargeConfigSeed()) d.insert(chargeConfig).values(row).run();
  t.close();
  tpl = open(TEMPLATE, true);
});

afterAll(() => {
  for (const db of opened) if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the fixture is not vacuous", () => {
  it("the template holds 45 keys with two dated epochs, and the user index is 5 columns", () => {
    const multi = (
      tpl
        .prepare(
          `SELECT count(*) AS n FROM (SELECT 1 FROM charge_config
             GROUP BY broker, plan, segment, exchange HAVING count(DISTINCT effective_from) >= 2)`,
        )
        .get() as { n: number }
    ).n;
    expect(multi).toBe(45);
    const idx = (tpl.prepare("PRAGMA index_info(charge_config_uq)").all() as { name: string }[]).map((c) => c.name);
    expect(idx).toEqual(["broker", "plan", "segment", "exchange", "effective_from"]);
  });
});

describe("refreshRateCards over epoch-dated rate cards", () => {
  it("(a) a fresh install (user = the template) refreshes nothing and does not throw", () => {
    const u = userCopy();
    expect(refresh(u)).toEqual({ added: 0, refreshed: 0 });
    expect(snapshot(u)).toEqual(snapshot(tpl));
  });

  it("(b) the owner's real state: 45 corrupted 1970 epochs are corrected, overlaps gone, pre-2026 trades priced at the old STT", () => {
    const u = userCopy();
    expect(plantOwnerState(u)).toBe(45);
    expect(overlaps(u)).toBe(45); // the planted state really has the defect

    expect(refresh(u)).toEqual({ added: 0, refreshed: 45 });
    expect(snapshot(u)).toEqual(snapshot(tpl));
    expect(overlaps(u)).toBe(0);

    const tplStt = (from: string) =>
      (
        tpl
          .prepare(
            `SELECT stt_pct AS v FROM charge_config WHERE broker = 'dhan' AND plan = 'default'
               AND segment = 'index_option' AND exchange = 'NSE' AND effective_from = ?`,
          )
          .get(from) as { v: number }
      ).v;
    const oldStt = tplStt("1970-01-01");
    const newStt = tplStt(STT_EPOCH_2026);
    expect(oldStt).not.toBe(newStt);

    const map = ratesMapOf(drizzle(u).select().from(chargeConfig).all() as unknown as ChargeRates[]);
    expect(findRates(map, "dhan", "index_option", "NSE", "2026-03-15").sttPct).toBe(oldStt);
    expect(findRates(map, "dhan", "index_option", "NSE", "2026-04-15").sttPct).toBe(newStt);
  });

  it("(c) the pre-v3.2 shape (one open 1970 row per key at current rates) gains the epochs, no overlaps", () => {
    const u = userCopy();
    expect(plantOwnerState(u)).toBe(45);
    u.prepare(`DELETE FROM charge_config WHERE effective_from = '${STT_EPOCH_2026}'`).run();
    expect(count(u)).toBe(count(tpl) - 45);

    expect(refresh(u)).toEqual({ added: 45, refreshed: 45 });
    expect(snapshot(u)).toEqual(snapshot(tpl));
    expect(overlaps(u)).toBe(0);
  });

  it("(d) is idempotent: a second launch refreshes nothing", () => {
    const u = userCopy();
    plantOwnerState(u);
    expect(refresh(u)).toEqual({ added: 0, refreshed: 45 });
    expect(refresh(u)).toEqual({ added: 0, refreshed: 0 });
  });

  it("(e) a user-edited open row stays byte-identical and no seed epoch is inserted beside it", () => {
    const u = userCopy();
    const key = `broker = 'dhan' AND plan = 'default' AND segment = 'index_option' AND exchange = 'NSE'`;
    u.prepare(`DELETE FROM charge_config WHERE ${key} AND effective_from = '${STT_EPOCH_2026}'`).run();
    u.prepare(
      `UPDATE charge_config SET user_edited = 1, stt_pct = 0.0042, effective_to = NULL
       WHERE ${key} AND effective_from = '1970-01-01'`,
    ).run();
    const before = u.prepare(`SELECT * FROM charge_config WHERE ${key}`).all();
    expect(before).toHaveLength(1);

    expect(refresh(u)).toEqual({ added: 0, refreshed: 0 });
    expect(u.prepare(`SELECT * FROM charge_config WHERE ${key}`).all()).toEqual(before);
  });

  it("(e2) a non-edited epoch covered by a user-edited window is not refreshed either (seed-core parity)", () => {
    const u = userCopy();
    const key = `broker = 'dhan' AND plan = 'default' AND segment = 'index_option' AND exchange = 'NSE'`;
    u.prepare(
      `UPDATE charge_config SET stt_pct = 0.0099 WHERE ${key} AND effective_from = '${STT_EPOCH_2026}'`,
    ).run();
    u.prepare(
      `UPDATE charge_config SET user_edited = 1, effective_to = NULL WHERE ${key} AND effective_from = '1970-01-01'`,
    ).run();
    const before = u.prepare(`SELECT * FROM charge_config WHERE ${key} ORDER BY effective_from`).all();

    expect(refresh(u)).toEqual({ added: 0, refreshed: 0 });
    expect(u.prepare(`SELECT * FROM charge_config WHERE ${key} ORDER BY effective_from`).all()).toEqual(before);
  });

  it("(f) a correction inside one epoch refreshes exactly that row", () => {
    const corrected = path.join(dir, "template-corrected.sqlite");
    fs.copyFileSync(TEMPLATE, corrected);
    const c = new Database(corrected);
    const changed = c
      .prepare(
        `UPDATE charge_config SET exchange_txn_pct = 0.00012345 WHERE broker = 'zerodha' AND plan = 'default'
           AND segment = 'future' AND exchange = 'NSE' AND effective_from = '${STT_EPOCH_2026}'`,
      )
      .run().changes;
    c.close();
    expect(changed).toBe(1);

    const u = userCopy();
    const was = snapshot(u) as Record<string, unknown>[];
    expect(refresh(u, corrected)).toEqual({ added: 0, refreshed: 1 });
    const now = snapshot(u) as Record<string, unknown>[];
    const diff = now.filter((r, i) => JSON.stringify(r) !== JSON.stringify(was[i]));
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ broker: "zerodha", segment: "future", exchange_txn_pct: 0.00012345 });
    expect(now).toEqual(snapshot(open(corrected, true)));
  });

  it("(g) is atomic: an UPDATE that aborts rolls the INSERT back too", () => {
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
  });

  it("(j) KEY comes from charge_config_uq: no index means a skip, not a guess", () => {
    const u = userCopy();
    plantOwnerState(u);
    u.exec("DROP INDEX charge_config_uq");
    const rows = count(u);
    const was = snapshot(u);
    const r = refresh(u);
    expect(r.skipped).toMatch(/charge_config_uq/);
    expect(count(u)).toBe(rows);
    expect(snapshot(u)).toEqual(was);
  });

  it("(j2) a user DB still on the pre-0050 4-column index skips rather than pick an arbitrary epoch", () => {
    const u = userCopy();
    u.prepare(`DELETE FROM charge_config WHERE effective_from = '${STT_EPOCH_2026}'`).run();
    u.exec(
      "DROP INDEX charge_config_uq; CREATE UNIQUE INDEX charge_config_uq ON charge_config (broker, plan, segment, exchange)",
    );
    const was = snapshot(u);
    const r = refresh(u);
    expect(r.skipped).toMatch(/not unique/);
    expect(snapshot(u)).toEqual(was);
  });
});

// ---------------------------------------------------------------------------
// The launcher and the bundle, read as source (the sidecar cannot run here).

const root = path.resolve(__dirname, "..");
const launcher = fs.readFileSync(path.join(root, "scripts", "desktop-server.mjs"), "utf8");
const builder = fs.readFileSync(path.join(root, "scripts", "build-desktop.mjs"), "utf8");

function closeOf(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return i;
  }
  return -1;
}
/** Every try statement: the try block's span, its catch body and finally body. */
function tryStatements(src: string) {
  const out: { start: number; end: number; catchBody: string; finallyBody: string }[] = [];
  for (const m of src.matchAll(/\btry\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const end = closeOf(src, open);
    let tail = end;
    let catchBody = "";
    let finallyBody = "";
    const c = /^\s*catch\s*(\([^)]*\))?\s*\{/.exec(src.slice(tail + 1));
    if (c) {
      const o = tail + 1 + c[0].length - 1;
      tail = closeOf(src, o);
      catchBody = src.slice(o, tail + 1);
    }
    const f = /^\s*finally\s*\{/.exec(src.slice(tail + 1));
    if (f) {
      const o = tail + 1 + f[0].length - 1;
      finallyBody = src.slice(o, closeOf(src, o) + 1);
    }
    out.push({ start: open, end, catchBody, finallyBody });
  }
  return out;
}

describe("(h) the launcher isolates the refresh from the migration", () => {
  const stmts = tryStatements(launcher);
  const call = launcher.search(/refreshRateCards\(\s*sqlite/);
  const inside = (s: { start: number; end: number }) => call > s.start && call < s.end;

  it("calls the refresh from the module, not an inline copy", () => {
    expect(call).toBeGreaterThan(-1);
    expect(launcher).not.toMatch(/function\s+refreshRateCards/);
  });

  it("the refresh call is NOT inside the try whose catch reports a migration failure", () => {
    const mig = stmts.filter((s) => s.catchBody.includes("migration step failed"));
    expect(mig).toHaveLength(1);
    expect(inside(mig[0]), "refresh runs inside the migration try — its failure would be logged as a migration failure").toBe(false);
  });

  it("the refresh has its own catch, and sqlite.close() sits in a finally around it", () => {
    const own = stmts.filter((s) => s.catchBody.includes("rate-card refresh failed"));
    expect(own).toHaveLength(1);
    expect(inside(own[0])).toBe(true);
    const closer = stmts.filter((s) => s.finallyBody.includes("sqlite.close()"));
    expect(closer).toHaveLength(1);
    expect(inside(closer[0])).toBe(true);
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
});
