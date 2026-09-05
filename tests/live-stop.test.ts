import { describe, expect, it } from "vitest";
import { computeStop, roundStopToTick, type StopSettings, type StopSetup } from "@/lib/live/stop";

/**
 * `computeStop` — 03 §5, spec §4.3. Integer paise throughout.
 *
 * The three properties under test that are not "does the arithmetic work":
 *   * every branch returns its `source`, so the chart line can be labelled;
 *   * tick rounding moves the stop AWAY from entry in BOTH directions;
 *   * `entry === stop` and a wrong-side stop are TYPED ERRORS, never Infinity
 *     or NaN leaking into a risk column.
 */

const CAPITAL = 100_000_000; // ₹10,00,000.00
const ENTRY = 250_000; // ₹2,500.00

const setup = (over: Partial<StopSetup> = {}): StopSetup => ({
  side: "long",
  entryP: ENTRY,
  tickP: 5,
  lotSize: 1,
  ...over,
});

const settings = (over: Partial<StopSettings> = {}): StopSettings => ({
  riskPpm: 20_000, // 2%
  capitalP: CAPITAL,
  deployCapPpm: null,
  ...over,
});

describe("the risk-not-set gate", () => {
  it("returns risk-not-set when no risk percentage is configured", () => {
    expect(computeStop(setup({ manualStopP: 240_000 }), settings({ riskPpm: null }))).toEqual({ kind: "risk-not-set" });
  });

  it("returns risk-not-set when capital is unconfigured — it never defaults a percentage", () => {
    expect(computeStop(setup({ manualStopP: 240_000 }), settings({ capitalP: null }))).toEqual({ kind: "risk-not-set" });
    expect(computeStop(setup({ manualStopP: 240_000 }), settings({ capitalP: 0 }))).toEqual({ kind: "risk-not-set" });
  });

  it("is checked BEFORE any stop is derived, so no half-computed level escapes", () => {
    const r = computeStop(setup({ atrP3: 2_000_000 }), settings({ riskPpm: null, atrMultPermille: 2000 }));
    expect(r.kind).toBe("risk-not-set");
  });
});

describe("the decision tree — each branch names its source", () => {
  it("manual wins outright", () => {
    const r = computeStop(setup({ manualStopP: 240_000, structureStopP: 230_000, atrP3: 2_000_000 }), settings({ atrMultPermille: 2000 }));
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.source).toBe("manual");
    expect(r.kind === "ok" && r.stopP).toBe(240_000);
  });

  it("structure is next", () => {
    const r = computeStop(setup({ structureStopP: 230_000, atrP3: 2_000_000 }), settings({ atrMultPermille: 2000 }));
    expect(r.kind === "ok" && r.source).toBe("structure");
    expect(r.kind === "ok" && r.stopP).toBe(230_000);
  });

  it("ATR is third: entry − floor(atrP3 × mult / 1e6)", () => {
    // ATR 2_000 paise (atrP3 2_000_000) × 2.0 = 4_000 paise below entry.
    const r = computeStop(setup({ atrP3: 2_000_000 }), settings({ atrMultPermille: 2000 }));
    expect(r.kind === "ok" && r.source).toBe("atr");
    expect(r.kind === "ok" && r.stopP).toBe(246_000);
  });

  it("percent is last, and only fires when the user configured it", () => {
    const r = computeStop(setup(), settings({ defaultPctPpm: 40_000 })); // 4%
    expect(r.kind === "ok" && r.source).toBe("percent");
    expect(r.kind === "ok" && r.stopP).toBe(240_000);
    // Shipped unset ⇒ no stop at all rather than a house default.
    expect(computeStop(setup(), settings()).kind).toBe("no-stop");
  });

  it("an explicit stop_method is tried first, then the tree falls through", () => {
    const r = computeStop(setup({ manualStopP: 240_000, atrP3: 2_000_000 }), settings({ stopMethod: "atr", atrMultPermille: 2000 }));
    expect(r.kind === "ok" && r.source).toBe("atr");
    // With the forced branch's input missing, it falls through instead of dead-ending.
    const fallen = computeStop(setup({ manualStopP: 240_000 }), settings({ stopMethod: "atr", atrMultPermille: 2000 }));
    expect(fallen.kind === "ok" && fallen.source).toBe("manual");
  });

  it("shorts derive the stop ABOVE entry", () => {
    const r = computeStop(setup({ side: "short", atrP3: 2_000_000 }), settings({ atrMultPermille: 2000 }));
    expect(r.kind === "ok" && r.stopP).toBe(254_000);
  });
});

describe("(b) tick rounding moves the stop AWAY from entry, in both directions", () => {
  it("rounds a long's stop DOWN to the tick — wider, never tighter", () => {
    expect(roundStopToTick(240_003, ENTRY, 5)).toBe(240_000);
    const r = computeStop(setup({ manualStopP: 240_003 }), settings());
    expect(r.kind === "ok" && r.stopP).toBe(240_000);
    expect(r.kind === "ok" && r.flags).toContain("tick-rounded");
  });

  it("rounds a short's stop UP to the tick — also wider", () => {
    expect(roundStopToTick(260_002, ENTRY, 5)).toBe(260_005);
    const r = computeStop(setup({ side: "short", manualStopP: 260_002 }), settings());
    expect(r.kind === "ok" && r.stopP).toBe(260_005);
  });

  it("leaves an on-tick stop alone and does not flag it", () => {
    const r = computeStop(setup({ manualStopP: 240_000 }), settings());
    expect(r.kind === "ok" && r.flags).not.toContain("tick-rounded");
  });

  it("a non-positive tick disables rounding rather than dividing by zero", () => {
    expect(roundStopToTick(240_003, ENTRY, 0)).toBe(240_003);
  });
});

describe("(a) typed errors, never Infinity or NaN", () => {
  it("entry === stop is an error, not a division by zero", () => {
    const r = computeStop(setup({ manualStopP: ENTRY }), settings());
    expect(r).toEqual({ kind: "error", code: "stop-at-entry", source: "manual" });
  });

  it("a long with a stop ABOVE entry is an error", () => {
    const r = computeStop(setup({ manualStopP: 260_000 }), settings());
    expect(r).toEqual({ kind: "error", code: "stop-wrong-side", source: "manual" });
  });

  it("a short with a stop BELOW entry is an error", () => {
    const r = computeStop(setup({ side: "short", manualStopP: 240_000 }), settings());
    expect(r).toEqual({ kind: "error", code: "stop-wrong-side", source: "manual" });
  });

  it("no branch can produce a qty that is Infinity or NaN", () => {
    for (const stopP of [ENTRY, ENTRY + 1, ENTRY - 1]) {
      const r = computeStop(setup({ manualStopP: stopP }), settings());
      if (r.kind === "ok") {
        expect(Number.isFinite(r.qty)).toBe(true);
        expect(Number.isInteger(r.qty)).toBe(true);
      }
    }
  });

  it("a non-positive entry is an error rather than a negative size", () => {
    const r = computeStop(setup({ entryP: 0, manualStopP: -100 }), settings());
    expect(r.kind === "error" && r.code).toBe("entry-not-positive");
  });
});

describe("(c)–(f) the quantity chain", () => {
  it("(c) qty = floor(riskBudget / riskPerShare) and NEVER over-risks the budget", () => {
    // Budget 2% of ₹10,00,000 = ₹20,000 = 2_000_000 paise; risk/share 10_000.
    const r = computeStop(setup({ manualStopP: 240_000 }), settings());
    expect(r.kind === "ok" && r.riskBudgetP).toBe(2_000_000);
    expect(r.kind === "ok" && r.qty).toBe(200);
    expect(r.kind === "ok" && r.riskAtStopP).toBeLessThanOrEqual(2_000_000);
  });

  it("qty × riskPerShare ≤ riskBudget holds even when it does not divide evenly", () => {
    const r = computeStop(setup({ manualStopP: 243_003 }), settings());
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.qty * r.riskPerShareP).toBeLessThanOrEqual(r.riskBudgetP);
  });

  it("(d) the deploy cap clips and records clippedBy", () => {
    // 25% of ₹10,00,000 = ₹2,50,000 → 100 shares at ₹2,500, below the 200 the
    // risk budget would allow.
    const r = computeStop(setup({ manualStopP: 240_000 }), settings({ deployCapPpm: 250_000 }));
    expect(r.kind === "ok" && r.qty).toBe(100);
    expect(r.kind === "ok" && r.clippedBy).toBe("deployCap");
  });

  it("the deploy cap only ever REDUCES — it is a clip, not a sizing method", () => {
    const uncapped = computeStop(setup({ manualStopP: 240_000 }), settings());
    const capped = computeStop(setup({ manualStopP: 240_000 }), settings({ deployCapPpm: 900_000 }));
    expect(capped.kind === "ok" && uncapped.kind === "ok" && capped.qty).toBeLessThanOrEqual(uncapped.kind === "ok" ? uncapped.qty : 0);
    expect(capped.kind === "ok" && capped.clippedBy).toBeNull();
  });

  it("(e) lot rounding FLOORS: lotSize 65 with a raw 129 gives 65, never 130", () => {
    // riskPerShare 15_504 paise → floor(2_000_000 / 15_504) = 129 raw.
    const r = computeStop(setup({ manualStopP: ENTRY - 15_504, tickP: 0, lotSize: 65 }), settings());
    expect(r.kind === "ok" && r.qty).toBe(65);
    expect(r.kind === "ok" && r.clippedBy).toBe("lotSize");
  });

  it("(f) a stop wider than the whole budget returns kind 'zero', not an error", () => {
    // Budget 0.01% of ₹10,00,000 = ₹100; risk per share is ₹2,400.
    const r = computeStop(setup({ manualStopP: 10_000 }), settings({ riskPpm: 100 }));
    expect(r.kind).toBe("zero");
    expect(r.kind === "zero" && r.source).toBe("manual");
    expect(r.kind === "zero" && r.riskPerShareP).toBe(240_000);
  });
});

describe("(g)–(h) flags", () => {
  it("(g) flags a stop wider than N ATRs", () => {
    // ATR 2_000 paise; a 10_000-paise stop is 5 N, over a 3 N threshold.
    const r = computeStop(setup({ manualStopP: 240_000, atrP3: 2_000_000 }), settings({ nStopMultPermille: 3000 }));
    expect(r.kind === "ok" && r.flags).toContain("wider-than-n-stop");
    const inside = computeStop(setup({ manualStopP: 245_000, atrP3: 2_000_000 }), settings({ nStopMultPermille: 3000 }));
    expect(inside.kind === "ok" && inside.flags).not.toContain("wider-than-n-stop");
  });

  it("(g) is silent with no ATR or no threshold, rather than flagging on a guess", () => {
    const r = computeStop(setup({ manualStopP: 240_000 }), settings({ nStopMultPermille: 3000 }));
    expect(r.kind === "ok" && r.flags).toEqual([]);
  });

  it("(h) flags a stop outside today's circuit band", () => {
    const r = computeStop(setup({ manualStopP: 240_000 }), settings(), { circuitLowP: 245_000, circuitHighP: 255_000 });
    expect(r.kind === "ok" && r.flags).toContain("outside-circuit-band");
    const inside = computeStop(setup({ manualStopP: 246_000 }), settings(), { circuitLowP: 245_000, circuitHighP: 255_000 });
    expect(inside.kind === "ok" && inside.flags).not.toContain("outside-circuit-band");
  });
});
