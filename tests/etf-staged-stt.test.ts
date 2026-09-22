import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedRatesMap } from "@/lib/engine/rates";
import type { Leg } from "@/lib/domain/staged";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v4.5.0 wave 3a — A STAGED LADDER IS AN ETF TOO (the wave-3a writer defect).
 *
 * `priceLegs` handed `ratesForTrade` only `{broker, segment, exchange}`, so the
 * ETF STT overlay could never fire on a staged position: a NIFTYBEES ladder was
 * billed the equity-SHARE delivery STT — 0.1% on both sides — on every leg,
 * while the identical flat trade was billed 0.001% on the sale only. Two
 * pricing answers for one instrument, from one entry point, with nothing on
 * screen looking wrong. The fix is `isin`/`symbol` on the ctx and on the
 * `rebuildStagedTrade` call that fills it from the parent row.
 *
 * The REAL `priceLegs` is driven here, not a mirror: the mirror cannot see the
 * overlay at all. lib/queries/staged.ts is server-only, so it is imported
 * DYNAMICALLY after the helper sets VYUHA_DB_PATH — ONE temp database per FILE
 * (AGENTS.md Testing). The rates come from the pure seed map, so nothing in
 * this file depends on what is in that database.
 */

const ratesMap = seedRatesMap();
const ASOF = "2026-09-15";

/** 100 bought at 200, 100 sold at 220: ₹20,000 buy value, ₹22,000 sell value. */
const legs: Leg[] = [
  { id: 1, seq: 1, kind: "entry", tradeDate: "2026-08-01", qty: 100, price: 200 },
  { id: 2, seq: 2, kind: "exit", tradeDate: "2026-09-01", qty: 100, price: 220 },
];
const BUY_VALUE = 20_000;
const SELL_VALUE = 22_000;

describe("the ETF STT overlay reaches a STAGED ladder (lib/queries/staged.ts#priceLegs)", () => {
  let t: TempDb;
  let staged: typeof import("@/lib/queries/staged");

  beforeAll(async () => {
    t = await openTempDb("etf-staged-stt");
    staged = await import("@/lib/queries/staged");
  }, 120_000);
  afterAll(() => t?.cleanup());

  /** Per-leg STT as the real ladder bills it, for an instrument and a segment. */
  const sttPerLeg = (
    instrument: { isin?: string | null; symbol?: string | null },
    segment: "eq_delivery" | "eq_mtf" | "eq_intraday" = "eq_delivery",
  ): number[] =>
    staged
      .priceLegs(legs, { broker: "zerodha", segment, exchange: "NSE", direction: "long", asOf: ASOF, ...instrument }, ratesMap)
      .map((p) => p.breakdown.sttCtt);

  it("an ordinary share is unchanged: 0.1% of BOTH legs, which is what every ETF used to be billed", () => {
    const [buy, sell] = sttPerLeg({ isin: "INE002A01018", symbol: "RELIANCE" });
    expect(buy).toBe(Math.round(BUY_VALUE * 0.001));
    expect(sell).toBe(Math.round(SELL_VALUE * 0.001));
    // …and a ladder with no instrument at all prices exactly as it always did.
    expect(sttPerLeg({})).toEqual([buy, sell]);
  });

  it("a NIFTYBEES ladder is billed 0.001% on the SELL leg only — the s.98 Sl. 2A rate, seller-side", () => {
    // STT rounds to the rupee (invariant 3 / engine rule), so 22,000 × 0.001% = ₹0.22 → ₹0.
    // Assert the RATE the ladder priced at, not just the rounded rupee, so the
    // case cannot pass by being small: buy side must be zero, sell side must be
    // the seller-only row, and the equity-share bill must be gone.
    for (const instrument of [{ isin: "INF204KB14I2" }, { symbol: "NIFTYBEES" }, { isin: "INF204KB14I2", symbol: "NIFTYBEES" }]) {
      const [buy, sell] = sttPerLeg(instrument);
      expect(buy, JSON.stringify(instrument)).toBe(0);
      expect(sell, JSON.stringify(instrument)).toBe(Math.round(SELL_VALUE * 0.00001));
      // The equity-share bill it used to carry — ₹20 and ₹22 — is what this kills.
      expect(buy, JSON.stringify(instrument)).not.toBe(Math.round(BUY_VALUE * 0.001));
      expect(sell, JSON.stringify(instrument)).not.toBe(Math.round(SELL_VALUE * 0.001));
    }
  });

  it("the same ladder under MTF is priced the same way, and INTRADAY is deliberately untouched", () => {
    expect(sttPerLeg({ isin: "INF204KB14I2" }, "eq_mtf")).toEqual([0, Math.round(SELL_VALUE * 0.00001)]);
    // Intraday: the s.98 "otherwise than by actual delivery" row already names an
    // equity-oriented unit at the share's own rate, so it must NOT move.
    expect(sttPerLeg({ isin: "INF204KB14I2" }, "eq_intraday")).toEqual(sttPerLeg({ symbol: "RELIANCE" }, "eq_intraday"));
    expect(sttPerLeg({ isin: "INF204KB14I2" }, "eq_intraday")[1]).toBe(Math.round(SELL_VALUE * 0.00025));
  });

  it("a GOLDBEES ladder is billed NO STT at all, on either leg, in every equity segment", () => {
    for (const segment of ["eq_delivery", "eq_mtf", "eq_intraday"] as const) {
      expect(sttPerLeg({ isin: "INF204KB17I5" }, segment), segment).toEqual([0, 0]);
      expect(sttPerLeg({ symbol: "GOLDBEES" }, segment), segment).toEqual([0, 0]);
    }
  });

  it("only the STT moves: every other charge on an ETF ladder equals the ordinary share's", () => {
    const share = staged.priceLegs(
      legs,
      { broker: "zerodha", segment: "eq_delivery", exchange: "NSE", direction: "long", asOf: ASOF, symbol: "RELIANCE" },
      ratesMap,
    );
    const etf = staged.priceLegs(
      legs,
      { broker: "zerodha", segment: "eq_delivery", exchange: "NSE", direction: "long", asOf: ASOF, isin: "INF204KB14I2" },
      ratesMap,
    );
    const cols = (b: unknown) => b as Record<string, unknown>;
    expect(etf).toHaveLength(share.length);
    etf.forEach((leg, i) => {
      const other = share[i];
      const differing = Object.keys(leg.breakdown).filter(
        (k) => !Object.is(cols(leg.breakdown)[k], cols(other.breakdown)[k]),
      );
      // `total` moves because the STT inside it did; nothing else may.
      expect(differing.sort(), `leg ${leg.legId}`).toEqual(["sttCtt", "total"]);
    });
  });
});
