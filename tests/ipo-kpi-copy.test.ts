import { describe, it, expect } from "vitest";
import { computeIpo, summariseIpos, type IpoInput } from "@/lib/analytics/ipo";
import { realisedNetScope } from "@/components/ipo/ipo-client";

/**
 * IPO-KPI (v4.3.0 wave 2F). The 'Realised net' popup read "Across N exited
 * IPOs" with N = exitedCount, a STATUS count, while realisedNet and estTax add
 * priced exits only (an exit with no readable exit date, N13, carries no net and
 * no tax). Measured before, for one priced + one unpriced exit: "Across 2 exited
 * IPOs." Now the popup names the priced exits the figure is made of, and says
 * how many exits are not in it: a count, never a figure (invariant 6).
 */
function ipo(p: Partial<IpoInput>): IpoInput {
  return {
    id: 1, name: "TEST IPO", broker: "zerodha", exchange: "NSE",
    appliedPrice: 100, lotSize: 50, lotsApplied: 2,
    allotted: false, allottedQty: 0, listingPrice: null, exitPrice: null, ...p,
  };
}

const priced = (id: number) => computeIpo(ipo({ id, allotted: true, allottedQty: 50, exitPrice: 140, allotmentDate: "2026-06-20", exitDate: "2026-06-25" }));
const unpriced = (id: number) => computeIpo(ipo({ id, allotted: true, allottedQty: 50, exitPrice: 150, exitDate: "15-03-2011" }));
const holding = (id: number) => computeIpo(ipo({ id, lotsApplied: 1, allotted: true, allottedQty: 50, listingPrice: 120 }));

describe("the 'Realised net' popup names the exits its figure is made of (IPO-KPI)", () => {
  it("one priced + one unpriced exit: the priced count, then the unpriced count kept out of the figure", () => {
    const s = summariseIpos([priced(1), unpriced(2), holding(3)]);
    expect(s.exitedCount).toBe(2);
    expect(realisedNetScope(s)).toBe("Across 1 priced exit. 1 exit has no readable exit date and is not in this figure.");
  });

  it("every exit priced: the priced count alone, no unpriced sentence", () => {
    expect(realisedNetScope(summariseIpos([priced(1), priced(2), holding(3)]))).toBe("Across 2 priced exits.");
  });

  it("no exit priced: zero priced exits, and the unpriced ones named by count, never a figure", () => {
    const line = realisedNetScope(summariseIpos([unpriced(1), unpriced(2)]));
    expect(line).toBe("Across 0 priced exits. 2 exits have no readable exit date and are not in this figure.");
    expect(line).not.toMatch(/₹|\b(recommend|suggest|should|consider|buy|sell)\b/i);
  });
});
