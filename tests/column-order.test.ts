import { describe, expect, it } from "vitest";
import {
  applyColumnOrder,
  columnKey,
  movableKeys,
  parseStoredOrder,
  type ColumnLike,
} from "@/lib/domain/column-order";
import { moveIndex } from "@/components/layout/nav-config";
import { budgetMinWidth } from "@/components/ui/data-table";
import type { ColumnDef } from "@tanstack/react-table";

/** The Trades table's real shape: two pinned, then the movable region. */
const COLS: ColumnLike[] = [
  { id: "select" },
  { accessorKey: "symbol" },
  { accessorKey: "broker" },
  { accessorKey: "segment" },
  { accessorKey: "exchange" },
  { accessorKey: "buyValue" },
  { accessorKey: "netPnl" },
  { id: "actions" },
];
const PINNED = 2;
const keys = (c: ColumnLike[]) => c.map(columnKey);

describe("columnKey", () => {
  it("reads id or accessorKey", () => {
    expect(columnKey({ id: "select" })).toBe("select");
    expect(columnKey({ accessorKey: "netPnl" })).toBe("netPnl");
  });

  it("every real column produces a unique, non-empty key", () => {
    // A definition with neither id nor accessorKey collapses onto "" and two
    // such columns would fold into one on reload, losing a column silently.
    const ks = keys(COLS);
    expect(ks.every((k) => k.length > 0)).toBe(true);
    expect(new Set(ks).size).toBe(ks.length);
  });
});

describe("applyColumnOrder — the pinned prefix is unreachable", () => {
  it("keeps select and symbol at 0 and 1 for a normal saved order", () => {
    const out = applyColumnOrder(COLS, ["netPnl", "broker", "segment", "exchange", "buyValue", "actions"], PINNED);
    expect(keys(out).slice(0, 2)).toEqual(["select", "symbol"]);
    expect(keys(out)[2]).toBe("netPnl");
  });

  it("cannot be moved even by a saved order that NAMES them", () => {
    // The hostile case: a corrupt or hand-edited entry trying to move the
    // frozen columns. The head is sliced off before any reordering, so the
    // code never even looks at these names.
    for (const hostile of [
      ["symbol", "select", "broker"],
      ["actions", "select", "symbol", "netPnl"],
      ["select"],
    ]) {
      const out = applyColumnOrder(COLS, hostile, PINNED);
      expect(keys(out).slice(0, 2), hostile.join(",")).toEqual(["select", "symbol"]);
      expect(out).toHaveLength(COLS.length);
    }
  });

  it("a column added by a later release lands at its DEFAULT slot", () => {
    // Saved when "exchange" did not exist; it must reappear between segment
    // and buyValue, not at the end and not nowhere.
    const saved = ["broker", "segment", "buyValue", "netPnl", "actions"];
    const out = keys(applyColumnOrder(COLS, saved, PINNED));
    expect(out).toContain("exchange");
    expect(out.indexOf("exchange")).toBe(out.indexOf("segment") + 1);
    expect(out).toHaveLength(COLS.length);
  });

  it("a column removed by a later release drops out silently", () => {
    const saved = ["broker", "deletedColumn", "segment", "exchange", "buyValue", "netPnl", "actions"];
    const out = keys(applyColumnOrder(COLS, saved, PINNED));
    expect(out).not.toContain("deletedColumn");
    expect(out).toHaveLength(COLS.length);
  });

  it("null / empty / garbage give the default order", () => {
    for (const s of [null, undefined, []]) {
      expect(keys(applyColumnOrder(COLS, s, PINNED))).toEqual(keys(COLS));
    }
    expect(keys(applyColumnOrder(COLS, ["nope", "alsoNope"], PINNED)).sort()).toEqual(keys(COLS).sort());
  });

  it("never mutates its input", () => {
    const before = keys(COLS);
    applyColumnOrder(COLS, ["netPnl", "broker"], PINNED);
    expect(keys(COLS)).toEqual(before);
  });

  it("always returns every column exactly once", () => {
    for (const saved of [null, ["netPnl"], ["actions", "broker"], keys(COLS).reverse()]) {
      const out = keys(applyColumnOrder(COLS, saved, PINNED));
      expect(new Set(out).size).toBe(COLS.length);
    }
  });
});

describe("a drag round-trips through the persisted shape", () => {
  it("moving within the movable region lands where asked", () => {
    const movable = movableKeys(COLS, PINNED);
    expect(movable).toEqual(["broker", "segment", "exchange", "buyValue", "netPnl", "actions"]);
    // Drag netPnl (index 4) to the front of the movable region.
    const next = moveIndex(movable, 4, 0);
    const out = keys(applyColumnOrder(COLS, next, PINNED));
    expect(out).toEqual(["select", "symbol", "netPnl", "broker", "segment", "exchange", "buyValue", "actions"]);
  });
});

describe("parseStoredOrder", () => {
  it("accepts the versioned shape", () => {
    expect(parseStoredOrder(JSON.stringify({ v: 1, order: ["a", "b"] }))).toEqual(["a", "b"]);
  });

  it("rejects a future or missing version rather than mis-reading it", () => {
    expect(parseStoredOrder(JSON.stringify({ v: 2, order: ["a"] }))).toBeNull();
    expect(parseStoredOrder(JSON.stringify(["a", "b"]))).toBeNull();
  });

  it("survives corrupt storage", () => {
    for (const junk of [null, "", "{", "not json", JSON.stringify({ v: 1 })]) {
      expect(parseStoredOrder(junk)).toBeNull();
    }
  });
});

describe("the width budget does not depend on the order", () => {
  // If it did, dragging a column would change the table's min-width and the
  // layout would shift under the pointer mid-drag.
  const metas: ColumnDef<unknown, unknown>[] = [
    { id: "select", meta: { width: 36 } },
    { accessorKey: "symbol" }, // flexible — claims the allowance, and is pinned
    { accessorKey: "broker" },
    { accessorKey: "segment", meta: { width: 90 } },
    { accessorKey: "netPnl", meta: { align: "right" } },
    { id: "actions", meta: { width: 70 } },
  ] as ColumnDef<unknown, unknown>[];

  it("is identical for every permutation of the movable region", () => {
    const base = budgetMinWidth(metas);
    const tail = metas.slice(2);
    for (const perm of permutations(tail)) {
      expect(budgetMinWidth([...metas.slice(0, 2), ...perm])).toBe(base);
    }
  });

  it("holds for a permutation of the WHOLE list, pinned columns included", () => {
    // Not because the pinned pair protects it — the sum is invariant for any
    // arrangement. Recorded so the weaker claim is not read into it.
    const base = budgetMinWidth(metas);
    for (const perm of permutations(metas)) expect(budgetMinWidth(perm)).toBe(base);
  });

  it("is order-dependent the moment the flex rule becomes positional", () => {
    // The failure this guards against, demonstrated on a stand-in: award the
    // allowance by INDEX and the same columns budget differently per order.
    const positional = (cols: ColumnDef<unknown, unknown>[]) =>
      cols.reduce<number>((t, c, i) => t + ((c.meta as { width?: number })?.width ?? (i === 0 ? 200 : 120)), 0);
    const tail = metas.slice(2);
    // The swap has to move a WIDTH-DECLARED column into slot 0 — swapping two
    // undeclared ones just hands the same 200 to the other, and the totals
    // match by coincidence.
    expect(positional(tail)).not.toBe(positional([tail[1], tail[0], tail[2], tail[3]]));
  });

});

function* permutations<T>(xs: T[]): Generator<T[]> {
  if (xs.length <= 1) { yield xs; return; }
  for (let i = 0; i < xs.length; i++) {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) {
      yield [xs[i], ...rest];
    }
  }
}
