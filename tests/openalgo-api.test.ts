import { describe, expect, it } from "vitest";
import { BROKERS } from "../lib/domain/constants";
import {
  assertOpenAlgoBroker,
  canonicalOpenAlgoSymbol,
  isOpenAlgoConnectionId,
  normalizeHost,
  normalizeOpenAlgoTrades,
  openAlgoBrokerOptions,
  openAlgoConnectionId,
  openAlgoUnderlyingOf,
  OPENALGO_BROKERS,
  recoverQuantity,
  toParsedFile,
  underlyingExchangeConflict,
  type OpenAlgoTradeRow,
} from "../lib/import/api/openalgo";
import { classify } from "../lib/engine/classify";

const DATE = "2026-08-20";

const row = (over: Partial<OpenAlgoTradeRow>): OpenAlgoTradeRow => ({
  action: "BUY",
  symbol: "RELIANCE",
  exchange: "NSE",
  orderid: "250408000989443",
  product: "MIS",
  quantity: 10,
  average_price: 1180.1,
  timestamp: "13:58:03",
  trade_value: 11801,
  ...over,
});

describe("the broker table covers all eight of Vyuha's brokers", () => {
  // The table is the adapter's contract with the charges engine. A broker
  // MISSING from it would fall through assertOpenAlgoBroker's "not a broker
  // Vyuha knows" branch and read as a typo rather than as an unmade decision.
  it("names every broker in BROKERS, exactly once", () => {
    const named = OPENALGO_BROKERS.map((b) => b.broker).sort();
    expect(named).toEqual([...BROKERS].sort());
    expect(new Set(named).size).toBe(named.length);
  });

  it("offers seven brokers and refuses the one OpenAlgo has no plugin for", () => {
    const options = openAlgoBrokerOptions();
    expect(options).toHaveLength(7);
    expect(options.map((b) => b.broker)).not.toContain("sahi");
  });

  it("every unsupported entry says WHY, so the UI never shows a bare refusal", () => {
    for (const entry of OPENALGO_BROKERS.filter((b) => !b.supported)) {
      expect(entry.note, `${entry.broker} has no note`).toBeTruthy();
    }
  });

  it("accepts each supported broker and rejects the unsupported one by name", () => {
    for (const entry of openAlgoBrokerOptions()) {
      expect(() => assertOpenAlgoBroker(entry.broker)).not.toThrow();
    }
    expect(() => assertOpenAlgoBroker("sahi")).toThrow(/no Sahi plugin/i);
  });
});

describe("recoverQuantity", () => {
  it("uses the stated quantity when it is positive", () => {
    expect(recoverQuantity(row({ quantity: 7 }))).toEqual({ qty: 7, repaired: false });
  });

  // OpenAlgo's own documented sample response ships quantity 0.0 on a filled
  // trade. Importing that as a zero-size trade would produce zero charges and
  // zero P&L and pass every reconciliation, which is why this case is coded.
  it("recovers size from trade_value ÷ average_price when quantity is 0", () => {
    const got = recoverQuantity(row({ quantity: 0, average_price: 1180.1, trade_value: 1180.1 }));
    expect(got).toEqual({ qty: 1, repaired: true });
  });

  it("snaps a float-division near-miss to the integer lot", () => {
    // 3 × 83.74 = 251.22; 251.22 / 83.74 is 2.9999999999999996 in float.
    const got = recoverQuantity(row({ quantity: 0, average_price: 83.74, trade_value: 251.22 }));
    expect(got?.qty).toBe(3);
    expect(got?.repaired).toBe(true);
  });

  it("refuses rather than guesses when nothing is recoverable", () => {
    expect(recoverQuantity(row({ quantity: 0, trade_value: 0 }))).toBeNull();
    expect(recoverQuantity(row({ quantity: 0, average_price: 0, trade_value: 500 }))).toBeNull();
  });
});

describe("normalizeOpenAlgoTrades", () => {
  it("aggregates executions per symbol+product into one round trip", () => {
    const { trades } = normalizeOpenAlgoTrades(
      [
        row({ quantity: 10, average_price: 600 }),
        row({ quantity: 5, average_price: 610 }),
        row({ action: "SELL", quantity: 15, average_price: 620, timestamp: "14:30:00" }),
      ],
      "zerodha",
      DATE,
    );
    expect(trades).toHaveLength(1);
    const t = trades[0]!;
    expect(t.buyQty).toBe(15);
    expect(t.sellQty).toBe(15);
    expect(t.avgBuyPrice).toBeCloseTo((10 * 600 + 5 * 610) / 15, 2);
    expect(t.avgSellPrice).toBe(620);
    expect(t.grossPnl).toBeCloseTo((620 - (10 * 600 + 5 * 610) / 15) * 15, 2);
    expect(t.broker).toBe("zerodha");
    expect(t.sourceFile).toBe("openalgo-api");
  });

  it("stamps whichever broker it was given — the same payload, seven ways", () => {
    for (const entry of openAlgoBrokerOptions()) {
      const { trades } = normalizeOpenAlgoTrades([row({})], entry.broker, DATE);
      expect(trades[0]!.broker).toBe(entry.broker);
    }
  });

  it("keeps the same symbol under two products apart", () => {
    const { trades } = normalizeOpenAlgoTrades(
      [row({ product: "MIS" }), row({ product: "CNC" })],
      "dhan",
      DATE,
    );
    expect(trades).toHaveLength(2);
    expect(trades.map((t) => t.productHint).sort()).toEqual(["delivery", "intraday"]);
  });

  it("maps products, including MTF, and derivative exchanges to their parent", () => {
    const { trades } = normalizeOpenAlgoTrades(
      [
        row({ product: "MTF", symbol: "A" }),
        row({ product: "NRML", symbol: "B", exchange: "NFO" }),
        row({ product: "CNC", symbol: "C", exchange: "BSE" }),
        row({ product: "NRML", symbol: "D", exchange: "MCX" }),
      ],
      "zerodha",
      DATE,
    );
    const by = Object.fromEntries(trades.map((t) => [t.tradingsymbol, t]));
    expect(by.A!.productHint).toBe("mtf");
    expect(by.B!.productHint).toBeNull(); // NRML — the classifier decides
    expect(by.B!.exchangeHint).toBe("NSE");
    expect(by.C!.exchangeHint).toBe("BSE");
    expect(by.D!.exchangeHint).toBe("MCX");
  });

  it("stamps the caller's date on both legs and reads HH:MM off the time-only stamp", () => {
    const { trades } = normalizeOpenAlgoTrades(
      [
        row({ timestamp: "09:20:11" }),
        row({ timestamp: "10:05:00" }),
        row({ action: "SELL", timestamp: "15:11:59" }),
      ],
      "upstox",
      DATE,
    );
    const t = trades[0]!;
    expect(t.buyDate).toBe(DATE);
    expect(t.sellDate).toBe(DATE);
    expect(t.entryTime).toBe("09:20"); // earliest buy
    expect(t.exitTime).toBe("15:11"); // latest sell
  });

  it("leaves the unopened leg's date null rather than inventing one", () => {
    const { trades } = normalizeOpenAlgoTrades([row({ action: "BUY" })], "groww", DATE);
    expect(trades[0]!.buyDate).toBe(DATE);
    expect(trades[0]!.sellDate).toBeNull();
    expect(trades[0]!.exitTime).toBeNull();
  });

  it("counts repairs and refusals instead of hiding them", () => {
    const { trades, repaired, refused } = normalizeOpenAlgoTrades(
      [
        row({ symbol: "OK", quantity: 4 }),
        row({ symbol: "FIXED", quantity: 0, average_price: 100, trade_value: 500 }),
        row({ symbol: "GONE", quantity: 0, average_price: 0, trade_value: 0 }),
        row({ symbol: "", quantity: 1 }),
      ],
      "paytm",
      DATE,
    );
    expect(trades).toHaveLength(2);
    expect(repaired).toBe(1);
    expect(refused).toBe(2);
  });

  it("survives an empty or malformed payload", () => {
    expect(normalizeOpenAlgoTrades([], "zerodha", DATE).trades).toEqual([]);
    expect(
      normalizeOpenAlgoTrades(undefined as unknown as OpenAlgoTradeRow[], "zerodha", DATE).trades,
    ).toEqual([]);
  });
});

describe("toParsedFile", () => {
  it("says so when today had no executions", () => {
    const p = toParsedFile("zerodha", { trades: [], repaired: 0, refused: 0, notes: [] });
    expect(p.warnings.join(" ")).toMatch(/current trading day/i);
  });

  it("surfaces repairs and refusals as warnings the user must read", () => {
    const p = toParsedFile("dhan", {
      trades: normalizeOpenAlgoTrades([row({})], "dhan", DATE).trades,
      repaired: 3,
      refused: 1,
      notes: [],
    });
    expect(p.warnings.some((w) => /quantity 0/i.test(w))).toBe(true);
    expect(p.warnings.some((w) => /skipped/i.test(w))).toBe(true);
    expect(p.broker).toBe("dhan");
    expect(p.format).toBe("api");
  });
});

// Symbols in this block are from a REAL Dhan-backed OpenAlgo tradebook
// (206 executions, 2026-08-26) — the first live pull through this adapter.
// It found the same defect the Dhan API adapter had: compact F&O symbols fell
// through parseInstrumentName to the equity branch and were charged equity STT.
describe("canonicalOpenAlgoSymbol — F&O names from the stated exchange + compact symbol", () => {
  it("parses the real payload's option symbols", () => {
    expect(canonicalOpenAlgoSymbol("SENSEX27AUG2677400PE", "BFO")).toBe("OPT SENSEX 27 Aug 2026 77400 PE");
    expect(canonicalOpenAlgoSymbol("BANKINDIA29SEP26155CE", "NFO")).toBe("OPT BANKINDIA 29 Sep 2026 155 CE");
    expect(canonicalOpenAlgoSymbol("EICHERMOT29SEP268500CE", "NFO")).toBe("OPT EICHERMOT 29 Sep 2026 8500 CE");
    expect(canonicalOpenAlgoSymbol("VBL29SEP26390PE", "NFO")).toBe("OPT VBL 29 Sep 2026 390 PE");
  });

  it("parses futures", () => {
    expect(canonicalOpenAlgoSymbol("NIFTY29SEP26FUT", "NFO")).toBe("FUT NIFTY 29 Sep 2026");
    expect(canonicalOpenAlgoSymbol("GOLDM05DEC26FUT", "MCX")).toBe("FUT GOLDM 05 Dec 2026");
  });

  it("returns null off the derivative exchanges — an equity symbol is never reshaped", () => {
    expect(canonicalOpenAlgoSymbol("GAJA", "NSE")).toBeNull();
    expect(canonicalOpenAlgoSymbol("RELIANCE", "BSE")).toBeNull();
  });

  it("returns null rather than guessing at an unparseable derivative symbol", () => {
    expect(canonicalOpenAlgoSymbol("MYSTERY-THING", "NFO")).toBeNull();
    expect(canonicalOpenAlgoSymbol("SENSEX27XXX2677400PE", "BFO")).toBeNull();
  });

  it("the canonical name classifies as an option with the right exchange", () => {
    const name = canonicalOpenAlgoSymbol("SENSEX27AUG2678200CE", "BFO")!;
    const cls = classify({ tradingsymbol: name, exchangeHint: "BSE", productHint: null });
    expect(cls.instrumentType).toBe("option");
    expect(cls.segment).toBe("index_option");
    expect(cls.expiry).toBe("2026-08-27");
    expect(cls.strike).toBe(78200);
    expect(cls.optionType).toBe("CE");
  });
});

describe("underlyingExchangeConflict — the SILVERM defence", () => {
  // A real instance relabelled a PIIND 2600 CE as SILVERM23NOV26236750PE on
  // NFO (2026-08-26): right numbers, wrong identity. Silver does not trade on
  // NFO, so the corruption is detectable — and must be SAID, not absorbed.
  it("flags a commodity underlying on an equity-derivatives exchange", () => {
    expect(underlyingExchangeConflict("SILVERM", "NFO")).toMatch(/commodity underlying/i);
    expect(underlyingExchangeConflict("GOLD", "BFO")).toMatch(/commodity underlying/i);
  });

  it("flags an index underlying on MCX", () => {
    expect(underlyingExchangeConflict("SENSEX", "MCX")).toMatch(/index underlying/i);
    expect(underlyingExchangeConflict("NIFTY", "MCX")).toMatch(/index underlying/i);
  });

  it("stays silent for coherent pairs", () => {
    expect(underlyingExchangeConflict("PIIND", "NFO")).toBeNull();
    expect(underlyingExchangeConflict("SENSEX", "BFO")).toBeNull();
    expect(underlyingExchangeConflict("SILVERM", "MCX")).toBeNull();
  });
});

describe("normalizeOpenAlgoTrades — derivatives (the 2026-08-26 live pull, end to end)", () => {
  const TODAY = "2026-08-26";

  it("emits the canonical option name and reads times off the Dhan plugin's datetimes", () => {
    const { trades, notes } = normalizeOpenAlgoTrades(
      [
        row({ symbol: "SENSEX27AUG2678200CE", exchange: "BFO", product: "MIS",
          quantity: 7040, average_price: 62.01, trade_value: 436567, timestamp: "2026-08-26 10:12:07" }),
        row({ symbol: "SENSEX27AUG2678200CE", exchange: "BFO", product: "MIS", action: "SELL",
          quantity: 7040, average_price: 61.39, trade_value: 432207, timestamp: "2026-08-26 15:29:59" }),
      ],
      "dhan",
      TODAY,
    );
    expect(trades).toHaveLength(1);
    expect(trades[0]!.tradingsymbol).toBe("OPT SENSEX 27 Aug 2026 78200 CE");
    expect(trades[0]!.exchangeHint).toBe("BSE");
    expect(trades[0]!.entryTime).toBe("10:12");
    expect(trades[0]!.exitTime).toBe("15:29");
    expect(notes).toEqual([]);
  });

  it("REFUSES a suspect symbol and says so — a corrupt identity cannot be charged honestly", () => {
    // The real mislabelled row would classify commodity_option/NSE, a pair no
    // charge_config row can exist for — the engine throws on it by design. So
    // the row never reaches the pipeline: refused here, with the reason.
    const result = normalizeOpenAlgoTrades(
      [row({ symbol: "SILVERM23NOV26236750PE", exchange: "NFO", product: "NRML",
        quantity: 175, average_price: 41.2, trade_value: 7210 })],
      "dhan",
      TODAY,
    );
    expect(result.trades).toHaveLength(0);
    expect(result.notes.join(" ")).toMatch(/REFUSED — suspect symbol/);
    expect(result.notes.join(" ")).toMatch(/commodity underlying but arrived on NFO/i);
    const p = toParsedFile("dhan", result);
    expect(p.warnings.join(" ")).toMatch(/REFUSED — suspect symbol/);
    expect(p.warnings.join(" ")).toMatch(/broker's own API or file/i);
  });

  it("keeps the raw name and says so when a derivative-exchange symbol will not parse", () => {
    const { trades, notes } = normalizeOpenAlgoTrades(
      [row({ symbol: "MYSTERY-THING", exchange: "NFO", product: "NRML" })],
      "dhan",
      TODAY,
    );
    expect(trades[0]!.tradingsymbol).toBe("MYSTERY-THING");
    expect(notes.join(" ")).toMatch(/does not parse as an option or future/i);
  });
});

describe("openalgo connection ids — one row per instance", () => {
  // One OpenAlgo instance fronts ONE broker login, so a user with several
  // broker accounts runs several instances (verified live 2026-08-26: Upstox
  // on :5000 and Dhan on :5051 on one machine). The connection identity is
  // `openalgo:<underlying>`; the legacy bare `openalgo` is still recognised.
  it("builds and parses the id", () => {
    expect(openAlgoConnectionId("dhan")).toBe("openalgo:dhan");
    expect(openAlgoUnderlyingOf("openalgo:dhan")).toBe("dhan");
    expect(openAlgoUnderlyingOf("openalgo:upstox")).toBe("upstox");
  });

  it("recognises both forms, and nothing else", () => {
    expect(isOpenAlgoConnectionId("openalgo")).toBe(true); // legacy single-instance id
    expect(isOpenAlgoConnectionId("openalgo:dhan")).toBe(true);
    expect(isOpenAlgoConnectionId("dhan")).toBe(false);
    expect(isOpenAlgoConnectionId("zerodha")).toBe(false);
    expect(isOpenAlgoConnectionId("openalgofoo")).toBe(false);
  });

  it("the legacy id has no parseable underlying — that lives in its auth blob", () => {
    expect(openAlgoUnderlyingOf("openalgo")).toBeNull();
    expect(openAlgoUnderlyingOf("openalgo:")).toBeNull();
  });
});

describe("normalizeHost", () => {
  it("accepts the usual shapes and strips paths", () => {
    expect(normalizeHost("http://127.0.0.1:5000")).toBe("http://127.0.0.1:5000");
    expect(normalizeHost("127.0.0.1:5000")).toBe("http://127.0.0.1:5000");
    expect(normalizeHost("http://127.0.0.1:5000/api/v1/")).toBe("http://127.0.0.1:5000");
    expect(normalizeHost("https://openalgo.mydomain.in")).toBe("https://openalgo.mydomain.in");
  });

  it("refuses an empty or unparseable host", () => {
    expect(() => normalizeHost("")).toThrow(/required/i);
    expect(() => normalizeHost("   ")).toThrow(/required/i);
  });
});
