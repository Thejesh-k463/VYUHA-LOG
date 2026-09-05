import { describe, expect, it } from "vitest";
import { buildLedger, shortfallLine, type LedgerInput } from "@/lib/atlas/ledger";

const base: LedgerInput = {
  asOf: "2026-09-04",
  generatedAt: "2026-09-05T04:00:00.000Z",
  specVersion: "atlas-core/1.0.0",
  inputChecksum: "abc123",
  anchorCoverage: 2821,
  anchorTotal: 2957,
  truncated: ["FAST"],
  stale: [{ symbol: "SLOW", lastSeen: "2026-08-28", sessionsBehind: 5 }],
  nonEquity: ["NIFTYBEES"],
  insufficientHistory: ["NEWCO"],
  corporateAction: [{ symbol: "SPLITCO", date: "2026-08-12", ratioPpm: -800_000 }],
  denominators: [
    { metric: "above_sma200_pct_ppm", denominator: 43, coverage_ppm: 15_000, insufficient_history: 2778 },
    { metric: "advance_pct_ppm", denominator: 2821, coverage_ppm: 1_000_000, insufficient_history: 0 },
  ],
  shortfalls: [{ metric: "above_sma200_pct_ppm", needsSessions: 200, youHaveSessions: 43, line: shortfallLine(200, 43) }],
};

describe("the staleness ledger publishes the four things", () => {
  it("1 — the anchor, its coverage and the policy that chose it", () => {
    const l = buildLedger(base);
    expect(l.as_of).toBe("2026-09-04");
    expect(l.anchor.coverage).toBe(2821);
    expect(l.anchor.total).toBe(2957);
    expect(l.anchor.coverage_ppm).toBe(954_007);
    expect(l.anchor.truncated).toBe(1);
    expect(l.anchor.policy).toBe("latest modal session, ties to the later date");
  });

  it("2 — a per-metric denominator; the universe count is never reused", () => {
    const l = buildLedger(base);
    const sma200 = l.denominators.find((d) => d.metric === "above_sma200_pct_ppm")!;
    expect(sma200.denominator).toBe(43);
    expect(sma200.denominator).not.toBe(l.anchor.coverage);
  });

  it("3 — insufficient history is its own reason, separate from 'excluded'", () => {
    const l = buildLedger(base);
    const reasons = l.exclusions.map((e) => e.reason);
    expect(reasons).toContain("insufficient_history");
    expect(reasons).toContain("no_bar_on_anchor");
    const insufficient = l.exclusions.find((e) => e.reason === "insufficient_history")!;
    const stale = l.exclusions.find((e) => e.reason === "no_bar_on_anchor")!;
    expect(insufficient.symbols.map((s) => s.symbol)).toEqual(["NEWCO"]);
    expect(stale.symbols).toEqual([{ symbol: "SLOW", lastSeen: "2026-08-28", sessionsBehind: 5 }]);
    expect(l.shortfalls[0].line).toBe("Needs 200 sessions of price history. You have 43.");
  });

  it("4 — the corporate-action state, with the gap that caused it", () => {
    const l = buildLedger(base);
    const ca = l.exclusions.find((e) => e.reason === "corporate_action_unreconciled")!;
    expect(ca.count).toBe(1);
    expect(ca.symbols[0]).toEqual({
      symbol: "SPLITCO",
      lastSeen: "2026-08-12",
      detail: "close gap -80.0% on 2026-08-12",
    });
  });

  it("carries the two identifiers that make a stored snapshot re-checkable", () => {
    const l = buildLedger(base);
    expect(l.spec_version).toBe("atlas-core/1.0.0");
    expect(l.input_checksum).toBe("abc123");
    expect(l.generated_at).toBe("2026-09-05T04:00:00.000Z");
  });

  it("totals every exclusion and orders deterministically", () => {
    const l = buildLedger(base);
    expect(l.excluded_total).toBe(5);
    expect(l.exclusions.map((e) => e.reason)).toEqual([
      "no_bar_on_anchor",
      "truncated_to_anchor",
      "non_equity",
      "insufficient_history",
      "corporate_action_unreconciled",
    ]);
    expect(l.denominators.map((d) => d.metric)).toEqual(["above_sma200_pct_ppm", "advance_pct_ppm"]);
    expect(JSON.stringify(buildLedger(base))).toBe(JSON.stringify(l));
  });

  it("omits a reason nobody triggered rather than printing a zero row", () => {
    const clean = buildLedger({ ...base, nonEquity: [], corporateAction: [], insufficientHistory: [] });
    expect(clean.exclusions.map((e) => e.reason)).toEqual(["no_bar_on_anchor", "truncated_to_anchor"]);
    expect(clean.excluded_total).toBe(2);
  });

  it("does not divide by an empty universe", () => {
    const nothing = buildLedger({ ...base, asOf: null, anchorCoverage: 0, anchorTotal: 0 });
    expect(nothing.anchor.coverage_ppm).toBe(0);
    expect(nothing.anchor.date).toBeNull();
  });
});
