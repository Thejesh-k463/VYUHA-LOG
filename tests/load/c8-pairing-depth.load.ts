import { describe, expect, it } from "vitest";
import { pairLegs, summarisePairing, type Leg } from "@/lib/import/pair-legs";
import { growthRatio, report, rng, time } from "./helpers/measure";

/**
 * C8 — the pairing engine at depth.
 *
 * WHY THIS FILE EXISTS. `lib/import/pair-legs.ts` was rewritten on 2026-08-20
 * (v2.99.98) from a single pass to TWO — pass 1 measures the orphan quantity a
 * file never shows being bought, pass 2 seeds it as the oldest lot so opening
 * sells land where the broker puts them. It is the hot path for FIVE import
 * sources (Zerodha, Paytm Money, Dhan GTR, Groww orders, generic column
 * mapper), and the load suite was written five days BEFORE that rewrite. An
 * import-graph scan of the other twelve cases found none of them import this
 * module, so the most algorithmically significant change in the import path
 * has never been measured.
 *
 * THE SHAPE UNDER TEST. Per symbol the engine sorts legs, then walks them
 * consuming a FIFO lot queue. The cost of a sell is proportional to the number
 * of OPEN LOTS, not to the number of legs — so a book where buys outnumber
 * sells lets `lots` grow without bound and turns per-sell work into per-sell ×
 * per-lot work. Real files seen so far are small (Zerodha 1,554 fills → 28
 * positions; Paytm 414 → 142). A trader accumulating months of one symbol is
 * the case nobody has measured, and it is the one the owner asked about:
 * "works the same after weeks and months of data".
 *
 * WHAT IS ASSERTED. Growth ratios, per the suite's stated preference — a ratio
 * cancels machine speed. Linear work returns ~4 at 4n; quadratic returns ~16.
 * The bar is 6, matching `growthRatio`'s own docstring. Absolute milliseconds
 * are reported, never asserted.
 *
 * WHAT IT FOUND, 2026-08-21. A real quadratic. Each sell ran THREE O(lots)
 * scans — a full-queue walk looking for same-day lots, `.some()` + `.find()`
 * inside the oldest-first loop, and a `splice` compaction — so a queue that
 * grows (buys outnumbering sells) turned the walk into O(n²):
 *
 *   one symbol, growing queue   8,000 → 79 ms   32,000 → 1,249 ms   ratio 15.89x
 *   opening-sell heavy         14,000 → 70 ms   56,000 →   937 ms   ratio 13.32x
 *   many symbols               24,000 → 26 ms   96,000 →   109 ms   ratio  4.19x  (fine)
 *
 * Fixed the same day with a forward-only `head` pointer plus a per-date index
 * (lib/import/pair-legs.ts). Same lot chosen every time — 1,920 unit tests and
 * both real-file reconciliations (Paytm 414 executions vs Paytm's own Realized
 * P&L Detail, Zerodha 1,554 fills) pass unchanged, and 50,000 legs on one
 * symbol went 775 ms → 63 ms producing byte-identical output.
 *
 * The baselines below were RAISED after the fix: at the old sizes the work
 * finished under `growthRatio`'s 25 ms floor, which is the failure mode its own
 * docstring describes — a ratio built on timer noise.
 */

/** One symbol, `n` legs, `buyShare` of them buys. Deterministic. */
function oneSymbol(n: number, buyShare: number, seed: number): Leg[] {
  const rand = rng(seed);
  const legs: Leg[] = [];
  for (let i = 0; i < n; i++) {
    // Spread across ~2 years of trading days so FIFO-across-days is exercised
    // rather than collapsing into the same-day-netting branch.
    const day = new Date(Date.UTC(2025, 0, 2 + Math.floor(i / 3)));
    const qty = 10 + Math.floor(rand() * 90);
    const price = 100 + rand() * 900;
    legs.push({
      symbol: "ACCUM",
      side: rand() < buyShare ? "buy" : "sell",
      date: day.toISOString().slice(0, 10),
      qty,
      value: Math.round(qty * price * 100) / 100,
      charges: Math.round(qty * price * 0.0012 * 100) / 100,
      exchange: "NSE",
      product: "delivery",
    });
  }
  return legs;
}

/** `n` legs spread over `symbols` symbols — the realistic accumulated book. */
function manySymbols(n: number, symbols: number, seed: number): Leg[] {
  const rand = rng(seed);
  const legs: Leg[] = [];
  for (let i = 0; i < n; i++) {
    const day = new Date(Date.UTC(2025, 0, 2 + Math.floor(i / symbols)));
    const qty = 10 + Math.floor(rand() * 90);
    const price = 100 + rand() * 900;
    legs.push({
      symbol: `SYM${i % symbols}`,
      // Alternate per symbol-cycle so each symbol genuinely pairs rather than
      // ending up single-sided (the trap c2 documents for its own generator).
      side: Math.floor(i / symbols) % 2 === 0 ? "buy" : "sell",
      date: day.toISOString().slice(0, 10),
      qty,
      value: Math.round(qty * price * 100) / 100,
      charges: Math.round(qty * price * 0.0012 * 100) / 100,
      exchange: "NSE",
      product: "delivery",
    });
  }
  return legs;
}

describe("C8 · pairing engine at depth", () => {
  it("scales linearly across MANY symbols — work partitions per symbol", () => {
    const { ratio, small, large } = growthRatio(
      (size) => manySymbols(size, 500, 0xc8a),
      (legs: Leg[]) => void pairLegs(legs),
      24_000,
    );
    report(small, { test: "c8", shape: "many-symbols" });
    report(large, { test: "c8", shape: "many-symbols" });
    console.log(`    many symbols: 4n cost ${ratio.toFixed(2)}× n`);
    expect(ratio, `4× the legs across 500 symbols cost ${ratio.toFixed(1)}× the time`).toBeLessThan(6);
  });

  it("scales linearly on ONE symbol whose lot queue keeps growing", () => {
    // 65% buys: the queue grows monotonically, which is the accumulation case.
    const { ratio, small, large } = growthRatio(
      (size) => oneSymbol(size, 0.65, 0xc8b),
      (legs: Leg[]) => void pairLegs(legs),
      24_000,
    );
    report(small, { test: "c8", shape: "one-symbol-growing-queue" });
    report(large, { test: "c8", shape: "one-symbol-growing-queue" });
    console.log(`    one symbol, growing queue: 4n cost ${ratio.toFixed(2)}× n`);
    expect(
      ratio,
      `4× the legs on ONE symbol cost ${ratio.toFixed(1)}× the time — the FIFO lot queue is being rescanned per sell`,
    ).toBeLessThan(6);
  });

  it("scales linearly when the book is opening-sell heavy (forces the pass-2 seed)", () => {
    // 25% buys: most sells have no lot to consume, so pass 1 measures a large
    // orphan quantity and pass 2 re-runs the whole walk with a seeded lot.
    const { ratio, small, large } = growthRatio(
      (size) => oneSymbol(size, 0.25, 0xc8c),
      (legs: Leg[]) => void pairLegs(legs),
      30_000,
    );
    report(small, { test: "c8", shape: "opening-sell-heavy" });
    report(large, { test: "c8", shape: "opening-sell-heavy" });
    console.log(`    opening-sell heavy: 4n cost ${ratio.toFixed(2)}× n`);
    expect(ratio, `4× the legs with a seeded opening lot cost ${ratio.toFixed(1)}× the time`).toBeLessThan(6);
  });

  it("conserves quantity and value at ABUSIVE depth", () => {
    // The load README's ABUSIVE tier is 2,000,000 trade_legs across the book;
    // 50,000 on a single symbol is a deliberately unfair slice of it.
    const legs = oneSymbol(50_000, 0.55, 0xc8d);
    let paired!: ReturnType<typeof pairLegs>;
    const t = time("pairLegs, 50,000 legs on ONE symbol", legs.length, () => {
      paired = pairLegs(legs);
    });
    const s = summarisePairing(legs, paired);
    const totalIn = legs.reduce((acc, l) => acc + l.value, 0);
    const relDrift = Math.abs(s.valueDelta) / totalIn;
    report(t, { test: "c8", shape: "abusive-conservation", positions: paired.length, totalIn, relDrift, ...s });
    console.log(
      `    50,000 legs → ${paired.length} positions ` +
        `(${s.closed} closed / ${s.open} open / ${s.openingSells} opening-sell)`,
    );
    console.log(
      `    value ₹${totalIn.toFixed(0)} in, drift ₹${s.valueDelta.toFixed(2)} ` +
        `= ${(relDrift * 1e9).toFixed(2)} parts per billion`,
    );

    // FIFO moves quantity between records; it must never invent or lose any.
    // Quantities are integers, so this is exact and any drift is a real bug.
    expect(s.qtyDelta, "pairing lost or invented quantity at depth").toBe(0);

    /**
     * Value is a float64 sum over 50,000 legs totalling ~₹1.4 billion, so an
     * ABSOLUTE rupee bar is the wrong instrument — IEEE-754 alone accumulates a
     * few rupees at that magnitude, which says nothing about correctness. The
     * meaningful invariant is RELATIVE: value must be conserved to within one
     * part in a million. Float noise sits around one part per billion, so this
     * leaves three orders of magnitude of headroom and still catches a real
     * leak (a dropped lot would move whole percent, not parts per billion).
     * The absolute figure is reported above so a genuine regression is visible
     * to a human reading the run.
     */
    expect(relDrift, `value drifted ₹${s.valueDelta} on ₹${totalIn.toFixed(0)}`).toBeLessThan(1e-6);
  });
});
