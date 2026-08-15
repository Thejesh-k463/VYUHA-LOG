import { describe, expect, it } from "vitest";
import {
  entryExitPrices,
  investedSummary,
  tradeDirection,
  tradeQty,
  type TradeLegs,
} from "@/lib/domain/trade-columns";

const base: TradeLegs = {
  buyQty: 0, sellQty: 0, avgBuyPrice: 0, avgSellPrice: 0,
  buyValue: 0, sellValue: 0, segment: "eq_delivery", mtfFundedAmount: null,
};
const mk = (o: Partial<TradeLegs>): TradeLegs => ({ ...base, ...o });

const closedLong = mk({ buyQty: 100, avgBuyPrice: 250, buyValue: 25_000, sellQty: 100, avgSellPrice: 260, sellValue: 26_000 });
const openLong = mk({ buyQty: 100, avgBuyPrice: 250, buyValue: 25_000 });
const closedShort = mk({ sellQty: 50, avgSellPrice: 400, sellValue: 20_000, buyQty: 50, avgBuyPrice: 390, buyValue: 19_500, segment: "index_option" });
const openingSell = mk({ sellQty: 50, avgSellPrice: 400, sellValue: 20_000, segment: "index_option" });

describe("tradeDirection", () => {
  it("is short only when the sell leg carries more quantity", () => {
    expect(tradeDirection(closedLong)).toBe("long");
    expect(tradeDirection(openLong)).toBe("long");
    expect(tradeDirection(closedShort)).toBe("long"); // equal legs: the buy convention wins
    expect(tradeDirection(openingSell)).toBe("short");
    expect(tradeDirection(mk({ buyQty: 20, sellQty: 50 }))).toBe("short");
  });
});

describe("entryExitPrices", () => {
  it("long: entry is the buy price, exit the sell price", () => {
    expect(entryExitPrices(closedLong)).toEqual({ entry: 250, exit: 260 });
  });
  it("open long: exit is null, never 0", () => {
    expect(entryExitPrices(openLong)).toEqual({ entry: 250, exit: null });
  });
  it("short: entry is the sell price, exit the buy-back price", () => {
    const partial = mk({ sellQty: 50, avgSellPrice: 400, buyQty: 20, avgBuyPrice: 380 });
    expect(entryExitPrices(partial)).toEqual({ entry: 400, exit: 380 });
  });
  it("opening sell (buyQty 0): exit is null, entry is the sell price", () => {
    expect(entryExitPrices(openingSell)).toEqual({ entry: 400, exit: null });
  });
  it("a row with no legs at all has neither price", () => {
    expect(entryExitPrices(base)).toEqual({ entry: null, exit: null });
  });
});

describe("tradeQty", () => {
  it("is the opening leg's quantity", () => {
    expect(tradeQty(closedLong)).toBe(100);
    expect(tradeQty(openLong)).toBe(100);
    expect(tradeQty(openingSell)).toBe(50);
    expect(tradeQty(mk({ buyQty: 20, sellQty: 50 }))).toBe(50);
  });
});

describe("investedSummary", () => {
  it("non-MTF long: the buy value, no hint", () => {
    expect(investedSummary(closedLong)).toEqual({ amount: 25_000, mtf: false, ownPct: null, hint: null });
  });
  it("non-MTF short: the sell value (what was sold to open)", () => {
    expect(investedSummary(openingSell)).toEqual({ amount: 20_000, mtf: false, ownPct: null, hint: null });
  });
  it("MTF resolved: own contribution, own %, and a hint naming the broker's share", () => {
    const t = mk({ segment: "eq_mtf", buyQty: 100, avgBuyPrice: 1_000, buyValue: 100_000, mtfFundedAmount: 75_000 });
    const s = investedSummary(t);
    expect(s.amount).toBe(25_000);
    expect(s.mtf).toBe(true);
    expect(s.ownPct).toBe(25);
    expect(s.hint).toBe("MTF · you funded 25% · broker ₹75,000");
  });
  it("MTF unresolved: full buy value, NO invented %, explicit hint", () => {
    const t = mk({ segment: "eq_mtf", buyQty: 100, avgBuyPrice: 1_000, buyValue: 100_000, mtfFundedAmount: null });
    const s = investedSummary(t);
    expect(s).toEqual({ amount: 100_000, mtf: true, ownPct: null, hint: "MTF · funding not yet resolved" });
    expect(s.hint).not.toMatch(/%/);
  });
  it("MTF with a zero buy value never divides: ownPct is null", () => {
    const t = mk({ segment: "eq_mtf", buyValue: 0, mtfFundedAmount: 0 });
    const s = investedSummary(t);
    expect(s.ownPct).toBeNull();
    expect(s.mtf).toBe(true);
    expect(s.hint).not.toMatch(/NaN|%/);
  });
  it("MTF percent rounds to a whole number", () => {
    const t = mk({ segment: "eq_mtf", buyValue: 30_000, mtfFundedAmount: 20_000 });
    expect(investedSummary(t).ownPct).toBe(33);
  });
});
