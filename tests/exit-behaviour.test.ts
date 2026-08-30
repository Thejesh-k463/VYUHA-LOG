import { describe, expect, it } from "vitest";
import {
  EXIT_TRIGGERS,
  exitClock,
  exitTriggers,
  fragmentation,
  holdingClock,
  minutesOfDay,
  type ExitTrade,
} from "@/lib/analytics/exit-behaviour";

/**
 * Built from columns the journal always captured and never read. The property
 * every one of these shares, and the reason they are grouped: a row missing the
 * field is EXCLUDED and COUNTED, never bucketed as "unknown" — which would
 * quietly change the denominator (invariant 6).
 */

const t = (o: Partial<ExitTrade>): ExitTrade => ({
  netPnl: 0,
  grossPnl: 0,
  buyValue: 10000,
  isOpen: false,
  ...o,
});

describe("minutesOfDay", () => {
  it("reads both HH:MM and HH:MM:SS", () => {
    expect(minutesOfDay("09:15")).toBe(555);
    expect(minutesOfDay("15:30:45")).toBe(930);
  });

  it("refuses anything that is not a clock time", () => {
    for (const bad of [null, undefined, "", "abc", "25:00", "09:75", "9"]) {
      expect(minutesOfDay(bad as string)).toBeNull();
    }
  });
});

describe("exitClock", () => {
  it("buckets exits into the SAME sessions cockpit.ts uses for entries", () => {
    const r = exitClock([
      t({ exitTime: "09:20", netPnl: 100 }),
      t({ exitTime: "09:30", netPnl: -50 }),
      t({ exitTime: "15:10", netPnl: 200 }),
    ]);
    const open = r.bands.find((b) => b.key === "Opening drive")!;
    expect(open.count).toBe(2);
    expect(open.net).toBe(50);
    expect(open.winRate).toBeCloseTo(0.5, 6);
    expect(r.bands.find((b) => b.key === "Closing hour")!.count).toBe(1);
  });

  it("counts trades with no exit time instead of guessing one", () => {
    const r = exitClock([t({ exitTime: "09:20" }), t({ exitTime: null }), t({ exitTime: "" })]);
    expect(r.withTime).toBe(1);
    expect(r.withoutTime).toBe(2);
    // Nothing was invented to fill the gap.
    expect(r.bands.reduce((s, b) => s + b.count, 0)).toBe(1);
  });

  it("reports off-hours exits rather than dropping them, so bands reconcile", () => {
    const r = exitClock([t({ exitTime: "09:20" }), t({ exitTime: "18:00" })]);
    expect(r.withTime).toBe(2);
    expect(r.offHours).toBe(1);
    expect(r.bands.reduce((s, b) => s + b.count, 0) + r.offHours).toBe(r.withTime);
  });

  it("ignores open positions — an exit clock needs an exit", () => {
    expect(exitClock([t({ exitTime: "09:20", isOpen: true })]).withTime).toBe(0);
  });
});

describe("holdingClock", () => {
  const sameDay = () => true;

  it("buckets time in trade", () => {
    const r = holdingClock(
      [
        t({ entryTime: "09:15", exitTime: "09:18", netPnl: -10 }), // 3 min
        t({ entryTime: "09:15", exitTime: "09:40", netPnl: 50 }), // 25 min
        t({ entryTime: "09:15", exitTime: "12:00", netPnl: 500 }), // 165 min
      ],
      sameDay,
    );
    expect(r.measured).toBe(3);
    expect(r.buckets.find((b) => b.key === "under 5 min")!.count).toBe(1);
    expect(r.buckets.find((b) => b.key === "5–30 min")!.count).toBe(1);
    expect(r.buckets.find((b) => b.key === "over 2 h")!.count).toBe(1);
  });

  it("refuses an exit that precedes its entry rather than reporting negative time", () => {
    const r = holdingClock([t({ entryTime: "14:00", exitTime: "09:20" })], sameDay);
    expect(r.measured).toBe(0);
    expect(r.unmeasurable).toBe(1);
  });

  it("counts positions missing either time", () => {
    const r = holdingClock([t({ entryTime: "09:15", exitTime: null }), t({ entryTime: null, exitTime: "10:00" })], sameDay);
    expect(r.measured).toBe(0);
    expect(r.unmeasurable).toBe(2);
  });
});

describe("fragmentation", () => {
  it("buckets by total executed orders and finds the median", () => {
    const r = fragmentation([
      t({ buyOrderCount: 1, sellOrderCount: 1, netPnl: 100 }), // 2
      t({ buyOrderCount: 2, sellOrderCount: 2, netPnl: -40 }), // 4
      t({ buyOrderCount: 6, sellOrderCount: 5, netPnl: -300 }), // 11
    ]);
    expect(r.measured).toBe(3);
    expect(r.medianFills).toBe(4);
    expect(r.buckets.find((b) => b.key === "2 fills (one in, one out)")!.count).toBe(1);
    expect(r.buckets.find((b) => b.key === "9+ fills")!.net).toBe(-300);
  });

  it("averages the median across an even count", () => {
    const r = fragmentation([
      t({ buyOrderCount: 1, sellOrderCount: 1 }), // 2
      t({ buyOrderCount: 2, sellOrderCount: 2 }), // 4
    ]);
    expect(r.medianFills).toBe(3);
  });

  it("has no median at all with nothing to measure", () => {
    expect(fragmentation([]).medianFills).toBeNull();
    expect(fragmentation([t({ buyOrderCount: 0, sellOrderCount: 0 })]).measured).toBe(0);
  });
});

describe("exitTriggers", () => {
  it("crosses the reason with how much of the move the exit captured", () => {
    const r = exitTriggers([
      t({ exitTrigger: "target hit", capturedPct: 80, netPnl: 500 }),
      t({ exitTrigger: "target hit", capturedPct: 76, netPnl: 400 }),
      t({ exitTrigger: "panic", capturedPct: 31, netPnl: -200 }),
    ]);
    const target = r.rows.find((x) => x.key === "target hit")!;
    expect(target.count).toBe(2);
    expect(target.avgCapturedPct).toBe(78); // the sentence this feature exists for
    expect(r.rows.find((x) => x.key === "panic")!.avgCapturedPct).toBe(31);
  });

  it("EXCLUDES unanswered exits and says how many, never bucketing them as other", () => {
    const r = exitTriggers([
      t({ exitTrigger: "target hit" }),
      t({ exitTrigger: null }),
      t({ exitTrigger: "   " }),
    ]);
    expect(r.answered).toBe(1);
    expect(r.unanswered).toBe(2);
    expect(r.rows.map((x) => x.key)).toEqual(["target hit"]);
    expect(r.rows.some((x) => /other|unknown/i.test(x.key))).toBe(false);
  });

  it("returns null capture rather than 0 when no row in a bucket has an excursion", () => {
    const r = exitTriggers([t({ exitTrigger: "stop hit", capturedPct: null })]);
    // 0 would read as "captured none of the move", which is a different claim
    // from "we could not measure it".
    expect(r.rows[0].avgCapturedPct).toBeNull();
    expect(r.rows[0].capturedFrom).toBe(0);
  });

  it("ranks the most-used reason first", () => {
    const r = exitTriggers([
      t({ exitTrigger: "stop hit" }),
      t({ exitTrigger: "target hit" }),
      t({ exitTrigger: "target hit" }),
    ]);
    expect(r.rows[0].key).toBe("target hit");
  });

  it("ignores open positions", () => {
    expect(exitTriggers([t({ exitTrigger: "target hit", isOpen: true })]).answered).toBe(0);
  });
});

describe("EXIT_TRIGGERS", () => {
  it("offers reasons that distinguish process from impulse", () => {
    // The whole point is that "target hit" and "panic" land in different rows.
    expect(EXIT_TRIGGERS).toContain("target hit");
    expect(EXIT_TRIGGERS).toContain("panic");
    expect(EXIT_TRIGGERS).toContain("cut early — fear");
    expect(new Set(EXIT_TRIGGERS).size).toBe(EXIT_TRIGGERS.length);
  });
});
