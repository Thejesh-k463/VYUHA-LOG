import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CALC_EQUITY_PRODUCTS,
  CALC_FNO_INSTRUMENTS,
  CALC_SNAPSHOT_KEY,
  parseCalcSnapshot,
  type CalcSnapshot,
} from "@/lib/domain/calc-snapshot";

const FULL: CalcSnapshot = {
  v: 1,
  mode: "fno",
  broker: "zerodha",
  plan: "default",
  equity: {
    side: "long", ticker: "RELIANCE", exchange: "NSE", entry: "2450", sl: "2390",
    target: "2600", numTrades: "2", riskBudget: "5000", desiredRR: "2",
    product: "eq_mtf", shares: "40", ownCapital: "30000", holdDays: "12",
  },
  fno: {
    side: "short", ticker: "SENSEX", exchange: "BSE", entry: "110", sl: "160",
    target: "40", numTrades: "1", riskBudget: "", desiredRR: "3",
    instrument: "index_option", lots: "2", lotSize: "20", optionType: "PE",
    strike: "81000", spot: "80750",
  },
};

describe("parseCalcSnapshot", () => {
  it("round-trips a full snapshot", () => {
    expect(parseCalcSnapshot(JSON.stringify(FULL))).toEqual(FULL);
  });

  it("survives corrupt storage — defaults, never a crash", () => {
    for (const junk of [null, "", "{", "not json", "[]", "42", JSON.stringify({ v: 1 })]) {
      expect(parseCalcSnapshot(junk), String(junk)).not.toBeUndefined();
    }
    expect(parseCalcSnapshot("{")).toBeNull();
    expect(parseCalcSnapshot("[]")).toBeNull();
    // {v:1} alone is USABLE — empty branches, everything defaulted.
    const bare = parseCalcSnapshot(JSON.stringify({ v: 1 }));
    expect(bare).not.toBeNull();
    expect(bare!.equity).toEqual({});
    expect(bare!.fno).toEqual({});
  });

  it("rejects a future or missing version rather than mis-reading it", () => {
    expect(parseCalcSnapshot(JSON.stringify({ v: 2, mode: "fno" }))).toBeNull();
    expect(parseCalcSnapshot(JSON.stringify({ mode: "fno" }))).toBeNull();
  });

  it("drops a bad enum value so the component default holds — the field, not the snapshot", () => {
    const tampered = JSON.parse(JSON.stringify(FULL));
    tampered.mode = "crypto";
    tampered.broker = "robinhood";
    tampered.fno.exchange = "NYSE";
    tampered.fno.optionType = "STRADDLE";
    tampered.fno.instrument = "weather_future";
    tampered.equity.product = "eq_leveraged";
    const out = parseCalcSnapshot(JSON.stringify(tampered))!;
    expect(out).not.toBeNull();
    expect(out.mode).toBeUndefined();
    expect(out.broker).toBeUndefined();
    expect(out.fno.exchange).toBeUndefined();
    expect(out.fno.optionType).toBeUndefined();
    expect(out.fno.instrument).toBeUndefined();
    expect(out.equity.product).toBeUndefined();
    // Untouched siblings survive.
    expect(out.fno.strike).toBe("81000");
    expect(out.equity.shares).toBe("40");
  });

  it("never coerces a non-string into a text field", () => {
    const tampered = JSON.parse(JSON.stringify(FULL));
    tampered.equity.entry = 2450; // a number, not a string
    tampered.fno.lots = { evil: true };
    const out = parseCalcSnapshot(JSON.stringify(tampered))!;
    expect(out.equity.entry).toBeUndefined();
    expect(out.fno.lots).toBeUndefined();
  });

  it("keeps an EMPTY string — clearing the ticker is a real preference", () => {
    const out = parseCalcSnapshot(JSON.stringify({ v: 1, equity: { ticker: "" }, fno: {} }))!;
    expect(out.equity.ticker).toBe("");
  });
});

describe("the snapshot vocabulary cannot drift from the calculator's dropdowns", () => {
  // The component defines its own labelled arrays; the parser clamps against
  // these mirrors. If someone adds a product/instrument to one side only, the
  // stored value would silently drop on reload — this is what notices.
  const src = readFileSync(
    path.join(process.cwd(), "components/calculator/trade-calculator.tsx"),
    "utf8",
  );
  const valuesIn = (arrayName: string): string[] => {
    const start = src.indexOf(`const ${arrayName} = [`);
    expect(start, `${arrayName} not found in component`).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("];", start));
    return [...block.matchAll(/v:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  };

  it("equity products match", () => {
    expect(valuesIn("EQUITY_PRODUCTS").sort()).toEqual([...CALC_EQUITY_PRODUCTS].sort());
  });
  it("F&O instruments match", () => {
    expect(valuesIn("FNO_INSTRUMENTS").sort()).toEqual([...CALC_FNO_INSTRUMENTS].sort());
  });
  it("the component reads and writes the same key this module names", () => {
    expect(CALC_SNAPSHOT_KEY).toBe("vyuha-calc");
    expect(src).toContain("CALC_SNAPSHOT_KEY");
  });
});
