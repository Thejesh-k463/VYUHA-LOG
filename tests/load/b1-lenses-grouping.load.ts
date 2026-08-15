import { describe, expect, it } from "vitest";
import { LENSES, lensGroups, groupIds, type LensTrade } from "@/lib/domain/lenses";
import { growthRatio, report, rng, time } from "./helpers/measure";

/**
 * B1 — the Lenses page at scale.
 *
 * `app/lenses/page.tsx` does, for every lens, `lensGroups()` then
 * `groupIds(group, trades)` per group. For the predicate-shaped scopes
 * (broker / segment / importBatch) `groupIds` re-filters the WHOLE book per
 * group. Brokers and segments are bounded (7 and ~6), so those cuts stay
 * linear; import batches are not — a trader who imports weekly has hundreds of
 * them, and each one costs a full pass over the book. That is
 * O(batches × trades), and batches grow with trades, so it is quadratic in the
 * book. Pure module, so the whole thing measures with no database.
 *
 * Both axes grow together (batches = trades / 8) — the first trap the README
 * records is scaling one axis of a product and calling it linear.
 */

const BROKERS = ["dhan", "zerodha", "groww", "angelone", "upstox"];
const SEGMENTS = ["eq_delivery", "eq_intraday", "eq_mtf", "fo_options", "fo_futures", "commodity"];
const TRADES_PER_BATCH = 8;

function makeBook(n: number): { trades: LensTrade[]; batches: { id: number; fileName: string; broker: string; importedAt: string }[] } {
  const rand = rng(0xb1 + n);
  const batchCount = Math.ceil(n / TRADES_PER_BATCH);
  const batches = Array.from({ length: batchCount }, (_, i) => ({
    id: i + 1,
    fileName: `tradebook-${i + 1}.csv`,
    broker: BROKERS[i % BROKERS.length],
    importedAt: `2026-0${1 + (i % 8)}-01T10:00:00.000Z`,
  }));
  const trades: LensTrade[] = [];
  for (let i = 0; i < n; i++) {
    const batch = batches[Math.floor(i / TRADES_PER_BATCH)];
    const month = 1 + Math.floor(rand() * 8);
    const isOpen = rand() < 0.1;
    const net = Math.round((rand() - 0.45) * 10_000) / 100;
    trades.push({
      id: i + 1,
      accountId: 1,
      broker: batch.broker,
      segment: SEGMENTS[i % SEGMENTS.length],
      symbol: `S${i % 500}`,
      tradingsymbol: `S${i % 500}`,
      buyDate: `2026-0${month}-0${1 + (i % 9)}`,
      sellDate: isOpen ? null : `2026-0${month}-1${i % 9}`,
      isOpen,
      netPnl: net,
      importBatchId: i % 40 === 0 ? null : batch.id, // some manual entries, honestly grouped
      createdAt: "2026-07-01T10:00:00.000Z",
      setupTag: i % 3 === 0 ? `setup-${i % 12}` : null,
      playbookId: i % 5 === 0 ? 1 + (i % 4) : null,
      bucket: "equity",
      grossPnl: net + 12,
      chargesTotal: 12,
      rMultiple: null,
    });
  }
  return { trades, batches };
}

/** Exactly the loop the page runs — every lens, every group's member ids. */
function pageLoop(book: ReturnType<typeof makeBook>): number {
  const ctx = { batches: book.batches, playbooks: [{ id: 1, name: "A" }, { id: 2, name: "B" }] };
  let members = 0;
  for (const lens of LENSES) {
    for (const group of lensGroups(lens.kind, book.trades, ctx)) {
      members += groupIds(group, book.trades).length;
    }
  }
  return members;
}

describe("B1 · lens grouping across an unbounded number of import files", () => {
  it("every lens is a partition at scale (each trade counted once per lens)", () => {
    const book = makeBook(20_000);
    expect(pageLoop(book)).toBe(20_000 * LENSES.length);
  });

  it("the page loop grows linearly with the book, not with book × import files", () => {
    // Raise n until the baseline clears the 25 ms floor; the ratio is what is
    // asserted, the absolute time is only reported.
    // 80k is where a LINEAR loop clears the floor comfortably (~60 ms); the
    // quadratic version took 55 ms at 10k and 794 ms at 40k.
    let n = 80_000;
    let r: ReturnType<typeof growthRatio> | null = null;
    for (;;) {
      try {
        r = growthRatio((size) => makeBook(size), (b: ReturnType<typeof makeBook>) => void pageLoop(b), n);
        break;
      } catch (e) {
        if (n >= 320_000) throw e;
        n *= 2;
      }
    }
    console.log(`    n=${r.small.n}: ${r.small.ms.toFixed(0)} ms · n=${r.large.n}: ${r.large.ms.toFixed(0)} ms · ratio ${r.ratio.toFixed(2)}`);
    report(time("lenses page loop, small", r.small.n, () => {}), { test: "b1", ms: r.small.ms, ratio: r.ratio });
    report(time("lenses page loop, large", r.large.n, () => {}), { test: "b1", ms: r.large.ms, ratio: r.ratio });
    // Measured: the quadratic groupIds gave 14.3 (55 ms → 794 ms at 10k/40k);
    // the indexed one gives 5.1–5.3 at 80k/320k — above a clean 4 because two
    // lenses sort (n log n) and 320k trade objects put pressure on the GC.
    // 8 sits between the two with room for a noisy runner on either side.
    expect(
      r.ratio,
      `t(4n)/t(n) = ${r.ratio.toFixed(1)} — groupIds() re-filters the whole book once per import-batch group (lenses.ts groupIds), which is quadratic in the book.`,
    ).toBeLessThan(8);
  });
});
