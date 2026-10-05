import { describe, expect, it } from "vitest";
import {
  contractKeyOf,
  monthKeyOf,
  pairKeyOf,
  pairLevel,
  sameContractDay,
  sameContractDayOf,
  sameIssuer,
  stripSeriesSuffix,
} from "@/lib/import/contract-key";
// The re-exports every C6 caller still imports (D1: cross-source.ts and pull-symbols.ts re-export).
import * as crossSource from "@/lib/import/cross-source";
import * as pullSymbols from "@/lib/import/pull-symbols";
import { matchKey, planLotCloses, type IncomingRow, type OpenLot } from "@/lib/import/close-open-lots";
import { detectCrossBrokerEchoes } from "@/lib/import/cross-source";
import { legacyShortGroupRefusals, legacyShortLegMatch } from "@/lib/import/legacy-short";
import fs from "node:fs";
import path from "node:path";

/**
 * v4.8.0 wave X1 — THE CONTRACT KEY (design D1/D2/D3/D7/D8, review verdicts).
 *
 * Pure: no database, no React. Every pairing reader joins a lot and its
 * execution on `pairKeyOf`; a month-level pair is SAID and never applied
 * (owner ruling S6). This file pins the key's grammar, the level between two
 * names, the issuer veto, the moved re-exports, and the three pure readers
 * that follow the key (`matchKey`, the echoes note, legacy-short).
 */

const OA_W = "OPT NIFTY 22 Sep 2026 25000 CE"; //  OpenAlgo / Kotak / Nuvama / Dhan / Angel: the dated grammar
const NAT_W = "NIFTY2692225000CE"; //              Fyers / Zerodha / Upstox: the compact weekly (states the day)
const NAT_M = "NIFTY26SEP25000CE"; //              the compact MONTHLY (states only the month)
const OA_M = "OPT NIFTY 29 Sep 2026 25000 CE"; //  the monthly, dated by a dated-grammar source
const NAT_F = "NIFTY26SEPFUT";
const OA_F = "FUT NIFTY 29 Sep 2026";

describe("X1 D1 — the key grammar", () => {
  it("pairKeyOf: the month key plus the stated day, `M` for a compact monthly / future, the bare ticker for equity, raw otherwise", () => {
    expect(pairKeyOf(OA_W)).toBe("option|NIFTY|2026-09|25000|CE|2026-09-22");
    expect(pairKeyOf(NAT_W)).toBe("option|NIFTY|2026-09|25000|CE|2026-09-22");
    expect(pairKeyOf("OPT NIFTY 22 Sep 2026 25000.00 CE"), "a strike spelling is not an identity").toBe(pairKeyOf(OA_W));
    expect(pairKeyOf(NAT_M)).toBe("option|NIFTY|2026-09|25000|CE|M");
    expect(pairKeyOf(OA_M)).toBe("option|NIFTY|2026-09|25000|CE|2026-09-29");
    expect(pairKeyOf(NAT_F)).toBe("future|NIFTY|2026-09|||M");
    expect(pairKeyOf(OA_F)).toBe("future|NIFTY|2026-09|||2026-09-29");
    expect(pairKeyOf("SBIN")).toBe("equity|SBIN");
    expect(pairKeyOf(" sbin-eq ")).toBe("equity|SBIN");
    expect(pairKeyOf("OPT X 99 Foo 2026 100 CE"), "a derivative whose date does not parse matches only its own string").toBe(
      "raw|OPT X 99 FOO 2026 100 CE",
    );
    expect(pairKeyOf("")).toBe("raw|");
  });

  it("monthKeyOf is C6's contract key, unchanged — the compact monthly and the dated monthly share it", () => {
    expect(monthKeyOf(NAT_M)).toBe("option|NIFTY|2026-09|25000|CE");
    expect(monthKeyOf(OA_M)).toBe(monthKeyOf(NAT_M));
    expect(monthKeyOf(NAT_W)).toBe(monthKeyOf(NAT_M));
    expect(monthKeyOf(NAT_F)).toBe(monthKeyOf(OA_F));
    expect(monthKeyOf("SBIN-EQ")).toBe("equity|SBIN");
    expect(monthKeyOf(NAT_M)).toBe(contractKeyOf(NAT_M)!.key);
  });

  it("the series set is the UNION of the three pre-X1 copies (+BL, +GS) and strips nothing else (PROBE-K)", () => {
    expect(["SBIN-EQ", "sbin-be", " X-BZ ", "Y-SM", "Z-ST", "A-BL", "B-GS"].map(stripSeriesSuffix)).toEqual(["SBIN", "SBIN", "X", "Y", "Z", "A", "B"]);
    // 13 real tickers end in `-B` / `-RE` (KLBRENG-B, DHAN-RE): a ticker is not a series.
    expect(stripSeriesSuffix("KLBRENG-B")).toBe("KLBRENG-B");
    expect(stripSeriesSuffix("DHAN-RE")).toBe("DHAN-RE");
    expect(stripSeriesSuffix("BAJAJ-AUTO")).toBe("BAJAJ-AUTO");
    expect(pairKeyOf("KLBRENG-B")).toBe("equity|KLBRENG-B");
  });

  it("the moved names are re-exported where C6's callers import them", () => {
    expect(crossSource.contractKeyOf).toBe(contractKeyOf);
    expect(crossSource.sameContractDay).toBe(sameContractDay);
    expect(crossSource.stripSeriesSuffix).toBe(stripSeriesSuffix);
    expect(pullSymbols.contractKeyOf).toBe(contractKeyOf);
    expect(pullSymbols.stripSeriesSuffix).toBe(stripSeriesSuffix);
    // The leaf imports the classifier and nothing else (client-safe, invariant 2).
    const src = fs.readFileSync(path.join(process.cwd(), "lib", "import", "contract-key.ts"), "utf8");
    const imports = [...src.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).toEqual(["@/lib/engine/classify"]);
  });

  it("is memoised per distinct string: 100k reads of one name cost one parse", () => {
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) pairKeyOf(OA_W);
    expect(performance.now() - t0).toBeLessThan(300);
  });
});

describe("X1 D3 (review REVISE) — pairLevel", () => {
  it("exact: a compact weekly and its dated twin; equity with and without the series; two compact monthlies", () => {
    expect(pairLevel(NAT_W, OA_W)).toBe("exact");
    expect(pairLevel("SBIN-EQ", "sbin")).toBe("exact");
    expect(pairLevel(NAT_M, "NIFTY26SEP25000CE")).toBe("exact");
    expect(pairLevel(NAT_F, "nifty26sepfut")).toBe("exact");
  });

  it("month: ONLY a compact monthly / future against a DATED-grammar name of its month", () => {
    expect(pairLevel(NAT_M, OA_M)).toBe("month");
    expect(pairLevel(OA_M, NAT_M), "either order").toBe("month");
    expect(pairLevel(NAT_F, OA_F)).toBe("month");
    // The dated name need not be the monthly's day: a dated WEEKLY against the
    // compact monthly is month level too — the calendar spread the design names
    // (seq 19), listed with both names and never closed.
    expect(pairLevel(OA_W, NAT_M)).toBe("month");
  });

  it("null: a compact weekly against a compact monthly (one grammar, never one contract), two dated expiries, two strikes, CE vs PE, equity vs its option", () => {
    expect(pairLevel(NAT_W, NAT_M)).toBeNull();
    expect(pairLevel(OA_W, OA_M)).toBeNull();
    expect(pairLevel(OA_W, "OPT NIFTY 22 Sep 2026 25100 CE")).toBeNull();
    expect(pairLevel(OA_W, "OPT NIFTY 22 Sep 2026 25000 PE")).toBeNull();
    expect(pairLevel("NIFTY", NAT_M)).toBeNull();
    expect(pairLevel("SBIN", "SBINX")).toBeNull();
  });

  it("null when the execution is dated after the dated name's own expiry day", () => {
    expect(pairLevel(NAT_M, OA_W, "2026-09-22")).toBe("month");
    expect(pairLevel(NAT_M, OA_W, "2026-09-23"), "the weekly expired on the 22nd — a sale on the 23rd is some other expiry's").toBeNull();
    expect(pairLevel(OA_M, NAT_M, "2026-09-30")).toBeNull();
    expect(pairLevel(OA_M, NAT_M, "2026-09-29")).toBe("month");
    // An exact pair is not dated-gated here (the applier's own date rule decides).
    expect(pairLevel(NAT_W, OA_W, "2026-09-30")).toBe("exact");
  });

  it("sameContractDayOf reads the two names' days (D7/D8)", () => {
    expect(sameContractDayOf(NAT_M, OA_M)).toBe(true);
    expect(sameContractDayOf(NAT_W, OA_W)).toBe(true);
    expect(sameContractDayOf(NAT_W, OA_M)).toBe(false);
    expect(sameContractDayOf("SBIN", "SBIN-EQ")).toBe(true);
  });
});

describe("X1 D2 rider — the issuer veto", () => {
  it("two stated ISINs of different issuers never pair; a split (same issuer, new ISIN) still does; one side unstated is no veto", () => {
    expect(sameIssuer("INE0N6U01018", "INE610E01010"), "KALYANI: bse vs nse are two companies").toBe(false);
    expect(sameIssuer("INE062A01020", "INE062A01038"), "a face-value split keeps the issuer").toBe(true);
    expect(sameIssuer("INE062A01020", null)).toBe(true);
    expect(sameIssuer("", "INE062A01020")).toBe(true);
    expect(sameIssuer(" ine062a01020 ", "INE062A01020")).toBe(true);
  });
});

// ─── the pure readers that follow the key ────────────────────────────────────

const lot = (over: Partial<OpenLot> & { tradingsymbol: string }): OpenLot => ({
  id: 1, accountId: 7, broker: "fyers", segment: "index_option", exchange: "NSE", side: "long",
  qty: 75, price: 120, value: 9000, charges: 10, date: "2026-09-14", ...over,
});
const sale = (over: Partial<IncomingRow> & { tradingsymbol: string }): IncomingRow => ({
  key: "k", accountId: 7, broker: "fyers", segment: "index_option", exchange: "NSE", side: "sell",
  qty: 75, price: 140, value: 10500, charges: 12, date: "2026-09-15", ...over,
});

describe("X1 D2 — matchKey and planLotCloses pair on pairKeyOf, EXACT only", () => {
  it("matchKey: the OpenAlgo lot and the native sale of one weekly share a key; the compact monthly does not meet its dated twin", () => {
    expect(matchKey(lot({ tradingsymbol: OA_W }))).toBe(matchKey(sale({ tradingsymbol: NAT_W })));
    expect(matchKey(lot({ tradingsymbol: OA_W }))).toBe(`7|fyers|${pairKeyOf(OA_W)}|index_option|NSE`);
    expect(matchKey(lot({ tradingsymbol: NAT_M }))).not.toBe(matchKey(sale({ tradingsymbol: OA_M })));
    // Segment and exchange stay in the key exactly as before.
    expect(matchKey(lot({ tradingsymbol: OA_W, exchange: "BSE" }))).not.toBe(matchKey(sale({ tradingsymbol: NAT_W })));
    expect(matchKey(lot({ tradingsymbol: OA_W, segment: "stock_option" }))).not.toBe(matchKey(sale({ tradingsymbol: NAT_W })));
  });

  it("planLotCloses: the native sale closes the OpenAlgo lot whole (THE pinned R4' class, now exact for a weekly)", () => {
    const plan = planLotCloses([lot({ tradingsymbol: OA_W })], [sale({ tradingsymbol: NAT_W })]);
    expect(plan.closes.map((c) => [c.lotId, c.qty, c.fullyConsumed, c.tradingsymbol])).toEqual([[1, 75, true, OA_W]]);
    expect(plan.untouched).toEqual([]);
  });

  it("planLotCloses: a compact MONTHLY lot is NOT closed by its dated twin (owner ruling S6 — asked, never applied)", () => {
    const plan = planLotCloses([lot({ tradingsymbol: NAT_M })], [sale({ tradingsymbol: OA_M })]);
    expect(plan.closes).toEqual([]);
    expect(plan.untouched).toEqual([{ key: "k", qty: 75 }]);
  });

  it("planLotCloses (D2 rider): two stated ISINs of different issuers on one key are refused", () => {
    const veto = planLotCloses([lot({ tradingsymbol: "MAL", segment: "eq_delivery", isin: "INE0N6U01018" })], [sale({ tradingsymbol: "MAL", segment: "eq_delivery", isin: "INE610E01010" })]);
    expect(veto.closes).toEqual([]);
    const split = planLotCloses([lot({ tradingsymbol: "MAL", segment: "eq_delivery", isin: "INE062A01020" })], [sale({ tradingsymbol: "MAL", segment: "eq_delivery", isin: "INE062A01038" })]);
    expect(split.closes).toHaveLength(1);
    const unstated = planLotCloses([lot({ tradingsymbol: "MAL", segment: "eq_delivery", isin: "INE0N6U01018" })], [sale({ tradingsymbol: "MAL", segment: "eq_delivery", isin: null })]);
    expect(unstated.closes).toHaveLength(1);
  });
});

describe("X1 D8 — the cross-broker echoes note follows the key", () => {
  const ex = (broker: string, tradingsymbol: string, day: string) => ({
    id: 1, broker, symbol: "NIFTY", tradingsymbol, buyQty: 75, sellQty: 0, buyValue: 9000, sellValue: 0,
    buyDate: day, sellDate: null, sourceFile: "x", dedupHash: "h",
  });
  const inc = (broker: string, tradingsymbol: string, day: string) => ({
    broker, symbol: "NIFTY", tradingsymbol, buyQty: 75, sellQty: 0, buyValue: 9000, sellValue: 0, buyDate: day, sellDate: null, dedupHash: "i",
  });

  it("two brokers printing one weekly two ways are an echo; the weekly against the monthly of one month is not", () => {
    expect(detectCrossBrokerEchoes([inc("fyers", NAT_W, "2026-09-15")], [ex("dhan", OA_W, "2026-09-15")])).toMatch(/also under dhan/);
    expect(detectCrossBrokerEchoes([inc("fyers", NAT_M, "2026-09-15")], [ex("dhan", OA_M, "2026-09-15")]), "month level with a SHARED date (C6 Q6)").toMatch(/also under dhan/);
    expect(detectCrossBrokerEchoes([inc("fyers", NAT_W, "2026-09-15")], [ex("dhan", OA_M, "2026-09-15")])).toBeNull();
    expect(detectCrossBrokerEchoes([inc("fyers", NAT_W, "2026-09-15")], [ex("dhan", OA_W, "2026-09-14")]), "the date still decides").toBeNull();
  });
});

describe("X1 D7 — legacy-short reads the key at month level plus the stated day", () => {
  const stored = (tradingsymbol: string) => [
    { id: 11, broker: "fyers", tradingsymbol, isin: null, importNotes: null, buyQty: 0, avgBuyPrice: 0, buyValue: 0, buyDate: null, sellQty: 75, avgSellPrice: 122, sellValue: 9150, sellDate: "2026-09-01", dedupHash: "a".repeat(40) },
    { id: 12, broker: "fyers", tradingsymbol, isin: null, importNotes: null, buyQty: 75, avgBuyPrice: 90, buyValue: 6750, buyDate: "2026-09-02", sellQty: 0, avgSellPrice: 0, sellValue: 0, sellDate: null, dedupHash: "b".repeat(40) },
  ];
  const incoming = (tradingsymbol: string) => ({
    broker: "fyers", tradingsymbol, isin: null, side: "short",
    buyQty: 75, avgBuyPrice: 90, buyValue: 6750, buyDate: "2026-09-02",
    sellQty: 75, avgSellPrice: 122, sellValue: 9150, sellDate: "2026-09-01",
  });

  it("a pre-4.6 two-row short stored under the dated name is refused when restated under the compact name (and the other way)", () => {
    expect(legacyShortLegMatch(incoming(NAT_W), stored(OA_W))).toEqual({ saleId: 11, purchaseId: 12 });
    expect(legacyShortLegMatch(incoming(OA_M), stored(NAT_M)), "month level, bounded by leg equality to the paisa plus the date").toEqual({ saleId: 11, purchaseId: 12 });
    expect(legacyShortGroupRefusals([incoming(NAT_W)], stored(OA_W)).map((g) => g.storedIds)).toEqual([[11, 12]]);
  });

  it("two stated expiry days are two contracts: the weekly's rows never refuse the monthly", () => {
    expect(legacyShortLegMatch(incoming(OA_M), stored(OA_W))).toEqual({ saleId: null, purchaseId: null });
    expect(legacyShortGroupRefusals([incoming(OA_M)], stored(OA_W))).toEqual([]);
    // D7 as ACCEPTED (review): `sameContractDay`, not `pairLevel` — an unstated
    // day meets a stated one, bounded by BOTH legs equal to the paisa AND dated
    // alike (C6 Q6). The compact-weekly-vs-compact-monthly refinement is D3's
    // (the applier and Data Quality), where no leg equality bounds it.
    expect(legacyShortLegMatch(incoming(NAT_W), stored(NAT_M))).toEqual({ saleId: 11, purchaseId: 12 });
  });
});
