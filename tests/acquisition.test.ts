import { describe, it, expect } from "vitest";
import {
  hasKnownBasis, unknownBasisTrades, basisCompleteTrades, applyBasis,
  summariseAcquisitions, ipoAllottedPnl, type BasisTrade,
} from "@/lib/analytics/acquisition";

let id = 1;
const t = (p: Partial<BasisTrade> = {}): BasisTrade => ({
  id: p.id ?? id++,
  symbol: "TEST",
  sellValue: 0, buyValue: 0, sellQty: 0, netPnl: 0, chargesTotal: 0,
  sellDate: "2026-07-22", acquisition: null, acquisitionPrice: null, acquisitionDate: null,
  ...p,
});

describe("hasKnownBasis", () => {
  it("an ordinary bought-and-sold trade always has a basis", () => {
    expect(hasKnownBasis({ acquisition: null, acquisitionPrice: null, buyValue: 10000 })).toBe(true);
  });

  it("a flagged trade with no buy value and no supplied price does NOT", () => {
    expect(hasKnownBasis({ acquisition: "unknown", acquisitionPrice: null, buyValue: 0 })).toBe(false);
  });

  it("accepts a supplied price of exactly zero — bonus shares really do cost nothing", () => {
    // Refusing 0 would make bonus/split credits permanently unreportable.
    expect(hasKnownBasis({ acquisition: "bonus", acquisitionPrice: 0, buyValue: 0 })).toBe(true);
  });

  it("accepts a flagged trade that later acquired a real buy value", () => {
    expect(hasKnownBasis({ acquisition: "ipo", acquisitionPrice: null, buyValue: 12000 })).toBe(true);
  });
});

describe("the fabrication this exists to prevent", () => {
  it("holds an unpriced IPO flip out of the edge statistics", () => {
    // SBI Funds Management: sold 37 for Rs 21,904, never bought in the window.
    // Arithmetically this is a 100% win. It is not a win at all.
    const book = [
      t({ symbol: "SBI Funds Management", acquisition: "unknown", sellQty: 37, sellValue: 21904, netPnl: 21881 }),
      t({ symbol: "GM Breweries", buyValue: 643353, sellValue: 635921, netPnl: -8883 }),
    ];
    expect(unknownBasisTrades(book)).toHaveLength(1);
    const usable = basisCompleteTrades(book);
    expect(usable).toHaveLength(1);
    expect(usable[0].symbol).toBe("GM Breweries");
    // The only trade left is a loser, so a naive win rate of 50% collapses to 0%.
    expect(usable.filter((x) => x.netPnl > 0)).toHaveLength(0);
  });

  it("returns the trade to the statistics once a basis is supplied", () => {
    const book = [t({ acquisition: "ipo", acquisitionPrice: 500, sellQty: 37, sellValue: 21904 })];
    expect(unknownBasisTrades(book)).toHaveLength(0);
    expect(basisCompleteTrades(book)).toHaveLength(1);
  });
});

describe("applyBasis", () => {
  it("derives buy value and corrects P&L, leaving charges untouched", () => {
    const r = applyBasis({ sellQty: 37, sellValue: 21904, chargesTotal: 22.72 }, 500);
    expect(r.buyValue).toBe(18500);
    expect(r.grossPnl).toBe(3404);
    expect(r.netPnl).toBeCloseTo(3381.28, 2);
  });

  it("handles a zero basis without producing Infinity or NaN", () => {
    const r = applyBasis({ sellQty: 10, sellValue: 5000, chargesTotal: 10 }, 0);
    expect(r.buyValue).toBe(0);
    expect(Number.isFinite(r.netPnl)).toBe(true);
    expect(r.netPnl).toBe(4990);
  });
});

describe("summariseAcquisitions", () => {
  it("separates pending from resolved and totals only the pending cash", () => {
    const s = summariseAcquisitions([
      t({ acquisition: "unknown", sellValue: 21904, chargesTotal: 22 }),
      t({ acquisition: "ipo", acquisitionPrice: 300, sellQty: 50, sellValue: 20000, chargesTotal: 18 }),
      t({ acquisition: "bonus", acquisitionPrice: 0, sellValue: 5000, chargesTotal: 5 }),
      t({ buyValue: 1000, sellValue: 1100 }), // ordinary trade, not flagged
    ]);
    expect(s.total).toBe(3);
    expect(s.pending).toBe(1);
    expect(s.resolved).toBe(2);
    expect(s.pendingProceeds).toBe(21904);
    expect(s.pendingCharges).toBe(22);
    expect(s.byKind.map((k) => k.kind).sort()).toEqual(["bonus", "ipo", "unknown"]);
  });

  it("returns zeroes for a book with no flagged trades", () => {
    const s = summariseAcquisitions([t({ buyValue: 100, sellValue: 110 })]);
    expect(s).toMatchObject({ total: 0, pending: 0, resolved: 0, pendingProceeds: 0 });
    expect(s.byKind).toEqual([]);
  });
});

describe("ipoAllottedPnl — kept separate from trading edge on purpose", () => {
  it("reports proceeds, cost and net for priced allotments only", () => {
    const r = ipoAllottedPnl([
      t({ acquisition: "ipo", acquisitionPrice: 300, sellQty: 50, sellValue: 20000, chargesTotal: 18 }),
      t({ acquisition: "ipo", acquisitionPrice: null, sellQty: 37, sellValue: 21904 }), // unpriced
      t({ acquisition: "unknown", sellValue: 999 }), // not an IPO
    ]);
    expect(r.trades).toBe(1);
    expect(r.cost).toBe(15000);
    expect(r.proceeds).toBe(20000);
    expect(r.netPnl).toBe(4982);
    // The unpriced one is counted as pending, never folded into the totals.
    expect(r.pending).toBe(1);
  });

  it("uses a real buy value when one exists, not the supplied price", () => {
    const r = ipoAllottedPnl([
      t({ acquisition: "ipo", buyValue: 16000, acquisitionPrice: 300, sellQty: 50, sellValue: 20000, chargesTotal: 0 }),
    ]);
    expect(r.cost).toBe(16000);
  });

  it("is safe on an empty book", () => {
    expect(ipoAllottedPnl([])).toMatchObject({ trades: 0, netPnl: 0, pending: 0 });
  });
});

/**
 * The rule has to hold in the ANALYTICS, not just in the helper. These pin the
 * two engines that would otherwise turn an unpriced sale into a 100% winner.
 */
describe("the basis rule reaches the analytics engines", () => {
  it("computeKpis counts unpriced cash but keeps it out of the ratios", async () => {
    const { computeKpis } = await import("@/lib/analytics/metrics");
    const base = {
      broker: "dhan", bucket: "equity", segment: "eq_delivery", rMultiple: null,
      isOpen: false, sellDate: "2026-07-22", buyDate: "2026-07-01", setupTag: null,
    };
    const k = computeKpis([
      // A real loser.
      { ...base, netPnl: -8883, grossPnl: -7432, chargesTotal: 1451, buyValue: 643353 },
      // An unpriced IPO sale: buyValue 0 makes this look like a 100% winner.
      { ...base, netPnl: 21881, grossPnl: 21904, chargesTotal: 23, buyValue: 0, acquisition: "unknown", acquisitionPrice: null },
    ]);

    // Cash is honest: both trades are in the net.
    expect(k.netPnl).toBe(12998);
    // The ratios are protected: one measurable trade, and it lost.
    expect(k.wins).toBe(0);
    expect(k.winRate).toBe(0);
    expect(k.expectancy).toBe(-8883);
    expect(k.unpricedCount).toBe(1);
    expect(k.unpricedNetPnl).toBe(21881);
  });

  it("computeKpis restores the trade once a basis is supplied", async () => {
    const { computeKpis } = await import("@/lib/analytics/metrics");
    const base = {
      broker: "dhan", bucket: "equity", segment: "eq_delivery", rMultiple: null,
      isOpen: false, sellDate: "2026-07-22", buyDate: null, setupTag: null,
    };
    const k = computeKpis([
      { ...base, netPnl: 3381, grossPnl: 3404, chargesTotal: 23, buyValue: 0, acquisition: "ipo", acquisitionPrice: 598 },
    ]);
    expect(k.unpricedCount).toBe(0);
    expect(k.wins).toBe(1);
    expect(k.winRate).toBe(1);
  });

  it("cockpitReport drops unpriced trades from every panel and says how many", async () => {
    const { cockpitReport } = await import("@/lib/analytics/cockpit");
    const t = (p: Record<string, unknown>) => ({
      id: 1, symbol: "X", segment: "eq_delivery", netPnl: 0, buyValue: 100000, sellValue: 100000,
      buyDate: "2026-07-01", sellDate: "2026-07-02", entryTime: null, exitTime: null,
      isOpen: false, rMultiple: null, ...p,
    });
    const rep = cockpitReport([
      t({ id: 1, netPnl: -500 }),
      t({ id: 2, netPnl: -300 }),
      t({ id: 3, netPnl: 21881, buyValue: 0, acquisition: "unknown", acquisitionPrice: null }),
    ] as never);

    expect(rep.excludedUnpriced).toBe(1);
    expect(rep.closedTrades).toBe(2);
    // The segment scorecard must not show the phantom winner.
    const seg = rep.segments.find((s) => s.key === "eq_delivery")!;
    expect(seg.trades).toBe(2);
    expect(seg.winRate).toBe(0);
  });
});
