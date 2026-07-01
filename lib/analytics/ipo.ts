// Pure IPO P&L analytics. An IPO moves applied → allotted/not → listed → exited.
// Charges apply only on the SELL (delivery sell estimate); the allotment is primary.

export interface IpoInput {
  id: number;
  name: string;
  broker: string | null;
  exchange: string;
  appliedPrice: number;
  lotSize: number;
  lotsApplied: number;
  allotted: boolean;
  allottedQty: number; // shares
  listingPrice: number | null;
  exitPrice: number | null;
  appliedDate?: string | null;
  listingDate?: string | null;
  exitDate?: string | null;
  notes?: string | null;
}

export type IpoStatus = "not_allotted" | "allotted" | "listed" | "exited";

export interface IpoComputed extends IpoInput {
  status: IpoStatus;
  applicationAmount: number; // money blocked at apply
  investedAllotted: number; // appliedPrice × allottedQty
  listingGain: number | null; // (listing − applied) × qty, gross
  grossPnl: number; // realised gross (exited)
  charges: number; // sell charges (exited)
  netPnl: number; // realised net (exited)
  unrealised: number; // holding mark-to-listing (listed, not exited)
  realised: boolean;
  returnPct: number | null;
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

export function computeIpo(i: IpoInput): IpoComputed {
  const applicationAmount = r2(i.appliedPrice * i.lotSize * i.lotsApplied);
  const allottedQty = i.allotted ? i.allottedQty : 0;
  const investedAllotted = r2(i.appliedPrice * allottedQty);

  let status: IpoStatus;
  if (!i.allotted) status = "not_allotted";
  else if (i.exitPrice != null) status = "exited";
  else if (i.listingPrice != null) status = "listed";
  else status = "allotted";

  const listingGain =
    i.allotted && i.listingPrice != null ? r2((i.listingPrice - i.appliedPrice) * allottedQty) : null;

  let grossPnl = 0, charges = 0, netPnl = 0, unrealised = 0, realised = false, returnPct: number | null = null;

  if (status === "exited" && i.exitPrice != null) {
    grossPnl = r2((i.exitPrice - i.appliedPrice) * allottedQty);
    charges = ipoSellCharges(i.exitPrice * allottedQty, investedAllotted);
    netPnl = r2(grossPnl - charges);
    realised = true;
    returnPct = investedAllotted > 0 ? r2((netPnl / investedAllotted) * 100) : null;
  } else if (status === "listed" && i.listingPrice != null) {
    unrealised = r2((i.listingPrice - i.appliedPrice) * allottedQty);
    returnPct = investedAllotted > 0 ? r2((unrealised / investedAllotted) * 100) : null;
  }

  return {
    ...i,
    allottedQty,
    status,
    applicationAmount,
    investedAllotted,
    listingGain,
    grossPnl,
    charges,
    netPnl,
    unrealised,
    realised,
    returnPct,
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
}

export function summariseIpos(list: IpoComputed[]): IpoSummary {
  const s: IpoSummary = {
    count: list.length,
    appliedCount: list.length,
    allottedCount: 0, notAllottedCount: 0, listedCount: 0, exitedCount: 0,
    applicationAmount: 0, investedAllotted: 0, listingGains: 0, realisedNet: 0, unrealised: 0,
  };
  for (const i of list) {
    s.applicationAmount += i.applicationAmount;
    s.investedAllotted += i.investedAllotted;
    if (i.listingGain != null) s.listingGains += i.listingGain;
    if (i.status === "not_allotted") s.notAllottedCount++;
    else s.allottedCount++;
    if (i.status === "listed") s.listedCount++;
    if (i.status === "exited") { s.exitedCount++; s.realisedNet += i.netPnl; }
    if (i.status === "listed") s.unrealised += i.unrealised;
  }
  s.applicationAmount = r2(s.applicationAmount);
  s.investedAllotted = r2(s.investedAllotted);
  s.listingGains = r2(s.listingGains);
  s.realisedNet = r2(s.realisedNet);
  s.unrealised = r2(s.unrealised);
  return s;
}
