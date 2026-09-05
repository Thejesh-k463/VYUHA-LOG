import { describe, expect, it } from "vitest";
import { alignToAnchor, modalAnchor, sessionCalendar, truncateTo } from "@/lib/atlas/anchor";
import { toSeries, type Bar } from "@/lib/atlas/types";

const DAY = 86_400_000;
const iso = (i: number) => new Date(Date.UTC(2026, 0, 5) + i * DAY).toISOString().slice(0, 10);

function bars(symbol: string, days: number[], close = 100): Bar[] {
  return days.map((d) => ({ symbol, date: iso(d), high: close, low: close, close, volume: 1000 }));
}

describe("A10 — the daily anchor is the latest MODAL session, not max(date)", () => {
  it("picks the session most symbols actually closed on", () => {
    // Four symbols on day 2; ONE symbol refreshed early to day 3. max(date)
    // would publish a one-symbol cross-section as the whole market's breadth.
    const series = toSeries([
      ...bars("AAA", [0, 1, 2]),
      ...bars("BBB", [0, 1, 2]),
      ...bars("CCC", [0, 1, 2]),
      ...bars("DDD", [0, 1, 2]),
      ...bars("EEE", [0, 1, 2, 3]),
    ]);
    expect(modalAnchor(series)).toBe(iso(2));
    const maxDate = series.flatMap((s) => s.bars.map((b) => b.date)).sort().at(-1);
    expect(maxDate).toBe(iso(3));
    expect(modalAnchor(series)).not.toBe(maxDate);
  });

  it("breaks a tie towards the LATER date", () => {
    const series = toSeries([
      ...bars("AAA", [0, 1]),
      ...bars("BBB", [0, 1]),
      ...bars("CCC", [0, 1, 2]),
      ...bars("DDD", [0, 1, 2]),
    ]);
    expect(modalAnchor(series)).toBe(iso(2));
  });

  it("returns null for an empty universe rather than inventing a session", () => {
    expect(modalAnchor([])).toBeNull();
    const alignment = alignToAnchor([], null);
    expect(alignment.anchor).toBeNull();
    expect(alignment.aligned).toEqual([]);
  });

  it("truncates symbols ahead of the anchor and excludes those behind it, publishing both", () => {
    const series = toSeries([
      ...bars("AAA", [0, 1, 2]),
      ...bars("BBB", [0, 1, 2]),
      ...bars("CCC", [0, 1, 2]),
      ...bars("AHEAD", [0, 1, 2, 3]),
      ...bars("STALE", [0]),
    ]);
    const alignment = alignToAnchor(series, modalAnchor(series));
    expect(alignment.anchor).toBe(iso(2));
    expect(alignment.truncated).toEqual(["AHEAD"]);
    expect(alignment.aligned.map((s) => s.symbol)).toEqual(["AAA", "AHEAD", "BBB", "CCC"]);
    expect(alignment.aligned.find((s) => s.symbol === "AHEAD")!.bars.at(-1)!.date).toBe(iso(2));
    expect(alignment.stale).toEqual([{ symbol: "STALE", lastSeen: iso(0), sessionsBehind: 2 }]);
    expect(alignment.coverage).toBe(4);
    expect(alignment.total).toBe(5);
  });

  it("sessionCalendar and truncateTo are the replay primitives", () => {
    const series = toSeries([...bars("AAA", [0, 2, 4]), ...bars("BBB", [1, 2, 3])]);
    expect(sessionCalendar(series)).toEqual([iso(0), iso(1), iso(2), iso(3), iso(4)]);
    const cut = truncateTo(series, iso(2));
    expect(cut.map((s) => s.bars.length)).toEqual([2, 2]);
  });
});
