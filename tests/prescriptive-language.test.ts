import { describe, expect, it } from "vitest";
import { PRESCRIPTIVE_LANGUAGE } from "@/lib/intelligence/insight";

/**
 * Red-on-revert coverage for the shared banned-phrase regex (contract rule 1:
 * descriptive, never prescriptive). The contract test scans every rule's
 * OUTPUT with this regex; this file pins the regex ITSELF, so narrowing it
 * back — in particular re-opening the contraction hole, where "you'd need to"
 * and friends slipped past a literal `\byou should\b` — fails here first,
 * before any rule copy has a chance to exploit the gap.
 */

describe("PRESCRIPTIVE_LANGUAGE — the net itself", () => {
  it("catches the plain advice shapes it always caught", () => {
    const banned = [
      "you should stop trading after a loss",
      "you must respect the stop", // via \bmust\b
      "avoid revenge trades",
      "never trade the first candle",
      "we recommend a smaller size",
      "consider selling half here",
    ];
    for (const s of banned) expect(s, s).toMatch(PRESCRIPTIVE_LANGUAGE);
  });

  it("catches contraction phrasing (red-on-revert for the widened net)", () => {
    // Every one of these evaded the previous `\byou should\b`-only pattern.
    const banned = [
      "You'd need to cut size after a loss",
      "you've got to wait for the retest",
      "You'll want to review Tuesday entries",
      "you'll need to record your stops",
      "you'll have to size down on gap days",
      "you're supposed to let winners run",
      "you need to journal the exit reason",
      "you have to respect the plan",
      "you ought to skip expiry day",
    ];
    for (const s of banned) expect(s, s).toMatch(PRESCRIPTIVE_LANGUAGE);
  });

  it("leaves descriptive statements of record alone", () => {
    const legal = [
      "historically, your after-loss expectancy is negative",
      "your record shows the gap narrowing over the last quarter",
      "you have 12 losers with a stop recorded",
      "SL recorded on 12 of 40 losers",
      "trades you'd tagged as breakout lost more on average", // 'd + past participle, not 'd need to
      "days you've journalled show a smaller give-back",
      "you're up 3.2R on Mondays",
    ];
    for (const s of legal) expect(s, s).not.toMatch(PRESCRIPTIVE_LANGUAGE);
  });
});
