import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "../helpers/temp-db";
import { growthRatio, report, time } from "./helpers/measure";

/**
 * SEARCH-N — Search v1 at the HEAVY tier.
 *
 * Two engines answer a query: FTS5 (trigram, external content over `trades`)
 * for the trades source, and the in-memory tier ranker for everything else
 * (the 5,700-row bundled symbol list, help, screens, playbooks, instruments).
 * Both are hit on every keystroke, so the number that matters is the
 * per-query p95, not the mean — a search box that stalls one keystroke in
 * twenty feels broken.
 *
 * Asserted:
 *   - p95 per FTS query < 50 ms on a 25,000-trade book;
 *   - p95 per in-memory fan-out < 10 ms;
 *   - growthRatio() of the FTS path between a 5k and a 20k book ≤ 6
 *     (growthRatio measures n and 4n; the 25k book is then measured on its
 *     own for the p95). Linear ≈ 4; a scan that re-tokenises the book per
 *     query would read ≈ 16.
 *
 * The book is built by TOPPING UP the one temp database (one per file): the
 * FTS triggers index every insert, so building 25k rows is the same work the
 * importer does.
 */

const N = 200;
const SMALL = 5_000;
const HEAVY = 25_000;

/** Note vocabulary — 'kou' (breakout), 'etest' (retest), 'fade', 'chase' are mid-word / whole-word probes. */
const NOTES = [
  "breakout retest held through lunch",
  "gap fade into vwap, chased the second leg",
  "fomo entry, no plan",
  "clean pullback to 20ema",
  "news spike, scratched flat",
  "range low reclaim",
  "orb failed, cut fast",
  "trend day, added on retest",
];
const SETUPS = ["orb", "vcp", "pullback", "gapfade", "reclaim"];
const TICKERS = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "SBIN", "ITC", "LT", "AXISBANK", "MARUTI", "TITAN"];

let t: TempDb;
let search: typeof import("@/lib/queries/search");

const sym = (i: number) => (i % 10 === 0 ? TICKERS[(i / 10) % TICKERS.length] : `SYM${String(i % 500).padStart(4, "0")}`);

/** Insert until the trades table holds `size` rows. Idempotent. */
function topUp(size: number): number {
  const have = (t.sqlite.prepare("SELECT count(*) AS n FROM trades").get() as { n: number }).n;
  if (have >= size) return have;
  t.db.transaction((tx) => {
    for (let i = have; i < size; i++) {
      tx.insert(t.schema.trades)
        .values(
          tradeRow({
            accountId: 1 + (i % 2),
            symbol: sym(i),
            tradingsymbol: sym(i),
            notes: `${NOTES[i % NOTES.length]} #${i}`,
            setupTag: SETUPS[i % SETUPS.length],
            mistakeTags: i % 7 === 0 ? ["fomo", "chased"] : null,
            buyDate: `2026-0${(i % 8) + 1}-1${i % 9}`,
            sellDate: `2026-0${(i % 8) + 1}-2${i % 8}`,
          }),
        )
        .run();
    }
  });
  return size;
}

/** N queries: mid-word trigram over notes, ticker prefix, BSE code, help keyword. */
const QUERIES: string[] = [];
for (let i = 0; i < N; i++) {
  const kind = i % 4;
  if (kind === 0) QUERIES.push(["kou", "etest", "fade", "chase", "pullb", "scratch"][i % 6]);
  else if (kind === 1) QUERIES.push(["REL", "TC", "HDF", "SBI", "ITC", "AXI"][i % 6]);
  else if (kind === 2) QUERIES.push(["500325", "532540", "500180", "500112"][i % 4]);
  else QUERIES.push(["var", "tax", "backup", "stop loss", "ltcg", "delete"][i % 6]);
}

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];

function runFts(): number[] {
  const out: number[] = [];
  for (const q of QUERIES) {
    const t0 = performance.now();
    search.searchTradeIds(q, 0);
    search.searchTradeIds(q, 1);
    out.push(performance.now() - t0);
  }
  return out;
}

const IN_MEMORY = ["symbols", "help", "screens", "playbooks", "instruments"] as const;

function runInMemory(): number[] {
  const out: number[] = [];
  for (const q of QUERIES) {
    const t0 = performance.now();
    search.searchAll(q, { accountId: 0, categories: IN_MEMORY, entitlement: { pro: true } });
    out.push(performance.now() - t0);
  }
  return out;
}

beforeAll(async () => {
  t = await openTempDb("search-N", { seed: true });
  t.db.insert(t.schema.accounts).values({ id: 2, name: "Swing", isDefault: false }).run();
  search = await import("@/lib/queries/search");
  t.db.insert(t.schema.playbooks).values({ name: "Gap fade", description: "fade the open", rules: [] }).run();
}, 600_000);
afterAll(() => t?.cleanup());

describe("SEARCH-N · ranked queries at scale", () => {
  it("FTS path grows linearly between a 5k and a 20k book (growthRatio ≤ 6)", () => {
    const build = time("build 5k book (FTS triggers on)", SMALL, () => topUp(SMALL));
    report(build, { test: "search-N-build" });
    const { ratio, small, large } = growthRatio(
      (size) => topUp(size),
      () => runFts(),
      SMALL,
    );
    report({ ...small, label: `${N} FTS queries × 2 scopes @ ${small.n.toLocaleString()} trades` }, { test: "search-N-ratio" });
    report({ ...large, label: `${N} FTS queries × 2 scopes @ ${large.n.toLocaleString()} trades` }, { test: "search-N-ratio" });
    console.log(`    FTS growth ratio t(20k)/t(5k): ${ratio.toFixed(2)}`);
    expect(ratio, "the FTS path is no longer linear in the book size").toBeLessThanOrEqual(6);
  });

  it(`FTS p95 per query < 50 ms on the ${HEAVY.toLocaleString()}-trade book`, () => {
    const build = time("top up to 25k", HEAVY, () => topUp(HEAVY));
    report(build, { test: "search-N-build" });
    runFts(); // warm
    const ms = runFts();
    const worst = p95(ms);
    const total = ms.reduce((a, b) => a + b, 0);
    report({ label: `FTS ${N} queries @ 25k (p95 per query)`, ms: worst, n: N, perItemUs: (total * 1000) / N }, { test: "search-N-fts-p95", p95: worst, max: Math.max(...ms) });
    console.log(`    FTS @ 25k: p95 ${worst.toFixed(2)} ms, mean ${(total / N).toFixed(2)} ms, max ${Math.max(...ms).toFixed(2)} ms`);
    expect(worst).toBeLessThan(50);
  });

  it("in-memory fan-out (symbols + help + screens + playbooks + instruments) p95 < 10 ms", () => {
    runInMemory(); // warm — builds the symbol candidate list once
    const ms = runInMemory();
    const worst = p95(ms);
    const total = ms.reduce((a, b) => a + b, 0);
    report({ label: `in-memory ${N} queries (p95 per query)`, ms: worst, n: N, perItemUs: (total * 1000) / N }, { test: "search-N-mem-p95", p95: worst, max: Math.max(...ms) });
    console.log(`    in-memory: p95 ${worst.toFixed(2)} ms, mean ${(total / N).toFixed(2)} ms, max ${Math.max(...ms).toFixed(2)} ms`);
    expect(worst).toBeLessThan(10);
  });
});
