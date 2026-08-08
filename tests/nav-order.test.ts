import { describe, expect, it } from "vitest";
import { mergeOrder, moveIndex } from "@/components/layout/nav-config";
import { dropTarget } from "@/components/layout/use-list-drag";

describe("mergeOrder — a saved nav order must survive app updates", () => {
  const current = ["a", "b", "c", "d"];

  it("no saved order → default order", () => {
    expect(mergeOrder(null, current)).toEqual(current);
    expect(mergeOrder([], current)).toEqual(current);
  });

  it("saved order wins for keys it knows", () => {
    expect(mergeOrder(["d", "a", "c", "b"], current)).toEqual(["d", "a", "c", "b"]);
  });

  it("a screen ADDED by an update slots in at its default position, not the end", () => {
    // User saved when only a,b,d existed; c arrived later between b and d.
    expect(mergeOrder(["d", "b", "a"], current)).toEqual(["d", "b", "c", "a"]);
  });

  it("a screen REMOVED by an update drops out silently", () => {
    expect(mergeOrder(["x", "b", "a"], ["a", "b"])).toEqual(["b", "a"]);
  });

  it("brand-new install after saving nothing relevant → still every current key", () => {
    const out = mergeOrder(["z", "y"], current);
    expect([...out].sort()).toEqual([...current].sort());
  });
});

describe("moveIndex — the drag primitive", () => {
  it("moves an entry to an arbitrary position, both directions", () => {
    expect(moveIndex(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveIndex(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("dragging DOWN lands where the pointer is — the classic off-by-one", () => {
    // Remove-then-insert: after removing index 0, "c" sits at index 1, so
    // inserting at 1 puts "a" between b and c, which is what the drop
    // indicator showed. A swap-based move would have produced a different list.
    expect(moveIndex(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });

  it("is a no-op for same position or an out-of-range source", () => {
    const l = ["a", "b", "c"];
    expect(moveIndex(l, 1, 1)).toBe(l);
    expect(moveIndex(l, -1, 0)).toBe(l);
    expect(moveIndex(l, 9, 0)).toBe(l);
  });

  it("clamps a target past the ends instead of dropping the entry", () => {
    expect(moveIndex(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
    expect(moveIndex(["a", "b", "c"], 2, -5)).toEqual(["c", "a", "b"]);
  });

  it("never mutates the input", () => {
    const l = ["a", "b", "c"];
    moveIndex(l, 0, 2);
    expect(l).toEqual(["a", "b", "c"]);
  });
});

describe("dropTarget — the item must land where the insertion line promised", () => {
  // The line is drawn between rows of the list as displayed; moveIndex splices
  // after removing the dragged row. These are different coordinate systems and
  // the drag felt subtly wrong until they were reconciled.
  const list = ["a", "b", "c", "d"];
  const drop = (from: number, line: number) => moveIndex(list, from, dropTarget(from, line));

  it("dragging DOWN lands above the row the line sat before", () => {
    // Line at 3 = "between c and d". Dragging a there must give b,c,a,d —
    // NOT b,c,d,a, which is what an unconverted index produces.
    expect(drop(0, 3)).toEqual(["b", "c", "a", "d"]);
    expect(drop(0, 2)).toEqual(["b", "a", "c", "d"]);
  });

  it("dragging UP needs no conversion — removal happens below the target", () => {
    expect(drop(3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(drop(2, 0)).toEqual(["c", "a", "b", "d"]);
  });

  it("dropping into the gap the row already occupies is a no-op, either side", () => {
    expect(drop(1, 1)).toEqual(list);
    expect(drop(1, 2)).toEqual(list);
  });

  it("a line past the last row sends the entry to the end", () => {
    expect(drop(0, 4)).toEqual(["b", "c", "d", "a"]);
  });
});
