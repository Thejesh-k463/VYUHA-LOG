import { describe, it, expect } from "vitest";
import {
  computeSettlement,
  DEFAULT_SETTLEMENT_RATES,
  type SettlementInput,
} from "@/lib/analytics/settlement";

const today = "2026-06-24";
const base = {
  optionType: null as string | null,
  strike: null as number | null,
  side: "long" as const,
  refPrice: null as number | null,
};

describe("computeSettlement — stock future", () => {
  const inputs: SettlementInput[] = [
    { ...base, id: 1, symbol: "RELIANCE", tradingsymbol: "FUT RELIANCE 25 Jun 2026", segment: "future", expiry: "2026-06-25", netQty: 250, refPrice: 3000 },
  ];
  const s = computeSettlement(inputs, DEFAULT_SETTLEMENT_RATES, today);
  const o = s.obligations[0];

  it("is physical, certain delivery, near expiry → danger", () => {
    expect(o.kind).toBe("stock_future");
    expect(o.physical).toBe(true);
    expect(o.settles).toBe("yes");
    expect(o.dte).toBe(1);
    expect(o.warn).toBe("danger");
    expect(o.deliveryAction).toBe("Take delivery (buy)");
  });

  it("computes notional + the delivery-STT jump", () => {
    expect(o.notional).toBe(750000); // 3000 × 250
    expect(o.physicalStt).toBe(750); // 0.1% × 750000
    expect(o.exitStt).toBe(150); // 0.02% × 750000
    expect(o.sttJump).toBe(600);
  });

  it("short future gives delivery", () => {
    const sh = computeSettlement(
      [{ ...inputs[0], side: "short" }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    ).obligations[0];
    expect(sh.deliveryAction).toBe("Give delivery (sell)");
    expect(sh.fundsOrShares).toContain("deliver 250 RELIANCE");
  });
});

describe("computeSettlement — stock option (spot known)", () => {
  it("ITM long call → take delivery, physical settles, exercise STT on intrinsic", () => {
    const o = computeSettlement(
      [{ ...base, id: 2, symbol: "RELIANCE", tradingsymbol: "OPT RELIANCE 25 Jun 2026 2900 CE", segment: "stock_option", optionType: "CE", strike: 2900, expiry: "2026-06-26", netQty: 250, refPrice: 3000 }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    ).obligations[0];
    expect(o.kind).toBe("stock_option");
    expect(o.moneyness).toBe("ITM");
    expect(o.intrinsicPerUnit).toBe(100); // 3000 − 2900
    expect(o.settles).toBe("yes");
    expect(o.deliveryAction).toBe("Take delivery (buy)");
    expect(o.notional).toBe(725000); // strike 2900 × 250
    expect(o.physicalStt).toBe(31); // 0.125% × 100 × 250 = 31.25 → ₹31
    expect(o.warn).toBe("danger"); // dte 2 ≤ 7
  });

  it("OTM call lapses worthless — no delivery", () => {
    const o = computeSettlement(
      [{ ...base, id: 3, symbol: "TCS", tradingsymbol: "OPT TCS 25 Jun 2026 4000 CE", segment: "stock_option", optionType: "CE", strike: 4000, expiry: "2026-06-26", netQty: 175, refPrice: 3800 }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    ).obligations[0];
    expect(o.moneyness).toBe("OTM");
    expect(o.settles).toBe("no");
    expect(o.warn).toBe("info"); // near but harmless
  });

  it("short ITM put → take delivery (assigned)", () => {
    const o = computeSettlement(
      [{ ...base, id: 4, symbol: "INFY", tradingsymbol: "OPT INFY 25 Jun 2026 1600 PE", segment: "stock_option", optionType: "PE", strike: 1600, side: "short", expiry: "2026-06-26", netQty: 400, refPrice: 1500 }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    ).obligations[0];
    expect(o.moneyness).toBe("ITM"); // put ITM when spot < strike
    expect(o.deliveryAction).toBe("Take delivery (buy)");
  });
});

describe("computeSettlement — stock option (spot unknown)", () => {
  it("falls back to a conditional 'if-ITM' obligation with strike-based notional", () => {
    const o = computeSettlement(
      [{ ...base, id: 5, symbol: "HDFCBANK", tradingsymbol: "OPT HDFCBANK 25 Jun 2026 1700 PE", segment: "stock_option", optionType: "PE", strike: 1700, expiry: "2026-06-26", netQty: 550, refPrice: null }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    ).obligations[0];
    expect(o.moneyness).toBe("unknown");
    expect(o.settles).toBe("if-ITM");
    expect(o.notional).toBe(935000); // 1700 × 550 (known from strike)
    expect(o.physicalStt).toBeNull();
    expect(o.deliveryAction).toBe("Give delivery (sell)"); // long put → sell
    expect(o.warn).toBe("warn"); // conditional & near
  });
});

describe("computeSettlement — cash-settled & non-equity", () => {
  it("index option is cash-settled, no obligation", () => {
    const o = computeSettlement(
      [{ ...base, id: 6, symbol: "NIFTY", tradingsymbol: "OPT NIFTY 26 Jun 2026 24000 CE", segment: "index_option", optionType: "CE", strike: 24000, expiry: "2026-06-26", netQty: 75, refPrice: 24500 }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    ).obligations[0];
    expect(o.kind).toBe("index_cash");
    expect(o.physical).toBe(false);
    expect(o.settles).toBe("no");
  });

  it("index future (symbol in index set) is cash-settled", () => {
    const o = computeSettlement(
      [{ ...base, id: 7, symbol: "BANKNIFTY", tradingsymbol: "FUT BANKNIFTY 26 Jun 2026", segment: "future", expiry: "2026-06-26", netQty: 30, refPrice: 52000 }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    ).obligations[0];
    expect(o.kind).toBe("index_cash");
    expect(o.physical).toBe(false);
  });

  it("commodity future is surfaced separately", () => {
    const o = computeSettlement(
      [{ ...base, id: 8, symbol: "CRUDEOIL", tradingsymbol: "FUT CRUDEOIL 19 Jun 2026", segment: "commodity_future", expiry: "2026-06-19", netQty: 100, refPrice: 6000 }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    ).obligations[0];
    expect(o.kind).toBe("commodity");
    expect(o.physical).toBe(false);
  });

  it("equity rows are ignored", () => {
    const s = computeSettlement(
      [{ ...base, id: 9, symbol: "ITC", tradingsymbol: "ITC", segment: "eq_delivery", expiry: null, netQty: 100, refPrice: 450 }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    );
    expect(s.total).toBe(0);
  });
});

describe("computeSettlement — summary & ordering", () => {
  const inputs: SettlementInput[] = [
    { ...base, id: 10, symbol: "NIFTY", tradingsymbol: "OPT NIFTY 26 Jun 2026 24000 CE", segment: "index_option", optionType: "CE", strike: 24000, expiry: "2026-06-26", netQty: 75, refPrice: 24500 },
    { ...base, id: 11, symbol: "RELIANCE", tradingsymbol: "FUT RELIANCE 25 Jun 2026", segment: "future", expiry: "2026-06-25", netQty: 250, refPrice: 3000 },
    { ...base, id: 12, symbol: "INFY", tradingsymbol: "OPT INFY 25 Jun 2026 1500 CE", segment: "stock_option", optionType: "CE", strike: 1500, expiry: "2026-06-26", netQty: 400, refPrice: 1600 },
  ];
  const s = computeSettlement(inputs, DEFAULT_SETTLEMENT_RATES, today);

  it("counts physical vs cash and aggregates risk", () => {
    expect(s.total).toBe(3);
    expect(s.physicalCount).toBe(2); // future + stock option
    expect(s.certainDeliveryCount).toBe(2); // future + ITM stock option
    expect(s.expiringPhysicalCount).toBe(2);
    expect(s.nearestExpiry).toBe("2026-06-25");
    // notionalAtRisk = 750000 (RELIANCE fut) + 600000 (INFY 1500×400) = 1350000
    expect(s.notionalAtRisk).toBe(1350000);
    expect(s.fundsNeeded).toBe(1350000); // both are take-delivery (long fut + long ITM call)
  });

  it("orders physical positions first, nearest expiry first", () => {
    expect(s.obligations[0].symbol).toBe("RELIANCE"); // physical, dte 1
    expect(s.obligations[s.obligations.length - 1].kind).toBe("index_cash");
  });

  it("empty input → zeroed summary", () => {
    const e = computeSettlement([], DEFAULT_SETTLEMENT_RATES, today);
    expect(e.total).toBe(0);
    expect(e.notionalAtRisk).toBe(0);
    expect(e.nearestExpiry).toBeNull();
  });
});
