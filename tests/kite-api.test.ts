import { describe, expect, it } from "vitest";
import { normalizeKiteTrades, type KiteTradeRow } from "../lib/import/api/kite";

const row = (over: Partial<KiteTradeRow>): KiteTradeRow => ({
  tradingsymbol: "ATGL",
  exchange: "NSE",
  product: "CNC",
  transaction_type: "BUY",
  quantity: 10,
  average_price: 600,
  fill_timestamp: "2026-07-11 10:02:31",
  ...over,
});

describe("normalizeKiteTrades", () => {
  it("aggregates executions per symbol+product into one round-trip", () => {
    const out = normalizeKiteTrades([
      row({ quantity: 10, average_price: 600 }),
      row({ quantity: 5, average_price: 610 }),
      row({ transaction_type: "SELL", quantity: 15, average_price: 620, fill_timestamp: "2026-07-11 14:30:00" }),
    ]);
    expect(out).toHaveLength(1);
    const t = out[0];
    expect(t.buyQty).toBe(15);
    expect(t.avgBuyPrice).toBeCloseTo((10 * 600 + 5 * 610) / 15, 2);
    expect(t.sellQty).toBe(15);
    expect(t.sellValue).toBe(9300);
    // gross = (620 − 603.33) × 15
    expect(t.grossPnl).toBeCloseTo(250, 0);
    expect(t.productHint).toBe("delivery");
    expect(t.broker).toBe("zerodha");
  });

  it("keeps earliest buy date and latest sell date across executions", () => {
    const out = normalizeKiteTrades([
      row({ fill_timestamp: "2026-07-11 11:00:00" }),
      row({ fill_timestamp: "2026-07-11 09:20:00" }),
      row({ transaction_type: "SELL", fill_timestamp: "2026-07-11 15:15:00" }),
    ]);
    expect(out[0].buyDate).toBe("2026-07-11");
    expect(out[0].sellDate).toBe("2026-07-11");
  });

  it("separates products and maps hints (MIS→intraday, NRML→null)", () => {
    const out = normalizeKiteTrades([
      row({ product: "MIS" }),
      row({ product: "NRML", tradingsymbol: "NIFTY26JUL24500CE", exchange: "NFO", quantity: 75, average_price: 120 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((t) => t.tradingsymbol === "ATGL")!.productHint).toBe("intraday");
    const opt = out.find((t) => t.tradingsymbol === "NIFTY26JUL24500CE")!;
    expect(opt.productHint).toBeNull();
    expect(opt.exchangeHint).toBe("NSE"); // NFO → NSE
  });

  it("leaves one-sided (open) groups with zero gross", () => {
    const out = normalizeKiteTrades([row({})]);
    expect(out[0].sellQty).toBe(0);
    expect(out[0].grossPnl).toBe(0);
  });

  it("skips zero-qty rows", () => {
    expect(normalizeKiteTrades([row({ quantity: 0 })])).toHaveLength(0);
  });
});
