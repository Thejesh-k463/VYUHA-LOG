import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { detectPaytmTradebook, parsePaytmTradebook } from "@/lib/import/parsers/paytm-tradebook";
import { relabelledFromWarnings } from "@/lib/domain/import-shape";
import { ownerFile } from "./helpers/owner-broker-files";

/**
 * Paytm pairs by ISIN (2026-09-04).
 *
 * The 7,544-execution export relabels a security mid-window — a ticker until
 * June, a numeric BSE code from July; 35 of its 281 ISINs were seen under
 * both. Keyed on `Script`, each such security split into two books: the
 * ticker's buys stayed "open" forever and the code's sells became "opening
 * sells" with no cost basis. Only the ISIN survives the relabel, so that is
 * the pairing key; `Script` is the fallback for a row with no ISIN.
 *
 * The fixture is SYNTHETIC (scripts/fixtures/paytm-tradebook-v3.mjs) in the
 * real layout; the last block reconciles the real export when it is present.
 */

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "redacted", "paytm-tradebook-v3.xlsx");
const v3 = () => ({ filename: "paytm-tradebook-v3.xlsx", buffer: fs.readFileSync(FIXTURE) });

const HEADER = [
  "Date", "Script", "ISIN", "Exchange", "Product Type", "Type", "Quantity", "Price",
  "Brokerage", "ETT", "GST", "STT", "SEBI", "Stamp Duty", "Order Number", "Trade Number", "Trade Time",
];
function wb(rows: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([["UCC"], ["Name"], ["PAN Number"], ["Period"], [], HEADER, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, ws, "Sheet1");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const row = (over: Partial<Record<string, unknown>> = {}): unknown[] => {
  const d: Record<string, unknown> = {
    Date: "03-08-2026", Script: "216463", ISIN: "INE000000001", Exchange: "NSE",
    "Product Type": "EQ", Type: "Buy", Quantity: 100, Price: 200,
    Brokerage: 20, ETT: 6, GST: 4.68, STT: 20, SEBI: 0.02, "Stamp Duty": 3,
    "Order Number": "O1", "Trade Number": "0", "Trade Time": "",
    ...over,
  };
  return HEADER.map((h) => d[h]);
};
const parse = (rows: unknown[][]) => parsePaytmTradebook({ filename: "export.xlsx", buffer: wb(rows) });

describe("fixture v3 — the 2026 layout", () => {
  const p = parsePaytmTradebook(v3());

  it("is still claimed as a Paytm tradebook", () => {
    expect(detectPaytmTradebook(v3())).toBeGreaterThanOrEqual(0.9);
  });

  it("reads every execution row", () => {
    expect(p.sourceRows).toBe(10);
  });

  it("pairs SYNTICK (June, NSE) with 999123 (July, BSE) into ONE closed trade under their ISIN", () => {
    const a = p.trades.filter((t) => t.isin === "INE0SYN01011");
    expect(a).toHaveLength(1);
    expect(a[0].buyQty).toBe(200);
    expect(a[0].sellQty).toBe(200);
    expect(a[0].grossPnl).toBe(3000);
    expect(a[0].basisUnknown).toBe(false);
    expect(a[0].buyDate).toBe("2026-06-05");
    expect(a[0].sellDate).toBe("2026-07-10");
  });

  it("shows the ticker the file used, not the code it switched to", () => {
    const a = p.trades.find((t) => t.isin === "INE0SYN01011")!;
    expect(a.tradingsymbol).toBe("SYNTICK");
    expect((a.importNotes ?? []).join(" ")).not.toMatch(/numeric scrip code/i);
  });

  it("keeps the code when the file never names a ticker, so commit can still resolve it by ISIN", () => {
    const e = p.trades.find((t) => t.isin === "INE0NUM01013")!;
    expect(e.tradingsymbol).toBe("543210");
    expect((e.importNotes ?? []).join(" ")).toMatch(/numeric scrip code, not a ticker/i);
  });

  it("counts the securities it saw under two labels, in a warning the import screen reads back", () => {
    expect(p.warnings).toContain("1 security appeared under two labels — paired by ISIN");
    expect(relabelledFromWarnings(p.warnings)).toBe(1);
  });

  it("carries the execution ladder across the relabel, with the clock where the file has one", () => {
    const a = p.trades.find((t) => t.isin === "INE0SYN01011")!;
    expect(a.executions).toHaveLength(2);
    expect(a.entryTime).toBeNull(); // Trade Number 0 → no Trade Time
    expect(a.exitTime).toBe("10:12");
  });

  it("books the sale with no purchase as an opening sell whose Net P&L is minus its charges only", () => {
    const d = p.trades.find((t) => t.isin === "INE0IPO01015")!;
    expect(d.basisUnknown).toBe(true);
    expect(d.buyQty).toBe(0);
    expect(d.sellValue).toBe(30000);
    expect(d.grossPnl).toBe(0); // so commit's netPnl = grossPnl − charges = −charges
    // Its slice of the book's charges, apportioned by share (the parser's
    // rule), so it lands within rounding of the row's own 54.69.
    expect(Math.abs((d.reportedCharges?.total ?? NaN) - (20 + 0.9 + 3.76 + 30 + 0.03))).toBeLessThan(0.05);
  });

  it("has one opening sell, one open lot, and nothing unbalanced", () => {
    expect(p.trades.filter((t) => t.basisUnknown)).toHaveLength(1);
    expect(p.trades.filter((t) => !t.basisUnknown && t.sellQty === 0)).toHaveLength(1);
    expect(p.trades.filter((t) => t.buyQty > 0 && t.sellQty > 0 && t.buyQty !== t.sellQty)).toHaveLength(0);
  });
});

describe("the key", () => {
  it("falls back to Script when a row has no ISIN", () => {
    const p = parse([
      row({ ISIN: "" }),
      row({ ISIN: "", Date: "04-08-2026", Type: "Sell", Quantity: 100, Price: 210, STT: 21, "Stamp Duty": 0 }),
    ]);
    expect(p.trades).toHaveLength(1);
    expect(p.trades[0].isin).toBeNull();
    expect(p.trades[0].tradingsymbol).toBe("216463");
    expect(p.trades[0].grossPnl).toBe(1000);
  });

  it("keeps a stated MTF book apart from the EQ book of the SAME ISIN", () => {
    const p = parse([row(), row({ "Product Type": "MTF", Quantity: 50, STT: 10, "Stamp Duty": 1.5 })]);
    expect(p.trades).toHaveLength(2);
    expect(p.trades.map((t) => t.productHint).sort()).toEqual(["delivery", "mtf"]);
  });

  it("pairs across a ticker→code relabel and across exchanges — ISIN, not ISIN+exchange", () => {
    // Bought on NSE as a ticker, sold on BSE as a code. ISIN + Exchange would
    // leave a buy with no sale AND a sale with no purchase (measured 101 vs
    // 38 opening sells on the real book).
    const p = parse([
      row({ Script: "ACME", ISIN: "INE0ACM01011", Exchange: "NSE" }),
      row({ Script: "512345", ISIN: "INE0ACM01011", Exchange: "BSE", Date: "04-08-2026", Type: "Sell",
        Quantity: 100, Price: 210, STT: 21, "Stamp Duty": 0 }),
    ]);
    expect(p.trades).toHaveLength(1);
    expect(p.trades[0].basisUnknown).toBe(false);
    expect(p.trades[0].tradingsymbol).toBe("ACME");
    expect(p.trades.filter((t) => t.sellQty === 0)).toHaveLength(0);
  });

  it("names the ticker even when the file shows the code FIRST", () => {
    const p = parse([
      row({ Script: "512345", ISIN: "INE0ACM01011" }),
      row({ Script: "ACME", ISIN: "INE0ACM01011", Date: "04-08-2026", Type: "Sell", Quantity: 100, Price: 210,
        STT: 21, "Stamp Duty": 0 }),
    ]);
    expect(p.trades[0].tradingsymbol).toBe("ACME");
  });
});

// ── The real book, when it is on this machine ───────────────────────────────
//
// The 7,544-execution export lives outside the repo (or in the gitignored
// private fixtures). Read-only: nothing from it is copied anywhere. The
// numbers asserted are the ones the 2026-09-04 research measured on it.
const PRIVATE = path.join(process.cwd(), "tests", "fixtures", "private");

function dataRowCount(file: string): number {
  const book = XLSX.read(fs.readFileSync(file), { type: "buffer" });
  const ws = book.Sheets[book.SheetNames[0]!];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" }) as string[][];
  return rows.slice(6).filter((r) => r.some((c) => String(c).trim() !== "")).length;
}
function realBook(): string | null {
  const candidates = [
    path.join(PRIVATE, "Paytm Money - Tradebook (real).xlsx"),
    // The owner's real book, found by the shared helper. This used to read a
    // `process.env.VYUHA_OWNER_BOOK_DIR` that nothing ever sets, so the only
    // path that ever resolved was the private demo fixture below and the real
    // 7,544-row reconciliation silently never ran.
    ownerFile(/^ACCOUNT 2=3-PAYTM MONEY-LARGE DATA-TIMEPERIOD CHANGE\.xlsx$/),
    // The same export, as the private demo fixture (2026-08-30).
    path.join(PRIVATE, "Paytm Money - Tradebook (demo 2026-08-30).xlsx"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c) && dataRowCount(c) === 7544) return c;
  }
  return null;
}
const BOOK = realBook();

describe.skipIf(!BOOK)("the real 7,544-execution book reconciles", () => {
  // skipIf marks the tests skipped but STILL RUNS this callback at collection
  // time — on CI (no owner book) the parse below threw ENOENT and the whole
  // file failed to load (v3.8 CI run on 15d3c4b). Bail before touching disk.
  if (!BOOK) return;
  const p = parsePaytmTradebook({ filename: "export.xlsx", buffer: fs.readFileSync(BOOK ?? "") });
  const t = p.trades;
  const closed = t.filter((x) => x.buyQty > 0 && x.sellQty > 0);
  const opening = t.filter((x) => x.basisUnknown);
  const open = t.filter((x) => !x.basisUnknown && x.sellQty === 0);
  const sum = (k: string) => t.reduce((s, x) => s + ((x.reportedCharges as Record<string, number>)[k] ?? 0), 0);

  it("reads all 7,544 executions", () => {
    expect(p.sourceRows).toBe(7544);
  });

  it("leaves no more than the 38 SME-IPO allotments unpriced", () => {
    expect(opening.length).toBeLessThanOrEqual(38);
  });

  it("never splits one security into two books: one label per ISIN, and no open lot beside an opening sell", () => {
    // The Script-keyed defect looked like this: the ticker's buys "open" and
    // the code's later sells "opening sells", in the SAME security and stated
    // product. (Overlapping CLOSED windows are legitimate FIFO — buy, buy,
    // sell, sell — so they are not what is checked.)
    const byKey = new Map<string, typeof t>();
    for (const x of t) {
      const k = `${x.isin}|${x.productHint === "mtf" ? "mtf" : "eq"}`;
      byKey.set(k, [...(byKey.get(k) ?? []), x]);
    }
    for (const [k, arr] of byKey) {
      expect(new Set(arr.map((x) => x.tradingsymbol)).size, `${k} shown under more than one label`).toBe(1);
      const opens = arr.filter((x) => !x.basisUnknown && x.sellQty === 0);
      const orphans = arr.filter((x) => x.basisUnknown);
      for (const o of opens) {
        for (const s of orphans) {
          expect(s.sellDate! > o.buyDate!, `${k}: open lot ${o.buyDate} beside an opening sell ${s.sellDate}`).toBe(false);
        }
      }
    }
  });

  it("conserves the broker's own charges to the paisa", () => {
    expect(Math.abs(sum("total") - 1249096.81)).toBeLessThanOrEqual(0.01 + 1e-9);
    expect(sum("brokerage")).toBeCloseTo(58654.3, 2);
    expect(sum("exchangeTxn")).toBeCloseTo(56422.64, 2);
    expect(sum("gst")).toBeCloseTo(20993.89, 2);
    expect(sum("sttCtt")).toBeCloseTo(1031198.23, 2);
    expect(sum("sebi")).toBeCloseTo(1555.74, 2);
    expect(sum("stampDuty")).toBeCloseTo(80272, 2);
  });

  it("prints the shape for the record (console, never stored)", () => {
    const closedNet = closed.reduce((s, x) => s + x.grossPnl - (x.reportedCharges?.total ?? 0), 0);
    const line = JSON.stringify({
      positions: t.length,
      closed: closed.length,
      open: open.length,
      openingSells: opening.length,
      openingProceeds: Math.round(opening.reduce((s, x) => s + x.sellValue, 0) * 100) / 100,
      closedNet: Math.round(closedNet * 100) / 100,
      intraday: t.filter((x) => x.productHint === "intraday").length,
      relabelled: relabelledFromWarnings(p.warnings),
      chargesTotal: Math.round(sum("total") * 100) / 100,
    });
    // vitest swallows console.* under this config; stdout does not go through it.
    process.stdout.write(`PAYTM-REAL-BOOK ${line}\n`);
    expect(t.length).toBeGreaterThan(0);
  });
});
