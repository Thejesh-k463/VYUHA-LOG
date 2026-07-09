import { describe, it, expect } from "vitest";
import { computeIpo, summariseIpos, ipoSellCharges, ipoTaxEstimate, type IpoInput } from "@/lib/analytics/ipo";

function ipo(p: Partial<IpoInput>): IpoInput {
  return {
    id: 1, name: "TEST IPO", broker: "zerodha", exchange: "NSE",
    appliedPrice: 100, lotSize: 50, lotsApplied: 2,
    allotted: false, allottedQty: 0, listingPrice: null, exitPrice: null, ...p,
  };
}

describe("computeIpo", () => {
  it("exited IPO: realised net P&L after sell charges", () => {
    const c = computeIpo(ipo({ allotted: true, allottedQty: 50, listingPrice: 130, exitPrice: 140 }));
    expect(c.status).toBe("exited");
    expect(c.applicationAmount).toBe(10000); // 100×50×2 blocked
    expect(c.investedAllotted).toBe(5000); // 100×50 allotted
    expect(c.listingGain).toBe(1500); // (130−100)×50
    expect(c.grossPnl).toBe(2000); // (140−100)×50
    expect(c.charges).toBeCloseTo(23.59, 1);
    expect(c.netPnl).toBeCloseTo(1976.41, 1);
    expect(c.realised).toBe(true);
    expect(c.returnPct).toBeCloseTo(39.53, 1);
  });

  it("listed (holding): unrealised mark-to-listing, not realised", () => {
    const c = computeIpo(ipo({ lotsApplied: 1, allotted: true, allottedQty: 50, listingPrice: 120 }));
    expect(c.status).toBe("listed");
    expect(c.unrealised).toBe(1000); // (120−100)×50
    expect(c.netPnl).toBe(0);
    expect(c.realised).toBe(false);
    expect(c.returnPct).toBe(20);
  });

  it("not allotted: zero P&L, application returned", () => {
    const c = computeIpo(ipo({ allotted: false, listingPrice: 130 }));
    expect(c.status).toBe("not_allotted");
    expect(c.allottedQty).toBe(0);
    expect(c.grossPnl).toBe(0);
    expect(c.unrealised).toBe(0);
    expect(c.listingGain).toBeNull();
  });

  it("allotted, awaiting listing", () => {
    const c = computeIpo(ipo({ allotted: true, allottedQty: 50 }));
    expect(c.status).toBe("allotted");
    expect(c.unrealised).toBe(0);
  });
});

describe("computeIpo — v2: discount cost basis, refund, board", () => {
  it("employee discount lowers the cost basis everywhere (application, invested, P&L)", () => {
    // issue 100, discount 10 → effective cost 90
    const c = computeIpo(ipo({ discountPerShare: 10, category: "employee", allotted: true, allottedQty: 50, exitPrice: 140, exitDate: "2026-07-01", allotmentDate: "2026-06-20" }));
    expect(c.effectiveCost).toBe(90);
    expect(c.applicationAmount).toBe(9000); // 90×50×2
    expect(c.investedAllotted).toBe(4500); // 90×50
    expect(c.grossPnl).toBe(2500); // (140−90)×50
  });

  it("refund = application − invested (partial allotment), full when not allotted", () => {
    const partial = computeIpo(ipo({ allotted: true, allottedQty: 50 })); // applied 2 lots, got 1
    expect(partial.refundAmount).toBe(5000); // 10000 − 5000
    const none = computeIpo(ipo({ allotted: false }));
    expect(none.refundAmount).toBe(10000); // everything back
  });

  it("board defaults to mainboard; sme passes through", () => {
    expect(computeIpo(ipo({})).board).toBe("mainboard");
    expect(computeIpo(ipo({ board: "sme" })).board).toBe("sme");
  });
});

describe("ipoTaxEstimate — STCG/LTCG on exit", () => {
  it("listing-day flip = STCG at the post-cutover 20% rate", () => {
    const c = computeIpo(ipo({ allotted: true, allottedQty: 50, exitPrice: 140, allotmentDate: "2026-06-20", exitDate: "2026-06-25" }));
    expect(c.tax).not.toBeNull();
    expect(c.tax!.term).toBe("ST");
    expect(c.tax!.ratePct).toBe(20);
    expect(c.tax!.estTax).toBeCloseTo(c.netPnl * 0.2, 1);
    expect(c.tax!.postTaxNet).toBeCloseTo(c.netPnl - c.tax!.estTax, 1);
  });

  it("held ≥365 days = LTCG at 12.5%", () => {
    const c = computeIpo(ipo({ allotted: true, allottedQty: 50, exitPrice: 140, allotmentDate: "2025-06-01", exitDate: "2026-07-01" }));
    expect(c.tax!.term).toBe("LT");
    expect(c.tax!.ratePct).toBe(12.5);
  });

  it("pre-cutover exit uses the old 15% STCG rate", () => {
    const t = ipoTaxEstimate(1000, "2024-05-01", "2024-07-01");
    expect(t.ratePct).toBe(15);
    expect(t.estTax).toBe(150);
  });

  it("a loss owes no tax and is flagged as a set-off-able capital loss", () => {
    const t = ipoTaxEstimate(-500, "2026-06-20", "2026-06-25");
    expect(t.estTax).toBe(0);
    expect(t.isLoss).toBe(true);
    expect(t.postTaxNet).toBe(-500);
  });

  it("falls back allotment→listing→applied for the acquisition date", () => {
    // no allotmentDate; listingDate old enough to make it LT
    const c = computeIpo(ipo({ allotted: true, allottedQty: 50, exitPrice: 140, listingDate: "2025-01-01", exitDate: "2026-07-01" }));
    expect(c.tax!.acquisitionDate).toBe("2025-01-01");
    expect(c.tax!.term).toBe("LT");
  });

  it("no tax object until exited", () => {
    expect(computeIpo(ipo({ allotted: true, allottedQty: 50, listingPrice: 120 })).tax).toBeNull();
    expect(computeIpo(ipo({ allotted: false })).tax).toBeNull();
  });
});

describe("ipoSellCharges", () => {
  it("delivery-sell estimate (STT + exchange + SEBI + stamp + DP + GST)", () => {
    expect(ipoSellCharges(7000, 5000)).toBeCloseTo(23.59, 1);
    expect(ipoSellCharges(0, 0)).toBe(0);
  });
});

describe("summariseIpos", () => {
  it("aggregates realised, unrealised and counts", () => {
    const list = [
      computeIpo(ipo({ id: 1, allotted: true, allottedQty: 50, listingPrice: 130, exitPrice: 140 })),
      computeIpo(ipo({ id: 2, lotsApplied: 1, allotted: true, allottedQty: 50, listingPrice: 120 })),
      computeIpo(ipo({ id: 3, allotted: false })),
    ];
    const s = summariseIpos(list);
    expect(s.count).toBe(3);
    expect(s.allottedCount).toBe(2);
    expect(s.notAllottedCount).toBe(1);
    expect(s.exitedCount).toBe(1);
    expect(s.listedCount).toBe(1);
    expect(s.realisedNet).toBeCloseTo(1976.41, 1);
    expect(s.unrealised).toBe(1000);
  });

  it("aggregates estimated tax and post-tax net across exited IPOs", () => {
    const list = [
      computeIpo(ipo({ id: 1, allotted: true, allottedQty: 50, exitPrice: 140, allotmentDate: "2026-06-20", exitDate: "2026-06-25" })),
      computeIpo(ipo({ id: 2, lotsApplied: 1, allotted: true, allottedQty: 50, listingPrice: 120 })),
    ];
    const s = summariseIpos(list);
    expect(s.estTax).toBeCloseTo(list[0].tax!.estTax, 1);
    expect(s.postTaxNet).toBeCloseTo(s.realisedNet - s.estTax, 1);
  });
});
