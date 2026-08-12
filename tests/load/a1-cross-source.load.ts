import { describe, expect, it } from "vitest";
import { detectCrossSourceDuplicates, type ExistingRow, type IncomingRow } from "@/lib/import/cross-source";
import { report, rng, time } from "./helpers/measure";

/**
 * A1 — cross-source overlap detection, the work that runs on EVERY import
 * preview (lib/import/commit.ts calls it before anything is shown).
 *
 * `detectCrossSourceDuplicates` filters the entire existing book once per
 * incoming row, and `norm()` (trim + toUpperCase) is evaluated INSIDE the
 * predicate on both operands — so two strings are allocated per comparison and
 * nothing can be hoisted out of the loop. That is incoming × existing.
 *
 * At the HEAVY tier (25,000 trades already recorded, a 5,000-row broker export
 * dropped on top) that is 125 million iterations with ~250 million string
 * allocations, in a synchronous handler, while the user stares at a preview
 * that has not appeared yet. The import client re-POSTs the same file up to
 * three times, so a user who assumes it hung and retries pays it again.
 *
 * MEASURED, not inferred: 8,003 ms before the fix, ~20 ms after — 364×. The
 * fix buckets candidates by broker|norm(tradingsymbol) once instead of
 * filtering the whole book per incoming row.
 */

const BROKERS = ["zerodha", "dhan", "groww", "angelone", "upstox", "paytm"];

/**
 * SYMBOL CARDINALITY IS THE VARIABLE THAT DECIDES THIS TEST, so it is chosen
 * deliberately rather than by convenience.
 *
 * Candidates are grouped by broker + tradingsymbol, so the cost of the inner
 * comparison is (rows sharing a symbol)², not (book size)². An early draft of
 * this file used ten symbols and reported a 36× growth ratio against code that
 * is demonstrably 35× faster at the HEAVY tier — the generator, not the
 * subject, was producing the quadratic.
 *
 * 500 is defensible for a decade: a delivery trader touches 50-150 scrips, and
 * an F&O trader's tradingsymbols carry strike and expiry, so every weekly
 * contract is a distinct key and cardinality runs into the thousands. 500 is
 * the conservative middle. The genuinely pathological case — one symbol, whole
 * book — is covered separately below, and honestly, because no bucketing can
 * help it.
 */
const SYMBOL_COUNT = 500;
const SYMBOLS = Array.from({ length: SYMBOL_COUNT }, (_, i) => `SYM${String(i).padStart(4, "0")}`);

function makeExisting(count: number): ExistingRow[] {
  const r = rng(1);
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    // One broker dominates, which is the realistic shape: the candidate filter
    // only narrows by broker, so a trader who uses mostly one broker gets the
    // worst case. Spreading evenly across six would understate it 6×.
    broker: r() < 0.7 ? "zerodha" : BROKERS[Math.floor(r() * BROKERS.length)],
    symbol: SYMBOLS[Math.floor(r() * SYMBOLS.length)],
    tradingsymbol: SYMBOLS[Math.floor(r() * SYMBOLS.length)],
    buyQty: 1 + Math.floor(r() * 500),
    sellQty: 1 + Math.floor(r() * 500),
    buyValue: Math.round(r() * 500_000) / 100,
    sellValue: Math.round(r() * 500_000) / 100,
    buyDate: "2026-01-05",
    sellDate: "2026-01-09",
    sourceFile: `older-export-${i % 40}.csv`,
    dedupHash: `existing-${i}`,
  }));
}

function makeIncoming(count: number): IncomingRow[] {
  const r = rng(2);
  return Array.from({ length: count }, (_, i) => ({
    broker: "zerodha",
    symbol: SYMBOLS[Math.floor(r() * SYMBOLS.length)],
    tradingsymbol: SYMBOLS[Math.floor(r() * SYMBOLS.length)],
    buyQty: 1 + Math.floor(r() * 500),
    sellQty: 1 + Math.floor(r() * 500),
    buyValue: Math.round(r() * 500_000) / 100,
    sellValue: Math.round(r() * 500_000) / 100,
    buyDate: "2026-02-02",
    sellDate: "2026-02-06",
    dedupHash: `incoming-${i}`,
  }));
}

describe("A1 · cross-source overlap on import preview", () => {
  it("keeps a HEAVY-tier preview well under a second", () => {
    /**
     * A GENEROUS ABSOLUTE CEILING, not a ratio — chosen after trying the ratio
     * and finding it the wrong instrument here.
     *
     * Before the Map bucketing this exact workload took 8,003 ms; after, 22 ms.
     * Any ceiling between those two separates them, and 2,000 ms leaves ~90×
     * headroom over the current number — enough that no plausible runner, GC
     * pause or CI contention trips it, while a reintroduced full-book scan
     * (which costs 8 s here) fails immediately.
     *
     * A t(4n)/t(n) ratio cannot do this job: at realistic symbol cardinality
     * the fixed code is faster than the timer noise floor, so the ratio becomes
     * jitter. Ratios need a baseline big enough to measure — see growthRatio's
     * own guard.
     */
    const existing = makeExisting(25_000);
    const incoming = makeIncoming(5_000);
    const t = time("BUDGET: 5,000 incoming × 25,000 existing", 5_000, () => {
      detectCrossSourceDuplicates(incoming, existing, "new-export.csv");
    });
    report(t, { test: "a1-budget", ceilingMs: 2_000 });

    expect(
      t.ms,
      `import preview took ${t.ms.toFixed(0)} ms. It was 8,003 ms before the candidates were ` +
        "bucketed by broker|norm(tradingsymbol); if this regressed, something is scanning the " +
        "whole book per incoming row again — and it blocks the event loop while it does.",
    ).toBeLessThan(2_000);
  });

  it("survives the pathological single-symbol book, and says what it costs", () => {
    // Every trade in one scrip. Grouping cannot help — the candidate set IS the
    // book — so this is inherently incoming × existing and always will be.
    // Report it rather than pretend otherwise; the sentinel only catches a hang.
    const one = "RELIANCE";
    const existing = makeExisting(10_000).map((e) => ({ ...e, broker: "zerodha", tradingsymbol: one }));
    const incoming = makeIncoming(1_000).map((i) => ({ ...i, broker: "zerodha", tradingsymbol: one }));
    const t = time("PATHOLOGICAL: 1,000 × 10,000, all one symbol", 1_000, () => {
      detectCrossSourceDuplicates(incoming, existing, "new-export.csv");
    });
    report(t, { test: "a1-pathological" });
    expect(t.ms, "a single-symbol book should still finish, however slowly").toBeLessThan(120_000);
  });

});
