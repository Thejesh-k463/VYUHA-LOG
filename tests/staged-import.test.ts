import { describe, expect, it } from "vitest";
import { parseAngelOne, parseUpstox } from "../lib/import/parsers/angelone-upstox";
import { parseZerodha } from "../lib/import/parsers/zerodha";
import { summarise, sortLegs, type Leg } from "../lib/domain/staged";
import type { NormalizedTrade } from "../lib/engine/types";

const ctx = (filename: string, text: string) => ({ filename, text, buffer: undefined });

// A scaled-in position: three buys at rising prices, then two partial sells.
const ANGEL_SCALED = `Angel One Limited
Trade Book Report,,,,
Symbol,Exchange,Product,Buy/Sell,Quantity,Price,Trade Date
RELIANCE,NSE,DELIVERY,BUY,10,2900,2026-06-02
RELIANCE,NSE,DELIVERY,BUY,10,2950,2026-06-03
RELIANCE,NSE,DELIVERY,BUY,10,3000,2026-06-04
RELIANCE,NSE,DELIVERY,SELL,15,3100,2026-06-10
RELIANCE,NSE,DELIVERY,SELL,15,3200,2026-06-11
TCS,NSE,INTRADAY,BUY,5,3800,2026-06-03
TCS,NSE,INTRADAY,SELL,5,3780,2026-06-03
`;

const ZERODHA_SCALED = `Tradebook
Symbol,ISIN,Exchange,Trade Type,Quantity,Price,Product,Trade Date
INFY,INE009A01021,NSE,buy,20,1500,CNC,2026-06-02
INFY,INE009A01021,NSE,buy,30,1520,CNC,2026-06-03
INFY,INE009A01021,NSE,sell,50,1600,CNC,2026-06-09
`;

const UPSTOX_PNL = `Upstox Securities
Realised P&L Statement,,,,,
Scrip Name,ISIN,Exchange,Buy Quantity,Buy Value,Sell Quantity,Sell Value,Realised P&L
INFY,INE009A01021,NSE,"20","30000","20","31500","1500"
`;

/** Mirrors commit.ts#stagedFromExecutions — a SIDE must be filled more than once. */
function isStaged(t: NormalizedTrade): boolean {
  const ex = t.executions ?? [];
  if (ex.length < 2) return false;
  const buys = ex.filter((e) => e.side === "buy").length;
  return buys > 1 || ex.length - buys > 1;
}

/** Mirrors commit.ts#orderExecutions. */
function toLegs(t: NormalizedTrade): Leg[] {
  const isShort = t.sellQty > 0 && t.buyQty === 0;
  const opening = isShort ? "sell" : "buy";
  const ordered = [...(t.executions ?? [])]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const da = a.e.date ?? "", db = b.e.date ?? "";
      if (da !== db) return da < db ? -1 : 1;
      const oa = a.e.side === opening ? 0 : 1, ob = b.e.side === opening ? 0 : 1;
      if (oa !== ob) return oa - ob;
      return a.i - b.i;
    })
    .map((x) => x.e);
  return ordered.map((ex, i) => ({
    id: i + 1,
    seq: i + 1,
    kind: (isShort ? ex.side === "sell" : ex.side === "buy") ? "entry" : "exit",
    tradeDate: ex.date ?? "",
    qty: ex.qty,
    price: ex.price,
  }));
}

describe("tradebook imports preserve the entry ladder", () => {
  it("keeps all five Angel One fills instead of one blended average", () => {
    const out = parseAngelOne(ctx("angelone-tradebook.csv", ANGEL_SCALED));
    const ril = out.trades.find((t) => t.tradingsymbol === "RELIANCE")!;
    expect(ril.executions).toHaveLength(5);
    expect(ril.executions!.filter((e) => e.side === "buy")).toHaveLength(3);
    expect(ril.executions!.map((e) => e.price)).toEqual([2900, 2950, 3000, 3100, 3200]);
    // The aggregate the rest of the app reads is unchanged.
    expect(ril.buyQty).toBe(30);
    expect(ril.avgBuyPrice).toBe(2950);
  });

  it("rebuilds a ladder whose totals match the aggregate exactly", () => {
    const out = parseAngelOne(ctx("angelone-tradebook.csv", ANGEL_SCALED));
    const ril = out.trades.find((t) => t.tradingsymbol === "RELIANCE")!;
    const pos = summarise(toLegs(ril), "long");

    expect(pos.entryCount).toBe(3);
    expect(pos.exitCount).toBe(2);
    expect(pos.totalEntryQty).toBe(ril.buyQty);
    expect(pos.totalExitQty).toBe(ril.sellQty);
    expect(pos.avgEntryPrice).toBe(ril.avgBuyPrice);
    // Ladder gross must equal the aggregate's gross.
    expect(pos.realisedGross).toBeCloseTo(ril.sellValue - ril.buyValue, 6);
    expect(pos.isClosed).toBe(true);
  });

  it("leaves an ordinary one-in-one-out trade unstaged", () => {
    const out = parseAngelOne(ctx("angelone-tradebook.csv", ANGEL_SCALED));
    const tcs = out.trades.find((t) => t.tradingsymbol === "TCS")!;
    expect(tcs.executions).toHaveLength(2); // one buy, one sell
    expect(isStaged(tcs)).toBe(false); // …but neither SIDE was scaled
  });

  it("stages the position that really was scaled", () => {
    const out = parseAngelOne(ctx("angelone-tradebook.csv", ANGEL_SCALED));
    const ril = out.trades.find((t) => t.tradingsymbol === "RELIANCE")!;
    expect(isStaged(ril)).toBe(true); // 3 buys, 2 sells
  });

  it("stages a scale-OUT even when the entry was a single fill", () => {
    const scaleOutOnly = `Angel One Limited
Trade Book Report,,,,
Symbol,Exchange,Product,Buy/Sell,Quantity,Price,Trade Date
HDFCBANK,NSE,DELIVERY,BUY,30,1600,2026-06-02
HDFCBANK,NSE,DELIVERY,SELL,15,1700,2026-06-05
HDFCBANK,NSE,DELIVERY,SELL,15,1750,2026-06-06
`;
    const out = parseAngelOne(ctx("angelone-tradebook.csv", scaleOutOnly));
    const h = out.trades[0];
    expect(isStaged(h)).toBe(true);
    const pos = summarise(toLegs(h), "long");
    expect(pos.entryCount).toBe(1);
    expect(pos.exitCount).toBe(2);
    expect(pos.fills[0].avgCostAtExit).toBe(1600);
  });

  it("preserves Zerodha's fills and blends them correctly", () => {
    const out = parseZerodha(ctx("tradebook-zerodha.csv", ZERODHA_SCALED));
    const infy = out.trades.find((t) => t.tradingsymbol === "INFY")!;
    expect(infy.executions).toHaveLength(3);
    const pos = summarise(toLegs(infy), "long");
    expect(pos.totalEntryQty).toBe(50);
    expect(pos.avgEntryPrice).toBe(1512); // (20*1500 + 30*1520) / 50
    expect(pos.realisedGross).toBeCloseTo(50 * 1600 - (20 * 1500 + 30 * 1520), 6);
  });

  it("does not stage a pre-aggregated P&L report — it has no fills to preserve", () => {
    const out = parseUpstox(ctx("upstox-pnl.csv", UPSTOX_PNL));
    const infy = out.trades.find((t) => t.tradingsymbol === "INFY")!;
    expect(infy.executions ?? null).toBeNull();
    expect(isStaged(infy)).toBe(false);
  });

  it("orders fills so an exit never precedes the entry it closes", () => {
    // Same-day scale-out listed BEFORE the entries in the file.
    const jumbled = `Angel One Limited
Trade Book Report,,,,
Symbol,Exchange,Product,Buy/Sell,Quantity,Price,Trade Date
WIPRO,NSE,INTRADAY,SELL,10,260,2026-06-02
WIPRO,NSE,INTRADAY,BUY,10,250,2026-06-02
`;
    const out = parseAngelOne(ctx("angelone-tradebook.csv", jumbled));
    const w = out.trades[0];
    const legs = sortLegs(toLegs(w));
    expect(legs[0].kind).toBe("entry");
    expect(legs[1].kind).toBe("exit");
    const pos = summarise(legs, "long");
    expect(pos.realisedGross).toBe(100); // (260-250)*10, not a negative
  });
});
