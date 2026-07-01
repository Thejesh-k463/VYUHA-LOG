import { describe, it, expect } from "vitest";
import { computeTradeCalc, type TradeCalcInput } from "@/lib/analytics/trade-calc";
import { seedRatesMap, findRates } from "@/lib/engine/rates";
import { toRupees } from "@/lib/money";

const rates = (broker: string, segment: string, exchange = "NSE") =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findRates(seedRatesMap(), broker as any, segment as any, exchange as any);

describe("computeTradeCalc — equity delivery (long)", () => {
  const input: TradeCalcInput = {
    segment: "eq_delivery", side: "long", entry: 100, sl: 95, target: 110, qty: 100, numTrades: 1,
  };
  const r = computeTradeCalc(input, rates("zerodha", "eq_delivery"));

  it("computes gross P&L per scenario", () => {
    expect(toRupees(r.target.grossPaise)).toBe(1000); // (110-100)*100
    expect(toRupees(r.sl.grossPaise)).toBe(-500); // (95-100)*100
  });

  it("nets out real charges and a gross 2:1 reward:risk", () => {
    expect(r.chargesPerTradePaise).toBeGreaterThan(0);
    expect(r.target.netPaise).toBeLessThan(r.target.grossPaise); // charges eat in
    expect(r.rrGross).toBe(2); // 1000 / 500
    expect(r.breakevenPrice).toBeGreaterThan(100); // above entry for a long
  });
});

describe("computeTradeCalc — index option (long), × N trades", () => {
  const input: TradeCalcInput = {
    segment: "index_option", side: "long", entry: 100, sl: 60, target: 180, qty: 75, numTrades: 20,
  };
  const r = computeTradeCalc(input, rates("dhan", "index_option"));

  it("scales charges and P&L across N trades", () => {
    expect(r.numTrades).toBe(20);
    expect(r.totalChargesPaise).toBe(r.chargesPerTradePaise * 20);
    expect(r.totalSttPaise).toBe(r.target.charges.sttCtt * 20);
    expect(r.totalNetTargetPaise).toBe(r.target.netPaise * 20);
    expect(r.totalNetSlPaise).toBe(r.sl.netPaise * 20);
  });

  it("charges a non-zero STT on the option sell leg", () => {
    expect(r.target.charges.sttCtt).toBeGreaterThan(0);
  });
});

describe("computeTradeCalc — short future puts STT on the sell (entry) leg", () => {
  const long = computeTradeCalc(
    { segment: "future", side: "long", entry: 3000, sl: 2950, target: 3100, qty: 250 },
    rates("dhan", "future"),
  );
  const short = computeTradeCalc(
    { segment: "future", side: "short", entry: 3000, sl: 3050, target: 2900, qty: 250 },
    rates("dhan", "future"),
  );
  it("profits when a short's exit is below entry; breakeven below entry", () => {
    expect(toRupees(short.target.grossPaise)).toBe(25000); // (3000-2900)*250
    expect(short.breakevenPrice).toBeLessThan(3000);
    expect(long.breakevenPrice).toBeGreaterThan(3000);
  });
});

describe("computeTradeCalc — equity MTF interest grows with holding days", () => {
  const base = { segment: "eq_mtf" as const, side: "long" as const, entry: 1000, sl: 950, target: 1100, qty: 500 };
  const d10 = computeTradeCalc({ ...base, mtf: { fundedAmount: 500000, daysHeld: 10 } }, rates("dhan", "eq_mtf"));
  const d40 = computeTradeCalc({ ...base, mtf: { fundedAmount: 500000, daysHeld: 40 } }, rates("dhan", "eq_mtf"));
  it("longer holding ⇒ more MTF interest ⇒ higher total charges", () => {
    expect(d40.target.charges.mtfInterest).toBeGreaterThan(d10.target.charges.mtfInterest);
    expect(d40.chargesPerTradePaise).toBeGreaterThan(d10.chargesPerTradePaise);
  });
});
