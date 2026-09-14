import { describe, it, expect } from "vitest";
import { computeIpo, summariseIpos, ipoSellCharges, ipoTaxEstimate, type IpoInput } from "@/lib/analytics/ipo";
import { computeCharges } from "@/lib/engine/charges";
import { seedRatesMap, statutoryRatesFor } from "@/lib/engine/rates";
import type { ChargeRates } from "@/lib/engine/types";

function ipo(p: Partial<IpoInput>): IpoInput {
  return {
    id: 1, name: "TEST IPO", broker: "zerodha", exchange: "NSE",
    appliedPrice: 100, lotSize: 50, lotsApplied: 2,
    allotted: false, allottedQty: 0, listingPrice: null, exitPrice: null, ...p,
  };
}

describe("the charger is injected — invariant 3, defect D4", () => {
  it("an injected charger's figure lands in netPnl, replacing the static estimate", () => {
    // The server injects a charge_config-backed charger; with none injected,
    // computeIpo prices from the seed's statutory row (no frozen rates, R36).
    const flat = () => 100;
    const c = computeIpo(ipo({ allotted: true, allottedQty: 50, exitPrice: 140 }), flat);
    expect(c.charges).toBe(100);
    expect(c.netPnl).toBe(2000 - 100);
  });

  it("without an injection the fallback prices from the seed's statutory row (no frozen constants)", () => {
    const c = computeIpo(ipo({ allotted: true, allottedQty: 50, exitPrice: 140 }));
    // Re-pinned (R36): 23.59 before (frozen rates + a flat DP 15.34), 8.26 after
    // (STT 7 + exchange/IPFT 0.21 + SEBI 0.01 + GST 0.04 + stamp 1; no DP).
    // Re-pinned (N14, measured 8.26 → 7.26): no date is known, so the allotment
    // reads as today's, after 1 Jul 2020 — the issuer bears its stamp, not the allottee.
    expect(c.charges).toBe(7.26);
  });

  it("engine parity: a real rates row prices the exit like any delivery sell with no buy brokerage", () => {
    // An injected engine charger reaches computeIpo unchanged; zero buy orders
    // mean a flat-fee broker contributes only sell-side brokerage. This inline
    // charger is NOT the production broker path: lib/queries/ipos.ts prices
    // exchange txn / SEBI / IPFT and their GST on the sale only (W2-IPO2),
    // pinned in tests/ipo-exit-rates.test.ts.
    const rates: ChargeRates = {
      broker: "zerodha", plan: "default", planLabel: null, subscriptionMonthly: 0,
      segment: "eq_delivery", exchange: "NSE",
      brokerageFlat: 20, brokeragePct: 0, brokerageCap: null, brokerageFloor: 0,
      sttPct: 0.001, sttSide: "sell", exchangeTxnPct: 0.0000297, sebiPct: 0.000001,
      stampPct: 0.00015, ipftPct: 0, gstPct: 0.18,
      dpCharge: 15.34, dpPct: 0, dpGstApplicable: false, dpMinValue: 0,
      mtfInterestAnnual: 0, mtfRateUnknown: false, mtfTiers: null,
      pledgeCharge: 0, unpledgeCharge: 0,
    };
    const engine = computeCharges(
      { segment: "eq_delivery", buyValue: 5000, sellValue: 7000, buyQty: 1, sellQty: 1, buyOrderCount: 0, sellOrderCount: 1 },
      rates,
    );
    expect(engine.brokerage).toBe(20); // sell side only — no buy order
    expect(engine.stampDuty).toBe(Math.round(0.00015 * 5000)); // on the allotment
    // allotmentDate before 1 Jul 2020 so computeIpo hands the charger the allotment's
    // value as its stamp base (N14); undated, it now hands 0 and the total read 46.20.
    const c = computeIpo(
      ipo({ allotted: true, allottedQty: 50, exitPrice: 140, allotmentDate: "2020-06-15" }),
      (sellValue, allottedValue) =>
        computeCharges({ segment: "eq_delivery", buyValue: allottedValue, sellValue, buyQty: 1, sellQty: 1, buyOrderCount: 0, sellOrderCount: 1 }, rates).total,
    );
    expect(c.charges).toBe(engine.total);
  });
});

describe("computeIpo", () => {
  it("exited IPO: realised net P&L after sell charges", () => {
    const c = computeIpo(ipo({ allotted: true, allottedQty: 50, listingPrice: 130, exitPrice: 140 }));
    expect(c.status).toBe("exited");
    expect(c.applicationAmount).toBe(10000); // 100×50×2 blocked
    expect(c.investedAllotted).toBe(5000); // 100×50 allotted
    expect(c.listingGain).toBe(1500); // (130−100)×50
    expect(c.grossPnl).toBe(2000); // (140−100)×50
    // Re-pinned (R36) to the engine fallback: charges 23.59 → 8.26, net
    // 1976.41 → 1991.74, return 39.53 → 39.83 (the frozen DP 15.34 is gone).
    // Re-pinned (N14, measured): charges 8.26 → 7.26, net 1991.74 → 1992.74,
    // return 39.83 → 39.85 — an undated allotment reads as after 1 Jul 2020, no allottee stamp.
    expect(c.charges).toBeCloseTo(7.26, 1);
    expect(c.netPnl).toBeCloseTo(1992.74, 1);
    expect(c.realised).toBe(true);
    expect(c.returnPct).toBeCloseTo(39.85, 1);
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
  it("engine wrapper over the statutory row (STT on the sale + exchange/IPFT/SEBI + GST + stamp on the allotment)", () => {
    const stat = statutoryRatesFor(seedRatesMap(), "eq_delivery", "NSE", "2026-06-15");
    // Re-pinned (R36): the frozen estimate gave 23.59 (with DP 15.34); the engine gives 8.26.
    expect(ipoSellCharges(7000, 5000, stat)).toBe(8.26);
    expect(ipoSellCharges(0, 0, stat)).toBe(0);
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
    // re-pinned (R36): 1976.41 before, the frozen DP gone; re-pinned (N14, measured 1991.74 → 1992.74): no allottee stamp
    expect(s.realisedNet).toBeCloseTo(1992.74, 1);
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

  /**
   * IPO-KPI (v4.3.0 wave 2F). The 'Realised net' popup read "Across N exited
   * IPOs" with N counted by STATUS, while an exit whose date cannot be priced
   * (N13: no charges, net "—") adds nothing to realisedNet or estTax — so N
   * named IPOs the figure does not cover. The summary now counts the PRICED
   * exits the realised figures are made of, and the unpriced ones separately,
   * so the popup can name how many are not priced instead of folding them into
   * a figure (invariant 6). exitedCount stays the status count: the "where they
   * stand" popup lists every exit.
   */
  it("counts priced and unpriced exits apart; the realised figures are made of the priced ones only (IPO-KPI)", () => {
    const priced = computeIpo(ipo({ id: 1, allotted: true, allottedQty: 50, exitPrice: 140, allotmentDate: "2026-06-20", exitDate: "2026-06-25" }));
    const unpriced = computeIpo(ipo({ id: 2, allotted: true, allottedQty: 50, exitPrice: 150, exitDate: "15-03-2011" }));
    const holding = computeIpo(ipo({ id: 3, lotsApplied: 1, allotted: true, allottedQty: 50, listingPrice: 120 }));
    expect([priced.realised, unpriced.unpriced]).toEqual([true, true]);
    const s = summariseIpos([priced, unpriced, holding]);
    expect(s.exitedCount).toBe(2); // by status — the "where they stand" popup
    expect(s.pricedExitCount).toBe(1);
    expect(s.unpricedExitCount).toBe(1);
    expect(s.realisedNet).toBe(priced.netPnl);
    expect(s.estTax).toBe(priced.tax!.estTax);
    // No unpriced exit: every exit is priced.
    const clean = summariseIpos([priced, holding]);
    expect([clean.exitedCount, clean.pricedExitCount, clean.unpricedExitCount]).toEqual([1, 1, 0]);
  });
});
