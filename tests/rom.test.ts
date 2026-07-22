import { describe, it, expect } from "vitest";
import {
  romReport,
  capitalForTrade,
  daysHeld,
  sideOf,
  capitalEfficiencyVerdict,
  presentAnnualised,
  type RomTrade,
} from "@/lib/analytics/rom";
import { marginKey, type MarginRates } from "@/lib/risk/margin";

/** Realistic Indian rate card: 12% for F&O, 20% intraday, 25% MTF own margin,
 *  100% delivery (you pay in full). */
function rates(): MarginRates {
  const m: MarginRates = new Map();
  m.set(marginKey("zerodha", "index_option"), 12);
  m.set(marginKey("zerodha", "stock_option"), 15);
  m.set(marginKey("zerodha", "future"), 12);
  m.set(marginKey("zerodha", "eq_intraday"), 20);
  m.set(marginKey("zerodha", "eq_mtf"), 25);
  m.set(marginKey("zerodha", "eq_delivery"), 100);
  return m;
}

let nextId = 1;
function trade(p: Partial<RomTrade> = {}): RomTrade {
  return {
    id: p.id ?? nextId++,
    symbol: "TEST",
    broker: "zerodha",
    bucket: "active",
    segment: "index_option",
    instrumentType: "option",
    optionType: null,
    strike: null,
    buyQty: 0, avgBuyPrice: 0, buyValue: 0,
    sellQty: 0, avgSellPrice: 0, sellValue: 0,
    netPnl: 0,
    buyDate: "2026-01-01",
    sellDate: "2026-01-11",
    playbookId: null,
    setupTag: null,
    ...p,
  };
}

describe("daysHeld", () => {
  it("counts calendar days between entry and exit", () => {
    expect(daysHeld("2026-01-01", "2026-01-11")).toBe(10);
  });

  it("floors a same-day trade at 1, never 0", () => {
    // Dividing by zero days is undefined, and intraday capital was still used.
    expect(daysHeld("2026-01-01", "2026-01-01")).toBe(1);
  });

  it("falls back to 1 on missing or unparseable dates", () => {
    expect(daysHeld(null, "2026-01-11")).toBe(1);
    expect(daysHeld("nonsense", "2026-01-11")).toBe(1);
  });

  it("is direction-agnostic, so a short's reversed dates still measure right", () => {
    expect(daysHeld("2026-01-11", "2026-01-01")).toBe(10);
  });
});

describe("sideOf", () => {
  it("reads a sell-first trade as short", () => {
    expect(sideOf({ buyQty: 50, sellQty: 50, buyDate: "2026-01-10", sellDate: "2026-01-01" })).toBe("short");
  });

  it("reads a buy-first trade as long", () => {
    expect(sideOf({ buyQty: 50, sellQty: 50, buyDate: "2026-01-01", sellDate: "2026-01-10" })).toBe("long");
  });

  it("falls back to quantity when dates are missing", () => {
    expect(sideOf({ buyQty: 0, sellQty: 50, buyDate: null, sellDate: null })).toBe("short");
  });
});

describe("capitalForTrade — the point of the whole metric", () => {
  it("charges a LONG option only the premium paid", () => {
    // Long options block no SPAN margin. Treating them as notional × margin%
    // would invent a requirement that never existed.
    const t = trade({
      optionType: "CE", strike: 25000,
      buyQty: 50, avgBuyPrice: 200, buyValue: 10000,
      sellQty: 50, avgSellPrice: 260, sellValue: 13000,
      buyDate: "2026-01-01", sellDate: "2026-01-05",
    });
    const { capital, basis } = capitalForTrade(t, rates());
    expect(capital).toBe(10000); // 50 × 200 premium
    expect(basis).toMatch(/premium paid/);
  });

  it("charges a SHORT option margin against the UNDERLYING, not the premium", () => {
    // A ₹10,000 credit can tie up ₹1.5L — that asymmetry is the insight.
    const t = trade({
      optionType: "CE", strike: 25000,
      sellQty: 50, avgSellPrice: 200, sellValue: 10000,
      buyQty: 50, avgBuyPrice: 140, buyValue: 7000,
      buyDate: "2026-01-05", sellDate: "2026-01-01", // sold first = short
    });
    const { capital, basis } = capitalForTrade(t, rates());
    expect(capital).toBe(150000); // 12% × (50 × 25000)
    expect(basis).toMatch(/notional/);
  });

  it("makes the long/short asymmetry visible — same notional, 15x the capital", () => {
    const common = { optionType: "CE" as const, strike: 25000 };
    const long = capitalForTrade(trade({ ...common, buyQty: 50, avgBuyPrice: 200, buyDate: "2026-01-01", sellDate: "2026-01-05" }), rates());
    const short = capitalForTrade(trade({ ...common, sellQty: 50, avgSellPrice: 200, buyDate: "2026-01-05", sellDate: "2026-01-01" }), rates());
    expect(short.capital / long.capital).toBe(15);
  });

  it("charges delivery the full invested value", () => {
    const t = trade({
      segment: "eq_delivery", instrumentType: "equity",
      buyQty: 100, avgBuyPrice: 1000, buyValue: 100000,
      sellQty: 100, avgSellPrice: 1100, sellValue: 110000,
    });
    expect(capitalForTrade(t, rates()).capital).toBe(100000);
  });

  it("charges MTF only your own capital share", () => {
    const t = trade({
      segment: "eq_mtf", instrumentType: "equity",
      buyQty: 100, avgBuyPrice: 1000, buyValue: 100000,
      sellQty: 100, avgSellPrice: 1100, sellValue: 110000,
    });
    expect(capitalForTrade(t, rates()).capital).toBe(25000); // 25% own margin
  });

  it("charges intraday equity the leveraged share", () => {
    const t = trade({
      segment: "eq_intraday", instrumentType: "equity",
      buyQty: 100, avgBuyPrice: 1000, buyValue: 100000,
      sellQty: 100, avgSellPrice: 1010, sellValue: 101000,
    });
    expect(capitalForTrade(t, rates()).capital).toBe(20000);
  });

  it("flags an assumed rate rather than silently pretending 100% is right", () => {
    const t = trade({ broker: "unknown_broker", segment: "future", buyQty: 10, avgBuyPrice: 1000, buyDate: "2026-01-01", sellDate: "2026-01-02" });
    expect(capitalForTrade(t, rates()).rateAssumed).toBe(true);
  });

  it("prices a short off its ENTRY (the sell), not its exit", () => {
    // Getting this backwards would value a short option at the price it was
    // covered at, understating capital in a winning trade.
    const t = trade({
      optionType: "PE", strike: 24000,
      sellQty: 50, avgSellPrice: 300,
      buyQty: 50, avgBuyPrice: 10,
      buyDate: "2026-01-05", sellDate: "2026-01-01",
    });
    // Short option uses strike-based notional, so entry price does not change
    // the answer here — but the side detection must still say "short".
    expect(sideOf(t)).toBe("short");
    expect(capitalForTrade(t, rates()).capital).toBe(144000); // 12% × 50 × 24000
  });
});

describe("romReport", () => {
  it("computes raw ROM and per-day ROM per trade", () => {
    const t = trade({
      segment: "eq_delivery", instrumentType: "equity",
      buyQty: 100, avgBuyPrice: 1000, buyValue: 100000,
      sellQty: 100, avgSellPrice: 1100, sellValue: 110000,
      netPnl: 10000,
      buyDate: "2026-01-01", sellDate: "2026-01-11",
    });
    const rep = romReport([t], rates());
    expect(rep.rows).toHaveLength(1);
    expect(rep.rows[0].capital).toBe(100000);
    expect(rep.rows[0].romPct).toBe(10);      // 10,000 / 100,000
    expect(rep.rows[0].daysHeld).toBe(10);
    expect(rep.rows[0].romPerDayPct).toBe(1); // 10% over 10 days
  });

  it("shows a short option earning far less on capital than its premium suggests", () => {
    // ₹3,000 profit on ₹10,000 of premium looks like +30%. Against the
    // ₹1.5L actually blocked it is +2% — which is the truth.
    const t = trade({
      optionType: "CE", strike: 25000,
      sellQty: 50, avgSellPrice: 200, sellValue: 10000,
      buyQty: 50, avgBuyPrice: 140, buyValue: 7000,
      netPnl: 3000,
      buyDate: "2026-01-05", sellDate: "2026-01-01",
    });
    const rep = romReport([t], rates());
    expect(rep.rows[0].capital).toBe(150000);
    expect(rep.rows[0].romPct).toBe(2);
  });

  it("NEVER annualises an individual trade", () => {
    // One lucky intraday scalp at "+5000% annualised" destroys credibility.
    const t = trade({
      segment: "eq_intraday", instrumentType: "equity",
      buyQty: 100, avgBuyPrice: 1000, netPnl: 2000,
      buyDate: "2026-01-01", sellDate: "2026-01-01",
    });
    const rep = romReport([t], rates());
    expect(rep.rows[0]).not.toHaveProperty("annualisedPct");
    expect(rep.overall.annualisedPct).not.toBeNull();
  });

  it("weights per-day ROM by capital-DAYS, not by trade count", () => {
    // ₹1L for 10 days is ten times the commitment of ₹1L for 1 day; a naive
    // average of the two per-day figures would say otherwise.
    const slow = trade({
      segment: "eq_delivery", instrumentType: "equity",
      buyQty: 100, avgBuyPrice: 1000, netPnl: 10000,
      buyDate: "2026-01-01", sellDate: "2026-01-11",
    });
    const fast = trade({
      segment: "eq_delivery", instrumentType: "equity",
      buyQty: 100, avgBuyPrice: 1000, netPnl: 1000,
      buyDate: "2026-02-01", sellDate: "2026-02-02",
    });
    const rep = romReport([slow, fast], rates());
    // capitalDays = 100k×10 + 100k×1 = 1.1m ; pnl = 11k → 1% per capital-day
    expect(rep.overall.capitalDays).toBe(1_100_000);
    expect(rep.overall.romPerDayPct).toBe(1);
  });

  it("groups by segment, best capital efficiency first", () => {
    const del = trade({
      segment: "eq_delivery", instrumentType: "equity",
      buyQty: 100, avgBuyPrice: 1000, netPnl: 1000,
      buyDate: "2026-01-01", sellDate: "2026-01-11",
    });
    const intra = trade({
      segment: "eq_intraday", instrumentType: "equity",
      buyQty: 100, avgBuyPrice: 1000, netPnl: 1000,
      buyDate: "2026-01-01", sellDate: "2026-01-01",
    });
    const rep = romReport([del, intra], rates());
    expect(rep.bySegment[0].key).toBe("eq_intraday"); // 5%/day beats 0.1%/day
    expect(rep.bySegment).toHaveLength(2);
  });

  it("skips trades with no establishable capital rather than reporting infinity", () => {
    const bad = trade({ buyQty: 0, sellQty: 0, avgBuyPrice: 0, avgSellPrice: 0, netPnl: 500 });
    const rep = romReport([bad], rates());
    expect(rep.rows).toHaveLength(0);
    expect(rep.skipped).toBe(1);
  });

  it("reports which segments fell back to an assumed rate", () => {
    const t = trade({ broker: "mystery", segment: "future", buyQty: 10, avgBuyPrice: 1000, netPnl: 100, buyDate: "2026-01-01", sellDate: "2026-01-02" });
    const rep = romReport([t], rates());
    expect(rep.missingRates).toContain(marginKey("mystery", "future"));
    expect(rep.rows[0].rateAssumed).toBe(true);
  });

  it("groups by playbook and labels them", () => {
    const a = trade({ segment: "eq_delivery", buyQty: 100, avgBuyPrice: 1000, netPnl: 5000, playbookId: 7 });
    const b = trade({ segment: "eq_delivery", buyQty: 100, avgBuyPrice: 1000, netPnl: 1000, playbookId: 7 });
    const rep = romReport([a, b], rates(), { playbookNames: { 7: "ORB" } });
    expect(rep.byPlaybook).toHaveLength(1);
    expect(rep.byPlaybook[0].label).toBe("ORB");
    expect(rep.byPlaybook[0].trades).toBe(2);
  });

  it("ignores untagged trades in the playbook rollup", () => {
    const rep = romReport([trade({ segment: "eq_delivery", buyQty: 100, avgBuyPrice: 1000, netPnl: 100 })], rates());
    expect(rep.byPlaybook).toHaveLength(0);
  });

  it("computes win rate per group", () => {
    const w = trade({ segment: "eq_delivery", buyQty: 100, avgBuyPrice: 1000, netPnl: 500 });
    const l = trade({ segment: "eq_delivery", buyQty: 100, avgBuyPrice: 1000, netPnl: -500 });
    expect(romReport([w, l], rates()).overall.winRate).toBe(50);
  });

  it("handles an empty book without dividing by zero", () => {
    const rep = romReport([], rates());
    expect(rep.overall.trades).toBe(0);
    expect(rep.overall.romPct).toBeNull();
    expect(rep.overall.annualisedPct).toBeNull();
  });

  it("carries losses through as negative ROM", () => {
    const t = trade({
      segment: "eq_delivery", buyQty: 100, avgBuyPrice: 1000, netPnl: -8000,
      buyDate: "2026-01-01", sellDate: "2026-01-05",
    });
    const rep = romReport([t], rates());
    expect(rep.rows[0].romPct).toBe(-8);
    expect(rep.overall.annualisedPct).toBeLessThan(0);
  });
});

describe("capitalEfficiencyVerdict", () => {
  const mk = (segment: string, n: number, pnlEach: number, days: number) =>
    Array.from({ length: n }, () =>
      trade({
        segment, instrumentType: "equity",
        buyQty: 100, avgBuyPrice: 1000, netPnl: pnlEach,
        buyDate: "2026-01-01",
        sellDate: new Date(Date.UTC(2026, 0, 1 + days)).toISOString().slice(0, 10),
      }),
    );

  it("names the best and worst segment when both have enough trades", () => {
    const rep = romReport([...mk("eq_delivery", 12, 500, 10), ...mk("eq_intraday", 12, 500, 1)], rates());
    const v = capitalEfficiencyVerdict(rep);
    expect(v).not.toBeNull();
    expect(v).toMatch(/Intraday|eq_intraday/i);
  });

  it("stays silent on a small sample rather than declaring a winner off noise", () => {
    const rep = romReport([...mk("eq_delivery", 3, 500, 10), ...mk("eq_intraday", 3, 500, 1)], rates());
    expect(capitalEfficiencyVerdict(rep)).toBeNull();
  });

  it("stays silent when only one segment has been traded", () => {
    const rep = romReport(mk("eq_delivery", 20, 500, 10), rates());
    expect(capitalEfficiencyVerdict(rep)).toBeNull();
  });
});

describe("presentAnnualised — keeping an honest metric believable", () => {
  it("floors the downside at -100%, because you cannot lose more than your capital", () => {
    expect(presentAnnualised(-3887.5)).toEqual({ display: -100, extrapolated: true });
  });

  it("caps a runaway upside and flags it as extrapolation", () => {
    expect(presentAnnualised(5000)).toEqual({ display: 1000, extrapolated: true });
  });

  it("passes plausible figures through untouched and unflagged", () => {
    expect(presentAnnualised(42.5)).toEqual({ display: 42.5, extrapolated: false });
    expect(presentAnnualised(-30)).toEqual({ display: -30, extrapolated: false });
  });

  it("handles the boundaries without flagging them", () => {
    expect(presentAnnualised(-100)).toEqual({ display: -100, extrapolated: false });
    expect(presentAnnualised(1000)).toEqual({ display: 1000, extrapolated: false });
  });

  it("passes null through", () => {
    expect(presentAnnualised(null)).toEqual({ display: null, extrapolated: false });
  });

  it("keeps the RAW value on the group for export fidelity", () => {
    // A book losing 10%/day on one-day trades.
    const rows = Array.from({ length: 12 }, () =>
      trade({ segment: "eq_delivery", buyQty: 100, avgBuyPrice: 1000, netPnl: -10000, buyDate: "2026-01-01", sellDate: "2026-01-01" }),
    );
    const rep = romReport(rows, rates());
    expect(rep.overall.annualisedPct).toBeLessThan(-100);       // raw, uncapped
    expect(rep.overall.annualisedDisplayPct).toBe(-100);        // safe for display
    expect(rep.overall.annualisedIsExtrapolation).toBe(true);
  });
});
