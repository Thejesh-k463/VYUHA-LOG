// Pure charges & MTF-leak analytics. Consumes trades carrying the full charge
// breakdown columns.

export interface ChargeReportTrade {
  segment: string;
  sellDate: string | null;
  buyValue: number;
  sellValue: number;
  grossPnl: number;
  netPnl: number;
  brokerage: number;
  sttCtt: number;
  exchangeTxn: number;
  sebi: number;
  stampDuty: number;
  ipft: number;
  gst: number;
  dpCharges: number;
  mtfInterest: number;
  pledgeCharges: number;
  chargesTotal: number;
}

export interface ChargeRow {
  key: string;
  count: number;
  turnover: number;
  brokerage: number;
  sttCtt: number;
  exchangeTxn: number;
  statutory: number; // sebi + stamp + ipft
  gst: number;
  dpCharges: number;
  mtfInterest: number;
  pledgeCharges: number;
  total: number;
  gross: number;
  net: number;
  breakevenPct: number; // total charges as % of turnover (avg move to break even)
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function emptyRow(key: string): ChargeRow {
  return {
    key, count: 0, turnover: 0, brokerage: 0, sttCtt: 0, exchangeTxn: 0,
    statutory: 0, gst: 0, dpCharges: 0, mtfInterest: 0, pledgeCharges: 0,
    total: 0, gross: 0, net: 0, breakevenPct: 0,
  };
}

function accumulate(row: ChargeRow, t: ChargeReportTrade) {
  row.count++;
  row.turnover += t.buyValue + t.sellValue;
  row.brokerage += t.brokerage;
  row.sttCtt += t.sttCtt;
  row.exchangeTxn += t.exchangeTxn;
  row.statutory += t.sebi + t.stampDuty + t.ipft;
  row.gst += t.gst;
  row.dpCharges += t.dpCharges;
  row.mtfInterest += t.mtfInterest;
  row.pledgeCharges += t.pledgeCharges;
  row.total += t.chargesTotal;
  row.gross += t.grossPnl;
  row.net += t.netPnl;
}

function finalize(row: ChargeRow): ChargeRow {
  return {
    ...row,
    turnover: r2(row.turnover),
    brokerage: r2(row.brokerage),
    sttCtt: r2(row.sttCtt),
    exchangeTxn: r2(row.exchangeTxn),
    statutory: r2(row.statutory),
    gst: r2(row.gst),
    dpCharges: r2(row.dpCharges),
    mtfInterest: r2(row.mtfInterest),
    pledgeCharges: r2(row.pledgeCharges),
    total: r2(row.total),
    gross: r2(row.gross),
    net: r2(row.net),
    breakevenPct: row.turnover > 0 ? r2((row.total / row.turnover) * 100) : 0,
  };
}

function groupCharges(trades: ChargeReportTrade[], keyFn: (t: ChargeReportTrade) => string): ChargeRow[] {
  const map = new Map<string, ChargeRow>();
  for (const t of trades) {
    const k = keyFn(t);
    const row = map.get(k) ?? emptyRow(k);
    accumulate(row, t);
    map.set(k, row);
  }
  return [...map.values()].map(finalize).sort((a, b) => b.total - a.total);
}

export function chargesBySegment(trades: ChargeReportTrade[]): ChargeRow[] {
  return groupCharges(trades, (t) => t.segment);
}

export function chargesByMonth(trades: ChargeReportTrade[]): ChargeRow[] {
  return groupCharges(trades.filter((t) => t.sellDate), (t) => t.sellDate!.slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key));
}

export function chargesTotals(trades: ChargeReportTrade[]): ChargeRow {
  const row = emptyRow("Total");
  for (const t of trades) accumulate(row, t);
  return finalize(row);
}
