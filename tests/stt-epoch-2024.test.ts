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
 * The F&O STT schedules: C-7 (the 1 October 2024 epoch), then R1 (v4.3.0; owner
 * ruling "from a verified primary source only, as C-8; rates only").
 *
 * From v3.2.0 (b26cb5c) the seed gave the 45 F&O keys two epochs, and the 1970
 * one carried the rates in force FROM 1 Oct 2024 (C-7 fixed that). C-7 still
 * left three STT windows, so every F&O sale before 1 Apr 2023 priced at the
 * Finance Act 2023 rates: futures 0.0125% where the statute said 0.01% (and
 * 0.017% before 1 Jun 2013), options 0.0625% where it said 0.05% (and 0.017%
 * before 1 Jun 2016). The keys now carry FIVE STT windows each; since C-8 they
 * are also split at the NSE/BSE exchange-charge boundaries
 * (tests/exchange-charge-epochs.test.ts pins those).
 *
 * The schedule below is TYPED from the NSE circulars, one FATAX reference per
 * window — never read back from the seed or from the reference JSON, so neither
 * can agree with itself. The reference JSON is then pinned TO it (R91).
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

const FATAX = (id: string) => `https://nsearchives.nseindia.com/content/circulars/${id}.pdf`;

/** One sell-side STT window: [from, to), the rate, and the NSE circular that states it. */
type Window = { from: string; to: string | null; stt: number; circular: string };

/** Row 4(c), sale of a futures in securities, of traded value. */
const FUTURES: Window[] = [
  // "0.017 per cent till 31.05.2013". When the 0.017% regime began (Finance Act
  // 2008) is NOT verified — NSE/F&A/10706 returns 404 — so it is extended back.
  { from: "1970-01-01", to: "2013-06-01", stt: 0.00017, circular: "FATAX23500" },
  { from: "2013-06-01", to: "2023-04-01", stt: 0.0001, circular: "FATAX23500" }, // "0.01 per cent from 01.06.2013"
  { from: "2023-04-01", to: "2024-10-01", stt: 0.000125, circular: "FATAX56235" }, // "0.0125% (upto March 31, 2023 – 0.01%)"
  { from: "2024-10-01", to: "2026-04-01", stt: 0.0002, circular: "FATAX63809" },
  { from: "2026-04-01", to: null, stt: 0.0005, circular: "FATAX73524" },
];
/** Row 4(a), sale of an option in securities, of premium — index and stock options alike. */
const OPTIONS: Window[] = [
  // "4(a) 0.017 per cent"; start unverified, extended back (as above).
  { from: "1970-01-01", to: "2016-06-01", stt: 0.00017, circular: "FATAX27711" },
  { from: "2016-06-01", to: "2023-04-01", stt: 0.0005, circular: "FATAX32385" }, // "from current rate of 0.017% to 0.05%"
  { from: "2023-04-01", to: "2024-10-01", stt: 0.000625, circular: "FATAX56235" }, // "0.0625% (upto March 31, 2023 – 0.05%)"
  { from: "2024-10-01", to: "2026-04-01", stt: 0.001, circular: "FATAX63809" }, // "0.10% (upto September 30, 2024 - 0.0625%)"
  { from: "2026-04-01", to: null, stt: 0.0015, circular: "FATAX73524" },
];
const SCHEDULE = { future: FUTURES, index_option: OPTIONS, stock_option: OPTIONS } as const;
type FnoSegment = keyof typeof SCHEDULE;
const isFno = (segment: string): segment is FnoSegment => segment in SCHEDULE;
/** The window `on` falls in. */
function windowOn(segment: FnoSegment, on: string): Window {
  let hit = SCHEDULE[segment][0];
  for (const w of SCHEDULE[segment]) if (w.from <= on) hit = w;
  return hit;
}
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

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

type RefEpoch = {
  segment: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  verified: boolean;
  sources?: string[];
  note?: string;
  rates: { sttPct: number; sttSide: string };
};
const ref = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../lib/data/charge-rates-defaults.json"), "utf8"),
) as { epochs: RefEpoch[] };

describe("the reference table (lib/data/charge-rates-defaults.json) states the circulars' schedule (R91)", () => {
  it("futures and index options: R1's windows, STT and circular on every epoch; the unverified 1970 start is not marked verified; no stock_option row", () => {
    for (const segment of ["future", "index_option"] as const) {
      const eps = ref.epochs
        .filter((e) => e.segment === segment)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      expect(eps.map((e) => [e.effectiveFrom, e.effectiveTo]), segment).toEqual(SCHEDULE[segment].map((w) => [w.from, w.to]));
      expect(eps.map((e) => e.rates.sttPct), segment).toEqual(SCHEDULE[segment].map((w) => w.stt));
      expect(eps.map((e) => e.rates.sttSide), segment).toEqual(SCHEDULE[segment].map(() => "sell"));
      eps.forEach((e, i) =>
        expect(e.sources ?? [], `${segment} ${e.effectiveFrom}`).toContain(FATAX(SCHEDULE[segment][i].circular)),
      );
      expect(eps[0].verified, `${segment} 1970`).toBe(false);
      expect(eps[0].note, `${segment} 1970`).toMatch(/NOT verified/);
    }
    expect(ref.epochs.some((e) => e.segment === "stock_option")).toBe(false);
  });

  it("every epoch names its own sources, and one marked verified cites a primary NSE circular", () => {
    expect(ref.epochs.filter((e) => e.verified).length).toBeGreaterThan(0);
    for (const e of ref.epochs) {
      const at = `${e.segment} ${e.effectiveFrom}`;
      expect(Array.isArray(e.sources), at).toBe(true);
      if (e.verified) expect(e.sources!.some((s) => /nsearchives\.nseindia\.com.*FATAX/.test(s)), at).toBe(true);
    }
  });
});

describe("the seed's F&O STT epochs", () => {
  it("all 45 F&O keys follow the five STT windows: an epoch starts on each STT boundary, every epoch carries its window's STT, and only STT, the exchange charge and IPFT differ", () => {
    expect(fnoKeys).toHaveLength(45);
    const rest = (r: SeedRow) => {
      const o: Record<string, unknown> = { ...r };
      for (const c of ["sttPct", "sttSide", "exchangeTxnPct", "ipftPct", "effectiveFrom", "effectiveTo"]) delete o[c];
      return o;
    };
    for (const [k, rows] of fnoKeys) {
      const segment = rows[0].segment as FnoSegment;
      const asc = oldestFirst(rows);
      const froms = asc.map((r) => r.effectiveFrom);
      expect(froms[0], k).toBe("1970-01-01");
      expect(froms, k).toEqual(expect.arrayContaining(SCHEDULE[segment].map((w) => w.from)));
      asc.forEach((r, i) => expect(r.effectiveTo ?? null, `${k} ${r.effectiveFrom}`).toBe(asc[i + 1]?.effectiveFrom ?? null));
      expect(asc.map((r) => r.sttPct), k).toEqual(asc.map((r) => windowOn(segment, r.effectiveFrom!).stt));
      expect(new Set(asc.map((r) => r.sttSide)), k).toEqual(new Set(["sell"]));
      for (const r of asc) expect(rest(r), `${k} ${r.effectiveFrom}`).toEqual(rest(asc[asc.length - 1]));
    }
  });

  it("no other segment gains STT history: the 72 other keys carry one STT on every epoch, MCX keeps one open row, 522 rows in all", () => {
    const others = [...byKey.entries()].filter(([, rows]) => !isFno(rows[0].segment));
    expect(others).toHaveLength(72);
    for (const [k, rows] of others) expect(new Set(rows.map((r) => `${r.sttPct}/${r.sttSide}`)).size, k).toBe(1);
    const mcx = others.filter(([, rows]) => rows[0].exchange === "MCX");
    expect(mcx).toHaveLength(18);
    for (const [k, rows] of mcx) {
      expect(rows, k).toHaveLength(1);
      expect([rows[0].effectiveFrom, rows[0].effectiveTo], k).toEqual([undefined, undefined]);
    }
    // 459 before R1: + 9 NSE futures keys × 2013-06-01, 18 NSE option keys × 2016-06-01,
    // 18 BSE option keys × (2016-06-01, 2023-04-01) = +63.
    expect(seed).toHaveLength(522);
  });

  it("R1's own pins: the day before and the day of each boundary the pre-R1 seed priced at the Finance Act 2023 rates", () => {
    const map = seedRatesMap();
    const stt = (segment: FnoSegment, exchange: "NSE" | "BSE", on: string) =>
      findRates(map, "zerodha", segment, exchange, on).sttPct;
    expect(stt("future", "NSE", "2013-05-31")).toBe(0.00017); // FATAX23500: "0.017 per cent till 31.05.2013"
    expect(stt("future", "NSE", "2013-06-01")).toBe(0.0001);
    expect(stt("future", "NSE", "2023-03-31")).toBe(0.0001); // FATAX56235: "upto March 31, 2023 – 0.01%"
    expect(stt("future", "NSE", "2023-04-01")).toBe(0.000125);
    expect(stt("index_option", "NSE", "2016-05-31")).toBe(0.00017); // FATAX32385: "from current rate of 0.017%"
    expect(stt("index_option", "NSE", "2016-06-01")).toBe(0.0005);
    expect(stt("index_option", "BSE", "2023-03-31")).toBe(0.0005); // FATAX56235: "upto March 31, 2023 – 0.05%"
    expect(stt("index_option", "BSE", "2023-04-01")).toBe(0.000625);
  });

  it("findRates prices every F&O key, NSE and BSE, at the STT in force on the day before and the day of each boundary", () => {
    const map = seedRatesMap();
    let checked = 0;
    for (const [k, rows] of fnoKeys) {
      const { broker, plan, segment, exchange } = rows[0];
      const seg = segment as FnoSegment;
      // A date long before any verified boundary takes the EARLIEST verified schedule (owner ruling C-8).
      const probes = ["2000-01-03"];
      for (const w of SCHEDULE[seg].slice(1)) probes.push(dayBefore(w.from), w.from);
      for (const on of probes) {
        const hit = findRates(map, broker, segment, exchange, on, plan);
        expect(hit.sttPct, `${k} on ${on}`).toBe(windowOn(seg, on).stt);
        expect(hit.sttSide, `${k} on ${on}`).toBe("sell");
        checked++;
      }
    }
    expect(checked).toBe(45 * 9);
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
type Counts = { added?: number; refreshed?: number; removed?: number; skipped?: string };

/** Every column but the surrogate id and the write stamp, in identity order. */
function snapshot(db: Raw, where = "1"): unknown[] {
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
const openEpochOverlaps = (db: Raw) =>
  (
    db
      .prepare(
        `SELECT count(*) AS n FROM (SELECT 1 FROM charge_config WHERE effective_to IS NULL
           GROUP BY broker, plan, segment, exchange HAVING count(*) > 1)`,
      )
      .get() as { n: number }
  ).n;

/**
 * bbdc4ec's flat exchange charges (its exchangeTxnFor and IPFT_NSE_PCT), and the
 * STT its 1970 F&O rows carried (the Finance Act 2023 rates, extended back),
 * bound as exact doubles.
 */
const PRE_C8 = {
  eqNse: 0.0000297, eqBse: 0.0000375, optNse: 0.0003503, optBse: 0.000325,
  fut: 0.0000173, cfut: 0.000021, copt: 0.000418, ipft: 0.000000001,
  futStt: 0.000125, optStt: 0.000625,
};
/**
 * Back to bbdc4ec's own card (C-7 applied, C-8 and R1 not): F&O keys keep their
 * 1970, 2024-10-01 and 2026-04-01 epochs, every other key its 1970 row, at
 * bbdc4ec's flat exchange charges and 1970 F&O STT, each row re-closed at the
 * next surviving epoch. The same SQL as tests/rate-card-refresh.test.ts.
 * Returns the row count (bbdc4ec: 207).
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
       ipft_pct = CASE exchange WHEN 'NSE' THEN :ipft ELSE 0 END,
       stt_pct = CASE
         WHEN effective_from = '1970-01-01' AND segment = 'future' THEN :futStt
         WHEN effective_from = '1970-01-01' AND segment IN ('index_option', 'stock_option') THEN :optStt
         ELSE stt_pct END`,
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
/** The key the R54 state's user edited. */
const MINE = "broker = 'dhan' AND plan = 'default' AND segment = 'index_option' AND exchange = 'NSE'";
/**
 * R54 (on the template): the user edited this key's 1970 row — open-ended, brokerage ₹15 —
 * while the seed's six later epochs sit inside its window, the 2026 one stale.
 */
const userEditedState = (db: Raw) => {
  const edited = db
    .prepare(`UPDATE charge_config SET user_edited = 1, effective_to = NULL, brokerage_flat = 15 WHERE ${MINE} AND effective_from = '1970-01-01'`)
    .run().changes;
  const stale = db.prepare(`UPDATE charge_config SET stt_pct = 0.0099 WHERE ${MINE} AND effective_from = '${STT_EPOCH_2026}'`).run().changes;
  expect([edited, stale]).toEqual([1, 1]);
  expect(snapshot(db, MINE)).toHaveLength(7);
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

type Via = { first: Counts; second: Counts; snap: unknown[]; db: Raw; userRows: unknown[] };
/** The sidecar path: an in-memory copy of `bytes`, planted, refreshed twice from TEMPLATE. */
function viaRefresh(plant: (db: Raw) => void, bytes: Buffer, userKey?: string): Via {
  const db = new Database(bytes);
  opened.push(db);
  plant(db);
  const userRows = userKey ? snapshot(db, `${userKey} AND user_edited = 1`) : [];
  const first = refreshRateCards(db, TEMPLATE, () => {}) as Counts;
  const second = refreshRateCards(db, TEMPLATE, () => {}) as Counts;
  expect(openEpochOverlaps(db)).toBe(0);
  return { first, second, snap: snapshot(db), db, userRows };
}
/** The TypeScript path: ONE seedDatabase() over the one temp DB. */
function seedOnce(): { counts: Counts; snap: unknown[] } {
  const a = seedDatabase();
  expect(openEpochOverlaps(t.sqlite)).toBe(0);
  return {
    counts: { added: a.chargeAdded, refreshed: a.chargeRefreshed, removed: a.chargeRemoved },
    snap: snapshot(t.sqlite),
  };
}

describe("parity: seedDatabase() and refreshRateCards() agree on every planted state", () => {
  // Declaration order matters: each state is planted on the DB the previous one
  // left (= the template). The R54 state leaves a user-edited key, so it is last.
  const STATES: { name: string; plant: (db: Raw) => void; empty?: true; userKey?: string; expected: Counts }[] = [
    { name: "an empty migrated DB", plant: (db) => expect(snapshot(db)).toEqual([]), empty: true, expected: { added: 522, refreshed: 0, removed: 0 } },
    { name: "the owner's real DB (4.2.0: two epochs, corrupted 1970 rows)", plant: ownerState, expected: { added: 360, refreshed: 135, removed: 0 } },
    { name: "the correct two-epoch DB (1970 → 2026-04-01 at FY25 STT)", plant: fy25State, expected: { added: 360, refreshed: 135, removed: 0 } },
    { name: "bbdc4ec's own DB (C-7's three F&O epochs, pre-C-8 exchange charges)", plant: preC8State, expected: { added: 315, refreshed: 171, removed: 0 } },
    { name: "the pre-v3.2 one-epoch DB", plant: preV32State, expected: { added: 405, refreshed: 99, removed: 0 } },
    {
      name: "a user-edited open 1970 row with six stale seed epochs inside its window (R54)",
      plant: userEditedState,
      userKey: MINE,
      expected: { added: 0, refreshed: 0, removed: 6 },
    },
  ];

  // Three rows per state, run in order (one `it` holding both paths and a
  // re-seed was this file's slowest row): the sidecar path, then the same
  // planted state through seedDatabase(), then a second seedDatabase().
  for (const s of STATES) {
    describe(s.name, () => {
      let r: Via | undefined;

      it("refreshRateCards: the expected counts; every key but the user's equals the template, the user's key holds only the user's row; a re-run is 0/0/0", () => {
        const tpl = new Database(templateBytes);
        opened.push(tpl);
        r = viaRefresh(s.plant, s.empty ? emptyBytes : templateBytes, s.userKey);
        expect(r.first).toEqual(s.expected);
        expect(r.second).toEqual({ added: 0, refreshed: 0, removed: 0 });
        const others = s.userKey ? `NOT (${s.userKey})` : "1";
        expect(snapshot(r.db, others)).toEqual(snapshot(tpl, others));
        if (s.userKey) {
          expect(r.userRows).toHaveLength(1);
          expect(snapshot(r.db, s.userKey)).toEqual(r.userRows);
        }
      });

      it("seedDatabase() over the same planted state: the same counts, a byte-identical charge_config", () => {
        s.plant(t.sqlite);
        const sd = seedOnce();
        expect(sd.counts).toEqual(s.expected);
        expect(sd.snap).toEqual(r?.snap);
      });

      it("a second seedDatabase() is 0/0/0 and changes nothing", () => {
        const sd = seedOnce();
        expect(sd.counts).toEqual({ added: 0, refreshed: 0, removed: 0 });
        expect(sd.snap).toEqual(r?.snap);
      });
    });
  }
});
