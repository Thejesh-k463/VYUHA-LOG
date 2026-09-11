import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { blackScholes, positionGreeks, portfolioGreeks, resolveIvSource, DEFAULT_IV_PCT } from "@/lib/analytics/greeks";

/**
 * R101 (v4.3.0 fix wave 1). The Risk panel's footnote and this module's header
 * said Indian stock options are American-style. NSE Clearing's settlement page
 * says the exercise style is European and "Final Exercise is Automatic on
 * expiry" (SEBI CIR/DNPD/6/2010, 27 Oct 2010). BSE stock options are not
 * verified, so the copy names NSE and leaves BSE unnamed.
 */
describe("the exercise-style statement is the exchange's (R101)", () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");

  it("the Greeks footnote and the module header say NSE stock options are European-style", () => {
    const panel = read("components/risk/greeks-panel.tsx");
    const mod = read("lib/analytics/greeks.ts");
    for (const [rel, src] of [["greeks-panel.tsx", panel], ["greeks.ts", mod]] as const) {
      expect(src, `${rel} still calls stock options American-style`).not.toMatch(/stock options are\s+American-style/i);
      expect(src, `${rel} names BSE's exercise style, which is not verified`).not.toMatch(/\bBSE stock options are\b/i);
    }
    expect(panel).toMatch(/NSE stock options are\s+European-style/);
    expect(mod).toMatch(/NSE stock options are\s+European-style/);
  });
});

describe("blackScholes — put-call parity (C - P = S - K·e^-rT, holds for any inputs)", () => {
  it("holds for an ATM 30d option", () => {
    const c = blackScholes(24000, 24000, 30, "CE", 15, 0.07);
    const p = blackScholes(24000, 24000, 30, "PE", 15, 0.07);
    const disc = 24000 * Math.exp(-0.07 * (30 / 365));
    expect(c.price - p.price).toBeCloseTo(24000 - disc, 1);
  });

  it("holds for an OTM strike further out", () => {
    const c = blackScholes(1800, 1900, 60, "CE", 25, 0.07);
    const p = blackScholes(1800, 1900, 60, "PE", 25, 0.07);
    const disc = 1900 * Math.exp(-0.07 * (60 / 365));
    expect(c.price - p.price).toBeCloseTo(1800 - disc, 1);
  });
});

describe("blackScholes — ATM delta near 0.5 / -0.5", () => {
  it("call delta and put delta sum to ~1 at the money", () => {
    const c = blackScholes(1000, 1000, 30, "CE", 20, 0);
    const p = blackScholes(1000, 1000, 30, "PE", 20, 0);
    expect(c.delta).toBeGreaterThan(0.45);
    expect(c.delta).toBeLessThan(0.6);
    expect(c.delta - p.delta).toBeCloseTo(1, 6); // delta_call - delta_put = 1 always
  });
});

describe("blackScholes — deep ITM/OTM asymptotics", () => {
  it("deep ITM call: delta -> 1, price -> intrinsic-ish", () => {
    const c = blackScholes(3000, 1000, 30, "CE", 20, 0.07);
    expect(c.delta).toBeGreaterThan(0.99);
    expect(c.price).toBeGreaterThan(1900); // ~ S - K discounted
  });

  it("deep OTM call: delta -> 0, price -> ~0", () => {
    const c = blackScholes(500, 3000, 30, "CE", 20, 0.07);
    expect(c.delta).toBeLessThan(0.01);
    expect(c.price).toBeLessThan(1);
  });
});

describe("blackScholes — Greek signs and shape", () => {
  const c = blackScholes(1000, 1000, 30, "CE", 20, 0);
  const p = blackScholes(1000, 1000, 30, "PE", 20, 0);

  it("gamma and vega are positive for both calls and puts", () => {
    expect(c.gamma).toBeGreaterThan(0);
    expect(p.gamma).toBeGreaterThan(0);
    expect(c.vega).toBeGreaterThan(0);
    expect(p.vega).toBeGreaterThan(0);
  });

  it("gamma and vega are identical for a call and put at the same strike/expiry", () => {
    expect(c.gamma).toBeCloseTo(p.gamma, 6);
    expect(c.vega).toBeCloseTo(p.vega, 6);
  });

  it("theta is negative for a long option (time decay costs the holder) when r=0", () => {
    expect(c.thetaPerDay).toBeLessThan(0);
    expect(p.thetaPerDay).toBeLessThan(0);
  });
});

describe("blackScholes — expired / zero-time-value fallback", () => {
  it("dte=0 collapses to intrinsic value with boundary Greeks", () => {
    const itmCall = blackScholes(110, 100, 0, "CE", 20, 0.07);
    expect(itmCall.price).toBe(10);
    expect(itmCall.delta).toBe(1);
    expect(itmCall.gamma).toBe(0);
    expect(itmCall.vega).toBe(0);

    const otmCall = blackScholes(90, 100, 0, "CE", 20, 0.07);
    expect(otmCall.price).toBe(0);
    expect(otmCall.delta).toBe(0);
  });

  it("non-positive IV also collapses to intrinsic (guards against bad input)", () => {
    const r = blackScholes(110, 100, 30, "CE", 0, 0.07);
    expect(r.price).toBe(10);
    expect(r.gamma).toBe(0);
  });
});

describe("positionGreeks", () => {
  const base = { id: 1, symbol: "NIFTY", spot: 24000, strike: 24000, dte: 30, optionType: "CE" as const, ivPct: 15, qty: 75 };

  it("scales per-unit Greeks by qty for a long position", () => {
    const g = positionGreeks({ ...base, side: "long" })!;
    expect(g.delta).toBeCloseTo(g.perUnit.delta * 75, 2);
    expect(g.thetaPerDay).toBeCloseTo(g.perUnit.thetaPerDay * 75, 2);
  });

  it("short flips the sign of every Greek vs the equivalent long", () => {
    const long = positionGreeks({ ...base, side: "long" })!;
    const short = positionGreeks({ ...base, side: "short" })!;
    expect(short.delta).toBeCloseTo(-long.delta, 6);
    expect(short.gamma).toBeCloseTo(-long.gamma, 6);
    expect(short.thetaPerDay).toBeCloseTo(-long.thetaPerDay, 6);
    expect(short.vega).toBeCloseTo(-long.vega, 6);
  });

  it("falls back to the default IV when none is set, and flags it", () => {
    const g = positionGreeks({ ...base, ivPct: null, side: "long" })!;
    expect(g.ivPct).toBe(DEFAULT_IV_PCT);
    expect(g.ivIsDefault).toBe(true);
    expect(g.ivSource).toBe("default");
  });

  it("IND-12 — falls back to the market IV (India VIX) before the flat default", () => {
    const g = positionGreeks({ ...base, ivPct: null, marketIvPct: 13.24, side: "long" })!;
    expect(g.ivPct).toBe(13.24);
    expect(g.ivIsDefault).toBe(true); // still "not the user's own" — market fallback also flagged
    expect(g.ivSource).toBe("market");
  });

  it("IND-12 — the position's own IV always wins over the market IV", () => {
    const g = positionGreeks({ ...base, ivPct: 22, marketIvPct: 13.24, side: "long" })!;
    expect(g.ivPct).toBe(22);
    expect(g.ivIsDefault).toBe(false);
    expect(g.ivSource).toBe("position");
  });

  it("returns null when spot or dte is unavailable (can't be priced)", () => {
    expect(positionGreeks({ ...base, spot: null, side: "long" })).toBeNull();
    expect(positionGreeks({ ...base, dte: null, side: "long" })).toBeNull();
  });
});

describe("resolveIvSource — IND-12 three-tier IV fallback", () => {
  it("prefers the position's own IV", () => {
    expect(resolveIvSource(22, 13.24)).toEqual({ ivPct: 22, source: "position" });
  });

  it("falls back to market IV when position IV is null", () => {
    expect(resolveIvSource(null, 13.24)).toEqual({ ivPct: 13.24, source: "market" });
  });

  it("falls back to market IV when position IV is zero or negative", () => {
    expect(resolveIvSource(0, 13.24)).toEqual({ ivPct: 13.24, source: "market" });
    expect(resolveIvSource(-5, 13.24)).toEqual({ ivPct: 13.24, source: "market" });
  });

  it("falls back to the flat default when neither position nor market IV is available", () => {
    expect(resolveIvSource(null, null)).toEqual({ ivPct: DEFAULT_IV_PCT, source: "default" });
    expect(resolveIvSource(null, undefined)).toEqual({ ivPct: DEFAULT_IV_PCT, source: "default" });
    expect(resolveIvSource(null, 0)).toEqual({ ivPct: DEFAULT_IV_PCT, source: "default" });
  });
});

describe("portfolioGreeks", () => {
  it("aggregates position Greeks and skips unpriceable legs", () => {
    const inputs = [
      { id: 1, symbol: "NIFTY", spot: 24000, strike: 24000, dte: 30, optionType: "CE" as const, ivPct: 15, qty: 75, side: "long" as const },
      { id: 2, symbol: "NIFTY", spot: 24000, strike: 24200, dte: 30, optionType: "CE" as const, ivPct: 15, qty: 75, side: "short" as const },
      { id: 3, symbol: "BANKNIFTY", spot: null, strike: 52000, dte: 30, optionType: "PE" as const, ivPct: null, qty: 30, side: "long" as const },
    ];
    const port = portfolioGreeks(inputs);
    expect(port.count).toBe(2);
    expect(port.skipped).toBe(1);
    const manualDelta = port.positions.reduce((s, p) => s + p.delta, 0);
    expect(port.delta).toBeCloseTo(manualDelta, 2);
  });

  it("counts positions priced with the default IV fallback", () => {
    const port = portfolioGreeks([
      { id: 1, symbol: "TCS", spot: 2000, strike: 2000, dte: 20, optionType: "CE" as const, ivPct: null, qty: 175, side: "long" as const },
    ]);
    expect(port.usingDefaultIvCount).toBe(1);
  });

  it("handles an empty book", () => {
    const port = portfolioGreeks([]);
    expect(port.count).toBe(0);
    expect(port.delta).toBe(0);
  });
});
