/**
 * WHICH CAPITAL-GAINS HEAD, AND AT WHAT RATE — one pure resolver (invariant 2).
 * INFORMATIONAL ONLY — not filing advice.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 *
 * Until v4.5.0 the head followed the SEGMENT: every `eq_delivery` / `eq_mtf`
 * row became "STCG (S.111A)" or "LTCG (S.112A)" and every rate came from ONE
 * cutover at 23-Jul-2024. Three things were wrong with that, and each of them
 * printed a confident number that was not the law:
 *
 *   1. A gold / silver / debt / international ETF is NOT an equity-oriented
 *      fund. It never pays 111A/112A, it never touches the ₹1.25 L exemption,
 *      and from 1-4-2023 a debt unit is DEEMED short-term for ever (s.50AA).
 *   2. A sale in 2007 was taxed at 15%. s.111A was inserted at **10%** and
 *      only became 15% for transfers from 1-4-2008.
 *   3. The holding period was 365 DAYS in four separate copies. The Act says
 *      MONTHS (General Clauses Act 1897 s.3(35) — a calendar month), and for a
 *      listed non-equity-oriented unit it was 36 months between 11-07-2014 and
 *      22-07-2024.
 *
 * So the head, the term, the rate, the exemption and the citation are ONE
 * decision taken here, from the ASSET CLASS and the TRANSFER DATE, and every
 * other module reads the answer instead of re-deriving it.
 *
 * ── Every statutory number below names the primary-source file it came from ─
 *
 * The folder is `_data/etf-tax-primary-sources-2026-09-15/` (128 files, with a
 * MANIFEST.md), outside the repo — raw gazette/CBDT captures are research
 * inputs, not shipped assets. A number with no file beside it does not belong
 * in this file: where the folder is silent the answer is BLANK (invariant 6),
 * never a plausible default. Two such blanks ship deliberately:
 *
 *   • the COST INFLATION INDEX is not in the folder, so every indexed cost,
 *     indexed gain and the tax on an s.112-with-indexation cell is null, with
 *     the missing input named (owner answer T2, 2026-09-22);
 *   • the FA 2017 proviso to s.10(38) (acquisition-side STT for shares bought
 *     on or after 1-10-2004) is NOT VERIFIED, so a SHARE sold in FY 2017-18
 *     long-term has NO head at all rather than a guessed one.
 */

import { normalizeDate } from "@/lib/domain/trading-day";
import { etfClass } from "@/lib/engine/etf-class";
import type { SectionKey, StatuteId } from "./statute";
import { statuteForDate } from "./statute";

// ---------------------------------------------------------------------------
// The epochs — ONE place, ISO strings, compared as strings
// ---------------------------------------------------------------------------
//
// ISO comparison is deliberate: `new Date()` on a legacy day-first value is an
// Invalid Date and every comparison against it is false, which silently picked
// the oldest band. Callers normalise through `normalizeDate` first.

/** Chapter VII (STT) commenced; s.111A/s.10(38) became operative on STT-paid transfers.
 *  `egazette-22230-SO1058E-2004-09-28-STT-chapter-VII-commencement-…pdf` */
export const EPOCH_STT_START = "2004-10-01";
/** s.111A raised 10% → 15% by FA 2008 s.21 (transfers from 1-4-2008).
 *  `incometaxindia-finance-act-2008-s21-s111A-fifteen-and-bill-cl18-text-capture.txt` */
export const EPOCH_111A_15 = "2008-04-01";
/** FA 2014: a listed non-EOF unit needs 36 months. The band opens on the day AFTER
 *  this date (transfers from 11-07-2014). `egazette-…finance-no2-act-2014…` (dossier §G1) */
export const EPOCH_UNIT_36M = "2014-07-10";
/** FA 2017 inserted the acquisition-side-STT proviso to s.10(38). NOT VERIFIED in the
 *  folder — a SHARE transferred in this band has a BLANK long-term head. (dossier §G1) */
export const EPOCH_FA2017_PROVISO = "2017-04-01";
/** Grandfathered cost s.55(2)(ac): "acquired before the 1st day of February, 2018".
 *  `egazette-184302-finance-act-2018-act13.pdf` */
export const EPOCH_GRANDFATHER = "2018-02-01";
/** s.10(38) sunset and s.112A in force — transfers from 1-4-2018.
 *  `egazette-184302-finance-act-2018-act13.pdf` */
export const EPOCH_112A = "2018-04-01";
/** s.50AA deeming — a Specified Mutual Fund unit ACQUIRED on/after this date.
 *  `egazette-244830-finance-act-2023.pdf`, `itact1961-s50AA-consolidated-…html` */
export const EPOCH_50AA = "2023-04-01";
/** s.111A 15% → 20%, s.112A 10% → 12.5%, exemption ₹1 L → ₹1.25 L, and a listed
 *  unit's holding period back to 12 months. `egazette-256436-finance-no2-act-2024.pdf` */
export const EPOCH_FA2024 = "2024-07-23";
/** The SMF test changes: "≤35% domestic equity" (to 31-3-2025) → ">65% debt + money
 *  market" (from 1-4-2025). `itact1961-s50AA-consolidated-…html` */
export const EPOCH_SMF_REDEFINED = "2025-04-01";
/** The Income-tax Act, 2025 in force — s.196 / s.197 / s.198.
 *  `egazette-265620-income-tax-act-2025-act30.pdf` */
export const EPOCH_ITA2025 = "2026-04-01";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type GainTerm = "ST" | "LT";

/** What KIND of capital asset was transferred. Never defaulted anywhere. */
export type CgAssetClass =
  /** A listed equity share. */
  | "share"
  /** An equity-oriented fund unit — an ETF or MF ≥65% domestic listed equity. */
  | "equityFund"
  /** A listed non-equity-oriented unit that is NOT debt: gold, silver, international. */
  | "otherUnit"
  /** A listed debt / liquid unit. Separated from `otherUnit` because the s.50AA
   *  Specified-Mutual-Fund test reads them differently from 1-4-2025. */
  | "debtUnit"
  /** The journal cannot say what this is. The head is BLANK (invariant 6). */
  | "undetermined";

export type CgHeadKind =
  | "stcg111A"
  | "stcgSlab"
  | "stcgDeemedSmf"
  | "ltcg112A"
  /** Long-term under s.112 (1961) / s.197 (2025) — a non-equity-oriented unit. */
  | "ltcg112"
  /**
   * DELIBERATE ADDITION to the design's enum. Between 1-10-2004 and 31-3-2018 a
   * long-term STT-paid equity gain was EXEMPT under s.10(38); it is neither
   * `ltcg112A` (which did not exist) nor `undetermined` (it is perfectly
   * determined — it is exempt). The design mandates the E-EX1038 cell while its
   * own enum cannot express it; this member is that cell's head.
   * `egazette-184302-finance-act-2018-act13.pdf` (the sunset) and
   * `incometaxindia-finance-no2-act-2004-s5h-s10-38-…-capture.txt` (the insertion).
   */
  | "ltcgExempt1038"
  | "undetermined";

export interface CgHead {
  /** The dossier §G1 cell id — E-ST10, E-EX1038, O-LT-a, … ; "UNDET" when blank. */
  cell: string;
  head: CgHeadKind;
  /** null when the head is undetermined — a blank term, never a guessed "ST". */
  term: GainTerm | null;
  /** Calendar months that had to elapse for long-term at this date and class. */
  holdingMonths: number;
  /** Which Act governs the transfer date. */
  act: StatuteId;
  /** The concept key `lib/analytics/statute.ts` resolves into a citation. */
  sectionKey: SectionKey | null;
  /** The rate as a FRACTION, or null where the folder does not carry one (slab,
   *  unverified, or an s.112 cell whose CII input is missing). NEVER a guess. */
  ratePct: number | null;
  /** Whether the cell is computed on an INDEXED cost. Always paired with a null
   *  amount downstream, because no CII table is bundled. */
  indexation: boolean;
  /** The pre-FA2024 s.112 proviso: 10% without indexation as a cap. Not priced —
   *  no rate for it is in the folder, so it is surfaced as a flag only. */
  cap10NoIndexation: boolean;
  /** The annual 112A exemption in ₹, or null where the cell has none. */
  exemption: number | null;
  /** s.55(2)(ac) grandfathering is available on this cell for a pre-1-2-2018 lot. */
  grandfatherEligible: boolean;
  /** Human-readable WHY — printed beside a blank so the user knows what is missing. */
  reasons: string[];
}

export interface CgHeadInput {
  assetClass: CgAssetClass;
  /** Acquisition date, any accepted shape — normalised here. */
  acquiredOn: string | null;
  /** Transfer date (the broker's-note date, Circular 704). */
  transferredOn: string | null;
}

// ---------------------------------------------------------------------------
// T3 — calendar months, the ONE holding-period helper
// ---------------------------------------------------------------------------

/**
 * The same calendar date `n` months after `iso`, with the day clamped to the
 * target month's length: 31-Jan + 1 month is 28-Feb (29-Feb in a leap year),
 * and 29-Feb + 12 months is 28-Feb.
 */
function addMonthsIso(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const totalMonth = m - 1 + n;
  const ty = y + Math.floor(totalMonth / 12);
  const tm = ((totalMonth % 12) + 12) % 12; // 0-based
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const td = Math.min(d, lastDay);
  return `${String(ty).padStart(4, "0")}-${String(tm + 1).padStart(2, "0")}-${String(td).padStart(2, "0")}`;
}

/**
 * Was the asset held for MORE THAN `n` calendar months?
 *
 * The Act says "months", and the General Clauses Act, 1897 s.3(35) defines a
 * month as a calendar month reckoned from a date — NOT 30 days and NOT 365 days
 * for twelve of them (`indiacode-general-clauses-act-1897-s3-definitions-item.json`).
 * Long-term therefore requires the transfer to fall AFTER the same calendar date
 * `n` months on: bought 15-Jan-2023, a sale on 15-Jan-2024 is still SHORT-term
 * and 16-Jan-2024 is long. The 365-day approximation this replaces moved that
 * line by up to two days for EVERY equity trade, in both directions.
 *
 * A missing or unparseable date keeps the conservative answer (short-term), as
 * the four copies it replaces did.
 */
export function heldMoreThanMonths(
  acquired: string | null,
  transferred: string | null,
  n: number,
): boolean {
  const a = normalizeDate(acquired);
  const t = normalizeDate(transferred);
  if (!a || !t) return false;
  return t > addMonthsIso(a, n);
}

/**
 * Calendar months an asset of this class must be held to be long-term, for a
 * transfer on this date.
 *
 * 12 for a share or an equity-oriented-fund unit at EVERY date. For a listed
 * NON-equity-oriented unit it was 12 until 10-07-2014, 36 for transfers from
 * 11-07-2014 to 22-07-2024, and 12 again from 23-07-2024
 * (`egazette-256436-finance-no2-act-2024.pdf`).
 */
export function holdingMonthsFor(assetClass: CgAssetClass, transferIso: string | null): number {
  if (assetClass === "share" || assetClass === "equityFund") return 12;
  if (!transferIso) return 12;
  return transferIso > EPOCH_UNIT_36M && transferIso < EPOCH_FA2024 ? 36 : 12;
}

/**
 * The legacy day-count API, kept as a THIN WRAPPER so callers that only need
 * "ST or LT" for an equity row do not each re-derive it. It is the 12-month
 * rule — a non-equity unit must go through `resolveCgHead`, which knows the
 * 36-month band.
 */
export function classifyTerm(buyDate: string | null, sellDate: string | null): GainTerm {
  return heldMoreThanMonths(buyDate, sellDate, 12) ? "LT" : "ST";
}

// ---------------------------------------------------------------------------
// Asset class
// ---------------------------------------------------------------------------

/** A BSE numeric scrip code, e.g. "532540". Same predicate as
 *  `lib/import/isin-symbol.ts:68 isCodedSymbol`, re-stated here so the pure
 *  analytics graph does not pull the two listing snapshots in. */
const NUMERIC_CODE = /^\d+$/;

/**
 * What kind of capital asset a trade row transferred.
 *
 * P3 (v4.5.0): a row whose symbol is still a BARE NUMERIC SCRIP CODE and that
 * states no ISIN is NOT an equity share — the journal simply does not know what
 * it is, and calling it a share taxed it at 111A/112A on no evidence. It
 * resolves to `undetermined`, which blanks the head, and Data Quality names the
 * code so the user can fix it.
 *
 * An INF-prefixed ISIN absent from the bundled NSE ETF list (the seven BSE-only
 * Sensex ETFs, SIF units, segregated portfolios) is likewise `undetermined`:
 * `etfClass` answers null for "the list does not say", never "an ordinary
 * share" (dossier §F.2).
 */
export function assetClassFor(t: {
  segment: string;
  isin?: string | null;
  symbol?: string | null;
}): CgAssetClass {
  const isin = String(t.isin ?? "").trim().toUpperCase();
  const symbol = String(t.symbol ?? "").trim().toUpperCase();

  const etf = etfClass({ isin, symbol });
  if (etf) {
    if (etf.kind === "equity-oriented") return "equityFund";
    // The RAW `ETF Underlying` NSE published, not the binary kind: s.50AA reads
    // DEBT differently from COMMODITY / GLOBAL INDICES from 1-4-2025.
    const u = etf.underlying.trim().toUpperCase();
    if (u === "DEBT") return "debtUnit";
    // A hybrid unit's equity share is not published, so neither the EOF test nor
    // the SMF test can be applied — blank, with a Data Quality warning (T1, Q4(a)).
    if (u === "HYBRID") return "undetermined";
    return "otherUnit";
  }

  // An INF ISIN that the list does not carry: an ETF/MF unit of unknown class.
  if (isin.startsWith("INF")) return "undetermined";

  // P3 — a bare scrip code with no ISIN.
  if (!isin && NUMERIC_CODE.test(symbol)) return "undetermined";

  return "share";
}

// ---------------------------------------------------------------------------
// The transfer-date band table (dossier §G1 — G wins on every conflict)
// ---------------------------------------------------------------------------

const UNDETERMINED_HEAD = (reasons: string[]): CgHead => ({
  cell: "UNDET",
  head: "undetermined",
  term: null,
  holdingMonths: 0,
  act: "ita1961",
  sectionKey: null,
  ratePct: null,
  indexation: false,
  cap10NoIndexation: false,
  exemption: null,
  grandfatherEligible: false,
  reasons,
});

/** Is a lot eligible for the s.55(2)(ac) grandfathered cost at all? */
export function isGrandfatherEligible(acquiredOn: string | null): boolean {
  const iso = normalizeDate(acquiredOn);
  // "acquired before the 1st day of February, 2018" — a lot acquired ON
  // 31-Jan-2018 IS eligible. The predecessor tested `iso < "2018-01-31"` and
  // excluded exactly that day.
  return !!iso && iso < EPOCH_GRANDFATHER;
}

/** Equity (share | equityFund): the short-term cell for a transfer on this date. */
function equityShortTerm(transferIso: string, act: StatuteId): CgHead {
  const base = {
    head: "stcg111A" as CgHeadKind,
    term: "ST" as GainTerm,
    holdingMonths: 12,
    act,
    sectionKey: "stcgEquity" as SectionKey,
    indexation: false,
    cap10NoIndexation: false,
    exemption: null,
    grandfatherEligible: false,
  };
  if (transferIso < EPOCH_STT_START) {
    return {
      ...base,
      cell: "E-ST-SLAB",
      head: "stcgSlab",
      sectionKey: null,
      ratePct: null,
      reasons: [
        `s.111A applies to transfers from ${EPOCH_STT_START}, when Chapter VII (STT) commenced. Before that a short-term gain was taxed at your SLAB rate, which this journal does not know.`,
      ],
    };
  }
  if (transferIso < EPOCH_111A_15) {
    return { ...base, cell: "E-ST10", ratePct: 0.10, reasons: ["s.111A as inserted by the Finance (No. 2) Act, 2004 s.26 — 10%."] };
  }
  if (transferIso < EPOCH_FA2024) {
    return { ...base, cell: "E-ST15", ratePct: 0.15, reasons: ["s.111A at 15%, Finance Act 2008 s.21, for transfers from 1-4-2008."] };
  }
  if (transferIso < EPOCH_ITA2025) {
    return { ...base, cell: "E-ST20", ratePct: 0.20, reasons: ["s.111A at 20%, Finance (No. 2) Act 2024, for transfers from 23-7-2024."] };
  }
  return { ...base, cell: "E-ST196", ratePct: 0.20, reasons: ["s.196 of the Income-tax Act, 2025 — 20%, in force 1-4-2026."] };
}

/** Equity (share | equityFund): the long-term cell for a transfer on this date. */
function equityLongTerm(assetClass: CgAssetClass, transferIso: string, acquiredOn: string | null, act: StatuteId): CgHead {
  const base = {
    term: "LT" as GainTerm,
    holdingMonths: 12,
    act,
    indexation: false,
    cap10NoIndexation: false,
  };
  if (transferIso < EPOCH_STT_START) {
    return {
      ...base,
      cell: "E-LT112",
      head: "ltcg112",
      sectionKey: "ltcgOther",
      ratePct: null,
      exemption: null,
      grandfatherEligible: false,
      indexation: true,
      cap10NoIndexation: true,
      reasons: [
        "Before 1-10-2004 a long-term listed-equity gain fell under S.112, on an INDEXED cost.",
        CII_MISSING,
      ],
    };
  }
  if (transferIso < EPOCH_112A) {
    // s.10(38): exempt. The FA 2017 proviso (acquisition-side STT) narrowed this
    // for SHARES acquired on/after 1-10-2004 and transferred from 1-4-2017 — the
    // notified exceptions are NOT in the primary-source folder, so a share in
    // that final year gets NO head rather than a guessed one.
    if (assetClass === "share" && transferIso >= EPOCH_FA2017_PROVISO) {
      return UNDETERMINED_HEAD([
        "FY 2017-18: the Finance Act 2017 proviso to S.10(38) denies the exemption where STT was not paid on ACQUISITION, subject to notified exceptions (Notification 60/2018).",
        "That proviso and its notified exceptions are NOT in this release's primary-source set, so the head is left BLANK rather than guessed. An equity-oriented FUND unit is unaffected — the proviso reads on shares only.",
      ]);
    }
    return {
      ...base,
      cell: "E-EX1038",
      head: "ltcgExempt1038",
      sectionKey: "ltcgExempt1038",
      ratePct: 0,
      exemption: null,
      grandfatherEligible: false,
      reasons: ["S.10(38): a long-term STT-paid equity gain was EXEMPT for transfers up to 31-3-2018."],
    };
  }
  const grandfatherEligible = isGrandfatherEligible(acquiredOn);
  const gfReason = grandfatherEligible
    ? ["Acquired before 1-2-2018 — the S.55(2)(ac) grandfathered cost (higher of actual cost and the lower of 31-Jan-2018 FMV and sale value) applies if an FMV is on record."]
    : [];
  if (transferIso < EPOCH_FA2024) {
    return {
      ...base,
      cell: "E-LT10",
      head: "ltcg112A",
      sectionKey: "ltcgEquity",
      ratePct: 0.10,
      exemption: 100000,
      grandfatherEligible,
      reasons: ["S.112A at 10% above the ₹1,00,000 annual threshold, Finance Act 2018.", ...gfReason],
    };
  }
  if (transferIso < EPOCH_ITA2025) {
    return {
      ...base,
      cell: "E-LT125",
      head: "ltcg112A",
      sectionKey: "ltcgEquity",
      ratePct: 0.125,
      exemption: 125000,
      grandfatherEligible,
      reasons: ["S.112A at 12.5% above the ₹1,25,000 annual threshold, Finance (No. 2) Act 2024.", ...gfReason],
    };
  }
  return {
    ...base,
    cell: "E-LT198",
    head: "ltcg112A",
    sectionKey: "ltcgEquity",
    ratePct: 0.125,
    exemption: 125000,
    grandfatherEligible,
    reasons: ["s.198 of the Income-tax Act, 2025 — 12.5% above ₹1,25,000, in force 1-4-2026.", ...gfReason],
  };
}

const CII_MISSING =
  "NO COST INFLATION INDEX is bundled with this release, so the indexed cost, the indexed gain and the tax on this cell are BLANK. Missing input: the CBDT cost-inflation-index notification for the acquisition and transfer years.";

/**
 * Is this unit a Specified Mutual Fund under s.50AA for a transfer on this date?
 * Only a unit ACQUIRED on/after 1-4-2023 can be one.
 *   • to 31-3-2025 — "not more than 35% of total proceeds invested in the equity
 *     shares of domestic companies": a debt/liquid unit AND a gold/silver/
 *     international unit both qualify.
 *   • from 1-4-2025 — "more than 65% in debt and money-market instruments":
 *     only the debt/liquid unit still does.
 * `itact1961-s50AA-consolidated-incometaxindia-capture-2026-09-15.html`,
 * `egazette-244830-finance-act-2023.pdf`.
 */
function isSpecifiedMutualFund(assetClass: CgAssetClass, acquiredIso: string | null, transferIso: string): boolean {
  if (!acquiredIso || acquiredIso < EPOCH_50AA) return false;
  if (assetClass === "debtUnit") return true;
  return assetClass === "otherUnit" && transferIso < EPOCH_SMF_REDEFINED;
}

/** A listed non-equity-oriented unit. */
function unitHead(assetClass: CgAssetClass, acquiredIso: string | null, transferIso: string, act: StatuteId): CgHead {
  const months = holdingMonthsFor(assetClass, transferIso);

  if (isSpecifiedMutualFund(assetClass, acquiredIso, transferIso)) {
    return {
      cell: "O-SMF",
      head: "stcgDeemedSmf",
      term: "ST",
      holdingMonths: months,
      act,
      sectionKey: "stcgDeemedSmf",
      ratePct: null,
      indexation: false,
      cap10NoIndexation: false,
      exemption: null,
      grandfatherEligible: false,
      reasons: [
        "S.50AA DEEMS the gain on a Specified Mutual Fund unit acquired on or after 1-4-2023 to be SHORT-TERM however long it was held.",
        "It is taxed at your SLAB rate, which this journal does not know — the amount is stated, the tax is blank.",
      ],
    };
  }

  const isLt = heldMoreThanMonths(acquiredIso, transferIso, months);
  if (!isLt) {
    return {
      cell: "O-ST",
      head: "stcgSlab",
      term: "ST",
      holdingMonths: months,
      act,
      sectionKey: null,
      ratePct: null,
      indexation: false,
      cap10NoIndexation: false,
      exemption: null,
      grandfatherEligible: false,
      reasons: [
        `A non-equity-oriented unit held ${months} calendar months or less is SHORT-TERM and taxed at your SLAB rate, which this journal does not know.`,
        "S.111A does not reach it — no STT is charged on a non-equity-oriented unit, so the concessional rate never applies.",
      ],
    };
  }

  const base = {
    head: "ltcg112" as CgHeadKind,
    term: "LT" as GainTerm,
    holdingMonths: months,
    act,
    sectionKey: "ltcgOther" as SectionKey,
    exemption: null,
    grandfatherEligible: false,
  };
  if (transferIso < EPOCH_FA2024) {
    return {
      ...base,
      cell: "O-LT-a",
      ratePct: null,
      indexation: true,
      cap10NoIndexation: true,
      reasons: [
        "S.112 on an INDEXED cost of acquisition.",
        CII_MISSING,
        "The rate for this cell is not in this release's primary-source set either — it is left BLANK rather than assumed.",
      ],
    };
  }
  if (transferIso < EPOCH_ITA2025) {
    return {
      ...base,
      cell: "O-LT-b",
      ratePct: 0.125,
      indexation: false,
      cap10NoIndexation: false,
      reasons: ["S.112 at 12.5% WITHOUT indexation for transfers from 23-7-2024, Finance (No. 2) Act 2024."],
    };
  }
  return {
    ...base,
    cell: "O-LT-c",
    ratePct: null,
    indexation: false,
    cap10NoIndexation: false,
    reasons: [
      "s.197 of the Income-tax Act, 2025 governs this transfer.",
      "No rate for s.197 is in this release's primary-source set — it is left BLANK rather than carried over from the repealed Act.",
    ],
  };
}

/**
 * THE resolver. Every head, term, rate, exemption and citation in the app comes
 * from here — `capital-gains.ts`, `tax.ts`, `itr.ts`, `monthly.ts`,
 * `itr-schedule.ts`, `tax-itr.ts` and the four report pages all read the answer.
 */
export function resolveCgHead(input: CgHeadInput): CgHead {
  const acquiredIso = normalizeDate(input.acquiredOn);
  const transferIso = normalizeDate(input.transferredOn);

  if (input.assetClass === "undetermined") {
    return UNDETERMINED_HEAD([
      "This journal cannot tell what kind of asset was transferred, so it states NO head and NO tax rather than guessing one.",
      "A bare BSE scrip code with no ISIN, or an ETF/fund ISIN the bundled NSE list does not carry — set the symbol or the ISIN on the trade and the head resolves.",
    ]);
  }
  if (!transferIso) {
    return UNDETERMINED_HEAD([
      "No transfer (sell) date is recorded, and every rate, holding period and exemption in the Act is keyed to it.",
      "Record the sell date on this trade and the head resolves.",
    ]);
  }

  const act = statuteForDate(transferIso).id;

  if (input.assetClass === "share" || input.assetClass === "equityFund") {
    const lt = heldMoreThanMonths(acquiredIso, transferIso, 12);
    const head = lt
      ? equityLongTerm(input.assetClass, transferIso, acquiredIso, act)
      : equityShortTerm(transferIso, act);
    if (!acquiredIso && head.term === "ST") {
      return {
        ...head,
        reasons: [
          ...head.reasons,
          "No acquisition date is recorded, so the 12-month line cannot be tested — SHORT-term is the conservative answer, not a measured one.",
        ],
      };
    }
    return head;
  }

  return unitHead(input.assetClass, acquiredIso, transferIso, act);
}

/** The bucket a head belongs to in every per-FY shape in this app. */
export type CgBucketKey = "stcg111A" | "stcgOther" | "ltcg112A" | "ltcg112" | "cgUndetermined";

/**
 * Which per-FY bucket a head lands in.
 *
 * `stcgOther` gathers the two SLAB-rate short-term heads (s.50AA-deemed and
 * ordinary slab): they are the same line on the return and the same reason the
 * year's tax total is blank.
 * An exempt s.10(38) gain is NOT a taxable bucket — it is reported and taxed at
 * nothing, so it rides in `ltcg112A` with a zero rate and no exemption, which is
 * where the return also puts it.
 */
export function bucketFor(head: CgHeadKind): CgBucketKey {
  switch (head) {
    case "stcg111A":
      return "stcg111A";
    case "stcgSlab":
    case "stcgDeemedSmf":
      return "stcgOther";
    case "ltcg112A":
    case "ltcgExempt1038":
      return "ltcg112A";
    case "ltcg112":
      return "ltcg112";
    default:
      return "cgUndetermined";
  }
}
