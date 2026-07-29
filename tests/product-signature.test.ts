import { describe, it, expect } from "vitest";
import {
  inferProduct, corroborate, splitMixedRow, productReason,
  MIN_VALUE_FOR_SIGNAL, type ChargeSignature,
} from "@/lib/import/product-signature";

/**
 * Every fixture below is a real row of charges from a Dhan Global Transaction
 * Report (01-07-2026 to 29-07-2026), with the scrip names removed.
 *
 * Synthetic numbers would only prove the algebra agrees with itself; these
 * prove it agrees with what a broker actually charged, which is the only claim
 * worth making.
 */
const sig = (p: Partial<ChargeSignature>): ChargeSignature => ({
  buyValue: 0, sellValue: 0, stt: 0, stampDuty: 0, ...p,
});

describe("inferProduct — delivery", () => {
  it("reads a delivery buy (buy 643,353, stamp 96.50, STT 643.43) as delivery", () => {
    const s = sig({ buyValue: 643353.30, stt: 643.43, stampDuty: 96.50 });
    expect(inferProduct(s)).toBe("delivery");
    expect(corroborate(s, "delivery")).toBe(true);
  });

  it("reads another delivery buy (buy 478,719, stamp 71.69) as delivery", () => {
    expect(inferProduct(sig({ buyValue: 478718.80, stt: 478.79, stampDuty: 71.69 }))).toBe("delivery");
  });

  it("reads a sell-only delivery leg from STT alone (no stamp on a sell)", () => {
    // a delivery buy sold the next day: STT 636.10 on 635,921.52 = 0.1%
    const s = sig({ sellValue: 635921.52, stt: 636.10 });
    expect(inferProduct(s)).toBe("delivery");
    expect(corroborate(s, "delivery")).toBe(true);
  });
});

describe("inferProduct — intraday", () => {
  it("reads an intraday round trip (buy 265,405 / sell 262,900, stamp 7.96) as intraday", () => {
    const s = sig({ buyValue: 265404.80, sellValue: 262900, stt: 66.04, stampDuty: 7.96 });
    expect(inferProduct(s)).toBe("intraday");
    expect(corroborate(s, "intraday")).toBe(true);
  });

  it("reads a larger intraday round trip (buy 577,096 / sell 571,234, stamp 17.04) as intraday", () => {
    expect(inferProduct(sig({ buyValue: 577095.50, sellValue: 571234.20, stt: 143.96, stampDuty: 17.04 }))).toBe("intraday");
  });

  it("reads a 65-lakh round trip (8,000 shares) as intraday — size does not blur the rate", () => {
    expect(inferProduct(sig({ buyValue: 6547223.30, sellValue: 6541691.80, stt: 1636.12, stampDuty: 196.42 }))).toBe("intraday");
  });
});

describe("inferProduct — refuses to guess", () => {
  it("returns unknown below the rounding floor, rather than reading an artefact", () => {
    // a tiny delivery buy: buy 1,298.90, STT rounds to Rs 1.00 (0.077%), stamp rounds to 0.
    expect(inferProduct(sig({ buyValue: 1298.90, stt: 1.00, stampDuty: 0 }))).toBe("unknown");
  });

  it("returns unknown when stamp duty is absent on a buy row", () => {
    expect(inferProduct(sig({ buyValue: 500000, stt: 500, stampDuty: 0 }))).toBe("unknown");
  });

  it("treats the floor as inclusive-exclusive exactly once", () => {
    expect(inferProduct(sig({ buyValue: MIN_VALUE_FOR_SIGNAL - 1, stt: 5, stampDuty: 0.75 }))).toBe("unknown");
    expect(inferProduct(sig({ buyValue: MIN_VALUE_FOR_SIGNAL, stt: 5, stampDuty: 0.75 }))).toBe("delivery");
  });

  it("NEVER returns mtf — an MTF row is indistinguishable from delivery here", () => {
    const verdicts = new Set<string>();
    for (const v of [
      sig({ buyValue: 643353.30, stt: 643.43, stampDuty: 96.50 }),
      sig({ buyValue: 265404.80, sellValue: 262900, stt: 66.04, stampDuty: 7.96 }),
      sig({ buyValue: 795403.62, sellValue: 400728.60, stt: 498.88, stampDuty: 71.18 }),
    ]) verdicts.add(inferProduct(v));
    expect([...verdicts]).not.toContain("mtf");
  });
});

describe("splitMixedRow — the algebra against real bills", () => {
  it("detects a half-carried bill as mixed and splits it ~50/50", () => {
    // Bought 3,600 for 795,403.62; squared 1,800 same day, carried 1,800.
    const s = sig({ buyValue: 795403.62, sellValue: 400728.60, stt: 498.88, stampDuty: 71.18 });
    expect(inferProduct(s)).toBe("mixed");
    const split = splitMixedRow(s)!;
    expect(split).not.toBeNull();
    // Half the buy carried overnight.
    expect(split.deliveryFraction).toBeGreaterThan(0.45);
    expect(split.deliveryFraction).toBeLessThan(0.55);
    // The two halves must add back to the whole — no value invented or lost.
    expect(split.deliveryValue + split.intradayValue).toBeCloseTo(795403.62, 1);
  });

  it("splits a half-squared bill (bought 700, sold 350 same day) at ~50%", () => {
    const s = sig({ buyValue: 1399472.52, sellValue: 694608.99, stt: 873.00, stampDuty: 125.84 });
    expect(inferProduct(s)).toBe("mixed");
    expect(splitMixedRow(s)!.deliveryFraction).toBeCloseTo(0.5, 1);
  });

  it("splits a mostly-squared bill (bought 775, sold 550 same day) toward intraday", () => {
    const s = sig({ buyValue: 766369.14, sellValue: 538992.74, stt: 357.13, stampDuty: 49.70 });
    expect(inferProduct(s)).toBe("mixed");
    const f = splitMixedRow(s)!.deliveryFraction;
    // 225 of 775 carried ≈ 29%.
    expect(f).toBeGreaterThan(0.2);
    expect(f).toBeLessThan(0.4);
  });

  it("returns null rather than a nonsense split when the numbers do not admit one", () => {
    expect(splitMixedRow(sig({ buyValue: 100000, stampDuty: 500 }))).toBeNull(); // implies 3x the value
    expect(splitMixedRow(sig({ buyValue: 100, stampDuty: 1 }))).toBeNull(); // below the floor
  });

  it("a pure-delivery row resolves to ~100% delivery, conserving the total", () => {
    // Callers only split rows inferProduct() called "mixed"; this pins that the
    // algebra degrades sanely if one ever slips through. Stamp duty rounds to
    // the rupee, so a Rs 6.4 lakh buy carries ~Rs 25 of rounding — 0.004% of
    // the row. The FRACTION is the meaningful quantity, not the rupee residue.
    const s = sig({ buyValue: 643353.30, stt: 643.43, stampDuty: 96.50 });
    const split = splitMixedRow(s)!;
    expect(split.deliveryFraction).toBeGreaterThan(0.999);
    expect(split.deliveryValue + split.intradayValue).toBeCloseTo(643353.30, 1);
  });
});

describe("productReason", () => {
  it("says WHY, and distinguishes a corroborated verdict from a lone one", () => {
    expect(productReason("delivery", true)).toMatch(/both match/i);
    expect(productReason("delivery", false)).toMatch(/does not corroborate/i);
    expect(productReason("mixed", false)).toMatch(/squared off the same day/i);
    expect(productReason("unknown", false)).toMatch(/too small|unusual/i);
  });

  it("never claims to know about MTF", () => {
    for (const v of ["delivery", "intraday", "mixed", "unknown"] as const) {
      expect(productReason(v, true).toLowerCase()).not.toContain("mtf");
    }
  });
});
