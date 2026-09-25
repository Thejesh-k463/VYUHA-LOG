import { describe, expect, it } from "vitest";
import { closeRemainder, closingAggregate, closingCountIsDefault, type CloseSource } from "@/lib/domain/close-aggregate";

/**
 * v4.3.0 fix wave 2H seam S1 — the ONE closing-leg aggregate.
 *
 * H1 taught `closePosition` to close a PARTLY closed row by adding the exit to
 * the leg already on the closing side. The Trades close dialog's live preview
 * kept its own copy of the pre-H1 write (sell only the remainder), so for a long
 * 100 @200 with 60 sold it previewed sell 40 for ₹10,200 / gross ₹2,200 while
 * the save stored sell 100 for ₹25,200 / gross ₹5,200 (seam E-c). Both now read
 * `closingAggregate`; this file pins the helper against H1's inline arithmetic.
 * The preview = save pin over the real route and the real write lives in
 * tests/close-position-partial.test.ts.
 */

/** H1's closePosition closing-leg arithmetic as it stood inline (wave 2H working tree), verbatim. */
function h1Inline(t: Required<CloseSource>, exitPrice: number) {
  const isShort = t.sellQty > t.buyQty;
  const qty = Math.abs(t.buyQty - t.sellQty) || (isShort ? t.sellQty : t.buyQty);
  const exitValue = Math.round(exitPrice * qty * 100) / 100;
  const priorQty = t.buyQty !== t.sellQty ? (isShort ? t.buyQty : t.sellQty) : 0;
  const closeQty = priorQty + qty;
  const closeValue = priorQty > 0 ? Math.round(((isShort ? t.buyValue : t.sellValue) + exitValue) * 100) / 100 : exitValue;
  const closeAvg = priorQty > 0 ? closeValue / closeQty : exitPrice;
  const closeOrders = (isShort ? t.buyOrderCount : t.sellOrderCount) || 1;
  const closeOrderCount = priorQty > 0 ? closeOrders + 1 : closeOrders;
  return { isShort, qty, exitValue, closeQty, closeValue, closeAvg, closeOrderCount };
}

const row = (over: Partial<Required<CloseSource>>): Required<CloseSource> => ({
  buyQty: 0,
  sellQty: 0,
  buyValue: 0,
  sellValue: 0,
  buyOrderCount: 1,
  sellOrderCount: 1,
  // v4.6.0 W6: the side reading's inputs (unstated → the legs decide).
  side: null,
  buyDate: null,
  sellDate: null,
  ...over,
});

describe("closingAggregate — the closing side a manual close writes", () => {
  it("long bought 100 @200, sold 60 @250, closed @255: the remaining 40 land ON the sell leg — 100 for 25,200 @252, one more order", () => {
    const a = closingAggregate(row({ buyQty: 100, buyValue: 20000, sellQty: 60, sellValue: 15000 }), 255);
    expect(a).toEqual({ isShort: false, qty: 40, exitValue: 10200, closeQty: 100, closeValue: 25200, closeAvg: 252, closeOrderCount: 2 });
  });

  it("the short mirror: sold 100 @250, covered 60 @200, closed @195 — the buy leg becomes 100 for 19,800 @198", () => {
    const a = closingAggregate(row({ sellQty: 100, sellValue: 25000, buyQty: 60, buyValue: 12000, buyOrderCount: 3 }), 195);
    expect(a).toEqual({ isShort: true, qty: 40, exitValue: 7800, closeQty: 100, closeValue: 19800, closeAvg: 198, closeOrderCount: 4 });
  });

  it("an empty closing leg keeps the pre-H1 write: the exit price itself (not value ÷ qty), the leg's count or 1", () => {
    const exitValue = Math.round(250.555 * 7 * 100) / 100;
    expect(exitValue / 7, "the pin can tell a divided average from the exit price").not.toBe(250.555);
    expect(closingAggregate(row({ buyQty: 7, buyValue: 1400, sellOrderCount: 0 }), 250.555)).toEqual({
      isShort: false,
      qty: 7,
      exitValue,
      closeQty: 7,
      closeValue: exitValue,
      closeAvg: 250.555,
      closeOrderCount: 1,
    });
    // A short sell-to-open with nothing covered: the cover is the whole position.
    expect(closingAggregate(row({ sellQty: 50, sellValue: 5000, buyOrderCount: 0 }), 90)).toMatchObject({ isShort: true, qty: 50, closeQty: 50, closeValue: 4500, closeAvg: 90, closeOrderCount: 1 });
  });

  it("the closing side's STORED count carries through (T2: the wire row holds it now); a stored 0 reads as 1, as closePosition's `|| 1` does", () => {
    const zero: CloseSource = { buyQty: 100, buyValue: 20000, sellQty: 60, sellValue: 15000, buyOrderCount: 0, sellOrderCount: 0 };
    expect(closingAggregate(zero, 255).closeOrderCount).toBe(2);
    expect(closingAggregate({ buyQty: 7, buyValue: 1400, sellQty: 0, sellValue: 0, buyOrderCount: 1, sellOrderCount: 0 }, 250).closeOrderCount).toBe(1);
    // The probe's option: 60 covered in 3 orders, the cover of the rest is the 4th.
    expect(closingAggregate({ sellQty: 100, sellValue: 500, buyQty: 60, buyValue: 180, sellOrderCount: 2, buyOrderCount: 3 }, 2).closeOrderCount).toBe(4);
  });

  it("V4: a closing leg that gains its FIRST quantity and stores no count bills the passed settings default (by side); a stored count, or a leg already holding quantity, does not", () => {
    const defaults = { buyOrders: 3, sellOrders: 2 };
    // Long, nothing sold, no count stored: the sell default.
    const long = { buyQty: 100, buyValue: 500, sellQty: 0, sellValue: 0, buyOrderCount: 2, sellOrderCount: 0 };
    expect(closingAggregate(long, 8, defaults).closeOrderCount).toBe(2);
    expect(closingCountIsDefault(long)).toBe(true);
    // Short mirror: the buy default.
    const short = { sellQty: 100, sellValue: 800, buyQty: 0, buyValue: 0, sellOrderCount: 2, buyOrderCount: 0 };
    expect(closingAggregate(short, 5, defaults).closeOrderCount).toBe(3);
    expect(closingCountIsDefault(short)).toBe(true);
    // No defaults passed: 1, as before.
    expect(closingAggregate(long, 8).closeOrderCount).toBe(1);
    // A stored count wins.
    expect(closingAggregate({ ...long, sellOrderCount: 4 }, 8, defaults).closeOrderCount).toBe(4);
    expect(closingCountIsDefault({ ...long, sellOrderCount: 4 })).toBe(false);
    // A leg already holding quantity with no stored count keeps `|| 1` + the exit order.
    const partZero = { buyQty: 100, buyValue: 20000, sellQty: 60, sellValue: 15000, buyOrderCount: 0, sellOrderCount: 0 };
    expect(closingAggregate(partZero, 255, defaults).closeOrderCount).toBe(2);
    expect(closingCountIsDefault(partZero)).toBe(false);
  });

  it("closeRemainder is the open quantity and side the dialog prints (a row stating equal legs closes its whole buy quantity)", () => {
    expect(closeRemainder({ buyQty: 100, sellQty: 60 })).toEqual({ isShort: false, qty: 40 });
    expect(closeRemainder({ buyQty: 60, sellQty: 100 })).toEqual({ isShort: true, qty: 40 });
    expect(closeRemainder({ buyQty: 10, sellQty: 10 })).toEqual({ isShort: false, qty: 10 });
  });

  it.each([
    ["long partial", row({ buyQty: 100, buyValue: 20000, sellQty: 60, sellValue: 15000 }), 255],
    ["short partial", row({ sellQty: 100, sellValue: 25000, buyQty: 60, buyValue: 12000 }), 195],
    ["long empty leg, fractional exit", row({ buyQty: 7, buyValue: 1400, sellOrderCount: 0 }), 250.555],
    ["short empty leg", row({ sellQty: 3, sellValue: 312.45, buyOrderCount: 0 }), 99.99],
    ["equal legs (no remainder stated)", row({ buyQty: 10, buyValue: 2000, sellQty: 10, sellValue: 2500, sellOrderCount: 3 }), 300],
    ["odd paise on the prior leg", row({ buyQty: 33, buyValue: 3300.33, sellQty: 11, sellValue: 1111.11, sellOrderCount: 2 }), 101.017],
    ["short odd paise, many cover orders", row({ sellQty: 29, sellValue: 2929.29, buyQty: 13, buyValue: 1234.57, buyOrderCount: 5 }), 88.885],
  ])("equals H1's inline closePosition arithmetic exactly: %s", (_name, r, exit) => {
    expect(closingAggregate(r, exit)).toStrictEqual(h1Inline(r, exit));
  });
});
