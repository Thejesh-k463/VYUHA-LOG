import { describe, it, expect } from "vitest";
import {
  INTRADAY_SHORT_NOTE,
  pairLegs,
  pairSymbolLegs,
  summarisePairing,
  type Leg,
} from "@/lib/import/pair-legs";

const leg = (p: Partial<Leg> & Pick<Leg, "symbol" | "side" | "date" | "qty" | "value">): Leg => ({
  charges: 0,
  ...p,
});

/**
 * Two facts a paired position must state that its numbers cannot: that a sell
 * came BEFORE the buy that covered it on the same day (a covered intraday
 * short), and that the buy and the sell were filled on different exchanges.
 *
 * Neither changes the arithmetic. Both change what the row means, and a trader
 * reading "bought then sold" for a trade they entered short is being told
 * something that did not happen.
 */
describe("covered intraday short — sold first, bought back the same day", () => {
  it("closes a same-day sell-then-buy with a KNOWN basis and says it was a short", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "SHORTCO", side: "sell", date: "2026-07-06", qty: 100, value: 21000, charges: 12 }),
      leg({ symbol: "SHORTCO", side: "buy", date: "2026-07-06", qty: 100, value: 20500, charges: 11 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("closed");
    expect(out[0].basisUnknown).toBe(false);
    expect(out[0].buyValue).toBe(20500); // basis is the covering buy, not zero
    expect(out[0].sellValue).toBe(21000);
    expect(out[0].buyDate).toBe("2026-07-06");
    expect(out[0].sellDate).toBe("2026-07-06");
    expect(out[0].notes).toContain(INTRADAY_SHORT_NOTE);
    // Cash equity cannot be short overnight, so this is intraday by definition.
    expect(out[0].product).toBe("intraday");
  });

  it("keeps the legs' own product when they state one", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "SHORTCO", side: "sell", date: "2026-07-06", qty: 100, value: 21000, product: "delivery" }),
      leg({ symbol: "SHORTCO", side: "buy", date: "2026-07-06", qty: 100, value: 20500, product: "delivery" }),
    ]);
    expect(out[0].product).toBe("delivery");
    expect(out[0].notes).toContain(INTRADAY_SHORT_NOTE);
  });

  it("covers only the uncovered quantity — the excess buy is a normal open lot", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "SHORTCO", side: "sell", date: "2026-07-06", qty: 100, value: 21000 }),
      leg({ symbol: "SHORTCO", side: "buy", date: "2026-07-06", qty: 160, value: 32800 }),
    ]);
    const closed = out.find((p) => p.kind === "closed")!;
    const open = out.find((p) => p.kind === "open")!;
    expect(closed.sellQty).toBe(100);
    expect(closed.notes).toContain(INTRADAY_SHORT_NOTE);
    expect(open.buyQty).toBe(60);
    expect(open.notes).toEqual([]);
    expect(closed.buyValue + open.buyValue).toBeCloseTo(32800, 2);
  });

  it("orphans the part no same-day buy covers, and still marks the covered part", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "SHORTCO", side: "sell", date: "2026-07-06", qty: 100, value: 21000 }),
      leg({ symbol: "SHORTCO", side: "buy", date: "2026-07-06", qty: 60, value: 12300 }),
    ]);
    const closed = out.find((p) => p.kind === "closed")!;
    const orphan = out.find((p) => p.kind === "opening-sell")!;
    expect(closed.sellQty).toBe(60);
    expect(closed.notes).toContain(INTRADAY_SHORT_NOTE);
    expect(orphan.sellQty).toBe(40);
    expect(orphan.basisUnknown).toBe(true);
    expect(closed.sellValue + orphan.sellValue).toBeCloseTo(21000, 2);
  });

  it("MULTI-DAY is not a short — a sell then a next-day buy stays an opening sell", () => {
    // Cash equity cannot be carried short overnight, so the only honest reading
    // is that the shares were acquired before the file begins.
    const out = pairSymbolLegs([
      leg({ symbol: "NOTSHORT", side: "sell", date: "2026-07-06", qty: 100, value: 21000 }),
      leg({ symbol: "NOTSHORT", side: "buy", date: "2026-07-07", qty: 100, value: 20500 }),
    ]);
    expect(out.map((p) => p.kind).sort()).toEqual(["open", "opening-sell"]);
    const sell = out.find((p) => p.kind === "opening-sell")!;
    expect(sell.basisUnknown).toBe(true);
    expect(sell.notes.join(" ")).not.toContain("Intraday short");
  });

  it("does NOT call a same-day round trip a short when the buy came first", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "INTRACO", side: "buy", date: "2026-07-06", qty: 2000, value: 214446.4, product: "intraday" }),
      leg({ symbol: "INTRACO", side: "sell", date: "2026-07-06", qty: 2000, value: 216601.0, product: "intraday" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].notes).toEqual([]);
  });

  it("does NOT call it a short when an existing holding could deliver the shares", () => {
    // Holding 1,000 from an earlier day; today's rows read sell 500 then buy 500.
    // Those shares existed, so nothing was sold short — and same-day netting must
    // still pair the sell with today's buy and leave the old lot alone.
    const out = pairSymbolLegs([
      leg({ symbol: "HOLDCO", side: "buy", date: "2026-08-01", qty: 1000, value: 100000 }),
      leg({ symbol: "HOLDCO", side: "sell", date: "2026-08-02", qty: 500, value: 55000 }),
      leg({ symbol: "HOLDCO", side: "buy", date: "2026-08-02", qty: 500, value: 54000 }),
    ]);
    const closed = out.find((p) => p.kind === "closed")!;
    const open = out.find((p) => p.kind === "open")!;
    expect(closed.notes).toEqual([]);
    expect(closed.buyValue).toBeCloseTo(54000, 2); // today's buy, not the old lot
    expect(open.buyQty).toBe(1000);
    expect(open.buyDate).toBe("2026-08-01");
  });

  /**
   * THE THREE LINES THAT DECIDE THIS NOTE, each with a test that goes red when
   * it alone is reverted. Until now the covered-short fix had none: reverting
   * the seed, the date sort or the same-day guard left the whole suite green,
   * so three deliberate decisions were protected by nothing.
   */

  /**
   * (a) THE SEED — `shortCoverQtys(legsIn, openingQty)`.
   *
   * The file opens with a sale of shares it never shows being bought. Walked
   * from zero, that sale looks naked and the same-day buy behind it looks like
   * the cover; walked from the pre-file lot the pairing pass is itself holding,
   * it is an ordinary delivery sale. Revert `openingQty` to 0 and this day
   * wrongly gains the short note — and with it `unknown -> intraday`, which
   * understates STT on a file that states no product.
   */
  it("is not a short when the shares came from a lot the FILE never shows being bought", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "SEEDCO", side: "sell", date: "2026-07-10", qty: 100, value: 21000 }),
      leg({ symbol: "SEEDCO", side: "buy", date: "2026-07-10", qty: 100, value: 20500 }),
      leg({ symbol: "SEEDCO", side: "sell", date: "2026-07-20", qty: 100, value: 21500 }),
    ]);
    const closed = out.find((p) => p.kind === "closed")!;
    expect(closed.buyDate).toBe("2026-07-10");
    expect(closed.notes, "the 10th's sale was delivered from the pre-file lot").toEqual([]);
    // The product must stay unknown: `unknown -> intraday` is reached ONLY
    // through the short note, and this was not a short.
    expect(closed.product).toBe("unknown");
    // The pre-file lot is what the LATER sale consumed, and it has no basis.
    const opening = out.find((p) => p.kind === "opening-sell")!;
    expect(opening.sellDate).toBe("2026-07-20");
    expect(opening.basisUnknown).toBe(true);
  });

  /**
   * (b) THE DATE SORT — `[...legsIn].sort((a, b) => a.date.localeCompare(b.date))`.
   *
   * Several brokers export newest-first. Walked in raw file order the holding
   * bought on the 1st has not "happened" yet when the sale on the 5th is read,
   * so the sale looks naked and the same-day part-buy looks like its cover.
   * Revert the sort and this position wrongly gains the short note.
   */
  it("reads a NEWEST-FIRST export as the dates say, not as the file happens to be ordered", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "REVCO", side: "sell", date: "2026-01-05", qty: 100, value: 21000 }),
      leg({ symbol: "REVCO", side: "buy", date: "2026-01-05", qty: 100, value: 20800 }),
      leg({ symbol: "REVCO", side: "buy", date: "2026-01-01", qty: 100, value: 20000 }),
    ]);
    const closed = out.find((p) => p.kind === "closed")!;
    expect(closed.sellQty).toBe(100);
    // Same-day netting pairs the sale with the 5th's own buy, so BOTH dates
    // are the 5th and the overnight guard cannot mask a misread walk — the
    // date sort is the only thing standing between this row and the note.
    expect(closed.buyDate).toBe("2026-01-05");
    expect(closed.notes, "100 shares were held since the 1st; nothing was sold short").toEqual([]);
    expect(closed.product).toBe("unknown");
    const open = out.find((p) => p.kind === "open")!;
    expect(open.buyQty).toBe(100);
    expect(open.buyDate).toBe("2026-01-01");
  });

  /**
   * (c) THE HARD GUARD — `buyDate === leg.date` in `pairSymbolLegs`.
   *
   * Cash equity cannot be carried short overnight, so a position whose entry
   * and exit fall on different days is not one, whatever the cover arithmetic
   * upstream concluded. Here 40 of the 100 sold really were covered by that
   * day's own buy — but FIFO gives the POSITION an entry date of the 1st, and
   * a multi-day position may never carry the note. Revert the guard and it does.
   */
  it("never puts the note on a position that spans days, however the cover arithmetic reads", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "SPANCO", side: "buy", date: "2026-01-01", qty: 60, value: 12000 }),
      leg({ symbol: "SPANCO", side: "sell", date: "2026-01-05", qty: 100, value: 21000 }),
      leg({ symbol: "SPANCO", side: "buy", date: "2026-01-05", qty: 40, value: 8200 }),
    ]);
    expect(out).toHaveLength(1);
    const closed = out[0];
    expect(closed.kind).toBe("closed");
    expect(closed.buyQty).toBe(100);
    // Entry on the 1st, exit on the 5th — two days, so not an intraday short.
    expect(closed.buyDate).toBe("2026-01-01");
    expect(closed.sellDate).toBe("2026-01-05");
    expect(closed.notes).toEqual([]);
    expect(closed.product).toBe("unknown");
  });

  it("conserves quantity and value to the paisa across a book containing shorts", () => {
    const legs: Leg[] = [
      leg({ symbol: "S1", side: "sell", date: "2026-07-06", qty: 100, value: 21000, charges: 12 }),
      leg({ symbol: "S1", side: "buy", date: "2026-07-06", qty: 160, value: 32800, charges: 15 }),
      leg({ symbol: "S2", side: "sell", date: "2026-07-06", qty: 90, value: 18000, charges: 9 }),
      leg({ symbol: "S2", side: "buy", date: "2026-07-06", qty: 50, value: 9900, charges: 6 }),
      leg({ symbol: "S3", side: "buy", date: "2026-07-01", qty: 40, value: 4000, charges: 3 }),
      leg({ symbol: "S3", side: "sell", date: "2026-07-06", qty: 40, value: 4400, charges: 4 }),
    ];
    const paired = pairLegs(legs);
    const s = summarisePairing(legs, paired);
    expect(s.qtyDelta).toBe(0);
    expect(Math.abs(s.valueDelta)).toBeLessThanOrEqual(s.valueTolerance);
    expect(s.conserved).toBe(true);
    expect(paired.filter((p) => p.notes.includes(INTRADAY_SHORT_NOTE))).toHaveLength(2);
  });
});

describe("cross-exchange fills — one holding, two venues", () => {
  it("notes a buy on NSE closed by a sell on BSE, without splitting the position", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "ACME", side: "buy", date: "2026-08-03", qty: 100, value: 20000, exchange: "NSE" }),
      leg({ symbol: "ACME", side: "sell", date: "2026-08-04", qty: 100, value: 21000, exchange: "BSE" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("closed");
    expect(out[0].basisUnknown).toBe(false);
    // The position's exchange stays the first leg's — the note carries the rest.
    expect(out[0].exchange).toBe("NSE");
    expect(out[0].notes).toHaveLength(1);
    expect(out[0].notes[0]).toBe(
      "Bought on NSE, sold on BSE — one holding, the exchange is where the fill happened.",
    );
  });

  it("stays silent when both fills are on the same exchange", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "ACME", side: "buy", date: "2026-08-03", qty: 100, value: 20000, exchange: "NSE" }),
      leg({ symbol: "ACME", side: "sell", date: "2026-08-04", qty: 100, value: 21000, exchange: "NSE" }),
    ]);
    expect(out[0].notes).toEqual([]);
  });

  it("stays silent when an exchange is missing rather than guessing one", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "ACME", side: "buy", date: "2026-08-03", qty: 100, value: 20000, exchange: "NSE" }),
      leg({ symbol: "ACME", side: "sell", date: "2026-08-04", qty: 100, value: 21000 }),
    ]);
    expect(out[0].notes).toEqual([]);
  });

  it("names every venue a closed position was bought on, once each", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "ACME", side: "buy", date: "2026-08-01", qty: 50, value: 10000, exchange: "NSE" }),
      leg({ symbol: "ACME", side: "buy", date: "2026-08-02", qty: 50, value: 10200, exchange: "BSE" }),
      leg({ symbol: "ACME", side: "sell", date: "2026-08-04", qty: 100, value: 21000, exchange: "MCX" }),
    ]);
    const closed = out.find((p) => p.kind === "closed")!;
    expect(closed.notes[0]).toBe(
      "Bought on NSE/BSE, sold on MCX — one holding, the exchange is where the fill happened.",
    );
  });

  it("carries both notes when a cross-exchange fill is also a covered short", () => {
    const out = pairSymbolLegs([
      leg({ symbol: "ACME", side: "sell", date: "2026-08-04", qty: 100, value: 21000, exchange: "BSE" }),
      leg({ symbol: "ACME", side: "buy", date: "2026-08-04", qty: 100, value: 20000, exchange: "NSE" }),
    ]);
    expect(out[0].notes).toHaveLength(2);
    expect(out[0].notes[0]).toBe(INTRADAY_SHORT_NOTE);
    expect(out[0].notes[1]).toMatch(/^Bought on NSE, sold on BSE/);
  });
});
