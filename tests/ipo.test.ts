import { describe, it, expect } from "vitest";
import { computeIpo, summariseIpos, ipoSellCharges, type IpoInput } from "@/lib/analytics/ipo";

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
});
