/**
 * WHICH ACT GOVERNED THAT YEAR — effective-dated statutory citations.
 *
 * ZERO DB and ZERO React imports; pure lookups over frozen tables.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The Income-tax Act, 1961 is REPEALED. The Income-tax Act, 2025 (Act 30 of
 * 2025) came into force on 1 April 2026 — verified in the Gazette text: "Save as
 * otherwise provided in this Act, it shall come into force on the 1st April,
 * 2026." The terms "previous year" and "assessment year" no longer exist; the
 * unit is the TAX YEAR.
 *
 * Every section number this app displayed was therefore repealed law for the
 * current year. But a report for FY 2023-24 is still governed by the 1961 Act,
 * and re-labelling it with 2025 Act sections would make it cite law that never
 * applied to it — the same class of error that effective-dated charge rates
 * (migration 0050) exist to prevent.
 *
 * So citations are RESOLVED BY TAX YEAR, exactly as rates are resolved by date.
 * A 2024-25 tax pack keeps "S.111A"; a 2026-27 pack says "s.196".
 *
 * ── What did and did not change ───────────────────────────────────────────
 *
 * The ARITHMETIC largely survives; the CITATIONS do not. The ₹10 Cr / ₹3 Cr
 * limits, the 15/45/75/100 instalment ladder, the 3/3/3/1 deferment rates, the
 * 20% / 12.5% / ₹1,25,000 capital-gains figures and the 31-Jan-2018
 * grandfathering rule all carry across unchanged. That is why this module holds
 * LABELS and not numbers: putting thresholds here would duplicate the modules
 * that already own them.
 *
 * ── Verified against the ENACTED Finance Act, 2026 ────────────────────────
 *
 * The Finance Act, 2026 (No. 4 of 2026, assented 30 March 2026) amends 88
 * sections of the 2025 Act. Checked on 2026-08-31, because several of them are
 * ones this app depends on:
 *   - s.425 is amended at sub-section (5)(f) ONLY — a tax-credit cross-reference.
 *     The 3/3/3/1 Table, the s.425(2) safe harbour and the s.425(4) relief stand.
 *   - s.66 is amended at clause (4) ONLY — the commodities-tax definitions.
 *     Clause (31) (speculative) and clause (33) (the F&O carve-out) stand.
 *   - s.63, s.196, s.198, s.72, s.90 and ss.108-113 are NOT amended at all.
 *   - s.58, s.202 and s.263 ARE amended — read the Act before relying on those.
 *
 * NOTE the Finance BILL, 2026 (Bill No. 3 of 2026) is NOT authoritative and
 * differs from the Act as passed. Cite the Act.
 */

export type StatuteId = "ita1961" | "ita2025";

/**
 * Stable concept keys. Call sites reference the CONCEPT, never a number, so a
 * future Act is one table away rather than a repo-wide find-and-replace.
 */
export type SectionKey =
  | "speculative"
  | "derivativeCarveOut"
  | "stcgEquity"
  | "ltcgEquity"
  | "grandfather"
  | "cgComputation"
  | "sttNotDeductibleCg"
  | "sttBusinessExpense"
  | "generalDeduction"
  | "depreciation"
  | "presumptive"
  | "books"
  | "audit"
  | "intraHeadSetOff"
  | "interHeadSetOff"
  | "cfCapitalLoss"
  | "cfBusinessLoss"
  | "speculationLoss"
  | "lateReturnForfeits"
  | "rebate"
  | "newRegime"
  | "stripping"
  | "gaar"
  | "advanceTaxInstalments"
  | "interestLateReturn"
  | "interestAdvanceTax"
  | "interestDeferment";

export interface Statute {
  id: StatuteId;
  /** Full name, for the one place a report should spell it out. */
  name: string;
  /** The unit of assessment under this Act — the vocabulary changed too. */
  periodNoun: string;
  /**
   * First tax year this Act governs, as a START YEAR. The 2025 Act commenced
   * 1 April 2026, which is the first day of tax year 2026-27.
   */
  fromStartYear: number;
  sections: Record<SectionKey, string>;
}

const ITA_1961: Statute = {
  id: "ita1961",
  name: "Income-tax Act, 1961",
  periodNoun: "financial year",
  fromStartYear: 0,
  sections: {
    speculative: "S.43(5)",
    derivativeCarveOut: "S.43(5) proviso (d)",
    stcgEquity: "S.111A",
    ltcgEquity: "S.112A",
    grandfather: "S.55(2)(ac)",
    cgComputation: "S.48",
    sttNotDeductibleCg: "proviso to S.48",
    sttBusinessExpense: "S.36(1)(xv)",
    generalDeduction: "S.37(1)",
    depreciation: "S.32",
    presumptive: "S.44AD",
    books: "S.44AA",
    audit: "S.44AB",
    intraHeadSetOff: "S.70",
    interHeadSetOff: "S.71",
    cfCapitalLoss: "S.74",
    cfBusinessLoss: "S.72",
    speculationLoss: "S.73",
    lateReturnForfeits: "S.80",
    rebate: "S.87A",
    newRegime: "S.115BAC",
    stripping: "S.94",
    gaar: "Ch. X-A",
    advanceTaxInstalments: "S.211",
    interestLateReturn: "S.234A",
    interestAdvanceTax: "S.234B",
    interestDeferment: "S.234C",
  },
};

const ITA_2025: Statute = {
  id: "ita2025",
  name: "Income-tax Act, 2025",
  periodNoun: "tax year",
  fromStartYear: 2026,
  sections: {
    speculative: "s.66(31)",
    derivativeCarveOut: "s.66(33)",
    stcgEquity: "s.196",
    ltcgEquity: "s.198",
    grandfather: "s.90",
    cgComputation: "s.72",
    sttNotDeductibleCg: "s.72(3)(b)",
    sttBusinessExpense: "s.32(k)",
    generalDeduction: "s.34(1)",
    depreciation: "s.33",
    presumptive: "s.58",
    books: "s.62",
    audit: "s.63",
    intraHeadSetOff: "s.108",
    interHeadSetOff: "s.109",
    cfCapitalLoss: "s.111",
    cfBusinessLoss: "s.112",
    speculationLoss: "s.113",
    lateReturnForfeits: "s.121",
    rebate: "s.156",
    newRegime: "s.202",
    stripping: "s.175",
    gaar: "ss.178-181",
    advanceTaxInstalments: "s.408",
    interestLateReturn: "s.423",
    interestAdvanceTax: "s.424",
    interestDeferment: "s.425",
  },
};

/** Newest first, so the first match wins. */
const STATUTES: readonly Statute[] = [ITA_2025, ITA_1961];

/** The tax year in which the 2025 Act took effect. */
export const STATUTE_CUTOVER_FY = "2026-27";

/**
 * Start year of an FY label like "2026-27". Returns null for anything that is
 * not one, so callers can fall back rather than silently cite the wrong Act.
 */
export function fyStartYear(fy: string): number | null {
  const m = /^(\d{4})-\d{2}$/.exec(fy.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The Act governing a tax year. An unparseable label falls back to the CURRENT
 * Act rather than the repealed one — a wrong-but-current citation is far less
 * misleading than confidently citing repealed law.
 */
export function statuteForFy(fy: string): Statute {
  const start = fyStartYear(fy);
  if (start == null) return ITA_2025;
  return STATUTES.find((s) => start >= s.fromStartYear) ?? ITA_1961;
}

/** The citation for a concept, in the Act that governed that tax year. */
export function section(fy: string, key: SectionKey): string {
  return statuteForFy(fy).sections[key];
}

/** The day the 2025 Act commenced — the first day of tax year 2026-27. */
export const STATUTE_CUTOVER_DATE = "2026-04-01";

/**
 * The Act in force on a given ISO date. For call sites that hold a transaction
 * date rather than a year label — deriving an FY label just to look one up
 * would introduce an fyStartMonth dependency this question does not have.
 * A missing or unparseable date falls back to the current Act, as above.
 */
export function statuteForDate(iso: string | null | undefined): Statute {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso.trim())) return ITA_2025;
  return iso.trim() >= STATUTE_CUTOVER_DATE ? ITA_2025 : ITA_1961;
}

/** The citation for a concept, in the Act in force on that date. */
export function sectionOn(iso: string | null | undefined, key: SectionKey): string {
  return statuteForDate(iso).sections[key];
}

/**
 * The citation plus its predecessor, for the first years after the changeover
 * when readers still know the old numbers — "s.425 (formerly S.234C)".
 *
 * Only annotated where the Act actually changed under the reader's feet; a
 * 2019-20 report says "S.234C" with no bridge, because there was nothing to
 * bridge from.
 */
export function sectionWithLegacy(fy: string, key: SectionKey): string {
  const st = statuteForFy(fy);
  if (st.id !== "ita2025") return st.sections[key];
  return `${ITA_2025.sections[key]} (formerly ${ITA_1961.sections[key]})`;
}

/**
 * One line naming the governing Act, for the head of a tax report. Reports that
 * span the changeover need this more than any single citation does.
 */
export function statuteNote(fy: string): string {
  const st = statuteForFy(fy);
  if (st.id === "ita1961") {
    return `${fy} is governed by the ${st.name}, which was repealed with effect from 1 April 2026. Sections are cited as they stood for that year.`;
  }
  return `${fy} is governed by the ${st.name}, in force from 1 April 2026. Section numbers differ from the 1961 Act even where the rule is unchanged.`;
}
