#!/usr/bin/env node
/**
 * Generates tests/fixtures/redacted/paytm-tradebook-v3.xlsx — a SYNTHETIC
 * Paytm Money tradebook in the real 2026 layout (preamble rows 0–3 with
 * placeholder UCC / Name / PAN / Period, blank row 4, the 17 real column
 * names on row 5, `EQ` as the product type, NSE and BSE rows, `dd-mm-yyyy`
 * dates, 4-dp numbers as strings, Trade Time blank exactly where Trade
 * Number is 0). No cell comes from a real export.
 *
 * Deterministic: fixed data, fixed workbook dates, no compression, so two
 * runs produce byte-identical files (the test that reads it does not care,
 * but a fixture that changes on every regeneration is noise in every diff).
 *
 *   node scripts/fixtures/paytm-tradebook-v3.mjs
 *
 * What the rows exercise (tests/paytm-isin-pairing.test.ts):
 *
 *   A  one security traded as `SYNTICK` in June and as BSE code `999123` in
 *      July under ONE ISIN — pairs into one closed trade only when the parser
 *      keys on ISIN, not on Script.
 *   B  a MIXED scrip-day: 1,000 bought, 600 sold the same day, 400 carried.
 *      Stamp duty 7.80 = 0.015% × 40,000 + 0.003% × 60,000 sits between the
 *      two rates (a 60/40 split the other way reads as delivery — the 35%
 *      tolerance makes "mixed" mean 9–56% delivery); STT 40 (delivery buy)
 *      + 15.15 (intraday sell on 60,600).
 *   C  a same-day round trip charged as CNC DELIVERY: stamp 0.015% of the
 *      buy, STT 0.1% of buy PLUS sell (25 + 26 = 51 on 51,000).
 *   D  a sale with no purchase anywhere in the file (an SME IPO allotment).
 *   E  a code-only security — no ticker anywhere, so the code is displayed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "tests", "fixtures", "redacted", "paytm-tradebook-v3.xlsx");

const HEADER = [
  "Date", "Script", "ISIN", "Exchange", "Product Type", "Type", "Quantity", "Price",
  "Brokerage", "ETT", "GST", "STT", "SEBI", "Stamp Duty", "Order Number", "Trade Number", "Trade Time",
];

const f4 = (n) => Number(n).toFixed(4);

/** One execution row in the real column order. Money as 4-dp strings. */
function row(date, script, isin, exch, side, qty, price, c, order, tradeNo, time) {
  return [
    date, script, isin, exch, "EQ", side, String(qty), f4(price),
    f4(c.brok), f4(c.ett), f4(c.gst), f4(c.stt), f4(c.sebi), f4(c.stamp),
    order, String(tradeNo), tradeNo === 0 ? "" : time,
  ];
}

const rows = [
  // A — SYNTICK (NSE, June) … 999123 (BSE, July), ISIN INE0SYN01011: delivery, 200 @150 → 200 @165.
  row("05-06-2026", "SYNTICK", "INE0SYN01011", "NSE", "BUY", 200, 150, { brok: 20, ett: 0.9, gst: 3.76, stt: 30, sebi: 0.03, stamp: 4.5 }, "1000000000000101", 0, ""),
  row("10-07-2026", "999123", "INE0SYN01011", "BSE", "SELL", 200, 165, { brok: 20, ett: 0.99, gst: 3.78, stt: 33, sebi: 0.03, stamp: 0 }, "1775000000000102", 55512, "10:12:45"),

  // B — MIXCO, ISIN INE0MIX01019: 16-06 buy 600 + 400 @100, sell 600 @101 same day; 20-07 sell the 400 @110.
  row("16-06-2026", "MIXCO", "INE0MIX01019", "NSE", "BUY", 600, 100, { brok: 20, ett: 1.8, gst: 3.92, stt: 0, sebi: 0.06, stamp: 0 }, "1000000000000201", 70001, "09:20:10"),
  row("16-06-2026", "MIXCO", "INE0MIX01019", "NSE", "BUY", 400, 100, { brok: 20, ett: 1.2, gst: 3.82, stt: 40, sebi: 0.04, stamp: 7.8 }, "1000000000000202", 70002, "09:25:00"),
  row("16-06-2026", "MIXCO", "INE0MIX01019", "NSE", "SELL", 600, 101, { brok: 20, ett: 1.82, gst: 3.93, stt: 15.15, sebi: 0.06, stamp: 0 }, "1000000000000203", 70003, "14:10:05"),
  row("20-07-2026", "MIXCO", "INE0MIX01019", "NSE", "SELL", 400, 110, { brok: 20, ett: 1.32, gst: 3.84, stt: 44, sebi: 0.04, stamp: 0 }, "1000000000000204", 80001, "11:05:30"),

  // C — CNCDAY, ISIN INE0CNC01017: same-day round trip charged as delivery. 500 @50 → 500 @52.
  row("24-06-2026", "CNCDAY", "INE0CNC01017", "NSE", "BUY", 500, 50, { brok: 20, ett: 0.75, gst: 3.74, stt: 25, sebi: 0.03, stamp: 3.75 }, "1000000000000301", 90001, "10:00:00"),
  row("24-06-2026", "CNCDAY", "INE0CNC01017", "NSE", "SELL", 500, 52, { brok: 20, ett: 0.78, gst: 3.74, stt: 26, sebi: 0.03, stamp: 0 }, "1000000000000302", 90002, "15:00:00"),

  // D — IPOSME, ISIN INE0IPO01015: sold, never bought here. 100 @300.
  row("02-07-2026", "IPOSME", "INE0IPO01015", "NSE", "SELL", 100, 300, { brok: 20, ett: 0.9, gst: 3.76, stt: 30, sebi: 0.03, stamp: 0 }, "1000000000000401", 0, ""),

  // E — code only (BSE 543210), ISIN INE0NUM01013: 50 @400, still open.
  row("15-07-2026", "543210", "INE0NUM01013", "BSE", "BUY", 50, 400, { brok: 20, ett: 0.6, gst: 3.71, stt: 20, sebi: 0.02, stamp: 3 }, "1775000000000501", 91001, "12:30:00"),
];

const sheet = [
  ["UCC", "XX000000"],
  ["Name", "REDACTED HOLDER"],
  ["PAN Number", "XXXXX0000X"],
  ["Period", "01-06-2026 to 31-07-2026"],
  [],
  HEADER,
  ...rows,
];

const ws = XLSX.utils.aoa_to_sheet(sheet);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "sheet");
const fixed = new Date(Date.UTC(2026, 8, 4, 0, 0, 0));
wb.Props = { Title: "paytm-tradebook-v3", Author: "vyuha fixture", CreatedDate: fixed, ModifiedDate: fixed };

fs.mkdirSync(path.dirname(OUT), { recursive: true });
XLSX.writeFile(wb, OUT, { bookType: "xlsx", compression: false });
console.log(`wrote ${path.relative(ROOT, OUT)} (${rows.length} execution rows)`);
