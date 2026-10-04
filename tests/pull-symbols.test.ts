import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildContext, rankParsers } from "@/lib/import/detect";
import type { ParsedFile } from "@/lib/import/types";
import { classify } from "@/lib/engine/classify";
import { canonicalOpenAlgoSymbol } from "@/lib/import/api/openalgo";
import { bundledSymbolByIsin } from "@/lib/import/isin-symbol";
import {
  contractKeyOf,
  fyersTradingsymbol,
  fyersUnpricedRow,
  kotakTradingsymbol,
  kotakUnpricedSegment,
  nuvamaTradingsymbol,
  nuvamaUnpricedRow,
  sameContractDay,
  stripSeriesSuffix,
  unpricedRefusalNote,
} from "@/lib/import/pull-symbols";

/**
 * v4.7.0 wave C6 (builder B1) — the tradingsymbol each NATIVE pull stores
 * (design D6, review R1/R3/R12). Each builder is pinned against the string the
 * OTHER source of that broker already stores, from that source's own code:
 *   Fyers  ↔ the Fyers tradebook parser over the redacted real export;
 *   Kotak  ↔ `canonicalOpenAlgoSymbol` (OpenAlgo-Kotak), through `classify`;
 *   Nuvama ↔ the Nuvama P&L-report parser over the redacted real workbook,
 *            byte for byte, for EVERY derivative contract it holds.
 * And each refuses (null) what it cannot name from stated fields.
 */

const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");
const parse = (file: string): ParsedFile => {
  const ctx = buildContext(file, fs.readFileSync(path.join(DIR, file)));
  return rankParsers(ctx)[0]!.parse(ctx) as ParsedFile;
};

describe("stripSeriesSuffix", () => {
  it("drops the five equity series and nothing else", () => {
    expect(["SBIN-EQ", "sbin-be", " X-BZ ", "Y-SM", "Z-ST"].map(stripSeriesSuffix)).toEqual(["SBIN", "SBIN", "X", "Y", "Z"]);
    expect(stripSeriesSuffix("BAJAJ-AUTO")).toBe("BAJAJ-AUTO");
    expect(stripSeriesSuffix("M&M")).toBe("M&M");
    expect(stripSeriesSuffix("NIFTY26SEPFUT")).toBe("NIFTY26SEPFUT");
  });
});

describe("fyersTradingsymbol", () => {
  let fileSymbols: string[];
  beforeAll(() => {
    fileSymbols = [...new Set(parse("fyers-tradebook-2026-07-25_2026-08-25.csv").trades.map((t) => t.tradingsymbol))];
  });

  it("a derivative keeps the Fyers FILE's compact form byte for byte — every contract of the real export", () => {
    expect(fileSymbols.length).toBeGreaterThan(5);
    expect(fileSymbols).toContain("CDSL26SEP1400CE");
    for (const s of fileSymbols) expect(fyersTradingsymbol(`NSE:${s}`), s).toEqual({ tradingsymbol: s, series: null });
  });

  it("the documented forms: monthly, weekly (NSE + BSE), future; prefix and case", () => {
    expect(fyersTradingsymbol("NSE:NIFTY24NOV22500CE")).toEqual({ tradingsymbol: "NIFTY24NOV22500CE", series: null });
    expect(fyersTradingsymbol("NSE:NIFTY20O0811000CE")).toEqual({ tradingsymbol: "NIFTY20O0811000CE", series: null });
    expect(fyersTradingsymbol("BSE:SENSEX2681377500PE")).toEqual({ tradingsymbol: "SENSEX2681377500PE", series: null });
    expect(fyersTradingsymbol("NSE:NIFTY26SEPFUT")).toEqual({ tradingsymbol: "NIFTY26SEPFUT", series: null });
    expect(fyersTradingsymbol("MCX:CRUDEOIL26OCTFUT")).toEqual({ tradingsymbol: "CRUDEOIL26OCTFUT", series: null });
    expect(fyersTradingsymbol("nse:cdsl26sep1400ce")).toEqual({ tradingsymbol: "CDSL26SEP1400CE", series: null });
    // and the classifier reads each as the file's row does
    expect(classify({ tradingsymbol: fyersTradingsymbol("NSE:NIFTY20O0811000CE")!.tradingsymbol })).toEqual(
      classify({ tradingsymbol: "NIFTY20O0811000CE" }),
    );
  });

  it("equity: the series is stripped to the bare ticker and RETURNED (R3)", () => {
    expect(fyersTradingsymbol("NSE:SBIN-EQ")).toEqual({ tradingsymbol: "SBIN", series: "EQ" });
    expect(fyersTradingsymbol("NSE:IDEA-BE")).toEqual({ tradingsymbol: "IDEA", series: "BE" });
    expect(fyersTradingsymbol("NSE:M&M-EQ")).toEqual({ tradingsymbol: "M&M", series: "EQ" });
    expect(fyersTradingsymbol("NSE:BAJAJ-AUTO-EQ")).toEqual({ tradingsymbol: "BAJAJ-AUTO", series: "EQ" });
    expect(classify({ tradingsymbol: fyersTradingsymbol("NSE:SBIN-EQ")!.tradingsymbol }).symbol).toBe("SBIN");
  });

  it("refuses empty and garbage", () => {
    for (const bad of ["", "   ", "NSE:", "-EQ", "NSE:-EQ", "XYZ:SBIN-EQ", "NSE:SB IN", "NSE:SBIN;DROP"]) {
      expect(fyersTradingsymbol(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("kotakTradingsymbol", () => {
  it("cash: trdSym with the series suffix stripped (R3 extended — K-S2 `IDEA-EQ`)", () => {
    expect(kotakTradingsymbol({ trdSym: "IDEA-EQ", exSeg: "nse_cm" })).toBe("IDEA");
    expect(kotakTradingsymbol({ trdSym: "SBIN", exSeg: "bse_cm" })).toBe("SBIN");
    expect(kotakTradingsymbol({ trdSym: "", exSeg: "nse_cm" })).toBeNull();
  });

  it("the documented future (K-S1): `FUT TCS 28 Jul 2026` — equal to OpenAlgo-Kotak's name byte for byte", () => {
    const k = kotakTradingsymbol({ trdSym: "TCS26JULFUT", sym: "TCS", exSeg: "nse_fo", optTp: "XX", expDt: "28 Jul, 2026" });
    expect(k).toBe("FUT TCS 28 Jul 2026");
    expect(k).toBe(canonicalOpenAlgoSymbol("TCS28JUL26FUT", "NFO"));
    expect(classify({ tradingsymbol: k! })).toEqual(classify({ tradingsymbol: canonicalOpenAlgoSymbol("TCS28JUL26FUT", "NFO")! }));
  });

  it("ROUND TRIP: classify() of every Kotak-built option equals classify() of the OpenAlgo-Kotak string", () => {
    const cases: [Parameters<typeof kotakTradingsymbol>[0], string, string][] = [
      [{ trdSym: "CDSL26SEP1400CE", sym: "CDSL", exSeg: "nse_fo", optTp: "CE", expDt: "29 Sep, 2026", stkPrc: "1400.00" }, "CDSL29SEP261400CE", "NFO"],
      [{ trdSym: "NIFTY25O0723750PE", sym: "NIFTY", exSeg: "nse_fo", optTp: "PE", expDt: "07-Oct-2025", stkPrc: 23750 }, "NIFTY07OCT2523750PE", "NFO"],
      [{ trdSym: "SENSEX2681377500PE", sym: "SENSEX", exSeg: "bse_fo", optTp: "PE", expDt: "13 Aug 2026", stkPrc: "77500" }, "SENSEX13AUG2677500PE", "BFO"],
      [{ trdSym: "TATASTEEL26JUN187.5PE", sym: "TATASTEEL", exSeg: "nse_fo", optTp: "PE", expDt: "30 Jun, 2026", stkPrc: "187.5" }, "TATASTEEL30JUN26187.5PE", "NFO"],
      [{ trdSym: "CRUDEOIL26JUNFUT", sym: "CRUDEOIL", exSeg: "mcx_fo", optTp: "XX", expDt: "19 Jun, 2026", stkPrc: "0" }, "CRUDEOIL19JUN26FUT", "MCX"],
    ];
    for (const [row, oaSymbol, oaExchange] of cases) {
      const k = kotakTradingsymbol(row);
      const oa = canonicalOpenAlgoSymbol(oaSymbol, oaExchange);
      expect(oa, oaSymbol).not.toBeNull();
      expect(k, oaSymbol).toBe(oa); // byte-equal, so the exact hash meets too
      expect(classify({ tradingsymbol: k! })).toEqual(classify({ tradingsymbol: oa! }));
    }
  });

  it("no `sym`: the underlying comes from trdSym ONLY when its compact contract agrees with every stated field", () => {
    const base = { trdSym: "TCS26JULFUT", exSeg: "nse_fo", optTp: "XX", expDt: "28 Jul, 2026" };
    expect(kotakTradingsymbol(base)).toBe("FUT TCS 28 Jul 2026");
    expect(kotakTradingsymbol({ trdSym: "M&M26SEP3000CE", exSeg: "nse_fo", optTp: "CE", expDt: "29 Sep 2026", stkPrc: "3000" })).toBe(
      "OPT M&M 29 Sep 2026 3000 CE",
    );
    // a trdSym that is not a compact contract → nothing unambiguous to derive
    expect(kotakTradingsymbol({ ...base, trdSym: "TCS-FUT" })).toBeNull();
    // the trdSym's month disagrees with the stated expiry
    expect(kotakTradingsymbol({ ...base, expDt: "25 Aug, 2026" })).toBeNull();
  });

  it("a stated field that CONTRADICTS trdSym's own contract is refused, never reconciled", () => {
    const row = { trdSym: "CDSL26SEP1400CE", sym: "CDSL", exSeg: "nse_fo", optTp: "CE", expDt: "29 Sep, 2026", stkPrc: "1400" };
    expect(kotakTradingsymbol(row)).toBe("OPT CDSL 29 Sep 2026 1400 CE");
    expect(kotakTradingsymbol({ ...row, stkPrc: "1500" })).toBeNull(); // strike
    expect(kotakTradingsymbol({ ...row, optTp: "PE" })).toBeNull(); // type
    expect(kotakTradingsymbol({ ...row, sym: "TCS" })).toBeNull(); // underlying
    expect(kotakTradingsymbol({ ...row, optTp: "XX" })).toBeNull(); // kind
  });

  it("REFUSES what it cannot name from stated fields", () => {
    const row = { trdSym: "CDSL26SEP1400CE", sym: "CDSL", exSeg: "nse_fo", optTp: "CE", expDt: "29 Sep, 2026", stkPrc: "1400" };
    for (const [why, over] of [
      ["unparseable expiry", { expDt: "Sep 2026" }],
      ["no expiry", { expDt: null }],
      ["a day that does not exist", { expDt: "31 Sep, 2026" }],
      ["an ambiguous numeric date", { expDt: "29/09/2026" }],
      ["strike not a number", { stkPrc: "1,400" }],
      ["strike zero", { stkPrc: "0" }],
      ["strike absent", { stkPrc: null }],
      ["unknown option type", { optTp: "CA" }],
      ["a token for an underlying", { sym: "7053_NSE", trdSym: "UNREADABLE" }],
      ["currency segment (no OpenAlgo grammar)", { exSeg: "cde_fo" }],
      ["unknown segment", { exSeg: "nse_xx" }],
    ] as const) {
      expect(kotakTradingsymbol({ ...row, ...over }), why).toBeNull();
    }
  });
});

describe("nuvamaTradingsymbol", () => {
  let nuvama: ParsedFile;
  beforeAll(() => {
    nuvama = parse("nuvama-pnl-report-2026-07-01_2026-09-22.xlsx");
  });

  it("ROUND TRIP: every derivative contract of the real report, rebuilt from sym/opTyp/stkPrc/dpExpDt, is the report's string byte for byte", () => {
    const deriv = nuvama.trades.filter((t) => /-(OPT|FUT)-/.test(t.dedupLabel ?? ""));
    expect(deriv.length).toBeGreaterThan(3);
    for (const t of deriv) {
      const label = t.dedupLabel!;
      const o = /^(.+)-OPT-(\d{2})([A-Za-z]{3})(\d{4})-(CE|PE)-([\d.]+)-([A-Z]+)$/.exec(label);
      const f = /^(.+)-FUT-(\d{2})([A-Za-z]{3})(\d{4})-([A-Z]+)$/.exec(label);
      const row = o
        ? { trdSym: "40021_NFO", sym: o[1]!, exc: "NFO", opTyp: o[5]!, stkPrc: o[6]!, dpExpDt: `${o[2]}-${o[3]}-${o[4]}` }
        : { trdSym: "40021_NFO", sym: f![1]!, exc: "NFO", opTyp: "FUT", stkPrc: "0", dpExpDt: `${f![2]}${f![3]}${f![4]}` };
      expect(nuvamaTradingsymbol(row), label).toBe(t.tradingsymbol);
      // and the report's own instrument string, if the API states it in trdSym
      expect(nuvamaTradingsymbol({ trdSym: label }), label).toBe(t.tradingsymbol);
    }
  });

  it("accepts the unambiguous dpExpDt forms and nothing else", () => {
    const row = { trdSym: "x", sym: "NIFTY", exc: "NFO", opTyp: "PE", stkPrc: "23550" };
    const want = "OPT NIFTY 22 Sep 2026 23550 PE";
    for (const d of ["22Sep2026", "22-Sep-2026", "22 Sep 2026", "22 Sep, 2026", "22-Sep-26", "2026-09-22", "22-SEP-2026"]) {
      expect(nuvamaTradingsymbol({ ...row, dpExpDt: d }), d).toBe(want);
    }
    for (const d of ["", "22/09/2026", "09/22/2026", "Sep 2026", "31-Sep-2026", "2026-13-01"]) {
      expect(nuvamaTradingsymbol({ ...row, dpExpDt: d }), d).toBeNull();
    }
  });

  it("a token-shaped `sym` is not an underlying; trdSym's compact contract supplies one only when it agrees", () => {
    const row = { trdSym: "NIFTY26SEP23550PE", sym: "7053_NSE", exc: "NFO", opTyp: "PE", stkPrc: "23550.00", dpExpDt: "29-Sep-2026" };
    expect(nuvamaTradingsymbol(row)).toBe("OPT NIFTY 29 Sep 2026 23550 PE");
    expect(nuvamaTradingsymbol({ ...row, trdSym: "40021_NFO" })).toBeNull(); // no underlying anywhere
    expect(nuvamaTradingsymbol({ ...row, stkPrc: "23600" })).toBeNull(); // contradiction
  });

  it("refuses an unparseable derivative", () => {
    const row = { trdSym: "x", sym: "NIFTY", exc: "NFO", opTyp: "CE", stkPrc: "23550", dpExpDt: "22-Sep-2026" };
    expect(nuvamaTradingsymbol({ ...row, stkPrc: "abc" })).toBeNull();
    expect(nuvamaTradingsymbol({ ...row, opTyp: "OPTIDX" })).toBeNull();
    expect(nuvamaTradingsymbol({ ...row, dpExpDt: null })).toBeNull();
    expect(nuvamaTradingsymbol({ trdSym: "NIFTY-OPT-22Sep2026-XE-23550-NSE" })).toBeNull();
  });

  it("equity: an ISIN resolves through the bundled chain (kept when unknown); a ticker loses its series", () => {
    // the bundled snapshot's own answer, whatever it is on this checkout
    const isin = "INE062A01020"; // SBIN
    expect(nuvamaTradingsymbol({ trdSym: isin, exc: "NSE", opTyp: "" })).toBe(bundledSymbolByIsin(isin) ?? isin);
    expect(nuvamaTradingsymbol({ trdSym: "INE000Z99999", exc: "NSE" })).toBe(bundledSymbolByIsin("INE000Z99999") ?? "INE000Z99999");
    expect(nuvamaTradingsymbol({ trdSym: "TATCHE", exc: "NSE", opTyp: "XX", dpExpDt: "" })).toBe("TATCHE");
    expect(nuvamaTradingsymbol({ trdSym: "IDEA-EQ", exc: "NSE" })).toBe("IDEA");
    expect(nuvamaTradingsymbol({ trdSym: "", exc: "NSE" })).toBeNull();
    expect(nuvamaTradingsymbol({ trdSym: "7053_NSE", exc: "NSE" })).toBeNull();
  });
});

describe("currency / NCDEX — one refusal rule across the three pulls (seam D-C6-2)", () => {
  it("Kotak cde_fo, Nuvama CDS/BCD/NCDEX and Fyers segment 12 are unpriced; equity, F&O and MCX are not", () => {
    expect(kotakUnpricedSegment("cde_fo")).toBe(true);
    expect(kotakTradingsymbol({ trdSym: "USDINR26OCTFUT", sym: "USDINR", exSeg: "cde_fo", optTp: "XX", expDt: "28 Oct, 2026" })).toBeNull();
    for (const seg of ["nse_cm", "bse_cm", "nse_fo", "bse_fo", "mcx_fo"]) expect(kotakUnpricedSegment(seg), seg).toBe(false);

    for (const exc of ["CDS", "bcd", "NCDEX"]) {
      expect(nuvamaUnpricedRow({ trdSym: "USDINR26OCTFUT", exc }), exc).toBe(true);
      expect(nuvamaTradingsymbol({ trdSym: "USDINR26OCTFUT", sym: "USDINR", exc, opTyp: "FUT", dpExpDt: "28Oct2026" }), exc).toBeNull();
    }
    expect(nuvamaUnpricedRow({ trdSym: "USDINR-FUT-28Oct2026-CDS", exc: "" })).toBe(true);
    expect(nuvamaTradingsymbol({ trdSym: "USDINR-FUT-28Oct2026-CDS" })).toBeNull();
    for (const [trdSym, exc] of [["SBIN-EQ", "NSE"], ["NIFTY-OPT-22Sep2026-PE-23550-NSE", ""], ["CRUDEOIL26OCTFUT", "MCX"], ["TCS26OCTFUT", "NFO"]]) {
      expect(nuvamaUnpricedRow({ trdSym, exc }), trdSym).toBe(false);
    }

    expect(fyersUnpricedRow(12, "NSE:USDINR26OCTFUT")).toBe(true);
    expect(fyersUnpricedRow("12", "NSE:USDINR26OCTFUT")).toBe(true);
    for (const sym of ["CDS:USDINR26OCTFUT", "BCD:USDINR26OCTFUT", "ncdex:CASTOR26OCTFUT"]) expect(fyersUnpricedRow(undefined, sym), sym).toBe(true);
    for (const [seg, sym] of [[10, "NSE:SBIN-EQ"], [11, "NSE:NIFTY26OCTFUT"], [20, "MCX:CRUDEOIL26OCTFUT"], [undefined, "NSE:SBIN-EQ"]] as const) {
      expect(fyersUnpricedRow(seg, sym), sym).toBe(false);
    }

    expect(unpricedRefusalNote(1)).toBe("1 currency / NCDEX fill was refused: currency / NCDEX contracts are not imported by this pull (no charge profile covers them).");
  });
});

describe("contractKeyOf — the cross-source contract key (R1/R2)", () => {
  it("one key for the three ways one Fyers option is stored; the compact monthly states no day", () => {
    const file = contractKeyOf("CDSL26SEP1400CE")!;
    const oa = contractKeyOf("OPT CDSL 29 Sep 2026 1400 CE")!;
    expect(file).toEqual({ key: "option|CDSL|2026-09|1400|CE", day: null });
    expect(oa).toEqual({ key: "option|CDSL|2026-09|1400|CE", day: "2026-09-29" });
    expect(sameContractDay(file.day, oa.day)).toBe(true);
  });

  it("futures meet across grammars; a weekly and the monthly of one month share the key but not the day", () => {
    expect(contractKeyOf("NIFTY26SEPFUT")!.key).toBe(contractKeyOf("FUT NIFTY 29 Sep 2026")!.key);
    const weekly = contractKeyOf("NIFTY2690825000CE")!;
    const monthly = contractKeyOf("OPT NIFTY 29 Sep 2026 25000 CE")!;
    expect(weekly.key).toBe(monthly.key);
    expect(sameContractDay(weekly.day, monthly.day)).toBe(false);
  });

  it("equity is the bare ticker, NO segment; an unparseable derivative has no key", () => {
    expect(contractKeyOf("SBIN-EQ")).toEqual({ key: "equity|SBIN", day: null });
    expect(contractKeyOf("sbin")).toEqual({ key: "equity|SBIN", day: null });
    expect(contractKeyOf("OPT X 99 Foo 2026 100 CE")).toBeNull();
    expect(contractKeyOf("   ")).toBeNull();
  });
});
