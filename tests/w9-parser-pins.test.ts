import { describe, it, expect } from "vitest";
import { buildContext } from "@/lib/import/detect";
import { parseFyersTradebook } from "@/lib/import/parsers/fyers-tradebook";
import { orderByCumulative } from "@/lib/import/parsers/nuvama-pnl-report";

/**
 * Two W9 parser branches the v4.6.0 money-mutation lens found UNPINNED (no
 * behaviour change here — pins only):
 *
 *   MU-1 — `orderByCumulative` (nuvama-pnl-report.ts): the FIRST day of an
 *          instrument may start from a position held BEFORE the report window;
 *          the chain's own first cumulative then states the opening. Deleting
 *          that fallback let a same-day buy pair against a sale that closed an
 *          earlier lot (an invented cost basis) and 0 of the 30 fixture
 *          instruments took the path.
 *   MU-2 — Fyers product → leg: CNC / Overnight / Margin are DELIVERY (the
 *          fixture is all derivatives, so a mutant to intraday stayed green).
 */

type Line = Parameters<typeof orderByCumulative>[0][number];
const line = (seq: number, side: "buy" | "sell", qty: number, cum: number | null, date = "2026-07-01"): Line =>
  ({
    instrument: "ABC", isin: "INE000A01010", inst: {} as Line["inst"], date, side, qty, price: 100, cum,
    exchange: "NSE", heads: { brokerage: 0, gst: 0, sttCtt: 0, stampDuty: 0, sebi: 0, exchangeTxn: 0, other: 0 }, net: 0, seq,
  }) as Line;

describe("MU-1 · orderByCumulative — the first day may open on a position held before the window", () => {
  it("sell 100 then buy 50 (cumulative 0 → 50): an opening position of 100 is read off the chain, the day RESOLVES", () => {
    // Printed buy-first; only sell-then-buy satisfies the chain from an opening of 100.
    const { ordered, unresolvedDays } = orderByCumulative([line(1, "buy", 50, 50), line(2, "sell", 100, 0)]);
    expect(unresolvedDays).toBe(0);
    expect(ordered.map((l) => [l.side, l.qty, l.cum])).toEqual([["sell", 100, 0], ["buy", 50, 50]]);
  });

  it("…and the next day continues from where the first left (50), not from 0", () => {
    const { ordered, unresolvedDays } = orderByCumulative([
      line(1, "buy", 50, 50), line(2, "sell", 100, 0),
      line(3, "sell", 50, 0, "2026-07-02"),
    ]);
    expect(unresolvedDays).toBe(0);
    expect(ordered.map((l) => l.seq)).toEqual([2, 1, 3]);
  });

  it("the fallback is the FIRST day only: a later day that breaks the chain is unresolved (buys first)", () => {
    const { unresolvedDays } = orderByCumulative([
      line(1, "buy", 10, 10),
      line(2, "buy", 5, 99, "2026-07-02"),
    ]);
    expect(unresolvedDays).toBe(1);
  });
});

const FYERS_EQUITY_CSV = [
  "Report Title,Tradebook report,,,,,,,,,",
  "Date Range,From 01/07/2026 to 03/07/2026,,,,,,,,,",
  ",,,,,,,,,,",
  "Symbol name,Symbol code,Date & time,Side,Product type,Qty,Traded price,Total value,Segment,Exchange order ID,OMS order ID",
  'TCS,TCS-EQ,"03 Jul 2026, 10:00:00 AM",BUY,Intraday,1,3000,"3,000.00",Capital Market,1100000000000004,2607030000004',
  'INFY,INFY-EQ,"02 Jul 2026, 10:00:00 AM",BUY,Margin,2,1500,"3,000.00",Capital Market,1100000000000003,2607020000003',
  'ITC,ITC-EQ,"01 Jul 2026, 11:00:00 AM",BUY,Overnight,10,400,"4,000.00",Capital Market,1100000000000002,2607010000002',
  'RELIANCE,RELIANCE-EQ,"01 Jul 2026, 10:00:00 AM",BUY,CNC,5,1400,"7,000.00",Capital Market,1100000000000001,2607010000001',
].join("\n");

describe("MU-2 · Fyers product type → leg product", () => {
  it("CNC, Overnight and Margin are DELIVERY; Intraday is intraday", () => {
    const file = "FYERS_tradebook_equity.csv";
    const parsed = parseFyersTradebook(buildContext(file, Buffer.from(FYERS_EQUITY_CSV)));
    const hint = Object.fromEntries(parsed.trades.map((t) => [t.tradingsymbol, t.productHint]));
    expect(hint).toEqual({ RELIANCE: "delivery", ITC: "delivery", INFY: "delivery", TCS: "intraday" });
  });
});
