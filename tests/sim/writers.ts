/**
 * One writer per broker format. Each renders the SAME book in that broker's
 * verified layout — column names, preamble rows, date formats, sheet names,
 * the lot — taken from docs/BROKER_FORMATS.md and from the redacted fixtures
 * that were cut from real exports. If a writer drifts from the real layout the
 * parser will (rightly) refuse it, so a green run here is also a layout check.
 *
 * Upstox is deliberately ABSENT: its three real exports carried zero data
 * rows, so every value behaviour is still INFERRED. A generator would test a
 * guess against itself.
 */
import * as XLSX from "xlsx";
import { type Book, type Fill, charges } from "./book";

const r2 = (n: number) => Math.round(n * 100) / 100;
const ddmmyyyy = (iso: string) => iso.split("-").reverse().join("-");
const dMonYYYY = (iso: string) => {
  const [y, m, d] = iso.split("-");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1];
  return `${d} ${mon} ${y}`;
};

function xlsx(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

// ── Zerodha — Console tradebook (XLSX, 8-row preamble, header row 9) ──────────
export function zerodhaConsoleTradebook(book: Book): { filename: string; buffer: Buffer } {
  const dates = book.fills.map((f) => f.date).sort();
  const rows: unknown[][] = [
    ["Client ID"], [], [], [],
    [`Tradebook for Equity from ${dates[0]} to ${dates[dates.length - 1]}`],
    [], [], [],
    ["Symbol", "ISIN", "Trade Date", "Exchange", "Segment", "Series", "Trade Type", "Auction", "Quantity", "Price", "Trade ID", "Order ID", "Order Execution Time"],
  ];
  for (const f of book.fills) {
    rows.push([f.symbol, f.isin, f.date, f.exchange, "EQ", "EQ", f.side, "FALSE", f.qty, f.price, String(100000 + f.seq), String(1_000_000_000 + f.seq), `${f.date} ${f.time}`]);
  }
  return { filename: "tradebook-EQ-console.xlsx", buffer: xlsx({ Sheet1: rows }) };
}

// ── Dhan — Global Transaction Report (CSV, one row per scrip per bill) ────────
// A bill is one scrip-day. Buys and sells on the same scrip-day land on ONE
// row with both sides filled — that is how the real report reads.
export function dhanGtr(book: Book): { filename: string; text: string } {
  const dates = book.fills.map((f) => f.date).sort();
  const byBill = new Map<string, Fill[]>();
  for (const f of book.fills) {
    const k = `${f.date}|${f.symbol}`;
    (byBill.get(k) ?? byBill.set(k, []).get(k)!).push(f);
  }
  const lines = [
    `Global transction report,From ${ddmmyyyy(dates[0])} to ${ddmmyyyy(dates[dates.length - 1])}`,
    "Name,SIMUSER",
    "Client ID,1000000001",
    "",
    "",
    "",
    "Date,Scrip Name,Exchange,Bill No.,Buy Qty.,Buy Value,Sell Qty.,Sell Value,Brokerage,GST,STT,SEBI Fees,Stamp Duty,Txn. Charges,Oth. Charges,Gross Amount",
  ];
  let bill = 8_800_000;
  for (const [k, fills] of [...byBill.entries()].sort()) {
    const [date, symbol] = k.split("|");
    const buys = fills.filter((f) => f.side === "buy");
    const sells = fills.filter((f) => f.side === "sell");
    const bq = buys.reduce((s, f) => s + f.qty, 0), bv = r2(buys.reduce((s, f) => s + f.value, 0));
    const sq = sells.reduce((s, f) => s + f.qty, 0), sv = r2(sells.reduce((s, f) => s + f.value, 0));
    const c = fills.map(charges).reduce((a, x) => ({ brokerage: a.brokerage + x.brokerage, gst: a.gst + x.gst, stt: a.stt + x.stt, sebi: a.sebi + x.sebi, stamp: a.stamp + x.stamp, txn: a.txn + x.txn }), { brokerage: 0, gst: 0, stt: 0, sebi: 0, stamp: 0, txn: 0 });
    const gross = r2(sv - bv - (c.brokerage + c.gst + c.stt + c.sebi + c.stamp + c.txn));
    const q = (s: string | number) => `"${s}"`;
    lines.push([
      q(`${dMonYYYY(date)} 00:00:00`), q(symbol), q(fills[0].exchange), q(String(bill++)),
      q(bq), q(bv.toFixed(2)), q(sq), q(sv.toFixed(2)),
      q(r2(c.brokerage).toFixed(2)), q(r2(c.gst).toFixed(2)), q(r2(c.stt).toFixed(2)), q(r2(c.sebi).toFixed(2)), q(r2(c.stamp).toFixed(2)), q(r2(c.txn).toFixed(2)), q("0.00"), q(gross.toFixed(2)),
    ].join(","));
  }
  return { filename: "Global_Transaction_Report.csv", text: lines.join("\n") + "\n" };
}

// ── Paytm Money — Tradebook v2 (XLSX, metadata rows 1–4, header row 6) ────────
// Numeric scrip CODE in `Script`, ISIN always filled, Product Type `EQ` on every
// row, and STT + stamp duty for a scrip-day booked on that day's LAST execution.
export function paytmTradebook(book: Book): { filename: string; buffer: Buffer } {
  const dates = book.fills.map((f) => f.date).sort();
  const code = new Map(book.symbols.map((s) => [s.symbol, s.code]));
  const rows: unknown[][] = [
    ["UCC", "SIM000001"], ["Name", "SIM USER"], ["PAN Number", "AAAAA0000A"],
    ["Period", `${ddmmyyyy(dates[0])} to ${ddmmyyyy(dates[dates.length - 1])}`],
    [],
    ["Date", "Script", "ISIN", "Exchange", "Product Type", "Type", "Quantity", "Price", "Brokerage", "ETT", "GST", "STT", "SEBI", "Stamp Duty", "Order Number", "Trade Number", "Trade Time"],
  ];
  // Group by scrip-day so STT/stamp can be booked on the last row of each.
  const groups = new Map<string, Fill[]>();
  for (const f of book.fills) {
    const k = `${f.date}|${f.symbol}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(f);
  }
  let order = 1_000_000_000_000_000;
  for (const f of book.fills) {
    const g = groups.get(`${f.date}|${f.symbol}`)!;
    const last = g[g.length - 1] === f;
    const c = charges(f);
    const dayStt = last ? g.map(charges).reduce((s, x) => s + x.stt, 0) : 0;
    const dayStamp = last ? g.map(charges).reduce((s, x) => s + x.stamp, 0) : 0;
    rows.push([
      ddmmyyyy(f.date), code.get(f.symbol), f.isin, f.exchange, "EQ", f.side.toUpperCase(), f.qty, f.price,
      c.brokerage, c.txn, c.gst, r2(dayStt), c.sebi, r2(dayStamp), String(order++), 0, "",
    ]);
  }
  return { filename: "Tradebook_EQ.xlsx", buffer: xlsx({ Sheet1: rows }) };
}

// ── Groww — Stocks Order History (XLSX, metadata rows 1–2, header row 6) ──────
// No price column (Value / Quantity), no charges, the word "Groww" nowhere.
export function growwOrderHistory(book: Book): { filename: string; buffer: Buffer } {
  const rows: unknown[][] = [
    ["Name", "SIM USER", "", "", "", "", "", "", "", ""],
    ["Unique Client Code", "5400000001", "", "", "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", "", "", ""],
    ["Stock name", "Symbol", "ISIN", "Type", "Quantity", "Value", "Exchange", "Exchange Order Id", "Execution date and time", "Order status"],
  ];
  for (const f of book.fills) {
    rows.push([`${f.symbol} Ltd`, f.symbol, f.isin, f.side.toUpperCase(), f.qty, f.value, f.exchange, String(1_100_000_000_000 + f.seq), `${f.date} ${f.time}`, "EXECUTED"]);
  }
  return { filename: "Stocks_Order_History_5400000001.xlsx", buffer: xlsx({ Sheet1: rows }) };
}

/**
 * ── Angel One — Tax P&L (XLSX, 5 sheets) ─────────────────────────────────────
 * This report is PRE-AGGREGATED: positions, not fills. So the writer pairs the
 * book itself (same-day-first, then FIFO) into the Intraday / Delivery / Open
 * Sell / Open Holdings sections — which makes the test a check that the parser
 * reads what the broker STATES, and in particular that `Qty Breakup`'s explicit
 * MTF Qty is read rather than inferred. A share of open holdings is marked MTF.
 */
export function angelOneTaxPnl(book: Book, mtfShare = 0.3): { filename: string; buffer: Buffer; expected: { intraday: number; delivery: number; openSell: number; openHold: number; mtfQty: number } } {
  type Lot = { qty: number; price: number; date: string };
  const intraday: unknown[][] = [], delivery: unknown[][] = [], openSell: unknown[][] = [], openHold: unknown[][] = [], breakup: unknown[][] = [];
  let mtfQty = 0;
  const bySym = new Map<string, Fill[]>();
  for (const f of book.fills) (bySym.get(f.symbol) ?? bySym.set(f.symbol, []).get(f.symbol)!).push(f);
  let i = 0;
  for (const [symbol, fills] of bySym) {
    const isin = fills[0].isin;
    const lots: Lot[] = [];
    for (const f of fills) {
      if (f.side === "buy") { lots.push({ qty: f.qty, price: f.price, date: f.date }); continue; }
      let rem = f.qty;
      // same-day first
      for (const l of lots) { if (rem <= 0) break; if (l.date === f.date && l.qty > 0) { const t = Math.min(rem, l.qty); intraday.push([isin, `${symbol} LTD`, t, ddmmyyyy(f.date), l.price, r2(t * l.price), f.price, r2(t * f.price), r2(charges(f).total * (t / f.qty)), charges(f).stt, r2(t * (f.price - l.price))]); l.qty -= t; rem -= t; } }
      for (const l of lots) { if (rem <= 0) break; if (l.qty > 0) { const t = Math.min(rem, l.qty); delivery.push([isin, `${symbol} LTD`, t, ddmmyyyy(l.date), ddmmyyyy(f.date), l.price, r2(t * l.price), f.price, r2(t * f.price), r2(t * l.price), r2(charges(f).total * (t / f.qty)), charges(f).stt, r2(t * (f.price - l.price)), 0, r2(t * (f.price - l.price)), "Regular", "Equity"]); l.qty -= t; rem -= t; } }
      if (rem > 0) openSell.push([isin, `${symbol} LTD`, rem, ddmmyyyy(f.date), f.price, r2(rem * f.price), r2(charges(f).total * (rem / f.qty)), charges(f).stt]);
    }
    const held = lots.filter((l) => l.qty > 0);
    if (held.length) {
      const q = held.reduce((s, l) => s + l.qty, 0);
      const v = r2(held.reduce((s, l) => s + l.qty * l.price, 0));
      const mtf = i++ % Math.round(1 / mtfShare) === 0 ? Math.floor(q / 2) : 0;
      mtfQty += mtf;
      openHold.push([isin, `${symbol} LTD`, q, r2(v / q), v, 0, 0, r2(v / q), v, 0, 0]);
      breakup.push([isin, `${symbol} LTD`, q, q - mtf, 0, 0, mtf, 0, 0, q]);
    }
  }
  const eq: unknown[][] = [
    ["Equity+Bonds+SGB Trade Details"], [], [], [], [], [], [], [], [],
    [],
    ["Intraday (Speculation)"],
    ["ISIN", "Scrip Name", "Qty", "Transaction Date", "Avg Buy Price", "Buy Value", "Avg Sell Price", "Sell Value", "Charges and Statutory", "STT", "Taxable P&L"],
    ...intraday, [],
    ["Delivery P&L"],
    ["ISIN", "Scrip Name", "Qty", "Buy Date", "Sell Date", "Avg Buy Price", "Buy Value", "Avg Sell Price", "Sell Value", "Cost Of Acquisition", "Charges and Statutory", "STT", "Net Profit/Loss", "Long term taxable income", "Short term taxable income", "Purchase Type", "Type of instrument"],
    ...delivery, [],
    ["Open Sell"],
    ["ISIN", "Scrip Name", "Quantity", "Sell Date", "Avg Sell Price", "Sell Value", "Charges and Statutory", "STT"],
    ...openSell, [],
    ["Open Holdings as of 31-03-2027"],
    ["ISIN", "Scrip Name", "Quantity", "Avg Buy Price", "Buy Value", "Charges and Statutory", "STT", "Closing rate", "Turnover", "Short term Unrealised P&L", "Long term Unrealised P&L"],
    ...openHold, [],
    ["Qty Breakup"],
    ["ISIN", "Scrip Name", "Total Qty", "DP Qty", "Pool Qty", "CUSPA Qty", "MTF Qty", "Pledge Qty", "Long term quantity", "Short term quantity"],
    ...breakup,
  ];
  const buffer = xlsx({
    Summary: [["Angel One Limited — Tax P&L Statement FY 2026-27"], ["Client", "SIM000001"]],
    "Equity+Bonds+SGB Trade Details": eq,
    "Derivatives Trade Details": [["Derivatives Trade Details"], [], ["Futures"], ["Segment", "Symbol Name", "Expiry date", "Qty", "Buy Date", "Sell date", "Avg Buy Price", "Buy Value", "Avg Sell Price", "Sell Value", "Total Charges and Statutory", "STT", "Closing Price(31/03/2027)", "Closing Price(31/03/2027)", "Taxable P&L", "Turnover"], [], ["Options"], ["Segment", "Symbol Name", "Expiry date", "Strike Price", "Option Type", "Qty", "Buy Date", "Sell date", "Avg Buy Price", "Buy Value", "Avg Sell Price", "Sell Value", "Total Charges and Statutory", "STT", "Taxable P&L", "Turnover"]],
    "Non Trade Charges": [["Charge", "Posting Date", "Debit Amount", "Credit Amount"]],
    "Dividend Report": [["ISIN", "Scrip Name", "Dividend Date", "Qty", "Dividend Rate", "Dividend Amount"]],
  });
  return { filename: "Tax PNL FY 2026-27.xlsx", buffer, expected: { intraday: intraday.length, delivery: delivery.length, openSell: openSell.length, openHold: openHold.length, mtfQty } };
}

// ── Generic CSV — the control: any-broker columns through the mapper ─────────
export function genericCsv(book: Book): { filename: string; text: string } {
  const lines = ["Date,Symbol,Side,Qty,Price,Charges"];
  for (const f of book.fills) lines.push(`${f.date},${f.symbol},${f.side.toUpperCase()},${f.qty},${f.price},${charges(f).total}`);
  return { filename: "mystery-broker.csv", text: lines.join("\n") + "\n" };
}
