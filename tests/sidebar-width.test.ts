import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTENT_MIN_W,
  DEFAULT_SIDEBAR_WIDTH,
  SIDEBAR_DEFAULT_W,
  SIDEBAR_MAX_W,
  SIDEBAR_MIN_W,
  SIDEBAR_STEP,
  SIDEBAR_STEP_LARGE,
  SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
  parseSidebarWidth,
  resolveSidebarWidth,
  serialiseSidebarWidth,
  sidebarMaxFor,
  sidebarWidthForKey,
} from "@/components/layout/use-sidebar-width";

/**
 * The resizable sidebar width (v4.4.0) — the PURE half, plus the source
 * contracts a unit test can reach. The browser half (a trusted-input drag, the
 * width surviving a reload, the re-clamp on a small window, no horizontal
 * scrollbar at the minimum) is `e2e/z-sidebar-width.spec.ts`.
 *
 * Each block names the failure signature it guards (W1–W10 in
 * LIVE-DESK-RESEARCH/19-BACKLOG-RESEARCH-2026-09-16/sidebar-resizable-width.md §7).
 */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
/** Comments out, so a pin cannot be satisfied (or tripped) by prose. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const SIDEBAR = "components/layout/sidebar.tsx";
const HOOK = "components/layout/use-sidebar-width.ts";
const LAYOUT = "app/layout.tsx";
const DESK = "components/live/tracker-client.tsx";

describe("the stored envelope (W10)", () => {
  it("is a vyuha- kebab key holding {v:1, px}, and round-trips", () => {
    expect(SIDEBAR_WIDTH_KEY).toBe("vyuha-sidebar-width");
    const s = { v: 1 as const, px: 300 };
    expect(JSON.parse(serialiseSidebarWidth(s))).toEqual({ v: 1, px: 300 });
    expect(parseSidebarWidth(serialiseSidebarWidth(s))).toEqual(s);
    expect(JSON.parse(serialiseSidebarWidth(DEFAULT_SIDEBAR_WIDTH))).toEqual({ v: 1, px: null });
  });

  it("the serialiser never writes a bare number", () => {
    const out = serialiseSidebarWidth({ v: 1, px: 260 });
    expect(Number.isNaN(Number(out)), `stored ${out}`).toBe(true);
    expect(out.startsWith("{")).toBe(true);
  });

  it("defaults on absent, unreadable, non-object, bare-number and UNKNOWN-VERSION values", () => {
    for (const raw of [null, undefined, "", "{oops", "[]", "null", "300", '"300"']) {
      expect(parseSidebarWidth(raw), String(raw)).toEqual(DEFAULT_SIDEBAR_WIDTH);
    }
    // Another build wrote it; guessing what its author meant is worse than
    // opening at the default.
    expect(parseSidebarWidth(JSON.stringify({ v: 2, px: 300 }))).toEqual(DEFAULT_SIDEBAR_WIDTH);
    expect(parseSidebarWidth(JSON.stringify({ px: 300 }))).toEqual(DEFAULT_SIDEBAR_WIDTH);
  });

  it("inside a v1 envelope a corrupt px falls back to null on its own", () => {
    expect(parseSidebarWidth(JSON.stringify({ v: 1, px: "wide" }))).toEqual({ v: 1, px: null });
    expect(parseSidebarWidth(JSON.stringify({ v: 1 }))).toEqual({ v: 1, px: null });
    expect(parseSidebarWidth('{"v":1,"px":1e999}')).toEqual({ v: 1, px: null });
  });

  it("the default is today's literal and the range is the ruled one", () => {
    expect(SIDEBAR_DEFAULT_W).toBe(232);
    expect([SIDEBAR_MIN_W, SIDEBAR_MAX_W, CONTENT_MIN_W]).toEqual([180, 420, 640]);
    expect([SIDEBAR_STEP, SIDEBAR_STEP_LARGE]).toEqual([16, 64]);
  });
});

describe("the clamp (W2 — clamped on EVERY read, not only on drag)", () => {
  it("keeps an in-range width, whole pixels", () => {
    expect(clampSidebarWidth(300, 1440)).toBe(300);
    expect(clampSidebarWidth(300.4, 1440)).toBe(300);
    expect(clampSidebarWidth(300, null)).toBe(300);
  });

  it("pins to MIN and MAX", () => {
    expect(clampSidebarWidth(40, 1440)).toBe(SIDEBAR_MIN_W);
    expect(clampSidebarWidth(9000, 1920)).toBe(SIDEBAR_MAX_W);
    expect(clampSidebarWidth(9000, null)).toBe(SIDEBAR_MAX_W);
  });

  it("keeps CONTENT_MIN_W for main: a 1024 px window (the desktop floor) caps the sidebar at 384", () => {
    expect(sidebarMaxFor(1024)).toBe(1024 - CONTENT_MIN_W);
    expect(clampSidebarWidth(420, 1024)).toBe(384);
  });

  it("MIN wins LAST: a window narrower than MIN + CONTENT_MIN pins the sidebar at MIN, never below", () => {
    expect(sidebarMaxFor(700)).toBe(SIDEBAR_MIN_W);
    expect(clampSidebarWidth(300, 700)).toBe(SIDEBAR_MIN_W);
    expect(clampSidebarWidth(300, 0)).toBe(SIDEBAR_MIN_W);
  });

  it("a non-finite width is the default, never NaN in a style attribute", () => {
    expect(clampSidebarWidth(Number.NaN, 1440)).toBe(SIDEBAR_DEFAULT_W);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY, null)).toBe(SIDEBAR_DEFAULT_W);
  });

  it("resolve: never resized → 232; before hydration (null viewport) → 232", () => {
    expect(resolveSidebarWidth(DEFAULT_SIDEBAR_WIDTH, null)).toBe(232);
    expect(resolveSidebarWidth(DEFAULT_SIDEBAR_WIDTH, 1280)).toBe(232);
    expect(resolveSidebarWidth(DEFAULT_SIDEBAR_WIDTH, 1024)).toBe(232);
  });

  it("resolve RE-CLAMPS a stored width to the window it is read in", () => {
    // Stored at 420 on a wide monitor, reopened in the 1024 px desktop floor:
    // main must keep 640 px, so the sidebar reads 384 — without anyone dragging.
    expect(resolveSidebarWidth({ v: 1, px: 420 }, 1920)).toBe(420);
    expect(resolveSidebarWidth({ v: 1, px: 420 }, 1024)).toBe(384);
    // A hand-edited or future-build 900 is still recovered.
    expect(resolveSidebarWidth({ v: 1, px: 900 }, 1024)).toBe(384);
    expect(resolveSidebarWidth({ v: 1, px: 100 }, 1440)).toBe(SIDEBAR_MIN_W);
  });
});

describe("the keyboard path (the recorded sidebar a11y debt is not grown)", () => {
  it("Arrow = ±16, Shift+Arrow = ±64, clamped", () => {
    expect(sidebarWidthForKey("ArrowRight", false, 232, 1440)).toBe(248);
    expect(sidebarWidthForKey("ArrowLeft", false, 232, 1440)).toBe(216);
    expect(sidebarWidthForKey("ArrowRight", true, 232, 1440)).toBe(296);
    // 232 − 64 = 168 is below MIN — the step is clamped, not refused.
    expect(sidebarWidthForKey("ArrowLeft", true, 232, 1440)).toBe(SIDEBAR_MIN_W);
    expect(sidebarWidthForKey("ArrowRight", true, 400, 1440)).toBe(SIDEBAR_MAX_W);
    expect(sidebarWidthForKey("ArrowLeft", false, 185, 1440)).toBe(SIDEBAR_MIN_W);
  });

  it("Home = MIN, End = MAX for THIS window, Enter/Space = reset", () => {
    expect(sidebarWidthForKey("Home", false, 300, 1440)).toBe(SIDEBAR_MIN_W);
    expect(sidebarWidthForKey("End", false, 300, 1440)).toBe(SIDEBAR_MAX_W);
    expect(sidebarWidthForKey("End", false, 300, 1024)).toBe(384);
    expect(sidebarWidthForKey("Enter", false, 300, 1440)).toBe("reset");
    expect(sidebarWidthForKey(" ", false, 300, 1440)).toBe("reset");
  });

  it("leaves every other key alone — j/k and Escape still belong to the page", () => {
    for (const k of ["j", "k", "Escape", "Tab", "ArrowUp", "ArrowDown"]) {
      expect(sidebarWidthForKey(k, false, 300, 1440), k).toBeNull();
    }
  });

  it("a key the separator handles stops there — Enter must not also expand a Live Desk row", () => {
    // The desk listens for Enter on `window`; without this, resetting the width
    // from the keyboard on /live also toggled the focused position open.
    expect(code(HOOK)).toMatch(/if \(next === null\) return;\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);/);
  });
});

describe("source contracts", () => {
  const sidebar = code(SIDEBAR);
  const hook = code(HOOK);

  it("W5: the handle lives INSIDE the one <aside> — the e2e hydration gate matches `aside`", () => {
    expect(sidebar.match(/<aside\b/g) ?? [], "sidebar.tsx renders exactly one <aside>").toHaveLength(1);
    expect(code(LAYOUT).match(/<aside\b/g) ?? [], "the root layout renders none of its own").toHaveLength(0);
    const handle = sidebar.indexOf('role="separator"');
    expect(handle, "no separator in the sidebar").toBeGreaterThan(-1);
    expect(handle, "the separator must sit before </aside>").toBeLessThan(sidebar.indexOf("</aside>"));
    expect(handle).toBeGreaterThan(sidebar.indexOf("<aside"));
  });

  it("the separator is focusable, labelled, keyboard- and double-click-resettable", () => {
    expect(sidebar).toMatch(/aria-orientation="vertical"/);
    expect(sidebar).toMatch(/tabIndex=\{0\}/);
    expect(sidebar).toMatch(/aria-valuenow=\{sidebarWidth\.width\}/);
    expect(sidebar).toMatch(/onKeyDown=\{sidebarWidth\.onKeyDown\}/);
    expect(sidebar).toMatch(/onDoubleClick=\{sidebarWidth\.reset\}/);
  });

  it("W1: the width transition is OFF while dragging", () => {
    expect(sidebar).toMatch(/sidebarWidth\.dragging && "transition-none"/);
  });

  it("collapse stays independent: the rail is w-14, the width applies only when expanded", () => {
    expect(sidebar).toMatch(/collapsed && "w-14"/);
    expect(sidebar).toMatch(/style=\{collapsed \? undefined : \{ width: sidebarWidth\.width \}\}/);
    expect(sidebar, "the old fixed literal must not fight the inline width").not.toContain("w-[232px]");
    expect(sidebar, "the collapse key is untouched").toContain('const COLLAPSE_KEY = "vyuha-sidebar-collapsed"');
  });

  it("the footer Reset clears the width too, and shows while either key is stored", () => {
    expect(sidebar).toMatch(/\(rawNavOrder !== null \|\| sidebarWidth\.stored\) &&/);
    expect(sidebar).toMatch(/const resetOrder = \(\) => \{\s*writeStored\(NAV_ORDER_KEY, null\);\s*sidebarWidth\.reset\(\);/);
  });

  it("W3: nav labels and the brand lockup truncate instead of overflowing at 180 px", () => {
    expect(sidebar).toMatch(/"flex min-w-0 flex-1 items-center gap-2\.5/);
    expect(sidebar).toMatch(/<span className="min-w-0 truncate">\{item\.label\}<\/span>/);
    expect(sidebar).toMatch(/className="truncate font-display/);
    expect(sidebar).toMatch(/className="truncate text-\[8\.5px\]/);
    // "Jump to… / Ctrl K" wrapped to two lines at 180 px (e2e, 2026-09-18).
    expect(sidebar).toMatch(/<span className="min-w-0 truncate">Jump to…<\/span>/);
    expect(sidebar).toMatch(/\{sidebarWidth\.width >= KBD_HINT_MIN_W && \(\s*<kbd className="ml-auto shrink-0/);
  });

  it("the version footer bump-version rewrites is still there", () => {
    expect(read(SIDEBAR)).toContain("Vyuha Desktop · v");
  });

  it("W7/W8: window listeners, no pointer capture, registered once per drag", () => {
    expect(hook).not.toMatch(/setPointerCapture/);
    expect(hook).toMatch(/window\.addEventListener\("pointermove"/);
    expect(hook, "the live gesture is read through a ref").toContain("gestureRef.current");
    expect(hook, "the effect keys on whether a drag runs, not on its position").toMatch(/\}, \[dragging, clamp, onCommit\]\);/);
    expect(hook).not.toMatch(/\}, \[gesture, clamp, onCommit\]\);/);
  });

  it("W9/W10: storage is the one copy — the house hook, the serialiser as the only writer", () => {
    expect(hook).toContain("useStoredValue(SIDEBAR_WIDTH_KEY)");
    expect(hook).toMatch(/writeStored\(SIDEBAR_WIDTH_KEY, px === null \? null : serialiseSidebarWidth\(/);
    for (const f of [SIDEBAR, HOOK]) {
      expect(read(f), `${f}: set-state-in-effect is never silenced`).not.toMatch(/eslint-disable[^\n]*set-state-in-effect/);
    }
    expect(read(HOOK), "never localStorage directly").not.toMatch(/localStorage\.(get|set|remove)Item/);
    expect(sidebar, "the width is not written from the sidebar by hand").not.toMatch(/SIDEBAR_WIDTH_KEY/);
  });
});

describe("W4: the Live Desk re-measures its scroll geometry on resize", () => {
  const desk = code(DESK);

  it("both the <thead> height and the box chrome are observed, not read once on mount", () => {
    expect(desk).toMatch(/new ResizeObserver\(/);
    expect(desk).toMatch(/ro\.disconnect\(\)/);
    expect(desk, "theadHeight is measured through the observer").toMatch(
      /return observeSize\(el, \(\) => setTheadHeight\(el\.offsetHeight \|\| THEAD_HEIGHT_FALLBACK\)\)/,
    );
    expect(desk, "boxChromeY is measured through the observer").toMatch(
      /observeSize\(el, \(\) => setBoxChromeY\(Math\.max\(0, el\.offsetHeight - el\.clientHeight\)\)\)/,
    );
    expect(desk, "no set-state-in-effect suppression was used to get there").not.toMatch(
      /eslint-disable[^\n]*set-state-in-effect/,
    );
  });
});
