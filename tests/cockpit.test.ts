import { describe, it, expect } from "vitest";
import {
  cockpitReport, timeEdge, holdingBehaviour, sizingBehaviour, tiltBehaviour,
  segmentScorecard, sessionOf, weekdayOf, MIN_SAMPLE, type CockpitTrade,
} from "@/lib/analytics/cockpit";

let id = 1;
function t(p: Partial<CockpitTrade> = {}): CockpitTrade {
  return {
    id: p.id ?? id++,
    symbol: "TEST",
    segment: "eq_delivery",
    netPnl: 0,
    buyValue: 100000,
    sellValue: 100000,
    buyDate: "2026-06-01",
    sellDate: "2026-06-01",
    entryTime: null,
    exitTime: null,
    isOpen: false,
    rMultiple: null,
    ...p,
  };
}
/** n trades sharing the same shape — for clearing MIN_SAMPLE deliberately. */
const many = (n: number, p: Partial<CockpitTrade> = {}) => Array.from({ length: n }, () => t(p));

describe("sessionOf", () => {
  it("maps Indian session windows", () => {
    expect(sessionOf("09:20")).toBe("open");
    expect(sessionOf("10:30")).toBe("morning");
    expect(sessionOf("12:45")).toBe("midday");
    expect(sessionOf("14:30")).toBe("afternoon");
    expect(sessionOf("15:20")).toBe("close");
  });

  it("includes the 15:30 bell in the closing hour", () => {
    expect(sessionOf("15:30")).toBe("close");
  });

  it("returns null outside market hours rather than inventing a session", () => {
    expect(sessionOf("08:00")).toBeNull();
    expect(sessionOf("16:30")).toBeNull();
    expect(sessionOf(null)).toBeNull();
  });

  it("puts the boundary minute in the LATER session, not both", () => {
    expect(sessionOf("09:45")).toBe("morning");
    expect(sessionOf("11:30")).toBe("midday");
  });
});

describe("weekdayOf", () => {
  it("reads the weekday from an ISO date", () => {
    expect(weekdayOf("2026-06-01")).toBe(1); // Monday
    expect(weekdayOf("2026-06-05")).toBe(5); // Friday
  });

  it("returns null on missing or junk dates", () => {
    expect(weekdayOf(null)).toBeNull();
    expect(weekdayOf("not a date")).toBeNull();
  });
});

describe("timeEdge", () => {
  it("counts trades WITHOUT a time separately rather than bucketing them", () => {
    // A P&L import has no times. Silently dropping them into 09:15 would
    // fabricate a session edge that never existed.
    const rows = [...many(10, { entryTime: "09:30", netPnl: 100 }), ...many(5, { entryTime: null, netPnl: 100 })];
    const e = timeEdge(rows);
    expect(e.withTime).toBe(10);
    expect(e.withoutTime).toBe(5);
  });

  it("flags insufficient data below MIN_SAMPLE", () => {
    expect(timeEdge(many(3, { entryTime: "09:30" })).insufficient).toBe(true);
    expect(timeEdge(many(MIN_SAMPLE, { entryTime: "09:30" })).insufficient).toBe(false);
  });

  it("marks a thin bucket rather than hiding it", () => {
    // 10:30 is the morning window; 09:30 would be the opening drive.
    const e = timeEdge([...many(20, { entryTime: "10:30", netPnl: 500 }), ...many(2, { entryTime: "12:00", netPnl: -900 })]);
    expect(e.bySession.find((b) => b.key === "midday")?.thin).toBe(true);
    expect(e.bySession.find((b) => b.key === "morning")?.thin).toBe(false);
  });

  it("computes weekday buckets from DATES, so P&L imports still work", () => {
    const e = timeEdge(many(5, { entryTime: null, sellDate: "2026-06-01", netPnl: 100 }));
    expect(e.withTime).toBe(0);
    expect(e.byWeekday.find((b) => b.label === "Monday")?.trades).toBe(5);
  });

  it("excludes open positions — they have no realised outcome", () => {
    const e = timeEdge([...many(5, { entryTime: "09:30", isOpen: true }), ...many(3, { entryTime: "09:30" })]);
    expect(e.withTime).toBe(3);
  });
});

describe("holdingBehaviour", () => {
  it("detects losers held longer than winners", () => {
    const rows = [
      ...many(20, { netPnl: 500, buyDate: "2026-06-01", sellDate: "2026-06-03" }),  // 2 days
      ...many(20, { netPnl: -500, buyDate: "2026-06-01", sellDate: "2026-06-11" }), // 10 days
    ];
    const h = holdingBehaviour(rows);
    expect(h.avgWinDays).toBe(2);
    expect(h.avgLossDays).toBe(10);
    expect(h.ratio).toBe(5);
    expect(h.insufficient).toBe(false);
  });

  it("reports the healthy direction too", () => {
    const rows = [
      ...many(20, { netPnl: 500, buyDate: "2026-06-01", sellDate: "2026-06-11" }),
      ...many(20, { netPnl: -500, buyDate: "2026-06-01", sellDate: "2026-06-03" }),
    ];
    expect(holdingBehaviour(rows).ratio).toBe(0.2);
  });

  it("flags insufficient when either side is too thin", () => {
    const rows = [...many(30, { netPnl: 500 }), ...many(2, { netPnl: -500 })];
    expect(holdingBehaviour(rows).insufficient).toBe(true);
  });

  it("floors a same-day trade at 1 day, never 0", () => {
    const rows = [...many(20, { netPnl: 100 }), ...many(20, { netPnl: -100 })];
    expect(holdingBehaviour(rows).avgWinDays).toBe(1);
  });
});

describe("sizingBehaviour", () => {
  it("splits into quartiles and says whether bigger was better", () => {
    // Larger positions deliberately perform WORSE here.
    const rows = Array.from({ length: 40 }, (_, i) =>
      t({ buyValue: (i + 1) * 10000, netPnl: i < 20 ? 1000 : -1000 }),
    );
    const s = sizingBehaviour(rows);
    expect(s.quartiles).toHaveLength(4);
    expect(s.insufficient).toBe(false);
    expect(s.biggerIsBetter).toBe(false);
  });

  it("says nothing on a small sample rather than guessing", () => {
    const s = sizingBehaviour(many(10, { buyValue: 50000, netPnl: 100 }));
    expect(s.insufficient).toBe(true);
    expect(s.biggerIsBetter).toBeNull();
    expect(s.quartiles).toEqual([]);
  });
});

describe("tiltBehaviour", () => {
  it("separates trades after a win from trades after a loss", () => {
    // Alternating outcomes give a clean split.
    const rows = Array.from({ length: 40 }, (_, i) =>
      t({ netPnl: i % 2 === 0 ? 500 : -500, sellDate: `2026-06-${String((i % 28) + 1).padStart(2, "0")}` }),
    );
    const tb = tiltBehaviour(rows);
    expect(tb.afterWin.trades + tb.afterLoss.trades).toBe(39); // first has no predecessor
  });

  it("measures the longest winning and losing streaks", () => {
    const rows = [
      ...many(3, { netPnl: 100, sellDate: "2026-06-01" }),
      ...many(5, { netPnl: -100, sellDate: "2026-06-02" }),
      ...many(2, { netPnl: 100, sellDate: "2026-06-03" }),
    ];
    const tb = tiltBehaviour(rows);
    expect(tb.longestWinStreak).toBe(3);
    expect(tb.longestLossStreak).toBe(5);
  });

  it("counts same-day re-entries after a loss — the revenge signal", () => {
    const rows = [
      t({ netPnl: -500, sellDate: "2026-06-01" }),
      t({ netPnl: -200, sellDate: "2026-06-01" }), // same day, straight back in
      t({ netPnl: 300, sellDate: "2026-06-05" }),
    ];
    expect(tiltBehaviour(rows).sameDayReentryAfterLoss).toBe(1);
  });

  it("ignores breakeven trades when deciding what came 'after'", () => {
    const rows = [t({ netPnl: 0, sellDate: "2026-06-01" }), t({ netPnl: 100, sellDate: "2026-06-02" })];
    const tb = tiltBehaviour(rows);
    expect(tb.afterWin.trades).toBe(0);
    expect(tb.afterLoss.trades).toBe(0);
  });
});

describe("segmentScorecard", () => {
  it("ranks segments by expectancy, best first", () => {
    const rows = [
      ...many(20, { segment: "eq_delivery", netPnl: 1000 }),
      ...many(20, { segment: "index_option", netPnl: -500 }),
    ];
    const s = segmentScorecard(rows, {}, { eq_delivery: "Equity Delivery", index_option: "Index Options" });
    expect(s[0].label).toBe("Equity Delivery");
    expect(s[1].label).toBe("Index Options");
  });

  it("computes charge drag against gross", () => {
    // Net 800 with 200 of charges = 1000 gross, so drag is 20%.
    const rows = many(20, { segment: "eq_delivery", netPnl: 800 });
    const charges = Object.fromEntries(rows.map((r) => [r.id, 200]));
    expect(segmentScorecard(rows, charges)[0].chargeDragPct).toBe(20);
  });

  it("returns null drag when gross is negative rather than a backwards number", () => {
    const rows = many(20, { segment: "eq_delivery", netPnl: -5000 });
    const charges = Object.fromEntries(rows.map((r) => [r.id, 100]));
    expect(segmentScorecard(rows, charges)[0].chargeDragPct).toBeNull();
  });
});

describe("findings — the honesty gate", () => {
  it("says NOTHING on a tiny sample", () => {
    // Four trades cannot support any behavioural claim.
    const rep = cockpitReport(many(4, { netPnl: 100, entryTime: "09:30" }));
    expect(rep.findings).toEqual([]);
  });

  it("flags the loser-holding leak once the sample supports it", () => {
    const rows = [
      ...many(20, { netPnl: 500, buyDate: "2026-06-01", sellDate: "2026-06-03" }),
      ...many(20, { netPnl: -500, buyDate: "2026-06-01", sellDate: "2026-06-21" }),
    ];
    const f = cockpitReport(rows).findings;
    expect(f.some((x) => /held longer/i.test(x.title))).toBe(true);
  });

  it("credits the healthy direction, not only the problems", () => {
    const rows = [
      ...many(20, { netPnl: 500, buyDate: "2026-06-01", sellDate: "2026-06-21" }),
      ...many(20, { netPnl: -500, buyDate: "2026-06-01", sellDate: "2026-06-03" }),
    ];
    const f = cockpitReport(rows).findings;
    expect(f.some((x) => x.tone === "good")).toBe(true);
  });

  it("flags a losing segment with the real numbers attached", () => {
    const rows = [
      ...many(20, { segment: "eq_delivery", netPnl: 900 }),
      ...many(20, { segment: "index_option", netPnl: -800 }),
    ];
    const f = cockpitReport(rows, {}, { index_option: "Index Options" }).findings;
    const seg = f.find((x) => /losing money/i.test(x.title));
    expect(seg).toBeTruthy();
    expect(seg!.detail).toMatch(/per trade over 20 trades/);
  });

  it("never phrases a finding as an instruction", () => {
    const rows = [
      ...many(20, { netPnl: 500, buyDate: "2026-06-01", sellDate: "2026-06-03" }),
      ...many(20, { netPnl: -500, buyDate: "2026-06-01", sellDate: "2026-06-21" }),
    ];
    for (const f of cockpitReport(rows).findings) {
      expect(f.title + f.detail).not.toMatch(/\byou should\b|\bmust\b|\bstop doing\b/i);
    }
  });
});

describe("cockpitReport", () => {
  it("handles an empty book without throwing", () => {
    const rep = cockpitReport([]);
    expect(rep.closedTrades).toBe(0);
    expect(rep.findings).toEqual([]);
    expect(rep.time.insufficient).toBe(true);
  });

  it("ignores open positions throughout", () => {
    const rep = cockpitReport([...many(10, { isOpen: true, netPnl: 9999 }), ...many(3, { netPnl: 100 })]);
    expect(rep.closedTrades).toBe(3);
  });
});
