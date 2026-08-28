import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, type TempDb } from "../helpers/temp-db";
import { report, rng, time } from "./helpers/measure";
import {
  LEDGER_PAGE_SIZE,
  LEDGER_TYPES,
  summariseLedger,
  summariseLedgerGroups,
} from "@/lib/analytics/ledger";

/**
 * A7 — /cash (Cash & Ledger) at the HEAVY tier.
 *
 * The old page materialised EVERY ledger entry per render — once into
 * `summariseLedger` (which only needed the sums), once into the table's RSC
 * props, and once more into `exportData` for the export buttons. At 60k
 * entries that was a 113 MB HTML document and a 27-second render, the worst
 * page in the app.
 *
 * The fix pushes the sums into `GROUP BY bucket, type` and the running balance
 * into a SQL window function, and ships only LEDGER_PAGE_SIZE rows per render
 * (the rest load on demand via GET /api/ledger). This file pins two things:
 *
 *   1. NUMBERS UNCHANGED — at 80k entries the grouped path and the windowed
 *      page agree with `summariseLedger` over the full entry list, figure for
 *      figure and row for row.
 *   2. GROWTH — assembly time at 4n over n stays near linear (the window sort
 *      is O(n log n)); ~16× means someone reintroduced a per-render
 *      full-materialisation or a nested scan.
 *
 * ONE TEMP DB PER FILE.
 */

const N = 20_000;
const N4 = N * 4;
const BUCKETS = ["equity", "active", ""] as const;

let t: TempDb;
let ledgerQ: typeof import("@/lib/queries/ledger");

const rand = rng(0xcaf3);

function seedEntries(from: number, to: number) {
  const day0 = Date.UTC(2024, 0, 1);
  const rows: (typeof t.schema.ledgerEntries.$inferInsert)[] = [];
  for (let i = from; i < to; i++) {
    rows.push({
      accountId: 1,
      date: new Date(day0 + ((i * 7919) % 900) * 86_400_000).toISOString().slice(0, 10),
      bucket: BUCKETS[i % BUCKETS.length],
      type: LEDGER_TYPES[i % LEDGER_TYPES.length],
      amountPaise: Math.floor(rand() * 2_000_000) - 1_000_000,
      note: i % 97 === 0 ? `seed ${i}` : null,
    });
  }
  t.db.transaction((tx) => {
    for (let i = 0; i < rows.length; i += 500) {
      tx.insert(t.schema.ledgerEntries).values(rows.slice(i, i + 500)).run();
    }
  });
}

/** Everything /cash assembles per render under the fixed design. */
function assemble() {
  const opening = ledgerQ.getOpeningByBucketPaise();
  const s = summariseLedgerGroups(ledgerQ.getLedgerGroups(), opening);
  const page = ledgerQ.getLedgerRunningRows({ limit: LEDGER_PAGE_SIZE });
  return { s, page };
}

beforeAll(async () => {
  t = await openTempDb("a7-cash-ledger", { seed: true });
  ledgerQ = await import("@/lib/queries/ledger");
}, 600_000);
afterAll(() => t?.cleanup());

describe("A7 · /cash data assembly at the HEAVY tier", () => {
  it("grows ~linearly from 20k to 80k entries, and never hangs", () => {
    seedEntries(0, N);
    assemble(); // warm-up: JIT + statement cache
    assemble();
    const small = time(`/cash assembly n=${N.toLocaleString()}`, N, () => assemble());

    seedEntries(N, N4);
    assemble(); // warm the larger shape once too
    const large = time(`/cash assembly n=${N4.toLocaleString()}`, N4, () => assemble());

    report(small, { test: "a7-cash", n: N });
    report(large, { test: "a7-cash", n: N4 });

    expect(
      large.ms,
      `/cash data assembly took ${(large.ms / 1000).toFixed(1)} s at ${N4.toLocaleString()} entries. ` +
        "It is force-dynamic and better-sqlite3 is synchronous — the whole app blocks for that long. " +
        "Keep the sums in GROUP BY and the running balance in the SQL window; never materialise the ledger per render.",
    ).toBeLessThan(1_500);

    // Ratio guard only when the baseline is measurable — a sub-25 ms baseline
    // makes the ratio timer noise (see helpers/measure.ts).
    if (small.ms >= 25) {
      expect(
        large.ms / small.ms,
        `4× the entries cost ${(large.ms / small.ms).toFixed(1)}× the time — superlinear. ` +
          "Someone reintroduced a full-materialisation or nested scan in the /cash assembly path.",
      ).toBeLessThan(6);
    } else {
      console.log(`    baseline ${small.ms.toFixed(1)} ms is under the 25 ms floor — ratio skipped, sentinel still enforced`);
    }
  });

  it("matches the entry-level summariseLedger figure-for-figure at 80k entries", () => {
    const opening = ledgerQ.getOpeningByBucketPaise();
    const full = summariseLedger(ledgerQ.getLedgerEntries(), opening);
    const { s, page } = assemble();

    // Every figure the page renders: KPI row, bucket cards, type breakdown.
    expect(s.buckets).toEqual(full.buckets);
    expect(s.byType).toEqual(full.byType);
    expect(s.totalOpeningPaise).toBe(full.totalOpeningPaise);
    expect(s.totalFlowsPaise).toBe(full.totalFlowsPaise);
    expect(s.totalAvailablePaise).toBe(full.totalAvailablePaise);
    expect(s.totalCount).toBe(N4);
    expect(ledgerQ.countLedgerEntries()).toBe(N4);

    // The visible table page: SQL window vs the old chronological JS pass,
    // latest first — same rows, same balances, to the paisa.
    const oldDisplay = [...full.running].reverse().slice(0, LEDGER_PAGE_SIZE);
    expect(page).toHaveLength(LEDGER_PAGE_SIZE);
    expect(
      page.map((r) => [r.id, r.date, r.bucket, r.type, r.amountPaise, r.balancePaise]),
    ).toEqual(oldDisplay.map((r) => [r.id, r.date, r.bucket, r.type, r.amountPaise, r.balancePaise]));

    // And the deepest row, the worst case for the window: the last page ends
    // on the very first chronological entry.
    const lastRow = ledgerQ.getLedgerRunningRows({ limit: 1, offset: N4 - 1 })[0];
    const oldFirst = full.running[0];
    expect(lastRow.id).toBe(oldFirst.id);
    expect(lastRow.balancePaise).toBe(oldFirst.balancePaise);
  });
});
