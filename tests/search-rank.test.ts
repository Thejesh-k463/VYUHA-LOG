import { describe, expect, it } from "vitest";
import { CATEGORY_CHIPS, ftsMatch, matchTier, minTrigram, rankCandidates, tokenise, TRIGRAM_MIN, type Candidate } from "@/lib/domain/search-rank";
import { SOURCE_KEYS } from "@/lib/domain/search-scope";

/**
 * Search v1 — the pure ranking module.
 *
 * The tier ladder is the product rule: an exact ticker beats a ticker prefix
 * beats a name/keyword substring beats an exact BSE code, and ties break on
 * the label so a query is deterministic. `minTrigram` is the FTS switch: the
 * trigram tokenizer matches nothing under three characters, so a shorter
 * query must be answered in memory alone.
 */

const CANDS: Candidate[] = [
  { id: "INE002A01018", label: "RELIANCE", ticker: "RELIANCE", name: "Reliance Industries Limited", bseCode: "500325" },
  { id: "INE0J1Y01017", label: "RELINFRA", ticker: "RELINFRA", name: "Reliance Infrastructure Limited", bseCode: "500390" },
  { id: "INE467B01029", label: "TCS", ticker: "TCS", name: "Tata Consultancy Services Limited", bseCode: "532540" },
  { id: "INE860A01027", label: "HCLTECH", ticker: "HCLTECH", name: "HCL Technologies Limited", bseCode: "532281" },
  { id: "/reports/tax", label: "Tax Summary", keywords: ["ltcg", "stcg", "grandfathering", "reliance"] },
  { id: "INE0000X0001", label: "500325", ticker: "500325", name: "A ticker that looks like a code", bseCode: "999999" },
];

describe("tokenise / minTrigram / ftsMatch", () => {
  const cases: { q: string; tokens: string[]; fts: boolean; match: string | null }[] = [
    { q: "", tokens: [], fts: false, match: null },
    { q: "   ", tokens: [], fts: false, match: null },
    { q: "tc", tokens: ["tc"], fts: false, match: null },
    { q: "TCS", tokens: ["tcs"], fts: true, match: '"tcs"' },
    { q: "kou", tokens: ["kou"], fts: true, match: '"kou"' },
    { q: "a kou", tokens: ["a", "kou"], fts: true, match: '"kou"' },
    { q: "Break  Retest", tokens: ["break", "retest"], fts: true, match: '"break" AND "retest"' },
    { q: "fomo OR chased", tokens: ["fomo", "or", "chased"], fts: true, match: '"fomo" AND "chased"' },
    { q: "tcs tcs", tokens: ["tcs"], fts: true, match: '"tcs"' },
    { q: 'say "hi"', tokens: ["say", '"hi"'], fts: true, match: '"say" AND """hi"""' },
    { q: "notes* ^x:y (z)", tokens: ["notes*", "^x:y", "(z)"], fts: true, match: '"notes*" AND "^x:y" AND "(z)"' },
  ];
  it.each(cases)("$q", ({ q, tokens, fts, match }) => {
    expect(tokenise(q)).toEqual(tokens);
    expect(minTrigram(q)).toBe(fts);
    expect(ftsMatch(q)).toBe(match);
  });

  it("the trigram minimum is three characters", () => {
    expect(TRIGRAM_MIN).toBe(3);
  });

  it("every operator token comes back quoted — no bare FTS syntax survives", () => {
    const m = ftsMatch("AND NOT OR NEAR col:x *") ?? "";
    // Strip the quoted strings; nothing but AND-joins may remain.
    expect(m.replace(/"(?:[^"]|"")*"/g, "").trim().replace(/\s+/g, " ")).toMatch(/^(AND( AND)*)?$/);
  });
});

describe("matchTier — the ladder", () => {
  const rel = CANDS[0];
  const cases: { token: string; c: Candidate; tier: 0 | 1 | 2 | 3 | null }[] = [
    { token: "reliance", c: rel, tier: 0 },
    { token: "RELIANCE", c: rel, tier: 0 },
    { token: "reli", c: rel, tier: 1 },
    { token: "industries", c: rel, tier: 2 },
    { token: "500325", c: rel, tier: 3 },
    { token: "50032", c: rel, tier: null },
    { token: "liance", c: rel, tier: 2 }, // mid-word: a name substring, not a ticker prefix
    { token: "ltcg", c: CANDS[4], tier: 2 },
    { token: "tax", c: CANDS[4], tier: 2 },
    { token: "zzz", c: rel, tier: null },
    { token: "", c: rel, tier: null },
  ];
  it.each(cases)("'$token' → $tier", ({ token, c, tier }) => {
    expect(matchTier(token, c)).toBe(tier);
  });
});

describe("rankCandidates — order and tie-break", () => {
  it("exact ticker > ticker prefix > name/keyword substring > BSE code", () => {
    const out = rankCandidates("reliance", CANDS).map((r) => [r.candidate.label, r.tier]);
    expect(out).toEqual([
      ["RELIANCE", 0],
      ["RELINFRA", 2], // "reliance" is in the NAME, not a prefix of RELINFRA
      ["Tax Summary", 2],
    ]);
  });

  it("a BSE code is the last rung: a ticker that equals the code outranks the code match", () => {
    const out = rankCandidates("500325", CANDS).map((r) => [r.candidate.label, r.tier]);
    expect(out).toEqual([
      ["500325", 0],
      ["RELIANCE", 3],
    ]);
  });

  it("prefix ties break on the label, case-insensitively", () => {
    const out = rankCandidates("rel", CANDS).map((r) => r.candidate.label);
    expect(out).toEqual(["RELIANCE", "RELINFRA", "Tax Summary"]); // the keyword hit sits in the lower tier
    const swapped = rankCandidates("rel", [...CANDS].reverse()).map((r) => r.candidate.label);
    expect(swapped).toEqual(out);
  });

  it("every token must hit; the tier is the weakest token's", () => {
    // "tata" hits TCS on the name (2); "tcs" hits the ticker (0) → 2.
    expect(rankCandidates("tata tcs", CANDS).map((r) => [r.candidate.label, r.tier])).toEqual([["TCS", 2]]);
    // A token that hits nothing kills the candidate.
    expect(rankCandidates("tcs zzz", CANDS)).toEqual([]);
  });

  it("an empty query ranks nothing, and the limit caps the list", () => {
    expect(rankCandidates("", CANDS)).toEqual([]);
    expect(rankCandidates("limited", CANDS, 2)).toHaveLength(2);
    expect(rankCandidates("limited", CANDS)).toHaveLength(4);
  });
});

describe("category chips", () => {
  it("are the registry's keys, in registry order", () => {
    expect(CATEGORY_CHIPS).toEqual(SOURCE_KEYS);
    expect(CATEGORY_CHIPS).toEqual(["trades", "symbols", "playbooks", "instruments", "sessions", "challans", "help", "screens"]);
  });
});
