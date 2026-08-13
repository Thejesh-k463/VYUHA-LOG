import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "../helpers/temp-db";
import { report, time } from "./helpers/measure";

/**
 * A2 — the Data Quality Center.
 *
 * `getDataQualityReport` had two nested scans over the whole book:
 *
 *   staleMtmCount  — for every OPEN trade, `[...latestBySymbol.entries()]`
 *                    materialised the entire Map into a fresh array and then
 *                    `.some()` over it with `toUpperCase()` on both sides.
 *   markedTradeIds — for every trade, `.some()` over every mtm_prices row,
 *                    again with two `toUpperCase()` per comparison.
 *
 * That is trades × marks, and `/data-quality` is `force-dynamic`, so it runs in
 * full on every render. better-sqlite3 is synchronous, so it blocks the whole
 * app while it does.
 *
 * The workload here is HEAVY but not extreme: 25,000 trades (5,000 open) and
 * 50,000 marks — an F&O trader after a decade with a few years of bhavcopy
 * marks. The ceiling is a hang sentinel, not a benchmark.
 *
 * ONE TEMP DB PER FILE.
 */

const TRADES = 25_000;
const OPEN = 5_000;
const MARKS = 50_000;
const SYMBOLS = 500;

let t: TempDb;
let dq: typeof import("@/lib/queries/data-quality");

beforeAll(async () => {
  t = await openTempDb("a2-data-quality", { seed: true });
  dq = await import("@/lib/queries/data-quality");

  const sym = (i: number) => `SYM${String(i % SYMBOLS).padStart(4, "0")}`;

  t.db.transaction((tx) => {
    for (let i = 0; i < TRADES; i++) {
      // isOpen is derived from a missing sell side, so the open ones are
      // seeded by leaving sellDate/sellQty out rather than by setting a flag.
      const open = i < OPEN;
      tx.insert(t.schema.trades)
        .values(
          tradeRow({
            symbol: sym(i),
            tradingsymbol: sym(i),
            ...(open ? { sellDate: null, sellQty: 0, sellValue: 0 } : {}),
          }),
        )
        .run();
    }
  });

  t.db.transaction((tx) => {
    for (let i = 0; i < MARKS; i++) {
      tx.insert(t.schema.mtmPrices)
        .values({
          symbol: sym(i),
          price: 100 + (i % 900),
          // Deliberately old, so the stale branch does the most work it can.
          asOfDate: `2026-0${(i % 8) + 1}-15`,
        })
        .run();
    }
  });
}, 600_000);
afterAll(() => t?.cleanup());

describe("A2 · Data Quality Center at the HEAVY tier", () => {
  it("renders in seconds, not minutes", () => {
    const t0 = performance.now();
    const reportOut = dq.getDataQualityReport(new Date("2026-08-13"));
    const ms = performance.now() - t0;

    const timing = time(`getDataQualityReport (${TRADES.toLocaleString()} trades × ${MARKS.toLocaleString()} marks)`, TRADES, () => {});
    report({ ...timing, ms, perItemUs: (ms * 1000) / TRADES }, { test: "a2-heavy", trades: TRADES, marks: MARKS });
    console.log(`    /data-quality at HEAVY: ${ms.toFixed(0)} ms`);

    expect(reportOut).toBeTruthy();
    expect(
      ms,
      `/data-quality took ${(ms / 1000).toFixed(1)} s. It is force-dynamic, so this runs on every ` +
        "render, and better-sqlite3 is synchronous — the whole app is unresponsive for that long. " +
        "Index the marks by upper-cased symbol once instead of scanning them per trade.",
    ).toBeLessThan(3_000);
  });

  it("survives the case where no trade symbol has ever been marked", () => {
    /**
     * THE ACTUAL WORST CASE, and the reason the test above is not the whole
     * story.
     *
     * `markedTradeIds` uses `marks.some(...)`, which SHORT-CIRCUITS on the
     * first match. When every trade's symbol is in the marks table a match is
     * found almost immediately, which is why the shared-symbol run above comes
     * in fast and why "trades × marks" overstates the typical cost.
     *
     * Give it trades whose symbols are NOT in the marks table — an F&O book
     * against equity-only bhavcopy marks, which is an ordinary situation — and
     * `.some()` has to scan all 50,000 rows for every one of the 25,000 trades,
     * doing two `toUpperCase()` allocations per comparison. Nothing
     * short-circuits, and this is the number that matters.
     */
    t.db.transaction((tx) => {
      for (let i = 0; i < 5_000; i++) {
        tx.insert(t.schema.trades).values(tradeRow({ symbol: `UNMARKED${i}`, tradingsymbol: `UNMARKED${i}` })).run();
      }
    });

    const t0 = performance.now();
    dq.getDataQualityReport(new Date("2026-08-13"));
    const ms = performance.now() - t0;
    report({ label: "unmatched symbols (no short-circuit)", ms, n: 5_000, perItemUs: (ms * 1000) / 5_000 }, {
      test: "a2-unmatched",
    });
    console.log(`    /data-quality with 5,000 never-marked symbols: ${ms.toFixed(0)} ms`);

    expect(
      ms,
      `/data-quality took ${(ms / 1000).toFixed(1)} s once symbols stopped matching. ` +
        "marks.some() cannot short-circuit, so it scans every mtm_prices row per trade.",
    ).toBeLessThan(3_000);
  });
});
