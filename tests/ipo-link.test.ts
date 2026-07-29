import { describe, it, expect } from "vitest";
import {
  deriveHolding, tradePatchFromIpo, ipoSeedFromTrade, type IpoLinkInput,
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
