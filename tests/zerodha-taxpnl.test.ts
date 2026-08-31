import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { buildContext } from "@/lib/import/detect";
import { parseZerodha } from "@/lib/import/parsers/zerodha";

/**
 * Zerodha Console TAX P&L ("Tradewise Exits") — parsed output reconciled
 * against the workbook's OWN "F&O" summary sheet, on redacted copies of two
 * real exports (FY2024-25: 632 exit rows spanning the 1-Oct-2024 STT change;
 * FY2025-26: 59 rows at a single STT rate).
 *
 * The reconciliation targets travel INSIDE the fixture: Zerodha states its own
 * realized-profit and per-head charge totals on sheet 2, so these tests hold
 * the parser to the broker's own numbers rather than to figures we computed
 * once and froze.
 */

const RD = path.join(process.cwd(), "tests", "fixtures", "redacted");

const load = (file: string) =>
  // Neutral filename — real exports are named taxpnl-<client>-<fy>-Q1-Q4.xlsx
  // and name no broker; the claim and the parse must ride content alone.
  buildContext("export.xlsx", fs.readFileSync(path.join(RD, file)));

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Zerodha's own totals off the F&O summary sheet of the same workbook. */
function summaryOf(file: string) {
  const wb = XLSX.readFile(path.join(RD, file));
  const fo = XLSX.utils.sheet_to_json(wb.Sheets["F&O"], { header: 1, blankrows: false, defval: "" }) as unknown[][];
  const num = (v: unknown) => {
    const x = Number(String(v).replace(/,/g, ""));
    return Number.isFinite(x) ? x : 0;
  };
  const row = (re: RegExp) => fo.find((r) => re.test(String(r[0])));
  const profit = num(row(/^Options Realized Profit/i)?.[1]) + num(row(/^Futures Realized Profit/i)?.[1]);
  const charges = r2(
    fo
      .filter((r) => /\s-\s?Z$/.test(String(r[0]).trim()) || /^IPFT$/.test(String(r[0]).trim()))
      .reduce((s, r) => s + num(r[1]), 0),
  );
  return { profit, charges };
}

describe.each([
  // FY24-25 charges: Zerodha's summary sheet includes ₹187.31 the tradewise
  // rows do not carry (entry-side charges of positions still open at FY end —
  // the sheet lists EXITS). The delta is the FILE's, not the parser's, and is
  // pinned so a change in either direction is investigated, not absorbed.
  { file: "zerodha-taxpnl-fy2425.xlsx", rows: 632, positions: 206, chargeGap: -187.31 },
  { file: "zerodha-taxpnl-fy2526.xlsx", rows: 59, positions: 26, chargeGap: 0 },
])("tax P&L reconciles against Zerodha's own summary: $file", ({ file, rows, positions, chargeGap }) => {
  const parsed = parseZerodha(load(file));
  const stated = summaryOf(file);

  it("parses as the taxpnl format with the pinned row → position grouping", () => {
    expect(parsed.format).toBe("taxpnl");
    expect(parsed.sourceRows).toBe(rows);
    expect(parsed.trades.length).toBe(positions);
  });

  it("Σ gross P&L equals the broker's stated realized profit EXACTLY", () => {
    const gross = r2(parsed.trades.reduce((s, t) => s + t.grossPnl, 0));
    expect(gross).toBeCloseTo(stated.profit, 2);
  });

  it("Σ reported charges reconcile to the broker's stated totals", () => {
    // Zerodha states heads to 4 decimals; Vyuha stores integer paise per
    // trade, so each head can shift up to half a paisa per position when
    // rounded at the position boundary. 25p across a whole FY is far inside
    // that bound (7 heads × ½p × positions) — anything beyond it is a parser
    // bug, not rounding.
    const total = r2(parsed.trades.reduce((s, t) => s + (t.reportedCharges?.total ?? 0), 0));
    expect(Math.abs(total - stated.charges - chargeGap)).toBeLessThan(0.25);
  });

  it("every position carries entry AND exit time-of-day (the timestamps are the point of this file)", () => {
    expect(parsed.trades.every((t) => t.entryTime && t.exitTime)).toBe(true);
    expect(parsed.trades.every((t) => t.buyDate && t.sellDate)).toBe(true);
  });

  it("every position states the broker's own charges per head, closed both sides", () => {
    for (const t of parsed.trades) {
      expect(t.reportedCharges).toBeTruthy();
      expect(t.buyQty).toBe(t.sellQty);
      const c = t.reportedCharges!;
      const headSum = r2(
        (c.brokerage ?? 0) + (c.exchangeTxn ?? 0) + (c.ipft ?? 0) + (c.sebi ?? 0) +
        (c.gst ?? 0) + (c.stampDuty ?? 0) + (c.sttCtt ?? 0),
      );
      expect(headSum).toBeCloseTo(c.total ?? 0, 2);
    }
  });
});

describe("tradewise grouping semantics (synthetic workbook)", () => {
  const HEADER = ["Symbol", "Entry Date", "Exit Date", "Quantity", "Buy Value", "Sell Value", "Profit", "Turnover", "Brokerage", "Exchange Transaction Charges", "IPFT", "SEBI Charges", "CGST", "SGST", "IGST", "Stamp Duty", "STT"];
  const wbOf = (rows: unknown[][]) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Tradewise Exits from 2025-04-01");
    return buildContext("export.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
  };
  const pre = [["View Zerodha's guide on using tax reports for filing."], ["Client ID", "REDACTED"], ["F&O"], HEADER];

  it("splits of one order (same entry second, same exit day) merge into ONE position", () => {
    const parsed = parseZerodha(wbOf([
      ...pre,
      ["NIFTY2540323250CE", "2025-04-02T09:29:49", "2025-04-02T09:33:35", 75, 7725, 9112.5, 1387.5, 1387.5, 6.67, 5.9, 0.08, 0.02, 0, 0, 2.28, 0.24, 9.12],
      ["NIFTY2540323250CE", "2025-04-02T09:29:49", "2025-04-02T09:33:35", 75, 7725, 9108.75, 1383.75, 1383.75, 6.67, 5.9, 0.08, 0.02, 0, 0, 2.28, 0.24, 9.12],
    ]));
    expect(parsed.format).toBe("taxpnl");
    expect(parsed.trades.length).toBe(1);
    const t = parsed.trades[0];
    expect(t.buyQty).toBe(150);
    expect(t.grossPnl).toBeCloseTo(2771.25, 2);
    expect(t.buyValue).toBeCloseTo(15450, 2);
    // identical buy fills merge back into one execution; the two sells landed
    // at DIFFERENT prices, so they are genuinely two fills — the ladder keeps
    // its shape.
    const ex = t.executions ?? [];
    expect(ex.filter((e) => e.side === "buy").length).toBe(1);
    expect(ex.filter((e) => e.side === "sell").length).toBe(2);
  });

  it("one entry exited on DIFFERENT days stays separate positions (the scrip-day unit)", () => {
    const parsed = parseZerodha(wbOf([
      ...pre,
      ["NIFTY2540323750CE", "2025-03-28T10:37:46", "2025-04-02T15:25:00", 150, 17250, 600, -16650, 16650, 20, 0.21, 0, 0, 0, 0, 3.64, 0, 0.6],
      ["NIFTY2540323750CE", "2025-03-28T10:37:46", "2025-04-03T15:07:23", 225, 25875, 22.5, -25852.5, 25852.5, 20, 0.01, 0, 0, 0, 0, 3.6, 0, 0],
    ]));
    expect(parsed.trades.length).toBe(2);
    expect(parsed.trades.map((t) => t.sellDate).sort()).toEqual(["2025-04-02", "2025-04-03"]);
  });

  it("CGST + SGST + IGST fold into the engine's single gst head", () => {
    const parsed = parseZerodha(wbOf([
      ...pre,
      ["ITC25APR400CE", "2025-04-02T10:00:00", "2025-04-02T11:00:00", 100, 1000, 1200, 200, 200, 10, 2, 0.1, 0.05, 1.5, 1.5, 4, 0.3, 1.2],
    ]));
    const c = parsed.trades[0].reportedCharges!;
    expect(c.gst).toBeCloseTo(7, 2); // 1.5 + 1.5 + 4
    expect(c.sttCtt).toBeCloseTo(1.2, 2);
    expect(c.brokerage).toBeCloseTo(10, 2);
    expect(c.total).toBeCloseTo(10 + 2 + 0.1 + 0.05 + 7 + 0.3 + 1.2, 2);
  });

  it("a row with no readable date or quantity is refused, never coerced", () => {
    const parsed = parseZerodha(wbOf([
      ...pre,
      ["GOODROW25APR100CE", "2025-04-02T10:00:00", "2025-04-02T11:00:00", 10, 100, 120, 20, 20, 1, 0, 0, 0, 0, 0, 0, 0, 0],
      ["BADROW25APR100CE", "", "2025-04-02T11:00:00", 10, 100, 120, 20, 20, 1, 0, 0, 0, 0, 0, 0, 0],
      ["ZEROQTY25APR100CE", "2025-04-02T10:00:00", "2025-04-02T11:00:00", 0, 100, 120, 20, 20, 1, 0, 0, 0, 0, 0, 0, 0],
    ]));
    expect(parsed.trades.length).toBe(1);
    expect(parsed.trades[0].tradingsymbol).toBe("GOODROW25APR100CE");
    expect(parsed.warnings.join(" ")).toMatch(/refused/);
  });

  it("a Commodity section hints MCX; sections annotate provenance", () => {
    const parsed = parseZerodha(wbOf([
      ...pre,
      ["ITC25APR400CE", "2025-04-02T10:00:00", "2025-04-02T11:00:00", 100, 1000, 1200, 200, 200, 1, 0, 0, 0, 0, 0, 0, 0, 0],
      ["Commodity"],
      HEADER,
      ["CRUDEOIL25APR6000CE", "2025-04-03T10:00:00", "2025-04-03T11:00:00", 100, 1000, 1200, 200, 200, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    ]));
    expect(parsed.trades.length).toBe(2);
    const crude = parsed.trades.find((t) => t.tradingsymbol.startsWith("CRUDEOIL"))!;
    expect(crude.exchangeHint).toBe("MCX");
    expect(crude.importNotes?.join(" ")).toMatch(/Commodity/);
    const itc = parsed.trades.find((t) => t.tradingsymbol.startsWith("ITC"))!;
    expect(itc.exchangeHint).toBeNull();
  });
});
