import { describe, it, expect } from "vitest";
import * as ipoLink from "@/lib/analytics/ipo-link";
import {
  deriveHolding, tradePatchFromIpo, ipoSeedFromTrade, linkedSyncFor, sellLegIsIpoExit, type IpoLinkInput,
} from "@/lib/analytics/ipo-link";

const ipo = (p: Partial<IpoLinkInput> = {}): IpoLinkInput => ({
  appliedPrice: 500, discountPerShare: 0, allottedQty: 37, allotted: true,
  listingPrice: null, exitPrice: null,
  allotmentDate: "2026-07-15", listingDate: null, exitDate: null, ...p,
});

describe("deriveHolding — the two facts a holding was missing", () => {
  it("supplies the cost basis from the issue price", () => {
    const h = deriveHolding(ipo())!;
    expect(h.costPerShare).toBe(500);
    expect(h.qty).toBe(37);
    expect(h.buyValue).toBe(18500);
  });

  it("takes the category discount off the basis", () => {
    // A retail/employee discount is money not paid, so it must reduce cost.
    const h = deriveHolding(ipo({ appliedPrice: 500, discountPerShare: 25 }))!;
    expect(h.costPerShare).toBe(475);
    expect(h.buyValue).toBe(475 * 37);
  });

  it("never lets a discount push the basis below zero", () => {
    expect(deriveHolding(ipo({ appliedPrice: 100, discountPerShare: 250 }))!.costPerShare).toBe(0);
  });

  it("returns NO mark when neither a listing nor an exit price exists", () => {
    // This is the honest answer, not a missing value to fill with zero: the
    // holding genuinely has no price to be measured against yet.
    const h = deriveHolding(ipo())!;
    expect(h.markPrice).toBeNull();
    expect(h.markSource).toBeNull();
    expect(h.unrealisedPnl).toBeNull();
  });

  it("marks against the listing price once it is known", () => {
    const h = deriveHolding(ipo({ listingPrice: 598 }))!;
    expect(h.markPrice).toBe(598);
    expect(h.markSource).toBe("listing");
    expect(h.unrealisedPnl).toBe((598 - 500) * 37);
  });

  it("prefers a real EXIT price over a listing-day snapshot", () => {
    // An exit is a completed fact; a listing price is one day's picture.
    const h = deriveHolding(ipo({ listingPrice: 598, exitPrice: 640 }))!;
    expect(h.markSource).toBe("exit");
    expect(h.markPrice).toBe(640);
    expect(h.closed).toBe(true);
  });

  it("refuses to create a holding from an application that was not allotted", () => {
    expect(deriveHolding(ipo({ allotted: false }))).toBeNull();
    expect(deriveHolding(ipo({ allotted: true, allottedQty: 0 }))).toBeNull();
  });
});

describe("tradePatchFromIpo", () => {
  it("makes an unmarked holding whole — basis AND mark", () => {
    const p = tradePatchFromIpo(ipo({ listingPrice: 598 }))!;
    expect(p.acquisition).toBe("ipo");
    expect(p.acquisitionPrice).toBe(500);
    expect(p.buyValue).toBe(18500);
    expect(p.closingPrice).toBe(598);
    expect(p.unrealisedPnl).toBe(3626);
    expect(p.isOpen).toBe(true);
  });

  it("leaves the position honestly UNMARKED when no price is known", () => {
    const p = tradePatchFromIpo(ipo())!;
    expect(p.closingPrice).toBeNull();
    expect(p.unrealisedPnl).toBe(0);
    // …but the basis is still supplied, which is what lets it rejoin the
    // edge statistics even while it has no mark.
    expect(p.acquisitionPrice).toBe(500);
    expect(p.buyValue).toBe(18500);
  });

  it("closes the position when the IPO records an exit", () => {
    const p = tradePatchFromIpo(ipo({ exitPrice: 640, exitDate: "2026-07-22" }))!;
    expect(p.isOpen).toBe(false);
    expect(p.sellQty).toBe(37);
    expect(p.avgSellPrice).toBe(640);
    expect(p.sellValue).toBe(23680);
    expect(p.sellDate).toBe("2026-07-22");
    expect(p.grossPnl).toBe(23680 - 18500);
    // A sold position has nothing left to mark.
    expect(p.closingPrice).toBeNull();
    expect(p.unrealisedPnl).toBe(0);
  });

  it("carries the allotment date through as the acquisition date", () => {
    // This starts the tax holding period, so it must not silently become today.
    expect(tradePatchFromIpo(ipo())!.acquisitionDate).toBe("2026-07-15");
    expect(tradePatchFromIpo(ipo({ allotmentDate: null, listingDate: "2026-07-18" }))!.acquisitionDate)
      .toBe("2026-07-18");
    expect(tradePatchFromIpo(ipo({ allotmentDate: null }))!.acquisitionDate).toBeNull();
  });

  it("returns null rather than a patch for an unallotted application", () => {
    expect(tradePatchFromIpo(ipo({ allotted: false }))).toBeNull();
  });
});

describe("linkedSyncFor — a holding with a sale recorded in Trades is never recomputed from the IPO (X1)", () => {
  // Bought 10 @100 (the IPO's allotment); the sale is the trade's own.
  const soldInTrades = { sellQty: 10, avgSellPrice: 150, sellDate: "2026-03-02" };
  const partlySold = { sellQty: 4, avgSellPrice: 150, sellDate: "2026-03-02" };
  const noSale = { sellQty: 0, avgSellPrice: 0, sellDate: null };
  const unsold = ipo({ appliedPrice: 100, allottedQty: 10, listingPrice: 130, exitDate: null });
  const soldOnIpos = { ...unsold, exitPrice: 150, exitDate: "2026-03-02" };

  it("a holding with no sale always syncs, whatever the save changes", () => {
    expect(linkedSyncFor({ stored: unsold, next: { ...unsold, allottedQty: 20 }, trade: noSale })).toBe("sync");
    expect(linkedSyncFor({ stored: null, next: unsold, trade: noSale })).toBe("sync");
    expect(linkedSyncFor({ stored: unsold, next: unsold, trade: null })).toBe("sync");
  });

  it("m1 · a save that changes no money field of the IPO leaves a partly or fully sold holding alone", () => {
    expect(linkedSyncFor({ stored: unsold, next: unsold, trade: partlySold })).toBe("leave");
    expect(linkedSyncFor({ stored: unsold, next: unsold, trade: soldInTrades })).toBe("leave");
    // An exit date with no exit price prices nothing, so writing or clearing it changes no money field.
    expect(linkedSyncFor({ stored: { ...unsold, exitDate: "2026-02-30" }, next: unsold, trade: soldInTrades })).toBe("leave");
    expect(linkedSyncFor({ stored: unsold, next: { ...unsold, exitDate: "2026-03-02" }, trade: soldInTrades })).toBe("leave");
  });

  it("m2 · a save that changes a money field over that sale is refused", () => {
    for (const next of [
      { ...unsold, allottedQty: 20 },
      { ...unsold, appliedPrice: 90 },
      { ...unsold, discountPerShare: 5 },
      { ...unsold, listingPrice: 140 },
      { ...unsold, allotmentDate: "2019-02-01" },
      { ...unsold, allotted: false },
      { ...unsold, exitPrice: 160, exitDate: "2026-03-02" },
    ]) {
      expect(linkedSyncFor({ stored: unsold, next, trade: soldInTrades }), JSON.stringify(next)).toBe("refuse");
    }
    // A create, or a save that links a different holding, carries no stored record to compare: refused.
    expect(linkedSyncFor({ stored: null, next: unsold, trade: soldInTrades })).toBe("refuse");
  });

  it("(c) · an IPO whose exit IS the trade's sell leg keeps the full sync, clearing the exit included", () => {
    expect(sellLegIsIpoExit(soldOnIpos, soldInTrades)).toBe(true);
    expect(linkedSyncFor({ stored: soldOnIpos, next: unsold, trade: soldInTrades })).toBe("sync");
    expect(linkedSyncFor({ stored: soldOnIpos, next: { ...soldOnIpos, exitPrice: 160, allottedQty: 20 }, trade: soldInTrades })).toBe("sync");
    // U3: the date corrected in Trades, then saved onto the IPO; the save makes the exit that sale.
    expect(linkedSyncFor({ stored: { ...soldOnIpos, exitDate: "2026-02-30" }, next: soldOnIpos, trade: soldInTrades })).toBe("sync");
  });

  it("a sale differing from the IPO's exit in quantity, price or date is the trade's own", () => {
    expect(sellLegIsIpoExit(soldOnIpos, partlySold)).toBe(false);
    expect(sellLegIsIpoExit(soldOnIpos, { ...soldInTrades, avgSellPrice: 155 })).toBe(false);
    expect(sellLegIsIpoExit(soldOnIpos, { ...soldInTrades, sellDate: "2026-03-03" })).toBe(false);
    expect(sellLegIsIpoExit(unsold, soldInTrades)).toBe(false);
    expect(linkedSyncFor({ stored: { ...soldOnIpos, exitPrice: 155 }, next: unsold, trade: soldInTrades })).toBe("refuse");
  });

  /**
   * Y2 (v4.3.0 wave 2H): an IPO sold 150 on an unreadable '2026-02-30', its holding's sale
   * corrected in Trades to 152 on 2026-03-02. A save carrying 2026-03-02 (U3's pre-fill) or a
   * blank date changed nothing the sync writes but the date, which the stored row never held
   * readably — measured before: 'refuse' (409 on a notes-only save). Unchanged price and
   * quantity now leave the holding alone; any money change still follows X1.
   */
  it("Y2 · an UNREADABLE stored exit date equals any date for 'leave' while price and quantity are unchanged", () => {
    const stored = { ...soldOnIpos, exitDate: "2026-02-30" };
    const corrected = { sellQty: 10, avgSellPrice: 152, sellDate: "2026-03-02" };
    // THE assertions: the pre-filled date, a cleared date, and the stored value back — all leave.
    expect(linkedSyncFor({ stored, next: soldOnIpos, trade: corrected })).toBe("leave");
    expect(linkedSyncFor({ stored, next: { ...soldOnIpos, exitDate: null }, trade: corrected })).toBe("leave");
    expect(linkedSyncFor({ stored, next: stored, trade: corrected })).toBe("leave");
    expect(linkedSyncFor({ stored, next: { ...soldOnIpos, exitDate: "2026-03-09" }, trade: partlySold })).toBe("leave");
    // A money change over that sale is still refused; a save making the exit that sale still syncs.
    expect(linkedSyncFor({ stored, next: { ...soldOnIpos, exitPrice: 160 }, trade: corrected })).toBe("refuse");
    expect(linkedSyncFor({ stored, next: { ...soldOnIpos, allottedQty: 20 }, trade: corrected })).toBe("refuse");
    expect(linkedSyncFor({ stored, next: { ...soldOnIpos, exitPrice: null, exitDate: null }, trade: corrected })).toBe("refuse");
    expect(linkedSyncFor({ stored, next: { ...soldOnIpos, exitPrice: 152 }, trade: corrected })).toBe("sync");
    // A READABLE stored date is compared as it is: moving it over a sale that is not the exit is refused.
    expect(linkedSyncFor({ stored: soldOnIpos, next: { ...soldOnIpos, exitDate: "2026-03-09" }, trade: corrected })).toBe("refuse");
  });

  /**
   * Z2 (B) (wave 2H): the patch carries the IPO's computed exit charges, handed in by the caller,
   * and net = gross − charges. The decision builds BOTH sides without charges, so a charge figure
   * never turns a notes-only save into a money change.
   */
  it("Z2 · the patch carries a priced exit's charges and net; an open or unpriced patch states none, and the decision still leaves a notes-only save", () => {
    const p = tradePatchFromIpo(soldOnIpos, 2.06)!;
    expect([p.grossPnl, p.chargesTotal, p.netPnl]).toEqual([500, 2.06, 497.94]);
    expect([tradePatchFromIpo(soldOnIpos)!.chargesTotal, tradePatchFromIpo(soldOnIpos)!.netPnl]).toEqual([null, null]);
    expect([tradePatchFromIpo(unsold, 2.06)!.chargesTotal, tradePatchFromIpo(unsold, 2.06)!.netPnl]).toEqual([null, null]);
    expect(linkedSyncFor({ stored: unsold, next: unsold, trade: soldInTrades })).toBe("leave");
    expect(linkedSyncFor({ stored: soldOnIpos, next: soldOnIpos, trade: { ...soldInTrades, avgSellPrice: 152 } })).toBe("leave");
  });

  it("no second writer: the recompute that re-read gross against a kept sale is gone", () => {
    expect("keepLinkedSellLeg" in ipoLink).toBe(false);
  });
});

describe("ipoSeedFromTrade — pre-fill what is known, leave blank what is not", () => {
  const holding = {
    symbol: "SBI Funds Management", exchange: "NSE",
    buyQty: 37, avgBuyPrice: 0, buyValue: 0, buyDate: null, closingPrice: null,
  };

  it("carries the symbol, quantity and exchange across", () => {
    const s = ipoSeedFromTrade(holding);
    expect(s.name).toBe("SBI Funds Management");
    expect(s.allottedQty).toBe(37);
    expect(s.exchange).toBe("NSE");
    expect(s.allotted).toBe(true);
  });

  it("leaves the issue price at 0 for a holding with NO basis — the whole point", () => {
    // Pre-filling a guess here would defeat the feature: the issue price is
    // precisely the fact the journal is missing and the user must supply.
    expect(ipoSeedFromTrade(holding).appliedPrice).toBe(0);
  });

  it("carries a real purchase price across when the holding has one", () => {
    expect(ipoSeedFromTrade({ ...holding, avgBuyPrice: 598 }).appliedPrice).toBe(598);
  });

  it("does not invent a lot structure it cannot know", () => {
    const s = ipoSeedFromTrade(holding);
    expect(s.lotsApplied).toBe(1);
    expect(s.lotSize).toBe(37); // the whole holding as one lot
  });

  it("carries an existing mark across as the listing price, and nothing when unmarked", () => {
    expect(ipoSeedFromTrade({ ...holding, closingPrice: 610 }).listingPrice).toBe(610);
    expect(ipoSeedFromTrade(holding).listingPrice).toBeNull();
    expect(ipoSeedFromTrade({ ...holding, closingPrice: 0 }).listingPrice).toBeNull();
  });

  it("handles a zero-quantity holding without producing a nonsense lot size", () => {
    expect(ipoSeedFromTrade({ ...holding, buyQty: 0 }).lotSize).toBe(1);
  });
});

describe("the round trip: holding → IPO → holding", () => {
  it("restores a holding that arrived with neither basis nor mark", () => {
    // 1. An IPO allotment lands in the journal with nothing usable.
    const orphan = {
      symbol: "SBI Funds Management", exchange: "NSE",
      buyQty: 37, avgBuyPrice: 0, buyValue: 0, buyDate: null, closingPrice: null,
    };

    // 2. Pushed to the IPO section and filled in by the user.
    const seed = ipoSeedFromTrade(orphan);
    const filled: IpoLinkInput = {
      ...seed,
      appliedPrice: 500,          // what the user actually paid
      discountPerShare: 0,
      listingPrice: 598,          // what it listed at
      exitPrice: null,
      allotmentDate: "2026-07-15",
      listingDate: "2026-07-18",
      exitDate: null,
    };

    // 3. Flowing back, the holding is whole: it has a basis AND a mark.
    const patch = tradePatchFromIpo(filled)!;
    expect(patch.buyValue).toBe(18500);
    expect(patch.closingPrice).toBe(598);
    expect(patch.unrealisedPnl).toBe(3626);
    expect(patch.acquisition).toBe("ipo");
    // Which means it is no longer stuck outside every statistic.
    expect(patch.acquisitionPrice).toBeGreaterThan(0);
  });
});
