import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PANEL_STATE,
  PANEL_MARGIN,
  PANEL_SIZE,
  PANEL_STATE_KEY,
  clampPoint,
  dragDelta,
  parsePanelState,
  resolvePosition,
  serialisePanelState,
} from "@/components/system/use-panel-drag";

/**
 * The floating search panel (v3.9 Search v2) — the PURE half.
 *
 * The panel is a second surface over the SAME search engine: it reuses
 * use-search-session.ts and search-results.tsx, and adds exactly two things of
 * its own — a persisted position/open envelope, and the 2-D drag geometry that
 * moves it. Both are pure, so both are tested here without a browser; the
 * SOURCE half below pins the contracts a unit test cannot reach (one engine,
 * one literal fetch prefix, mounted once per account in the root layout).
 *
 * Off-screen recovery is the reason `clampPoint` exists at all: a panel parked
 * at x=1800 on a second monitor and reopened on a laptop would otherwise be
 * stored, restored, and invisible — with no way to drag it back.
 */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const PANEL = "components/system/search-panel.tsx";
const DRAG = "components/system/use-panel-drag.ts";
const LAYOUT = "app/layout.tsx";

describe("the stored envelope", () => {
  it("is a versioned vyuha- key, and round-trips", () => {
    expect(PANEL_STATE_KEY).toBe("vyuha-search-panel");
    const s = { v: 1 as const, x: 120, y: 240, open: true };
    expect(parsePanelState(serialisePanelState(s))).toEqual(s);
    expect(JSON.parse(serialisePanelState(s))).toEqual({ v: 1, x: 120, y: 240, open: true });
  });

  it("defaults on absent, unreadable, non-object and UNKNOWN-VERSION values", () => {
    expect(parsePanelState(null)).toEqual(DEFAULT_PANEL_STATE);
    expect(parsePanelState("")).toEqual(DEFAULT_PANEL_STATE);
    expect(parsePanelState("{oops")).toEqual(DEFAULT_PANEL_STATE);
    expect(parsePanelState("[]")).toEqual(DEFAULT_PANEL_STATE);
    expect(parsePanelState("null")).toEqual(DEFAULT_PANEL_STATE);
    // A build that is not this one wrote it; guessing what its author meant is
    // worse than opening where a first-run user opens.
    expect(parsePanelState(JSON.stringify({ v: 2, x: 10, y: 10, open: true }))).toEqual(DEFAULT_PANEL_STATE);
    expect(parsePanelState(JSON.stringify({ x: 10, y: 10, open: true }))).toEqual(DEFAULT_PANEL_STATE);
  });

  it("inside a v1 envelope an unreadable FIELD falls back on its own", () => {
    expect(parsePanelState(JSON.stringify({ v: 1, x: "left", y: 240, open: true }))).toEqual({ v: 1, x: null, y: 240, open: true });
    expect(parsePanelState(JSON.stringify({ v: 1, x: 5, y: Number.NaN, open: 1 }))).toEqual({ v: 1, x: 5, y: null, open: false });
    expect(parsePanelState(JSON.stringify({ v: 1 }))).toEqual(DEFAULT_PANEL_STATE);
  });

  it("starts closed and unpositioned — a first run opens nothing", () => {
    expect(DEFAULT_PANEL_STATE).toEqual({ v: 1, x: null, y: null, open: false });
  });
});

describe("drag geometry", () => {
  it("dragDelta is the start position plus the pointer's travel", () => {
    expect(dragDelta({ x: 100, y: 100 }, { x: 300, y: 300 }, { x: 420, y: 260 })).toEqual({ x: 220, y: 60 });
    expect(dragDelta({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 10 })).toEqual({ x: 0, y: 0 });
  });

  it("clampPoint keeps the whole panel inside the viewport, margin included", () => {
    const size = { w: 400, h: 500 };
    const vp = { w: 1000, h: 800 };
    expect(clampPoint({ x: 200, y: 100 }, size, vp)).toEqual({ x: 200, y: 100 });
    // Past the right/bottom edge → flush against it, one margin in.
    expect(clampPoint({ x: 5000, y: 5000 }, size, vp)).toEqual({ x: 1000 - 400 - PANEL_MARGIN, y: 800 - 500 - PANEL_MARGIN });
    // Negative → the top-left margin.
    expect(clampPoint({ x: -400, y: -9 }, size, vp)).toEqual({ x: PANEL_MARGIN, y: PANEL_MARGIN });
  });

  it("a viewport smaller than the panel pins it to the top-left rather than off-screen", () => {
    expect(clampPoint({ x: 40, y: 40 }, { w: 400, h: 500 }, { w: 320, h: 400 })).toEqual({ x: PANEL_MARGIN, y: PANEL_MARGIN });
  });

  it("resolvePosition parks an unpositioned panel bottom-right, and CLAMPS a stored one", () => {
    const vp = { w: 1440, h: 900 };
    expect(resolvePosition({ ...DEFAULT_PANEL_STATE }, PANEL_SIZE, vp)).toEqual({
      x: 1440 - PANEL_SIZE.w - PANEL_MARGIN,
      y: 900 - PANEL_SIZE.h - PANEL_MARGIN,
    });
    // Off-screen recovery: parked on a wide monitor, reopened on a laptop.
    expect(resolvePosition({ v: 1, x: 2400, y: 40, open: true }, PANEL_SIZE, vp)).toEqual({
      x: 1440 - PANEL_SIZE.w - PANEL_MARGIN,
      y: 40,
    });
  });
});

describe("panel contracts (source)", () => {
  const src = read(PANEL);

  it("is ONE engine, two surfaces — it reuses the session hook and the results list", () => {
    expect(src, "the panel must not grow a second session/back stack").toContain('from "./use-search-session"');
    expect(src, "the results list is shared with the palette, not re-implemented").toMatch(/import\("\.\/search-results"\)/);
    expect(src).toContain("useSearchSession(");
    expect(src).toContain("searchUrl(q, cats)");
  });

  it("fetches the LITERAL /api/search prefix, debounced and MIN_QUERY-guarded", () => {
    const calls = src.match(/\bfetch\(/g) ?? [];
    expect(calls, "fetch( call sites in the panel").toHaveLength(1);
    expect(read("components/system/use-search-session.ts")).toContain('return `/api/search?q=');
    expect(src).toMatch(/const searching = open && q\.length >= MIN_QUERY;/);
    expect(src).toContain("SEARCH_DEBOUNCE_MS");
    expect(src).toContain("ctrl.abort()");
  });

  it("persists through the house localStorage hook, never localStorage directly", () => {
    expect(src).toContain("useStoredValue(PANEL_STATE_KEY)");
    expect(src).toContain("writeStored(PANEL_STATE_KEY");
    for (const f of [PANEL, DRAG]) expect(read(f), `${f} must go through use-stored-value`).not.toMatch(/localStorage\.(get|set|remove)Item/);
  });

  it("has its own toggle chord, and never steals Ctrl+K from the palette", () => {
    expect(src, "Ctrl+Shift+K toggles the panel").toMatch(/e\.shiftKey[\s\S]{0,120}"k"/);
    expect(src, "Ctrl+K belongs to the modal palette").not.toMatch(/!e\.shiftKey/);
  });

  it("says nothing about dev Fast Refresh, and wraps no Badge in a <p>", () => {
    expect(src).not.toMatch(/Fast Refresh/i);
    expect(src).not.toMatch(/<p[^>]*>[\s\S]{0,200}<Badge/);
  });

  it("has NO PopoverTrigger — a second anchor leaves Radix holding a detached one", () => {
    // Radix registers an anchor from a ref callback that is null-guarded
    // (`if (node) onAnchorChange(node)`) and never fires again for an element
    // that stays mounted. `PopoverTrigger` renders itself INSIDE a
    // `PopperPrimitive.Anchor` until `hasCustomAnchor` flips true in an
    // effect — so on the first commit the trigger registers itself as the
    // anchor (its ref runs after ours), and when the flip re-parents it React
    // creates a NEW button node and DETACHES the old one. Radix keeps the
    // detached node: `getBoundingClientRect()` on it is all zeros, the popper
    // wrapper is pinned at `translate(0px, 0px)`, and the panel renders in the
    // top-left corner and NEVER follows the anchor the drag moves.
    // Observed: `--radix-popper-anchor-width: 0px` with the anchor div itself
    // measuring {x:772,y:72,width:1,height:1}. The launcher is a plain button.
    expect(src, "the positioned PopoverAnchor must be this popover's ONLY anchor").not.toMatch(/<PopoverTrigger/);
    expect(src, "and it is not even imported").toContain('import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";');
    expect(src, "the anchor is what positions the panel").toContain("<PopoverAnchor asChild>");
    expect(src, "the launcher toggles the stored envelope directly").toMatch(/aria-label="Search assistant \(Ctrl\+Shift\+K\)"/);
  });

  it("is mounted ONCE by the root layout, keyed per account (invariant 8)", () => {
    const layout = read(LAYOUT);
    expect(layout).toMatch(/<SearchPanel key=\{selectedAccountId\} accountId=\{selectedAccountId\}/);
    expect(layout, "the panel sits beside the palette, not inside a page").toContain("<CommandPalette key={selectedAccountId}");
  });
});
