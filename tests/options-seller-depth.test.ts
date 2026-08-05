import { describe, expect, it } from "vitest";
import {
  dteReport, hedgeReport, rollReport, ivRankReport, thetaEfficiency,
  sellerTrades, MIN_SAMPLE, MIN_IV_OBSERVATIONS,
  type SellerTradeWithDates,
} from "@/lib/analytics/options-seller-depth";
import type { SellerTrade } from "@/lib/analytics/options-seller";

/**
 * Option-seller depth. The properties worth pinning are the honesty ones —
 * every grouped finding must carry its sample size, refuse to rank on noise,
 * and never invent a denominator.
 */

let nextId = 1;
const s = (over: Partial<SellerTrade> = {}): SellerTrade => ({
  id: nextId++,
  symbol: "NIFTY",
  sellQty: 50,
  buyQty: 50,
  avgSellPrice: 100,
  avgBuyPrice: 40,
  netPnl: 3000,
  riskAmount: 10000,
  entryIv: 20,
  exitIv: 15,
  entryDte: 5,
  hedgeStatus: "unhedged",
  expiryOutcome: "squared_off",
  adjustmentGroup: null,
  isOpen: false,
  ...over,
});

/** n trades sharing the given shape — for crossing the sample threshold. */
const many = (n: number, over: Partial<SellerTrade> = {}) => Array.from({ length: n }, () => s(over));

describe("population", () => {
  it("keeps sell-opened positions and drops plain long options", () => {
    const pop = sellerTrades([
      s({ sellQty: 50, buyQty: 50 }),
      s({ sellQty: 0, buyQty: 50, avgSellPrice: 0 }),
    ]);
    expect(pop).toHaveLength(1);
  });
});

describe("DTE bands", () => {
  it("files each trade into the band its entry DTE falls in", () => {
    const r = dteReport([
      s({ entryDte: 1 }), s({ entryDte: 5 }), s({ entryDte: 14 }),
      s({ entryDte: 30 }), s({ entryDte: 90 }),
    ]);
    for (const b of r.buckets) expect(b.trades).toBe(1);
    expect(r.buckets.map((b) => b.label)).toEqual([
      "0–2 (expiry zone)", "3–7 (expiry week)", "8–21 (fortnight)", "22–45 (monthly)", "46+ (far)",
    ]);
  });

  it("counts trades with no recorded DTE instead of guessing one", () => {
    const r = dteReport([s({ entryDte: null }), s({ entryDte: null }), s({ entryDte: 5 })]);
    expect(r.unknownDte).toBe(2);
    expect(r.buckets.reduce((n, b) => n + b.trades, 0)).toBe(1);
  });

  it("excludes open positions — they have no outcome yet", () => {
    const r = dteReport([s({ isOpen: true }), s({ isOpen: false })]);
    expect(r.buckets.reduce((n, b) => n + b.trades, 0)).toBe(1);
  });

  it("marks a thin bucket untrustworthy and a full one trustworthy", () => {
    const r = dteReport([...many(MIN_SAMPLE, { entryDte: 5 }), s({ entryDte: 30 })]);
    expect(r.buckets.find((b) => b.label.startsWith("3–7"))!.trustworthy).toBe(true);
    expect(r.buckets.find((b) => b.label.startsWith("22–45"))!.trustworthy).toBe(false);
  });

  it("refuses to name a best band on noise", () => {
    // One trade in each band: nothing here is rankable.
    const r = dteReport([s({ entryDte: 1 }), s({ entryDte: 5 }), s({ entryDte: 30 })]);
    expect(r.best).toBeNull();
    expect(r.worst).toBeNull();
  });

  it("ranks best and worst once two bands carry a real sample", () => {
    const r = dteReport([
      ...many(MIN_SAMPLE, { entryDte: 5, netPnl: 5000 }),
      ...many(MIN_SAMPLE, { entryDte: 30, netPnl: -2000 }),
    ]);
    expect(r.best).toBe("3–7 (expiry week)");
    expect(r.worst).toBe("22–45 (monthly)");
  });

  it("returns null capture for a band with nothing sold", () => {
    const r = dteReport([s({ entryDte: 5, avgSellPrice: 0, sellQty: 50, buyQty: 0 })]);
    expect(r.buckets.find((b) => b.label.startsWith("3–7"))!.capturePct).toBeNull();
  });
});

describe("does hedging pay", () => {
  it("splits the two arms and reports each sample", () => {
    const r = hedgeReport([...many(3, { hedgeStatus: "hedged" }), ...many(2, { hedgeStatus: "unhedged" })]);
    expect(r.hedged.trades).toBe(3);
    expect(r.unhedged.trades).toBe(2);
  });

  it("withholds the gap until BOTH arms are big enough", () => {
    const thin = hedgeReport([...many(MIN_SAMPLE, { hedgeStatus: "hedged" }), ...many(2, { hedgeStatus: "unhedged" })]);
    expect(thin.comparable).toBe(false);
    expect(thin.expectancyGap).toBeNull();

    const full = hedgeReport([
      ...many(MIN_SAMPLE, { hedgeStatus: "hedged", netPnl: 1000 }),
      ...many(MIN_SAMPLE, { hedgeStatus: "unhedged", netPnl: 400 }),
    ]);
    expect(full.comparable).toBe(true);
    expect(full.expectancyGap).toBe(600);
  });

  it("counts partial and unset hedge states as unclassified rather than forcing an arm", () => {
    const r = hedgeReport([s({ hedgeStatus: "partial" }), s({ hedgeStatus: null }), s({ hedgeStatus: "hedged" })]);
    expect(r.unclassified).toBe(2);
  });

  it("always ships the selection-bias caveat", () => {
    expect(hedgeReport([s()]).note).toMatch(/not a controlled comparison/i);
  });
});

describe("roll / adjustment chains", () => {
  it("ignores trades with no adjustment group", () => {
    expect(rollReport([s({ adjustmentGroup: null }), s({ adjustmentGroup: "  " })]).chains).toHaveLength(0);
  });

  it("nets a chain and compares it with stopping at the first leg", () => {
    const r = rollReport([
      s({ id: 1, adjustmentGroup: "roll-a", netPnl: -1000 }),
      s({ id: 2, adjustmentGroup: "roll-a", netPnl: 4000 }),
    ]);
    const c = r.chains[0];
    expect(c.legs).toBe(2);
    expect(c.net).toBe(3000);
    expect(c.firstLegNet).toBe(-1000);
    expect(c.adjustmentDelta).toBe(4000);
    expect(c.verdict).toBe("helped");
  });

  it("calls a chain that made things worse hurt", () => {
    const r = rollReport([
      s({ id: 1, adjustmentGroup: "r", netPnl: 500 }),
      s({ id: 2, adjustmentGroup: "r", netPnl: -6000 }),
    ]);
    expect(r.chains[0].verdict).toBe("hurt");
    expect(r.hurt).toBe(1);
  });

  it("keeps rounding noise out of the verdict", () => {
    const r = rollReport([
      s({ id: 1, adjustmentGroup: "r", netPnl: 10000 }),
      s({ id: 2, adjustmentGroup: "r", netPnl: 5 }),
    ]);
    expect(r.chains[0].verdict).toBe("neutral");
  });

  it("leaves an unresolved chain out of every aggregate", () => {
    const r = rollReport([
      s({ id: 1, adjustmentGroup: "r", netPnl: 100 }),
      s({ id: 2, adjustmentGroup: "r", netPnl: 100, isOpen: true }),
    ]);
    expect(r.chains[0].verdict).toBe("open");
    expect(r.chains[0].resolved).toBe(false);
    expect(r.chainsResolved).toBe(0);
    expect(r.totalDelta).toBe(0);
  });

  it("counts the rescues that turned a winner into a loser", () => {
    // The single most expensive habit this report exists to surface.
    const r = rollReport([
      s({ id: 1, adjustmentGroup: "bad", netPnl: 2000 }),
      s({ id: 2, adjustmentGroup: "bad", netPnl: -9000 }),
      s({ id: 3, adjustmentGroup: "fine", netPnl: 1000 }),
      s({ id: 4, adjustmentGroup: "fine", netPnl: 500 }),
    ]);
    expect(r.rescuesThatBackfired).toBe(1);
  });

  it("orders legs by id so the first leg is genuinely the first", () => {
    const r = rollReport([
      s({ id: 9, adjustmentGroup: "r", netPnl: 700 }),
      s({ id: 2, adjustmentGroup: "r", netPnl: -300 }),
    ]);
    expect(r.chains[0].firstLegNet).toBe(-300);
  });

  it("verdict counts add up to the resolved count", () => {
    const r = rollReport([
      s({ id: 1, adjustmentGroup: "a", netPnl: 100 }), s({ id: 2, adjustmentGroup: "a", netPnl: 9000 }),
      s({ id: 3, adjustmentGroup: "b", netPnl: 100 }), s({ id: 4, adjustmentGroup: "b", netPnl: -9000 }),
      s({ id: 5, adjustmentGroup: "c", netPnl: 100, isOpen: true }),
    ]);
    expect(r.helped + r.hurt + r.neutral).toBe(r.chainsResolved);
  });
});

describe("IV rank at entry", () => {
  const ivs = (vals: number[], symbol = "NIFTY") => vals.map((v) => s({ symbol, entryIv: v }));

  it("refuses to rank an underlying with too few observations", () => {
    const r = ivRankReport(ivs([10, 20, 30]));
    expect(r.insufficient).toEqual(["NIFTY"]);
    expect(r.rows.every((x) => x.ivRank === null)).toBe(true);
  });

  it("ranks once there are enough observations, at the right ends", () => {
    const vals = Array.from({ length: MIN_IV_OBSERVATIONS }, (_, i) => 10 + i * 2); // 10..24
    const r = ivRankReport(ivs(vals));
    expect(r.insufficient).toEqual([]);
    const ranks = r.rows.map((x) => x.ivRank);
    expect(Math.min(...(ranks as number[]))).toBe(0);
    expect(Math.max(...(ranks as number[]))).toBe(100);
  });

  it("returns null rather than 0 or 100 when the history is flat", () => {
    const r = ivRankReport(ivs(Array.from({ length: MIN_IV_OBSERVATIONS }, () => 18)));
    expect(r.rows.every((x) => x.ivRank === null)).toBe(true);
  });

  it("ranks each underlying against its OWN history, not a pooled one", () => {
    // A 40 IV is the top of NIFTY's range here and the bottom of BANKNIFTY's.
    const n = Array.from({ length: MIN_IV_OBSERVATIONS }, (_, i) => s({ symbol: "NIFTY", entryIv: 10 + i * 5 })); // 10..45
    const b = Array.from({ length: MIN_IV_OBSERVATIONS }, (_, i) => s({ symbol: "BANKNIFTY", entryIv: 40 + i * 5 })); // 40..75
    const r = ivRankReport([...n, ...b]);
    expect(r.rows.find((x) => x.symbol === "BANKNIFTY" && x.entryIv === 40)!.ivRank).toBe(0);
    expect(r.rows.find((x) => x.symbol === "NIFTY" && x.entryIv === 45)!.ivRank).toBe(100);
  });

  it("withholds the rich-vs-cheap comparison until both halves are real", () => {
    const r = ivRankReport(ivs(Array.from({ length: MIN_IV_OBSERVATIONS }, (_, i) => 10 + i)));
    expect(r.comparable).toBe(false);
  });

  it("skips trades with no entry IV", () => {
    const r = ivRankReport([s({ entryIv: null }), s({ entryIv: null })]);
    expect(r.rows).toHaveLength(0);
  });

  it("states that rank is local, not a market feed", () => {
    expect(ivRankReport([s()]).note).toMatch(/not a market IV-rank feed/i);
  });
});

describe("premium captured per day of risk", () => {
  const d = (over: Partial<SellerTradeWithDates> = {}): SellerTradeWithDates => ({
    ...s(),
    buyDate: "2026-01-11",
    sellDate: "2026-01-01",
    ...over,
  });

  it("divides capture by days held, measuring from the SELL that opened it", () => {
    const r = thetaEfficiency([d({ sellDate: "2026-01-01", buyDate: "2026-01-11", avgSellPrice: 100, avgBuyPrice: 0, buyQty: 0, sellQty: 50 })]);
    expect(r.rows[0].daysHeld).toBe(10);
    expect(r.rows[0].premiumCaptured).toBe(5000);
    expect(r.rows[0].perDay).toBe(500);
  });

  it("counts a same-day trade as one day of risk, never zero", () => {
    const r = thetaEfficiency([d({ sellDate: "2026-01-01", buyDate: "2026-01-01" })]);
    expect(r.rows[0].daysHeld).toBe(1);
    expect(Number.isFinite(r.rows[0].perDay)).toBe(true);
  });

  it("excludes undated trades instead of assuming a holding period", () => {
    const r = thetaEfficiency([d({ sellDate: null }), d({ buyDate: null }), d()]);
    expect(r.undated).toBe(2);
    expect(r.rows).toHaveLength(1);
  });

  it("uses the median so one expiry-day scalp cannot distort it", () => {
    const r = thetaEfficiency([
      d({ sellDate: "2026-01-01", buyDate: "2026-01-11", avgSellPrice: 100, avgBuyPrice: 0, buyQty: 0 }),  // 500/day
      d({ sellDate: "2026-01-01", buyDate: "2026-01-11", avgSellPrice: 200, avgBuyPrice: 0, buyQty: 0 }),  // 1000/day
      d({ sellDate: "2026-01-01", buyDate: "2026-01-02", avgSellPrice: 2000, avgBuyPrice: 0, buyQty: 0 }), // 100000/day
    ]);
    expect(r.medianPerDay).toBe(1000);
  });

  it("returns null rather than NaN for an empty book", () => {
    expect(thetaEfficiency([]).medianPerDay).toBeNull();
  });
});
