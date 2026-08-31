import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RISK_LIST_CAP } from "@/components/ui/capped-note";
import { WINDOW_STEP } from "@/components/ui/show-more";

/**
 * The v3.4.0 render-windowing pass, pinned.
 *
 * Six routes sat over the perf budget for two releases. Five of them were fixed
 * not by touching SQL but by refusing to put rows nobody looks at into the DOM:
 *
 *   /strategies       6026 → 1022 ms   626 payoff charts, mounted on approach
 *   /options-journal  5770 → 1082 ms   8,058 form rows → a window
 *   /equity           3208 →  931 ms   ~2,750 rows → DataTable `virtual`
 *   /risk             2503 → 1349 ms   two windows + three stated caps
 *   /lenses           2114 → 1276 ms   43-column projection → 19
 *
 * Every one of those is a single prop or a single call. Any of them can be
 * removed by accident in a refactor, and NOTHING would go red — `perf:sweep`
 * is not in CI, and none of these routes has an e2e spec. That is precisely how
 * the six breaches accumulated unnoticed in the first place.
 *
 * So these are source guards, the same tool `pro-gating.test.ts` uses to pin
 * which pages must not carry a <ProGate>. They are deliberately shallow: they
 * assert the mechanism is still wired, not that it works. What proves it works
 * is `npm run perf:seed && npm run perf:sweep`.
 */

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

describe("row windowing is still wired on the routes that needed it", () => {
  it("/equity's tracker table passes `virtual` to DataTable", () => {
    const src = read("components/trackers/tracker-client.tsx");
    const call = src.slice(src.indexOf("<DataTable"), src.indexOf("<DataTable") + 400);
    expect(call, "the tracker DataTable lost its `virtual` prop").toMatch(/\bvirtual\b/);
  });

  it("/options-journal's editor renders a window, not every contract", () => {
    const src = read("components/behavior/options-journal-editor.tsx");
    expect(src).toContain("useRowWindow");
    expect(src).toContain("ShowMore");
    // The tell-tale of a regression: mapping the raw prop again.
    expect(src, "editor is mapping all trades again").not.toMatch(/\btrades\.map\(/);
  });

  it("/risk's cockpit and margin panel both window their position lists", () => {
    for (const f of ["components/risk/risk-cockpit-client.tsx", "components/risk/margin-panel.tsx"]) {
      const src = read(f);
      expect(src, `${f} lost useRowWindow`).toContain("useRowWindow");
      expect(src, `${f} lost its ShowMore control`).toContain("ShowMore");
    }
    expect(read("components/risk/risk-cockpit-client.tsx"), "cockpit maps every position again")
      .not.toMatch(/e\.positions\.map\(\(p\)\s*=>\s*\(?\s*<PositionRow/);
    expect(read("components/risk/margin-panel.tsx"), "margin panel maps every position again")
      .not.toMatch(/summary\.positions\.map\(/);
  });

  it("/strategies mounts its 626 payoff charts lazily", () => {
    const src = read("app/strategies/page.tsx");
    expect(src).toContain("LazyMount");
    // A bare <PayoffChart> outside LazyMount is the regression.
    const idx = src.indexOf("<PayoffChart");
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, idx - 200), idx), "PayoffChart is no longer inside a LazyMount")
      .toContain("LazyMount");
  });
});

describe("every server-side cap states what it held back", () => {
  // A silent .slice() reads as "this is your whole book". Each of these three
  // panels caps at RISK_LIST_CAP, so each must also render a CappedNote.
  const capped = [
    "components/risk/expiry-obligations.tsx",
    "components/risk/greeks-panel.tsx",
    "components/risk/mtf-drift-card.tsx",
  ];

  it.each(capped)("%s slices with RISK_LIST_CAP and renders CappedNote", (f) => {
    const src = read(f);
    expect(src, `${f} slices without using the shared cap`).toContain("RISK_LIST_CAP");
    expect(src, `${f} caps its list but does not say so`).toContain("<CappedNote");
  });

  it("no capped panel uses a bare numeric slice", () => {
    for (const f of capped) {
      expect(read(f), `${f} has a hardcoded slice`).not.toMatch(/\.slice\(0,\s*\d+\)/);
    }
  });
});

describe("the windowing constants stay sane", () => {
  it("a window step large enough to fill a scroller, small enough to matter", () => {
    expect(WINDOW_STEP).toBeGreaterThanOrEqual(50);
    expect(WINDOW_STEP).toBeLessThanOrEqual(500);
  });

  it("the risk cap is bounded — an unbounded cap is not a cap", () => {
    expect(RISK_LIST_CAP).toBeGreaterThanOrEqual(25);
    expect(RISK_LIST_CAP).toBeLessThanOrEqual(500);
  });
});

describe("the projections that replaced whole-row reads", () => {
  const src = read("lib/queries/trades.ts");

  it("/options-journal and /strategies no longer select every column", () => {
    expect(src).toContain("OPTION_JOURNAL_FIELDS");
    expect(src).toContain("STRATEGY_LEG_FIELDS");
    // `getTrades()` is the canonical whole-book reader and KEEPS its bare
    // db.select() on purpose — every projection is proved against it. So the
    // guard is that the two option readers use pickCols, not that no bare
    // select exists anywhere.
    for (const fn of ["getOptionTrades", "getOpenOptionPositions"]) {
      const body = src.slice(src.indexOf(`export const ${fn}`), src.indexOf(`export const ${fn}`) + 700);
      expect(body, `${fn} is selecting every column again`).toContain("pickCols");
      expect(body, `${fn} has a bare db.select()`).not.toMatch(/db\.select\(\)/);
    }
  });

  it("/lenses has its own projection rather than narrowing /trades' shared one", () => {
    expect(src).toContain("LENS_FIELDS");
    expect(src).toContain("getLensTrades");
    expect(read("app/lenses/page.tsx")).toContain("getLensTrades");
  });

  it("every projection still orders by the same keys, so tie order is unchanged", () => {
    // Projections are safe precisely because they add no WHERE and no new sort.
    // If one of these gains an ORDER BY of its own, the equivalence argument in
    // this file's header stops holding — see docs/DECISIONS.md 2026-08-29.
    // Nested parens make a regex for the whole call fragile, so compare counts:
    // every .orderBy( in this file must be the one canonical ordering.
    // Only orderings on the TRADES table — `getImportBatches` legitimately
    // orders importBatches by importedAt and is not part of this contract.
    const onTrades = (src.match(/\.orderBy\(desc\(trades\./g) ?? []).length;
    const canonical = (src.match(/\.orderBy\(desc\(trades\.sellDate\),\s*desc\(trades\.createdAt\)\)/g) ?? []).length;
    expect(onTrades).toBeGreaterThanOrEqual(4);
    expect(canonical, `${onTrades - canonical} trades query orders differently`).toBe(onTrades);
  });
});
