import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { markAfterMove, stepsToShow, windowLimit } from "@/lib/live/positions-view";
import { nextIndex } from "@/components/live/desk-keys";
import { WINDOW_STEP } from "@/components/ui/show-more";

/**
 * v4.8.0 FIX-B, finding U-2 — the /live Positions window must not shrink under the cursor.
 *
 * The window render shows is `windowLimit(asked, total, focusIdx, step)`: the user's own mark (`asked`, raised only
 * by Show more and `askFor`) widened to hold the focused row. A filter cleared under a focused row leaves it 900
 * places down, so the DERIVED window is 1,050 rows while the user's mark is still 150. Before the fix, `k` raised the
 * mark only when it stepped PAST the window's edge — so each `k` up from 900 re-derived a smaller window and the rows
 * below the cursor vanished a step at a time. Now the key handler makes the width on screen the user's own on every
 * move (`markAfterMove`), the same high-water mark Show more and `j` past the edge set.
 *
 * Pure: the handler's arithmetic replayed over the real helpers, plus one pin that the handler calls it.
 */

const TOTAL = 3460;
const STEP = WINDOW_STEP;

/** One j / k press as the Positions tab's key handler performs it (an existing focus, so `nextIndex` over the book). */
function press(s: { asked: number; focus: number }, down: boolean) {
  const shown = windowLimit(s.asked, TOTAL, s.focus, STEP);
  const next = nextIndex(s.focus, TOTAL, down ? 1 : -1);
  const asked = s.asked + stepsToShow(s.asked, markAfterMove(shown, next), STEP) * STEP;
  return { asked, focus: next };
}

describe("U-2 — the row window holds what is on screen when the focus moves", () => {
  it("markAfterMove: the width on screen, or the row the focus lands on, whichever is wider", () => {
    expect(markAfterMove(1050, 899)).toBe(1050);
    expect(markAfterMove(150, 150)).toBe(151); // j past the edge — as `askFor(next + 1)` asked before
    expect(markAfterMove(150, 10)).toBe(150);
  });

  it("a filter cleared under the focus at row 900: walking up with k never narrows the window", () => {
    let s = { asked: STEP, focus: 900 };
    const wide = windowLimit(s.asked, TOTAL, s.focus, STEP);
    expect(wide).toBe(1050); // derived, before any key
    for (let i = 0; i < 900; i++) {
      s = press(s, false);
      expect(windowLimit(s.asked, TOTAL, s.focus, STEP), `after k #${i + 1} (focus ${s.focus})`).toBe(wide);
    }
    expect(s.focus).toBe(0);
  });

  it("a book the window already holds is untouched — no Show-more step for a move inside it", () => {
    let s = { asked: STEP, focus: 10 };
    for (const down of [true, false, false, true]) {
      s = press(s, down);
      expect(s.asked).toBe(STEP);
    }
  });

  it("j past the edge still widens by one whole step and keeps it", () => {
    let s = { asked: STEP, focus: STEP - 1 };
    s = press(s, true);
    expect(s.asked).toBe(2 * STEP);
    s = press(s, false);
    expect(windowLimit(s.asked, TOTAL, s.focus, STEP)).toBe(2 * STEP);
  });

  it("the key handler raises the mark on EVERY move, not only past the window's edge — in the handler, never an effect", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "components/live/positions-tab.tsx"), "utf8");
    const at = src.indexOf('if (action === "row-down" || action === "row-up")');
    expect(at).toBeGreaterThan(0);
    const branch = src.slice(at, src.indexOf('if (action === "expand")', at));
    const ask = branch.indexOf("askFor(markAfterMove(shown.length, next));");
    expect(ask, "the handler calls askFor(markAfterMove(shown.length, next))").toBeGreaterThan(0);
    // …before the inside / past-the-edge split, so a move INSIDE a derived-wide window raises it too.
    expect(ask).toBeLessThan(branch.indexOf("if (next < shown.length)"));
    expect(branch).not.toMatch(/askFor\(next \+ 1\)/);
  });
});
