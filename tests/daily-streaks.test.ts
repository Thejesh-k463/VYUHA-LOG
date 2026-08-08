import { describe, expect, it } from "vitest";
import { streakReport } from "@/lib/analytics/daily-streaks";

describe("streakReport", () => {
  it("counts consecutive TRADED days — a gap (weekend, day off) doesn't break a run", () => {
    // Fri green, Mon green: two traded days in a row, despite the calendar gap.
    const r = streakReport({ "2026-07-03": 500, "2026-07-06": 700 });
    expect(r.currentGreen).toBe(2);
    expect(r.bestGreen).toBe(2);
  });

  it("a red day breaks the green run and starts a red one", () => {
    const r = streakReport({ "2026-07-01": 100, "2026-07-02": 100, "2026-07-03": -50 });
    expect(r.bestGreen).toBe(2);
    expect(r.currentGreen).toBe(0);
    expect(r.currentRed).toBe(1);
  });

  it("a flat day neither extends nor breaks — inflating the streak would be a lie", () => {
    const r = streakReport({ "2026-07-01": 100, "2026-07-02": 0, "2026-07-03": 100 });
    expect(r.greenDays).toBe(2);
    expect(r.flatDays).toBe(1);
    // The run survives the flat day but the flat day is not counted as green.
    expect(r.currentGreen).toBe(2);
    expect(r.bestGreen).toBe(2);
  });

  it("best and worst are the actual extremes, with their dates", () => {
    const r = streakReport({ "2026-07-01": 900, "2026-07-02": -1200, "2026-07-03": 300 });
    expect(r.best).toEqual({ date: "2026-07-01", net: 900 });
    expect(r.worst).toEqual({ date: "2026-07-02", net: -1200 });
    expect(r.tradedDays).toBe(3);
  });

  it("order of the input object never matters — days are sorted by date", () => {
    const a = streakReport({ "2026-07-03": -10, "2026-07-01": 10, "2026-07-02": 10 });
    expect(a.bestGreen).toBe(2);
    expect(a.currentRed).toBe(1);
  });

  it("empty input returns zeros and nulls, never NaN", () => {
    const r = streakReport({});
    expect(r).toMatchObject({ currentGreen: 0, bestGreen: 0, tradedDays: 0, best: null, worst: null });
  });

  it("an all-red book reports no green streak and a truthful worst day", () => {
    const r = streakReport({ "2026-07-01": -100, "2026-07-02": -200 });
    expect(r.bestGreen).toBe(0);
    expect(r.currentRed).toBe(2);
    expect(r.worst!.net).toBe(-200);
    // best is the least-bad day; the UI only frames it as an achievement when
    // it is actually positive.
    expect(r.best!.net).toBe(-100);
  });
});
