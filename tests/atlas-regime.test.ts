import { describe, expect, it } from "vitest";
import { classifyRegime, DEFAULT_REGIME_THRESHOLDS, formulaLine } from "@/lib/atlas/regime";

const sma = (value_ppm: number | null, denominator = 100) => ({ value_ppm, denominator });
const net = (value: number | null, denominator = 100) => ({ value, denominator });

describe("regime — three states over PRINTED thresholds", () => {
  it("Expansion needs both conditions", () => {
    expect(classifyRegime({ aboveSma50: sma(600_000), netHighLow: net(25) }).regime).toBe("expansion");
    expect(classifyRegime({ aboveSma50: sma(600_000), netHighLow: net(0) }).regime).toBe("neutral");
    expect(classifyRegime({ aboveSma50: sma(500_000), netHighLow: net(25) }).regime).toBe("neutral");
  });

  it("the Expansion boundary is inclusive at 55% and exclusive at netHL 0", () => {
    expect(classifyRegime({ aboveSma50: sma(550_000), netHighLow: net(1) }).regime).toBe("expansion");
    expect(classifyRegime({ aboveSma50: sma(549_999), netHighLow: net(1) }).regime).toBe("neutral");
  });

  it("Contraction fires on EITHER condition, inclusive at 40% and exclusive at -50", () => {
    expect(classifyRegime({ aboveSma50: sma(400_000), netHighLow: net(500) }).regime).toBe("contraction");
    expect(classifyRegime({ aboveSma50: sma(400_001), netHighLow: net(500) }).regime).toBe("neutral");
    expect(classifyRegime({ aboveSma50: sma(900_000), netHighLow: net(-51) }).regime).toBe("contraction");
    expect(classifyRegime({ aboveSma50: sma(900_000), netHighLow: net(-50) }).regime).toBe("neutral");
  });

  it("is unknown — never a guess — when an input is null", () => {
    const noSma = classifyRegime({ aboveSma50: sma(null), netHighLow: net(25) });
    expect(noSma.regime).toBe("unknown");
    expect(noSma.reason).toBe("missing_sma50");
    const noNet = classifyRegime({ aboveSma50: sma(600_000), netHighLow: net(null) });
    expect(noNet.regime).toBe("unknown");
    expect(noNet.reason).toBe("missing_net_high_low");
    expect(classifyRegime({ aboveSma50: null, netHighLow: null }).regime).toBe("unknown");
  });

  it("still decides Contraction from the one input that IS present", () => {
    expect(classifyRegime({ aboveSma50: sma(300_000), netHighLow: net(null) }).regime).toBe("contraction");
    expect(classifyRegime({ aboveSma50: null, netHighLow: net(-500) }).regime).toBe("contraction");
  });

  it("takes its thresholds as an input, so they are never a private rule", () => {
    const strict = { ...DEFAULT_REGIME_THRESHOLDS, expansionAboveSma50Ppm: 800_000 };
    const input = { aboveSma50: sma(600_000), netHighLow: net(25) };
    expect(classifyRegime(input).regime).toBe("expansion");
    expect(classifyRegime(input, strict).regime).toBe("neutral");
    expect(classifyRegime(input, strict).thresholds).toEqual(strict);
  });

  it("v4.6.0 W5 (AQ44 / A9): an input under the coverage floor cannot vote — unknown / coverage_below_floor", () => {
    const thin = { value_ppm: 600_000, denominator: 40, coverage_ppm: 21_053 }; // 40 of 1,900 priced
    const wide = { value: 25, denominator: 1_800, coverage_ppm: 947_368 };
    const r = classifyRegime({ aboveSma50: thin, netHighLow: wide });
    expect(r.regime).toBe("unknown");
    expect(r.reason).toBe("coverage_below_floor");
    expect(r.coverageFloorPpm).toBe(300_000);
    expect(r.belowFloor).toEqual([{ input: "aboveSma50", coverage_ppm: 21_053 }]);
    // The inputs are still printed, so the screen can say what it refused to read.
    expect(r.inputs).toEqual({ aboveSma50Ppm: 600_000, netHighLow: 25 });
    // At the floor exactly, it votes.
    expect(classifyRegime({ aboveSma50: { ...thin, coverage_ppm: 300_000 }, netHighLow: wide }).regime).toBe("expansion");
    // The floor is a parameter, defaulted to COVERAGE_FLOOR_PPM and carried on every result.
    expect(classifyRegime({ aboveSma50: sma(600_000), netHighLow: net(25) }).coverageFloorPpm).toBe(300_000);
    expect(classifyRegime({ aboveSma50: { ...thin, coverage_ppm: 500_000 }, netHighLow: wide }, DEFAULT_REGIME_THRESHOLDS, 600_000).reason).toBe("coverage_below_floor");
  });

  it("prints the rule with the numbers substituted", () => {
    const r = classifyRegime({ aboveSma50: sma(612_345), netHighLow: net(25) });
    expect(r.formula).toContain("Expansion when above-SMA50 >= 55.0%");
    expect(r.formula).toContain("net high-low < -50");
    expect(r.formula).toContain("Yours: above-SMA50 61.2%, net high-low 25.");
    expect(r.inputs).toEqual({ aboveSma50Ppm: 612_345, netHighLow: 25 });
    expect(formulaLine({ aboveSma50Ppm: null, netHighLow: null })).toContain("Yours: above-SMA50 n/a");
  });
});
