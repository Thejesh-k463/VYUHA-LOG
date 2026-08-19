import { describe, it, expect } from "vitest";
import { pairLegs, pairSymbolLegs, summarisePairing, type Leg } from "@/lib/import/pair-legs";

const leg = (p: Partial<Leg> & Pick<Leg, "symbol" | "side" | "date" | "qty" | "value">): Leg => ({
  charges: 0, ...p,
});

describe("pairSymbolLegs — the real shapes from a Dhan transaction report", () => {
  it("pairs a buy and a next-day sell into ONE trade held one day", () => {
    // DELIVCO: bought 650 on 06 Jul, sold 650 on 07 Jul.
    const out = pairSymbolLegs([
      leg({ symbol: "DELIVCO", side: "buy", date: "2026-07-06", qty: 650, value: 643353.30, charges: 767.59 }),
      leg({ symbol: "DELIVCO", side: "sell", date: "2026-07-07", qty: 650, value: 635921.52, charges: 683.49 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("closed");
    expect(out[0].buyDate).toBe("2026-07-06");
    expect(out[0].sellDate).toBe("2026-07-07");
    expect(out[0].buyQty).toBe(650);
    expect(out[0].charges).toBeCloseTo(1451.08, 2);
  });

  it("collapses a same-day round trip into one intraday position", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "INTRACO", side: "buy", date: "2026-07-06", qty: 2000, value: 214446.40, product: "intraday" }),
      leg({ symbol: "INTRACO", side: "sell", date: "2026-07-06", qty: 2000, value: 216601.00, product: "intraday" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].buyDate).toBe(out[0].sellDate);
    expect(out[0].product).toBe("intraday");
  });

  it("matches a sell against the SAME day's buy before an older lot (exchange netting)", () => {
    // The Paytm Money statement pattern (real export, 2026-08-20): 26,000 bought on
    // 03 Aug, 16,000 sold on 04 Aug, then 10,000 bought AND 10,000 sold on 05 Aug.
    // The broker pairs the 05 Aug sell with the 05 Aug buy (intraday) and leaves
    // 10,000 of the 03 Aug lot open — pure FIFO would close the old lot instead.
    const out = pairSymbolLegs([
      leg({ symbol: "NETCO", side: "buy", date: "2026-08-03", qty: 26000, value: 26000 * 52.45 }),
      leg({ symbol: "NETCO", side: "sell", date: "2026-08-04", qty: 16000, value: 16000 * 57.96 }),
      leg({ symbol: "NETCO", side: "buy", date: "2026-08-05", qty: 10000, value: 10000 * 57.0 }),
      leg({ symbol: "NETCO", side: "sell", date: "2026-08-05", qty: 10000, value: 10000 * 58.58 }),
    ]);
    const closed = out.filter((p) => p.kind === "closed").sort((a, b) => a.sellDate!.localeCompare(b.sellDate!));
    const open = out.filter((p) => p.kind === "open");
    expect(closed.map((p) => [p.buyDate, p.sellDate, p.buyQty])).toEqual([
      ["2026-08-03", "2026-08-04", 16000],
      ["2026-08-05", "2026-08-05", 10000],
    ]);
    expect(closed[1].buyValue).toBeCloseTo(570000, 2); // the 05 Aug buy, not 03 Aug's price
    expect(open).toHaveLength(1);
    expect(open[0].buyDate).toBe("2026-08-03");
    expect(open[0].buyQty).toBe(10000);
  });

  it("same-day first, then FIFO for the remainder of a bigger sell", () => {
    // Holding 1,000 from day 1; day 2 buys 500 and sells 800 → 500 intraday
    // against day 2's buy, 300 closed from the day-1 lot, 700 of day 1 still open.
    const out = pairSymbolLegs([
      leg({ symbol: "MIXCO", side: "buy", date: "2026-08-01", qty: 1000, value: 100000 }),
      leg({ symbol: "MIXCO", side: "buy", date: "2026-08-02", qty: 500, value: 55000 }),
      leg({ symbol: "MIXCO", side: "sell", date: "2026-08-02", qty: 800, value: 96000 }),
    ]);
    const closed = out.find((p) => p.kind === "closed")!;
    const open = out.find((p) => p.kind === "open")!;
    expect(closed.buyQty).toBe(800);
    // 500 @ 110 (day 2) + 300 @ 100 (day 1) = 85,000 — not 800 @ 100.
    expect(closed.buyValue).toBeCloseTo(85000, 2);
    expect(closed.buyDate).toBe("2026-08-01"); // oldest lot consumed still decides the holding period
    expect(open.buyQty).toBe(700);
    expect(open.buyDate).toBe("2026-08-01");
  });

  it("splits a partial exit into a closed trade plus a still-open remainder", () => {
    // PARTCO: bought 7,500 on 28 Jul, sold 5,000 the same day, 2,500 left.
    const out = pairSymbolLegs([
      leg({ symbol: "PARTCO", side: "buy", date: "2026-07-28", qty: 7500, value: 1162674.25 }),
      leg({ symbol: "PARTCO", side: "sell", date: "2026-07-28", qty: 5000, value: 772916.25 }),
    ]);
    expect(out.map((p) => p.kind).sort()).toEqual(["closed", "open"]);
    const closed = out.find((p) => p.kind === "closed")!;
    const open = out.find((p) => p.kind === "open")!;
    expect(closed.buyQty).toBe(5000);
    expect(open.buyQty).toBe(2500);
    // Buy value must divide in proportion, not be duplicated.
    expect(closed.buyValue + open.buyValue).toBeCloseTo(1162674.25, 0);
  });

  it("carries a multi-day scale-out across bills, FIFO", () => {
    // LADDERCO: bought 4,500 on 13 Jul; sold 2,000 that day, 2,500 on 14 Jul.
    const out = pairSymbolLegs([
      leg({ symbol: "LADDERCO", side: "buy", date: "2026-07-13", qty: 4500, value: 781390.10 }),
      leg({ symbol: "LADDERCO", side: "sell", date: "2026-07-13", qty: 2000, value: 347053.80 }),
      leg({ symbol: "LADDERCO", side: "sell", date: "2026-07-14", qty: 2500, value: 426023.00 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((p) => p.kind === "closed")).toBe(true);
    // Both exits trace back to the SAME entry date — that is what FIFO means.
    expect(out.every((p) => p.buyDate === "2026-07-13")).toBe(true);
    expect(out.map((p) => p.sellDate).sort()).toEqual(["2026-07-13", "2026-07-14"]);
    expect(out.reduce((s, p) => s + p.buyQty, 0)).toBe(4500);
  });

  it("retires the OLDEST lot first when two entries exist", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "X", side: "buy", date: "2026-07-01", qty: 100, value: 10000 }),
      leg({ symbol: "X", side: "buy", date: "2026-07-05", qty: 100, value: 12000 }),
      leg({ symbol: "X", side: "sell", date: "2026-07-10", qty: 100, value: 13000 }),
    ]);
    const closed = out.find((p) => p.kind === "closed")!;
    expect(closed.buyDate).toBe("2026-07-01");
    expect(closed.buyValue).toBe(10000);
    // The newer, pricier lot survives untouched.
    const open = out.find((p) => p.kind === "open")!;
    expect(open.buyDate).toBe("2026-07-05");
    expect(open.buyValue).toBe(12000);
  });
});

describe("opening sells — the unknowable cost basis", () => {
  it("flags a sell with no matching buy instead of inventing a 100% gain", () => {
    // ALLOTCO: sold 37 on 22 Jul, never bought in the window.
    const out = pairSymbolLegs([
      leg({ symbol: "ALLOTCO", side: "sell", date: "2026-07-22", qty: 37, value: 21904.00, charges: 22.72 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("opening-sell");
    expect(out[0].basisUnknown).toBe(true);
    expect(out[0].buyValue).toBe(0);
    expect(out[0].buyDate).toBeNull();
    expect(out[0].notes.join(" ")).toMatch(/IPO allotment/i);
  });

  it("matches what it can and orphans only the excess", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "Y", side: "buy", date: "2026-07-01", qty: 40, value: 4000 }),
      leg({ symbol: "Y", side: "sell", date: "2026-07-02", qty: 100, value: 11000 }),
    ]);
    const closed = out.find((p) => p.kind === "closed")!;
    const orphan = out.find((p) => p.kind === "opening-sell")!;
    expect(closed.sellQty).toBe(40);
    expect(orphan.sellQty).toBe(60);
    // The sell value splits between them — none created, none lost.
    expect(closed.sellValue + orphan.sellValue).toBeCloseTo(11000, 0);
  });
});

describe("conservation — FIFO must not create or destroy shares", () => {
  it("conserves quantity and value across a whole mixed book", () => {
    const legs: Leg[] = [
      leg({ symbol: "A", side: "buy", date: "2026-07-01", qty: 100, value: 10000, charges: 12 }),
      leg({ symbol: "A", side: "sell", date: "2026-07-03", qty: 60, value: 6600, charges: 8 }),
      leg({ symbol: "B", side: "buy", date: "2026-07-02", qty: 500, value: 55000, charges: 30 }),
      leg({ symbol: "B", side: "sell", date: "2026-07-02", qty: 500, value: 55500, charges: 31 }),
      leg({ symbol: "C", side: "sell", date: "2026-07-04", qty: 37, value: 21904, charges: 22 }),
    ];
    const paired = pairLegs(legs);
    const s = summarisePairing(legs, paired);
    expect(s.qtyDelta).toBe(0);
    expect(s.valueDelta).toBe(0);
    expect(s.closed).toBe(2);
    expect(s.open).toBe(1);
    expect(s.openingSells).toBe(1);
  });

  it("handles an empty book and a buy-only book without throwing", () => {
    expect(pairLegs([])).toEqual([]);
    const out = pairLegs([leg({ symbol: "Z", side: "buy", date: "2026-07-01", qty: 1, value: 100 })]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("open");
  });

  it("orders buys before sells on the same date — you cannot sell what you have not bought", () => {
    // Deliberately supplied sell-first; the pairing must still match them.
    const out = pairSymbolLegs([
      leg({ symbol: "Q", side: "sell", date: "2026-07-06", qty: 10, value: 1100 }),
      leg({ symbol: "Q", side: "buy", date: "2026-07-06", qty: 10, value: 1000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("closed");
    expect(out[0].basisUnknown).toBe(false);
  });
});
