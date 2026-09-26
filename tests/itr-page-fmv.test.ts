import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { aggregateTradesByFy, fmvTotalOf } from "@/lib/analytics/capital-gains";
import { itrPageInputs } from "@/lib/analytics/itr";
import { itrScheduleByFy } from "@/lib/analytics/itr-schedule";

/**
 * MO-3 (v4.6.0 fix wave, HIGH) — /reports/itr passed the stored 31-Jan-2018 FMV
 * RAW (per share) into the set-off engine and the schedule, whose
 * `grandfatheredCost(buyValue, fmv, sellValue)` reads a TOTAL. Every other tax
 * surface multiplies by `buyQty`. One lot: 100 shares bought at ₹100 in 2016,
 * FMV ₹250 on 31-Jan-2018, sold for ₹30,000 → grandfathered cost
 * max(10,000, min(25,000, 30,000)) = 25,000 → LTCG (s.112A) ₹5,000 by hand.
 * The ITR page said ₹20,000 (the FMV 250 was below the actual cost 10,000).
 *
 * Both surfaces are read through their REAL code: /reports/tax through
 * `getTaxBase().cgTrades`, /reports/itr through `itrPageInputs` — the pure
 * function the page itself calls — over the same realised rows the page reads.
 */

let t: TempDb;
let taxItr: typeof import("@/lib/queries/tax-itr");
let tradesQ: typeof import("@/lib/queries/trades");
let realisedQ: typeof import("@/lib/queries/realised-rows");

beforeAll(async () => {
  t = await openTempDb("itr-page-fmv");
  taxItr = await import("@/lib/queries/tax-itr");
  tradesQ = await import("@/lib/queries/trades");
  realisedQ = await import("@/lib/queries/realised-rows");
  t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        accountId: 1, symbol: "GFLOT", tradingsymbol: "GFLOT", segment: "eq_delivery",
        buyQty: 100, sellQty: 100, avgBuyPrice: 100, avgSellPrice: 300,
        buyValue: 10_000, sellValue: 30_000, grossPnl: 20_000, netPnl: 20_000, chargesTotal: 0,
        buyDate: "2016-05-10", sellDate: "2025-06-10", isOpen: false, side: "long",
        fmv31Jan2018: 250,
      }),
    )
    .run();
  t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();
});
afterAll(() => t?.cleanup());

const FY = "2025-26";

describe("MO-3 · a grandfathered lot states ONE LTCG on /reports/tax and /reports/itr", () => {
  it("fmvTotalOf scales the per-share FMV by the row's quantity, once", () => {
    expect(fmvTotalOf({ fmv31Jan2018: 250, buyQty: 100 })).toBe(25_000);
    expect(fmvTotalOf({ fmv31Jan2018: null, buyQty: 100 })).toBeNull();
    expect(fmvTotalOf({ fmv31Jan2018: 250, buyQty: 0 })).toBeNull();
  });

  it("/reports/tax (getTaxBase → the set-off engine) and /reports/itr (itrPageInputs) both state ₹5,000 LTCG 112A", () => {
    const { cgTrades } = taxItr.getTaxBase(null);
    const taxFy = aggregateTradesByFy(cgTrades, 4, FY).find((f) => f.fy === FY);
    expect(taxFy?.ltcg112A, "/reports/tax").toBe(5_000);

    const realised = realisedQ.getRealisedRows(tradesQ.getTrades([1]));
    const inputs = itrPageInputs(realised);
    const itrFy = aggregateTradesByFy(inputs.capitalGains, 4, FY).find((f) => f.fy === FY);
    expect(itrFy?.ltcg112A, "/reports/itr set-off engine").toBe(5_000);

    const sched = itrScheduleByFy(inputs.schedule, 4, FY).find((s) => s.fy === FY);
    const cg = sched?.lines.filter((l) => l.schedule === "Schedule CG") ?? [];
    // The schedule states the grandfathered COST (25,000), not the per-share 250.
    expect(cg.some((l) => l.amount === 25_000), JSON.stringify(cg.map((l) => [l.code, l.amount]))).toBe(true);
  });
});
