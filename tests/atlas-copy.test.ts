import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * The Atlas COPY rulings (research answers Q49, Q52, Q58, Q59).
 *
 * Four sentences on this screen are not decoration — they are the difference
 * between a computation and a claim, and each was decided in 06-ANSWERS.md:
 * the provenance line (no Chartink data), the not-advice line, the cap-band
 * "current classification, not point-in-time" label, and the my-names dark
 * state that tells the user how to turn the tab on. A refactor that drops one
 * of them leaves a screen that reads like a recommendation, so the strings are
 * pinned here and the wiring is read out of the real component source.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let t: TempDb;
let q: typeof import("@/lib/queries/atlas");

beforeAll(async () => {
  t = await openTempDb("atlas-copy", { seed: true });
  q = await import("@/lib/queries/atlas");
});

afterAll(() => t?.cleanup());

describe("the two footer lines (Q58/Q59)", () => {
  it("names the source and rules Chartink out, verbatim", () => {
    expect(q.NO_CHARTINK_LINE).toBe(
      "Computed from your stored end-of-day bhavcopy. No Chartink data is used.",
    );
  });

  it("says the screen computes and does not advise, verbatim", () => {
    expect(q.NOT_ADVICE_LINE).toBe("Vyuha computes; it does not advise.");
  });

  it("hands both lines to the panel, which prints them", () => {
    const view = { provenanceLine: q.NO_CHARTINK_LINE, notAdviceLine: q.NOT_ADVICE_LINE };
    expect(view.provenanceLine).toBe(q.NO_CHARTINK_LINE);
    const panel = read("components/atlas/atlas-panel.tsx");
    expect(panel).toContain("view.provenanceLine");
    expect(panel).toContain("view.notAdviceLine");
  });
});

describe("cap bands say what the band means (Q49)", () => {
  it("labels the classification as current, not point-in-time", () => {
    expect(q.CAP_BAND_CLASSIFICATION_NOTE.toLowerCase()).toContain(
      "current classification, not point-in-time",
    );
  });

  it("says the band is not backdated to the session being measured", () => {
    expect(q.CAP_BAND_CLASSIFICATION_NOTE).toMatch(/not backdated/i);
  });
});

describe("my names is dark until the cohort is real (Q52)", () => {
  it("needs 21 stored sessions", () => {
    expect(q.COHORT_MIN_SESSIONS).toBe(21);
  });

  it("tells the user to run the backfill, and counts what they have", () => {
    const view = q.getMyNames([], { groups: new Map(), unmapped: [] } as never, 4);
    expect(view.enabled).toBe(false);
    expect(view.rows).toHaveLength(0);
    expect(view.reason).toMatch(/run the backfill to enable/i);
    expect(view.reason).toContain("21");
    expect(view.reason).toContain("you have 4");
  });

  it("is enabled once the sessions are there", () => {
    const view = q.getMyNames([], { groups: new Map(), unmapped: [] } as never, 21);
    expect(view.enabled).toBe(true);
  });
});

describe("the locked preview (Q57)", () => {
  it("describes the cap bands without printing a figure", () => {
    const preview = read("components/atlas/atlas-preview.tsx");
    expect(preview.toLowerCase()).toContain("current classification, not a point-in-time");
  });
});
