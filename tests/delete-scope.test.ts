import { describe, expect, it } from "vitest";
import {
  resolveDeleteScope, manualBatches, brokerGroups, segmentGroups, manualDayOf,
  type DeletableTrade, type DeleteScope,
} from "@/lib/domain/delete-scope";

/**
 * Deleting is the one destructive thing Vyuha does to a user's own record, so
 * the properties worth pinning are the refusals: never sweep up a trade the
 * scope did not name, never guess on a missing date, and never resolve to
 * something the confirmation dialog did not show.
 */

let seq = 1;
const t = (over: Partial<DeletableTrade> = {}): DeletableTrade => ({
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
  ...over,
});

describe("scope: explicit ids (row selection)", () => {
  it("takes exactly the ids given and nothing else", () => {
    const a = t({ id: 1 }), b = t({ id: 2 }), c = t({ id: 3 });
    const r = resolveDeleteScope([a, b, c], { kind: "ids", ids: [1, 3] });
    expect(r.ids).toEqual([1, 3]);
    expect(r.count).toBe(2);
  });

  it("ignores ids that are not in the candidate list", () => {
    // Candidates are account-scoped by the caller; an id from another account
    // must not become deletable by being named.
    const r = resolveDeleteScope([t({ id: 1 })], { kind: "ids", ids: [1, 999] });
    expect(r.ids).toEqual([1]);
  });
});

describe("scope: import batch", () => {
  it("takes only trades from that batch", () => {
    const rows = [t({ id: 1, importBatchId: 7 }), t({ id: 2, importBatchId: 8 }), t({ id: 3, importBatchId: null })];
    const r = resolveDeleteScope(rows, { kind: "importBatch", batchId: 7 });
    expect(r.ids).toEqual([1]);
  });

  it("never matches manually-entered trades", () => {
    const r = resolveDeleteScope([t({ importBatchId: null })], { kind: "importBatch", batchId: 7 });
    expect(r.empty).toBe(true);
  });
});

describe("scope: manual day", () => {
  it("takes hand-entered trades from that day only", () => {
    const rows = [
      t({ id: 1, importBatchId: null, createdAt: "2026-07-01T09:00:00.000Z" }),
      t({ id: 2, importBatchId: null, createdAt: "2026-07-02T09:00:00.000Z" }),
    ];
    const r = resolveDeleteScope(rows, { kind: "manualDay", date: "2026-07-01" });
    expect(r.ids).toEqual([1]);
  });

  it("does NOT sweep up an imported trade recorded the same day", () => {
    // The distinction that makes this scope safe: "manual" means not-imported,
    // not merely "created on this date".
    const rows = [
      t({ id: 1, importBatchId: null, createdAt: "2026-07-01T09:00:00.000Z" }),
      t({ id: 2, importBatchId: 5, createdAt: "2026-07-01T09:30:00.000Z" }),
    ];
    const r = resolveDeleteScope(rows, { kind: "manualDay", date: "2026-07-01" });
    expect(r.ids).toEqual([1]);
  });
});

describe("scope: date range", () => {
  const rows = [
    t({ id: 1, buyDate: "2026-07-01", sellDate: "2026-07-02" }),
    t({ id: 2, buyDate: "2026-08-01", sellDate: "2026-08-02" }),
    t({ id: 3, buyDate: "2026-07-28", sellDate: "2026-08-05" }), // straddles
  ];

  it("matches on the entry leg when asked for entry", () => {
    const r = resolveDeleteScope(rows, { kind: "dateRange", from: "2026-07-01", to: "2026-07-31", basis: "entry" });
    expect(r.ids).toEqual([1, 3]);
  });

  it("matches on the exit leg when asked for exit", () => {
    const r = resolveDeleteScope(rows, { kind: "dateRange", from: "2026-08-01", to: "2026-08-31", basis: "exit" });
    expect(r.ids).toEqual([2, 3]);
  });

  it("either matches a trade touching the window on either leg", () => {
    const r = resolveDeleteScope(rows, { kind: "dateRange", from: "2026-07-01", to: "2026-07-31", basis: "either" });
    expect(r.ids).toEqual([1, 3]);
  });

  it("is inclusive of both endpoints", () => {
    const r = resolveDeleteScope([t({ id: 9, buyDate: "2026-07-31", sellDate: null })],
      { kind: "dateRange", from: "2026-07-01", to: "2026-07-31", basis: "entry" });
    expect(r.count).toBe(1);
  });

  it("leaves a trade alone when it has no date on the chosen basis", () => {
    // An undated trade cannot be PROVEN in range, and deleting on a guess is
    // not recoverable.
    const undated = t({ id: 4, buyDate: null, sellDate: null });
    const r = resolveDeleteScope([undated], { kind: "dateRange", from: "2000-01-01", to: "2099-01-01", basis: "either" });
    expect(r.empty).toBe(true);
  });
});

describe("scope: broker / segment / account", () => {
  it("filters by broker", () => {
    const rows = [t({ id: 1, broker: "dhan" }), t({ id: 2, broker: "zerodha" })];
    expect(resolveDeleteScope(rows, { kind: "broker", broker: "zerodha" }).ids).toEqual([2]);
  });

  it("filters by segment", () => {
    const rows = [t({ id: 1, segment: "eq_delivery" }), t({ id: 2, segment: "index_option" })];
    expect(resolveDeleteScope(rows, { kind: "segment", segment: "index_option" }).ids).toEqual([2]);
  });

  it("filters by account", () => {
    const rows = [t({ id: 1, accountId: 1 }), t({ id: 2, accountId: 2 })];
    expect(resolveDeleteScope(rows, { kind: "account", accountId: 2 }).ids).toEqual([2]);
  });
});

describe("the preview a user confirms against", () => {
  it("counts open, closed and staged separately", () => {
    const rows = [
      t({ id: 1, isOpen: true }),
      t({ id: 2, isOpen: false }),
      t({ id: 3, isOpen: false, staged: true }),
    ];
    const r = resolveDeleteScope(rows, { kind: "ids", ids: [1, 2, 3] });
    expect(r.open).toBe(1);
    expect(r.closed).toBe(2);
    expect(r.staged).toBe(1);
  });

  it("sums net P&L and reports the date span", () => {
    const rows = [
      t({ id: 1, netPnl: 100.005, buyDate: "2026-07-01", sellDate: "2026-07-02" }),
      t({ id: 2, netPnl: -50, buyDate: "2026-06-01", sellDate: "2026-09-09" }),
    ];
    const r = resolveDeleteScope(rows, { kind: "ids", ids: [1, 2] });
    expect(r.netPnl).toBe(50.01);
    expect(r.earliest).toBe("2026-06-01");
    expect(r.latest).toBe("2026-09-09");
  });

  it("caps the symbol preview but still reports the true count", () => {
    const rows = Array.from({ length: 20 }, (_, i) => t({ id: i + 1, symbol: `SYM${i}` }));
    const r = resolveDeleteScope(rows, { kind: "ids", ids: rows.map((x) => x.id) });
    expect(r.symbols.length).toBeLessThanOrEqual(8);
    expect(r.symbolCount).toBe(20);
  });

  it("always warns that attachments and journal notes go too, and says where they can be recovered", () => {
    // The copy changed when deletes started writing a recovery snapshot
    // (lib/trash.ts). It must not still claim the delete is irreversible —
    // a warning the user learns is false is worse than none.
    const r = resolveDeleteScope([t({ id: 1 })], { kind: "ids", ids: [1] });
    expect(r.warnings.join(" ")).toMatch(/attachments/i);
    expect(r.warnings.join(" ")).toMatch(/snapshot is saved first/i);
    expect(r.warnings.join(" ")).toMatch(/Deleted items/i);
    expect(r.warnings.join(" ")).not.toMatch(/cannot be undone/i);
  });

  it("warns specifically when open or staged positions are in scope", () => {
    const r = resolveDeleteScope([t({ id: 1, isOpen: true }), t({ id: 2, staged: true })], { kind: "ids", ids: [1, 2] });
    expect(r.warnings.join(" ")).toMatch(/open position/i);
    expect(r.warnings.join(" ")).toMatch(/tranche/i);
  });

  it("an empty scope is flagged and carries no warnings to click past", () => {
    const r = resolveDeleteScope([t({ id: 1 })], { kind: "ids", ids: [] });
    expect(r.empty).toBe(true);
    expect(r.count).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it("labels every scope in words a confirmation dialog can show", () => {
    const scopes: DeleteScope[] = [
      { kind: "ids", ids: [1] },
      { kind: "importBatch", batchId: 1 },
      { kind: "manualDay", date: "2026-07-01" },
      { kind: "dateRange", from: "2026-07-01", to: "2026-07-31", basis: "either" },
      { kind: "broker", broker: "dhan" },
      { kind: "segment", segment: "eq_delivery" },
      { kind: "account", accountId: 1 },
      { kind: "filter", ids: [1], label: "open · Dhan" },
    ];
    for (const s of scopes) {
      const r = resolveDeleteScope([t({ id: 1, importBatchId: 1, createdAt: "2026-07-01T00:00:00Z" })], s);
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.label).not.toMatch(/undefined|NaN/);
    }
  });
});

describe("groupings offered in the UI", () => {
  it("groups manual entries by day, newest first, excluding imports", () => {
    const rows = [
      t({ id: 1, importBatchId: null, createdAt: "2026-07-01T09:00:00.000Z" }),
      t({ id: 2, importBatchId: null, createdAt: "2026-07-03T09:00:00.000Z" }),
      t({ id: 3, importBatchId: 5, createdAt: "2026-07-03T09:00:00.000Z" }),
    ];
    const g = manualBatches(rows);
    expect(g.map((x) => x.key)).toEqual(["manual:2026-07-03", "manual:2026-07-01"]);
    expect(g[0].count).toBe(1); // the imported one is excluded
  });

  it("ranks broker and segment groups by size", () => {
    const rows = [
      t({ broker: "dhan", segment: "eq_delivery" }),
      t({ broker: "dhan", segment: "eq_delivery" }),
      t({ broker: "zerodha", segment: "index_option" }),
    ];
    expect(brokerGroups(rows)[0].label).toBe("dhan");
    expect(brokerGroups(rows)[0].count).toBe(2);
    expect(segmentGroups(rows)[0].label).toBe("eq_delivery");
  });

  it("every group's scope resolves back to exactly its own count", () => {
    // The invariant that keeps the preview honest: what the group claims and
    // what the resolver returns must be the same number.
    const rows = [
      t({ id: 1, broker: "dhan", importBatchId: null, createdAt: "2026-07-01T00:00:00Z" }),
      t({ id: 2, broker: "zerodha", importBatchId: null, createdAt: "2026-07-01T00:00:00Z" }),
      t({ id: 3, broker: "dhan", importBatchId: 9, createdAt: "2026-07-02T00:00:00Z" }),
    ];
    for (const g of [...manualBatches(rows), ...brokerGroups(rows), ...segmentGroups(rows)]) {
      expect(resolveDeleteScope(rows, g.scope).count).toBe(g.count);
    }
  });
});

describe("manualDayOf", () => {
  it("takes the calendar day from the ISO timestamp", () => {
    expect(manualDayOf(t({ createdAt: "2026-07-04T23:59:59.999Z" }))).toBe("2026-07-04");
  });
});
