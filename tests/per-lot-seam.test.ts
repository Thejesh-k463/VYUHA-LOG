import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
// PURE (no DB, no React) — safe to import statically beside openTempDb.
import {
  isLotSegment, perLotAggregateResolved, perLotSecondLine, perLotUnknownNote, rPerLotLabel,
} from "@/lib/analytics/per-lot";
import { edgeMeasurable } from "@/lib/analytics/metrics";

/**
 * v4.4.0 D3 — THE PER-LOT SECOND LINE ACROSS THE SEAM.
 *
 * `tests/per-lot.test.ts` proves the maths on hand-built rows. This file proves
 * the two halves that ship it: `getDashboardTrades` resolves `lots`/`lotSource`
 * SERVER-side against a real database (the dated index table, the stored
 * `lot_size`), and the dashboard's own projection then divides them.
 *
 * WRONG looks like: a per-lot line that reconciles in the unit test and prints
 * "₹3,100 per lot" on screen because the wire never carried the lots — or one
 * that quietly averages the rows whose lot we happen to know.
 *
 * ONE temp database for the whole file (AGENTS.md Testing).
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

let t: TempDb;
let q: typeof import("@/lib/queries/trades");
let acct: number;

// Measured locally 2026-09-21: migrate + seed + the query import ~1.3 s.
beforeAll(async () => {
  t = await openTempDb("per-lot-seam", { seed: true });
  q = await import("@/lib/queries/trades");
  acct = t.db.select().from(t.schema.accounts).all()[0]!.id;
  t.db.update(t.schema.settings).set({ selectedAccountId: acct }).run();

  const fo = (over: Record<string, unknown>) => tradeRow({
    accountId: acct, isOpen: false, bucket: "fno", instrumentType: "option",
    symbol: "NIFTY", tradingsymbol: "NIFTY26MAR26000CE",
    avgBuyPrice: 100, avgSellPrice: 120, grossPnl: 0, chargesTotal: 0,
    buyValue: 10_000, sellValue: 10_000, sellDate: "2026-03-26",
    ...over,
  });

  t.db.insert(t.schema.trades).values([
    // index_option — BOTH rows resolvable: one off the dated bundled table
    // (expiry ≥ INDEX_LOTS_AS_OF), one off its own stored lot_size.
    fo({ segment: "index_option", expiry: "2026-03-26", lotSize: null, buyQty: 130, sellQty: 130,
      netPnl: 2600, grossPnl: 2600, riskAmount: 1300, rMultiple: 2, riskSource: "set", slPlanned: 90 }),
    fo({ segment: "index_option", expiry: "2026-03-26", lotSize: 65, buyQty: 195, sellQty: 195,
      netPnl: -1300, grossPnl: -1300, riskAmount: 1300, rMultiple: -1, riskSource: "cap" }),
    // future — one resolvable row and ONE Dec-2025 expiry with no stored lot:
    // the bundled 65 speaks for 2026-01-01 onward, so that row is unresolved and
    // the WHOLE line dashes.
    fo({ segment: "future", expiry: "2026-03-26", lotSize: null, buyQty: 65, sellQty: 65,
      netPnl: 500, grossPnl: 500, riskAmount: 500, rMultiple: 1, riskSource: "cap" }),
    fo({ segment: "future", expiry: "2025-12-24", lotSize: null, buyQty: 75, sellQty: 75,
      netPnl: -200, grossPnl: -200, riskAmount: 500, rMultiple: -0.4, riskSource: "cap" }),
  ] as never).run();
});

afterAll(() => t?.cleanup());

/** Exactly what components/dashboard/dashboard-client.tsx does with the wire. */
function dashAggregate(segment: string) {
  const pop = q.getDashboardTrades().filter((x) => x.segment === segment && !x.isOpen && edgeMeasurable(x));
  return {
    pop,
    agg: perLotAggregateResolved(pop.map((x) => ({
      lots: x.lots ?? null,
      lotSource: x.lotSource ?? null,
      netPnl: x.netPnl,
      riskAmount: x.riskAmount ?? null,
      rMultiple: x.rMultiple,
    }))),
  };
}

describe("the dashboard wire carries lots, and the line divides them", () => {
  it("per-lot × Σlots = Σnet to the paisa, and 1R names its per-lot rupees", () => {
    const { pop, agg } = dashAggregate("index_option");
    expect(pop.length, "both index_option rows reached the projection").toBe(2);
    // The wire itself: lots resolved server-side, each naming its source.
    expect(pop.map((x) => x.lots).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([2, 3]);
    expect(agg.sources).toEqual(["bundled (2026-01-01)", "trade"]);

    const net = pop.reduce((s, x) => s + x.netPnl, 0);
    expect(agg.lots).toBe(5);
    expect(agg.expectancyPerLot! * agg.lots!).toBeCloseTo(net, 2);
    expect(agg.expectancyPerLot).toBe(260);
    expect(rPerLotLabel(agg)).toBe("1R = ₹520 per lot");
    expect(perLotUnknownNote(agg)).toBeNull();
  });

  it("the second line prints the figures, the lot source AND where the R came from", () => {
    const { agg } = dashAggregate("index_option");
    const line = perLotSecondLine(agg, "1 plan-derived · 0 typed · 1 default-cap · 0 no R");
    expect(line).toContain("₹260 / lot");
    expect(line).toContain("1R = ₹520 per lot");
    expect(line).toContain("lots from bundled (2026-01-01), trade");
    // The design-review delta: a cap-unit R beside a per-lot figure is never
    // printed unlabelled (invariant 6).
    expect(line).toContain("1 default-cap");
  });

  it("ONE row the book cannot size dashes the WHOLE line and says k of N", () => {
    const { agg } = dashAggregate("future");
    expect(agg.total).toBe(2);
    expect(agg.unknown, "the Dec-2025 expiry with no stored lot_size").toBe(1);
    expect(agg.lots).toBeNull();
    expect(agg.expectancyPerLot).toBeNull();
    expect(agg.rupeesPerLotR).toBeNull();
    expect(perLotUnknownNote(agg)).toBe("lot size unknown on 1 of 2");
    expect(perLotSecondLine(agg, "")).toBe("Per lot: — · lot size unknown on 1 of 2");
  });

  it("the Dec-2025 NIFTY row itself is the unresolved one — not some other row", () => {
    const rows = q.getDashboardTrades().filter((x) => x.segment === "future");
    const byExpiry = new Map(rows.map((x) => [x.netPnl, x.lots]));
    expect(byExpiry.get(-200), "expiry 2025-12-24, no lot_size").toBeNull();
    expect(byExpiry.get(500), "expiry 2026-03-26, bundled 65").toBe(1);
  });

  it("equity segments get no per-lot line at all — a share is not a lot", () => {
    expect(isLotSegment("eq_delivery")).toBe(false);
    expect(isLotSegment("index_option")).toBe(true);
    expect(isLotSegment("future")).toBe(true);
  });
});

describe("both render sites print the SAME helper output", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

  it.each([
    ["components/dashboard/dashboard-client.tsx"],
    ["app/reports/edge/page.tsx"],
  ])("%s renders perLotSecondLine beside rProvenanceLine", (file) => {
    const src = read(file);
    expect(src, "the shared second line, not a hand-rolled one").toContain("perLotSecondLine(");
    expect(src, "the R provenance caption rides on the same line").toContain("rProvenanceLine(");
    expect(src).toContain("rProvenanceCounts(");
    // …and the population is the closed, priced rows of that segment only.
    expect(src).toMatch(/isLotSegment/);
  });

  it("the dashboard popups speak per-lot only under ONE F&O segment", () => {
    const src = read("components/dashboard/dashboard-client.tsx");
    expect(src).toContain("segment && isLotSegment(segment)");
    expect(src).toContain("Expectancy / lot");
    expect(src).toContain("rPerLotLabel(segPerLot.agg)");
  });

  it("the dashboard wire resolves lots server-side rather than shipping six columns", () => {
    const src = read("lib/queries/trades.ts");
    expect(src).toContain("lotsOf(");
    expect(src).toContain("lotSourceLabel(");
    expect(src).toContain("getIndexLotMap()");
  });
});
