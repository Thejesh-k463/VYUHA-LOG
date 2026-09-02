import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RISK_LIST_CAP } from "@/components/ui/capped-note";
import { WINDOW_STEP } from "@/components/ui/show-more";
import { SLIM_TRADE_FIELDS } from "@/lib/domain/slim-trade";

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
 *
 * ── They match STRIPPED source, always ──────────────────────────────────────
 *
 * v3.7.0 found three guards in this family that passed against reverted code;
 * one of them matched the call it was guarding inside a DOC COMMENT
 * (DECISIONS.md 2026-09-02). Every match below runs on comment-stripped
 * source, so prose describing a mechanism can never stand in for the
 * mechanism.
 */

const root = path.resolve(__dirname, "..");
const readRaw = (p: string) => readFileSync(path.join(root, p), "utf8");

// The `capital-fallback-guard.test.ts` stripper, verbatim: a block-comment
// opener is never preceded by a word char, comma or star (those are MIME
// wildcards like "text/csv,*/*", which a naive strip ate from).
const stripComments = (src: string) =>
  src
    .replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const read = (p: string) => stripComments(readRaw(p));

/** The string entries of a `const NAME = [ … ] as const` field list. */
const fieldList = (src: string, name: string): string[] => {
  const start = src.indexOf(`const ${name} = [`);
  expect(start, `${name} is no longer declared as a field list`).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("] as const", start));
  return [...body.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
};

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

/**
 * /lenses, v3.7.0 (the sixth route; measured 1718 / 1557 ms against a 1500 ms
 * budget on the seeded perf book). Same rule as the v3.4.0 pass: nothing here
 * changed a SQL predicate, an ORDER BY, or a figure — the page stopped
 * shipping 25,001 trades so a browser could rebuild 45 group rows it had
 * already been given.
 */
describe("/lenses ships group rows, not the book", () => {
  const page = read("app/lenses/page.tsx");
  const client = read("components/lenses/lenses-client.tsx");
  const route = read("app/api/lenses/members/route.ts");

  it("the page hands the client its own grouping output, never the trades", () => {
    expect(page, "the page stopped shipping group rows").toMatch(/lenses=\{lenses\}/);
    // The regression: putting the book back on the wire (~9.3 MB of RSC
    // flight at 25,001 rows) so the client can group it again.
    expect(page, "the whole book is crossing the RSC payload again").not.toMatch(/trades=\{/);
    expect(page, "batches/playbooks are label sources — they stay server-side")
      .not.toMatch(/(batches|playbooks)=\{/);
  });

  it("the client no longer groups the book — it has no book to group", () => {
    for (const fn of ["lensGroups(", "groupIds("]) {
      expect(client, `lenses-client is calling ${fn} again`).not.toContain(fn);
    }
    // Scoped to LensesClient's own signature: `GroupDetail` legitimately takes
    // a `trades` prop — that is the ONE group's members, fetched on demand.
    const signature = client.slice(
      client.indexOf("export function LensesClient("),
      client.indexOf("const router = useRouter()"),
    );
    expect(signature.length).toBeGreaterThan(50);
    expect(signature, "a `trades` prop is back on the client").not.toMatch(/\btrades\b/);
    // The KPI split stays server-side, or the paywall is decoration.
    expect(client, "the client is computing KPIs again").not.toContain("computeKpis");
  });

  it("the group list renders a window and says what it held back", () => {
    // Scoped to GroupList: `LedgerColumn` also maps a prop called `rows` (the
    // top-5 winners), and that list is capped at five by construction.
    const list = client.slice(client.indexOf("function GroupList("), client.indexOf("function EdgeCell("));
    expect(list.length).toBeGreaterThan(500);
    expect(list, "GroupList lost useRowWindow").toContain("useRowWindow");
    expect(list, "GroupList lost its ShowMore control").toContain("<ShowMore");
    expect(list, "GroupList renders something other than the window").toMatch(/win\.visible\.map\(/);
    // The tell-tale of a regression: mapping every group again.
    expect(list, "GroupList is mapping every group again").not.toMatch(/\brows\.map\(/);
  });

  it("the drill-down keeps its stated cap and its virtualized table", () => {
    expect(client, "DRILL_LIMIT no longer bounds the drill-down list").toMatch(/slice\(0,\s*DRILL_LIMIT\)/);
    const call = client.slice(client.indexOf("<DataTable"), client.indexOf("<DataTable") + 400);
    expect(call, "the drill-down DataTable lost its `virtual` prop").toMatch(/\bvirtual\b/);
    // …and it still states the cap rather than quietly showing a subset.
    expect(client, "the drill-down cap stopped stating itself").toMatch(/Showing the first \{shown\.length\} of \{trades\.length\}/);
  });

  it("the members route re-derives from the SAME projection and the SAME order", () => {
    // The equivalence argument is that this route runs the page's own code
    // over the page's own read. A bespoke query here — a WHERE, an ORDER BY,
    // or the whole-row reader — breaks it silently: the drill-down, the
    // top-5 ledger and the DELETE preview all read this array.
    expect(route, "the members route stopped using the /lenses projection").toContain("getLensTrades");
    for (const bad of ["db.select", "orderBy", "getTrades()", "getSlimTrades"]) {
      expect(route, `the members route grew its own read (${bad})`).not.toContain(bad);
    }
    for (const pure of ["lensGroups", "groupIds"]) {
      expect(route, `the members route stopped resolving groups with ${pure}`).toContain(pure);
    }
    // Pro insights keep routing through the one allow-list.
    expect(route, "the route attaches insights past the paywall allow-list").toContain("toLensRow");
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

  it("LENS_FIELDS stays a strict subset of the /trades wire shape, and does not creep", () => {
    // The prose above LENS_FIELDS used to state both counts ("19 columns, not
    // the 43 of SlimTrade") and was wrong for two releases — SLIM_TRADE_FIELDS
    // went 43 → 44 → 45 when v3.7.0 added `reviewedAt`, and no test could
    // fail. The arrays are the count now; this is what holds them apart.
    const lens = fieldList(src, "LENS_FIELDS");
    expect(lens.length).toBeGreaterThan(10);
    const strays = lens.filter((f) => !(SLIM_TRADE_FIELDS as readonly string[]).includes(f));
    expect(strays, `LENS_FIELDS selects columns /trades does not: ${strays.join(", ")}`).toEqual([]);
    expect(
      lens.length,
      "LENS_FIELDS has crept up to the whole wire shape — the projection was the /lenses fix",
    ).toBeLessThan(SLIM_TRADE_FIELDS.length - 15);
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
