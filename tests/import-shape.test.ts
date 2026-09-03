import { describe, expect, it } from "vitest";
import {
  importShapeSentence,
  importShapeCompact,
  openingSellNote,
  type ImportShape,
} from "@/lib/domain/import-shape";

/**
 * The sentence that cost a live demo (2026-08-30).
 *
 * Every case here is a shape a REAL file produced, so the copy is pinned
 * against the numbers it actually has to explain, not invented examples.
 */

const shape = (s: Partial<ImportShape>): ImportShape => ({
  sourceRows: null,
  positions: 0,
  open: 0,
  openingSells: 0,
  ...s,
});

describe("importShapeSentence", () => {
  it("never states the position count without the execution count that produced it", () => {
    // The owner's Paytm demo file, 2026-08-30.
    const s = importShapeSentence(shape({ sourceRows: 7544, positions: 804, open: 82, openingSells: 72 }));
    expect(s).toBe("7,544 executions → 804 positions (82 open, 72 opening sells without buy history)");
    // The failure mode: the smaller number standing alone.
    expect(s.startsWith("804")).toBe(false);
  });

  it("describes the Zerodha demo file", () => {
    expect(importShapeSentence(shape({ sourceRows: 3530, positions: 79, open: 4, openingSells: 11 })))
      .toBe("3,530 executions → 79 positions (4 open, 11 opening sells without buy history). 11 sales without a purchase — review before trusting Net P&L.");
  });

  it("describes the private fixtures the diagnosis was built on", () => {
    expect(importShapeSentence(shape({ sourceRows: 414, positions: 142, open: 3, openingSells: 24 })))
      .toBe("414 executions → 142 positions (3 open, 24 opening sells without buy history). 24 sales without a purchase — review before trusting Net P&L.");
    expect(importShapeSentence(shape({ sourceRows: 1554, positions: 28, open: 2, openingSells: 11 })))
      .toBe("1,554 executions → 28 positions (2 open, 11 opening sells without buy history). 11 sales without a purchase — review before trusting Net P&L.");
  });

  it("drops the arrow when one source row is one position", () => {
    // A P&L statement states positions directly — there is no pairing to explain.
    expect(importShapeSentence(shape({ sourceRows: null, positions: 124 }))).toBe("124 positions");
    expect(importShapeSentence(shape({ sourceRows: 124, positions: 124 }))).toBe("124 positions");
  });

  it("drops the parenthetical rather than printing zeroes that invite a question", () => {
    expect(importShapeSentence(shape({ sourceRows: 92, positions: 73 }))).toBe("92 executions → 73 positions");
  });

  it("states only the sub-count that exists", () => {
    expect(importShapeSentence(shape({ sourceRows: 92, positions: 73, open: 5 })))
      .toBe("92 executions → 73 positions (5 open)");
    expect(importShapeSentence(shape({ sourceRows: 92, positions: 73, openingSells: 5 })))
      .toBe("92 executions → 73 positions (5 opening sells without buy history)");
  });

  it("agrees with itself in the singular", () => {
    expect(importShapeSentence(shape({ sourceRows: 3, positions: 1, open: 1 })))
      .toBe("3 executions → 1 position (1 open)");
    expect(importShapeSentence(shape({ sourceRows: 2, positions: 1, openingSells: 1 })))
      .toBe("2 executions → 1 position (1 opening sell without buy history). 1 sale without a purchase — review before trusting Net P&L.");
  });

  it("groups Indian-style, because every other number on the screen does", () => {
    expect(importShapeSentence(shape({ sourceRows: 150000, positions: 12500 })))
      .toBe("1,50,000 executions → 12,500 positions");
  });
});

describe("openingSellNote", () => {
  it("says why the P&L cell is blank, and how to fill it", () => {
    const note = openingSellNote(24)!;
    expect(note).toContain("24 of these are sells");
    expect(note).toContain('"—"');
    expect(note).toMatch(/set the buy price/i);
  });

  it("is silent when there is nothing to explain", () => {
    expect(openingSellNote(0)).toBeNull();
    expect(openingSellNote(-1)).toBeNull();
  });

  it("agrees with itself in the singular", () => {
    expect(openingSellNote(1)).toContain("1 of these is a sell");
  });

  it("makes no forbidden claim", () => {
    // The banned-claims rule the buyer-facing copy audit enforces: a journal
    // never speaks of "returns" (see docs/DOC_AUDIT.md).
    const BANNED = /\breturns?\b(?! to)/i;
    for (const n of [1, 24, 72]) expect(openingSellNote(n)!).not.toMatch(BANNED);
    for (const s of [
      importShapeSentence(shape({ sourceRows: 7544, positions: 804, open: 82, openingSells: 72 })),
      importShapeSentence(shape({ positions: 1 })),
    ]) {
      expect(s).not.toMatch(BANNED);
    }
  });
});

describe("importShapeCompact", () => {
  it("fits a table cell without losing the first number", () => {
    expect(importShapeCompact(shape({ sourceRows: 7544, positions: 804 }))).toBe("7,544 → 804");
    expect(importShapeCompact(shape({ sourceRows: null, positions: 124 }))).toBe("124");
    expect(importShapeCompact(shape({ sourceRows: 124, positions: 124 }))).toBe("124");
  });
});

// ── 2026-09-04: two cautions the sentence carries ───────────────────────────
import {
  OPENING_SELL_REVIEW_SHARE,
  openingSellReviewNote,
  relabelledFromWarnings,
  relabelledNote,
} from "@/lib/domain/import-shape";

describe("opening-sell review caution", () => {
  it("names its threshold", () => {
    expect(OPENING_SELL_REVIEW_SHARE).toBe(0.1);
  });

  it("appears once opening sells reach the threshold share of positions", () => {
    expect(openingSellReviewNote(80, 800)).toBe("80 sales without a purchase — review before trusting Net P&L");
    expect(openingSellReviewNote(1, 1)).toBe("1 sale without a purchase — review before trusting Net P&L");
  });

  it("is silent below it — the real SME-IPO book (38 of 793) is not flagged", () => {
    expect(openingSellReviewNote(38, 793)).toBeNull();
    expect(openingSellReviewNote(79, 800)).toBeNull();
    expect(openingSellReviewNote(0, 10)).toBeNull();
    expect(openingSellReviewNote(3, 0)).toBeNull();
  });

  it("rides on the headline sentence, after the arithmetic", () => {
    expect(importShapeSentence(shape({ sourceRows: 414, positions: 142, open: 3, openingSells: 24 })))
      .toBe("414 executions → 142 positions (3 open, 24 opening sells without buy history). 24 sales without a purchase — review before trusting Net P&L.");
    expect(importShapeSentence(shape({ sourceRows: 7544, positions: 793, open: 62, openingSells: 38 })))
      .toBe("7,544 executions → 793 positions (62 open, 38 opening sells without buy history)");
  });
});

describe("relabelled securities", () => {
  it("is minted and read back by the same module — the count survives the trip through warnings", () => {
    expect(relabelledNote(35)).toBe("35 securities appeared under two labels — paired by ISIN");
    expect(relabelledNote(1)).toBe("1 security appeared under two labels — paired by ISIN");
    expect(relabelledNote(0)).toBeNull();
    expect(relabelledFromWarnings(["Charges are the broker's own.", relabelledNote(35)!])).toBe(35);
    expect(relabelledFromWarnings(["Charges are the broker's own."])).toBe(0);
    expect(relabelledFromWarnings([relabelledNote(1200)!])).toBe(1200);
  });

  it("joins the sentence, alongside the review caution when both apply", () => {
    expect(importShapeSentence({ ...shape({ sourceRows: 7544, positions: 793, open: 62, openingSells: 38 }), relabelled: 35 }))
      .toBe("7,544 executions → 793 positions (62 open, 38 opening sells without buy history). 35 securities appeared under two labels — paired by ISIN.");
    expect(importShapeSentence({ ...shape({ sourceRows: 414, positions: 142, open: 3, openingSells: 24 }), relabelled: 2 }))
      .toBe("414 executions → 142 positions (3 open, 24 opening sells without buy history). 24 sales without a purchase — review before trusting Net P&L. 2 securities appeared under two labels — paired by ISIN.");
  });

  it("changes nothing when absent", () => {
    expect(importShapeSentence({ ...shape({ sourceRows: 3530, positions: 79 }), relabelled: 0 }))
      .toBe("3,530 executions → 79 positions");
  });
});
