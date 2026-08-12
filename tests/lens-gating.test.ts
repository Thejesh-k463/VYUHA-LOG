import { describe, expect, it } from "vitest";
import { toLensRow, type LensRow } from "@/lib/domain/lens-edge";
import { computeKpis, type AnalyticsTrade } from "@/lib/analytics/metrics";

/**
 * The Lenses hybrid gate is a statement about the WIRE, not about CSS: when
 * unlicensed, the Pro figures must not exist in the payload at all. These
 * tests serialise the split the way the RSC boundary will and assert the
 * absence — a blurred number would pass a render test and still be a leak.
 */

const trade = (over: Partial<AnalyticsTrade> = {}): AnalyticsTrade => ({
  broker: "dhan", bucket: "equity", segment: "eq_delivery",
  netPnl: 500, grossPnl: 520, chargesTotal: 20, rMultiple: 1.5,
  isOpen: false, sellDate: "2026-07-10", buyDate: "2026-07-01",
  setupTag: null,
  // edgeMeasurable needs a cost basis
  buyValue: 1000, sellValue: 1500,
  ...over,
} as AnalyticsTrade);

const kpisOf = (trades: AnalyticsTrade[]) => computeKpis(trades);

describe("the split is an allow-list", () => {
  it("free totals carry exactly the free fields — a new Kpis field lands nowhere by default", () => {
    const row = toLensRow(kpisOf([trade()]), false);
    expect(Object.keys(row.totals).sort()).toEqual(
      ["charges", "closedCount", "count", "netPnl", "openCount", "unpricedCount", "unpricedNetPnl"].sort(),
    );
    expect(row.edge).toBeNull();
  });

  it("pro edge carries exactly the pro fields", () => {
    const row = toLensRow(kpisOf([trade()]), true);
    expect(row.edge).not.toBeNull();
    expect(Object.keys(row.edge!).sort()).toEqual(
      ["avgR", "expectancy", "losses", "profitFactor", "winRate", "wins"].sort(),
    );
  });
});

describe("the serialisation proof", () => {
  it("an unlicensed payload contains no Pro field name and no Pro value", () => {
    const trades = [trade({ netPnl: 777 }), trade({ netPnl: -333 })];
    const k = kpisOf(trades);
    const wire = JSON.stringify(toLensRow(k, false));
    for (const field of ["winRate", "profitFactor", "expectancy", "avgR", "wins", "losses"]) {
      expect(wire, `${field} leaked to an unlicensed client`).not.toContain(field);
    }
    // The expectancy value itself must be absent too, not just its label.
    expect(wire).not.toContain(String(k.expectancy));
    expect(wire).toContain('"edge":null');
  });

  it("a licensed row's edge matches computeKpis exactly — the gate changes visibility, never the maths", () => {
    const trades = [trade({ netPnl: 800 }), trade({ netPnl: -200 })];
    const k = kpisOf(trades);
    const row = toLensRow(k, true);
    expect(row.edge!.winRate).toBe(k.winRate);
    expect(row.edge!.expectancy).toBe(k.expectancy);
    expect(row.edge!.wins).toBe(k.wins);
  });
});

describe("the Infinity trap", () => {
  it("a group with no losing trade round-trips through JSON unchanged", () => {
    // profitFactor is grossWins/grossLosses = Infinity with zero losers. This
    // value now CROSSES the RSC payload, where JSON silently turns Infinity
    // into null — normalise it deliberately at the boundary instead.
    const k = kpisOf([trade({ netPnl: 100 }), trade({ netPnl: 200 })]);
    const row = toLensRow(k, true);
    expect(row.edge!.profitFactor).toBeNull(); // normalised, not Infinity
    const roundTripped = JSON.parse(JSON.stringify(row)) as LensRow;
    expect(roundTripped).toEqual(row);
  });
});
