import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The demo video's narration and publish copy are the most-watched words the
 * product will ever ship, and they go to strangers. Two things must hold and
 * nothing in CI checked either until now:
 *
 *  1. NO OUTCOME CLAIMS. The SEBI posture (MONETIZATION_PLAN §5) forbids
 *     returns, win-rate, "improve your trading" and anything that reads as a
 *     tip service. The product's actual pitch is that it does not do this.
 *  2. NAV LABELS ARE REAL. The shot list names sidebar entries; a renamed
 *     screen must break the shot list here, not in front of a camera. The
 *     first draft of the guide had three wrong labels ("Risk", "Backup",
 *     "Pricing") — found by reading nav-config.ts, which is what this pins.
 *
 * The no-claims check deliberately also covers the standing rules: macOS is
 * not sold, indicators/TradingView/Pine Script are invite-only, OpenAlgo ships
 * off and undocumented. A demo that mentioned any of them would be a
 * buyer-facing claim the repo has already decided not to make.
 */

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const COPY_FILES = [
  "docs/owner/demo-video/01-NARRATION.md",
  "docs/owner/demo-video/06-PUBLISH-COPY.md",
  // The 10-minute tour (2026-08-28): filmed by scripts/demo-video/record.mjs,
  // same rules — and OpenAlgo stays OUT of the main tour by owner decision
  // (it is advertised in writing and has its own setup video instead).
  "docs/owner/demo-video/tour/NARRATION.md",
];

// The OpenAlgo setup video NAMES OpenAlgo — that is its purpose (the
// advertising hold was discharged 2026-08-27 when a live pull reconciled
// against a signed contract note). Every OTHER ban still applies to it.
const OPENALGO_KIT_FILES = [
  "docs/owner/demo-video/openalgo/NARRATION.md",
  "docs/owner/demo-video/openalgo/SHOT-LIST.md",
  "docs/OPENALGO_SETUP.md",
];

/** Phrases that must never appear in anything a prospect reads or hears. */
const BANNED: { re: RegExp; why: string }[] = [
  { re: /improve your trading/i, why: "outcome claim" },
  { re: /become profitable|make (you )?money|more profitable/i, why: "outcome claim" },
  { re: /\bwin[- ]?rate\b/i, why: "outcome metric as a promise" },
  { re: /\baccuracy\b/i, why: "outcome metric as a promise" },
  { re: /\bguarantee/i, why: "outcome claim" },
  { re: /\breturns?\b(?! to)/i, why: "outcome claim (use 'what it cost', never 'returns')" },
  { re: /beat the market/i, why: "outcome claim" },
  { re: /\b(buy|sell) (calls?|tips?|recommendations?)\b|\btip service\b/i, why: "advisory framing" },
  { re: /\bAI[- ]powered\b/i, why: "not what the product does" },
  { re: /\bmacOS\b|\bon (a )?Mac\b/i, why: "macOS is not sold (owner decision 2026-08-15)" },
  { re: /TradingView|Pine Script|\bindicators?\b/i, why: "invite-only, not sold" },
  { re: /OpenAlgo/i, why: "kept out of the MAIN tour video (owner decision 2026-08-28) — it is advertised in writing and in its own setup video" },
];

describe("demo video copy makes no outcome claims and no retired claims", () => {
  for (const file of COPY_FILES) {
    it(`${file} is clean`, () => {
      const text = read(file);
      // The "Banned phrases" section of 06 LISTS the phrases by design; skip it.
      const body = text.split(/^## Banned phrases/m)[0];
      // Likewise the narration's "What was deliberately left out" table names them to explain why.
      const checked = body.split(/^## What was deliberately left out/m)[0];
      const hits = BANNED.filter((b) => b.re.test(checked)).map((b) => `${b.re} — ${b.why}`);
      expect(hits, `${file} contains banned phrasing:\n  ${hits.join("\n  ")}`).toEqual([]);
    });
  }

  for (const file of OPENALGO_KIT_FILES) {
    it(`${file} is clean (every ban except the OpenAlgo name itself)`, () => {
      const text = read(file);
      const checked = text.split(/^## Troubleshooting/m)[0]; // the table quotes UI warnings verbatim
      const hits = BANNED.filter((b) => !/OpenAlgo/i.test(String(b.re)) && b.re.test(checked)).map(
        (b) => `${b.re} — ${b.why}`,
      );
      expect(hits, `${file} contains banned phrasing:\n  ${hits.join("\n  ")}`).toEqual([]);
    });
  }

  it("every block still carries the not-advice line", () => {
    const pub = read("docs/owner/demo-video/06-PUBLISH-COPY.md");
    // The YouTube long description and the LinkedIn post are the two that
    // strangers read in full; both must say it outright.
    expect(pub).toMatch(/record-keeping and analytics tool, not investment advice/);
    expect(pub).toMatch(/It is a record-keeping tool\./);
  });
});

describe("the shot list names real sidebar labels", () => {
  const nav = read("components/layout/nav-config.ts");
  const labels = new Set([...nav.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]));

  it("nav-config exposes labels (sanity)", () => {
    expect(labels.size).toBeGreaterThan(30);
    expect(labels.has("Portfolio Risk")).toBe(true);
    expect(labels.has("Backup & Restore")).toBe(true);
  });

  it("every **bold** sidebar reference in the shot list exists in nav-config", () => {
    const shots = read("docs/owner/demo-video/02-SHOT-LIST.md");
    // The shot list writes sidebar targets as `*Group* → **Label**` — the
    // italic group name (Journal, Analytics, Positions, System, Overview) is
    // what distinguishes a Vyuha nav claim from an OBS menu path like
    // `OBS → **File → Remux Recordings**`, which the first version of this
    // regex caught as a false positive.
    const GROUPS = ["Overview", "Journal", "Positions", "Risk", "Analytics", "System"];
    const referenced = [...shots.matchAll(/\*(Overview|Journal|Positions|Risk|Analytics|System)\* → \*\*([^*]+)\*\*/g)].map((m) => m[2].trim());
    void GROUPS;
    expect(referenced.length).toBeGreaterThan(8);
    const missing = referenced.filter((l) => !labels.has(l));
    expect(missing, `shot list names sidebar entries that do not exist:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("the shot list does not use the three labels the first draft got wrong", () => {
    const shots = read("docs/owner/demo-video/02-SHOT-LIST.md");
    expect(shots).not.toMatch(/→ \*\*Risk\*\*/);
    expect(shots).not.toMatch(/→ \*\*Backup\*\*/);
    expect(shots).not.toMatch(/→ \*\*Pricing\*\*/);
  });
});
