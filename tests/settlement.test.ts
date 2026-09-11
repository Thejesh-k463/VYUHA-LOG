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
    // 0.05% × 750,000. Was 150 at the pre-1-Apr-2026 rate of 0.02%; raised by
    // the Finance Act 2026 (NSE circular 02/2026, ref NSE/FATAX/73524, row 4(c)).
    // The number moved because the STATUTE moved, not to make a test pass.
    expect(o.exitStt).toBe(375);
    /**
     * 750 − 375 = 375. The jump USED to be 600, and it shrank — a real and
     * slightly counter-intuitive consequence of the Finance Act 2026: because
     * the cost of squaring a future off tripled (0.02% → 0.05%) while delivery
     * STT was left alone at 0.1%, the PENALTY for letting a stock future go to
     * physical delivery is now smaller than it was. The warning this module
     * exists to give is therefore weaker than before, and correctly so.
     */
    expect(o.sttJump).toBe(375);
  });

  it("physicalSttTotal sums the STT settlement will LEVY — never futures deltas mixed with options absolutes", () => {
    // One future (physicalStt 750, sttJump 375) + one ITM call (physicalStt
    // only — an option's exit STT needs its current premium, unknowable
    // offline). The old total summed 375 + option-absolute under a "extra STT"
    // label; the summary figure is now Σ physicalStt, labelled as such, and
    // per-row sttJump keeps the honest futures-only delta.
    const s2 = computeSettlement(
      [
        inputs[0],
        { ...base, id: 2, symbol: "RELIANCE", tradingsymbol: "OPT RELIANCE 25 Jun 2026 2900 CE", segment: "stock_option", optionType: "CE", strike: 2900, expiry: "2026-06-25", netQty: 250, refPrice: 3000 },
      ],
      DEFAULT_SETTLEMENT_RATES,
      today,
    );
    const opt = s2.obligations.find((o2) => o2.kind === "stock_option")!;
    expect(opt.sttJump).toBeNull(); // no invented option delta
    expect(opt.physicalStt).not.toBeNull();
    expect(s2.physicalSttTotal).toBe(750 + opt.physicalStt!);
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
    // R78: TWO levies, each rounded to the rupee on its own.
    //   delivery STT  0.1%  × 7,25,000 (strike × qty)  = ₹725 — a physically
    //     settled contract carries delivery STT on BOTH sides (FATAX38737,
    //     from 26 Jul 2018);
    //   exercise STT  0.15% × 100 × 250 (intrinsic)   = 37.5 → ₹38 — circular
    //     02/2026 row 4(b), payable by the PURCHASER who exercises.
    // This pin was 38 — the exercise term alone — under a footer saying the
    // delivery charge was included.
    expect(o.physicalStt).toBe(763);
    expect(o.physicalStt).not.toBe(38);
    expect(o.warn).toBe("danger"); // dte 2 ≤ 7
  });

  it("R77 short ITM call → give delivery, delivery STT on the strike value and NO exercise STT", () => {
    const o = computeSettlement(
      [{ ...base, id: 13, symbol: "SBIN", tradingsymbol: "OPT SBIN 25 Jun 2026 1400 CE", segment: "stock_option", optionType: "CE", strike: 1400, side: "short", expiry: "2026-06-26", netQty: 500, refPrice: 1500 }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    ).obligations[0];
    expect(o.moneyness).toBe("ITM");
    expect(o.deliveryAction).toBe("Give delivery (sell)"); // assigned writer delivers
    expect(o.notional).toBe(700000); // 1400 × 500
    // 0.1% × 7,00,000 = ₹700. The writer does not exercise, so row 4(b)
    // (payable by the purchaser) is not its levy: 0.15% × 100 × 500 = ₹75 was
    // what this row printed, a tenth of what it owes.
    expect(o.physicalStt).toBe(700);
    expect(o.physicalStt).not.toBe(75);
    expect(o.sttJump).toBeNull(); // an option's exit STT needs its premium
  });

  it("an index option is cash-settled — no delivery STT, no STT figure at all", () => {
    const o = computeSettlement(
      [{ ...base, id: 14, symbol: "NIFTY", tradingsymbol: "OPT NIFTY 26 Jun 2026 24000 CE", segment: "index_option", optionType: "CE", strike: 24000, side: "short", expiry: "2026-06-26", netQty: 75, refPrice: 24500 }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    ).obligations[0];
    expect(o.kind).toBe("index_cash");
    expect(o.physicalStt).toBeNull();
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
    // R77: the assigned writer takes 400 shares at 1600 — delivery STT 0.1% ×
    // 6,40,000 = ₹640, and no exercise STT (that is the purchaser's levy). It
    // printed ₹60 (0.15% × 100 × 400) before.
    expect(o.notional).toBe(640000);
    expect(o.physicalStt).toBe(640);
    expect(o.physicalStt).not.toBe(60);
  });

  it("the summary carries the rates it was computed with — the footer prints them", () => {
    const rates = { ...DEFAULT_SETTLEMENT_RATES, deliverySttPct: 0.0012 };
    const s = computeSettlement(
      [{ ...base, id: 15, symbol: "SBIN", tradingsymbol: "OPT SBIN 25 Jun 2026 1400 CE", segment: "stock_option", optionType: "CE", strike: 1400, side: "short", expiry: "2026-06-26", netQty: 500, refPrice: 1500 }],
      rates,
      today,
    );
    expect(s.rates).toEqual(rates);
    expect(s.obligations[0].physicalStt).toBe(840); // 0.12% × 7,00,000 — the passed rate, not the default
    expect(s.physicalSttTotal).toBe(840);
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

/**
 * OWNER RULING C-1 (v4.2 fix wave 3). A stock future is settled by the exchange
 * at the UNDERLYING's cash-segment close, so `refPrice` is that cash mark —
 * and when the book holds no cash mark, no recorded close and no usable entry
 * price, the reference is UNKNOWN. It used to be coerced (`p.refPrice ?? 0`)
 * into a ₹0 notional, ₹0 STT and a ₹0 "STT jump" — a fabricated number on the
 * one panel whose whole job is to warn about a delivery obligation
 * (invariant 6: blank beats 0). Unknown now stays unknown, all the way to the
 * "—" the panel prints.
 */
describe("computeSettlement — stock future with an UNKNOWN reference price (C-1)", () => {
  const unknownFut: SettlementInput = {
    ...base,
    id: 20,
    symbol: "WIPRO",
    tradingsymbol: "FUT WIPRO 25 Jun 2026",
    segment: "future",
    side: "short",
    expiry: "2026-06-25",
    netQty: 300,
    refPrice: null,
  };

  it("carries a null reference through as an unknown notional — never ₹0", () => {
    const o = computeSettlement([unknownFut], DEFAULT_SETTLEMENT_RATES, today).obligations[0];
    expect(o.kind).toBe("stock_future");
    expect(o.settles).toBe("yes"); // it WILL devolve; only its value is unknown
    expect(o.notional).toBeNull();
    expect(o.notional).not.toBe(0);
    expect(o.physicalStt).toBeNull();
    expect(o.exitStt).toBeNull();
    expect(o.sttJump).toBeNull();
    // The delivery is still stated in SHARES — that much is known.
    expect(o.fundsOrShares).toContain("deliver 300 WIPRO");
    expect(o.warn).toBe("danger"); // dte 1 — an unknown value is not a safe one
  });

  it("a LONG unknown future states no rupee figure it cannot derive", () => {
    const o = computeSettlement(
      [{ ...unknownFut, side: "long" }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    ).obligations[0];
    expect(o.deliveryAction).toBe("Take delivery (buy)");
    expect(o.notional).toBeNull();
    expect(o.fundsOrShares).not.toContain("₹0");
    expect(o.fundsOrShares.toLowerCase()).toContain("unknown");
  });

  it("the summary EXCLUDES it and counts it instead of summing a zero", () => {
    const s = computeSettlement(
      [
        unknownFut,
        { ...base, id: 21, symbol: "RELIANCE", tradingsymbol: "FUT RELIANCE 25 Jun 2026", segment: "future", expiry: "2026-06-25", netQty: 250, refPrice: 3000 },
      ],
      DEFAULT_SETTLEMENT_RATES,
      today,
    );
    expect(s.notionalAtRisk).toBe(750000); // the known future only
    expect(s.fundsNeeded).toBe(750000);
    expect(s.physicalSttTotal).toBe(750);
    expect(s.unknownNotionalCount).toBe(1);
    // …and an all-known book counts none.
    expect(computeSettlement([{ ...unknownFut, refPrice: 500 }], DEFAULT_SETTLEMENT_RATES, today).unknownNotionalCount).toBe(0);
  });

  it("known-value futures are unchanged (the cash mark, times qty)", () => {
    const o = computeSettlement(
      [{ ...unknownFut, refPrice: 500 }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    ).obligations[0];
    expect(o.notional).toBe(150000); // 500 × 300
    expect(o.physicalStt).toBe(150);
  });
});

/**
 * OWNER RULING M-1 (v4.2 fix wave 4). Futures STT is SELL-SIDE ONLY — the
 * `future` row of `charge_config` is `{ pct: 0.0005, side: "sell" }`
 * (lib/db/seed-data.ts) and `lib/engine/charges.ts` levies it on `sellValue`
 * alone. `exitStt` is what SQUARING OFF costs, so it depends on the direction
 * of the square-off, which is the opposite of the position's side:
 *
 *   LONG  → square off by SELLING → sell-side rate × notional
 *   SHORT → square off by BUYING  → ₹0, because STT does not touch the buy leg
 *
 * The side-blind version charged a short future an exit STT it would never pay
 * and, through `sttJump = physicalStt − exitStt`, UNDERSTATED the penalty for
 * letting it devolve by exactly that amount — on the one panel that exists to
 * warn about that penalty. For a short, the whole delivery STT IS the jump.
 */
describe("computeSettlement — exit STT is side-aware (M-1)", () => {
  const sbinFut = (side: "long" | "short"): SettlementInput => ({
    ...base,
    id: 30,
    symbol: "SBIN",
    tradingsymbol: "FUT SBIN 25 Jun 2026",
    segment: "future",
    side,
    expiry: "2026-06-25",
    netQty: 500,
    refPrice: 1400, // notional = 1400 × 500 = 7,00,000
  });

  it("a LONG future squares off by SELLING — the sell-side rate applies", () => {
    const o = computeSettlement([sbinFut("long")], DEFAULT_SETTLEMENT_RATES, today).obligations[0];
    expect(o.deliveryAction).toBe("Take delivery (buy)");
    expect(o.notional).toBe(700000);
    expect(o.physicalStt).toBe(700); // 0.1%  × 7,00,000 — delivery STT
    expect(o.exitStt).toBe(350); //     0.05% × 7,00,000 — futures STT, sell side
    expect(o.sttJump).toBe(350); //     700 − 350
  });

  it("a SHORT future squares off by BUYING — ₹0 exit STT, so the jump is the WHOLE delivery STT", () => {
    const o = computeSettlement([sbinFut("short")], DEFAULT_SETTLEMENT_RATES, today).obligations[0];
    expect(o.deliveryAction).toBe("Give delivery (sell)");
    expect(o.notional).toBe(700000);
    expect(o.physicalStt).toBe(700);
    expect(o.exitStt).toBe(0);
    expect(o.exitStt).not.toBe(350); // the side-blind figure this ruling removes
    expect(o.sttJump).toBe(700); // 700 − 0, not 350
  });

  it("the two sides differ by exactly the sell-side charge a short never pays", () => {
    const long = computeSettlement([sbinFut("long")], DEFAULT_SETTLEMENT_RATES, today).obligations[0];
    const short = computeSettlement([sbinFut("short")], DEFAULT_SETTLEMENT_RATES, today).obligations[0];
    expect(short.sttJump! - long.sttJump!).toBe(350);
    expect(long.exitStt! - short.exitStt!).toBe(350);
  });
});

/**
 * M-2 — the Funds tile's exclusion count is its OWN.
 *
 * `fundsNeeded` sums only "Take delivery (buy)" rows, so the positions it could
 * not include are the unknown TAKE-DELIVERY ones. `unknownNotionalCount` counts
 * every settling row with an unknown notional, give-delivery included — hung on
 * the Funds tile it printed "Funds to take delivery ₹0 · 1 unknown" over a book
 * whose only unknown row delivers SHARES and needs no cash at all.
 */
describe("computeSettlement — the Funds tile counts only what IT excluded (M-2)", () => {
  const unknownShortFut: SettlementInput = {
    ...base,
    id: 40,
    symbol: "WIPRO",
    tradingsymbol: "FUT WIPRO 25 Jun 2026",
    segment: "future",
    side: "short",
    expiry: "2026-06-25",
    netQty: 300,
    refPrice: null,
  };

  it("a SHORT unknown future is counted by the notional tiles and NOT by the funds tile", () => {
    const s = computeSettlement([unknownShortFut], DEFAULT_SETTLEMENT_RATES, today);
    expect(s.obligations[0].deliveryAction).toBe("Give delivery (sell)");
    expect(s.unknownNotionalCount).toBe(1); // notional + STT totals did exclude it
    expect(s.unknownFundsCount).toBe(0); // …but fundsNeeded never wanted it
    expect(s.fundsNeeded).toBe(0);
  });

  it("a LONG unknown future IS counted by the funds tile — that total is genuinely short", () => {
    const s = computeSettlement(
      [{ ...unknownShortFut, side: "long" }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    );
    expect(s.obligations[0].deliveryAction).toBe("Take delivery (buy)");
    expect(s.unknownNotionalCount).toBe(1);
    expect(s.unknownFundsCount).toBe(1);
  });

  it("both signs at once: two unknown rows, one of them funds", () => {
    const s = computeSettlement(
      [unknownShortFut, { ...unknownShortFut, id: 41, symbol: "LT", tradingsymbol: "FUT LT 25 Jun 2026", side: "long" }],
      DEFAULT_SETTLEMENT_RATES,
      today,
    );
    expect(s.unknownNotionalCount).toBe(2);
    expect(s.unknownFundsCount).toBe(1);
  });
});
