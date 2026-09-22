/**
 * WHICH BOX ON WHICH FORM IN WHICH YEAR — ITR Schedule CG item codes (PURE).
 *
 * ── Why a table, and why it is allowed to be empty ────────────────────────
 *
 * `itr-schedule.ts` emitted ONE code set for every assessment year: A3 for
 * s.111A and B4 for s.112A. Both of those are wrong somewhere:
 *
 *   • On **ITR-2**, s.111A short-term gains are item **A2**, not A3. A3 is a
 *     different row entirely. VYUHA has emitted A3 since the module was
 *     written (`incometaxgov-ITR-2_2025_Main_V1.2-schema-AY2025-26.json`).
 *   • On **ITR-3**, s.111A really is A3 — the two forms number Schedule CG
 *     differently, so one code set cannot serve both (dossier §F.1).
 *   • The **codes move between years**: on ITR-2, s.112A is B4 for AY 2025-26
 *     and **B3** for AY 2026-27, and the s.112 row moves B9 → **B8**
 *     (`incometaxgov-…AY2026-27 schema json`,
 *     `incometaxgov-notification-46-2026-…pdf`).
 *
 * A code is a pointer into a specific PDF of a specific year. Guessing one is
 * worse than printing nothing: a wrong box number is transcribed straight into
 * the utility and is invisible until the return is rejected. So an (form, AY)
 * pair this release has not READ A SCHEMA FOR returns BLANK codes — invariant 6,
 * the same rule `taxesPaidByFy` applies to a missing challan.
 *
 * NOTHING here is derived. Every row below was read off the form's own schema
 * or notification in `_data/etf-tax-primary-sources-2026-09-15/`.
 */

export type ItrForm = "ITR-2" | "ITR-3";

/** The Schedule CG item codes for one (form, assessment year). null = not read. */
export interface ItrCgCodes {
  /** Short-term, s.111A / s.196. */
  stcg111A: string | null;
  /** Long-term, s.112A / s.198. */
  ltcg112A: string | null;
  /** Long-term, s.112 / s.197 — a non-equity-oriented unit. */
  ltcg112: string | null;
  /** Why a code is blank, for the caution line. Empty when all three are known. */
  notes: string[];
}

const BLANK = (notes: string[]): ItrCgCodes => ({ stcg111A: null, ltcg112A: null, ltcg112: null, notes });

/**
 * Read off the published schemas. Keyed `${form}|${assessmentYear}`.
 *
 * ITR-3's long-term rows are DELIBERATELY absent: only its A3 = 111A row was
 * verified (§F.1), and its Schedule CG B-series was not read. Blank, not
 * borrowed from ITR-2.
 */
const TABLE: Record<string, ItrCgCodes> = {
  // incometaxgov-ITR-2_2025_Main_V1.2-schema-AY2025-26.json
  "ITR-2|2025-26": { stcg111A: "A2", ltcg112A: "B4", ltcg112: "B9", notes: [] },
  // incometaxgov-ITR-2 schema AY2026-27 json + incometaxgov-notification-46-2026-…pdf
  "ITR-2|2026-27": { stcg111A: "A2", ltcg112A: "B3", ltcg112: "B8", notes: [] },
  // dossier §F.1 — ITR-3 numbers Schedule CG differently and keeps A3 for 111A.
  "ITR-3|2025-26": {
    stcg111A: "A3",
    ltcg112A: null,
    ltcg112: null,
    notes: ["ITR-3's Schedule CG long-term item codes were not read for this release — those boxes are left blank rather than borrowed from ITR-2, which numbers them differently."],
  },
  "ITR-3|2026-27": {
    stcg111A: "A3",
    ltcg112A: null,
    ltcg112: null,
    notes: ["ITR-3's Schedule CG long-term item codes were not read for this release — those boxes are left blank rather than borrowed from ITR-2, which numbers them differently."],
  },
};

/**
 * The assessment year for a financial-year label: FY 2024-25 → AY 2025-26.
 * Returns null for anything that is not an FY label, so a caller blanks rather
 * than cites a year it invented.
 */
export function assessmentYearFor(fy: string): string | null {
  const m = /^(\d{4})-\d{2}$/.exec(String(fy ?? "").trim());
  if (!m) return null;
  const y = Number(m[1]) + 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/**
 * Schedule CG item codes for a form and a FINANCIAL year. Blank codes plus a
 * named reason whenever the pair is not in the table — never a nearby year's.
 */
export function itrCgCodes(form: ItrForm, fy: string): ItrCgCodes {
  const ay = assessmentYearFor(fy);
  if (!ay) {
    return BLANK([`"${fy}" is not a financial-year label, so no assessment year and no Schedule CG item codes can be stated for it.`]);
  }
  const hit = TABLE[`${form}|${ay}`];
  if (!hit) {
    return BLANK([
      `No ${form} Schedule CG schema for AY ${ay} was read for this release, so the item codes are BLANK. They move between years — s.112A was B4 on the AY 2025-26 ITR-2 and B3 on AY 2026-27 — so a nearby year's codes would be wrong, not approximate. Read the boxes off the form for AY ${ay}.`,
    ]);
  }
  return hit;
}
