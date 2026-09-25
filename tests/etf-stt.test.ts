import { describe, expect, it } from "vitest";
import { findRates, ratesForTrade, seedRatesMap, type RatesMap } from "@/lib/engine/rates";
import type { ChargeRates } from "@/lib/engine/types";
import type { Broker, Exchange, Segment } from "@/lib/domain/constants";

/**
 * v4.5.0 wave 3a — THE ETF STT OVERLAY (ruling R90, design review revision 18,
 * wave3-tax-designs.md T1), over the canonical seed.
 *
 * Until this existed an ETF unit was charged the equity-SHARE delivery STT,
 * 0.1% on both sides, because it shares `eq_delivery` with an ordinary share.
 * The statute does not say that:
 *
 *  · s.98 Sl. 2A (inserted by the Finance Act 2013, in force 2013-06-01) —
 *    sale of a unit of an EQUITY-ORIENTED fund, settled by actual delivery:
 *    0.001%, SELLER. So NIFTYBEES sells at a hundredth of what it was charged
 *    and buys at nothing.
 *  · a NON-equity-oriented unit (gold, silver, debt, liquid, international,
 *    hybrid) appears in NO row of the s.98 table at all — hence `etf_other`
 *    carries 0 with side "none", never an invented rate.
 *  · INTRADAY is the deliberate asymmetry: the "settled otherwise than by
 *    actual delivery" row names an equity share AND an equity-oriented fund
 *    unit at ONE rate, so an equity-oriented ETF sold intraday is already
 *    priced right by its own product row and the overlay must NOT fire. A
 *    non-equity unit is in no row at all, so `etf_other` overlays intraday too.
 *
 * Invariant 3 is the thing to keep hold of here: the rates come from
 * `charge_config` rows (`etf_equity` / `etf_other`), never from a literal in
 * `ratesForTrade`. And the overlay takes sttPct/sttSide and NOTHING else —
 * brokerage, DP, stamp, exchange, SEBI, IPFT, the GST base and MTF interest all
 * stay the trade's own product row, or an ETF would be billed at zero
 * brokerage. The last case in this file asserts exactly that, key by key.
 *
 * It NEVER throws. An unlisted INF ISIN, an absent etf_* row, an empty bundled
 * list: all fall back silently to the equity-share rate the app charged before,
 * because a refusal here would abort a whole import over a classification.
 * Data Quality names the undetermined ones instead (tests/etf-data-quality).
 */

const map = seedRatesMap();
const EQ_SEGMENTS = ["eq_delivery", "eq_mtf", "eq_intraday"] as const;

/** The real entry point, with a day after the 2013 boundary unless one is given. */
const stt = (
  t: { segment: Segment; isin?: string | null; symbol?: string | null; broker?: Broker; exchange?: Exchange },
  on = "2026-09-01",
  plan = "default",
): { pct: number; side: string } => {
  const r = ratesForTrade(
    map,
    { broker: t.broker ?? "zerodha", segment: t.segment, exchange: t.exchange ?? "NSE", isin: t.isin, symbol: t.symbol },
    on,
    plan,
  );
  return { pct: r.sttPct, side: r.sttSide };
};

describe("the ETF STT overlay: what each unit is actually charged", () => {
  it("1 · GOLDBEES by SYMBOL ALONE (a tradebook that states no ISIN): delivery STT is 0, side none — not 0.1% both sides", () => {
    expect(stt({ segment: "eq_delivery", symbol: "GOLDBEES" })).toEqual({ pct: 0, side: "none" });
    // The equity-share row it used to be charged at, for contrast — still what an ordinary share pays.
    expect(stt({ segment: "eq_delivery", symbol: "RELIANCE" })).toEqual({ pct: 0.001, side: "both" });
  });

  it("2 · NIFTYBEES (INF204KB14I2) delivery AND MTF: 0.001% SELLER, from the s.98 Sl. 2A row — on both exchanges", () => {
    for (const exchange of ["NSE", "BSE"] as Exchange[]) {
      expect(stt({ segment: "eq_delivery", isin: "INF204KB14I2", exchange }), exchange).toEqual({ pct: 0.00001, side: "sell" });
      expect(stt({ segment: "eq_mtf", isin: "INF204KB14I2", exchange }), exchange).toEqual({ pct: 0.00001, side: "sell" });
    }
  });

  it("3 · the SAME unit on 2012-01-01 is 0.125% both sides: row 2A was an INSERTION, so nothing before 2013-06-01 moves", () => {
    expect(stt({ segment: "eq_delivery", isin: "INF204KB14I2" }, "2012-01-01")).toEqual({ pct: 0.00125, side: "both" });
    expect(stt({ segment: "eq_delivery", isin: "INF204KB14I2" }, "2012-07-01")).toEqual({ pct: 0.001, side: "both" });
    expect(stt({ segment: "eq_delivery", isin: "INF204KB14I2" }, "2013-05-31")).toEqual({ pct: 0.001, side: "both" });
    expect(stt({ segment: "eq_delivery", isin: "INF204KB14I2" }, "2013-06-01")).toEqual({ pct: 0.00001, side: "sell" });
  });

  it("4 · NIFTYBEES INTRADAY is 0.025% seller, UNCHANGED — the deliberate deviation: the s.98 'otherwise than by actual delivery' row names a share and an equity-oriented unit at ONE rate, and Sl. 2A is delivery-based only", () => {
    const equityShare = stt({ segment: "eq_intraday", symbol: "RELIANCE" });
    expect(equityShare).toEqual({ pct: 0.00025, side: "sell" });
    expect(stt({ segment: "eq_intraday", isin: "INF204KB14I2" })).toEqual(equityShare);
    expect(stt({ segment: "eq_intraday", symbol: "NIFTYBEES" })).toEqual(equityShare);
    // …and it is unchanged before the 2013 boundary too, because nothing about intraday moved.
    expect(stt({ segment: "eq_intraday", isin: "INF204KB14I2" }, "2012-01-01")).toEqual(equityShare);
  });

  it("5 · LIQUIDBEES (INF732E01037, a DEBT unit) is 0 / none in ALL THREE equity segments, intraday included", () => {
    for (const segment of EQ_SEGMENTS) {
      expect(stt({ segment, isin: "INF732E01037" }), segment).toEqual({ pct: 0, side: "none" });
      expect(stt({ segment, symbol: "LIQUIDBEES" }), segment).toEqual({ pct: 0, side: "none" });
      // Including long before 2013: a non-equity unit was never in the table.
      expect(stt({ segment, isin: "INF732E01037" }, "2005-04-01"), segment).toEqual({ pct: 0, side: "none" });
    }
  });

  it("6 · an INF ISIN the list does not carry keeps the equity-share rate and does NOT throw (Data Quality names it instead)", () => {
    expect(() => stt({ segment: "eq_delivery", isin: "INF000000000", symbol: "SOMEBSEETF" })).not.toThrow();
    expect(stt({ segment: "eq_delivery", isin: "INF000000000", symbol: "SOMEBSEETF" })).toEqual({ pct: 0.001, side: "both" });
    expect(stt({ segment: "eq_intraday", isin: "INF000000000" })).toEqual({ pct: 0.00025, side: "sell" });
  });

  it("HYBRIDETF (INF769K01RJ5) is priced through etf_other — 0 / none — because `Hybrid` is not EQUITY", () => {
    for (const segment of EQ_SEGMENTS) {
      expect(stt({ segment, isin: "INF769K01RJ5" }), segment).toEqual({ pct: 0, side: "none" });
    }
  });

  it("the plan is honoured: upstox|plus prices an ETF sale at 0.001% seller AND keeps Plus's own ₹30 brokerage cap", () => {
    const plus = ratesForTrade(
      map,
      { broker: "upstox", segment: "eq_delivery", exchange: "NSE", isin: "INF204KB14I2" },
      "2026-09-01",
      "plus",
    );
    expect([plus.sttPct, plus.sttSide]).toEqual([0.00001, "sell"]);
    expect(plus.brokerageCap).toBe(30);
    expect(plus.brokeragePct).toBe(0.025);
    // The default plan's ETF STT is the same statute, but its brokerage is Basic's.
    const basic = ratesForTrade(map, { broker: "upstox", segment: "eq_delivery", exchange: "NSE", isin: "INF204KB14I2" }, "2026-09-01");
    expect([basic.sttPct, basic.sttSide]).toEqual([0.00001, "sell"]);
    expect(basic.brokerageCap).toBe(20);
  });
});

describe("the overlay is gated, narrow, and cannot take a rate out of thin air", () => {
  it("every F&O and commodity segment is untouched, even with an ETF's own ISIN and symbol on the row", () => {
    const fno: Segment[] = ["index_option", "stock_option", "future", "commodity_future", "commodity_option"];
    for (const segment of fno) {
      const exchange: Exchange = segment.startsWith("commodity") ? "MCX" : "NSE";
      const bare = findRates(map, "zerodha", segment, exchange, "2026-09-01");
      expect(stt({ segment, exchange, isin: "INF204KB14I2", symbol: "NIFTYBEES" }), segment).toEqual({ pct: bare.sttPct, side: bare.sttSide });
      expect(stt({ segment, exchange, isin: "INF732E01037", symbol: "LIQUIDBEES" }), segment).toEqual({ pct: bare.sttPct, side: bare.sttSide });
    }
    // Index options in particular: 0.15% of premium, seller — an ETF-looking symbol must not zero it.
    expect(stt({ segment: "index_option", isin: "INF732E01037", symbol: "LIQUIDBEES" })).toEqual({ pct: 0.0015, side: "sell" });
  });

  it("with EVERY etf_* rate row stripped out of the map the overlay falls back to the product row and never throws", () => {
    const stripped: RatesMap = new Map([...map.entries()].filter(([k]) => !k.includes("|etf_")));
    expect(stripped.size).toBe(map.size - 56); // 14 broker-plans × 2 exchanges × 2 rate segments (10 before v4.6.0 W9)
    const via = (segment: Segment, isin: string) =>
      ratesForTrade(stripped, { broker: "zerodha", segment, exchange: "NSE", isin }, "2026-09-01");
    for (const segment of EQ_SEGMENTS) {
      expect(() => via(segment, "INF204KB14I2"), segment).not.toThrow();
      const bare = findRates(stripped, "zerodha", segment, "NSE", "2026-09-01");
      expect([via(segment, "INF204KB14I2").sttPct, via(segment, "INF204KB14I2").sttSide], segment).toEqual([bare.sttPct, bare.sttSide]);
      expect([via(segment, "INF732E01037").sttPct, via(segment, "INF732E01037").sttSide], segment).toEqual([bare.sttPct, bare.sttSide]);
    }
  });

  it("an ETF trade differs from the plain product row in EXACTLY sttPct and sttSide — every other charge stays the trade's own", () => {
    for (const segment of ["eq_delivery", "eq_mtf"] as Segment[]) {
      for (const broker of ["zerodha", "dhan", "groww", "angelone", "upstox", "kotakneo", "paytm", "sahi", "fyers", "nuvama"] as Broker[]) {
        for (const exchange of ["NSE", "BSE"] as Exchange[]) {
          const base = findRates(map, broker, segment, exchange, "2026-09-01");
          const etf = ratesForTrade(map, { broker, segment, exchange, isin: "INF204KB14I2" }, "2026-09-01");
          const cols = (r: ChargeRates) => r as unknown as Record<string, unknown>;
          const differing = Object.keys(base).filter((k) => !Object.is(cols(base)[k], cols(etf)[k]));
          expect(differing.sort(), `${broker}/${segment}/${exchange}`).toEqual(["sttPct", "sttSide"]);
        }
      }
    }
  });

  it("ACCOUNT #3's class — a Dhan manual OPTION book prices IDENTICALLY with and without the ETF rows on file", () => {
    const stripped: RatesMap = new Map([...map.entries()].filter(([k]) => !k.includes("|etf_")));
    for (const segment of ["index_option", "stock_option", "future"] as Segment[]) {
      for (const on of ["2016-05-31", "2023-04-01", "2026-09-01"]) {
        const withEtf = ratesForTrade(map, { broker: "dhan", segment, exchange: "NSE" }, on);
        const without = ratesForTrade(stripped, { broker: "dhan", segment, exchange: "NSE" }, on);
        expect(withEtf, `${segment} ${on}`).toEqual(without);
      }
    }
  });

  it("the etf_* rate rows themselves carry ZERO in every non-STT column, so a future overlay widening cannot silently un-bill a trade", () => {
    // `subscriptionMonthly` is a PLAN fact carried on every row of that plan, not a per-trade
    // charge — kotakneo|pro states 249 here as it does everywhere else, and D4's "· paid" badge
    // reads it. The identity columns and the STT pair are the other exemptions.
    const skip = new Set([
      "sttPct", "sttSide", "effectiveFrom", "effectiveTo",
      "broker", "plan", "planLabel", "segment", "exchange", "subscriptionMonthly",
    ]);
    let checked = 0;
    for (const [k, epochs] of map) {
      if (!k.includes("|etf_")) continue;
      for (const r of epochs) {
        for (const [col, v] of Object.entries(r)) {
          if (skip.has(col)) continue;
          // null / false / 0 are all "nothing"; a NUMBER here would be a second charge.
          expect(v == null || v === false || v === 0, `${k} ${col} = ${String(v)}`).toBe(true);
        }
        checked++;
      }
    }
    expect(checked).toBe(112); // 28 etf_equity keys × 3 epochs + 28 etf_other keys × 1 (80 before v4.6.0 W9: 14 broker-plans, was 10)
  });
});
