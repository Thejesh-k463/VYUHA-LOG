import { describe, expect, it } from "vitest";
import {
  INTRADAY_SHORT_NOTE,
  OVERNIGHT_SHORT_NOTE,
  isShortableSymbol,
  pairLegs,
  pairSymbolLegs,
  summarisePairing,
  type Leg,
} from "@/lib/import/pair-legs";

/**
 * v4.6.0 W6 (contract D4, LEDGER D-8) — an overnight F&O short is only ever
 * COVERED, never assumed.
 *
 *   - covered: sell day N, buy day N+1 of the same contract in the same file →
 *     ONE closed row, side 'short', known basis, OVERNIGHT_SHORT_NOTE;
 *   - uncovered: a sale no later buy covers stays the opening sell it always
 *     was, byte for byte (the owner's COFORGE26AUG1500CE pin);
 *   - partial cover: the covered part closes, the rest stays an opening sell;
 *   - same-day sell-then-buy under `shortable` equals the pre-W6 output;
 *   - `shortable: false` (the default) is the pre-W6 output for the same legs.
 */

const SYM = "NIFTY26SEP24500CE";
const leg = (p: Partial<Leg> & Pick<Leg, "side" | "date" | "qty" | "value">): Leg => ({ symbol: SYM, charges: 0, ...p });

describe("isShortableSymbol — classify's own grammar, never a second one", () => {
  it("a derivative is shortable; a cash-equity ticker is not", () => {
    expect(isShortableSymbol(SYM)).toBe(true);
    expect(isShortableSymbol("NIFTY26SEPFUT")).toBe(true);
    expect(isShortableSymbol("RELIANCE")).toBe(false);
  });
});

describe("pairLegs shortable — the overnight short", () => {
  const OVERNIGHT = [
    leg({ side: "sell", date: "2026-09-01", qty: 75, value: 7500, charges: 30 }),
    leg({ side: "buy", date: "2026-09-02", qty: 75, value: 6000, charges: 20 }),
  ];

  it("covered by a later buy → ONE closed short with a known basis", () => {
    const out = pairLegs(OVERNIGHT, { shortable: true });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "closed", side: "short", basisUnknown: false,
      buyQty: 75, sellQty: 75, buyValue: 6000, sellValue: 7500,
      sellDate: "2026-09-01", buyDate: "2026-09-02", charges: 50,
    });
    expect(out[0].notes).toEqual([OVERNIGHT_SHORT_NOTE]);
    expect(summarisePairing(OVERNIGHT, out).conserved).toBe(true);
  });

  it("…and `shortable: false` is the pre-W6 output: an opening sell plus an open long (D-8)", () => {
    const out = pairLegs(OVERNIGHT);
    expect(out.map((p) => [p.kind, p.side, p.buyQty, p.sellQty])).toEqual([
      ["opening-sell", "short", 0, 75],
      ["open", "long", 75, 0],
    ]);
  });

  it("uncovered: a sale no later buy covers stays the opening sell, byte for byte", () => {
    const legs = [
      leg({ side: "buy", date: "2026-07-20", qty: 100, value: 1000 }),
      leg({ side: "sell", date: "2026-07-21", qty: 100, value: 1500 }),
      // COFORGE's shape: sold with NO buy anywhere after it in the file.
      leg({ side: "sell", date: "2026-07-28", qty: 950, value: 95000, charges: 40 }),
    ];
    expect(pairLegs(legs, { shortable: true })).toEqual(pairLegs(legs));
  });

  it("a sale BEFORE a buy that later sells again — the seed still owns the uncovered part", () => {
    // sell 10 (d1) · buy 10 (d2) · sell 10 (d3), nothing after: pass 1 covers
    // d1 with d2 and leaves d3 pending; the seeded pass then reads the pre-file
    // holding first, which is exactly the pre-W6 output.
    const legs = [
      leg({ side: "sell", date: "2026-09-01", qty: 10, value: 1000 }),
      leg({ side: "buy", date: "2026-09-02", qty: 10, value: 900 }),
      leg({ side: "sell", date: "2026-09-03", qty: 10, value: 1100 }),
    ];
    expect(pairLegs(legs, { shortable: true })).toEqual(pairLegs(legs));
  });

  it("partial cover: the covered part closes short, the rest stays an opening sell", () => {
    const legs = [
      leg({ side: "sell", date: "2026-09-01", qty: 100, value: 10000, charges: 10 }),
      leg({ side: "buy", date: "2026-09-02", qty: 60, value: 5400, charges: 6 }),
    ];
    const out = pairLegs(legs, { shortable: true });
    const closed = out.find((p) => p.kind === "closed")!;
    const orphan = out.find((p) => p.kind === "opening-sell")!;
    expect([closed.side, closed.buyQty, closed.sellQty, closed.buyValue, closed.sellValue, closed.charges]).toEqual(["short", 60, 60, 5400, 6000, 12]);
    expect([orphan.sellQty, orphan.sellValue, orphan.basisUnknown]).toEqual([40, 4000, true]);
    expect(out).toHaveLength(2);
    expect(summarisePairing(legs, out).conserved).toBe(true);
  });

  it("a buy covers pending shorts FIRST (weighted, FIFO, entry at the oldest) and the rest opens a long", () => {
    const legs = [
      leg({ side: "sell", date: "2026-09-01", qty: 50, value: 5000 }),
      leg({ side: "sell", date: "2026-09-02", qty: 50, value: 6000 }),
      leg({ side: "buy", date: "2026-09-03", qty: 130, value: 10400 }),
    ];
    const out = pairLegs(legs, { shortable: true });
    expect(out.map((p) => [p.kind, p.side, p.buyQty, p.sellQty, p.buyValue, p.sellValue, p.sellDate, p.buyDate])).toEqual([
      ["closed", "short", 100, 100, 8000, 11000, "2026-09-01", "2026-09-03"],
      ["open", "long", 30, 0, 2400, 0, null, "2026-09-03"],
    ]);
  });

  it("same-day sell-then-buy under `shortable` equals today's output (the intraday short)", () => {
    const legs = [
      leg({ side: "sell", date: "2026-09-01", qty: 75, value: 7500 }),
      leg({ side: "buy", date: "2026-09-01", qty: 75, value: 7000 }),
    ];
    const out = pairSymbolLegs(legs, { shortable: true });
    expect(out).toEqual(pairSymbolLegs(legs));
    expect(out[0].notes).toContain(INTRADAY_SHORT_NOTE);
    expect(out[0].side).toBe("short");
  });

  it("a per-symbol predicate pairs each instrument by its own answer", () => {
    const cash: Leg[] = [
      { symbol: "RELIANCE", side: "sell", date: "2026-09-01", qty: 10, value: 3000, charges: 0 },
      { symbol: "RELIANCE", side: "buy", date: "2026-09-02", qty: 10, value: 2900, charges: 0 },
    ];
    const out = pairLegs([...cash, ...OVERNIGHT], { shortable: isShortableSymbol });
    expect(out.filter((p) => p.symbol === "RELIANCE").map((p) => p.kind)).toEqual(["opening-sell", "open"]);
    expect(out.filter((p) => p.symbol === SYM).map((p) => [p.kind, p.side])).toEqual([["closed", "short"]]);
  });
});
