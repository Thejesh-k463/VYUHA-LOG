import { describe, expect, it } from "vitest";
import { IMPORT_HELP_CARDS } from "@/lib/domain/import-help-content";
import { IMPORT_SOURCES, brokersWithNativeParser } from "@/lib/import/registry-meta";

/**
 * The Import Help screen's promise is the dropzone's promise, one level up: it
 * describes exactly the import paths that exist. Format rows are built from
 * the registry, so this joins cards against IMPORT_SOURCES both ways — a new
 * parser without a card, or a card for a source that is gone, fails the build.
 * And the copy is held to the same banned-claims list as the demo video
 * (tests/demo-video-copy.test.ts), with one difference: this screen is ALLOWED
 * to name OpenAlgo — documenting the integration is its job.
 */

/** Every user-visible string on one card, joined. */
function cardText(c: (typeof IMPORT_HELP_CARDS)[number]): string {
  return [
    c.title,
    c.summary,
    ...c.formats.map((f) => `${f.label} ${f.hint}`),
    ...c.steps,
    ...(c.api ?? []),
    ...(c.notes ?? []),
  ].join(" ");
}

/** Phrases that must never appear — same list as the demo video, minus the
 *  OpenAlgo ban (naming OpenAlgo is this screen's purpose). */
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
];

describe("cards cover the registry, exactly", () => {
  it("every import source appears on exactly one card", () => {
    const placed = IMPORT_HELP_CARDS.flatMap((c) => c.formats.map((f) => f.sourceId));
    for (const s of IMPORT_SOURCES) {
      expect(
        placed.filter((id) => id === s.sourceId),
        `${s.sourceId} must appear on exactly one card`,
      ).toHaveLength(1);
    }
    expect(placed, "cards list sources the registry does not have").toHaveLength(IMPORT_SOURCES.length);
  });

  it("every broker with a native parser has a card", () => {
    const ids = new Set(IMPORT_HELP_CARDS.map((c) => c.id));
    for (const b of brokersWithNativeParser()) {
      expect(ids.has(b), `no Import Help card for ${b}`).toBe(true);
    }
  });

  it("card ids are unique", () => {
    const ids = IMPORT_HELP_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the API and OpenAlgo paths are documented", () => {
  it("the four API brokers each carry an API section", () => {
    const apiIds = IMPORT_HELP_CARDS.filter((c) => c.api && c.api.length > 0).map((c) => c.id);
    for (const b of ["zerodha", "dhan", "angelone", "upstox"]) {
      expect(apiIds, `${b} has no API section`).toContain(b);
    }
  });

  it("the OpenAlgo pair exists — setup and connect", () => {
    const ids = IMPORT_HELP_CARDS.map((c) => c.id);
    expect(ids).toContain("openalgo-setup");
    expect(ids).toContain("openalgo-connect");
  });

  it("a card with the openalgo chip and no API section points at the pair", () => {
    for (const c of IMPORT_HELP_CARDS) {
      if (!c.channels.includes("openalgo") || c.id.startsWith("openalgo")) continue;
      expect(cardText(c), c.id).toMatch(/OpenAlgo/);
    }
  });
});

describe("the copy stays honest", () => {
  for (const c of IMPORT_HELP_CARDS) {
    it(`${c.id} is clean of banned claims`, () => {
      const text = cardText(c);
      const hits = BANNED.filter((b) => b.re.test(text)).map((b) => `${b.re} — ${b.why}`);
      expect(hits, `${c.id} contains banned phrasing:\n  ${hits.join("\n  ")}`).toEqual([]);
    });
  }

  it("the Upstox card states the inferred-values caveat (docs/BROKER_FORMATS.md)", () => {
    const upstox = IMPORT_HELP_CARDS.find((c) => c.id === "upstox")!;
    expect(cardText(upstox)).toMatch(/inferred/i);
  });

  it("the download prose is dated the way BROKER_FORMATS.md dates verifications", () => {
    for (const id of ["zerodha", "dhan", "groww", "angelone", "upstox", "paytm"]) {
      const c = IMPORT_HELP_CARDS.find((x) => x.id === id)!;
      expect(c.steps.join(" "), `${id} download steps carry no date`).toMatch(/As of Aug 2026/);
    }
  });

  it("the generic card promises no parser and carries the PDF honesty note", () => {
    const generic = IMPORT_HELP_CARDS.find((c) => c.id === "generic")!;
    const text = cardText(generic);
    expect(text).toMatch(/No parser is promised/i);
    expect(text).toMatch(/does not import trades/);
    expect(text).toMatch(/Sahi has no MTF/);
  });
});
