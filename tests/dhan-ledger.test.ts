import { describe, it, expect } from "vitest";
import {
  parseDhanLedger, classifyNarration, parseLedgerDate, findColumns,
  detectDhanLedger, reconcileMtfInterest,
} from "@/lib/import/parsers/dhan-ledger";

const LEDGER = `Ledger Statement,From 01-07-2026 to 29-07-2026
Name,TESTUSER

Date,Particulars,Debit,Credit,Running Balance
"01 Jul 2026","Opening Balance","0.00","150000.00","150000.00"
"03 Jul 2026","Net obligation for settlement 2026123","2645.76","0.00","147354.24"
"07 Jul 2026","MTF charges for the week ending 06 Jul 2026","1284.50","0.00","146069.74"
"10 Jul 2026","Brokerage and STT for bill 9877239","512.30","0.00","145557.44"
"14 Jul 2026","MTF Interest 07 Jul - 13 Jul","1190.25","0.00","144367.19"
"16 Jul 2026","UPI deposit received from TESTUSER","0.00","50000.00","194367.19"
"20 Jul 2026","Dividend credit RELIANCE","0.00","1200.00","195567.19"
"22 Jul 2026","Payout to bank account","25000.00","0.00","170567.19"
"24 Jul 2026","Zzzqx unknown voucher 4412","300.00","0.00","170267.19"
`;

describe("parseLedgerDate", () => {
  it("reads the shapes Indian brokers actually emit", () => {
    expect(parseLedgerDate("2026-07-01")).toBe("2026-07-01");
    expect(parseLedgerDate("01-07-2026")).toBe("2026-07-01");
    expect(parseLedgerDate("01/07/2026")).toBe("2026-07-01");
    expect(parseLedgerDate("01 Jul 2026")).toBe("2026-07-01");
  });

  it("assumes DAY-FIRST, per Indian convention", () => {
    // 06-01-2026 must be 6 January, not 1 June — misreading it would shift the
    // whole ledger by months.
    expect(parseLedgerDate("06-01-2026")).toBe("2026-01-06");
  });

  it("rejects junk rather than guessing", () => {
    expect(parseLedgerDate("")).toBeNull();
    expect(parseLedgerDate("Total")).toBeNull();
    expect(parseLedgerDate("32-13-2026")).toBeNull();
  });
});

describe("classifyNarration — MTF is checked first, and on its own", () => {
  it("catches the several ways a broker words MTF financing", () => {
    for (const n of [
      "MTF charges for the week ending 06 Jul 2026",
      "MTF Interest 07 Jul - 13 Jul",
      "Margin Trading Facility interest",
      "Margin funding charges",
      "Funding interest for the week",
    ]) {
      expect(classifyNarration(n).kind, n).toBe("mtf_interest");
    }
  });

  it("does NOT let the generic charges rule swallow an MTF row", () => {
    // "MTF charges" contains "charges"; ordering is meaning here, not style.
    expect(classifyNarration("MTF charges").kind).toBe("mtf_interest");
    expect(classifyNarration("Brokerage charges").kind).toBe("charge");
  });

  it("classifies the ordinary ledger traffic", () => {
    expect(classifyNarration("UPI deposit received from X").kind).toBe("deposit");
    expect(classifyNarration("Payout to bank account").kind).toBe("withdrawal");
    expect(classifyNarration("Dividend credit RELIANCE").kind).toBe("dividend");
    expect(classifyNarration("Net obligation for settlement 123").kind).toBe("realised_pnl");
    expect(classifyNarration("Brokerage and STT for bill 9").kind).toBe("charge");
  });

  it("ADMITS when it does not know, instead of filing a guess", () => {
    const r = classifyNarration("Zzzqx unknown voucher 4412");
    expect(r.kind).toBe("adjustment");
    expect(r.unclassified).toBe(true);
  });

  it("treats an empty narration as unclassified, not as an adjustment it understood", () => {
    expect(classifyNarration("").unclassified).toBe(true);
  });
});

describe("findColumns — header-driven, so a reordered export still parses", () => {
  it("finds columns by keyword regardless of position", () => {
    const c = findColumns(["Running Balance", "Credit", "Debit", "Particulars", "Date"])!;
    expect(c.date).toBe(4);
    expect(c.narration).toBe(3);
    expect(c.debit).toBe(2);
    expect(c.credit).toBe(1);
  });

  it("accepts a single signed amount column instead of debit/credit", () => {
    expect(findColumns(["Date", "Narration", "Amount"])).not.toBeNull();
  });

  it("refuses a header that cannot be a ledger", () => {
    expect(findColumns(["Symbol", "Qty", "Price"])).toBeNull();
    expect(findColumns(["Date", "Particulars"])).toBeNull(); // no money column
  });
});

describe("detectDhanLedger", () => {
  it("claims a real ledger confidently", () => {
    expect(detectDhanLedger(LEDGER)).toBeGreaterThan(0.8);
  });

  it("does not claim a tradebook", () => {
    expect(detectDhanLedger("Symbol,Qty,Price\nTCS,1,100")).toBe(0);
    expect(detectDhanLedger("")).toBe(0);
  });
});

describe("parseDhanLedger — against a representative ledger", () => {
  const p = parseDhanLedger(LEDGER);

  it("reads every dated row, excluding the balance marker which is not an entry", () => {
    // 9 dated lines, minus the "Opening Balance" assertion.
    expect(p.rows).toHaveLength(8);
    expect(p.openingBalance).toBe(150000);
    // from/to describe the ENTRY range, so they start at the first real
    // movement rather than at the balance assertion that precedes it.
    expect(p.from).toBe("2026-07-03");
    expect(p.to).toBe("2026-07-24");
  });

  it("totals the REAL MTF interest — the whole point of this importer", () => {
    // 1284.50 + 1190.25, reported positive because interest is a cost.
    expect(p.mtfInterestTotal).toBe(2474.75);
  });

  it("collapses debit/credit into one signed amount, negative for money out", () => {
    const mtf = p.rows.find((r) => r.kind === "mtf_interest")!;
    expect(mtf.amount).toBe(-1284.5);
    const deposit = p.rows.find((r) => r.kind === "deposit")!;
    expect(deposit.amount).toBe(50000);
  });

  it("keeps the running balance when the file carries one", () => {
    expect(p.rows[0].balance).toBe(147354.24);
  });

  it("surfaces the unclassifiable row rather than hiding it", () => {
    expect(p.unclassified).toHaveLength(1);
    expect(p.unclassified[0].narration).toMatch(/Zzzqx/);
    expect(p.warnings.join(" ")).toMatch(/could not be classified/i);
  });

  it("says plainly that the MTF figure is actual, not estimated", () => {
    expect(p.warnings.join(" ")).toMatch(/ACTUALLY charged, not an estimate/i);
  });

  it("explains an MTF-free ledger instead of looking broken", () => {
    const q = parseDhanLedger(`Date,Particulars,Debit,Credit\n"01 Jul 2026","Brokerage","10","0"\n`);
    expect(q.mtfInterestTotal).toBe(0);
    expect(q.warnings.join(" ")).toMatch(/posts MTF interest weekly/i);
  });

  it("fails loudly on a file with no recognisable header", () => {
    const q = parseDhanLedger("nothing,useful,here\n1,2,3");
    expect(q.rows).toEqual([]);
    expect(q.warnings.join(" ")).toMatch(/Could not find a ledger header/i);
  });
});

describe("reconcileMtfInterest — a comparison, deliberately not a correction", () => {
  it("reports the gap between actual and estimated", () => {
    const r = reconcileMtfInterest(2474.75, 2100);
    expect(r.actual).toBe(2474.75);
    expect(r.estimated).toBe(2100);
    expect(r.delta).toBe(374.75);
    expect(r.deltaPct).toBeCloseTo(17.85, 1);
  });

  it("returns a null percentage rather than dividing by zero", () => {
    expect(reconcileMtfInterest(500, 0).deltaPct).toBeNull();
  });

  it("reports a negative delta when Vyuha over-estimated", () => {
    expect(reconcileMtfInterest(1000, 1500).delta).toBe(-500);
  });
});
