import { describe, expect, it } from "vitest";
import {
  SCREEN_DOMAIN,
  WORKSPACES,
  asWorkspace,
  defaultBucket,
  screenVisible,
  type Workspace,
} from "@/lib/domain/workspace";
import { NAV_ITEMS, moveWithinVisible } from "@/components/layout/nav-config";

describe("screenVisible", () => {
  it("'both' shows every screen the app has", () => {
    for (const item of NAV_ITEMS) expect(screenVisible(item.href, "both")).toBe(true);
  });

  it("hides the other book, keeps its own", () => {
    expect(screenVisible("/strategies", "equity")).toBe(false);
    expect(screenVisible("/reports/expiry", "equity")).toBe(false);
    expect(screenVisible("/equity", "equity")).toBe(true);

    expect(screenVisible("/ipos", "fno")).toBe(false);
    expect(screenVisible("/reports/harvest", "fno")).toBe(false);
    expect(screenVisible("/active", "fno")).toBe(true);
  });

  it("an unlisted screen is SHARED — the safe default for anything new", () => {
    expect(screenVisible("/some-screen-added-next-year", "equity")).toBe(true);
    expect(screenVisible("/some-screen-added-next-year", "fno")).toBe(true);
  });

  it("Settings is reachable in every mode — it is the only way back out", () => {
    for (const ws of WORKSPACES) expect(screenVisible("/settings", ws)).toBe(true);
  });

  it("no mode can empty the journal: Trades and Import always show", () => {
    for (const ws of WORKSPACES) {
      expect(screenVisible("/trades", ws)).toBe(true);
      expect(screenVisible("/import", ws)).toBe(true);
      expect(screenVisible("/", ws)).toBe(true);
    }
  });

  it("every domain-tagged screen actually exists in the nav", () => {
    // A typo here would silently hide nothing at all.
    const hrefs = new Set(NAV_ITEMS.map((i) => i.href));
    for (const href of Object.keys(SCREEN_DOMAIN)) expect(hrefs.has(href)).toBe(true);
  });

  it("every group keeps at least one screen in every mode", () => {
    // A group that empties would leave a heading with nothing under it.
    const groups = [...new Set(NAV_ITEMS.map((i) => i.group))];
    for (const ws of WORKSPACES) {
      for (const g of groups) {
        const left = NAV_ITEMS.filter((i) => i.group === g && screenVisible(i.href, ws));
        expect(left.length, `${g} in ${ws}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("defaultBucket", () => {
  it("maps the user-facing mode onto the schema's bucket name", () => {
    // "fno" is the word the user picked; "active" is the word the DB stores.
    expect(defaultBucket("fno")).toBe("active");
    expect(defaultBucket("equity")).toBe("equity");
  });

  it("'both' seeds no filter at all", () => {
    expect(defaultBucket("both")).toBe("");
  });
});

describe("asWorkspace", () => {
  it("passes through the three real modes", () => {
    for (const ws of WORKSPACES) expect(asWorkspace(ws)).toBe(ws);
  });

  it("falls back to 'both' for anything else — a bad column never hides screens", () => {
    for (const bad of [null, undefined, "", "equities", 3, {}, "BOTH"]) {
      expect(asWorkspace(bad)).toBe("both");
    }
  });
});

describe("moveWithinVisible — reordering a list that is partly hidden", () => {
  // b and d are hidden by the current mode; the user only ever sees a, c, e.
  const full = ["a", "b", "c", "d", "e"];
  const visible = ["a", "c", "e"];

  it("keeps hidden entries in the saved order", () => {
    const out = moveWithinVisible(full, visible, 0, 1);
    expect([...out].sort()).toEqual([...full].sort());
  });

  it("lands the entry next to the visible neighbour it was dropped against", () => {
    // Drag "a" so it sits after "c": the visible order becomes c, a, e, and
    // "a" must therefore end up immediately before "e" in the full list.
    const out = moveWithinVisible(full, visible, 0, 1);
    expect(out.filter((x) => visible.includes(x))).toEqual(["c", "a", "e"]);
    expect(out.indexOf("a")).toBe(out.indexOf("e") - 1);
  });

  it("dropping past the last visible row appends to the whole list", () => {
    const out = moveWithinVisible(full, visible, 0, 2);
    expect(out.filter((x) => visible.includes(x))).toEqual(["c", "e", "a"]);
    expect(out[out.length - 1]).toBe("a");
  });

  it("with nothing hidden it behaves exactly like a plain reorder", () => {
    expect(moveWithinVisible(full, full, 0, 2)).toEqual(["b", "c", "a", "d", "e"]);
    expect(moveWithinVisible(full, full, 4, 0)).toEqual(["e", "a", "b", "c", "d"]);
  });

  it("never mutates its inputs and survives an out-of-range index", () => {
    const f = [...full];
    const v = [...visible];
    expect(moveWithinVisible(f, v, 9, 0)).toBe(f);
    expect(f).toEqual(full);
    expect(v).toEqual(visible);
  });
});

describe("the workspace type is closed", () => {
  it("exactly three modes ship", () => {
    const all: Workspace[] = [...WORKSPACES];
    expect(all).toEqual(["both", "equity", "fno"]);
  });
});
