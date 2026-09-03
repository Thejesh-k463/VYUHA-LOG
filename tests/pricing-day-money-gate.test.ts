import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { ownerFile } from "./helpers/owner-broker-files";

/**
 * v3.8 MONEY GATE for the "one today" migration (owner ruling 2026-09-04).
 *
 * `lib/import/commit.ts` prices every imported row against the charge_config
 * epoch effective on `pricingDate(row, today)`; `today` moved from a UTC
 * clock (`rates.ts#todayIso`, deleted) to IST (`todayIstIso`). At
 * 2026-09-03T20:00:00Z the two clocks name 2026-09-03 and 2026-09-04. This
 * file imports the same Paytm book twice into one temp database — once with
 * the pricing day forced to the UTC value, once to the IST value — and
 * asserts every row's charges identical, then states the general condition:
 * the two days can price differently ONLY when a charge_config row's
 * effective_from / effective_to falls on the IST day (the boundary the two
 * clocks straddle). The effective dates are printed for the record.
 *
 * `todayIstIso` is MOCKED here (not the clock) so the pricing day is the only
 * variable; the clock fact itself is pinned in tests/today-clock.test.ts.
 * One temp database per FILE (tests/helpers/temp-db.ts).
 */

const UTC_DAY = "2026-09-03";
const IST_DAY = "2026-09-04";

const clock = vi.hoisted(() => ({ today: "2026-09-03" }));
vi.mock("@/lib/domain/trading-day", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/domain/trading-day")>();
  return { ...orig, todayIstIso: () => clock.today };
});

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "redacted", "paytm-tradebook-v3.xlsx");
const OWNER_BOOK = ownerFile(/PAYTM MONEY-LARGE DATA-TIMEPERIOD CHANGE\.xlsx$/i);

/** Every column the charges engine writes, plus the P&L they net into. */
const CHARGE_COLS = [
  "brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty", "ipft", "gst",
  "dpCharges", "mtfInterest", "pledgeCharges", "chargesTotal", "netPnl",
] as const;

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let parser: typeof import("@/lib/import/parsers/paytm-tradebook");
let rates: typeof import("@/lib/engine/rates");
let ratesDb: typeof import("@/lib/engine/rates-db");

beforeAll(async () => {
  t = await openTempDb("money-gate", { seed: true });
  commit = await import("@/lib/import/commit");
  parser = await import("@/lib/import/parsers/paytm-tradebook");
  rates = await import("@/lib/engine/rates");
  ratesDb = await import("@/lib/engine/rates-db");
  t.db.insert(t.schema.accounts).values([
    { id: 2, name: "UTC-day" },
    { id: 3, name: "IST-day" },
    { id: 4, name: "Owner UTC-day" },
    { id: 5, name: "Owner IST-day" },
  ]).run();
});

afterAll(() => t?.cleanup());

/** Per-row charges for an account, keyed by dedup hash (stable across accounts). */
function chargesOf(accountId: number): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const r of t.db.select().from(t.schema.trades).all()) {
    if (r.accountId !== accountId) continue;
    const row = r as unknown as Record<string, unknown>;
    const picked: Record<string, number> = {};
    for (const c of CHARGE_COLS) {
      expect(row, `trades.${c} is not a column any more — update CHARGE_COLS`).toHaveProperty(c);
      picked[c] = Number(row[c]);
    }
    out[r.dedupHash] = picked;
  }
  return out;
}

function importTwice(parsed: ReturnType<typeof parser.parsePaytmTradebook>, utcAccount: number, istAccount: number) {
  clock.today = UTC_DAY;
  const a = commit.commitParsedFile(parsed, `book-${utcAccount}.xlsx`, null, utcAccount);
  clock.today = IST_DAY;
  const b = commit.commitParsedFile(parsed, `book-${istAccount}.xlsx`, null, istAccount);
  expect(a.added).toBeGreaterThan(0);
  expect(b.added).toBe(a.added);
  const utc = chargesOf(utcAccount);
  const ist = chargesOf(istAccount);
  expect(Object.keys(utc).length).toBe(a.added);
  expect(Object.keys(ist).sort()).toEqual(Object.keys(utc).sort());
  const differing = Object.keys(utc).filter((h) => JSON.stringify(utc[h]) !== JSON.stringify(ist[h]));
  return { rows: a.added, sourceRows: a.shape.sourceRows, differing: differing.map((h) => ({ hash: h, utc: utc[h], ist: ist[h] })) };
}

/** Every effective date in charge_config, and whether any sits on the IST day. */
function effectiveDates() {
  const rows = t.sqlite
    .prepare("SELECT DISTINCT effective_from AS f, effective_to AS t FROM charge_config ORDER BY 1, 2")
    .all() as { f: string; t: string | null }[];
  const dates = [...new Set(rows.flatMap((r) => [r.f, r.t]).filter((d): d is string => d != null))].sort();
  return { rows, dates, boundaryOnIstDay: dates.includes(IST_DAY) };
}

describe("charge pricing is the same on the UTC day and the IST day (seeded charge_config)", () => {
  it("prints the charge_config effective dates for the record", () => {
    const { rows, dates } = effectiveDates();
    console.log(`[money-gate] charge_config effective windows: ${rows.map((r) => `${r.f}→${r.t ?? "open"}`).join(", ")}`);
    console.log(`[money-gate] charge_config effective dates: ${dates.join(", ")} ; IST day ${IST_DAY} is ${dates.includes(IST_DAY) ? "" : "NOT "}a boundary`);
    expect(dates.length).toBeGreaterThan(0);
  });

  it("the redacted Paytm v3 fixture prices identically on both days, row for row", () => {
    const bytes = fs.readFileSync(FIXTURE);
    const parsed = parser.parsePaytmTradebook({ filename: "paytm-tradebook-v3.xlsx", buffer: bytes });
    expect(parsed.trades.length).toBeGreaterThan(0);
    const { rows, differing } = importTwice(parsed, 2, 3);
    console.log(`[money-gate] fixture: ${rows} rows compared, ${differing.length} differ`);
    expect(differing).toEqual([]);
  }, 60_000);

  it("the general condition: the two days can only differ when an effective date sits on the IST day", () => {
    // Directly on the rate lookup the importer uses, for EVERY key the table
    // holds — not just the rows a fixture happens to exercise. `covers(d)` and
    // `covers(d + 1)` disagree exactly when some row's from or to equals d + 1.
    const map = ratesDb.loadRatesMap();
    const keys = t.sqlite
      .prepare("SELECT DISTINCT broker, plan, segment, exchange FROM charge_config")
      .all() as { broker: string; plan: string; segment: string; exchange: string }[];
    expect(keys.length).toBeGreaterThan(0);
    const differingKeys: string[] = [];
    for (const k of keys) {
      const on = (d: string) => {
        try {
          return JSON.stringify(rates.findRates(map, k.broker as never, k.segment as never, k.exchange as never, d, k.plan));
        } catch (e) {
          return `refused:${(e as Error).message}`;
        }
      };
      if (on(UTC_DAY) !== on(IST_DAY)) differingKeys.push(`${k.broker}/${k.plan}/${k.segment}/${k.exchange}`);
    }
    const { boundaryOnIstDay } = effectiveDates();
    if (differingKeys.length > 0) expect(boundaryOnIstDay).toBe(true);
    if (!boundaryOnIstDay) expect(differingKeys).toEqual([]);
    // And with the seed as shipped, no boundary sits there — so identical is REQUIRED above.
    expect(boundaryOnIstDay).toBe(false);
  });

  it("'today' only ever reaches pricing as the FALLBACK for a row with no usable date", () => {
    expect(rates.pricingDate({ buyDate: "2026-08-03", sellDate: null }, IST_DAY)).toBe("2026-08-03");
    expect(rates.pricingDate({ buyDate: "03-08-2026", sellDate: "04-08-2026" }, IST_DAY)).toBe("2026-08-04");
    expect(rates.pricingDate({ buyDate: null, sellDate: null }, IST_DAY)).toBe(IST_DAY);
  });
});

describe.skipIf(!OWNER_BOOK)("the owner's Paytm book (read in place, never copied)", () => {
  it("prices identically on both days, row for row — STOP and report if not", () => {
    const bytes = fs.readFileSync(OWNER_BOOK!);
    const parsed = parser.parsePaytmTradebook({ filename: "export.xlsx", buffer: bytes });
    const { rows, sourceRows, differing } = importTwice(parsed, 4, 5);
    console.log(`[money-gate] owner book: ${sourceRows} executions → ${parsed.trades.length} positions; ${rows} rows compared, ${differing.length} differ`);
    if (differing.length > 0) console.log(JSON.stringify(differing.slice(0, 20), null, 2));
    expect(differing).toEqual([]);
    // 7,544 executions imported twice: ~5 s alone, longer under a loaded
    // machine — the default 5 s per-test budget tripped once in a 21-file run.
  }, 120_000);
});
