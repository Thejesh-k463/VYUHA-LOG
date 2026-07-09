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
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const rRupee = (n: number) => Math.round(n);

/** Delivery-sell charge estimate for IPO shares (no brokerage; primary acquisition). */
export function ipoSellCharges(sellValue: number, allottedValue: number): number {
  if (sellValue <= 0) return 0;
  const stt = rRupee(0.001 * sellValue); // 0.1% delivery sell
  const exchange = 0.0000297 * sellValue; // NSE equity
  const sebi = 0.000001 * sellValue;
  const stamp = rRupee(0.00015 * allottedValue); // 0.015% buy-side stamp on allotment
  const dp = 15.34; // delivery DP per scrip (incl GST)
  const gst = 0.18 * (exchange + sebi);
  return r2(stt + exchange + sebi + stamp + dp + gst);
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

export function computeIpo(i: IpoInput): IpoComputed {
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

  if (status === "exited" && i.exitPrice != null) {
    grossPnl = r2((i.exitPrice - effectiveCost) * allottedQty);
    charges = ipoSellCharges(i.exitPrice * allottedQty, investedAllotted);
    netPnl = r2(grossPnl - charges);
    realised = true;
    returnPct = investedAllotted > 0 ? r2((netPnl / investedAllotted) * 100) : null;
    tax = ipoTaxEstimate(netPnl, i.allotmentDate ?? i.listingDate ?? i.appliedDate ?? null, i.exitDate ?? null);
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
  };
}

export interface IpoSummary {
  count: number;
  appliedCount: number;
  allottedCount: number;
  notAllottedCount: number;
  listedCount: number;
  exitedCount: number;
  applicationAmount: number;
  investedAllotted: number;
  listingGains: number; // realised+unrealised listing gains across allotted
  realisedNet: number; // exited net
  unrealised: number; // listed (holding) mark-to-listing
  estTax: number; // Σ estimated tax across exited IPOs (informational)
  postTaxNet: number; // realisedNet − estTax
}

export function summariseIpos(list: IpoComputed[]): IpoSummary {
  const s: IpoSummary = {
    count: list.length,
    appliedCount: list.length,
    allottedCount: 0, notAllottedCount: 0, listedCount: 0, exitedCount: 0,
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
      s.realisedNet += i.netPnl;
      if (i.tax) s.estTax += i.tax.estTax;
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
