import { describe, expect, it } from "vitest";
import { parseAisText, reconcileAis, withinTolerance, fyOfDate } from "../lib/analytics/ais";

describe("parseAisText", () => {
  it("parses typed lines with FY labels, dates, ₹ and commas", () => {
    const { rows, unparsed } = parseAisText(
      [
        "dividend, ATGL, 2026-27, ₹9,000, 900",
        "Sale of securities (SFT-18), NSDL, FY 2026-27, 12,50,000",
        "purchase, SFT-17, 2026-05-12, 1100000",
        "interest, SBI SAVINGS, 2026-27, 4210",
        "# comment line",
        "garbage line",
      ].join("\n"),
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ type: "dividend", party: "ATGL", fy: "2026-27", amount: 9000, tds: 900 });
    expect(rows[1]).toMatchObject({ type: "sale", amount: 1250000 });
    expect(rows[2]).toMatchObject({ type: "purchase", fy: "2026-27" });
    expect(unparsed).toEqual(["garbage line"]);
  });

  it("converts dates to the right Indian FY", () => {
    expect(fyOfDate("2026-03-31")).toBe("2025-26");
    expect(fyOfDate("2026-04-01")).toBe("2026-27");
  });
});

describe("withinTolerance", () => {
  it("allows max(₹10, 0.5%)", () => {
    expect(withinTolerance(1000, 1009)).toBe(true);
    expect(withinTolerance(1000, 1011)).toBe(false);
    expect(withinTolerance(1_000_000, 1_004_000)).toBe(true); // 0.4%
    expect(withinTolerance(1_000_000, 1_006_000)).toBe(false);
  });
});

describe("reconcileAis", () => {
  const jDivs = [
    { symbol: "ATGL", fy: "2026-27", gross: 9000, tds: 900 },
    { symbol: "TCS", fy: "2026-27", gross: 2400, tds: 0 },
  ];
  const jTotals = [{ fy: "2026-27", saleConsideration: 1250000, purchaseValue: 900000 }];

  it("matches dividends per company+FY and flags both directions", () => {
    const r = reconcileAis(
      parseAisText(
        ["dividend, ATGL, 2026-27, 9000, 900", "dividend, INFY, 2026-27, 5000, 500"].join("\n"),
      ),
      jDivs,
      jTotals,
    );
    const atgl = r.dividends.find((d) => d.key.startsWith("ATGL"))!;
    expect(atgl.status).toBe("matched");
    const infy = r.dividends.find((d) => d.key.startsWith("INFY"))!;
    expect(infy.status).toBe("missing_in_journal");
    const tcs = r.dividends.find((d) => d.key.startsWith("TCS"))!;
    expect(tcs.status).toBe("missing_in_ais");
    expect(r.counts.matched).toBeGreaterThanOrEqual(1);
  });

  it("resolves broker full names to tickers before matching", () => {
    const resolve = (s: string) => (s === "ADANI TOTAL GAS LIMITED" ? "ATGL" : s);
    const r = reconcileAis(
      parseAisText("dividend, ADANI TOTAL GAS LIMITED, 2026-27, 9000, 900"),
      jDivs,
      jTotals,
      resolve,
    );
    expect(r.dividends.find((d) => d.key.startsWith("ATGL"))!.status).toBe("matched");
  });

  it("reconciles per-FY sale/purchase totals with mismatch deltas", () => {
    const r = reconcileAis(
      parseAisText(["sale, SFT-18, 2026-27, 1250000", "purchase, SFT-17, 2026-27, 1000000"].join("\n")),
      [],
      jTotals,
    );
    const sale = r.fyTotals.find((t) => t.kind === "sale")!;
    expect(sale.status).toBe("matched");
    const buy = r.fyTotals.find((t) => t.kind === "purchase")!;
    expect(buy.status).toBe("mismatch");
    expect(buy.delta).toBe(100000);
  });

  it("aggregates multiple AIS rows for the same company+FY before comparing", () => {
    const r = reconcileAis(
      parseAisText(["dividend, ATGL, 2026-27, 4500, 450", "dividend, ATGL, 2026-27, 4500, 450"].join("\n")),
      jDivs,
      jTotals,
    );
    expect(r.dividends.find((d) => d.key.startsWith("ATGL"))!.status).toBe("matched");
  });

  it("keeps interest rows informational", () => {
    const r = reconcileAis(parseAisText("interest, SBI, 2026-27, 4210"), [], []);
    expect(r.interest).toHaveLength(1);
    expect(r.counts.mismatch).toBe(0);
  });
});
