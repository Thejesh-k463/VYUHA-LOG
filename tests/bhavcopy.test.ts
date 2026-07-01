import { describe, it, expect } from "vitest";
import { parseBhavcopy } from "@/lib/import/bhavcopy";

describe("parseBhavcopy — NSE cash bhavcopy", () => {
  const csv = [
    "SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TIMESTAMP,ISIN",
    "RELIANCE,EQ,2900,2950,2890,2940.50,2940,2895,1000,28-JUN-2026,INE002A01018",
    "RELIANCE,BE,2900,2950,2890,2999.00,2999,2895,10,28-JUN-2026,INE002A01018",
    "TCS,EQ,3800,3820,3780,3805.25,3805,3795,500,28-JUN-2026,INE467B01029",
    "INFY,EQ,1500,1520,1495,1512.00,1512,1498,800,28-JUN-2026,INE009A01021",
  ].join("\n");
  const r = parseBhavcopy(csv);

  it("detects format and trade date", () => {
    expect(r.format).toBe("nse-eq");
    expect(r.date).toBe("2026-06-28");
    expect(r.count).toBe(3);
  });

  it("prefers the EQ series close when a symbol repeats", () => {
    expect(r.prices.RELIANCE).toBe(2940.5); // EQ, not the BE 2999
    expect(r.prices.TCS).toBe(3805.25);
    expect(r.prices.INFY).toBe(1512);
  });

  it("captures OHLC + volume bars for price_history", () => {
    expect(r.bars.RELIANCE).toEqual({ open: 2900, high: 2950, low: 2890, close: 2940.5, volume: 1000 });
    expect(r.bars.TCS.close).toBe(3805.25);
  });
});

describe("parseBhavcopy — NSE UDiFF full bhavcopy (skips derivatives)", () => {
  const csv = [
    "TradDt,Sgmt,FinInstrmTp,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric",
    "2026-06-28,CM,STK,RELIANCE,EQ,2900,2950,2890,2941.00",
    "2026-06-28,FO,OPTSTK,RELIANCE,XX,10,12,8,9.50",
    "2026-06-28,FO,FUTSTK,RELIANCE,XX,2940,2960,2930,2945.00",
    "2026-06-28,CM,IDX,NIFTY 50,XX,24000,24200,23950,24180.75",
  ].join("\n");
  const r = parseBhavcopy(csv);

  it("uses the cash close and ignores option/future rows", () => {
    expect(r.format).toBe("nse-udiff");
    expect(r.prices.RELIANCE).toBe(2941); // STK row, not the FUT/OPT rows
    expect(r.count).toBe(2); // RELIANCE + NIFTY 50
  });
});

describe("parseBhavcopy — BSE bhavcopy", () => {
  const csv = [
    "SC_CODE,SC_NAME,OPEN,HIGH,LOW,CLOSE,LAST",
    "500325,RELIANCE,2900,2950,2890,2942.10,2942",
    "532540,TCS,3800,3820,3780,3806.00,3806",
  ].join("\n");
  const r = parseBhavcopy(csv);
  it("reads SC_NAME → CLOSE", () => {
    expect(r.format).toBe("bse");
    expect(r.prices.RELIANCE).toBe(2942.1);
    expect(r.prices.TCS).toBe(3806);
  });
});

describe("parseBhavcopy — edge cases", () => {
  it("empty input", () => {
    expect(parseBhavcopy("").count).toBe(0);
  });
  it("unrecognised columns warn", () => {
    const r = parseBhavcopy("FOO,BAR\n1,2");
    expect(r.count).toBe(0);
    expect(r.warnings[0]).toMatch(/symbol\/close/i);
  });
});
