// Pure IPO P&L analytics. An IPO moves applied → allotted/not → listed → exited.
// Charges apply only on the SELL (delivery sell estimate); the allotment is primary.
//
// Upgraded (IPO v2):
//  • board — mainboard | sme (NSE Emerge / BSE SME). SME shares trade in LOT
//    MULTIPLES even after listing — surfaced as a UI constraint, not enforced here.
//  • category + discountPerShare — employee/shareholder/retail discounts change the
//    COST BASIS: effective cost = appliedPrice − discount (applies at application).
//  • refund — application amount minus allotted value (full refund when not allotted).
//  • tax — STCG/LTCG classification of the exit using the same date-based engine as
//    the capital-gains report (rates changed 23-Jul-2024). Holding period runs from
//    the ALLOTMENT date (fallback: listing date, then applied date). INFORMATIONAL —
//    the LTCG ₹-exemption is an FY-level aggregate, not per-IPO, so it is NOT netted
//    here; the estimate is the bucket rate on this IPO's net gain alone.

import { classifyTerm, capitalGainsRatesFor, type GainTerm } from "@/lib/analytics/capital-gains";
import { computeChargesPaise } from "@/lib/engine/charges";
import { seedRatesMap, statutoryRatesFor, type RatesMap } from "@/lib/engine/rates";
import type { ChargeBreakdown, ChargeRates } from "@/lib/engine/types";
import { todayIstIso } from "@/lib/domain/trading-day";
import { toPaise, toRupees } from "@/lib/money";

export type IpoBoard = "mainboard" | "sme";
export type IpoCategory = "retail" | "shni" | "bhni" | "employee" | "shareholder";

export const IPO_CATEGORY_LABELS: Record<IpoCategory, string> = {
  retail: "Retail",
  shni: "S-HNI (₹2–10L)",
  bhni: "B-HNI (>₹10L)",
  employee: "Employee",
  shareholder: "Shareholder",
};

export interface IpoInput {
  id: number;
  name: string;
  broker: string | null;
  exchange: string;
  board?: IpoBoard | string | null; // default mainboard
  category?: IpoCategory | string | null;
  discountPerShare?: number | null; // ₹/share off the issue price (employee/shareholder/retail)
  appliedPrice: number; // issue / cut-off price BEFORE discount
  lotSize: number;
  lotsApplied: number;
  allotted: boolean;
  allottedQty: number; // shares
  listingPrice: number | null;
  exitPrice: number | null;
  appliedDate?: string | null;
  allotmentDate?: string | null; // acquisition date for the tax holding period
  listingDate?: string | null;
  exitDate?: string | null;
  notes?: string | null;
}

export type IpoStatus = "not_allotted" | "allotted" | "listed" | "exited";

export interface IpoTaxEstimate {
  term: GainTerm; // ST | LT
  ratePct: number; // 15/20 (ST) or 10/12.5 (LT) by exit date
  taxableGain: number; // net P&L (post-charges); 0-floored for tax
  estTax: number; // ratePct × max(0, taxableGain)
  postTaxNet: number; // netPnl − estTax
  acquisitionDate: string | null; // the date the holding period ran from
  isLoss: boolean; // capital loss — set-off/carry-forward applies instead of tax
}

export interface IpoComputed extends IpoInput {
  board: IpoBoard;
  discountPerShare: number;
  status: IpoStatus;
  effectiveCost: number; // appliedPrice − discount (per share, floored at 0)
  applicationAmount: number; // money blocked at apply (effective cost × lot × lots)
  investedAllotted: number; // effectiveCost × allottedQty
  refundAmount: number; // application − invested (once allotment status is known)
  listingGain: number | null; // (listing − effectiveCost) × qty, gross
  grossPnl: number; // realised gross (exited)
  charges: number; // sell charges (exited)
  netPnl: number; // realised net (exited)
  unrealised: number; // holding mark-to-listing (listed, not exited)
  realised: boolean;
  returnPct: number | null;
  tax: IpoTaxEstimate | null; // present only when exited with an allotment
  /**
   * Exited, but the exit date is not a priceable day (`isPriceableExitDate`,
   * N13): no charges, no net, no tax are computed, `realised` is false (so it
   * stays out of realised net, capital and the tax pack) and the UI shows "—".
   */
  unpriced: boolean;
  /** Per-head exit charges when the charger stated them (the server path), else null. */
  chargeBreakdown: ChargeBreakdown | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * How exit charges are computed, injectable by the caller.
 *
 * This module is PURE (invariant 2) and so cannot read `charge_config` itself
 * — but invariant 3 says statutory rates live ONLY there. The resolution:
 * the server caller (`lib/queries/ipos.ts`) injects a charger built on the
 * real engine + the IPO's broker's configured rates, and the statutory-row
 * FALLBACK (`ipoSellCharges`) is used only when no broker is recorded on the
 * IPO or the broker has no rates row. A frozen-rate estimate existed first as
 * the ONLY path — which meant every exited
 * IPO's net P&L was computed from rates the user could not edit, and that
 * number flowed into realised-net and capital compounding (defect D4,
 * 2026-08-12).
 *
 * `allottedValue` is the STAMP BASE of the allotment: `computeIpo` passes 0
 * when the allottee owes no stamp (`ipoAllotmentStampBase`, N14). A charger
 * returns the total, or the per-head breakdown (the server path, which the
 * statement label reads), or null when the exit cannot be priced yet (N13).
 */
export type IpoSellCharger = (sellValue: number, allottedValue: number) => number | ChargeBreakdown | null;

/**
 * IPO exit charges over a charge_config row — a thin wrapper over the engine;
 * no rate is written here. The server feeds it the IPO broker's row
 * (`lib/queries/ipos.ts`), or, when the IPO names no broker (or its broker has
 * no row), the STATUTORY columns (`statutoryRatesFor`, R36).
 *
 *  • the SALE is the only exchange trade: STT, exchange txn, IPFT and SEBI on
 *    the sell value, GST over exchange + IPFT + SEBI (+ brokerage and a
 *    GST-bearing DP when the row has them);
 *  • the allotment is not bought on an exchange, so it carries no purchase STT
 *    (FATAX56235 row 1) and no exchange levies (W2-IPO2 for the broker path)
 *    — only stamp duty on `allottedValue`, the stamp base `computeIpo` passes
 *    (0 for an allotment from 1 Jul 2020, when the issuer bears it — N14);
 *  • brokerage and DP come from the row, on the sale: a broker's row carries
 *    them; the statutory row neutralises both (no broker is recorded, and DP
 *    is a broker tariff).
 */
export function ipoSellChargeBreakdown(
  sellValue: number,
  allottedValue: number,
  exitRates: ChargeRates,
): ChargeBreakdown {
  const rates: ChargeRates = { ...exitRates, sttSide: "sell" };
  const sale = computeChargesPaise(
    { segment: "eq_delivery", buyValue: 0, sellValue: toPaise(Math.max(0, sellValue)), buyQty: 0, sellQty: 1, buyOrderCount: 0, sellOrderCount: 1 },
    rates,
  );
  // Only this call's STAMP is read — the allotment's value is its base.
  const allotment = computeChargesPaise(
    { segment: "eq_delivery", buyValue: toPaise(Math.max(0, allottedValue)), sellValue: 0, buyQty: 1, sellQty: 0, buyOrderCount: 0, sellOrderCount: 0 },
    rates,
  );
  const p = {
    brokerage: sale.brokerage,
    sttCtt: sale.sttCtt,
    exchangeTxn: sale.exchangeTxn,
    sebi: sale.sebi,
    stampDuty: allotment.stampDuty,
    ipft: sale.ipft,
    gst: sale.gst,
    dpCharges: sale.dpCharges,
    mtfInterest: 0,
    pledgeCharges: 0,
  };
  const total = Object.values(p).reduce((s, v) => s + v, 0);
  return {
    brokerage: toRupees(p.brokerage),
    sttCtt: toRupees(p.sttCtt),
    exchangeTxn: toRupees(p.exchangeTxn),
    sebi: toRupees(p.sebi),
    stampDuty: toRupees(p.stampDuty),
    ipft: toRupees(p.ipft),
    gst: toRupees(p.gst),
    dpCharges: toRupees(p.dpCharges),
    mtfInterest: 0,
    pledgeCharges: 0,
    total: toRupees(total),
  };
}

/** The fallback's total; 0 when nothing was sold. See `ipoSellChargeBreakdown`. */
export function ipoSellCharges(sellValue: number, allottedValue: number, statutory: ChargeRates): number {
  if (sellValue <= 0) return 0;
  return ipoSellChargeBreakdown(sellValue, allottedValue, statutory).total;
}

/** The venue charge_config prices an IPO at: BSE when stated, else NSE. */
export function ipoVenue(exchange: string): "NSE" | "BSE" {
  return exchange === "BSE" ? "BSE" : "NSE";
}

/**
 * The earliest year an exit date is read as a day at all. BSE, India's first
 * stock exchange, dates from 1875, so no exit on an Indian exchange precedes
 * it; a smaller year is a typo or a date input's half-typed year ('0002-06-15'
 * while "2011" is being typed), not a trade.
 */
const EXIT_YEAR_FLOOR = 1875;

/**
 * Can this exit date be priced (N13)? A real `YYYY-MM-DD` calendar day with a
 * year from `EXIT_YEAR_FLOOR`. Anything else — '15-03-2011', '2026-02-30',
 * '0202-06-15' — leaves the exit NOT YET PRICED: no charges are computed and
 * the UI shows "—" (invariant 6), rather than throwing (which took down every
 * page reading IPOs) or guessing a day.
 */
export function isPriceableExitDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, day] = d.split("-").map(Number);
  if (y < EXIT_YEAR_FLOOR) return false;
  const t = new Date(Date.UTC(y, m - 1, day));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day;
}

/**
 * The date charge_config is read at for an IPO exit priced on `onDate`: that
 * date, unless it precedes EVERY eq_delivery epoch at the venue — then the
 * earliest epoch's start, i.e. the earliest verified schedule (06-ANSWERS
 * C-8 ruling: dates before the earliest verified boundary use the earliest
 * schedule). A gap between epochs is a charge_config defect, not a date, and
 * still throws where the rates are resolved.
 */
export function ipoRatesDate(map: RatesMap, venue: "NSE" | "BSE", onDate: string): string {
  let earliest: string | null = null;
  for (const list of map.values()) {
    for (const r of list) {
      if (r.segment !== "eq_delivery" || r.exchange !== venue) continue;
      const from = r.effectiveFrom ?? "1970-01-01"; // `covers` reads a missing start the same way
      if (earliest == null || from < earliest) earliest = from;
    }
  }
  return earliest != null && onDate < earliest ? earliest : onDate;
}

/**
 * From this day the ISSUER bears the stamp duty on an issue of securities:
 * Indian Stamp Act s.9A(1)(c) (collected by the depository from the issuer on
 * the allotment list), s.29(l) and Sch. I Art. 56A(a), inserted by Act 7 of
 * 2019 w.e.f. 1-7-2020 (India Code; primary sources and sha256 in
 * LIVE-DESK-RESEARCH/_data/stt-primary-sources-2026-09-11/MANIFEST.md). This
 * is who bears the duty, not a rate — the rate stays in charge_config.
 */
export const ISSUER_BEARS_ISSUE_STAMP_FROM = "2020-07-01";

/**
 * The allotment's stamp base for the ALLOTTEE (N14): its value for an
 * allotment before `ISSUER_BEARS_ISSUE_STAMP_FROM` (unchanged), 0 from then.
 * The allotment day is the first readable of allotment → listing → applied
 * date (the tax estimate's chain), then the exit date, then today IST.
 */
export function ipoAllotmentStampBase(i: IpoInput, investedAllotted: number): number {
  const day =
    [i.allotmentDate, i.listingDate, i.appliedDate, i.exitDate].find(
      (d): d is string => typeof d === "string" && isPriceableExitDate(d),
    ) ?? todayIstIso();
  return day < ISSUER_BEARS_ISSUE_STAMP_FROM ? investedAllotted : 0;
}

/**
 * The heads an IPO's exit charges actually carry, for its label (N15):
 * brokerage, STT, exch (exchange txn + SEBI + IPFT), stamp, DP, GST — a head
 * that is 0 for this IPO is not named. Empty with no breakdown.
 */
export function ipoChargeHeads(b: ChargeBreakdown | null): string[] {
  if (!b) return [];
  const heads: [string, number][] = [
    ["brokerage", b.brokerage],
    ["STT", b.sttCtt],
    ["exch", b.exchangeTxn + b.sebi + b.ipft],
    ["stamp", b.stampDuty],
    ["DP", b.dpCharges],
    ["GST", b.gst],
  ];
  return heads.filter(([, v]) => v > 0).map(([k]) => k);
}

let seedMap: RatesMap | null = null;

/**
 * The charger `computeIpo` uses when the caller injects none — the client
 * form's live preview, which has no DB. It prices from the canonical seed's
 * statutory row at (venue, exit date or today IST) through the same fallback,
 * so no rate is frozen in this module. The saved IPO is priced server-side
 * from charge_config (`lib/queries/ipos.ts`), which adds the broker's
 * brokerage and DP — the form labels its figure accordingly (N15). Rates are
 * resolved only when called, and an unpriceable exit date returns null.
 */
function seedFallbackCharger(i: IpoInput): IpoSellCharger {
  return (sellValue, allottedValue) => {
    if (i.exitDate && !isPriceableExitDate(i.exitDate)) return null;
    seedMap ??= seedRatesMap();
    const venue = ipoVenue(i.exchange);
    const stat = statutoryRatesFor(seedMap, "eq_delivery", venue, ipoRatesDate(seedMap, venue, i.exitDate || todayIstIso()));
    return ipoSellCharges(sellValue, allottedValue, stat);
  };
}

/** STCG/LTCG estimate for an exited IPO. Pure; reuses the capital-gains rate engine. */
export function ipoTaxEstimate(
  netPnl: number,
  acquisitionDate: string | null,
  exitDate: string | null,
): IpoTaxEstimate {
  const term = classifyTerm(acquisitionDate ?? null, exitDate ?? null); // no dates → ST (conservative)
  const rates = capitalGainsRatesFor(exitDate ?? "9999-12-31"); // no exit date → current regime
  const rate = term === "ST" ? rates.stcgPct : rates.ltcgPct;
  const taxableGain = Math.max(0, netPnl);
  const estTax = r2(taxableGain * rate);
  return {
    term,
    ratePct: r2(rate * 100),
    taxableGain: r2(taxableGain),
    estTax,
    postTaxNet: r2(netPnl - estTax),
    acquisitionDate: acquisitionDate ?? null,
    isLoss: netPnl < 0,
  };
}

export function computeIpo(i: IpoInput, sellCharger: IpoSellCharger = seedFallbackCharger(i)): IpoComputed {
  const board: IpoBoard = i.board === "sme" ? "sme" : "mainboard";
  const discountPerShare = Math.max(0, i.discountPerShare ?? 0);
  const effectiveCost = Math.max(0, r2(i.appliedPrice - discountPerShare));

  const applicationAmount = r2(effectiveCost * i.lotSize * i.lotsApplied);
  const allottedQty = i.allotted ? i.allottedQty : 0;
  const investedAllotted = r2(effectiveCost * allottedQty);
  const refundAmount = r2(applicationAmount - investedAllotted);

  let status: IpoStatus;
  if (!i.allotted) status = "not_allotted";
  else if (i.exitPrice != null) status = "exited";
  else if (i.listingPrice != null) status = "listed";
  else status = "allotted";

  const listingGain =
    i.allotted && i.listingPrice != null ? r2((i.listingPrice - effectiveCost) * allottedQty) : null;

  let grossPnl = 0, charges = 0, netPnl = 0, unrealised = 0, realised = false, returnPct: number | null = null;
  let tax: IpoTaxEstimate | null = null;
  let unpriced = false;
  let chargeBreakdown: ChargeBreakdown | null = null;

  if (status === "exited" && i.exitPrice != null) {
    grossPnl = r2((i.exitPrice - effectiveCost) * allottedQty);
    // N13: an unreadable exit date is never handed to a charger — not yet priced.
    const priced =
      !i.exitDate || isPriceableExitDate(i.exitDate)
        ? sellCharger(i.exitPrice * allottedQty, ipoAllotmentStampBase(i, investedAllotted))
        : null;
    if (priced == null) {
      unpriced = true;
    } else {
      chargeBreakdown = typeof priced === "number" ? null : priced;
      charges = typeof priced === "number" ? priced : priced.total;
      netPnl = r2(grossPnl - charges);
      realised = true;
      returnPct = investedAllotted > 0 ? r2((netPnl / investedAllotted) * 100) : null;
      tax = ipoTaxEstimate(netPnl, i.allotmentDate ?? i.listingDate ?? i.appliedDate ?? null, i.exitDate ?? null);
    }
  } else if (status === "listed" && i.listingPrice != null) {
    unrealised = r2((i.listingPrice - effectiveCost) * allottedQty);
    returnPct = investedAllotted > 0 ? r2((unrealised / investedAllotted) * 100) : null;
  }

  return {
    ...i,
    board,
    discountPerShare,
    allottedQty,
    status,
    effectiveCost,
    applicationAmount,
    investedAllotted,
    refundAmount,
    listingGain,
    grossPnl,
    charges,
    netPnl,
    unrealised,
    realised,
    returnPct,
    tax,
    unpriced,
    chargeBreakdown,
  };
}

export interface IpoSummary {
  count: number;
  appliedCount: number;
  allottedCount: number;
  notAllottedCount: number;
  listedCount: number;
  exitedCount: number; // by STATUS — every exit, priced or not
  /** Exits realisedNet and estTax are made of (IPO-KPI, v4.3.0). */
  pricedExitCount: number;
  /** Exits whose date cannot be priced (N13): in exitedCount, in no realised figure. */
  unpricedExitCount: number;
  applicationAmount: number;
  investedAllotted: number;
  listingGains: number; // realised+unrealised listing gains across allotted
  realisedNet: number; // net across PRICED exits
  unrealised: number; // listed (holding) mark-to-listing
  estTax: number; // Σ estimated tax across priced exits (informational)
  postTaxNet: number; // realisedNet − estTax
}

export function summariseIpos(list: IpoComputed[]): IpoSummary {
  const s: IpoSummary = {
    count: list.length,
    appliedCount: list.length,
    allottedCount: 0, notAllottedCount: 0, listedCount: 0, exitedCount: 0,
    pricedExitCount: 0, unpricedExitCount: 0,
    applicationAmount: 0, investedAllotted: 0, listingGains: 0, realisedNet: 0, unrealised: 0,
    estTax: 0, postTaxNet: 0,
  };
  for (const i of list) {
    s.applicationAmount += i.applicationAmount;
    s.investedAllotted += i.investedAllotted;
    if (i.listingGain != null) s.listingGains += i.listingGain;
    if (i.status === "not_allotted") s.notAllottedCount++;
    else s.allottedCount++;
    if (i.status === "listed") s.listedCount++;
    if (i.status === "exited") {
      s.exitedCount++;
      // IPO-KPI: an unpriced exit (N13) carries no net and no tax, so it is
      // counted apart — never folded into the realised figures' scope.
      if (i.realised) {
        s.pricedExitCount++;
        s.realisedNet += i.netPnl;
        if (i.tax) s.estTax += i.tax.estTax;
      } else {
        s.unpricedExitCount++;
      }
    }
    if (i.status === "listed") s.unrealised += i.unrealised;
  }
  s.applicationAmount = r2(s.applicationAmount);
  s.investedAllotted = r2(s.investedAllotted);
  s.listingGains = r2(s.listingGains);
  s.realisedNet = r2(s.realisedNet);
  s.unrealised = r2(s.unrealised);
  s.estTax = r2(s.estTax);
  s.postTaxNet = r2(s.realisedNet - s.estTax);
  return s;
}
