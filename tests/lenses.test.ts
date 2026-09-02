import { describe, expect, it } from "vitest";
import {
  LENSES, lensGroups, groupIds, setupGroups, outcomeGroups, isLensKind,
  type LensTrade,
} from "@/lib/domain/lenses";
import {
  resolveDeleteScope, monthGroups, importFileGroups, effectiveDateOf, monthLabel,
} from "@/lib/domain/delete-scope";

/**
 * The Lenses page re-groups the same book six ways and offers to delete any
 * group. Two properties carry the whole feature:
 *
 *   1. every lens is a PARTITION — the groups add up to the book exactly once,
 *      so no trade is invisible and none is counted twice;
 *   2. what a group COUNTS is what deleting it REMOVES — the group's ids and
 *      the resolved delete scope are the same set.
 *
 * Everything else is presentation.
 */

let seq = 1;
const t = (over: Partial<LensTrade> = {}): LensTrade => ({
  id: seq++,
  accountId: 1,
  broker: "dhan",
  segment: "eq_delivery",
  symbol: "TCS",
  tradingsymbol: "TCS",
  buyDate: "2026-07-01",
  sellDate: "2026-07-10",
  isOpen: false,
  netPnl: 100,
  importBatchId: null,
  createdAt: "2026-07-01T10:00:00.000Z",
  staged: false,
  setupTag: null,
  playbookId: null,
  bucket: "equity",
  grossPnl: 120,
  chargesTotal: 20,
  rMultiple: null,
  ...over,
});

const ctx = (over: Partial<Parameters<typeof lensGroups>[2]> = {}) => ({
  batches: [],
  playbooks: [],
  ...over,
});

describe("every lens is a partition", () => {
  // A trade of each awkward kind: open, undated, imported, hand-entered,
  // tagged, untagged, on a deleted playbook, breakeven.
  const book: LensTrade[] = [
    t({ segment: "eq_mtf", broker: "zerodha", setupTag: "breakout", importBatchId: 7 }),
    t({ segment: "index_option", broker: "dhan", playbookId: 1, importBatchId: 7 }),
    t({ segment: "eq_intraday", isOpen: true, sellDate: null, netPnl: 0 }),
    t({ segment: "future", buyDate: null, sellDate: null, isOpen: true, netPnl: 0 }),
    t({ netPnl: -50, playbookId: 99, importBatchId: 42 }),
    t({ netPnl: 0, sellDate: "2026-08-03" }),
  ];
  const c = ctx({ batches: [{ id: 7, fileName: "kite.csv", broker: "zerodha", importedAt: "2026-07-11T00:00:00Z" }], playbooks: [{ id: 1, name: "Gap fade" }] });

  for (const lens of LENSES) {
    it(`${lens.kind}: every trade lands in exactly one group`, () => {
      const groups = lensGroups(lens.kind, book, c);
      const seen = groups.flatMap((g) => groupIds(g, book));
      expect(seen.slice().sort()).toEqual(book.map((x) => x.id).sort());
      expect(new Set(seen).size).toBe(seen.length); // no trade in two groups
    });

    it(`${lens.kind}: group counts sum to the book`, () => {
      const groups = lensGroups(lens.kind, book, c);
      expect(groups.reduce((s, g) => s + g.count, 0)).toBe(book.length);
    });

    it(`${lens.kind}: deleting a group removes exactly what it counted`, () => {
      // This is the property the whole delete story rests on. A group that
      // counts 4 and whose scope resolves to 5 is the bug the preview exists
      // to prevent.
      for (const g of lensGroups(lens.kind, book, c)) {
        const resolved = resolveDeleteScope(book, g.scope);
        expect(resolved.count).toBe(g.count);
        expect(resolved.ids.slice().sort()).toEqual(groupIds(g, book).slice().sort());
      }
    });

    it(`${lens.kind}: declares whether it overlaps`, () => {
      expect(lens.overlapping).toBe(false);
    });
  }
});

describe("a group's members answer for the whole book (the /api/lenses/members contract)", () => {
  /**
   * v3.7.0 stopped shipping the book to the browser: `/lenses` sends the group
   * rows, and the drill-down fetches ONE group's members from
   * `app/api/lenses/members`. Two things on screen are then resolved against
   * that member array instead of the whole book — the delete preview, and
   * every figure in the drill-down.
   *
   * That substitution is only safe because a lens group holds exactly the
   * trades its scope matches, in book order. This pins it. The fixture is
   * deliberately built so its ARRAY order is the reverse of its id order and
   * the groups of every lens are interleaved: an implementation that returned
   * members sorted by id, or grouped-then-concatenated, passes an
   * order-blind assertion and fails this one.
   */
  const built: LensTrade[] = [
    t({ broker: "zerodha", segment: "eq_mtf", setupTag: "breakout", buyDate: "2026-05-02", sellDate: "2026-05-09", netPnl: 1234.56, importBatchId: 3 }),
    t({ broker: "dhan", segment: "index_option", setupTag: "fade", buyDate: "2026-06-02", sellDate: "2026-06-03", netPnl: -77.77, importBatchId: 3 }),
    t({ broker: "zerodha", segment: "eq_delivery", setupTag: "breakout", buyDate: "2026-05-11", sellDate: "2026-06-20", netPnl: 0 }),
    t({ broker: "groww", segment: "eq_intraday", isOpen: true, sellDate: null, buyDate: "2026-06-25", netPnl: 0, staged: true }),
    t({ broker: "dhan", segment: "eq_mtf", setupTag: "fade", buyDate: "2026-05-14", sellDate: "2026-05-30", netPnl: -412.4, importBatchId: 8 }),
    t({ broker: "zerodha", segment: "future", playbookId: 1, buyDate: "2026-06-01", sellDate: "2026-06-06", netPnl: 908.1, importBatchId: 8 }),
    t({ broker: "groww", segment: "eq_delivery", buyDate: null, sellDate: null, isOpen: true, netPnl: 0 }),
    t({ broker: "dhan", segment: "eq_delivery", setupTag: "breakout", buyDate: "2026-05-19", sellDate: "2026-05-21", netPnl: 55.55, symbol: "INFY", tradingsymbol: "INFY" }),
  ];
  // Newest-first is how the page reads it, and it is NOT id order.
  const book = [...built].reverse();
  const byId = new Map(book.map((x) => [x.id, x]));
  const c = ctx({
    batches: [
      { id: 3, fileName: "kite.csv", broker: "zerodha", importedAt: "2026-05-10T00:00:00Z" },
      { id: 8, fileName: "dhan.xlsx", broker: "dhan", importedAt: "2026-06-02T00:00:00Z" },
    ],
    playbooks: [{ id: 1, name: "Gap fade" }],
  });

  for (const lens of LENSES) {
    it(`${lens.kind}: the delete preview is the same whether resolved over the group or the book`, () => {
      const groups = lensGroups(lens.kind, book, c);
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) {
        const members = groupIds(g, book).map((id) => byId.get(id)!);
        // Every figure the confirmation shows: ids AND their order, count,
        // open/closed/staged, net P&L, symbols, first and last date.
        expect(resolveDeleteScope(members, g.scope), `${g.key} previews differently`)
          .toEqual(resolveDeleteScope(book, g.scope));
      }
    });

    it(`${lens.kind}: members arrive in book order, not id order`, () => {
      // The drill-down table, the top-5 winners/losers and every sum read this
      // array; a different order is a different screen.
      const pos = new Map(book.map((x, i) => [x.id, i]));
      for (const g of lensGroups(lens.kind, book, c)) {
        const idx = groupIds(g, book).map((id) => pos.get(id)!);
        expect([...idx].sort((a, b) => a - b), `${g.key} is not in book order`).toEqual(idx);
      }
    });
  }
});

describe("month", () => {
  it("files a closed trade by its EXIT date and an open one by its ENTRY date", () => {
    // The trap: `sellDate ?? buyDate` hands an open position an exit date it
    // has from a partial sale, filing a live holding under the wrong month.
    const closed = t({ buyDate: "2026-06-28", sellDate: "2026-07-02" });
    const open = t({ buyDate: "2026-06-28", sellDate: "2026-07-02", isOpen: true });
    expect(effectiveDateOf(closed)).toBe("2026-07-02");
    expect(effectiveDateOf(open)).toBe("2026-06-28");

    const g = monthGroups([closed, open]);
    expect(g.map((x) => x.label)).toEqual(["July 2026", "June 2026"]);
  });

  it("keeps a trade with no usable date instead of dropping it", () => {
    const g = monthGroups([t({ buyDate: null, sellDate: null, isOpen: true })]);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe("No date");
  });

  it("labels months without depending on the machine locale", () => {
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(monthLabel("2026-12")).toBe("December 2026");
    expect(monthLabel("garbage")).toBe("garbage");
  });

  it("carries the group's own ids, not a date range", () => {
    // A dateRange over August would also catch a trade bought in August and
    // sold in September, which this view files under September.
    const spans = t({ buyDate: "2026-08-20", sellDate: "2026-09-04" });
    const inAug = t({ buyDate: "2026-08-01", sellDate: "2026-08-10" });
    const aug = monthGroups([spans, inAug]).find((g) => g.label === "August 2026")!;
    expect(aug.count).toBe(1);
    expect(resolveDeleteScope([spans, inAug], aug.scope).ids).toEqual([inAug.id]);
  });
});

describe("import file", () => {
  const batches = [{ id: 1, fileName: "kite-2026.csv", broker: "zerodha", importedAt: "2026-07-01T00:00:00Z" }];

  it("groups by the file and labels it by name", () => {
    const g = importFileGroups([t({ importBatchId: 1 }), t({ importBatchId: 1 })], batches);
    expect(g[0].label).toBe("kite-2026.csv");
    expect(g[0].count).toBe(2);
  });

  it("keeps trades whose import record was deleted, and says so", () => {
    // "Delete import, keep the trades" removes the batch row and leaves
    // trades.import_batch_id pointing at nothing. Those trades are real.
    const g = importFileGroups([t({ importBatchId: 404 })], batches);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe("Import record removed");
    expect(g[0].sub).toContain("404");
  });

  it("separates hand-entered trades from every import", () => {
    const g = importFileGroups([t({ importBatchId: 1 }), t({ importBatchId: null })], batches);
    expect(g.map((x) => x.label)).toEqual(["kite-2026.csv", "Entered by hand"]);
  });

  it("puts hand-entered last even when it is the biggest group", () => {
    const g = importFileGroups([t({ importBatchId: null }), t({ importBatchId: null }), t({ importBatchId: 1 })], batches);
    expect(g[g.length - 1].label).toBe("Entered by hand");
  });
});

describe("setup", () => {
  it("prefers the playbook over the free-text tag, so a trade is counted once", () => {
    const trade = t({ playbookId: 1, setupTag: "breakout" });
    const g = setupGroups([trade], [{ id: 1, name: "Gap fade" }]);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe("Gap fade");
    expect(g[0].sub).toBe("playbook");
  });

  it("names a deleted playbook rather than calling its trades untagged", () => {
    const g = setupGroups([t({ playbookId: 77 })], []);
    expect(g[0].label).toBe("Playbook #77");
    expect(g[0].sub).toContain("no longer on record");
  });

  it("falls back to the setup tag, trimming it", () => {
    const g = setupGroups([t({ setupTag: "  pullback " })], []);
    expect(g[0].label).toBe("pullback");
    expect(g[0].sub).toBe("setup tag");
  });

  it("treats a whitespace-only tag as no setup at all", () => {
    const g = setupGroups([t({ setupTag: "   " })], []);
    expect(g[0].label).toBe("No setup recorded");
  });

  it("sorts untagged last however many there are", () => {
    const g = setupGroups(
      [t({}), t({}), t({}), t({ setupTag: "abc" })],
      [],
    );
    expect(g[g.length - 1].label).toBe("No setup recorded");
  });
});

describe("outcome", () => {
  it("never counts an open position as a winner or a loser", () => {
    const g = outcomeGroups([
      t({ netPnl: 500 }),
      t({ netPnl: -200 }),
      t({ netPnl: 0 }),
      t({ netPnl: 900, isOpen: true }), // a big unrealised mark is not a win
    ]);
    expect(g.map((x) => `${x.label}:${x.count}`)).toEqual([
      "Winners:1", "Losers:1", "Breakeven:1", "Still open:1",
    ]);
  });

  it("omits groups that are empty rather than showing a row of zeroes", () => {
    const g = outcomeGroups([t({ netPnl: 100 })]);
    expect(g.map((x) => x.label)).toEqual(["Winners"]);
  });
});

describe("lens kinds", () => {
  it("recognises only the six real lenses", () => {
    expect(isLensKind("month")).toBe(true);
    expect(isLensKind("outcome")).toBe(true);
    expect(isLensKind("sector")).toBe(false);
    expect(isLensKind(null)).toBe(false);
  });

  it("has no duplicate kinds", () => {
    expect(new Set(LENSES.map((l) => l.kind)).size).toBe(LENSES.length);
  });
});

describe("groupIds index (B1 load fix)", () => {
  // groupIds indexes the candidate array once (WeakMap on the array's
  // identity) instead of re-filtering the book per group. Two things must
  // still hold: ids come back in candidate order, exactly as the filter did;
  // and an array grown IN PLACE is re-indexed rather than answered stale.
  it("returns predicate-scope ids in candidate order and re-indexes a mutated array", () => {
    const book = [t({ broker: "zerodha" }), t({ broker: "dhan" }), t({ broker: "zerodha" })];
    const groups = lensGroups("broker", book, { batches: [], playbooks: [] });
    const z = groups.find((g) => g.key === "broker:zerodha")!;
    expect(groupIds(z, book)).toEqual([book[0].id, book[2].id]);

    book.push(t({ broker: "zerodha" }));
    expect(groupIds(z, book)).toEqual([book[0].id, book[2].id, book[3].id]);

    // A group whose predicate matches nothing in a different book is empty, not undefined.
    expect(groupIds(z, [t({ broker: "groww" })])).toEqual([]);
  });
});
