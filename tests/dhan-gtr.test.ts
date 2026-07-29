import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { detectDhanGtr, parseDhanGtr, parseGtrDate, readGtr, rowToLegs } from "@/lib/import/parsers/dhan-gtr";
import { detectDhanCsv } from "@/lib/import/parsers/dhan-csv";
import { pairLegs, summarisePairing } from "@/lib/import/pair-legs";

/**
 * Tested against a real Dhan Global Transaction Report (01-07-2026 to
 * 29-07-2026, 92 rows) with the scrip names and account identity replaced.
 *
 * Only the LABELS were changed. Every quantity, value and charge is untouched,
 * which is what makes this fixture worth having: the footer totals are the
 * broker's own arithmetic, so they act as an independent oracle. If the parser
 * and Dhan disagree, one of them is wrong, and it is not going to be Dhan.
 */
const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "dhan-gtr.csv");
const text = fs.readFileSync(FIXTURE, "utf8");
const ctx = { filename: "Dhan_GlobalTransction_Report_01-07-2026_29-07-2026.csv", text };

describe("detection", () => {
  it("claims this file confidently", () => {
    expect(detectDhanGtr(ctx)).toBeGreaterThan(0.9);
  });

  it("makes the ordinary Dhan P&L parser stand down, so the two never compete", () => {
    expect(detectDhanCsv(ctx)).toBe(0);
  });

  it("does not claim a file it cannot read", () => {
    expect(detectDhanGtr({ filename: "x.csv", text: "Symbol,Qty\nFOO,1" })).toBe(0);
  });
});

describe("date parsing", () => {
  it("reads the Dhan long-form date", () => {
    expect(parseGtrDate("01 Jul 2026 00:00:00")).toBe("2026-07-01");
    expect(parseGtrDate("29 Dec 2026 00:00:00")).toBe("2026-12-29");
  });

  it("rejects junk rather than guessing", () => {
    expect(parseGtrDate("")).toBeNull();
    expect(parseGtrDate("Net P&L")).toBeNull();
    expect(parseGtrDate("32 Xyz 2026")).toBeNull();
  });
});

describe("reading the file", () => {
  it("finds every data row and stops at the footer", () => {
    const { rows, reported } = readGtr(text);
    expect(rows).toHaveLength(92);
    expect(reported.netPnl).toBeCloseTo(-40799.7591, 2);
    expect(reported.grossPnl).toBeCloseTo(-8489.6035, 2);
    expect(reported.totalCharges).toBeCloseTo(32310.1556, 2);
    expect(reported.brokerage).toBeCloseTo(4090.02, 2);
  });

  it("keeps the footer identity the broker itself reports", () => {
    const { reported } = readGtr(text);
    expect(reported.grossPnl - reported.totalCharges).toBeCloseTo(reported.netPnl, 2);
  });

  it("carries the BSE row's exchange rather than defaulting everything to NSE", () => {
    const { rows } = readGtr(text);
    expect(rows.some((r) => r.exchange === "BSE")).toBe(true);
  });
});

describe("pairing the whole real book", () => {
  const { rows } = readGtr(text);
  const legs = rows.flatMap(rowToLegs);
  const paired = pairLegs(legs);
  const check = summarisePairing(legs, paired);

  it("conserves every share and every rupee through FIFO", () => {
    expect(check.qtyDelta).toBe(0);
    expect(check.valueDelta).toBe(0);
  });

  it("resolves 92 bill rows into positions with the expected shape", () => {
    expect(check.closed).toBe(75);
    expect(check.open).toBe(3);
    expect(check.openingSells).toBe(1);
  });

  it("identifies exactly the holdings still open at the end of the window", () => {
    const open = paired.filter((p) => p.kind === "open").map((p) => p.symbol).sort();
    expect(open).toEqual(["Test Scrip 01", "Test Scrip 66", "Test Scrip 67"]);
  });
});

describe("parseDhanGtr — against the broker's own totals", () => {
  const parsed = parseDhanGtr(ctx);
  const { reported } = readGtr(text);
  const r2 = (n: number) => Math.round(n * 100) / 100;

  it("reproduces the broker's total charges to within a rupee", () => {
    const charges = parsed.trades.reduce((s, t) => s + (t.reportedCharges?.total ?? 0), 0);
    expect(Math.abs(charges - reported.totalCharges)).toBeLessThan(1);
  });

  it("stores the BROKER'S charges, not computed ones", () => {
    // Every trade must carry a reported breakdown, or the truth-source promise
    // silently degrades back to estimates.
    expect(parsed.trades.every((t) => t.reportedCharges != null)).toBe(true);
  });

  it("accounts for the gross P&L gap exactly, via the unmatched holding", () => {
    // Matched gross differs from the footer by precisely the orphan's P&L.
    const matched = r2(parsed.trades.reduce((s, t) => s + t.grossPnl, 0));
    const orphan = parsed.trades.find((t) => t.basisUnknown)!;
    const impliedCost = (orphan.suggestedBasisPrice ?? 0) * orphan.sellQty;
    const orphanGross = orphan.sellValue - impliedCost;
    expect(matched + orphanGross).toBeCloseTo(reported.grossPnl, 0);
  });

  it("segregates delivery from intraday instead of assuming one", () => {
    const mix = parsed.trades.reduce<Record<string, number>>((a, t) => {
      const k = t.productHint ?? "unknown";
      a[k] = (a[k] ?? 0) + 1;
      return a;
    }, {});
    expect(mix.intraday).toBeGreaterThan(20);
    expect(mix.delivery).toBeGreaterThan(20);
    // Never MTF — it is not knowable from this file.
    expect(mix.mtf).toBeUndefined();
  });

  it("leaves execution times NULL — 00:00:00 is a settlement stamp, not a fill", () => {
    expect(parsed.trades.some((t) => t.entryTime != null)).toBe(false);
    expect(parsed.trades.some((t) => t.exitTime != null)).toBe(false);
  });

  it("gives every trade a real date, which the aggregated P&L file never could", () => {
    const closed = parsed.trades.filter((t) => t.buyQty === t.sellQty && !t.basisUnknown);
    expect(closed.length).toBeGreaterThan(50);
    expect(closed.every((t) => !!t.buyDate && !!t.sellDate)).toBe(true);
  });

  it("flags the one unmatched holding and recovers its cost from the footer", () => {
    const orphan = parsed.trades.filter((t) => t.basisUnknown);
    expect(orphan).toHaveLength(1);
    expect(orphan[0].tradingsymbol).toBe("Test Scrip 56");
    expect(orphan[0].buyValue).toBe(0);
    // ~Rs 598/share, derived purely from the footer's gross P&L.
    expect(orphan[0].suggestedBasisPrice).toBeGreaterThan(590);
    expect(orphan[0].suggestedBasisPrice).toBeLessThan(605);
  });

  it("warns about MTF rather than pretending it inferred it", () => {
    const w = parsed.warnings.join(" ");
    expect(w).toMatch(/MTF cannot be identified/i);
    expect(w).toMatch(/broker's own per-row figures/i);
    expect(w).toMatch(/IPO allotment/i);
  });

  it("reports the mixed bills it split, rather than splitting them quietly", () => {
    expect(parsed.warnings.join(" ")).toMatch(/mixed intraday and delivery/i);
  });

  it("marks the file as transaction-level so the importer treats it as one", () => {
    expect(parsed.format).toBe("transactions");
    expect(parsed.broker).toBe("dhan");
  });
});
