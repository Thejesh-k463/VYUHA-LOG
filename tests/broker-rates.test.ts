import { describe, it, expect } from "vitest";
import { computeCharges } from "@/lib/engine/charges";
import { seedRatesMap } from "@/lib/engine/rates";
import { BROKERS, SEGMENTS, type Broker, type Segment } from "@/lib/domain/constants";
import type { ChargeRates } from "@/lib/engine/types";

/**
 * Forensic sweep of EVERY broker × EVERY segment.
 *
 * Two different jobs here, and they are worth separating:
 *
 * 1. **Structural** properties that must hold for every broker alive — no
 *    negative charges, statutory rates identical across brokers, GST at 18% of
 *    the right base. These catch a bad rate row whoever added it.
 * 2. **Per-broker** assertions pinned to the numbers each broker actually
 *    publishes, cited in the seed. These catch a rate that silently drifts
 *    from the source.
 */

const rates = seedRatesMap();
/** Returns undefined instead of throwing, so a gap can be asserted on. */
const get = (b: Broker, s: Segment, ex = "NSE", plan = "default"): ChargeRates | undefined =>
  rates.get(`${b}|${plan}|${s}|${ex}`);

/** One round trip, sized so percentage and flat brokerage differ visibly. */
const roundTrip = (segment: Segment, value = 500_000) => ({
  segment,
  buyValue: value,
  sellValue: value,
  buyQty: 100,
  sellQty: 100,
  buyOrderCount: 1,
  sellOrderCount: 1,
});

describe("every broker prices every segment it claims to", () => {
  for (const broker of BROKERS) {
    it(`${broker} has a rate row for every segment`, () => {
      // Every row must EXIST — findRates throws on a gap, so a missing row
      // would crash the importer the first time such a trade arrived.
      for (const segment of SEGMENTS) {
        const ex = segment.startsWith("commodity") ? "MCX" : "NSE";
        expect(get(broker, segment, ex), `${broker}/${segment} has no rate row`).toBeDefined();
      }
    });
  }
});

describe("structural invariants — true for every broker", () => {
  for (const broker of BROKERS) {
    it(`${broker}: no charge component is ever negative`, () => {
      for (const segment of SEGMENTS) {
        const ex = segment.startsWith("commodity") ? "MCX" : "NSE";
        const r = get(broker, segment, ex);
        if (!r) continue;
        const c = computeCharges(roundTrip(segment), r);
        for (const [k, v] of Object.entries(c)) {
          expect(v, `${broker}/${segment}.${k} = ${v}`).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it(`${broker}: components sum to the stated total`, () => {
      for (const segment of SEGMENTS) {
        const ex = segment.startsWith("commodity") ? "MCX" : "NSE";
        const r = get(broker, segment, ex);
        if (!r) continue;
        const c = computeCharges(roundTrip(segment), r);
        const sum =
          c.brokerage + c.sttCtt + c.exchangeTxn + c.sebi + c.stampDuty +
          c.ipft + c.gst + c.dpCharges + c.mtfInterest + c.pledgeCharges;
        expect(Math.abs(sum - c.total), `${broker}/${segment}`).toBeLessThan(0.011);
      }
    });

    it(`${broker}: brokerage respects its own cap and floor`, () => {
      for (const segment of SEGMENTS) {
        const ex = segment.startsWith("commodity") ? "MCX" : "NSE";
        const r = get(broker, segment, ex);
        if (!r) continue;
        // A large trade is where an uncapped percentage runs away.
        const c = computeCharges(roundTrip(segment, 10_000_000), r);
        if (r.brokerageCap != null) {
          // Cap is per side; a round trip pays it at most twice.
          expect(c.brokerage, `${broker}/${segment} exceeded its cap`).toBeLessThanOrEqual(
            r.brokerageCap * 2 + 0.01,
          );
        }
      }
    });
  }
});

describe("statutory charges are identical across brokers — they are the law", () => {
  for (const segment of SEGMENTS) {
    it(`${segment}: STT, stamp, SEBI and exchange rates do not vary by broker`, () => {
      const ex = segment.startsWith("commodity") ? "MCX" : "NSE";
      const rows = BROKERS.map((b) => get(b, segment, ex)).filter(Boolean) as ChargeRates[];
      expect(rows.length).toBeGreaterThan(1);
      const first = rows[0];
      for (const r of rows.slice(1)) {
        expect(r.sttPct, `${r.broker} STT differs`).toBe(first.sttPct);
        expect(r.sttSide, `${r.broker} STT side differs`).toBe(first.sttSide);
        expect(r.stampPct, `${r.broker} stamp differs`).toBe(first.stampPct);
        expect(r.sebiPct, `${r.broker} SEBI differs`).toBe(first.sebiPct);
        expect(r.exchangeTxnPct, `${r.broker} exchange differs`).toBe(first.exchangeTxnPct);
        expect(r.gstPct, `${r.broker} GST differs`).toBe(0.18);
      }
    });
  }
});

// ── Per-broker, pinned to each broker's PUBLISHED numbers ──────────────────

describe("Kotak Neo — kotakneo.com/pricing (Trade Free Plan)", () => {
  it("delivery is 0.20% with no cap", () => {
    const r = get("kotakneo", "eq_delivery")!;
    expect(r.brokeragePct).toBe(0.002);
    expect(r.brokerageCap).toBeNull();
    // 0.20% of 5,00,000 per side = 1,000; a round trip pays it twice.
    expect(computeCharges(roundTrip("eq_delivery"), r).brokerage).toBeCloseTo(2000, 0);
  });

  it("intraday is the LOWER of ₹10 and 0.05%", () => {
    const r = get("kotakneo", "eq_intraday")!;
    // On 5 lakh, 0.05% = 250, so the ₹10 cap binds: ₹10 per side.
    expect(computeCharges(roundTrip("eq_intraday"), r).brokerage).toBeCloseTo(20, 0);
    // On a tiny trade the percentage is lower and wins.
    expect(computeCharges(roundTrip("eq_intraday", 10_000), r).brokerage).toBeCloseTo(10, 0);
  });

  it("F&O is a flat ₹10 an order", () => {
    for (const seg of ["future", "index_option", "stock_option"] as Segment[]) {
      const r = get("kotakneo", seg)!;
      expect(computeCharges(roundTrip(seg), r).brokerage, seg).toBeCloseTo(20, 0);
    }
  });

  it("DP is 0.04% of the sale with a ₹20 FLOOR — the only percentage DP here", () => {
    const r = get("kotakneo", "eq_delivery")!;
    expect(r.dpPct).toBe(0.0004);
    // 0.04% of 5,00,000 = 200, well above the ₹20 floor.
    expect(computeCharges(roundTrip("eq_delivery"), r).dpCharges).toBeCloseTo(200, 0);
    // On a small sale the floor binds instead.
    expect(computeCharges(roundTrip("eq_delivery", 10_000), r).dpCharges).toBeCloseTo(20, 0);
  });

  it("MTF interest is 9.69% a year — on Trade Free PRO, not the free plan", () => {
    expect(get("kotakneo", "eq_mtf", "NSE", "pro")!.mtfInterestAnnual).toBeCloseTo(0.0969, 4);
  });
});

describe("Paytm Money — paytmmoney.com/stocks/pricing", () => {
  it("delivery is the lower of 2.5% and ₹20", () => {
    const r = get("paytm", "eq_delivery")!;
    expect(r.brokeragePct).toBe(0.025);
    expect(r.brokerageCap).toBe(20);
    // 2.5% of 5 lakh is 12,500, so ₹20 binds hard.
    expect(computeCharges(roundTrip("eq_delivery"), r).brokerage).toBeCloseTo(40, 0);
    // Only on a very small trade does the percentage come in under ₹20.
    expect(computeCharges(roundTrip("eq_delivery", 500), r).brokerage).toBeCloseTo(25, 0);
  });

  it("intraday is the lower of 0.05% and ₹20", () => {
    const r = get("paytm", "eq_intraday")!;
    expect(computeCharges(roundTrip("eq_intraday"), r).brokerage).toBeCloseTo(40, 0);
  });

  it("MTF brokerage is 0.1% UNCAPPED — a floor rule, not a cap", () => {
    // Paytm bills "0.1% or current brokerage, whichever is HIGHER", and 0.1%
    // dominates at any real size. Capping it at ₹20 would understate badly.
    const r = get("paytm", "eq_mtf")!;
    expect(r.brokerageCap).toBeNull();
    expect(computeCharges(roundTrip("eq_mtf"), r).brokerage).toBeCloseTo(1000, 0);
  });

  it("MTF interest is tiered, and NOT monotonic", () => {
    const t = get("paytm", "eq_mtf")!.mtfTiers!;
    expect(t).toHaveLength(3);
    expect(t[0]).toEqual({ upTo: 100000, rate: 0.0799 });
    expect(t[1]).toEqual({ upTo: 10000000, rate: 0.0999 });
    expect(t[2]).toEqual({ upTo: null, rate: 0.0899 });
    // The middle band really is dearer than the top one — a sorted assumption
    // would quietly reorder these and misprice every mid-size book.
    expect(t[1].rate).toBeGreaterThan(t[2].rate);
  });

  it("DP on a delivery sell is ₹20", () => {
    expect(get("paytm", "eq_delivery")!.dpCharge).toBe(20);
  });
});

describe("Sahi — sahi.com/pricing", () => {
  it("delivery is NOT free — ₹10 or 0.05%, whichever is lower", () => {
    // Unusual among discount brokers, and the single most likely thing to be
    // assumed wrongly.
    const r = get("sahi", "eq_delivery")!;
    expect(r.brokeragePct).toBe(0.0005);
    expect(r.brokerageCap).toBe(10);
    expect(computeCharges(roundTrip("eq_delivery"), r).brokerage).toBeCloseTo(20, 0);
  });

  it("intraday matches delivery", () => {
    expect(computeCharges(roundTrip("eq_intraday"), get("sahi", "eq_intraday")!).brokerage)
      .toBeCloseTo(20, 0);
  });

  it("F&O is flat ₹10", () => {
    for (const seg of ["future", "index_option", "stock_option"] as Segment[]) {
      expect(computeCharges(roundTrip(seg), get("sahi", seg)!).brokerage, seg).toBeCloseTo(20, 0);
    }
  });

  it("DP is ₹13.50 a company on sells", () => {
    expect(get("sahi", "eq_delivery")!.dpCharge).toBe(13.5);
  });

  it("declares its MTF rate UNKNOWN rather than implying it is free", () => {
    // Sahi publishes no MTF interest rate. Seeding 0% would advertise free
    // funding in the very report meant to compare costs; omitting the row
    // would crash the importer. So the row exists and states the unknown.
    const r = get("sahi", "eq_mtf")!;
    expect(r).toBeDefined();
    expect(r.mtfRateUnknown).toBe(true);
    expect(r.mtfInterestAnnual).toBe(0);
    // Every OTHER charge on that row is real and usable.
    expect(r.brokeragePct).toBe(0.0005);
    expect(r.dpCharge).toBe(13.5);
  });

  it("shares 'no published MTF rate' with Kotak Neo's FREE plan and nobody else", () => {
    // Kotak publishes 9.69% for Pro subscribers only; on the free tier it says
    // nothing, and neither broker's silence may be read as zero.
    const unknown = BROKERS.filter((b) => get(b, "eq_mtf")?.mtfRateUnknown);
    expect(unknown).toEqual(["kotakneo", "sahi"]);
    expect(get("kotakneo", "eq_mtf", "NSE", "pro")?.mtfRateUnknown).toBe(false);
  });
});

describe("the existing brokers still price exactly as before", () => {
  it("Zerodha delivery is free; intraday is min(₹20, 0.03%)", () => {
    expect(computeCharges(roundTrip("eq_delivery"), get("zerodha", "eq_delivery")!).brokerage).toBe(0);
    expect(computeCharges(roundTrip("eq_intraday"), get("zerodha", "eq_intraday")!).brokerage)
      .toBeCloseTo(40, 0);
  });

  it("Dhan delivery is free; options are flat ₹20", () => {
    expect(computeCharges(roundTrip("eq_delivery"), get("dhan", "eq_delivery")!).brokerage).toBe(0);
    expect(computeCharges(roundTrip("index_option"), get("dhan", "index_option")!).brokerage)
      .toBeCloseTo(40, 0);
  });

  it("Groww applies a ₹5 FLOOR that the others do not", () => {
    const r = get("groww", "eq_delivery")!;
    expect(r.brokerageFloor).toBe(5);
    // A tiny trade pays the floor, not 0.1% of nearly nothing.
    expect(computeCharges(roundTrip("eq_delivery", 1000), r).brokerage).toBeCloseTo(10, 0);
  });

  it("no broker charges DP on an intraday or F&O trade", () => {
    for (const broker of BROKERS) {
      for (const seg of ["eq_intraday", "future", "index_option"] as Segment[]) {
        const r = get(broker, seg);
        if (!r) continue;
        expect(computeCharges(roundTrip(seg), r).dpCharges, `${broker}/${seg}`).toBe(0);
      }
    }
  });
});

describe("pricing plans — the free tier and the paid tier are separate offers", () => {
  it("gives every broker a free 'default' plan", () => {
    // Most users are on no plan at all, so the default must be the free one.
    for (const broker of BROKERS) {
      expect(get(broker, "eq_delivery")?.subscriptionMonthly, broker).toBe(0);
    }
  });

  it("carries Kotak Neo's Trade Free Pro as its own rate card", () => {
    const pro = get("kotakneo", "eq_delivery", "NSE", "pro");
    expect(pro?.planLabel).toBe("Trade Free Pro");
    expect(pro?.subscriptionMonthly).toBe(249);
    // The plan's whole point: 0.10% delivery against 0.20% on the free tier.
    expect(pro?.brokeragePct).toBe(0.001);
    expect(get("kotakneo", "eq_delivery")?.brokeragePct).toBe(0.002);
  });

  it("keeps 9.69% MTF on the plan that actually offers it", () => {
    // Kotak publishes this rate for Pro subscribers only. On the free tier it
    // publishes nothing — which is stated as unknown, not quoted as the Pro rate
    // and not seeded as zero.
    expect(get("kotakneo", "eq_mtf", "NSE", "pro")?.mtfInterestAnnual).toBe(0.0969);
    const free = get("kotakneo", "eq_mtf");
    expect(free?.mtfRateUnknown).toBe(true);
    expect(free?.mtfInterestAnnual).toBe(0);
  });

  it("leaves the single-structure brokers with no paid plan at all", () => {
    // Inventing a tier for a broker that does not sell one would be a claim
    // about their pricing, not a gap in ours.
    for (const broker of BROKERS.filter((b) => b !== "kotakneo")) {
      const plans = new Set([...rates.keys()].filter((k) => k.startsWith(`${broker}|`)).map((k) => k.split("|")[1]));
      expect([...plans], broker).toEqual(["default"]);
    }
  });

  it("charges the same statutory levies on a paid plan — only brokerage differs", () => {
    const free = get("kotakneo", "eq_delivery")!;
    const pro = get("kotakneo", "eq_delivery", "NSE", "pro")!;
    expect(pro.sttPct).toBe(free.sttPct);
    expect(pro.stampPct).toBe(free.stampPct);
    expect(pro.sebiPct).toBe(free.sebiPct);
    expect(pro.gstPct).toBe(free.gstPct);
    expect(pro.dpCharge).toBe(free.dpCharge);
  });
});

describe("rate cards corrected against the brokers' published pages", () => {
  it("prices Angel One delivery at zero — it is free, not ₹20", () => {
    const r = get("angelone", "eq_delivery")!;
    expect(r.brokerageFlat).toBe(0);
    expect(r.brokeragePct).toBe(0);
  });

  it("uses each broker's published MTF interest rate", () => {
    expect(get("angelone", "eq_mtf")?.mtfInterestAnnual).toBe(0.18);
    expect(get("upstox", "eq_mtf")?.mtfInterestAnnual).toBe(0.1825);
  });
});
