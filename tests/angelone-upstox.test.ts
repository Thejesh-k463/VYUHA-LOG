import { describe, expect, it } from "vitest";
import {
  detectAngelOne,
  parseAngelOne,
  detectUpstox,
  parseUpstox,
} from "../lib/import/parsers/angelone-upstox";
import { detectParser, buildContext } from "../lib/import/detect";

const ctx = (filename: string, text: string) => ({ filename, text, buffer: undefined });

// Angel One tradebook — banner rows above the header, "Buy/Sell" side column.
const ANGEL_TRADEBOOK = `Angel One Limited
Trade Book Report,,,,
Client Code,A12345,,,
Symbol,Exchange,Product,Buy/Sell,Quantity,Price,Trade Date
RELIANCE,NSE,DELIVERY,BUY,10,2900,2026-06-02
RELIANCE,NSE,DELIVERY,SELL,10,2950,2026-06-10
TCS,NSE,INTRADAY,BUY,5,3800,2026-06-03
TCS,NSE,INTRADAY,SELL,5,3780,2026-06-03
`;

// Upstox P&L report — aggregated per scrip, ₹ symbols and commas in numbers.
const UPSTOX_PNL = `Upstox Securities
Realised P&L Statement,,,,,
Scrip Name,ISIN,Exchange,Buy Quantity,Buy Value,Sell Quantity,Sell Value,Realised P&L
INFY,INE009A01021,NSE,"20","₹30,000","20","₹31,500","₹1,500"
WIPRO,INE075A01022,NSE,"50","₹25,000","50","₹24,000","-₹1,000"
`;

describe("Angel One parser", () => {
  it("detects its own tradebook and ignores foreign files", () => {
    expect(detectAngelOne(ctx("angelone-tradebook.csv", ANGEL_TRADEBOOK))).toBeGreaterThan(0.5);
    expect(detectAngelOne(ctx("random.csv", "a,b,c\n1,2,3"))).toBe(0);
  });

  it("aggregates executions into round-trips with product hints", () => {
    const out = parseAngelOne(ctx("angelone-tradebook.csv", ANGEL_TRADEBOOK));
    expect(out.broker).toBe("angelone");
    expect(out.format).toBe("tradebook");
    expect(out.trades).toHaveLength(2);

    const ril = out.trades.find((t) => t.tradingsymbol === "RELIANCE")!;
    expect(ril.buyQty).toBe(10);
    expect(ril.avgBuyPrice).toBe(2900);
    expect(ril.sellQty).toBe(10);
    expect(ril.avgSellPrice).toBe(2950);
    expect(ril.grossPnl).toBe(500); // (2950-2900) × 10
    expect(ril.productHint).toBe("delivery");
    expect(ril.exchangeHint).toBe("NSE");
    expect(ril.buyDate).toBe("2026-06-02");
    expect(ril.sellDate).toBe("2026-06-10");

    const tcs = out.trades.find((t) => t.tradingsymbol === "TCS")!;
    expect(tcs.productHint).toBe("intraday");
    expect(tcs.grossPnl).toBe(-100);
  });

  it("splits the same symbol across different products", () => {
    const mixed = `Symbol,Product,Buy/Sell,Quantity,Price
RELIANCE,DELIVERY,BUY,10,2900
RELIANCE,INTRADAY,BUY,5,2910
`;
    const out = parseAngelOne(ctx("angelone.csv", mixed));
    expect(out.trades).toHaveLength(2);
    expect(out.trades.map((t) => t.productHint).sort()).toEqual(["delivery", "intraday"]);
  });
});

describe("Upstox parser", () => {
  it("detects its own P&L report", () => {
    expect(detectUpstox(ctx("upstox-pnl.csv", UPSTOX_PNL))).toBeGreaterThan(0.5);
  });

  it("reads aggregated rows, stripping ₹ and commas", () => {
    const out = parseUpstox(ctx("upstox-pnl.csv", UPSTOX_PNL));
    expect(out.broker).toBe("upstox");
    expect(out.format).toBe("pnl-report");
    expect(out.trades).toHaveLength(2);

    const infy = out.trades.find((t) => t.tradingsymbol === "INFY")!;
    expect(infy.buyQty).toBe(20);
    expect(infy.buyValue).toBe(30000);
    expect(infy.sellValue).toBe(31500);
    expect(infy.grossPnl).toBe(1500);
    expect(infy.avgBuyPrice).toBe(1500); // derived: 30000/20
    expect(infy.isin).toBe("INE009A01021");

    const wipro = out.trades.find((t) => t.tradingsymbol === "WIPRO")!;
    expect(wipro.grossPnl).toBe(-1000);
  });

  it("returns a clear warning when no header is recognizable", () => {
    const out = parseUpstox(ctx("upstox.csv", "just,some\nrandom,data"));
    expect(out.trades).toHaveLength(0);
    expect(out.warnings[0]).toMatch(/header/i);
  });
});

describe("parser registry routing", () => {
  it("routes each broker's file to its own parser", () => {
    const angel = detectParser(buildContext("angelone-tradebook.csv", Buffer.from(ANGEL_TRADEBOOK)));
    expect(angel?.sourceId).toBe("angelone");
    const upstox = detectParser(buildContext("upstox-pnl.csv", Buffer.from(UPSTOX_PNL)));
    expect(upstox?.sourceId).toBe("upstox");
  });
});
