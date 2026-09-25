import { describe, expect, it } from "vitest";
import { GLOSSARY, findTerm } from "@/lib/domain/glossary";
import { splitGlossary, type GlossaryPiece, type GlossaryTerm } from "@/lib/domain/glossary-split";
import { METRIC_HELP } from "@/lib/domain/metric-help";

/**
 * v4.6.0 W4 (ruling H4) — the glossary the help dialog links, and the pure
 * cutter that links it. The registry half pins the content (Agent B's file);
 * the splitGlossary half pins the linking rules the dialog relies on.
 */

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe("GLOSSARY — the registry", () => {
  it("25–35 terms, every term and alias unique case-insensitively across the whole list", () => {
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(25);
    expect(GLOSSARY.length).toBeLessThanOrEqual(35);
    const all = GLOSSARY.flatMap((t) => [t.term, ...(t.aliases ?? [])].map((w) => w.trim().toLowerCase()));
    const dupes = all.filter((w, i) => all.indexOf(w) !== i);
    expect(dupes, `duplicate glossary words: ${dupes.join(", ")}`).toEqual([]);
  });

  it("every meaning is at most 40 words and says something", () => {
    for (const t of GLOSSARY) {
      expect(t.meaning.trim().length, t.term).toBeGreaterThan(0);
      expect(words(t.meaning), `${t.term}: ${words(t.meaning)} words`).toBeLessThanOrEqual(40);
    }
  });

  it("a metricId names a real METRIC_HELP entry", () => {
    const withId = GLOSSARY.filter((t) => t.metricId);
    expect(withId.length, "no glossary term is linked to a metric").toBeGreaterThan(0);
    for (const t of withId) expect(Object.keys(METRIC_HELP), `${t.term} → ${t.metricId}`).toContain(t.metricId);
  });

  it("findTerm matches a term or an alias, case-insensitively", () => {
    for (const t of GLOSSARY) {
      expect(findTerm(t.term.toUpperCase()), t.term).toBe(t);
      for (const a of t.aliases ?? []) expect(findTerm(` ${a.toLowerCase()} `), a).toBe(t);
    }
    expect(findTerm("zz-not-a-term")).toBeUndefined();
  });

  it("describes — no advice vocabulary", () => {
    for (const t of GLOSSARY) expect(t.meaning, t.term).not.toMatch(/\b(should|must|recommend\w*|suggest\w*|best)\b/i);
  });
});

describe("splitGlossary — the linking rules", () => {
  const R: GlossaryTerm = { term: "R-multiple", aliases: ["R"], meaning: "risk units" };
  const PRO: GlossaryTerm = { term: "Pro", meaning: "the paid tier" };
  const MARK: GlossaryTerm = { term: "Mark", aliases: ["MTM", "mark to market"], meaning: "a price" };
  const FNO: GlossaryTerm = { term: "F&O", meaning: "futures and options" };
  const TERMS = [R, PRO, MARK, FNO];

  const linked = (pieces: GlossaryPiece[]) =>
    pieces.filter((p): p is Exclude<GlossaryPiece, string> => typeof p !== "string").map((p) => [p.text, p.term.term]);
  const joined = (pieces: GlossaryPiece[]) => pieces.map((p) => (typeof p === "string" ? p : p.text)).join("");

  it("no partial-word match — not inside a word, not inside a hyphenated compound", () => {
    expect(linked(splitGlossary("ROM is pro-rata; profit is Rs gained", TERMS))).toEqual([]);
    expect(linked(splitGlossary("reproduce premarked FNOs", TERMS))).toEqual([]);
    // The hyphen binds on BOTH sides: a term after one is inside a compound too.
    expect(linked(splitGlossary("a semi-pro desk, a take-R row", TERMS))).toEqual([]);
  });

  it("whole words, case-insensitive, punctuation preserved around them", () => {
    const text = "Open R, (pro) and F&O.";
    const pieces = splitGlossary(text, TERMS);
    expect(linked(pieces)).toEqual([["R", "R-multiple"], ["pro", "Pro"], ["F&O", "F&O"]]);
    expect(joined(pieces)).toBe(text);
  });

  it("the longest phrase wins at a position — R-multiple before R, a three-word alias before one word", () => {
    expect(linked(splitGlossary("An R-multiple of 2", TERMS))).toEqual([["R-multiple", "R-multiple"]]);
    expect(linked(splitGlossary("Mark to market daily", TERMS))).toEqual([["Mark to market", "Mark"]]);
  });

  it("one link per term per paragraph — an alias of an already-linked term stays plain", () => {
    const text = "The mark moves; MTM again; the mark once more. R then R.";
    const pieces = splitGlossary(text, TERMS);
    expect(linked(pieces)).toEqual([["mark", "Mark"], ["R", "R-multiple"]]);
    expect(joined(pieces), "every character survives").toBe(text);
  });

  it("an empty text or an empty glossary is handled without inventing pieces", () => {
    expect(splitGlossary("", TERMS)).toEqual([]);
    expect(splitGlossary("nothing here", [])).toEqual(["nothing here"]);
    expect(splitGlossary("nothing here", TERMS)).toEqual(["nothing here"]);
  });

  it("the shipped glossary links real help prose and loses no character", () => {
    const text = "Open R against the risk frozen at entry, MTF interest, and STT on the sell leg.";
    const pieces = splitGlossary(text, GLOSSARY);
    expect(joined(pieces)).toBe(text);
    expect(linked(pieces).length).toBeGreaterThan(0);
  });
});
