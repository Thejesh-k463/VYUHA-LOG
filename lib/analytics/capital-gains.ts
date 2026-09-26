// IND-1 + IND-2 — dual capital-gains regime by date + speculative/non-speculative
// set-off & carry-forward (PURE, no DB/React). INFORMATIONAL ONLY, not filing
// advice — consult a qualified CA before filing.
//
// IND-1 — rates changed on 23-Jul-2024: STCG 15%→20%, LTCG 10%→12.5%, LTCG
// exemption ₹1L→₹1.25L. Every trade must use the rate in force on ITS sell date,
// not today's rate — a journal spanning the cutover needs both.
// Grandfathering: for equity acquired before 31-Jan-2018, LTCG cost of
// acquisition = higher of (actual cost, lower of [FMV @ 31-Jan-2018, sell price]).
// No historical FMV database exists offline — callers may pass a per-lot FMV;
// omitting it correctly falls back to actual cost (no grandfathering applied).
//
// IND-2 — set-off rules (sections 70/71 same-year; 72-74 carry-forward):
//   • STCL → STCG then LTCG (same year or carried forward, 8 years).
//   • LTCL → LTCG only (same year or carried forward, 8 years).
//   • Speculative business loss (equity intraday) → ONLY speculative business
//     income, this year or carried forward up to 4 years. Never against
//     non-speculative business, capital gains, or salary.
//   • Non-speculative business loss (F&O) → in the SAME year, settable against
//     any head except salary (including capital gains). Once carried forward
//     (up to 8 years), the inter-head flexibility is gone — future years only
//     against business income (speculative or non-speculative).

import { normalizeDate } from "@/lib/domain/trading-day";
import {
  EPOCH_FA2024,
  EPOCH_GRANDFATHER,
  bucketFor,
  classifyTerm,
  isGrandfatherEligible,
  resolveCgHead,
  type CgAssetClass,
  type CgBucketKey,
  type CgHead,
  type GainTerm,
} from "./cg-heads";

export type { GainTerm, CgAssetClass, CgHead, CgBucketKey };
// The holding-period rule and the grandfathering epoch have ONE home from
// v4.5.0 — `lib/analytics/cg-heads.ts`. Re-exported here because four modules
// and two pages already import them from this file; the copies in `tax.ts`,
// `itr.ts` and `monthly.ts` are deleted, not adjusted.
export { classifyTerm, isGrandfatherEligible };

export type LossBucket = "speculative" | "nonSpeculative" | "stcl" | "ltcl";

const r2 = (n: number) => Math.round(n * 100) / 100;
const rupee = (n: number) => Math.round(n);

// ---------------------------------------------------------------------------
// IND-1 — rate schedule
// ---------------------------------------------------------------------------

/** Kept for the two call sites that label a straddling FY. The rate SCHEDULE is
 *  no longer a two-way split on it — see `capitalGainsRatesFor`. */
export const RATE_CUTOVER_DATE = EPOCH_FA2024;
/** "acquired before the 1st day of February, 2018" — s.55(2)(ac). This was
 *  `"2018-01-31"` and the comparison was `<`, which excluded a lot acquired ON
 *  31-Jan-2018 that the statute includes. */
export const GRANDFATHER_DATE = EPOCH_GRANDFATHER;

export interface CapitalGainsRates {
  stcgPct: number;
  ltcgPct: number;
  ltcgExemption: number;
  /** The short-term rate is not a number this release can state (slab, or not in
   *  the primary-source set). `stcgPct` is 0 and must be PRINTED BLANK. */
  stcgBlank: boolean;
  /** Likewise for the long-term rate. Note it is FALSE for 1-10-2004..31-3-2018,
   *  where 0 is the right answer: the gain was exempt under S.10(38). */
  ltcgBlank: boolean;
}

/** A date far enough before `iso` that any 12-month test is satisfied. */
const threeYearsBefore = (iso: string) => `${Number(iso.slice(0, 4)) - 3}-01-01`;

/**
 * The EQUITY (s.111A / s.112A) rate schedule in force on a given transfer date.
 *
 * P4 (v4.5.0): this held exactly two schedules split at 23-Jul-2024, so a sale
 * in 2007 — three months before s.111A was raised to 15%, and eleven years
 * before s.112A existed at all — was taxed at 15% short / 10% long. It now
 * reads the SAME band table every head reads (`lib/analytics/cg-heads.ts`), so
 * the rate a report prints and the rate a head cites cannot diverge.
 *
 * Where a band has no rate this release can cite, the number is 0 and the
 * matching `…Blank` flag is true: callers must print blank, never ₹0 of tax
 * (invariant 6). Returns the schedule for a SHARE — a non-equity-oriented unit
 * has no schedule of its own here and must go through `resolveCgHead`.
 */
export function capitalGainsRatesFor(sellDate: string): CapitalGainsRates {
  // Read the calendar first (2M): a legacy day-first value compared character by
  // character picked the PRE-cutover schedule for a 2026 sale.
  const iso = normalizeDate(sellDate) ?? sellDate;
  const st = resolveCgHead({ assetClass: "share", acquiredOn: iso, transferredOn: iso });
  const lt = resolveCgHead({ assetClass: "share", acquiredOn: threeYearsBefore(iso), transferredOn: iso });
  return {
    stcgPct: st.ratePct ?? 0,
    ltcgPct: lt.ratePct ?? 0,
    ltcgExemption: lt.exemption ?? 0,
    stcgBlank: st.ratePct == null,
    ltcgBlank: lt.ratePct == null,
  };
}

/**
 * Grandfathered cost of acquisition for a pre-31-Jan-2018 LTCG lot.
 * @param actualCost total actual cost (avg buy price × qty, or per-unit — caller's choice, consistent units)
 * @param fmv31Jan2018 fair market value on 31-Jan-2018, same units as actualCost/sellValue — null if unknown
 * @param sellValue    sale value, same units
 */
export function grandfatheredCost(actualCost: number, fmv31Jan2018: number | null, sellValue: number): number {
  if (fmv31Jan2018 == null || fmv31Jan2018 <= 0) return actualCost; // no FMV on record — no adjustment
  const cappedFmv = Math.min(fmv31Jan2018, sellValue);
  return Math.max(actualCost, cappedFmv);
}

/**
 * THE one conversion of the stored FMV into what `grandfatheredCost` reads.
 * `trades.fmv31Jan2018` is PER SHARE (a level, invariant 1); `buyValue` and
 * `sellValue` are TOTALS, so a consumer multiplies by the row's `buyQty` — which
 * on a split realised row is the tranche quantity — exactly ONCE, here. The ITR
 * pack passed the per-share figure raw until the v4.6.0 fix wave (finding MO-3)
 * and overstated a grandfathered LTCG by the whole FMV uplift.
 */
export function fmvTotalOf(t: { fmv31Jan2018?: number | null; buyQty: number }): number | null {
  return t.fmv31Jan2018 != null && t.buyQty > 0 ? t.fmv31Jan2018 * t.buyQty : null;
}

// ---------------------------------------------------------------------------
// Per-trade classification
// ---------------------------------------------------------------------------

export interface CapitalGainsTrade {
  segment: string; // eq_delivery | eq_mtf | eq_intraday | index_option | stock_option | ... | future
  /**
   * WHAT was transferred. REQUIRED, and deliberately not defaulted: a default of
   * `"share"` silently recreates the v4.4 bug in any caller that forgets it, and
   * every gold/debt ETF in the book would be taxed at 111A/112A again. Build it
   * with `assetClassFor()` (lib/analytics/cg-heads.ts), never a literal.
   */
  assetClass: CgAssetClass;
  buyDate: string | null;
  sellDate: string | null;
  /** The date that files this row in an FY — REQUIRED, never defaulted: `fyDateOf(t)`
   *  (lib/analytics/tax.ts), the CLOSING leg's day. See `TaxTrade.fyDate`. */
  fyDate: string | null;
  buyValue: number; // actual cost (pre-charge)
  sellValue: number; // pre-charge
  netPnl: number; // post-charge P&L — matches taxByFy's bucketing convention; used for all buckets
  fmv31Jan2018?: number | null; // optional grandfathering input for equity delivery/MTF lots
  /** STT/CTT on this trade. Added BACK in the capital-gains buckets only — the
   *  proviso to S.48 (s.72(3)(b)) excludes it from cost and from transfer
   *  expenditure. It stays a deductible expense for the two BUSINESS heads. */
  sttCtt?: number;
  /** MTF interest. Added BACK in the capital-gains buckets only: no court has
   *  held it to be expenditure "wholly and exclusively in connection with the
   *  transfer", and the High Courts are split on whether it is cost of
   *  acquisition (dossier §G2). */
  mtfInterest?: number;
  /** Pledge / unpledge charges. Same treatment and the same reason. */
  pledgeCharges?: number;
}

export type CgClassifiedBucket = CgBucketKey | "speculative" | "nonSpeculative";

export interface ClassifiedGain {
  bucket: CgClassifiedBucket;
  /** The resolved head for a capital-gains row; null for the two business heads. */
  head: CgHead | null;
  /** Grandfathering-adjusted, add-back-adjusted gain for a capital-gains bucket;
   *  plain netPnl for the business heads. */
  taxableGain: number;
  /** ₹ of STT added back into `taxableGain` (capital-gains buckets only). */
  addedBackStt: number;
  /** ₹ of MTF interest + pledge charges added back (capital-gains buckets only). */
  addedBackMtf: number;
}

const NON_SPECULATIVE = new Set(["index_option", "stock_option", "commodity_option", "commodity_future", "future"]);
const DELIVERY = new Set(["eq_delivery", "eq_mtf"]);

/**
 * THE per-trade classification.
 *
 * Three things changed in v4.5.0 and each of them moves money on the CAPITAL
 * GAINS buckets only — no stored column is touched and a trade's own net P&L is
 * unchanged everywhere else in the app:
 *
 *  1. The head comes from `resolveCgHead` (asset class × transfer date), not
 *     from the segment. A gold ETF is no longer a 112A gain.
 *  2. STT is ADDED BACK. `netPnl` is net of every charge including STT, but the
 *     proviso to S.48 forbids deducting STT against a capital gain. It remains
 *     deductible for the speculative and F&O heads, which is why the add-back is
 *     inside the capital-gains branch only.
 *  3. MTF INTEREST and PLEDGE CHARGES are added back for the same kind of
 *     reason: they are financing costs, not transfer expenditure.
 */
export function classifyGain(t: CapitalGainsTrade): ClassifiedGain | null {
  if (DELIVERY.has(t.segment)) {
    const head = resolveCgHead({ assetClass: t.assetClass, acquiredOn: t.buyDate, transferredOn: t.sellDate });
    // Grandfathering only raises the cost basis (never lowers it), so subtract
    // the resulting cost delta straight from the net (post-charge) P&L to keep
    // charges netted.
    const cost = head.grandfatherEligible
      ? grandfatheredCost(t.buyValue, t.fmv31Jan2018 ?? null, t.sellValue)
      : t.buyValue;
    const addedBackStt = r2(Math.max(0, t.sttCtt ?? 0));
    const addedBackMtf = r2(Math.max(0, t.mtfInterest ?? 0) + Math.max(0, t.pledgeCharges ?? 0));
    return {
      bucket: bucketFor(head.head),
      head,
      taxableGain: r2(t.netPnl - (cost - t.buyValue) + addedBackStt + addedBackMtf),
      addedBackStt,
      addedBackMtf,
    };
  }
  if (t.segment === "eq_intraday")
    return { bucket: "speculative", head: null, taxableGain: r2(t.netPnl), addedBackStt: 0, addedBackMtf: 0 };
  if (NON_SPECULATIVE.has(t.segment))
    return { bucket: "nonSpeculative", head: null, taxableGain: r2(t.netPnl), addedBackStt: 0, addedBackMtf: 0 };
  return null;
}

/** The sentence that MUST travel with any "not deducted" figure. */
export const MTF_NOT_DEDUCTED_NOTE =
  "MTF interest and pledge/unpledge charges are NOT deducted from these capital-gains figures. No court has held either to be expenditure incurred wholly and exclusively in connection with the transfer, and the High Courts are SPLIT on whether interest on borrowed money forms part of the cost of acquisition — there is no Supreme Court ruling. Your own trade P&L everywhere else in Vyuha is unchanged and still nets them. The figure is a FLOOR: GST charged on those lines is not separable from the trade's single GST total, so that part is still netted.";

/** The sentence that MUST travel with any STT add-back figure. */
export const STT_ADDED_BACK_NOTE =
  "STT is ADDED BACK into the capital-gains figures above: the proviso to S.48 (s.72(3)(b) of the 2025 Act) excludes securities transaction tax from cost and from transfer expenditure. The same rupees ARE an allowable expense for the speculative (intraday) and non-speculative (F&O) heads, which are unchanged.";

/**
 * Aggregate classified trades into per-FY totals with a GAIN-WEIGHTED rate for
 * stcg/ltcg. Necessary because FY2024-25 straddles the 23-Jul-2024 cutover — a
 * single FY-end-based rate would wrongly tax pre-cutover gains at the new
 * (higher) rate. Each trade's tax uses ITS OWN sell-date rate; the FY-level
 * weighted rate lets set-off (which nets in ₹, not %) still produce a single
 * blended rate to apply to whatever net amount survives set-off. Not exact for
 * a straddling FY if set-off consumes a disproportionate share of one
 * sub-period's gains — flagged as an approximation in the UI for FY2024-25.
 */
export function aggregateTradesByFy(
  trades: CapitalGainsTrade[],
  fyStartMonth: number,
  fallbackFy: string,
): FyGrossGains[] {
  interface Acc {
    stcg111A: number; stcgOther: number; ltcg112A: number; ltcg112: number; cgUndetermined: number;
    speculative: number; nonSpeculative: number;
    stcgRateNum: number; stcgRateDen: number; ltcgRateNum: number; ltcgRateDen: number;
    exemption: number; notDeductedMtf: number; sttAddedBack: number; blank: Set<string>;
  }
  const empty = (): Acc => ({
    stcg111A: 0, stcgOther: 0, ltcg112A: 0, ltcg112: 0, cgUndetermined: 0,
    speculative: 0, nonSpeculative: 0,
    stcgRateNum: 0, stcgRateDen: 0, ltcgRateNum: 0, ltcgRateDen: 0,
    exemption: 0, notDeductedMtf: 0, sttAddedBack: 0, blank: new Set<string>(),
  });
  const map = new Map<string, Acc>();
  for (const t of trades) {
    const g = classifyGain(t);
    if (!g) continue;
    const fy = fyOf(t.fyDate, fyStartMonth, fallbackFy);
    const row = map.get(fy) ?? empty();
    if (g.bucket === "speculative") row.speculative += g.taxableGain;
    else if (g.bucket === "nonSpeculative") row.nonSpeculative += g.taxableGain;
    else {
      row[g.bucket] += g.taxableGain;
      row.notDeductedMtf += g.addedBackMtf;
      row.sttAddedBack += g.addedBackStt;
      const head = g.head;
      if (head) {
        if (head.exemption != null) row.exemption = Math.max(row.exemption, head.exemption);
        // Weight ONLY the rows that carry a rate: a slab row has no rate to
        // average in, and averaging it in as 0 would understate the whole year.
        if (head.ratePct != null) {
          if (head.term === "LT") { row.ltcgRateNum += g.taxableGain * head.ratePct; row.ltcgRateDen += g.taxableGain; }
          else { row.stcgRateNum += g.taxableGain * head.ratePct; row.stcgRateDen += g.taxableGain; }
        } else {
          // ONE blank rate blanks the YEAR's tax total — never a partial total
          // that reads as complete (invariant 6, owner answer T3).
          for (const r of head.reasons) row.blank.add(r);
        }
      }
    }
    map.set(fy, row);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([fy, r]) => {
      const fallbackRates = capitalGainsRatesFor(fallbackDateForFy(fy));
      return {
        fy,
        stcg111A: r2(r.stcg111A),
        stcgOther: r2(r.stcgOther),
        ltcg112A: r2(r.ltcg112A),
        ltcg112: r2(r.ltcg112),
        cgUndetermined: r2(r.cgUndetermined),
        speculative: r2(r.speculative),
        nonSpeculative: r2(r.nonSpeculative),
        // Gain-weighted average rate over the rows that HAVE a rate; falls back
        // to the FY's own end-of-year schedule when none does (e.g. a loss FY).
        stcgRate: r.stcgRateDen !== 0 ? r.stcgRateNum / r.stcgRateDen : fallbackRates.stcgPct,
        ltcgRate: r.ltcgRateDen !== 0 ? r.ltcgRateNum / r.ltcgRateDen : fallbackRates.ltcgPct,
        ltcgExemption: r.exemption || fallbackRates.ltcgExemption,
        notDeductedMtf: r2(r.notDeductedMtf),
        sttAddedBack: r2(r.sttAddedBack),
        blankReasons: [...r.blank],
      };
    });
}

function fyOf(dateStr: string | null, fyStartMonth: number, fallback: string): string {
  const iso = normalizeDate(dateStr); // 2M: a day-first value made `new Date` invalid → "NaN-aN"
  if (!iso) return fallback;
  const d = new Date(iso + "T00:00:00");
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const start = m >= fyStartMonth ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** A representative date near the end of an FY, for rate lookups when no trade date applies. */
function fallbackDateForFy(fy: string): string {
  return `${fyYearStart(fy) + 1}-03-31`;
}

// ---------------------------------------------------------------------------
// IND-2 — same-FY set-off + carry-forward across FYs
// ---------------------------------------------------------------------------

export interface FyGrossGains {
  fy: string;
  // v4.5.0 — `stcg` and `ltcg` are GONE from this shape on purpose. One "STCG"
  // number merged a 111A gain (a flat concessional rate) with a slab-rate gain
  // and an s.50AA-deemed gain, and one "LTCG" merged a 112A gain with an s.112
  // gain that needs an indexed cost this release cannot compute. Removing them
  // makes every consumer fail to COMPILE until it says which it meant.
  /** s.111A / s.196 — concessional-rate short-term. May be negative. */
  stcg111A: number;
  /** Slab-rate short-term: an ordinary unit and every s.50AA-deemed gain. */
  stcgOther: number;
  /** s.112A / s.198 — including the exempt S.10(38) years, at a zero rate. */
  ltcg112A: number;
  /** s.112 / s.197 — a non-equity-oriented unit. */
  ltcg112: number;
  /** Gains whose head this journal cannot determine. Never merged into a total. */
  cgUndetermined: number;
  speculative: number; // may be negative
  nonSpeculative: number; // may be negative
  /** ₹ of MTF interest + pledge charges added back into the buckets above. */
  notDeductedMtf: number;
  /** ₹ of STT added back into the buckets above (proviso to S.48). */
  sttAddedBack: number;
  /** Why this FY can state NO capital-gains tax total. Empty ⇒ a total is stated. */
  blankReasons: string[];
  // Gain-weighted average rate for this FY (handles a straddling FY like 2024-25
  // correctly — each trade already used its own date-based rate before weighting).
  stcgRate: number;
  ltcgRate: number;
  ltcgExemption: number;
}

/** One unabsorbed-loss vintage still available to set off in later years. */
export interface CarryForwardLot {
  bucket: LossBucket;
  fyIncurred: string;
  amount: number; // positive magnitude remaining
}

export interface FySetOffResult {
  fy: string;
  rates: CapitalGainsRates;
  /** The per-bucket gross figures this result was computed from — the page still
   *  shows every bucket even when the YEAR's total is blank (owner answer T3). */
  gross: FyGrossGains;
  // Taxable amount per bucket AFTER same-year set-off and brought-forward absorption.
  taxableStcg: number;
  taxableLtcg: number;
  taxableSpeculative: number; // business income, taxed at slab rate — no rate applied here
  taxableNonSpeculative: number; // business income, taxed at slab rate — no rate applied here
  /**
   * STCG + LTCG(after exemption) tax only — business income is slab-rate, not
   * computed here. **null** whenever the year holds a slab-rate bucket, an
   * undetermined head, or an s.112 cell whose indexed figure this release cannot
   * compute: the per-bucket AMOUNTS still show, but a total would be a figure the
   * app has not derived (invariant 6). `taxDueBlankReasons` names every input.
   */
  taxDue: number | null;
  /** Why `taxDue` is null. Empty when it is a number. */
  taxDueBlankReasons: string[];
  newCarryForward: CarryForwardLot[]; // losses generated (or still unabsorbed) this FY, to carry out
  usedCarryForward: { bucket: LossBucket; fyIncurred: string; amount: number }[]; // brought-forward lots consumed this FY
}

const CARRY_WINDOW: Record<LossBucket, number> = { speculative: 4, nonSpeculative: 8, stcl: 8, ltcl: 8 };

function fyYearStart(fy: string): number {
  return Number(fy.slice(0, 4));
}

/** Drop lots whose carry-forward window has expired by the given FY. */
function pruneExpired(lots: CarryForwardLot[], asOfFy: string): CarryForwardLot[] {
  const asOfYear = fyYearStart(asOfFy);
  return lots.filter((l) => asOfYear - fyYearStart(l.fyIncurred) <= CARRY_WINDOW[l.bucket]);
}

/**
 * The LAST FY in which a loss vintage can still be set off — it expires AFTER
 * this FY. Mirrors pruneExpired exactly (a lot survives while
 * fyStart(asOf) − fyStart(incurred) <= window), so the two can never disagree;
 * tests/loss-ledger.test.ts pins the agreement in both directions.
 */
export function lossExpiryFy(bucket: LossBucket, fyIncurred: string): string {
  const y = fyYearStart(fyIncurred) + CARRY_WINDOW[bucket];
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/**
 * Process one FY: same-year intra/inter-head set-off per sections 70/71, then
 * absorb still-available brought-forward losses (oldest vintage first, since it
 * expires soonest), then emit whatever remains as new carry-forward lots.
 */
export function computeFySetOff(
  gross: FyGrossGains,
  broughtForward: CarryForwardLot[],
): FySetOffResult {
  // Gain-weighted rates from the FY aggregation (correct for a straddling FY —
  // see aggregateTradesByFy). Exemption is the single FY-level annual threshold.
  const fallback = capitalGainsRatesFor(`${fyYearStart(gross.fy) + 1}-03-31`);
  const rates: CapitalGainsRates = {
    stcgPct: gross.stcgRate,
    ltcgPct: gross.ltcgRate,
    ltcgExemption: gross.ltcgExemption,
    stcgBlank: fallback.stcgBlank,
    ltcgBlank: fallback.ltcgBlank,
  };
  // Clone every lot before absorb() mutates .amount — broughtForward's elements may be
  // the SAME object references stored in a previous FY's returned newCarryForward (via
  // computeTaxTimeline's carry-forward chaining), so mutating in place would silently
  // corrupt an already-returned prior result.
  const bf = pruneExpired(broughtForward, gross.fy).map((l) => ({ ...l })).sort((a, b) => a.fyIncurred.localeCompare(b.fyIncurred));
  const usedCarryForward: FySetOffResult["usedCarryForward"] = [];

  // ---- Same-year set-off (sections 70/71) ----
  // STCL → STCG then LTCG. LTCL → LTCG only. These interact, so compute together.
  // The SET-OFF itself runs on aggregate short-term and long-term capital gains,
  // because that is what sections 70/71 do: a short-term capital LOSS meets any
  // short-term capital gain, concessional or slab. What is UNVERIFIED — and what
  // the owner ruled (T3, 2026-09-22) must therefore produce NO total — is the
  // ORDER in which a loss is allotted BETWEEN the 111A and slab buckets, which
  // changes the tax but never the taxable amount. ITR-2 Schedule CG validation
  // rule 164 settles it and has not been read; the gap is in DECISIONS.
  // `cgUndetermined` is deliberately OUTSIDE both totals: a gain whose head is
  // unknown cannot be known to be short- or long-term either.
  let stcg = r2(gross.stcg111A + gross.stcgOther);
  let ltcg = r2(gross.ltcg112A + gross.ltcg112);
  if (stcg < 0) {
    const stcl = -stcg;
    const vsLtcg = Math.min(stcl, Math.max(0, ltcg));
    ltcg -= vsLtcg;
    stcg = -(stcl - vsLtcg); // remaining STCL (still negative) carries forward as "stcl"
  }
  if (ltcg < 0) {
    // A net LTCL can't touch STCG (already resolved above) — just carries forward as "ltcl".
    // (stcg here is either >=0 already, or a remaining STCL note above.)
  }

  // Speculative: strictly isolated — a same-year loss here can ONLY be reduced by
  // brought-forward speculative losses being used against a same-year GAIN (i.e. if
  // gross.speculative is a gain, absorb brought-forward speculative losses into it).
  let speculative = gross.speculative;

  // Non-speculative (F&O): same-year loss may offset ANY other same-year gain
  // (except salary, not modelled here) — apply against STCG, then LTCG, then
  // speculative gain, in that order, before anything is carried forward.
  let nonSpeculative = gross.nonSpeculative;
  if (nonSpeculative < 0) {
    let loss = -nonSpeculative;
    const vsStcg = Math.min(loss, Math.max(0, stcg));
    stcg -= vsStcg;
    loss -= vsStcg;
    const vsLtcg = Math.min(loss, Math.max(0, ltcg));
    ltcg -= vsLtcg;
    loss -= vsLtcg;
    const vsSpeculative = Math.min(loss, Math.max(0, speculative));
    speculative -= vsSpeculative;
    loss -= vsSpeculative;
    nonSpeculative = -loss;
  }

  // ---- Absorb brought-forward losses against this year's remaining gains ----
  function absorb(bucket: LossBucket, gain: number): number {
    let remaining = gain;
    for (const lot of bf) {
      if (lot.bucket !== bucket || remaining <= 0 || lot.amount <= 0) continue;
      const use = Math.min(lot.amount, remaining);
      if (use <= 0) continue;
      lot.amount -= use;
      remaining -= use;
      usedCarryForward.push({ bucket, fyIncurred: lot.fyIncurred, amount: rupee(use) });
    }
    return remaining;
  }
  // Order matches how the same-year set-off resolved: stcl b/f -> stcg then ltcg;
  // ltcl b/f -> ltcg only; speculative b/f -> speculative gain ONLY (S.73);
  // nonSpeculative b/f -> any BUSINESS income — non-speculative first, then
  // speculative (S.72(1): a carried-forward business loss meets profits of any
  // business; only the speculative→non-speculative direction is barred).
  if (stcg > 0) stcg = absorb("stcl", stcg);
  if (ltcg > 0) ltcg = absorb("ltcl", ltcg);
  if (ltcg > 0) ltcg = absorb("stcl", ltcg); // remaining b/f STCL can still reach LTCG
  if (speculative > 0) speculative = absorb("speculative", speculative);
  if (nonSpeculative > 0) nonSpeculative = absorb("nonSpeculative", nonSpeculative);
  if (speculative > 0) speculative = absorb("nonSpeculative", speculative);

  // ---- New carry-forward: unabsorbed b/f lots + any new loss generated this FY ----
  const newCarryForward: CarryForwardLot[] = bf.filter((l) => l.amount > 0.5).map((l) => ({ ...l, amount: rupee(l.amount) }));
  if (stcg < 0) newCarryForward.push({ bucket: "stcl", fyIncurred: gross.fy, amount: rupee(-stcg) });
  if (ltcg < 0) newCarryForward.push({ bucket: "ltcl", fyIncurred: gross.fy, amount: rupee(-ltcg) });
  if (speculative < 0) newCarryForward.push({ bucket: "speculative", fyIncurred: gross.fy, amount: rupee(-speculative) });
  if (nonSpeculative < 0) newCarryForward.push({ bucket: "nonSpeculative", fyIncurred: gross.fy, amount: rupee(-nonSpeculative) });

  const taxableStcg = Math.max(0, stcg);
  const taxableLtcgGross = Math.max(0, ltcg);
  const taxableLtcg = Math.max(0, taxableLtcgGross - rates.ltcgExemption);

  // ---- Can this year state a capital-gains TAX total at all? ----
  // `?? []` is a runtime belt over the type's braces: `blankReasons` is
  // REQUIRED on FyGrossGains and tsc enforces it at every call site, but this
  // function is also handed objects built by hand in tests and by
  // `lib/queries/bf-losses.ts`, and a missing array must not throw inside a
  // tax computation.
  const taxDueBlankReasons: string[] = [...(gross.blankReasons ?? [])];
  if (gross.stcgOther !== 0) {
    taxDueBlankReasons.push(
      `FY ${gross.fy} holds ₹${rupee(Math.abs(gross.stcgOther)).toLocaleString("en-IN")} of SLAB-rate short-term capital gain (an ordinary unit, or one deemed short-term by S.50AA). It is taxed at your personal slab rate, which this journal does not know, and the ORDER in which a loss is set off between the slab and S.111A buckets is not settled here — so no capital-gains total is stated for the year. The per-bucket amounts above are complete.`,
    );
  }
  if (gross.cgUndetermined !== 0) {
    taxDueBlankReasons.push(
      `FY ${gross.fy} holds ₹${rupee(Math.abs(gross.cgUndetermined)).toLocaleString("en-IN")} of realised gain whose capital-gains head this journal cannot determine. Fix the symbols or ISINs Data Quality names, and the year computes.`,
    );
  }

  const taxDue = taxDueBlankReasons.length > 0
    ? null
    : rupee(taxableStcg * rates.stcgPct + taxableLtcg * rates.ltcgPct);

  return {
    fy: gross.fy,
    rates,
    gross,
    taxableStcg: rupee(taxableStcg),
    taxableLtcg: rupee(taxableLtcgGross), // pre-exemption, for display; taxDue already nets the exemption
    taxableSpeculative: rupee(Math.max(0, speculative)),
    taxableNonSpeculative: rupee(Math.max(0, nonSpeculative)),
    taxDue,
    taxDueBlankReasons,
    newCarryForward,
    usedCarryForward,
  };
}

/**
 * Chain computeFySetOff across FYs in chronological order, carrying losses forward.
 *
 * @param seed pre-journal loss vintages (e.g. losses incurred before the first
 * journalled FY, entered by hand). They enter the first FY exactly as brought-
 * forward lots: computeFySetOff prunes expired vintages on entry (8y capital/
 * non-spec, 4y speculative — a seed whose window closed before the first FY is
 * never applied) and absorbs the rest oldest-first under the usual set-off
 * rules. Defaults to [] so existing callers are byte-identical.
 */
export function computeTaxTimeline(byFy: FyGrossGains[], seed: CarryForwardLot[] = []): FySetOffResult[] {
  const sorted = [...byFy].sort((a, b) => a.fy.localeCompare(b.fy));
  const results: FySetOffResult[] = [];
  let carry: CarryForwardLot[] = seed;
  for (const fy of sorted) {
    const res = computeFySetOff(fy, carry);
    results.push(res);
    carry = res.newCarryForward;
  }
  return results;
}
