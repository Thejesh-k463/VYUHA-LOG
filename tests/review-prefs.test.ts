import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_PREFS,
  REVIEW_PREFS_KEY,
  parseReviewPrefs,
  reviewPrefsOrDefault,
  serialiseReviewPrefs,
} from "@/components/review/review-prefs";
import { previousWeekStart, weekOverWeek } from "@/components/review/week-gap";
import {
  carriedOverDraft,
  noteDraftText,
  noteOwner,
  type NoteDraft,
} from "@/components/review/note-draft";

/**
 * The Trade Review Desk's PURE helpers.
 *
 * Both exist so the desk's per-device chrome and its week-over-week line can be
 * exercised without a browser or a database — the parseNavOrder pattern. The
 * envelope tests are the important half: a stored value written by a DIFFERENT
 * build of the app has to be discarded rather than half-read, and the only way
 * to know that is to hand the parser the shapes it will actually meet.
 */

describe("the stored envelope", () => {
  it("uses the recorded key convention", () => {
    expect(REVIEW_PREFS_KEY).toBe("vyuha-review-prefs");
    expect(REVIEW_PREFS_KEY.startsWith("vyuha-")).toBe(true);
  });

  it("round-trips a full v1 envelope", () => {
    const prefs = { v: 1, scope: "week", sort: "worst", tag: "no_stop", hideReviewed: true } as const;
    expect(parseReviewPrefs(serialiseReviewPrefs(prefs))).toEqual(prefs);
  });

  it("always stamps v:1 on the way out, whatever it was handed", () => {
    // A caller cannot smuggle a different version past the serialiser.
    const written = serialiseReviewPrefs({ ...DEFAULT_REVIEW_PREFS, v: 2 as unknown as 1 });
    expect(JSON.parse(written).v).toBe(1);
    expect(parseReviewPrefs(written)).not.toBeNull();
  });

  it("discards garbage rather than mis-reading it", () => {
    for (const raw of [null, undefined, "", "not json", "{", "[]", '"a string"', "42", "null"]) {
      expect(parseReviewPrefs(raw), String(raw)).toBeNull();
    }
  });

  it("discards a LEGACY un-versioned object — nothing ever wrote one", () => {
    // parseNavOrder migrates its un-versioned shape because a shipped release
    // wrote it. No release has ever written review prefs, so an object with no
    // `v` came from somewhere else and is dropped.
    expect(parseReviewPrefs(JSON.stringify({ scope: "week", sort: "worst" }))).toBeNull();
    expect(parseReviewPrefs(JSON.stringify({ groups: [], items: {} }))).toBeNull();
  });

  it("discards a FUTURE version instead of reading fields out of it", () => {
    const future = JSON.stringify({ v: 2, scope: "week", sort: "worst", tag: "x", hideReviewed: true });
    expect(parseReviewPrefs(future)).toBeNull();
    // …and the caller therefore renders the defaults, not half of v2.
    expect(reviewPrefsOrDefault(future)).toEqual(DEFAULT_REVIEW_PREFS);
    expect(parseReviewPrefs(JSON.stringify({ v: "1", scope: "week" }))).toBeNull();
  });

  it("falls back FIELD by field inside a v1 envelope", () => {
    // A stale enum value is not a reason to throw away the rest of a choice the
    // user really made — the opposite call from a whole future envelope.
    const parsed = parseReviewPrefs(
      JSON.stringify({ v: 1, scope: "fortnight", sort: "worst", tag: 7, hideReviewed: "yes" }),
    );
    expect(parsed).toEqual({
      v: 1,
      scope: DEFAULT_REVIEW_PREFS.scope,
      sort: "worst",
      tag: DEFAULT_REVIEW_PREFS.tag,
      hideReviewed: DEFAULT_REVIEW_PREFS.hideReviewed,
    });
  });

  it("reviewPrefsOrDefault never returns null", () => {
    expect(reviewPrefsOrDefault("rubbish")).toEqual(DEFAULT_REVIEW_PREFS);
    expect(reviewPrefsOrDefault(null)).toEqual(DEFAULT_REVIEW_PREFS);
  });
});

describe("week-over-week — blank across a gap (the momNet rule)", () => {
  it("steps back exactly one ISO week, across a month and a year boundary", () => {
    expect(previousWeekStart("2026-09-07")).toBe("2026-08-31");
    expect(previousWeekStart("2026-01-05")).toBe("2025-12-29");
  });

  it("states a delta only against the IMMEDIATELY preceding week", () => {
    const scores = new Map<string, number | null>([
      ["2026-08-31", 60],
      ["2026-09-07", 74],
    ]);
    expect(weekOverWeek(scores, "2026-09-07", 74)).toEqual({
      kind: "delta",
      delta: 14,
      previousWeekStart: "2026-08-31",
      previousScore: 60,
    });
  });

  it("renders NOTHING across a gap rather than comparing non-adjacent weeks", () => {
    // The trader did not trade in the week of 2026-08-31. Comparing this week
    // against 2026-08-24 would invent a trend.
    const scores = new Map<string, number | null>([
      ["2026-08-24", 40],
      ["2026-09-07", 74],
    ]);
    expect(weekOverWeek(scores, "2026-09-07", 74)).toEqual({
      kind: "none",
      previousWeekStart: "2026-08-31",
      reason: "no-week",
    });
  });

  it("a preceding week that REFUSED to score is not a comparison either", () => {
    const scores = new Map<string, number | null>([
      ["2026-08-31", null],
      ["2026-09-07", 74],
    ]);
    expect(weekOverWeek(scores, "2026-09-07", 74)).toMatchObject({ kind: "none", reason: "no-score" });
  });

  it("no current score means no comparison, whatever last week did", () => {
    const scores = new Map<string, number | null>([["2026-08-31", 60]]);
    expect(weekOverWeek(scores, "2026-09-07", null)).toMatchObject({ kind: "none", reason: "no-current" });
  });

  it("a zero score is a score, not a gap", () => {
    // The one off-by-nullish trap: 0 is falsy and must still compare.
    const scores = new Map<string, number | null>([
      ["2026-08-31", 0],
      ["2026-09-07", 12],
    ]);
    expect(weekOverWeek(scores, "2026-09-07", 12)).toMatchObject({ kind: "delta", delta: 12 });
  });
});

describe("a weekly note belongs to ONE book and ONE week", () => {
  // The defect, probed 2026-09-02: the ritual panel seeded its textarea from
  // `useState(note)` and was mounted unkeyed, while the account switcher ends
  // in router.refresh() — a SOFT refresh that keeps the React instance alive.
  // Type against Zerodha, switch to Groww, and Zerodha's sentence sat beside
  // Groww's figures with "Save note" pointed at Groww.
  const ZERODHA = noteOwner(7, "2026-08-24");
  const GROWW = noteOwner(9, "2026-08-24");
  const typed: NoteDraft = {
    owner: ZERODHA,
    ownerLabel: "Zerodha · 2026-W35",
    text: "Overtraded Tuesday, cut size",
    unsaved: true,
  };

  it("shows the draft to the owner who typed it", () => {
    expect(noteDraftText(typed, ZERODHA, "")).toBe("Overtraded Tuesday, cut size");
  });

  it("does NOT show it to another account on the same week", () => {
    // The whole defect in one assertion.
    expect(noteDraftText(typed, GROWW, "Groww's note on file")).toBe("Groww's note on file");
  });

  it("does not show it to another WEEK on the same account either", () => {
    expect(noteDraftText(typed, noteOwner(7, "2026-08-17"), "last week's note")).toBe("last week's note");
  });

  it("falls back to the filed note when nothing has been typed", () => {
    expect(noteDraftText(null, ZERODHA, "what is on file")).toBe("what is on file");
    expect(noteDraftText(null, ZERODHA, "")).toBe("");
  });

  it("an owner is account AND week — neither alone identifies a note", () => {
    expect(noteOwner(7, "2026-08-24")).not.toBe(noteOwner(9, "2026-08-24"));
    expect(noteOwner(7, "2026-08-24")).not.toBe(noteOwner(7, "2026-08-17"));
    // The All-accounts view is a real owner too (0 is a view, invariant 9) —
    // it cannot write, but a draft typed there is still the user's.
    expect(noteOwner(0, "2026-08-24")).toBe("0:2026-08-24");
  });

  it("surfaces the stranded prose instead of eating it", () => {
    // The second half of the same bug: a `key` on the panel would fix the
    // wrong-book write by silently binning what the user typed.
    const carried = carriedOverDraft(typed, GROWW);
    expect(carried?.text).toBe("Overtraded Tuesday, cut size");
    expect(carried?.ownerLabel).toBe("Zerodha · 2026-W35");
  });

  it("says nothing when the draft is the owner's own", () => {
    expect(carriedOverDraft(typed, ZERODHA)).toBeNull();
    expect(carriedOverDraft(null, ZERODHA)).toBeNull();
  });

  it("says nothing about prose already on file, or about no prose at all", () => {
    expect(carriedOverDraft({ ...typed, unsaved: false }, GROWW)).toBeNull();
    expect(carriedOverDraft({ ...typed, text: "   " }, GROWW)).toBeNull();
  });

  it("switching back restores the words rather than losing them", () => {
    // Ownership is a lookup, not a lifecycle: the same draft answers again the
    // moment its own account and week are back on screen.
    expect(noteDraftText(typed, GROWW, "")).toBe("");
    expect(noteDraftText(typed, ZERODHA, "")).toBe("Overtraded Tuesday, cut size");
  });
});
