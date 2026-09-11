import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { buildChargeConfigSeed, STT_EPOCH_2024, STT_EPOCH_2026 } from "@/lib/db/seed-data";
import { findRates, seedRatesMap } from "@/lib/engine/rates";
import { refreshRateCards } from "../scripts/rate-card-refresh.mjs";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * C-7 (owner ruling "fix in 4.3.0, rates only"): the 1 October 2024 F&O STT epoch.
 *
 * From v3.2.0 (b26cb5c) the seed gave the 45 F&O keys two epochs, and the 1970
 * one carried the rates in force FROM 1 Oct 2024 — so every earlier F&O trade
 * priced from charge_config (a file that states no broker charges) carried 1.6×
 * the STT that applied. The keys now carry three STT windows; since C-8 the same
 * keys are also split at the NSE/BSE exchange-charge boundaries
 * (tests/exchange-charge-epochs.test.ts pins those).
 *
 * The values are pinned against lib/data/charge-rates-defaults.json, the dated
 * reference table that already held the pre-October-2024 epoch but that only the
 * Sizing Lab read (invariant 3: the engine reads rates only from charge_config).
 *
 * The second half is the round-1 parity harness: the same planted states run
 * through the TypeScript seed (seedDatabase) and the desktop sidecar's refresh
 * (refreshRateCards) must give identical counts and a byte-identical
 * charge_config. ONE temp database per file (lib/db caches its connection), so
 * the states are planted one after another on it, in declaration order. The
 * sidecar side runs on IN-MEMORY copies of a template migrated and seeded once,
 * in one transaction (CI 34586408007 timed this file's beforeAll out at 30 s on
 * the Windows runner, where every row of the old per-row seed paid an fsync).
 */

const WINDOWS = [
  ["1970-01-01", STT_EPOCH_2024],
  [STT_EPOCH_2024, STT_EPOCH_2026],
  [STT_EPOCH_2026, null],
];
/** Sell-side STT, oldest epoch first. Stock options share the options line of the levy. */
const STT = {
  future: [0.000125, 0.0002, 0.0005],
  index_option: [0.000625, 0.001, 0.0015],
  stock_option: [0.000625, 0.001, 0.0015],
} as const;
type FnoSegment = keyof typeof STT;
const isFno = (segment: string): segment is FnoSegment => segment in STT;

const seed = buildChargeConfigSeed();
type SeedRow = (typeof seed)[number];
const byKey = new Map<string, SeedRow[]>();
for (const r of seed) {
  const k = `${r.broker}/${r.plan}/${r.segment}/${r.exchange}`;
  byKey.set(k, [...(byKey.get(k) ?? []), r]);
}
const oldestFirst = (rows: SeedRow[]) =>
  [...rows].sort((a, b) => (a.effectiveFrom ?? "1970-01-01").localeCompare(b.effectiveFrom ?? "1970-01-01"));
const fnoKeys = [...byKey.entries()].filter(([, rows]) => isFno(rows[0].segment));

describe("the seed's F&O STT epochs", () => {
  it("the reference table states the values the seed uses (futures and index options; it has no stock_option row)", () => {
    const ref = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../lib/data/charge-rates-defaults.json"), "utf8"),
    ) as { epochs: { segment: string; effectiveFrom: string; effectiveTo: string | null; rates: { sttPct: number; sttSide: string } }[] };
    for (const segment of ["future", "index_option"] as const) {
      const eps = ref.epochs
        .filter((e) => e.segment === segment)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      expect(eps.map((e) => [e.effectiveFrom, e.effectiveTo]), segment).toEqual(WINDOWS);
      expect(eps.map((e) => e.rates.sttPct), segment).toEqual([...STT[segment]]);
      expect(eps.map((e) => e.rates.sttSide), segment).toEqual(["sell", "sell", "sell"]);
    }
    expect(ref.epochs.some((e) => e.segment === "stock_option")).toBe(false);
  });

  it("all 45 F&O keys follow the three STT windows: an epoch starts on each STT boundary, every epoch carries its window's STT, and only STT, the exchange charge and IPFT differ", () => {
    expect(fnoKeys).toHaveLength(45);
    /** The STT window a date falls in: 0 before 1 Oct 2024, 1 before 1 Apr 2026, 2 from then. */
    const era = (d: string): 0 | 1 | 2 => (d < STT_EPOCH_2024 ? 0 : d < STT_EPOCH_2026 ? 1 : 2);
    const rest = (r: SeedRow) => {
      const o: Record<string, unknown> = { ...r };
      for (const c of ["sttPct", "sttSide", "exchangeTxnPct", "ipftPct", "effectiveFrom", "effectiveTo"]) delete o[c];
      return o;
    };
    for (const [k, rows] of fnoKeys) {
      const asc = oldestFirst(rows);
      const froms = asc.map((r) => r.effectiveFrom);
      expect(froms[0], k).toBe("1970-01-01");
      expect(froms, k).toEqual(expect.arrayContaining([STT_EPOCH_2024, STT_EPOCH_2026]));
      asc.forEach((r, i) => expect(r.effectiveTo ?? null, `${k} ${r.effectiveFrom}`).toBe(asc[i + 1]?.effectiveFrom ?? null));
      expect(asc.map((r) => r.sttPct), k).toEqual(asc.map((r) => STT[r.segment as FnoSegment][era(r.effectiveFrom!)]));
      expect(new Set(asc.map((r) => r.sttSide)), k).toEqual(new Set(["sell"]));
      for (const r of asc) expect(rest(r), `${k} ${r.effectiveFrom}`).toEqual(rest(asc[asc.length - 1]));
    }
  });

  it("no other segment gains STT history: the 72 other keys carry one STT on every epoch, MCX keeps one open row, 459 rows in all", () => {
    const others = [...byKey.entries()].filter(([, rows]) => !isFno(rows[0].segment));
    expect(others).toHaveLength(72);
    for (const [k, rows] of others) expect(new Set(rows.map((r) => `${r.sttPct}/${r.sttSide}`)).size, k).toBe(1);
    const mcx = others.filter(([, rows]) => rows[0].exchange === "MCX");
    expect(mcx).toHaveLength(18);
    for (const [k, rows] of mcx) {
      expect(rows, k).toHaveLength(1);
      expect([rows[0].effectiveFrom, rows[0].effectiveTo], k).toEqual([undefined, undefined]);
    }
    expect(seed).toHaveLength(459);
  });

  it("findRates prices each NSE F&O key at the STT in force on the trade's own date", () => {
    const map = seedRatesMap();
    const PINS: [string, 0 | 1 | 2][] = [
      ["2024-09-30", 0],
      ["2024-10-01", 1],
      ["2026-03-31", 1],
      ["2026-04-01", 2],
    ];
    const nse = fnoKeys.filter(([, rows]) => rows[0].exchange === "NSE");
    expect(nse).toHaveLength(27); // 9 broker plans × future, index_option, stock_option
    for (const [k, rows] of nse) {
      const { broker, plan, segment } = rows[0];
      for (const [onDate, epoch] of PINS) {
        const hit = findRates(map, broker, segment, "NSE", onDate, plan);
        expect(hit.sttPct, `${k} on ${onDate}`).toBe(STT[segment as FnoSegment][epoch]);
        expect(hit.sttSide, `${k} on ${onDate}`).toBe("sell");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Parity: seedDatabase() and refreshRateCards() over the same planted states.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-stt-2024-"));
const TEMPLATE = path.join(dir, "template.sqlite");
const opened: Database.Database[] = [];
/** A migrated EMPTY charge_config, and the seeded template — each serialised once. */
let emptyBytes: Buffer;
let templateBytes: Buffer;
let t: TempDb;
let seedDatabase: typeof import("@/lib/db/seed-core").seedDatabase;

type Raw = Database.Database;
type Counts = { added?: number; refreshed?: number; skipped?: string };

/** Every column but the surrogate id and the write stamp, in identity order. */
function snapshot(db: Raw): unknown[] {
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
const openEpochOverlaps = (db: Raw) =>
  (
    db
      .prepare(
        `SELECT count(*) AS n FROM (SELECT 1 FROM charge_config WHERE effective_to IS NULL
           GROUP BY broker, plan, segment, exchange HAVING count(*) > 1)`,
      )
      .get() as { n: number }
  ).n;

/** bbdc4ec's flat exchange charges (its exchangeTxnFor and IPFT_NSE_PCT), bound as exact doubles. */
const PRE_C8 = {
  eqNse: 0.0000297, eqBse: 0.0000375, optNse: 0.0003503, optBse: 0.000325,
  fut: 0.0000173, cfut: 0.000021, copt: 0.000418, ipft: 0.000000001,
};
/**
 * Back to bbdc4ec's own card (C-7 applied, C-8 not): F&O keys keep their 1970,
 * 2024-10-01 and 2026-04-01 epochs, every other key its 1970 row, at bbdc4ec's
 * flat exchange charges, each row re-closed at the next surviving epoch. The
 * same SQL as tests/rate-card-refresh.test.ts. Returns the row count (bbdc4ec: 207).
 */
function plantPreC8(db: Raw): number {
  db.prepare(
    `DELETE FROM charge_config WHERE effective_from <> '1970-01-01'
       AND (segment NOT IN ('future', 'index_option', 'stock_option') OR effective_from NOT IN (?, ?))`,
  ).run(STT_EPOCH_2024, STT_EPOCH_2026);
  db.prepare(
    `UPDATE charge_config SET
       exchange_txn_pct = CASE
         WHEN segment IN ('eq_delivery', 'eq_mtf', 'eq_intraday') THEN (CASE exchange WHEN 'BSE' THEN :eqBse ELSE :eqNse END)
         WHEN segment IN ('index_option', 'stock_option') THEN (CASE exchange WHEN 'BSE' THEN :optBse ELSE :optNse END)
         WHEN segment = 'future' THEN :fut
         WHEN segment = 'commodity_future' THEN :cfut
         WHEN segment = 'commodity_option' THEN :copt
         ELSE 0 END,
       ipft_pct = CASE exchange WHEN 'NSE' THEN :ipft ELSE 0 END`,
  ).run(PRE_C8);
  db.prepare(
    `UPDATE charge_config AS t SET effective_to = (SELECT min(n.effective_from) FROM charge_config n
       WHERE n.broker = t.broker AND n.plan = t.plan AND n.segment = t.segment AND n.exchange = t.exchange
         AND n.effective_from > t.effective_from)`,
  ).run();
  return (db.prepare("SELECT count(*) AS n FROM charge_config").get() as { n: number }).n;
}
/** bbdc4ec's own DB: C-7's three F&O epochs, the pre-C-8 exchange charges. */
const preC8State = (db: Raw) => expect(plantPreC8(db)).toBe(207);

/**
 * Back to a two-epoch F&O key, from bbdc4ec's card: the 1970 row takes the STT
 * of the epoch starting `sttFrom` and ends at `to`, and the 2024-10-01 epoch is deleted.
 */
function collapse(db: Raw, sttFrom: string, to: string | null): void {
  preC8State(db);
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
  const dropped = db.prepare(`DELETE FROM charge_config WHERE effective_from = '${STT_EPOCH_2024}'`).run().changes;
  expect([changed, dropped]).toEqual([45, 45]);
}
/** The owner's real DB: two epochs per F&O key, the 1970 row carrying the 2026 STT and open-ended. */
const ownerState = (db: Raw) => collapse(db, STT_EPOCH_2026, null);
/** The v3.2.0..v4.2 template shape: 1970 → 2026-04-01 at the FY25 STT, then the 2026 epoch. */
const fy25State = (db: Raw) => collapse(db, STT_EPOCH_2024, STT_EPOCH_2026);
/** Pre-v3.2: one open 1970 row per key at the current rates. */
const preV32State = (db: Raw) => {
  ownerState(db);
  expect(db.prepare(`DELETE FROM charge_config WHERE effective_from = '${STT_EPOCH_2026}'`).run().changes).toBe(45);
};

beforeAll(async () => {
  t = await openTempDb("stt-epoch-2024");
  ({ seedDatabase } = await import("@/lib/db/seed-core"));
  // Migrated ONCE in memory, then seeded in one transaction; the seeded bytes
  // become the template FILE the refresh ATTACHes.
  const m = new Database(":memory:");
  migrate(drizzle(m), { migrationsFolder: path.resolve(__dirname, "../drizzle") });
  emptyBytes = m.serialize();
  const d = drizzle(m);
  m.transaction(() => {
    for (const row of buildChargeConfigSeed()) d.insert(t.schema.chargeConfig).values(row).run();
  })();
  templateBytes = m.serialize();
  m.close();
  fs.writeFileSync(TEMPLATE, templateBytes);
});

afterAll(() => {
  for (const db of opened) if (db.open) db.close();
  t?.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The sidecar path: an in-memory copy of `bytes`, planted, refreshed twice from TEMPLATE. */
function viaRefresh(plant: (db: Raw) => void, bytes: Buffer): { first: Counts; second: Counts; snap: unknown[] } {
  const db = new Database(bytes);
  opened.push(db);
  plant(db);
  const first = refreshRateCards(db, TEMPLATE, () => {}) as Counts;
  const second = refreshRateCards(db, TEMPLATE, () => {}) as Counts;
  expect(openEpochOverlaps(db)).toBe(0);
  return { first, second, snap: snapshot(db) };
}
/** The TypeScript path: ONE seedDatabase() over the one temp DB. */
function seedOnce(): { counts: Counts; snap: unknown[] } {
  const a = seedDatabase();
  expect(openEpochOverlaps(t.sqlite)).toBe(0);
  return { counts: { added: a.chargeAdded, refreshed: a.chargeRefreshed }, snap: snapshot(t.sqlite) };
}

describe("parity: seedDatabase() and refreshRateCards() agree on every planted state", () => {
  // Declaration order matters: each state is planted on the DB the previous one left (= the template).
  const STATES: { name: string; plant: (db: Raw) => void; empty?: true; expected: Counts }[] = [
    { name: "an empty migrated DB", plant: (db) => expect(snapshot(db)).toEqual([]), empty: true, expected: { added: 459, refreshed: 0 } },
    { name: "the owner's real DB (4.2.0: two epochs, corrupted 1970 rows)", plant: ownerState, expected: { added: 297, refreshed: 135 } },
    { name: "the correct two-epoch DB (1970 → 2026-04-01 at FY25 STT)", plant: fy25State, expected: { added: 297, refreshed: 135 } },
    { name: "bbdc4ec's own DB (C-7's three F&O epochs, pre-C-8 exchange charges)", plant: preC8State, expected: { added: 252, refreshed: 171 } },
    { name: "the pre-v3.2 one-epoch DB", plant: preV32State, expected: { added: 342, refreshed: 99 } },
  ];

  // Three rows per state, run in order (one `it` holding both paths and a
  // re-seed was this file's slowest row): the sidecar path, then the same
  // planted state through seedDatabase(), then a second seedDatabase().
  for (const s of STATES) {
    describe(s.name, () => {
      let r: { first: Counts; second: Counts; snap: unknown[] } | undefined;

      it("refreshRateCards: the expected counts, equal to the template; a re-run is 0/0", () => {
        const tpl = new Database(templateBytes);
        opened.push(tpl);
        r = viaRefresh(s.plant, s.empty ? emptyBytes : templateBytes);
        expect(r.first).toEqual(s.expected);
        expect(r.second).toEqual({ added: 0, refreshed: 0 });
        expect(r.snap).toEqual(snapshot(tpl));
      });

      it("seedDatabase() over the same planted state: the same counts, a byte-identical charge_config", () => {
        s.plant(t.sqlite);
        const sd = seedOnce();
        expect(sd.counts).toEqual(s.expected);
        expect(sd.snap).toEqual(r?.snap);
      });

      it("a second seedDatabase() is 0/0 and changes nothing", () => {
        const sd = seedOnce();
        expect(sd.counts).toEqual({ added: 0, refreshed: 0 });
        expect(sd.snap).toEqual(r?.snap);
      });
    });
  }
});
