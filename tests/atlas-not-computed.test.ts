import { describe, expect, it } from "vitest";
import { NOT_COMPUTED, NOT_COMPUTED_GATES, notComputedBy } from "@/lib/atlas/not-computed";

/**
 * The honesty list (v4.6.0 W5, owner rulings AQ10 / AQ11): what Atlas does NOT
 * compute, in Vyuha's OWN words. The scan is the test: no vendor name, no
 * widget title, no dashboard id, none of the banned vocabulary (AQ47 / AQ9).
 */

const TEXT = JSON.stringify(NOT_COMPUTED);

describe("the registry names families and gates, never another product", () => {
  it("carries no vendor name, dashboard id or widget title", () => {
    for (const re of [
      /chartink/i,
      /dashboard\s*#?\s*\d+/i,
      /dashboard/i,
      /sentinel/i,
      /trendlyne|screener\.in|tradingview|tijori|moneycontrol|stockedge|investing\.com/i,
      /widget/i,
    ]) {
      expect(TEXT, `registry matches ${re}`).not.toMatch(re);
    }
  });

  it("uses none of the banned words (AQ9 'turnover share', AQ47 no rating)", () => {
    for (const re of [/\bmoney\b/i, /\bflow(s|ing)?\b/i, /risk-on|risk-off/i, /\breduce\b/i, /\bbuy\b/i, /\bsell\b/i, /\bscore\b/i, /\brating\b/i]) {
      expect(TEXT, `registry matches ${re}`).not.toMatch(re);
    }
  });

  it("every family sits under one of the three gates with a status and a note", () => {
    expect(NOT_COMPUTED.length).toBeGreaterThanOrEqual(6);
    for (const f of NOT_COMPUTED) {
      expect(NOT_COMPUTED_GATES).toContain(f.why);
      expect(["later", "never"]).toContain(f.status);
      expect(f.family.length).toBeGreaterThan(5);
      expect(f.note.length).toBeGreaterThan(20);
    }
    expect(NOT_COMPUTED_GATES).toEqual(["needs an intraday feed", "needs fundamentals", "not computed here"]);
  });

  it("owner rulings: intraday and institutional/promoter are LATER; open interest and delivery are NEVER", () => {
    const intraday = notComputedBy("needs an intraday feed");
    expect(intraday.length).toBeGreaterThanOrEqual(1);
    expect(intraday.every((f) => f.status === "later")).toBe(true);
    const fundamentals = notComputedBy("needs fundamentals");
    expect(fundamentals.some((f) => /institutional/i.test(f.family))).toBe(true);
    expect(fundamentals.some((f) => /promoter/i.test(f.family))).toBe(true);
    expect(fundamentals.every((f) => f.status === "later")).toBe(true);
    const never = notComputedBy("not computed here");
    expect(never.some((f) => /open interest/i.test(f.family))).toBe(true);
    expect(never.some((f) => /delivery/i.test(f.family))).toBe(true);
    expect(never.every((f) => f.status === "never")).toBe(true);
  });
});
