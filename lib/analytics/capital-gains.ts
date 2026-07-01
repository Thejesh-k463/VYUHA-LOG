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

export type GainTerm = "ST" | "LT";
export type LossBucket = "speculative" | "nonSpeculative" | "stcl" | "ltcl";

const r2 = (n: number) => Math.round(n * 100) / 100;
const rupee = (n: number) => Math.round(n);

// ---------------------------------------------------------------------------
// IND-1 — rate schedule
// ---------------------------------------------------------------------------

export const RATE_CUTOVER_DATE = "2024-07-23";
export const GRANDFATHER_DATE = "2018-01-31";

export interface CapitalGainsRates {
  stcgPct: number;
  ltcgPct: number;
  ltcgExemption: number;
}

const PRE_CUTOVER: CapitalGainsRates = { stcgPct: 0.15, ltcgPct: 0.10, ltcgExemption: 100000 };
const POST_CUTOVER: CapitalGainsRates = { stcgPct: 0.20, ltcgPct: 0.125, ltcgExemption: 125000 };

/** The rate schedule in force on a given sell date. */
export function capitalGainsRatesFor(sellDate: string): CapitalGainsRates {
  return sellDate >= RATE_CUTOVER_DATE ? POST_CUTOVER : PRE_CUTOVER;
}

/** Long-term = held >= 365 days (the standard 12-month approximation used elsewhere in this app). */
export function classifyTerm(buyDate: string | null, sellDate: string | null): GainTerm {
  if (!buyDate || !sellDate) return "ST";
  const days = (new Date(sellDate + "T00:00:00").getTime() - new Date(buyDate + "T00:00:00").getTime()) / 86400000;
  return days >= 365 ? "LT" : "ST";
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

/** Is this buy date eligible for grandfathering consideration at all? */
export function isGrandfatherEligible(buyDate: string | null): boolean {
  return !!buyDate && buyDate < GRANDFATHER_DATE;
}

// ---------------------------------------------------------------------------
// Per-trade classification into one of the four tax buckets
// ---------------------------------------------------------------------------

export interface CapitalGainsTrade {
  segment: string; // eq_delivery | eq_mtf | eq_intraday | index_option | stock_option | ... | future
  buyDate: string | null;
  sellDate: string | null;
  buyValue: number; // actual cost (pre-charge)
  sellValue: number; // pre-charge
  netPnl: number; // post-charge P&L — matches taxByFy's bucketing convention; used for all buckets
  fmv31Jan2018?: number | null; // optional grandfathering input for equity delivery/MTF lots
}

export interface ClassifiedGain {
  bucket: "stcg" | "ltcg" | "speculative" | "nonSpeculative";
  taxableGain: number; // grandfathering-adjusted net P&L for ltcg; netPnl otherwise
}

const NON_SPECULATIVE = new Set(["index_option", "stock_option", "commodity_option", "commodity_future", "future"]);
const DELIVERY = new Set(["eq_delivery", "eq_mtf"]);

export function classifyGain(t: CapitalGainsTrade): ClassifiedGain | null {
  if (DELIVERY.has(t.segment)) {
    const term = classifyTerm(t.buyDate, t.sellDate);
    if (term === "ST") return { bucket: "stcg", taxableGain: r2(t.netPnl) };
    // LT: apply grandfathering if the lot predates 31-Jan-2018 and an FMV was supplied.
    // Grandfathering only raises the cost basis (never lowers it), so subtract the
    // resulting cost delta straight from the net (post-charge) P&L to keep charges netted.
    const cost = isGrandfatherEligible(t.buyDate)
      ? grandfatheredCost(t.buyValue, t.fmv31Jan2018 ?? null, t.sellValue)
      : t.buyValue;
    return { bucket: "ltcg", taxableGain: r2(t.netPnl - (cost - t.buyValue)) };
  }
  if (t.segment === "eq_intraday") return { bucket: "speculative", taxableGain: r2(t.netPnl) };
  if (NON_SPECULATIVE.has(t.segment)) return { bucket: "nonSpeculative", taxableGain: r2(t.netPnl) };
  return null;
}

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
  const map = new Map<string, { stcg: number; ltcg: number; speculative: number; nonSpeculative: number; stcgRateNum: number; ltcgRateNum: number; exemption: number }>();
  for (const t of trades) {
    const g = classifyGain(t);
    if (!g) continue;
    const fy = fyOf(t.sellDate, fyStartMonth, fallbackFy);
    const row = map.get(fy) ?? { stcg: 0, ltcg: 0, speculative: 0, nonSpeculative: 0, stcgRateNum: 0, ltcgRateNum: 0, exemption: 0 };
    const rates = capitalGainsRatesFor(t.sellDate ?? fallbackDateForFy(fy));
    if (g.bucket === "stcg") { row.stcg += g.taxableGain; row.stcgRateNum += g.taxableGain * rates.stcgPct; }
    else if (g.bucket === "ltcg") { row.ltcg += g.taxableGain; row.ltcgRateNum += g.taxableGain * rates.ltcgPct; row.exemption = rates.ltcgExemption; }
    else if (g.bucket === "speculative") row.speculative += g.taxableGain;
    else if (g.bucket === "nonSpeculative") row.nonSpeculative += g.taxableGain;
    map.set(fy, row);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([fy, r]) => ({
      fy,
      stcg: r2(r.stcg),
      ltcg: r2(r.ltcg),
      speculative: r2(r.speculative),
      nonSpeculative: r2(r.nonSpeculative),
      // Gain-weighted average rate; falls back to the FY's own end-of-year rate
      // schedule when the bucket has no gain to weight by (e.g. a pure loss FY).
      stcgRate: r.stcg !== 0 ? r.stcgRateNum / r.stcg : capitalGainsRatesFor(fallbackDateForFy(fy)).stcgPct,
      ltcgRate: r.ltcg !== 0 ? r.ltcgRateNum / r.ltcg : capitalGainsRatesFor(fallbackDateForFy(fy)).ltcgPct,
      ltcgExemption: r.exemption || capitalGainsRatesFor(fallbackDateForFy(fy)).ltcgExemption,
    }));
}

function fyOf(dateStr: string | null, fyStartMonth: number, fallback: string): string {
  if (!dateStr) return fallback;
  const d = new Date(dateStr + "T00:00:00");
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
  stcg: number; // may be negative (a net STCL for the year)
  ltcg: number; // may be negative (a net LTCL for the year)
  speculative: number; // may be negative
  nonSpeculative: number; // may be negative
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
  // Taxable amount per bucket AFTER same-year set-off and brought-forward absorption.
  taxableStcg: number;
  taxableLtcg: number;
  taxableSpeculative: number; // business income, taxed at slab rate — no rate applied here
  taxableNonSpeculative: number; // business income, taxed at slab rate — no rate applied here
  taxDue: number; // STCG + LTCG(after exemption) tax only — business income is slab-rate, not computed here
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
  const rates: CapitalGainsRates = { stcgPct: gross.stcgRate, ltcgPct: gross.ltcgRate, ltcgExemption: gross.ltcgExemption };
  // Clone every lot before absorb() mutates .amount — broughtForward's elements may be
  // the SAME object references stored in a previous FY's returned newCarryForward (via
  // computeTaxTimeline's carry-forward chaining), so mutating in place would silently
  // corrupt an already-returned prior result.
  const bf = pruneExpired(broughtForward, gross.fy).map((l) => ({ ...l })).sort((a, b) => a.fyIncurred.localeCompare(b.fyIncurred));
  const usedCarryForward: FySetOffResult["usedCarryForward"] = [];

  // ---- Same-year set-off (sections 70/71) ----
  // STCL → STCG then LTCG. LTCL → LTCG only. These interact, so compute together.
  let stcg = gross.stcg;
  let ltcg = gross.ltcg;
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
  // ltcl b/f -> ltcg only; speculative b/f -> speculative gain only;
  // nonSpeculative b/f -> only against non-speculative gain (no inter-head once carried forward).
  if (stcg > 0) stcg = absorb("stcl", stcg);
  if (ltcg > 0) ltcg = absorb("ltcl", ltcg);
  if (ltcg > 0) ltcg = absorb("stcl", ltcg); // remaining b/f STCL can still reach LTCG
  if (speculative > 0) speculative = absorb("speculative", speculative);
  if (nonSpeculative > 0) nonSpeculative = absorb("nonSpeculative", nonSpeculative);

  // ---- New carry-forward: unabsorbed b/f lots + any new loss generated this FY ----
  const newCarryForward: CarryForwardLot[] = bf.filter((l) => l.amount > 0.5).map((l) => ({ ...l, amount: rupee(l.amount) }));
  if (stcg < 0) newCarryForward.push({ bucket: "stcl", fyIncurred: gross.fy, amount: rupee(-stcg) });
  if (ltcg < 0) newCarryForward.push({ bucket: "ltcl", fyIncurred: gross.fy, amount: rupee(-ltcg) });
  if (speculative < 0) newCarryForward.push({ bucket: "speculative", fyIncurred: gross.fy, amount: rupee(-speculative) });
  if (nonSpeculative < 0) newCarryForward.push({ bucket: "nonSpeculative", fyIncurred: gross.fy, amount: rupee(-nonSpeculative) });

  const taxableStcg = Math.max(0, stcg);
  const taxableLtcgGross = Math.max(0, ltcg);
  const taxableLtcg = Math.max(0, taxableLtcgGross - rates.ltcgExemption);
  const taxDue = taxableStcg * rates.stcgPct + taxableLtcg * rates.ltcgPct;

  return {
    fy: gross.fy,
    rates,
    taxableStcg: rupee(taxableStcg),
    taxableLtcg: rupee(taxableLtcgGross), // pre-exemption, for display; taxDue already nets the exemption
    taxableSpeculative: rupee(Math.max(0, speculative)),
    taxableNonSpeculative: rupee(Math.max(0, nonSpeculative)),
    taxDue: rupee(taxDue),
    newCarryForward,
    usedCarryForward,
  };
}

/** Chain computeFySetOff across FYs in chronological order, carrying losses forward. */
export function computeTaxTimeline(byFy: FyGrossGains[]): FySetOffResult[] {
  const sorted = [...byFy].sort((a, b) => a.fy.localeCompare(b.fy));
  const results: FySetOffResult[] = [];
  let carry: CarryForwardLot[] = [];
  for (const fy of sorted) {
    const res = computeFySetOff(fy, carry);
    results.push(res);
    carry = res.newCarryForward;
  }
  return results;
}
