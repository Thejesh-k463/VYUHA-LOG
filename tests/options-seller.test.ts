import { describe, expect, it } from "vitest";
import { optionsSellerReport, type SellerTrade } from "@/lib/analytics/options-seller";

/**
 * B1 — option sellers are India's dominant retail F&O cohort, and their
 * question is not "did I win" but "how much of the premium I sold did I keep,
 * and what did it cost me in risk to keep it".
 *
 * The honesty rule that matters here: a percentage needs a denominator that
 * actually exists. Premium capture with nothing sold, IV change with only one
 * side recorded, and return-on-risk with no risk amount must all come back
 * null rather than 0 — a 0 reads as a real, terrible result.
 */

const seller = (over: Partial<SellerTrade> = {}): SellerTrade => ({
  id: 1,
  symbol: "NIFTY",
  sellQty: 50,
  buyQty: 50,
  avgSellPrice: 100,
  avgBuyPrice: 40,
  netPnl: 2900,
  riskAmount: 10000,
  entryIv: 20,
  exitIv: 15,
  entryDte: 7,
  hedgeStatus: "hedged",
  expiryOutcome: "squared_off",
  adjustmentGroup: null,
  isOpen: false,
  ...over,
});

describe("options seller — premium capture", () => {
  it("measures premium sold, captured and the capture rate", () => {
    const r = optionsSellerReport([seller()]);
    expect(r.rows[0].premiumSold).toBe(5000); // 100 × 50
    expect(r.rows[0].premiumCaptured).toBe(3000); // (100 − 40) × 50
    expect(r.rows[0].capturePct).toBe(60);
    expect(r.capturePct).toBe(60);
  });

  it("captures the whole premium when a short expires worthless", () => {
    const r = optionsSellerReport([seller({ buyQty: 0, avgBuyPrice: 0, expiryOutcome: "expired_worthless" })]);
    expect(r.rows[0].premiumCaptured).toBe(5000);
    expect(r.rows[0].capturePct).toBe(100);
  });

  it("reports a negative capture when the short was bought back dearer", () => {
    const r = optionsSellerReport([seller({ avgSellPrice: 40, avgBuyPrice: 100 })]);
    expect(r.rows[0].premiumCaptured).toBe(-3000);
    expect(r.rows[0].capturePct).toBe(-150);
  });

  it("returns null capture rather than 0 when nothing was actually sold", () => {
    // 0% capture would read as "kept none of the premium" — a real, bad result.
    const r = optionsSellerReport([seller({ avgSellPrice: 0, sellQty: 50, buyQty: 0 })]);
    expect(r.rows[0].capturePct).toBeNull();
    expect(r.capturePct).toBeNull();
  });

  it("never lets a partial buy-back consume more quantity than was sold", () => {
    // Over-buying (a reversal, not a cover) must not inflate the cost side.
    const r = optionsSellerReport([seller({ sellQty: 50, buyQty: 200, avgBuyPrice: 40 })]);
    expect(r.rows[0].premiumCaptured).toBe(3000); // priced on 50, not 200
  });

  it("aggregates capture across trades on premium, not as an average of rates", () => {
    // A big position and a small one must not count equally.
    const r = optionsSellerReport([
      seller({ id: 1, avgSellPrice: 100, avgBuyPrice: 0, sellQty: 100, buyQty: 0 }), // 10,000 sold, all kept
      seller({ id: 2, avgSellPrice: 100, avgBuyPrice: 100, sellQty: 1, buyQty: 1 }), // 100 sold, none kept
    ]);
    expect(r.capturePct).toBe(Math.round((10000 / 10100) * 10000) / 100);
  });
});

describe("options seller — IV and risk", () => {
  it("reports IV change only when both ends are recorded", () => {
    expect(optionsSellerReport([seller({ entryIv: 20, exitIv: 15 })]).rows[0].ivChange).toBe(-5);
    expect(optionsSellerReport([seller({ entryIv: 20, exitIv: null })]).rows[0].ivChange).toBeNull();
    expect(optionsSellerReport([seller({ entryIv: null, exitIv: 15 })]).rows[0].ivChange).toBeNull();
  });

  it("counts how many trades have a complete IV pair, so the sample is visible", () => {
    const r = optionsSellerReport([
      seller({ id: 1, entryIv: 20, exitIv: 15 }),
      seller({ id: 2, entryIv: 20, exitIv: null }),
      seller({ id: 3, entryIv: null, exitIv: null }),
    ]);
    expect(r.completeIv).toBe(1);
    expect(r.count).toBe(3);
  });

  it("returns return-on-risk against the recorded risk, and null without one", () => {
    expect(optionsSellerReport([seller({ netPnl: 2900, riskAmount: 10000 })]).rows[0].returnOnRiskPct).toBe(29);
    expect(optionsSellerReport([seller({ riskAmount: null })]).rows[0].returnOnRiskPct).toBeNull();
    expect(optionsSellerReport([seller({ riskAmount: 0 })]).rows[0].returnOnRiskPct).toBeNull();
  });
});

describe("options seller — population and outcomes", () => {
  it("excludes a plain long option, which is not a seller's trade at all", () => {
    const r = optionsSellerReport([seller({ id: 9, sellQty: 0, buyQty: 50, avgSellPrice: 0, avgBuyPrice: 100 })]);
    expect(r.count).toBe(0);
    expect(r.rows).toHaveLength(0);
  });

  it("keeps an open short in the population and counts closed separately", () => {
    const r = optionsSellerReport([
      seller({ id: 1, isOpen: true }),
      seller({ id: 2, isOpen: false }),
    ]);
    expect(r.count).toBe(2);
    expect(r.closed).toBe(1);
  });

  it("tallies expiry outcomes and files an unset one as unclassified", () => {
    const r = optionsSellerReport([
      seller({ id: 1, expiryOutcome: "expired_worthless" }),
      seller({ id: 2, expiryOutcome: "expired_worthless" }),
      seller({ id: 3, expiryOutcome: "assigned" }),
      seller({ id: 4, expiryOutcome: null }),
    ]);
    expect(r.outcomes.expired_worthless).toBe(2);
    expect(r.outcomes.assigned).toBe(1);
    expect(r.outcomes.unclassified).toBe(1);
  });

  it("reports the hedged share of the book", () => {
    const r = optionsSellerReport([
      seller({ id: 1, hedgeStatus: "hedged" }),
      seller({ id: 2, hedgeStatus: "unhedged" }),
      seller({ id: 3, hedgeStatus: null }),
      seller({ id: 4, hedgeStatus: "partial" }),
    ]);
    expect(r.hedgedPct).toBe(25);
  });

  it("returns nulls, not zeroes, for an empty book", () => {
    const r = optionsSellerReport([]);
    expect(r.count).toBe(0);
    expect(r.capturePct).toBeNull();
    expect(r.hedgedPct).toBeNull();
    expect(r.netPnl).toBe(0);
    expect(r.outcomes).toEqual({});
  });

  it("sums net P&L across the seller book", () => {
    const r = optionsSellerReport([seller({ id: 1, netPnl: 2900 }), seller({ id: 2, netPnl: -1100 })]);
    expect(r.netPnl).toBe(1800);
  });
});
