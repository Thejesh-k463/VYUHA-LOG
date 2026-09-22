import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EPOCH_111A_15,
  EPOCH_50AA,
  EPOCH_FA2024,
  EPOCH_GRANDFATHER,
  EPOCH_ITA2025,
  EPOCH_SMF_REDEFINED,
  EPOCH_STT_START,
  EPOCH_UNIT_36M,
  assetClassFor,
  bucketFor,
  classifyTerm,
  heldMoreThanMonths,
  holdingMonthsFor,
  isGrandfatherEligible,
  resolveCgHead,
  type CgAssetClass,
  type CgHeadKind,
} from "@/lib/analytics/cg-heads";
import { itrCgCodes, assessmentYearFor } from "@/lib/analytics/itr-cg-codes";

/**
 * WHICH HEAD, AT WHAT RATE — the band table (v4.5.0, wave 3b-i).
 *
 * Until this release the head followed the SEGMENT: every eq_delivery / eq_mtf
 * row became "STCG (S.111A)" or "LTCG (S.112A)" and every rate came from ONE
 * cutover at 23-Jul-2024. Three separate things were wrong with that, and each
 * printed a confident number that was not the law:
 *
 *   • a gold / silver / debt / international ETF is not an equity-oriented
 *     fund and never pays 111A/112A;
 *   • s.111A was INSERTED at 10% and became 15% only for transfers from
 *     1-4-2008, and between 1-10-2004 and 31-3-2018 the long-term equity gain
 *     was EXEMPT under S.10(38);
 *   • the holding period is CALENDAR MONTHS, not 365 days, and for a listed
 *     non-equity-oriented unit it was 36 months from 11-07-2014 to 22-07-2024.
 *
 * Every number below is the statute's, and every cell names the primary-source
 * file it was read from (`_data/etf-tax-primary-sources-2026-09-15/`).
 */

interface Row {
  n: number;
  why: string;
  assetClass: CgAssetClass;
  acquired: string | null;
  transferred: string | null;
  cell: string;
  head: CgHeadKind;
  ratePct: number | null;
  exemption: number | null;
}

const MATRIX: Row[] = [
  // ── Equity, SHORT-term: the s.111A rate by band ──────────────────────────
  { n: 1, why: "before Chapter VII (STT) commenced there was no s.111A at all — SLAB", assetClass: "share", acquired: "2004-06-01", transferred: "2004-09-30", cell: "E-ST-SLAB", head: "stcgSlab", ratePct: null, exemption: null },
  { n: 2, why: "s.111A as INSERTED by the Finance (No. 2) Act 2004 s.26 — 10%", assetClass: "share", acquired: "2006-01-01", transferred: "2006-06-01", cell: "E-ST10", head: "stcg111A", ratePct: 0.10, exemption: null },
  { n: 3, why: "Finance Act 2008 s.21 raised it to 15% for transfers from 1-4-2008", assetClass: "share", acquired: "2010-01-01", transferred: "2010-06-01", cell: "E-ST15", head: "stcg111A", ratePct: 0.15, exemption: null },
  { n: 4, why: "long-term, 2007: EXEMPT under S.10(38) — neither 112A nor undetermined", assetClass: "share", acquired: "2005-01-01", transferred: "2007-06-01", cell: "E-EX1038", head: "ltcgExempt1038", ratePct: 0, exemption: null },
  { n: 5, why: "still 15% in the last pre-112A year", assetClass: "share", acquired: "2018-01-01", transferred: "2018-03-31", cell: "E-ST15", head: "stcg111A", ratePct: 0.15, exemption: null },
  { n: 6, why: "an equity-oriented FUND unit in FY 2017-18: the FA 2017 proviso reads on SHARES only, so the exemption stands", assetClass: "equityFund", acquired: "2015-01-01", transferred: "2017-06-01", cell: "E-EX1038", head: "ltcgExempt1038", ratePct: 0, exemption: null },
  { n: 7, why: "a SHARE in FY 2017-18: the FA 2017 acquisition-side-STT proviso is NOT in this release's source set, so the head is BLANK rather than guessed", assetClass: "share", acquired: "2015-01-01", transferred: "2017-06-01", cell: "UNDET", head: "undetermined", ratePct: null, exemption: null },
  { n: 8, why: "a fund unit long-term in 2012 — exempt on the same authority", assetClass: "equityFund", acquired: "2010-01-01", transferred: "2012-06-01", cell: "E-EX1038", head: "ltcgExempt1038", ratePct: 0, exemption: null },
  { n: 9, why: "long-term before 1-10-2004: S.112 on an INDEXED cost, and no CII is bundled", assetClass: "share", acquired: "2000-01-01", transferred: "2004-09-30", cell: "E-LT112", head: "ltcg112", ratePct: null, exemption: null },
  { n: 10, why: "S.112A at 10% above ₹1,00,000, Finance Act 2018", assetClass: "share", acquired: "2018-06-01", transferred: "2020-06-01", cell: "E-LT10", head: "ltcg112A", ratePct: 0.10, exemption: 100000 },
  { n: 11, why: "12.5% above ₹1,25,000 from 23-7-2024 — the epoch day itself", assetClass: "share", acquired: "2023-01-01", transferred: "2024-07-23", cell: "E-LT125", head: "ltcg112A", ratePct: 0.125, exemption: 125000 },
  { n: 12, why: "s.198 of the Income-tax Act, 2025, in force 1-4-2026", assetClass: "share", acquired: "2024-01-01", transferred: "2026-06-01", cell: "E-LT198", head: "ltcg112A", ratePct: 0.125, exemption: 125000 },
  { n: 13, why: "s.111A at 20% from 23-7-2024", assetClass: "share", acquired: "2024-01-01", transferred: "2024-07-23", cell: "E-ST20", head: "stcg111A", ratePct: 0.20, exemption: null },
  { n: 14, why: "GRANDFATHER BOUNDARY: acquired ON 31-Jan-2018 — S.55(2)(ac) says 'before the 1st day of February, 2018', so it IS eligible", assetClass: "share", acquired: "2018-01-31", transferred: "2025-06-01", cell: "E-LT125", head: "ltcg112A", ratePct: 0.125, exemption: 125000 },
  { n: 15, why: "GRANDFATHER BOUNDARY: acquired on 1-Feb-2018 — the first day that is NOT eligible", assetClass: "share", acquired: "2018-02-01", transferred: "2025-06-01", cell: "E-LT125", head: "ltcg112A", ratePct: 0.125, exemption: 125000 },
  { n: 16, why: "s.196 of the Income-tax Act, 2025 — 20% short-term", assetClass: "share", acquired: "2026-01-01", transferred: "2026-06-01", cell: "E-ST196", head: "stcg111A", ratePct: 0.20, exemption: null },

  // ── A unit that is NOT equity-oriented ───────────────────────────────────
  { n: 17, why: "a DEBT unit acquired on/after 1-4-2023 is a Specified Mutual Fund — S.50AA DEEMS it short-term for ever", assetClass: "debtUnit", acquired: "2023-04-01", transferred: "2030-06-01", cell: "O-SMF", head: "stcgDeemedSmf", ratePct: null, exemption: null },
  { n: 18, why: "a GOLD unit met the ≤35%-domestic-equity SMF test too, up to 31-3-2025 — slab, so NO rate", assetClass: "otherUnit", acquired: "2023-06-01", transferred: "2025-03-31", cell: "O-SMF", head: "stcgDeemedSmf", ratePct: null, exemption: null },
  { n: 19, why: "held 17 months inside the 36-month band — SHORT-term at slab, and S.111A cannot reach it (no STT)", assetClass: "otherUnit", acquired: "2022-01-01", transferred: "2023-06-01", cell: "O-ST", head: "stcgSlab", ratePct: null, exemption: null },
  { n: 20, why: "the 36-month band opens the day AFTER 10-7-2014: held 18 months, still SHORT", assetClass: "debtUnit", acquired: "2013-01-01", transferred: "2014-07-11", cell: "O-ST", head: "stcgSlab", ratePct: null, exemption: null },
  { n: 21, why: "held 53 months — S.112 on an INDEXED cost, no CII bundled", assetClass: "otherUnit", acquired: "2019-01-01", transferred: "2023-06-01", cell: "O-LT-a", head: "ltcg112", ratePct: null, exemption: null },
  { n: 22, why: "transferred ON 10-7-2014, the last 12-month day for a listed unit — LONG-term", assetClass: "debtUnit", acquired: "2013-01-01", transferred: "2014-07-10", cell: "O-LT-a", head: "ltcg112", ratePct: null, exemption: null },
  { n: 23, why: "12.5% WITHOUT indexation from 23-7-2024, Finance (No. 2) Act 2024", assetClass: "otherUnit", acquired: "2013-01-01", transferred: "2024-07-23", cell: "O-LT-b", head: "ltcg112", ratePct: 0.125, exemption: null },
  { n: 24, why: "s.197 of the 2025 Act governs it and NO rate for s.197 is in the source set — BLANK, not carried over", assetClass: "otherUnit", acquired: "2020-01-01", transferred: "2026-06-01", cell: "O-LT-c", head: "ltcg112", ratePct: null, exemption: null },

  // ── Blank by construction ────────────────────────────────────────────────
  { n: 25, why: "the journal cannot say what was transferred — no head, no rate", assetClass: "undetermined", acquired: "2024-01-01", transferred: "2025-06-01", cell: "UNDET", head: "undetermined", ratePct: null, exemption: null },
  { n: 26, why: "no transfer date: every rate, holding period and exemption in the Act is keyed to it", assetClass: "share", acquired: "2024-01-01", transferred: null, cell: "UNDET", head: "undetermined", ratePct: null, exemption: null },
];

describe("resolveCgHead — the transfer-date band table (dossier §G1)", () => {
  it("covers 26 rows", () => {
    expect(MATRIX).toHaveLength(26);
    expect(new Set(MATRIX.map((r) => r.n)).size).toBe(26);
  });

  it.each(MATRIX)("row $n — $why", (r) => {
    const h = resolveCgHead({ assetClass: r.assetClass, acquiredOn: r.acquired, transferredOn: r.transferred });
    expect(h.cell).toBe(r.cell);
    expect(h.head).toBe(r.head);
    expect(h.ratePct).toBe(r.ratePct);
    expect(h.exemption).toBe(r.exemption);
    // An undetermined head carries NO term — never the conservative "ST" the
    // segment-driven code printed as if it had been measured.
    if (r.head === "undetermined") expect(h.term).toBeNull();
    else expect(h.term).not.toBeNull();
    // A blank rate always says WHY; a stated rate needs no excuse but still cites.
    expect(h.reasons.length).toBeGreaterThan(0);
  });

  it("rows 14 and 15 are the grandfather boundary, one day apart", () => {
    const on = resolveCgHead({ assetClass: "share", acquiredOn: "2018-01-31", transferredOn: "2025-06-01" });
    const after = resolveCgHead({ assetClass: "share", acquiredOn: "2018-02-01", transferredOn: "2025-06-01" });
    expect(on.grandfatherEligible).toBe(true);
    expect(after.grandfatherEligible).toBe(false);
    expect(on.reasons.join(" ")).toMatch(/grandfathered cost/);
    expect(isGrandfatherEligible("2018-01-31")).toBe(true);
    expect(isGrandfatherEligible(EPOCH_GRANDFATHER)).toBe(false);
  });

  it("rows 18 and 24 state an AMOUNT with no rate — the two shapes that blank a year", () => {
    for (const n of [18, 24]) {
      const r = MATRIX.find((x) => x.n === n)!;
      const h = resolveCgHead({ assetClass: r.assetClass, acquiredOn: r.acquired, transferredOn: r.transferred });
      expect(h.ratePct).toBeNull();
      expect(h.term).not.toBeNull(); // the TERM is known; only the rate is not
    }
  });

  it("the S.10(38) exemption is a determined head, and it rides in the 112A bucket", () => {
    // It is neither `ltcg112A` (which did not exist before 2018) nor
    // `undetermined` (it is perfectly determined — it is exempt), which is why
    // `CgHeadKind` gained a member the design's enum could not express.
    const h = resolveCgHead({ assetClass: "share", acquiredOn: "2005-01-01", transferredOn: "2007-06-01" });
    expect(h.head).toBe("ltcgExempt1038");
    expect(h.ratePct).toBe(0); // 0 is the RIGHT answer here, not a blank
    expect(bucketFor("ltcgExempt1038")).toBe("ltcg112A");
    expect(bucketFor("ltcg112A")).toBe("ltcg112A");
  });

  it("every head maps to exactly one per-FY bucket", () => {
    expect(bucketFor("stcg111A")).toBe("stcg111A");
    expect(bucketFor("stcgSlab")).toBe("stcgOther");
    expect(bucketFor("stcgDeemedSmf")).toBe("stcgOther");
    expect(bucketFor("ltcg112")).toBe("ltcg112");
    expect(bucketFor("undetermined")).toBe("cgUndetermined");
  });

  it("a short-term equity row with no acquisition date says the line was not tested", () => {
    const h = resolveCgHead({ assetClass: "share", acquiredOn: null, transferredOn: "2025-06-01" });
    expect(h.term).toBe("ST");
    expect(h.reasons.join(" ")).toMatch(/not a measured one/);
  });
});

/**
 * T3 — the holding period is CALENDAR MONTHS. S.2(42A) says months, and the
 * General Clauses Act, 1897 s.3(35) defines a month as a calendar month
 * reckoned from a date (`indiacode-general-clauses-act-1897-s3-definitions-item.json`).
 * The 365-day approximation this replaces sat in FOUR modules and moved the
 * long-term line by up to two days, in BOTH directions, for every equity trade.
 */
describe("heldMoreThanMonths — calendar months, not days", () => {
  it("needs the transfer PAST the same calendar date n months on", () => {
    expect(heldMoreThanMonths("2023-01-15", "2024-01-15", 12)).toBe(false); // exactly 12 months
    expect(heldMoreThanMonths("2023-01-15", "2024-01-16", 12)).toBe(true);
  });

  it("clamps 29-Feb to the target month's last day, so 29-Feb + 12m is 28-Feb", () => {
    expect(heldMoreThanMonths("2024-02-29", "2025-02-28", 12)).toBe(false);
    expect(heldMoreThanMonths("2024-02-29", "2025-03-01", 12)).toBe(true);
  });

  it("clamps 31-Jan the same way and never rounds a short holding up", () => {
    expect(heldMoreThanMonths("2023-01-31", "2024-01-31", 12)).toBe(false);
    expect(heldMoreThanMonths("2023-01-31", "2024-02-01", 12)).toBe(true);
    // 366 days (a leap year) is still not twelve calendar months here.
    expect(classifyTerm("2023-03-01", "2024-02-29")).toBe("ST");
    expect(classifyTerm("2023-03-01", "2024-03-02")).toBe("LT");
  });

  it("a missing or unreadable date keeps the conservative answer", () => {
    expect(heldMoreThanMonths(null, "2025-01-01", 12)).toBe(false);
    expect(heldMoreThanMonths("2023-01-01", null, 12)).toBe(false);
    expect(heldMoreThanMonths("2023-02-31", "2025-01-01", 12)).toBe(false);
    // A legacy day-first value is read as the day it NAMES, not as an Invalid Date.
    expect(heldMoreThanMonths("15-01-2023", "16-01-2024", 12)).toBe(true);
  });
});

describe("holdingMonthsFor — 12 for equity always, 36 for a listed unit in one band", () => {
  it("is 12 for a share and an equity-oriented fund at EVERY date", () => {
    for (const d of ["2004-01-01", EPOCH_UNIT_36M, "2020-01-01", EPOCH_FA2024, "2030-01-01", null]) {
      expect(holdingMonthsFor("share", d)).toBe(12);
      expect(holdingMonthsFor("equityFund", d)).toBe(12);
    }
  });

  it("is 36 for a non-EOF unit from 11-07-2014 to 22-07-2024, and 12 on either side", () => {
    // The band opens the day AFTER the FA 2014 date and closes the day BEFORE
    // the Finance (No. 2) Act 2024 date (`egazette-256436-finance-no2-act-2024.pdf`).
    expect(holdingMonthsFor("otherUnit", "2014-07-10")).toBe(12);
    expect(holdingMonthsFor("otherUnit", "2014-07-11")).toBe(36);
    expect(holdingMonthsFor("debtUnit", "2024-07-22")).toBe(36);
    expect(holdingMonthsFor("debtUnit", EPOCH_FA2024)).toBe(12);
    expect(holdingMonthsFor("otherUnit", "2030-01-01")).toBe(12);
    // No transfer date: the 12-month default, never the longer one.
    expect(holdingMonthsFor("otherUnit", null)).toBe(12);
  });
});

/**
 * P3 — what the asset class is resolved FROM, against the bundled NSE ETF list
 * (wave 3a), not a stub. A bare BSE scrip code with no ISIN is NOT evidence
 * that an equity share was traded, and calling it one taxed it at 111A/112A on
 * nothing at all.
 */
describe("assetClassFor — against the real bundled list", () => {
  it("a bare numeric scrip code with NO ISIN is undetermined (P3)", () => {
    expect(assetClassFor({ segment: "eq_delivery", symbol: "532540", isin: null })).toBe("undetermined");
    expect(assetClassFor({ segment: "eq_delivery", symbol: "532540", isin: "" })).toBe("undetermined");
    // The same code WITH its ISIN resolves — that is the fix the user applies.
    expect(assetClassFor({ segment: "eq_delivery", symbol: "532540", isin: "INE467B01029" })).toBe("share");
  });

  it("an ordinary listed share resolves to share", () => {
    expect(assetClassFor({ segment: "eq_delivery", symbol: "TCS", isin: "INE467B01029" })).toBe("share");
    expect(assetClassFor({ segment: "eq_mtf", symbol: "RELIANCE", isin: null })).toBe("share");
  });

  it("splits the bundled ETF list into equityFund / otherUnit / debtUnit", () => {
    expect(assetClassFor({ segment: "eq_delivery", symbol: "NIFTYBEES", isin: null })).toBe("equityFund");
    expect(assetClassFor({ segment: "eq_delivery", symbol: "GOLDBEES", isin: null })).toBe("otherUnit");
    expect(assetClassFor({ segment: "eq_delivery", symbol: "LIQUIDBEES", isin: null })).toBe("debtUnit");
  });

  it("an INF fund ISIN the bundled list does not carry is undetermined, never 'an ordinary share'", () => {
    expect(assetClassFor({ segment: "eq_delivery", symbol: "MYSTERY", isin: "INF999X01000" })).toBe("undetermined");
  });
});

/**
 * T2 — Schedule CG item codes. A code is a pointer into a specific PDF of a
 * specific year; guessing one is worse than printing nothing, because a wrong
 * box number is transcribed into the utility and is invisible until the return
 * is rejected (invariant 6).
 */
describe("itrCgCodes — read off the form, or blank", () => {
  it("ITR-2 AY 2025-26 is A2 / B4 / B9", () => {
    // incometaxgov-ITR-2_2025_Main_V1.2-schema-AY2025-26.json
    expect(itrCgCodes("ITR-2", "2024-25")).toEqual({ stcg111A: "A2", ltcg112A: "B4", ltcg112: "B9", notes: [] });
  });

  it("ITR-2 AY 2026-27 is A2 / B3 / B8 — the long-term rows MOVED", () => {
    expect(itrCgCodes("ITR-2", "2025-26")).toEqual({ stcg111A: "A2", ltcg112A: "B3", ltcg112: "B8", notes: [] });
  });

  it("ITR-3 keeps A3 for s.111A and blanks its long-term rows", () => {
    const c = itrCgCodes("ITR-3", "2025-26");
    expect(c.stcg111A).toBe("A3");
    expect(c.ltcg112A).toBeNull();
    expect(c.ltcg112).toBeNull();
    expect(c.notes.join(" ")).toMatch(/not read for this release/);
  });

  it("an assessment year this release has not read is BLANK, never a nearby year's", () => {
    const c = itrCgCodes("ITR-2", "2026-27"); // AY 2027-28
    expect(c).toMatchObject({ stcg111A: null, ltcg112A: null, ltcg112: null });
    expect(c.notes.join(" ")).toMatch(/AY 2027-28/);
    expect(c.notes.join(" ")).toMatch(/B4 for AY 2025-26 and B3 on AY 2026-27|B4 on the AY 2025-26/);
  });

  it("a label that is not a financial year gets no assessment year and no codes", () => {
    expect(assessmentYearFor("2024-25")).toBe("2025-26");
    expect(assessmentYearFor("not-a-year")).toBeNull();
    expect(itrCgCodes("ITR-2", "not-a-year").stcg111A).toBeNull();
  });
});

/**
 * Every statutory number in `cg-heads.ts` names the primary-source file it came
 * from. A citation to a file that does not exist is a citation to nothing, so
 * this reads the module's own text, extracts the filenames it names, and looks
 * for each one in the folder.
 *
 * The folder is OUTSIDE the repo (raw gazette/CBDT captures are research
 * inputs, not shipped assets), so this SKIPS when it is absent rather than
 * reddening a machine that does not have it — the same contract
 * `tests/isin-bundle-coverage.test.ts` uses for its private fixtures.
 */
const SOURCE_DIR = join(process.cwd(), "..", "LIVE-DESK-RESEARCH", "_data", "etf-tax-primary-sources-2026-09-15");

/**
 * The filenames a stretch of source cites, in backticks. A long capture is
 * ELIDED in those comments with a horizontal ellipsis that swallows the dot
 * too (`egazette-22230-…-commencement-…pdf`), so a citation is matched by its
 * stem plus its extension, never as an exact string.
 */
function citedFiles(text: string): { raw: string; stem: string; ext: string }[] {
  return [...text.matchAll(/`([A-Za-z0-9][\w.-]*?)[.…][\w.…-]*?(pdf|html|txt|json)`/g)].map((m) => ({
    raw: m[0],
    stem: m[1],
    ext: m[2],
  }));
}

describe("every epoch constant cites a primary-source file that EXISTS", () => {
  it("names at least one file per epoch", () => {
    const src = readFileSync(join(process.cwd(), "lib", "analytics", "cg-heads.ts"), "utf8");
    // The constants, and the doc block immediately above each of them.
    for (const name of [
      "EPOCH_STT_START", "EPOCH_111A_15", "EPOCH_UNIT_36M", "EPOCH_FA2017_PROVISO",
      "EPOCH_GRANDFATHER", "EPOCH_112A", "EPOCH_50AA", "EPOCH_FA2024",
      "EPOCH_SMF_REDEFINED", "EPOCH_ITA2025",
    ]) {
      const at = src.indexOf(`export const ${name} =`);
      expect(at, `${name} is declared`).toBeGreaterThan(-1);
      const doc = src.slice(Math.max(0, src.lastIndexOf("/**", at)), at);
      // Either a named file, or an explicit "(dossier §G1)" pointer for the two
      // constants whose authority is the dossier section rather than one file.
      expect(
        citedFiles(doc).length > 0 || /dossier §G1/.test(doc),
        `${name} cites a source`,
      ).toBe(true);
    }
  });

  it.skipIf(!existsSync(SOURCE_DIR))("every file named in cg-heads.ts is in the folder", () => {
    const present = readdirSync(SOURCE_DIR);
    const src = readFileSync(join(process.cwd(), "lib", "analytics", "cg-heads.ts"), "utf8");
    const cited = citedFiles(src);
    expect(cited.length).toBeGreaterThan(5);
    const missing = cited.filter(
      (c) => !present.some((f) => f.startsWith(c.stem) && f.toLowerCase().endsWith(`.${c.ext}`)),
    );
    expect(missing.map((c) => c.raw), "a citation to a file that is not in the primary-source folder").toEqual([]);
  });

  it("the epochs are the dates the statutes actually name", () => {
    expect(EPOCH_STT_START).toBe("2004-10-01");
    expect(EPOCH_111A_15).toBe("2008-04-01");
    expect(EPOCH_UNIT_36M).toBe("2014-07-10");
    expect(EPOCH_GRANDFATHER).toBe("2018-02-01"); // "before the 1st day of February, 2018"
    expect(EPOCH_50AA).toBe("2023-04-01");
    expect(EPOCH_FA2024).toBe("2024-07-23");
    expect(EPOCH_SMF_REDEFINED).toBe("2025-04-01");
    expect(EPOCH_ITA2025).toBe("2026-04-01");
  });
});
