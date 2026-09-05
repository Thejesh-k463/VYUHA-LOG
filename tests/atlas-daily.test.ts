import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checksumInput, computeAtlasDaily, type AtlasMetricRow } from "@/lib/atlas/compute-daily";
import type { Bar, SectorRef } from "@/lib/atlas/types";

// The hash is INJECTED: lib/atlas must not import `node:crypto` (invariant 2).
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const GENERATED_AT = "2026-02-04T04:00:00.000Z";

const DAY = 86_400_000;
const iso = (i: number) => new Date(Date.UTC(2026, 0, 5) + i * DAY).toISOString().slice(0, 10);

function bars(symbol: string, closes: number[], volume = 1000): Bar[] {
  return closes.map((c, i) => ({ symbol, date: iso(i), high: c, low: c, close: c, volume }));
}

const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
const falling = Array.from({ length: 30 }, (_, i) => 200 - i);
const flat = Array.from({ length: 30 }, () => 150);
// 1:5 split on session 25 that nobody adjusted: 500 -> 100 overnight.
const split = [...Array.from({ length: 25 }, () => 500), 100, 101, 102, 103, 104];

const UNIVERSE: Bar[] = [
  ...bars("AAA", rising),
  ...bars("BBB", falling),
  ...bars("CCC", flat),
  ...bars("SPLITCO", split),
  ...bars("ETFX", rising),
  ...bars("SLOWCO", rising.slice(0, 28)), // last bar is session 27, two behind
];

const MAP: Record<string, SectorRef> = {
  AAA: { sector: "Banks", tier: "high" },
  BBB: { sector: "Banks", tier: "high" },
  CCC: { sector: "Pharma", tier: "user" },
  SPLITCO: { sector: "Pharma", tier: "index" },
};
const sectorOf = (s: string): SectorRef | null => MAP[s] ?? null;

const OPTS = {
  generatedAt: GENERATED_AT,
  sha256,
  isEligible: (symbol: string) => symbol !== "ETFX",
};

const run = (input: Bar[] = UNIVERSE) => computeAtlasDaily(input, sectorOf, OPTS);
const metric = (rows: AtlasMetricRow[], name: string, group = "*") =>
  rows.find((r) => r.metric === name && r.group_name === group)!;

describe("computeAtlasDaily — the snapshot", () => {
  it("anchors on the modal session and publishes both universe counts", () => {
    const r = run();
    expect(r.daily).not.toBeNull();
    expect(r.daily!.as_of).toBe(iso(29));
    expect(r.daily!.universe_included).toBe(4); // AAA BBB CCC SPLITCO
    expect(r.daily!.universe_excluded).toBe(2); // ETFX (non-equity) + SLOWCO (stale)
    expect(r.daily!.anchor_coverage).toBe(4);
    expect(r.daily!.anchor_coverage_ppm).toBe(800_000);
    expect(r.daily!.spec_version).toBe("atlas-core/1.0.0");
    expect(r.daily!.source_mode).toBe("bhavcopy_local");
    expect(r.daily!.generated_at).toBe(GENERATED_AT);
  });

  it("honours a caller-supplied eligibility predicate (ETF / index exclusion)", () => {
    const r = run();
    expect(r.alignment.aligned.map((s) => s.symbol)).toEqual(["AAA", "BBB", "CCC", "SPLITCO"]);
    const nonEquity = r.staleness.filter((s) => s.reason === "non_equity");
    expect(nonEquity.map((s) => s.symbol)).toEqual(["ETFX"]);

    const withEtf = computeAtlasDaily(UNIVERSE, sectorOf, { generatedAt: GENERATED_AT, sha256 });
    expect(withEtf.daily!.universe_included).toBe(5);
    expect(withEtf.staleness.some((s) => s.reason === "non_equity")).toBe(false);
  });

  it("records the stale symbol with how far behind it is", () => {
    const stale = run().staleness.find((s) => s.reason === "no_bar_on_anchor")!;
    expect(stale).toEqual({
      as_of: iso(29),
      symbol: "SLOWCO",
      reason: "no_bar_on_anchor",
      last_seen_date: iso(27),
      sessions_behind: 2,
    });
  });

  it("keeps the split symbol in BREADTH and drops it from every RETURN window", () => {
    const r = run();
    const breadth = r.payload!.market_pulse.breadth;
    expect(breadth.counts.valid).toBe(4);
    expect(breadth.counts).toEqual({ advancing: 2, declining: 1, unchanged: 1, valid: 4 });
    expect(metric(r.metrics, "advance_pct_ppm").value_ppm).toBe(500_000);

    // Excluded from every window the gap actually spans...
    for (const key of ["1w", "1m"] as const) {
      expect(r.payload!.market_pulse.performance.windows[key].corporateActionExcluded).toContain("SPLITCO");
    }
    // ...and counted as insufficient history, NOT as an exclusion, where the
    // window is longer than anything the symbol has. The two are different facts.
    for (const key of ["2m", "3m"] as const) {
      expect(r.payload!.market_pulse.performance.windows[key].corporateActionExcluded).toEqual([]);
      expect(r.payload!.market_pulse.performance.windows[key].insufficient).toContain("SPLITCO");
    }
    expect(metric(r.metrics, "return_1w_ppm").denominator).toBe(3);
    expect(r.payload!.market_pulse.performance.ytd.corporateActionExcluded).toEqual(["SPLITCO"]);

    const ca = r.staleness.find((s) => s.reason === "corporate_action_unreconciled")!;
    expect(ca.symbol).toBe("SPLITCO");
    expect(ca.last_seen_date).toBe(iso(25));
    expect(r.payload!.warnings.some((w) => w.startsWith("Excluded from return windows:"))).toBe(true);
  });

  it("refuses the 52w label at 30 sessions and states the shortfall instead", () => {
    const r = run();
    expect(r.payload!.market_pulse.new_high_low.label).toBe("30d");
    expect(metric(r.metrics, "above_sma20_pct_ppm").denominator).toBe(4);
    expect(metric(r.metrics, "above_sma200_pct_ppm").value_ppm).toBeNull();
    expect(metric(r.metrics, "above_sma200_pct_ppm").denominator).toBeNull();
    expect(r.ledger.shortfalls.map((s) => s.line)).toContain("Needs 200 sessions of price history. You have 30.");
  });

  it("labels the regime unknown rather than guessing when SMA50 has no denominator", () => {
    const r = run();
    expect(r.payload!.regime.regime).toBe("unknown");
    expect(r.payload!.regime.reason).toBe("missing_sma50");
    expect(r.payload!.regime.thresholds.expansionAboveSma50Ppm).toBe(550_000);
  });

  it("every metric row carries its own denominator, and a count is never a ratio", () => {
    const r = run();
    for (const row of r.metrics) {
      if (row.value_ppm !== null) expect(row.denominator).toBeGreaterThan(0);
      if (row.denominator === null) expect(row.value_ppm).toBeNull();
    }
    const advancing = metric(r.metrics, "advancing_count");
    expect(advancing.value_ppm).toBeNull();
    expect(advancing.numerator).toBe(2);
    expect(advancing.denominator).toBe(4);
    expect(metric(r.metrics, "net_high_low").value_ppm).toBeNull();
    expect(metric(r.metrics, "net_high_low").numerator).toBe(0);
  });

  it("publishes sector rotation with a per-group denominator and the point-in-time caveat", () => {
    const r = run();
    const banks = metric(r.metrics, "rotation_1d_ppm", "Banks");
    expect(banks.group_kind).toBe("sector");
    expect(banks.denominator).toBe(2);
    expect(r.payload!.rotation.caveat).toBe("Current classification, not point-in-time.");
    expect(r.payload!.warnings).toContain("Current classification, not point-in-time.");
    // Pharma holds CCC and SPLITCO. The split is four sessions back, OUTSIDE
    // the one-day rotation window, so it does not exclude the symbol here —
    // the guard is scoped to the window, not applied to the whole symbol.
    const pharma = metric(r.metrics, "rotation_1d_ppm", "Pharma");
    expect(pharma.denominator).toBe(2);
    expect(pharma.coverage_ppm).toBe(1_000_000);
    expect(pharma.value_ppm).toBe(4_855); // mean(CCC 0%, SPLITCO +0.97%)
    expect(metric(r.metrics, "classification_coverage_ppm").value_ppm).toBe(1_000_000);
  });

  it("replays 90 sessions of PRICE metrics only, ending at the anchor", () => {
    const r = run();
    expect(r.payload!.history).toHaveLength(30);
    expect(r.payload!.history.at(-1)!.as_of).toBe(iso(29));
    expect(r.payload!.history.at(-1)!.advancing).toBe(2);
    expect(r.payload!.history[0].advance_pct_ppm).toBeNull(); // one bar, no direction yet
    const capped = computeAtlasDaily(UNIVERSE, sectorOf, { ...OPTS, historySessions: 5 });
    expect(capped.payload!.history).toHaveLength(5);
  });

  it("is byte-identical for the same input in a different row order", () => {
    const shuffled = [...UNIVERSE].reverse();
    const a = JSON.stringify(run(UNIVERSE));
    const b = JSON.stringify(run(shuffled));
    expect(b).toBe(a);
    expect(JSON.stringify(run(UNIVERSE))).toBe(a);
  });

  it("checksums the sorted (symbol,date,close,volume) rows, and notices a changed close", () => {
    const shuffled = [...UNIVERSE].reverse();
    expect(checksumInput(shuffled)).toBe(checksumInput(UNIVERSE));
    expect(run().daily!.input_checksum).toBe(sha256(checksumInput(UNIVERSE)));

    const tampered = UNIVERSE.map((b) =>
      b.symbol === "AAA" && b.date === iso(29) ? { ...b, close: b.close + 1 } : b,
    );
    expect(run(tampered).daily!.input_checksum).not.toBe(run().daily!.input_checksum);
  });

  it("returns an empty screen, not a zeroed one, with no bars at all", () => {
    const r = computeAtlasDaily([], sectorOf, OPTS);
    expect(r.daily).toBeNull();
    expect(r.metrics).toEqual([]);
    expect(r.payload).toBeNull();
    expect(r.ledger.as_of).toBeNull();
    expect(r.ledger.anchor.coverage).toBe(0);
  });
});
