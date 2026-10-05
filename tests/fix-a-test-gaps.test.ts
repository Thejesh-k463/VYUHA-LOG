import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
// Pure (no DB): the Data Quality pairing, the identity and the key.
import { staleOpenPairs, type QualityTrade } from "@/lib/analytics/data-quality";
import { executionIdentity, dedupLabelFromNotes } from "@/lib/import/trade-identity";
import { pairKeyOf } from "@/lib/import/contract-key";

/**
 * v4.8.0 FIX-A — the four MED test gaps of the release audit (TEST-ONLY; review: ACCEPT).
 *
 *   T-1 / M5-1  data-quality.ts ~909: the two halves of the month-only ambiguity
 *               rule, each pinned ALONE — (a) two candidate lots with ONE stated
 *               day; (b) one candidate lot with a SECOND stated day in the book.
 *               Each red with its own half deleted (`candidates > 1`, `statedDays.size > 1`).
 *   M5-2        data-quality.ts ~884: the take loop hands `s.date` to `pairLevel`,
 *               so an UNCONSUMED dated weekly (22 Sep) is never offered to a
 *               compact monthly sale dated 30 Sep. Red with `s.date` dropped.
 *   T-2         commit.ts :510 / :629: the D2 issuer veto end to end — BSE
 *               `KALYANI` (INE0N6U01018) and NSE `KALYANI` (INE610E01010) on one
 *               key never close each other; the same issuer does; a side with no
 *               ISIN does. Red with `isin` dropped at either site.
 *   M5-3        commit.ts :425-426: a PARTIAL cross-name close where both sides
 *               state ISINs — the slice's `dedup_hash` is `executionIdentity`
 *               over the slice's OWN stored columns (the LOT's name and ISIN).
 *               Red with `closedTradeOf` keeping the execution's name / ISIN.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const OA_W = "OPT NIFTY 22 Sep 2026 25000 CE";
const OA_M = "OPT NIFTY 29 Sep 2026 25000 CE";
const NAT_M = "NIFTY26SEP25000CE";
const r2 = (n: number) => Math.round(n * 100) / 100;

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the month-only ambiguity halves and the dated take loop
// ─────────────────────────────────────────────────────────────────────────────

let seq = 0;
const q = (p: Partial<QualityTrade> = {}): QualityTrade => ({
  id: ++seq,
  dedupHash: seq.toString(16).padStart(40, "0"),
  isOpen: true,
  acquisition: null,
  acquisitionPrice: null,
  closingPrice: null,
  slPlanned: 1,
  riskAmount: 1,
  segment: "fo_options",
  mtfFundedAmount: null,
  instrumentType: "option",
  expiry: null,
  strike: 25000,
  optionType: "CE",
  symbol: "NIFTY",
  tradingsymbol: NAT_M,
  accountId: 1,
  broker: "fyers",
  exchange: "NSE",
  buyQty: 0,
  sellQty: 0,
  avgBuyPrice: 0,
  avgSellPrice: 0,
  buyDate: null,
  sellDate: null,
  createdAt: "2026-09-15 04:00:00",
  staged: false,
  ...p,
});
const lotOf = (tradingsymbol: string, buyDate: string, qty = 75) => q({ tradingsymbol, buyQty: qty, avgBuyPrice: 120, buyDate });
const saleOf = (tradingsymbol: string, sellDate: string, qty = 75) => q({ tradingsymbol, sellQty: qty, avgSellPrice: 140, sellDate });

describe("T-1 / M5-1 — each half of the month-only ambiguity rule, alone", () => {
  it("(a) TWO lots of ONE dated name beside a compact monthly sale: candidates 2, one stated day → ambiguous (red with `candidates > 1` deleted)", () => {
    const pairs = staleOpenPairs([lotOf(OA_M, "2026-09-10"), lotOf(OA_M, "2026-09-11"), saleOf(NAT_M, "2026-09-15")]);
    expect(pairs.map((p) => [p.tradingsymbol, p.saleTradingsymbol, p.monthOnly, p.closedLotIds.length])).toEqual([[OA_M, NAT_M, true, 0]]);
    // THE assertion: the book states ONE expiry day (the 29th), so only the second candidate lot makes it ambiguous.
    expect([pairs[0]!.ambiguous, pairs[0]!.oneClick]).toEqual([true, false]);
  });

  it("(b) ONE candidate lot, but a SECOND stated expiry day in the month's book (a closed weekly, exited before the lot): ambiguous (red with `statedDays.size > 1` deleted)", () => {
    const closedWeekly = q({ tradingsymbol: OA_W, isOpen: false, buyQty: 75, avgBuyPrice: 100, buyDate: "2026-09-01", sellQty: 75, avgSellPrice: 110, sellDate: "2026-09-05" });
    const pairs = staleOpenPairs([closedWeekly, lotOf(OA_M, "2026-09-10"), saleOf(NAT_M, "2026-09-15")]);
    expect(pairs.map((p) => [p.tradingsymbol, p.saleTradingsymbol, p.monthOnly])).toEqual([[OA_M, NAT_M, true]]);
    // The closed weekly exited on the 5th, before the lot opened on the 10th, so it is NOT a closed lot that may have taken the sale…
    expect(pairs[0]!.closedLotIds).toEqual([]);
    // …and there is exactly one candidate lot: only the second stated day (the 22nd) makes it ambiguous.
    expect([pairs[0]!.ambiguous, pairs[0]!.oneClick]).toEqual([true, false]);
  });

  it("control — one candidate lot, one stated day: the month-only pair is NOT ambiguous and is one-click (with the tick)", () => {
    const pairs = staleOpenPairs([lotOf(OA_M, "2026-09-10"), saleOf(NAT_M, "2026-09-15")]);
    expect(pairs.map((p) => [p.monthOnly, p.ambiguous, p.oneClick])).toEqual([[true, false, true]]);
  });
});

describe("M5-2 — the take loop pairs on the SALE's date", () => {
  it("an UNCONSUMED dated weekly lot (22 Sep) and a compact monthly sale dated 30 Sep: not listed (red with `s.date` dropped from the take loop)", () => {
    const pairs = staleOpenPairs([lotOf(OA_W, "2026-09-10"), saleOf(NAT_M, "2026-09-30")]);
    expect(pairs).toEqual([]);
  });
  it("control — the same sale dated BEFORE the weekly's expiry is offered at month level", () => {
    const pairs = staleOpenPairs([lotOf(OA_W, "2026-09-10"), saleOf(NAT_M, "2026-09-15")]);
    expect(pairs.map((p) => [p.tradingsymbol, p.saleTradingsymbol, p.monthOnly])).toEqual([[OA_W, NAT_M, true]]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Through the importer: the issuer veto and the slice's identity
// ─────────────────────────────────────────────────────────────────────────────

let t: TempDb;
let commit: typeof import("@/lib/import/commit");

function trade(over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade {
  return {
    broker: "fyers",
    isin: null,
    buyQty: 0, avgBuyPrice: 0, buyValue: 0,
    sellQty: 0, avgSellPrice: 0, sellValue: 0,
    closingPrice: null, grossPnl: 0, unrealisedPnl: 0,
    buyDate: null, sellDate: null,
    productHint: null, exchangeHint: null, sourceFile: null,
    ...over,
  } as NormalizedTrade;
}
const buy = (sym: string, qty: number, price: number, date: string, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: sym, buyQty: qty, avgBuyPrice: price, buyValue: r2(qty * price), buyDate: date, ...over });
const sell = (sym: string, qty: number, price: number, date: string, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: sym, sellQty: qty, avgSellPrice: price, sellValue: r2(qty * price), sellDate: date, ...over });
const parsed = (trades: NormalizedTrade[]): ParsedFile => ({ sourceId: "fyers-tradebook", broker: "fyers", format: "csv", trades, warnings: [] });
const newAccount = (id: number, name: string) => {
  t.db.insert(t.schema.accounts).values({ id, name }).run();
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
};
const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);
const importFile = (accountId: number, file: ParsedFile, fileName: string) => commit.commitParsedFile(file, fileName, null, accountId, { autoClose: true });

// The seventh shared equity key (X1 review PROBE-K): one ticker, two issuers.
const BSE_KALYANI = "INE0N6U01018";
const NSE_KALYANI = "INE610E01010";

beforeAll(async () => {
  t = await openTempDb("fix-a-test-gaps", { seed: true });
  commit = await import("@/lib/import/commit");
}, 30_000);

afterAll(() => t?.cleanup());

describe("T-2 — the D2 issuer veto, end to end through commitParsedFile", () => {
  it("BSE KALYANI lot + NSE KALYANI sale, one key (no exchange stated → NSE), different issuers: NO close — both rows stand (red with `isin` dropped at :510 or :629)", () => {
    const A = 351;
    newAccount(A, "fix-a t2 veto");
    expect(importFile(A, parsed([buy("KALYANI", 100, 500, "2026-09-10", { isin: BSE_KALYANI })]), "lot.csv").added).toBe(1);
    const res = importFile(A, parsed([sell("KALYANI", 100, 520, "2026-09-15", { isin: NSE_KALYANI })]), "sale.csv");
    // THE assertion: a ticker is not an identity (AGENTS.md); the ISINs name two companies.
    expect(res.autoClose).toMatchObject({ closedWhole: 0, reduced: 0 });
    expect(res.added).toBe(1);
    expect(rowsOf(A).map((r) => [r.isin, r.buyQty, r.sellQty, r.isOpen]).sort()).toEqual([[BSE_KALYANI, 100, 0, true], [NSE_KALYANI, 0, 100, true]].sort());
  });

  it("control — the SAME issuer on both sides closes the lot whole", () => {
    const B = 352;
    newAccount(B, "fix-a t2 same issuer");
    importFile(B, parsed([buy("KALYANI", 100, 500, "2026-09-10", { isin: NSE_KALYANI })]), "lot.csv");
    const res = importFile(B, parsed([sell("KALYANI", 100, 520, "2026-09-15", { isin: NSE_KALYANI })]), "sale.csv");
    expect(res.autoClose).toMatchObject({ closedWhole: 1 });
    expect(rowsOf(B).map((r) => [r.buyQty, r.sellQty, r.isOpen])).toEqual([[100, 100, false]]);
  });

  it("control — a side that states NO ISIN is never vetoed (nothing stated, no veto)", () => {
    const C = 353;
    newAccount(C, "fix-a t2 no isin");
    importFile(C, parsed([buy("KALYANI", 100, 500, "2026-09-10", { isin: null })]), "lot.csv");
    const res = importFile(C, parsed([sell("KALYANI", 100, 520, "2026-09-15", { isin: NSE_KALYANI })]), "sale.csv");
    expect(res.autoClose).toMatchObject({ closedWhole: 1 });
    expect(rowsOf(C)).toHaveLength(1);
  });
});

describe("M5-3 — a partial cross-name close where both sides state ISINs: the slice's hash is derivable from its OWN stored columns", () => {
  it("two SBIN lots, an SBIN-EQ sale of 100 (both ISINs stated): the slice is stored under the LOT's name and hashes to itself (red with closedTradeOf keeping the execution's name / ISIN)", () => {
    const D = 354;
    const ISIN = "INE062A01020";
    newAccount(D, "fix-a m5-3 slice identity");
    expect(pairKeyOf("SBIN-EQ"), "the two names are one pairing key").toBe(pairKeyOf("SBIN"));
    importFile(D, parsed([buy("SBIN", 60, 800, "2026-09-10", { isin: ISIN }), buy("SBIN", 60, 810, "2026-09-11", { isin: ISIN })]), "lots.csv");
    const res = importFile(D, parsed([sell("SBIN-EQ", 100, 850, "2026-09-15", { isin: ISIN })]), "sale.csv");
    expect(res.autoClose).toMatchObject({ closedWhole: 1, reduced: 1 });
    const rows = rowsOf(D);
    const slice = rows.find((r) => !r.isOpen && r.buyQty === 40 && r.sellQty === 40)!;
    expect(slice, "the 40 the second lot gave up, as its own closed row").toBeDefined();
    // X1 D4(a): the slice carries the LOT's name and ISIN, never a re-classification.
    expect([slice.tradingsymbol, slice.isin]).toEqual(["SBIN", ISIN]);
    // THE assertion (the hash-vs-columns promise): identity re-derived from the stored row IS the stored hash.
    const derived = executionIdentity({
      broker: slice.broker,
      tradingsymbol: slice.tradingsymbol,
      isin: slice.isin,
      dedupLabel: dedupLabelFromNotes(slice.importNotes),
      buyQty: slice.buyQty,
      avgBuyPrice: slice.avgBuyPrice,
      buyValue: slice.buyValue,
      sellQty: slice.sellQty,
      avgSellPrice: slice.avgSellPrice,
      sellValue: slice.sellValue,
      buyDate: slice.buyDate,
      sellDate: slice.sellDate,
      segment: slice.segment,
      exchange: slice.exchange,
    });
    expect(slice.dedupHash).toBe(derived.hash);
    // And the lot consumed WHOLE holds the execution's own hash as its alias, so the file is a duplicate next time.
    expect(importFile(D, parsed([sell("SBIN-EQ", 100, 850, "2026-09-15", { isin: ISIN })]), "sale.csv").added).toBe(0);
  });
});
