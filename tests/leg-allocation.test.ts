import { describe, expect, it } from "vitest";
import { pairSymbolLegs, type Leg } from "@/lib/import/pair-legs";
import { allocateSymbolLegs, executionsByAllocation, matchAllocations } from "@/lib/import/leg-allocation";
import type { Execution } from "@/lib/engine/types";

/**
 * v4.6.0 W6 (contract D4, design review R-2 of D3b) — `allocateSymbolLegs`
 * mirrors pair-legs' pending short lots, so `matchAllocations` finds a closed
 * overnight short (buyDate = the cover, sellDate = the sale) and the ladder,
 * the times and a stated bill's heads survive. Before W6 it knew buy lots only
 * and returned `null` for any short shape.
 */

const SYM = "BANKNIFTY26SEP52000PE";
const leg = (p: Partial<Leg> & Pick<Leg, "side" | "date" | "qty" | "value">): Leg => ({ symbol: SYM, charges: 0, ...p });

describe("allocateSymbolLegs shortable — mirrors pairLegs", () => {
  const s1 = leg({ side: "sell", date: "2026-09-01", qty: 30, value: 3000 });
  const s2 = leg({ side: "sell", date: "2026-09-02", qty: 30, value: 3300 });
  const b3 = leg({ side: "buy", date: "2026-09-03", qty: 45, value: 2700 });
  const legs = [s1, s2, b3];

  it("every paired position finds its allocation — a closed short and the opening sell it left", () => {
    const paired = pairSymbolLegs(legs, { shortable: true });
    const allocs = allocateSymbolLegs(legs, { shortable: true });
    const matched = matchAllocations(paired, allocs);
    expect(matched.every((a) => a != null)).toBe(true);
    const short = matched[paired.findIndex((p) => p.kind === "closed")]!;
    expect(short.side).toBe("short");
    expect(short.buys.map((b) => [b.leg, b.qty])).toEqual([[b3, 45]]);
    // The seeded pass (pair-legs' pre-file lot, the OLDEST) owns the 15 no buy
    // covered — so it is the FIRST sale's 15 that stays an opening sell.
    expect(short.sells.map((s) => [s.leg, s.qty])).toEqual([[s1, 15], [s2, 30]]);
    expect([short.sellDate, short.buyDate]).toEqual(["2026-09-01", "2026-09-03"]);
    const orphan = matched[paired.findIndex((p) => p.kind === "opening-sell")]!;
    expect(orphan.sells.map((s) => [s.leg, s.qty])).toEqual([[s1, 15]]);
  });

  it("without `shortable` the same legs allocate as before (opening sells + an open lot)", () => {
    const allocs = allocateSymbolLegs(legs);
    expect(allocs.map((a) => [a.kind, a.buyQty, a.sellQty])).toEqual([
      ["opening-sell", 0, 30],
      ["opening-sell", 0, 30],
      ["open", 45, 0],
    ]);
    // A long's `sells` is its one `sell`.
    const long = allocateSymbolLegs([leg({ side: "buy", date: "2026-09-01", qty: 5, value: 50 }), leg({ side: "sell", date: "2026-09-02", qty: 5, value: 60 })])[0];
    expect(long.sells).toEqual([long.sell]);
  });

  it("the short's ladder holds the sale fills AND the covering fills; Σ per side = its quantity", () => {
    const fills = new Map<Leg, Execution[]>([
      [s1, [{ side: "sell", qty: 30, price: 100, date: "2026-09-01", time: "09:20" }]],
      [s2, [{ side: "sell", qty: 10, price: 110, date: "2026-09-02", time: "10:00" }, { side: "sell", qty: 20, price: 110, date: "2026-09-02", time: "11:00" }]],
      [b3, [{ side: "buy", qty: 45, price: 60, date: "2026-09-03", time: "14:10" }]],
    ]);
    const allocs = allocateSymbolLegs(legs, { shortable: true });
    const cut = executionsByAllocation(allocs, fills);
    const short = allocs.find((a) => a.kind === "closed")!;
    const ex = cut.get(short)!;
    const sum = (side: "buy" | "sell") => ex.filter((e) => e.side === side).reduce((s, e) => s + e.qty, 0);
    expect([sum("sell"), sum("buy")]).toEqual([45, 45]);
    expect(ex[0]).toMatchObject({ side: "sell", time: "09:20" });
    expect(ex.at(-1)).toMatchObject({ side: "buy", time: "14:10" });
  });
});
