import { describe, expect, it } from "vitest";
import {
  NAV_DEFAULT_VISIBLE,
  NAV_GROUPS,
  NAV_ITEMS,
  foldDrag,
  mergeOrder,
  mergeShown,
  moveIndex,
  parseNavOrder,
  partitionByShown,
} from "@/components/layout/nav-config";
import { dropTarget } from "@/components/layout/use-list-drag";
import { groupFoldState } from "@/components/layout/sidebar";

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

describe("NAV_DEFAULT_VISIBLE — the fold defaults must track NAV_ITEMS (drift guard)", () => {
  it("every group has a default visible set, and nothing else does", () => {
    expect(Object.keys(NAV_DEFAULT_VISIBLE).sort()).toEqual([...NAV_GROUPS].sort());
  });

  it("every default-visible href exists in NAV_ITEMS and lives in that group", () => {
    for (const [group, hrefs] of Object.entries(NAV_DEFAULT_VISIBLE)) {
      for (const href of hrefs) {
        const item = NAV_ITEMS.find((i) => i.href === href);
        expect(item, `${group}: ${href} is not a NAV_ITEMS href`).toBeTruthy();
        expect(item!.group, `${group}: ${href} actually lives in "${item!.group}"`).toBe(group);
      }
    }
  });

  it("no group folds to nothing by default", () => {
    for (const group of NAV_GROUPS) expect(NAV_DEFAULT_VISIBLE[group].length).toBeGreaterThan(0);
  });

  it("every NAV_ITEMS group is a NAV_GROUPS entry", () => {
    const groups = new Set<string>(NAV_GROUPS);
    for (const item of NAV_ITEMS) expect(groups.has(item.group), `${item.href} → "${item.group}"`).toBe(true);
  });
});

describe("mergeShown — a saved visible set must survive app updates", () => {
  const current = ["a", "b", "c", "d"];
  const defaults = ["a", "b"];

  it("no saved set → the defaults", () => {
    expect(mergeShown(null, defaults, current)).toEqual(defaults);
    expect(mergeShown(undefined, defaults, current)).toEqual(defaults);
  });

  it("a saved set wins, filtered to keys that still exist", () => {
    expect(mergeShown(["d", "x", "a"], defaults, current)).toEqual(["d", "a"]);
  });

  it("a deliberately EMPTY saved set is respected — the user folded everything", () => {
    expect(mergeShown([], defaults, current)).toEqual([]);
  });

  it("a saved set whose every member was removed by an update falls back to defaults", () => {
    expect(mergeShown(["x", "y"], defaults, current)).toEqual(defaults);
  });

  it("defaults are filtered to current keys too", () => {
    expect(mergeShown(null, ["a", "gone"], current)).toEqual(["a"]);
  });
});

describe("partitionByShown — the rendered order puts fold-visible rows first", () => {
  it("both sides keep their relative order", () => {
    expect(partitionByShown(["a", "b", "c", "d", "e"], new Set(["b", "d"]))).toEqual(["b", "d", "a", "c", "e"]);
  });

  it("is the identity when the shown rows already lead", () => {
    expect(partitionByShown(["a", "b", "c"], new Set(["a", "b"]))).toEqual(["a", "b", "c"]);
  });
});

describe("foldDrag — dragging across the fold promotes/demotes; hidden rows never move", () => {
  it("reorder under DOUBLE filtering (workspace + fold) preserves every hidden row's position", () => {
    const full = ["a", "b", "c", "d", "e", "f"];
    const shown = ["a", "b", "e"];
    const wsHidden = new Set(["c"]); // workspace filter on top of the fold filter
    // Collapsed rows render from the partitioned order, filtered twice:
    const rendered = partitionByShown(full, new Set(shown)).filter(
      (h) => shown.includes(h) && !wsHidden.has(h),
    );
    expect(rendered).toEqual(["a", "b", "e"]);
    const { order, shown: nextShown } = foldDrag(full, rendered, shown, 0, 2); // a → end of visible rows
    // Dropping at the end anchors to no follower, so `a` appends to the FULL
    // order — but c, d and f (fold-hidden or workspace-hidden) keep their
    // relative positions, and the fold set keeps all three visible rows.
    expect(order).toEqual(["b", "e", "c", "d", "f", "a"]);
    expect(nextShown).toEqual(["b", "e", "a"]);
    // What renders next time — the partitioned view — shows the new order.
    expect(partitionByShown(order, new Set(nextShown))).toEqual(["b", "e", "a", "c", "d", "f"]);
  });

  it("a drag inside a FOLDED group is pure reordering — membership cannot change", () => {
    const full = ["a", "b", "c", "d"];
    const shown = ["a", "b"];
    const rendered = ["a", "b"]; // folded: only visible rows render
    const { order, shown: nextShown } = foldDrag(full, rendered, shown, 0, 1);
    // Dropping at the visible end appends to the FULL order (no follower to
    // anchor to) — but the fold set still holds both rows, so the group
    // renders [b, a] and neither was demoted.
    expect(order).toEqual(["b", "c", "d", "a"]);
    expect(nextShown).toEqual(["b", "a"]);
    expect(partitionByShown(order, new Set(nextShown))).toEqual(["b", "a", "c", "d"]);
  });

  it("dragging a folded row above the fold line promotes it", () => {
    const full = ["a", "b", "c", "d"];
    const shown = ["a", "b"];
    const rendered = partitionByShown(full, new Set(shown)); // expanded view
    const { order, shown: nextShown } = foldDrag(full, rendered, shown, 2, 0); // c → top
    expect(nextShown).toEqual(["c", "a", "b"]);
    expect(order[0]).toBe("c");
  });

  it("dragging a visible row below the fold line demotes it", () => {
    const full = ["a", "b", "c", "d"];
    const shown = ["a", "b"];
    const rendered = partitionByShown(full, new Set(shown));
    const { order, shown: nextShown } = foldDrag(full, rendered, shown, 0, 3); // a → bottom
    expect(order).toEqual(["b", "c", "d", "a"]);
    expect(nextShown).toEqual(["b"]);
  });

  it("a folded row dropped EXACTLY on the fold boundary stays folded", () => {
    const full = ["a", "b", "c", "d"];
    const shown = ["a", "b"];
    const rendered = partitionByShown(full, new Set(shown));
    const { shown: nextShown } = foldDrag(full, rendered, shown, 3, 2); // d → first folded slot
    expect(nextShown).toEqual(["a", "b"]);
  });

  it("an out-of-range source is a no-op", () => {
    const full = ["a", "b"];
    const { order, shown } = foldDrag(full, ["a", "b"], ["a"], 9, 0);
    expect(order).toBe(full);
    expect(shown).toEqual(["a"]);
  });
});

describe("groupFoldState — a fold toggle must never render where clicking it does nothing", () => {
  const base = { total: 5, primary: 2, stored: false, forced: false, collapsed: false };

  it("folded by default: 'N more…' shows, 'Show less' does not", () => {
    expect(groupFoldState(base)).toEqual({ expanded: false, showMore: true, showLess: false });
  });

  it("user-expanded: 'Show less' shows, 'N more…' does not", () => {
    expect(groupFoldState({ ...base, stored: true })).toEqual({ expanded: true, showMore: false, showLess: true });
  });

  it("route-FORCED expanded shows NEITHER toggle — even with the stored flag set", () => {
    // The bug: `stored && forced` rendered "Show less", but clicking it only
    // cleared the stored flag while `forced` kept the group open — a control
    // that visibly did nothing.
    expect(groupFoldState({ ...base, forced: true })).toEqual({ expanded: true, showMore: false, showLess: false });
    expect(groupFoldState({ ...base, stored: true, forced: true })).toEqual({ expanded: true, showMore: false, showLess: false });
  });

  it("a fold-visible set entirely workspace-hidden renders the group EXPANDED, with neither toggle", () => {
    // The bug: primary=0 rendered a bare group header plus an "N more…"
    // button and zero rows — the group must open instead.
    expect(groupFoldState({ ...base, primary: 0 })).toEqual({ expanded: true, showMore: false, showLess: false });
    // …and a stale stored flag on such a group must not resurrect "Show less"
    // (clicking it could not fold anything: emptyFold pins the group open).
    expect(groupFoldState({ ...base, primary: 0, stored: true })).toEqual({ expanded: true, showMore: false, showLess: false });
  });

  it("nothing folded away: expanded, no toggles", () => {
    expect(groupFoldState({ ...base, primary: 5 })).toEqual({ expanded: true, showMore: false, showLess: false });
  });

  it("the icon rail ignores folding entirely", () => {
    expect(groupFoldState({ ...base, collapsed: true })).toEqual({ expanded: true, showMore: false, showLess: false });
  });

  it("a group emptied by the workspace filter offers no toggle (it does not render at all)", () => {
    expect(groupFoldState({ ...base, total: 0, primary: 0 })).toEqual({ expanded: true, showMore: false, showLess: false });
  });
});

describe("parseNavOrder — the versioned envelope, and the legacy value it must not discard", () => {
  it("null / empty / corrupt JSON → null (defaults render)", () => {
    expect(parseNavOrder(null)).toBeNull();
    expect(parseNavOrder("")).toBeNull();
    expect(parseNavOrder("{not json")).toBeNull();
    expect(parseNavOrder("42")).toBeNull();
    expect(parseNavOrder('["a"]')).toBeNull();
  });

  it("MIGRATES the legacy un-versioned {groups, items} instead of discarding it", () => {
    const legacy = JSON.stringify({ groups: ["Risk", "Overview"], items: { Positions: ["/equity", "/risk"] } });
    expect(parseNavOrder(legacy)).toEqual({
      v: 1,
      groups: ["Risk", "Overview"],
      items: { Positions: ["/equity", "/risk"] },
      shown: {},
      expanded: {},
    });
  });

  it("round-trips a v1 envelope", () => {
    const env = {
      v: 1,
      groups: ["Overview"],
      items: { Positions: ["/risk"] },
      shown: { Positions: ["/risk", "/equity"] },
      expanded: { Analytics: true },
    };
    expect(parseNavOrder(JSON.stringify(env))).toEqual(env);
  });

  it("a FUTURE version is discarded rather than mis-read", () => {
    expect(parseNavOrder(JSON.stringify({ v: 2, groups: [], items: {}, layout: "??" }))).toBeNull();
  });

  it("scrubs wrongly-typed fields instead of crashing", () => {
    const out = parseNavOrder(
      JSON.stringify({ v: 1, groups: ["a", 7], items: { G: ["/x", 3], H: "nope" }, shown: 5, expanded: { G: "yes", H: true } }),
    );
    expect(out).toEqual({ v: 1, groups: ["a"], items: { G: ["/x"] }, shown: {}, expanded: { H: true } });
  });

  it("an object with neither groups nor items is not a nav order", () => {
    expect(parseNavOrder(JSON.stringify({ foo: 1 }))).toBeNull();
  });
});
