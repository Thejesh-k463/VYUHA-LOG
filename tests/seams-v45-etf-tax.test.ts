import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { findRates, ratesForTrade, type RatesMap } from "@/lib/engine/rates";
import { computeCharges } from "@/lib/engine/charges";
import { assetClassFor, resolveCgHead, type CgAssetClass, type CgHead } from "@/lib/analytics/cg-heads";
import { classifyGain } from "@/lib/analytics/capital-gains";
import {
  assessDataQuality,
  etfClassUndetermined,
  type QualityInputs,
  type QualityTrade,
} from "@/lib/analytics/data-quality";
import etfList from "@/lib/data/etf-list.json";
import type { Broker, Exchange, Segment } from "@/lib/domain/constants";

/**
 * ════════════════════════════════════════════════════════════════════════════
 * v4.5.0 WAVE 3c — THE SEAM BETWEEN WAVE 3a (ETF class + STT) AND WAVE 3b
 * (capital-gains heads, and 3b-ii's per-fill realised rows).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Two builders, two disjoint file sets, ONE value crossing between them: the
 * instrument identity `{segment, isin, symbol}` a trade row carries. Wave 3a
 * reads it to decide WHICH STT RATE ROW bills the trade; wave 3b reads the SAME
 * three fields to decide WHICH CAPITAL-GAINS HEAD the sale takes. Neither
 * builder ran the other's half. A disagreement between them is money twice: a
 * gold ETF billed 0.1% both sides AND taxed at 112A, or an equity ETF billed
 * 0.001% while its gain is filed as an ordinary share's.
 *
 * ── THE CROSSING VALUES ─────────────────────────────────────────────────────
 *
 * value       | producer (wave 3a)                   | consumer (wave 3b / 3b-ii)             | unit / shape         | case
 * ------------|--------------------------------------|----------------------------------------|----------------------|------
 * isin        | trades.isin -> etfClass()            | assetClassFor() -> resolveCgHead()     | "INF…" string / null | 2,3,4,5,6
 *             | lib/engine/etf-class.ts:96           | lib/analytics/cg-heads.ts:256          |                      |
 * symbol      | etfClass() bySymbol fallback         | assetClassFor() same fallback          | upper-case ticker    | 1
 *             | lib/engine/etf-class.ts:103          | lib/analytics/cg-heads.ts:262          |                      |
 * kind        | EtfKind equity-oriented | other      | equityFund vs otherUnit / debtUnit     | enum                 | 1,2,3
 * underlying  | the RAW NSE `ETF Underlying` column  | DEBT -> debtUnit; Hybrid -> undet      | raw vendor string    | 3,5
 * (no hit)    | etfClass() null -> the product row   | INF prefix -> "undetermined" + DQ      | null is NOT "share"  | 4
 *             | lib/engine/rates.ts:561              | lib/analytics/cg-heads.ts:276          |                      |
 * segment     | ratesForTrade gate, 3 eq segments    | classifyGain DELIVERY set              | Segment union        | 1-6
 *             | lib/engine/rates.ts:559              | lib/analytics/capital-gains.ts:185     |                      |
 * rate row    | charge_config etf_equity / etf_other | —                                      | FRACTION, not %      | 1,2,5,6
 *             | lib/engine/rates.ts:563-571          |                                        |                      |
 * isin+symbol | lib/queries/staged.ts:530 priceLegs  | getTaxBase -> taxRows[].assetClass     | per FILL, not parent | 6
 *             |                                      | lib/queries/tax-itr.ts:123             |                      |
 *
 * ── HOW THIS FILE REFUSES TO AGREE WITH ITSELF ──────────────────────────────
 *
 * No statutory rate is written down here. Every expected STT is
 * `round(<the charge_config row's OWN sttPct> x <value>)`, and that row is
 * fetched with the ENGINE'S OWN reader (`findRates`) out of the REAL seeded
 * `charge_config` of a temp database (invariant 3). Each case also asserts the
 * figure DIFFERS from the equity-SHARE row's on the identical values, so a
 * broken overlay cannot pass by coincidence. The one literal in the file is ₹1
 * on ₹1,00,000 — the 3c design's own stated figure — asserted ALONGSIDE the
 * derived relation, never instead of it.
 *
 * ── RED ON EITHER SIDE ──────────────────────────────────────────────────────
 *
 * (a) reverse-apply wave 3a's overlay hunk in `lib/engine/rates.ts` and cases
 *     1, 2, 3, 5 and 6 go red on their CHARGES assertion;
 * (b) mutate `assetClassFor` to answer "share" for every INF ISIN and cases
 *     1, 3, 4, 5 and 6 go red on their HEAD / assetClass assertion.
 * Both were run; the quoted failures are in the wave report.
 *
 * ONE temp database for the FILE — `lib/db` caches its connection on
 * `globalThis`, so a second `openTempDb()` here would silently reuse this one.
 */

type Snapshot = { byIsin?: Record<string, unknown>; bySymbol?: Record<string, string> };
const snap = etfList as unknown as Snapshot;
/** The bundled snapshot may legitimately be absent or empty — the isin-bundle-coverage precedent. */
const HAVE_LIST = Object.keys(snap.byIsin ?? {}).length > 0;

const NIFTYBEES = { symbol: "NIFTYBEES", isin: "INF204KB14I2" }; //  EQUITY    -> equity-oriented
const GOLDBEES = { symbol: "GOLDBEES", isin: "INF204KB17I5" }; //    COMMODITY -> other
const LIQUIDBEES = { symbol: "LIQUIDBEES", isin: "INF732E01037" }; // DEBT      -> other
const HYBRIDETF = { symbol: "HYBRIDETF", isin: "INF769K01RJ5" }; //   Hybrid    -> other, class UNDETERMINED
/** An INF ISIN the NSE list does not carry: a BSE-only ETF, an SIF unit, a segregated portfolio. */
const UNLISTED = { symbol: "MYSTERYETF", isin: "INF999X01000" };
const SHARE = { symbol: "RELIANCE", isin: "INE002A01018" };

const BROKER: Broker = "zerodha";
const EXCHANGE: Exchange = "NSE";
const DAY = "2026-09-01"; // after every rate epoch in play

let t: TempDb;
let map: RatesMap;

beforeAll(async () => {
  t = await openTempDb("seams-v45-etf-tax", { seed: true });
  // THE REAL RATE SOURCE: charge_config rows of a migrated + seeded database,
  // read through the engine's own loader (invariant 3), never a literal.
  const { loadRatesMap } = await import("@/lib/engine/rates-db");
  map = loadRatesMap();
  expect(map.size, "the seed wrote charge_config rows").toBeGreaterThan(0);
});

afterAll(() => t?.cleanup());

// ── The two real doors, called exactly as production calls them ─────────────

/** WAVE 3a's door: the ONE pricing entry point, instrument keys and all. */
const ratesOf = (
  i: { isin?: string | null; symbol?: string | null },
  segment: Segment = "eq_delivery",
  on = DAY,
) =>
  ratesForTrade(
    map,
    { broker: BROKER, segment, exchange: EXCHANGE, isin: i.isin, symbol: i.symbol },
    on,
    "default",
  );

/** The rupees of STT the engine actually bills for a buy + sell of these values. */
const sttOf = (
  i: { isin?: string | null; symbol?: string | null },
  v: { buyValue: number; sellValue: number },
  segment: Segment = "eq_delivery",
  on = DAY,
) =>
  computeCharges(
    { segment, buyValue: v.buyValue, sellValue: v.sellValue, buyQty: 500, sellQty: 500 },
    ratesOf(i, segment, on),
  ).sttCtt;

/** A rate ROW straight out of charge_config — the expectation's own source. */
const row = (segment: string, on = DAY) =>
  findRates(map, BROKER, segment as unknown as Segment, EXCHANGE, on, "default");

/** The ₹ of STT a charge_config row implies on a stated base (the engine rounds to the rupee). */
const impliedStt = (segment: string, base: number, on = DAY) => Math.round(row(segment, on).sttPct * base);

/** WAVE 3b's door: the same three fields -> an asset class -> a head. */
const headOf = (
  i: { isin?: string | null; symbol?: string | null },
  acquiredOn: string | null,
  transferredOn: string | null,
  segment = "eq_delivery",
): { assetClass: CgAssetClass; head: CgHead } => {
  const assetClass = assetClassFor({ segment, isin: i.isin, symbol: i.symbol });
  return { assetClass, head: resolveCgHead({ assetClass, acquiredOn, transferredOn }) };
};

/** WAVE 3b's Data Quality half — the card a blank head is explained by. */
const qTrade = (p: Partial<QualityTrade>): QualityTrade => ({
  id: 1,
  isOpen: false,
  acquisition: null,
  acquisitionPrice: null,
  closingPrice: null,
  slPlanned: 90,
  riskAmount: 1000,
  segment: "eq_delivery",
  mtfFundedAmount: null,
  instrumentType: "equity",
  expiry: null,
  strike: null,
  optionType: null,
  symbol: "ABC",
  ...p,
});
const qInputs = (trades: QualityTrade[]): QualityInputs => ({
  trades,
  markedTradeIds: new Set(),
  knownSymbols: new Set(trades.map((x) => x.symbol.toUpperCase())),
  ipoLinkedTradeIds: new Set(),
  staleMtmCount: 0,
  missingAttachmentFiles: 0,
});
const etfClassIssue = (trades: QualityTrade[]) =>
  assessDataQuality(qInputs(trades)).issues.find((x) => x.code === "etf_class");

// A ₹90,000 buy and a ₹1,00,000 sell: the sale side is the 3c design's own
// stated base, so "₹1 of STT" below is that design's figure, not a new one.
const BUY_VALUE = 90_000;
const SELL_VALUE = 100_000;
const BOTH_SIDES = BUY_VALUE + SELL_VALUE;

describe.skipIf(!HAVE_LIST)("seam 3a x 3b — one instrument identity, one bill and one head", () => {
  it("case 1 · GOLDBEES by SYMBOL ALONE (no ISIN on the row): the etf_other row bills NOTHING, and the head is an s.112 / s.50AA UNIT head — never 111A/112A", () => {
    const bySymbolOnly = { symbol: GOLDBEES.symbol, isin: null };

    // ── 3a: the bill. The overlay must fire on the SYMBOL fallback alone.
    const r = ratesOf(bySymbolOnly);
    expect([r.sttPct, r.sttSide], "the etf_other row, reached without an ISIN").toEqual([
      row("etf_other").sttPct,
      row("etf_other").sttSide,
    ]);
    const etfBill = sttOf(bySymbolOnly, { buyValue: BUY_VALUE, sellValue: SELL_VALUE });
    expect(etfBill, "= the etf_other row's own rate on the same base").toBe(impliedStt("etf_other", BOTH_SIDES));
    // …and that is NOT what an equity share pays on the identical values.
    const shareBill = sttOf(SHARE, { buyValue: BUY_VALUE, sellValue: SELL_VALUE });
    expect(shareBill, "the equity-share row, for contrast").toBe(impliedStt("eq_delivery", BOTH_SIDES));
    expect(etfBill, "a gold unit is in no row of the s.98 table").not.toBe(shareBill);

    // ── 3b: the head, from the SAME symbol-only identity.
    const lt = headOf(bySymbolOnly, "2022-01-10", "2025-06-10");
    expect(lt.assetClass, "a commodity unit, resolved by symbol").toBe("otherUnit");
    expect([lt.head.head, lt.head.cell, lt.head.term], "s.112 at 12.5% without indexation, FA (No. 2) 2024").toEqual([
      "ltcg112",
      "O-LT-b",
      "LT",
    ]);
    expect(lt.head.exemption, "the ₹1.25L 112A threshold does NOT reach a gold unit").toBeNull();

    // The s.50AA half of the same band table: acquired on/after 1-4-2023 and
    // transferred before 1-4-2025, a gold unit is a Specified Mutual Fund.
    const smf = headOf(bySymbolOnly, "2023-06-01", "2024-12-01");
    expect([smf.head.head, smf.head.term, smf.head.ratePct], "deemed SHORT-term, taxed at slab — rate blank").toEqual([
      "stcgDeemedSmf",
      "ST",
      null,
    ]);

    for (const h of [lt.head.head, smf.head.head]) expect(["stcg111A", "ltcg112A"]).not.toContain(h);
  });

  it("case 2 · NIFTYBEES with its ISIN: ₹1 of seller-side STT on a ₹1,00,000 delivery sale, AND 111A / 112A by CALENDAR MONTH", () => {
    // ── 3a: the bill.
    const r = ratesOf(NIFTYBEES);
    expect(r.sttSide, "s.98 Sl. 2A is SELLER-side").toBe(row("etf_equity").sttSide);
    expect(r.sttPct, "and its rate comes from the etf_equity row").toBe(row("etf_equity").sttPct);
    const stt = sttOf(NIFTYBEES, { buyValue: BUY_VALUE, sellValue: SELL_VALUE });
    expect(stt, "the etf_equity row's own rate, on the SALE side only").toBe(impliedStt("etf_equity", SELL_VALUE));
    expect(stt, "the 3c design's stated figure: ₹1 on ₹1,00,000").toBe(1);
    expect(stt, "a hundredth of what the same values pay as a share").not.toBe(
      sttOf(SHARE, { buyValue: BUY_VALUE, sellValue: SELL_VALUE }),
    );
    // The overlay takes sttPct / sttSide and NOTHING else — the brokerage, DP
    // and GST of the trade's own product row survive it.
    const base = row("eq_delivery");
    expect(
      [r.brokerageFlat, r.brokeragePct, r.dpCharge, r.gstPct],
      "every other column is still the product row's",
    ).toEqual([base.brokerageFlat, base.brokeragePct, base.dpCharge, base.gstPct]);

    // ── 3b: the head, from the SAME ISIN.
    const short = headOf(NIFTYBEES, "2024-06-10", "2025-01-10");
    expect(short.assetClass).toBe("equityFund");
    expect([short.head.head, short.head.term], "an EOF unit held under 12 months is s.111A").toEqual([
      "stcg111A",
      "ST",
    ]);
    const long = headOf(NIFTYBEES, "2023-06-10", "2024-06-11");
    expect(
      [long.head.head, long.head.term, long.head.exemption],
      "12 calendar months + a day -> s.112A, ₹1L band (pre 23-7-2024)",
    ).toEqual(["ltcg112A", "LT", 100000]);
    // THE calendar-month line, at the seam: the same lot sold one day earlier.
    expect(headOf(NIFTYBEES, "2023-06-10", "2024-06-10").head.head, "exactly 12 months is still SHORT-term").toBe(
      "stcg111A",
    );
  });

  it("case 3 · LIQUIDBEES acquired 2023-05-02, sold after 1-4-2024: s.50AA deems it SHORT-term however long it was held — and it is billed nothing", () => {
    // ── 3a.
    expect(ratesOf(LIQUIDBEES).sttPct, "a debt unit is in no row of the s.98 table").toBe(row("etf_other").sttPct);
    const etfBill = sttOf(LIQUIDBEES, { buyValue: BUY_VALUE, sellValue: SELL_VALUE });
    expect(etfBill).toBe(impliedStt("etf_other", BOTH_SIDES));
    expect(etfBill).not.toBe(sttOf(SHARE, { buyValue: BUY_VALUE, sellValue: SELL_VALUE }));

    // ── 3b: the RAW `DEBT` underlying, not the binary kind, is what s.50AA reads.
    for (const sold of ["2024-09-10", "2026-01-05"]) {
      const h = headOf(LIQUIDBEES, "2023-05-02", sold);
      expect(h.assetClass, `${sold}: a DEBT unit`).toBe("debtUnit");
      expect(
        [h.head.head, h.head.term, h.head.ratePct],
        `${sold}: deemed short-term, taxed at slab, rate blank`,
      ).toEqual(["stcgDeemedSmf", "ST", null]);
    }
    // 2026-01-05 is 32 months of holding AND past 1-4-2025, when the SMF test
    // narrowed to debt alone — the gold unit falls out there, the debt one does not.
    expect(
      headOf(GOLDBEES, "2023-05-02", "2026-01-05").head.head,
      "a COMMODITY unit is no longer an SMF from 1-4-2025",
    ).not.toBe("stcgDeemedSmf");
    // And a lot acquired BEFORE 1-4-2023 can never be one.
    expect(headOf(LIQUIDBEES, "2023-03-31", "2026-01-05").head.head).not.toBe("stcgDeemedSmf");
  });

  it("case 4 · an unlisted INF ISIN the bundled list does not carry: billed at the equity-SHARE rate, head BLANK, and NAMED on the Data Quality card", () => {
    // ── 3a: the overlay must NOT fire and must NOT throw — the whole rate card
    // is the product row, key for key.
    expect(ratesOf(UNLISTED), "an unknown INF ISIN prices exactly as it did before the list existed").toEqual(
      row("eq_delivery"),
    );
    expect(
      sttOf(UNLISTED, { buyValue: BUY_VALUE, sellValue: SELL_VALUE }),
      "the equity-share bill, to the rupee",
    ).toBe(sttOf(SHARE, { buyValue: BUY_VALUE, sellValue: SELL_VALUE }));

    // ── 3b: "the list does not say" is NOT "an ordinary share".
    const h = headOf(UNLISTED, "2022-01-10", "2025-06-10");
    expect(h.assetClass, "INF = a fund unit of unknown class").toBe("undetermined");
    expect(
      [h.head.head, h.head.cell, h.head.term, h.head.ratePct, h.head.exemption],
      "blank, never a guessed 112A",
    ).toEqual(["undetermined", "UNDET", null, null, null]);
    expect(h.head.reasons.join(" "), "and the blank says WHY").toMatch(/bundled NSE list does not carry/i);

    // A blank head is REPORTED, never silently dropped (invariant 6).
    const rows = [qTrade({ id: 7, symbol: UNLISTED.symbol, isin: UNLISTED.isin })];
    expect(etfClassUndetermined(rows).map((x) => x.id)).toEqual([7]);
    const issue = etfClassIssue(rows);
    expect([issue?.severity, issue?.count], "the `etf_class` warning").toEqual(["warning", 1]);
    expect(issue?.detail).toContain(UNLISTED.symbol);
    expect(issue?.detail, "and it states the consequence on BOTH sides of this seam").toMatch(
      /STT is charged at the equity-share rate and their tax head is left blank/i,
    );

    // The deliberate NON-flag: a no-ISIN unknown ticker is an ordinary share.
    expect(etfClassUndetermined([qTrade({ symbol: "ABC", isin: null })])).toEqual([]);
    expect(assetClassFor({ segment: "eq_delivery", symbol: "ABC", isin: null })).toBe("share");
  });

  it("case 5 · the Hybrid-underlying ETF: the RATE is settled (etf_other, nothing) while the tax HEAD is undetermined — the two halves disagree BY DESIGN", () => {
    // ── 3a: `kind` is "other", so the rate row IS settled.
    const etfBill = sttOf(HYBRIDETF, { buyValue: BUY_VALUE, sellValue: SELL_VALUE });
    expect(ratesOf(HYBRIDETF).sttPct, "a hybrid unit is in no s.98 row either").toBe(row("etf_other").sttPct);
    expect(etfBill).toBe(impliedStt("etf_other", BOTH_SIDES));
    expect(etfBill).not.toBe(sttOf(SHARE, { buyValue: BUY_VALUE, sellValue: SELL_VALUE }));

    // ── 3b: the equity share of a hybrid portfolio is not published, so neither
    // the EOF test nor the SMF test can be applied. Blank, with a card.
    const h = headOf(HYBRIDETF, "2023-06-01", "2025-06-10");
    expect(h.assetClass, "settled for the RATE, unsettled for the HEAD").toBe("undetermined");
    expect([h.head.head, h.head.term, h.head.ratePct]).toEqual(["undetermined", null, null]);
    const issue = etfClassIssue([qTrade({ id: 9, symbol: HYBRIDETF.symbol, isin: HYBRIDETF.isin })]);
    expect([issue?.severity, issue?.count, issue?.ids]).toEqual(["warning", 1, [9]]);

    // And it never leaks into a taxable bucket.
    const g = classifyGain({
      segment: "eq_delivery",
      assetClass: h.assetClass,
      buyDate: "2023-06-01",
      sellDate: "2025-06-10",
      buyValue: BUY_VALUE,
      sellValue: SELL_VALUE,
      netPnl: 9800,
      sttCtt: 0,
    })!;
    expect(g.bucket, "an undetermined head lands in cgUndetermined, not 112A").toBe("cgUndetermined");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CASE 6 — the 3b-ii cross-check, on the real database.
//
//   e1  1000 @ 200   2024-06-10        (the conversion's own leg)
//   e2  1000 @ 240   2024-08-12
//   x1   600 @ 300   2025-02-10        <- a PARTIAL exit: the ladder stays OPEN
//
// Before 3b-ii the fill sat in NO tax year. Before 3a's `priceLegs` fix the
// SAME ladder was billed the equity-share STT on every leg while the identical
// flat trade paid the ETF rate. One instrument must produce one class on both
// sides of the seam: the ETF bill on the legs, and `equityFund` on the fill's
// realised row.
// ───────────────────────────────────────────────────────────────────────────

const LADDER = { entry1: 1000 * 200, entry2: 1000 * 240, exit1: 600 * 300 };

describe.skipIf(!HAVE_LIST)("case 6 · a STAGED NIFTYBEES ladder: the ETF bill on the legs and the ETF class on the fill", () => {
  let tradeId = 0;
  let staged: typeof import("@/lib/queries/staged");
  let taxItr: typeof import("@/lib/queries/tax-itr");
  let planAccountOf: (typeof import("@/lib/queries/broker-plan"))["planAccountOf"];

  beforeAll(async () => {
    staged = await import("@/lib/queries/staged");
    taxItr = await import("@/lib/queries/tax-itr");
    ({ planAccountOf } = await import("@/lib/queries/broker-plan"));

    t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();
    tradeId = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: 1,
          broker: BROKER,
          exchange: EXCHANGE,
          segment: "eq_delivery",
          symbol: NIFTYBEES.symbol,
          tradingsymbol: NIFTYBEES.symbol,
          isin: NIFTYBEES.isin,
          buyQty: 1000,
          avgBuyPrice: 200,
          buyValue: LADDER.entry1,
          buyDate: "2024-06-10",
          isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

    // THE REAL WRITE PATH — `rebuildStagedTrade` reprices the whole ladder
    // through `priceLegs`, handing it the parent's isin/symbol (wave 3a).
    expect(staged.convertToStaged(tradeId).ok, "staged mode on").toBe(true);
    for (const leg of [
      { kind: "entry" as const, tradeDate: "2024-08-12", qty: 1000, price: 240 },
      { kind: "exit" as const, tradeDate: "2025-02-10", qty: 600, price: 300 },
    ]) {
      const res = staged.addLeg({ tradeId, direction: "long", ...leg });
      expect(res.ok, `${leg.kind} ${leg.tradeDate}: ${res.message}`).toBe(true);
    }
  });

  /** Price the STORED ladder through the real `priceLegs`, with and without the instrument. */
  const priced = (withInstrument: boolean) => {
    const view = staged.getStagedView(tradeId)!;
    return staged.priceLegs(
      staged.toDomainLegs(view.legs),
      {
        broker: BROKER,
        segment: "eq_delivery",
        exchange: EXCHANGE,
        direction: "long",
        ...(withInstrument ? { isin: NIFTYBEES.isin, symbol: NIFTYBEES.symbol } : {}),
        mtfFundedAmount: null,
        planAccount: planAccountOf(1),
      },
      map,
    );
  };

  it("the legs are billed the ETF STT, not the equity-share STT — wave 3a's `priceLegs` fix, through the ladder the writer stored", () => {
    const withEtf = priced(true);
    const asShare = priced(false);
    expect(withEtf.length, "two entries and one exit").toBe(3);

    const stt = (ls: ReturnType<typeof priced>) => ls.map((l) => l.breakdown.sttCtt);
    // Seller-side only, at the etf_equity row's own rate: nothing on either entry.
    expect(stt(withEtf), "the etf_equity row, on the exit leg alone").toEqual([
      0,
      0,
      impliedStt("etf_equity", LADDER.exit1),
    ]);
    // The identical ladder with the instrument dropped — what it was billed before 3a.
    expect(stt(asShare), "0.1% both sides, every leg").toEqual([
      impliedStt("eq_delivery", LADDER.entry1),
      impliedStt("eq_delivery", LADDER.entry2),
      impliedStt("eq_delivery", LADDER.exit1),
    ]);
    expect(stt(withEtf), "and the two are not the same bill").not.toEqual(stt(asShare));

    // What the database actually STORES is the ETF bill, not the share bill.
    const storedTotal =
      (
        t.sqlite
          .prepare("SELECT SUM(charges_total_paise) AS c FROM trade_legs WHERE trade_id = ?")
          .get(tradeId) as { c: number }
      ).c / 100; // paise in the DB, rupees at runtime (invariant 1)
    const sum = (ls: ReturnType<typeof priced>) => Math.round(ls.reduce((s, l) => s + l.chargesTotal, 0) * 100) / 100;
    expect(storedTotal, "the ladder on disk was priced through the ETF door").toBe(sum(withEtf));
    expect(storedTotal, "and NOT at the equity-share rate").not.toBe(sum(asShare));
  });

  it("the fill's realised row carries the ETF identity, so the tax base classes it per FILL as an equity-oriented UNIT — never the default `share`", () => {
    const base = taxItr.getTaxBase();
    expect(base.scope.accountIds, "one account, one tax person").toEqual([1]);

    // 3b-ii: the partial exit is realised although the ladder is still OPEN.
    expect(base.taxRows.length, "one row for the one fill — before 3b-ii there were none").toBe(1);
    const fill = base.taxRows[0];
    expect([fill.buyDate, fill.sellDate], "the FIFO tranche's date and the fill's own").toEqual([
      "2024-06-10",
      "2025-02-10",
    ]);
    expect(fill.sellValue, "600 x 300").toBe(LADDER.exit1);

    // ── THE SEAM: wave 3a's identity, read by wave 3b, on a row 3b-ii created.
    expect(fill.assetClass, "NIFTYBEES is an equity-oriented FUND UNIT, not a share").toBe("equityFund");
    expect(
      base.cgTrades.map((c) => c.assetClass),
      "and the set-off engine reads the same class",
    ).toEqual(["equityFund"]);

    // …and the head that class takes: bought 2024-06-10, sold 2025-02-10 -> s.111A.
    const g = classifyGain(base.cgTrades[0])!;
    expect([g.bucket, g.head?.head, g.head?.term]).toEqual(["stcg111A", "stcg111A", "ST"]);
    // The STT the ladder was billed is added back in the CG bucket (proviso to
    // s.48) — an ETF ladder adds back the ETF bill, not a share's.
    expect(g.addedBackStt, "the etf_equity bill on the realised share of the ladder, not the share bill").toBeLessThan(
      impliedStt("eq_delivery", LADDER.exit1),
    );
  });
});
