import type { Broker, Exchange, Segment } from "../domain/constants";
import type { EtfRateSegment } from "../engine/etf-class";

/**
 * The canonical rate table: every broker's card, as one row per EPOCH of each
 * (broker, plan, segment, exchange) key. Everything here is a fraction of
 * turnover/premium (0.1% => 0.001) unless noted.
 *
 * The broker-set figures (brokerage, DP, MTF) are today's cards and carry no
 * history. The levies that have moved are EFFECTIVE-DATED: F&O and equity
 * delivery STT (the STT SCHEDULES below, one boundary per NSE FATAX circular) and the exchange
 * transaction charge + NSE IPFT (the EXCHANGE CHARGE EPOCHS below). A key is
 * split at the UNION of its boundaries; a key whose levies never moved keeps one
 * open-ended row.
 * These values seed `charge_config`; the engine reads only from the DB at runtime.
 */

type ChargeSeedRow = {
  broker: Broker;
  plan: string;
  planLabel: string | null;
  subscriptionMonthly: number;
  segment: Segment;
  exchange: Exchange;
  brokerageFlat: number | null;
  brokeragePct: number;
  brokerageCap: number | null;
  brokerageFloor: number;
  sttPct: number;
  sttSide: "both" | "buy" | "sell" | "none";
  exchangeTxnPct: number;
  sebiPct: number;
  stampPct: number;
  ipftPct: number;
  gstPct: number;
  dpCharge: number;
  dpPct: number;
  dpGstApplicable: boolean;
  dpMinValue: number;
  mtfInterestAnnual: number;
  mtfRateUnknown: boolean;
  mtfTiers: { upTo: number | null; rate: number }[] | null;
  pledgeCharge: number;
  unpledgeCharge: number;
  /** Start of this rate's window, inclusive. Absent = covers all history. */
  effectiveFrom?: string;
  /** End of this rate's window, EXCLUSIVE. Absent/null = open-ended. */
  effectiveTo?: string | null;
};

const SEBI_PCT = 0.000001; // 0.0001% = ₹10/crore, both sides
const GST = 0.18;
/** The seed's lower bound: an epoch starting here covers all earlier history. */
const EPOCH_START = "1970-01-01";

// --- STT / CTT by segment, EFFECTIVE-DATED -----------------------------------
/**
 * THE F&O STT SCHEDULES (v4.3.0 R1; owner ruling: from a verified primary
 * source only, as C-8; rates only — charges already stored on trades are not
 * rewritten). Every boundary is read from an NSE circular, all fetched
 * 2026-09-11 (SHA-256 in LIVE-DESK-RESEARCH/_data/stt-primary-sources-2026-09-11):
 *
 *   https://nsearchives.nseindia.com/content/circulars/FATAX23500.pdf
 *     Circular 1/2013, 24 May 2013 (Finance Act 2013): "Sale of a futures in
 *     securities: 0.017 per cent till 31.05.2013, 0.01 per cent from
 *     01.06.2013"; the sale of an option stays at 0.017 per cent.
 *   https://nsearchives.nseindia.com/content/circulars/FATAX27711.pdf
 *     Circular 1/2014, 29 Sep 2014: "4(a) 0.017 per cent; 4(b) 0.125 per cent
 *     Purchaser; 4(c) 0.01 per cent".
 *   https://nsearchives.nseindia.com/content/circulars/FATAX32385.pdf
 *     Circular 2/2016, 16 May 2016 (Finance Act 2016): STT on sale of option
 *     "revised from current rate of 0.017% to 0.05% with effect from 01st day
 *     of June, 2016". Futures did not move.
 *   https://nsearchives.nseindia.com/content/circulars/FATAX56235.pdf
 *     Circular 2/2023, 1 Apr 2023 (Finance Act 2023): option "0.0625% (upto
 *     March 31, 2023 – 0.05%)"; futures "0.0125% (upto March 31, 2023 – 0.01%)".
 *   https://nsearchives.nseindia.com/content/circulars/FATAX63809.pdf
 *     Circular 2/2024, 9 Sep 2024 (Finance (No. 2) Act 2024): "Sale of an
 *     option in securities has been revised to 0.10% (upto September 30, 2024
 *     - 0.0625%)"; futures 0.0125% → 0.02%, both from 1 Oct 2024.
 *   https://nsearchives.nseindia.com/content/circulars/FATAX73524.pdf
 *     Circular 02/2026, 31 Mar 2026 (Finance Act 2026, assent 30 Mar 2026):
 *
 * | Circular row | Transaction                          | ≤ 31-Mar-2026 | ≥ 1-Apr-2026 | Payable by |
 * |--------------|--------------------------------------|---------------|--------------|------------|
 * | 4(a)         | Sale of an option in securities      | 0.10%         | **0.15%**    | Seller     |
 * | 4(b)         | Sale of an option, where exercised   | 0.125%        | **0.15%**    | Purchaser  |
 * | 4(c)         | Sale of a futures in securities      | 0.02%         | **0.05%**    | Seller     |
 * | 1 & 2        | Equity delivery, purchase and sale   | 0.1%          | 0.1% (No Change) | both   |
 * | 3            | Equity sale settled otherwise (intraday) | 0.025%    | 0.025% (No Change) | Seller |
 *
 * THE UNVERIFIED START. The 0.017% regime came in with the Finance Act 2008,
 * whose NSE circular (NSE/F&A/10706) returns 404, so when it began is not
 * verified. Per the owner's C-8 ruling (06-ANSWERS: before the earliest
 * verified boundary the EARLIEST VERIFIED schedule applies, and the gap is
 * recorded) the 0.017% rows are extended back to 1970.
 *
 * Stock options take the index-option rate: the levy is one line for both
 * ("sale of an option in securities"). Before this schedule the seed had three
 * STT windows (1970, 1 Oct 2024, 1 Apr 2026), so every F&O sale before
 * 1 Apr 2023 was priced at the Finance Act 2023 rates: 1.25× on futures and
 * options after the 2013/2016 changes, 3.7× on options sold before June 2016,
 * and 0.74× on futures sold before June 2013.
 *
 * THE EQUITY DELIVERY STT SCHEDULE (v4.3.0 QS-EQ2012; the same owner ruling,
 * rates only — charges already stored on trades are not rewritten):
 *
 *   https://nsearchives.nseindia.com/content/circulars/FATAX20990.pdf
 *     Circular 1/2012, 12 Jun 2012 (Finance Act 2012, assent 28 May 2012),
 *     "Effective rate till 30.06.2012 / New rate from 01.07.2012":
 *       row 1, purchase of an equity share, settled by actual delivery:
 *         "0.125 per cent / 0.1 per cent", Purchaser
 *       row 2, sale of an equity share, settled by actual delivery:
 *         "0.125 per cent / 0.1 per cent", Seller
 *       row 3, sale settled otherwise than by actual delivery:
 *         "0.025 per cent / 0.025 per cent (no change)", Seller
 *
 * eq_delivery and eq_mtf (an MTF buy and sell settle by delivery) take rows 1
 * and 2: 0.125% both sides before 1 Jul 2012, 0.1% from it. When the 0.125%
 * rate began is NOT verified (the circular cites NSE/F&A/7526 of 26 May 2006,
 * which is not fetched), so it is extended back to 1970 under the same C-8
 * ruling. Commodity segments carry CTT, a different levy under a different head.
 */
export const STT_EPOCH_2026 = "2026-04-01";
/** Finance (No. 2) Act 2024 (FATAX63809): futures 0.0125% → 0.02%, options 0.0625% → 0.10%. */
export const STT_EPOCH_2024 = "2024-10-01";
/** Finance Act 2023 (FATAX56235): futures 0.01% → 0.0125%, options 0.05% → 0.0625%. */
const STT_EPOCH_2023 = "2023-04-01";
/** Finance Act 2016 (FATAX32385): options 0.017% → 0.05% of premium. Futures did not move. */
const STT_EPOCH_2016 = "2016-06-01";
/** Finance Act 2013 (FATAX23500): futures 0.017% → 0.01%. Options did not move. */
const STT_EPOCH_2013 = "2013-06-01";
/** Finance Act 2012 (FATAX20990): equity delivery STT 0.125% → 0.1%, purchaser and seller. */
export const STT_EPOCH_2012 = "2012-07-01";

/** One dated STT regime, in force from `from` (inclusive) to the next entry's `from`. */
type SttLevy = { from: string; pct: number; side: "both" | "sell" | "none" };

/** Row 4(c): sale of a futures in securities — seller, on traded value. */
const STT_FUTURES: SttLevy[] = [
  { from: EPOCH_START, pct: 0.00017, side: "sell" }, // FATAX23500 "till 31.05.2013"; start unverified, extended back
  { from: STT_EPOCH_2013, pct: 0.0001, side: "sell" }, // FATAX23500
  { from: STT_EPOCH_2023, pct: 0.000125, side: "sell" }, // FATAX56235
  { from: STT_EPOCH_2024, pct: 0.0002, side: "sell" }, // FATAX63809
  { from: STT_EPOCH_2026, pct: 0.0005, side: "sell" }, // FATAX73524
];
/** Row 4(a): sale of an option in securities — seller, on premium. Index and stock options alike. */
const STT_OPTIONS: SttLevy[] = [
  { from: EPOCH_START, pct: 0.00017, side: "sell" }, // FATAX23500 / FATAX27711; start unverified, extended back
  { from: STT_EPOCH_2016, pct: 0.0005, side: "sell" }, // FATAX32385
  { from: STT_EPOCH_2023, pct: 0.000625, side: "sell" }, // FATAX56235
  { from: STT_EPOCH_2024, pct: 0.001, side: "sell" }, // FATAX63809
  { from: STT_EPOCH_2026, pct: 0.0015, side: "sell" }, // FATAX73524
];

/** FATAX20990 rows 1 & 2: purchase and sale of an equity share settled by delivery — both sides, on traded value. */
const STT_DELIVERY: SttLevy[] = [
  { from: EPOCH_START, pct: 0.00125, side: "both" }, // FATAX20990 "0.125 per cent" till 30.06.2012; start unverified, extended back
  { from: STT_EPOCH_2012, pct: 0.001, side: "both" }, // FATAX20990 "0.1 per cent" from 01.07.2012; FATAX73524 rows 1 & 2, No Change
];

/**
 * THE ETF STT ROWS (v4.5.0 wave 3a; ruling R90, 06-ANSWERS "v4.3.0 wave-3
 * ruling", 2026-09-15, verbatim: "ETF units are charged equity-share delivery
 * STT (0.1% both sides); the statute charges 0.001% on the sale of
 * equity-oriented fund units (since 2013-06-01) and nothing on
 * gold/silver/debt/liquid/international ETFs").
 *
 * `etf_equity` and `etf_other` are RATE ROWS, not segments a trade can carry —
 * an ETF trade is still `eq_delivery` / `eq_intraday` / `eq_mtf`. They are read
 * for STT/CTT ONLY (`ratesForTrade`'s overlay in lib/engine/rates.ts);
 * brokerage, DP, stamp, exchange, SEBI, IPFT, the GST base and MTF interest all
 * come from the trade's OWN product row, so every other column here is 0 and is
 * never read. Keeping the rates in `charge_config` rather than in the overlay is
 * invariant 3: an operator edit still governs, and no rate is a literal in logic.
 *
 * SOURCES for the two numbers:
 *   0.001% SELLER, from 1 Jun 2013 — Finance Act 2013 inserting Sl. No. 2A in
 *   s.98 of the Finance (No. 2) Act 2004: "Sale of a unit of an equity oriented
 *   fund, where— (a) the transaction of such sale is entered into in a
 *   recognised stock exchange; and (b) the contract for the sale of such unit is
 *   settled by the actual delivery or transfer of such unit … 0.001 per cent …
 *   Seller" (LIVE-DESK-RESEARCH/_data/stt-primary-sources-2026-09-11/bill2013.pdf,
 *   the Bill as introduced; the enacted consolidated text could not be retrieved
 *   — recorded as corroboration-only in W3-TAX-DOSSIER §F.3, and the ruling
 *   states the same rate and date).
 *   NIL on a non-equity-oriented unit — it appears in NO row of the s.98 table
 *   at all (`incometaxindia-STT-s98-table-consolidated-capture-2026-09-15.html`),
 *   which is why `etf_other` carries 0 with side "none" rather than a rate.
 *
 * BEFORE 1 Jun 2013 an equity-oriented unit keeps the EQUITY-SHARE delivery
 * schedule (0.125% both sides to 30 Jun 2012, 0.1% from 1 Jul 2012). Row 2A was
 * an INSERTION, and no separate pre-2013 unit entry is in the research folder —
 * so under the C-8 ruling (before the earliest verified boundary the earliest
 * verified schedule applies, and the gap is recorded) the pre-2013 windows are
 * exactly what the app already charged. R90 corrects the rate from 2013-06-01
 * on; nothing earlier moves.
 */
/** Finance Act 2013: Sl. 2A, sale of an equity-oriented fund unit, delivery-based. */
const STT_EPOCH_ETF_2013 = "2013-06-01";
const STT_ETF_EQUITY: SttLevy[] = [
  ...STT_DELIVERY,
  { from: STT_EPOCH_ETF_2013, pct: 0.00001, side: "sell" },
];
const STT_ETF_OTHER: SttLevy[] = [{ from: EPOCH_START, pct: 0, side: "none" }];

/** A segment's STT schedule, oldest first. F&O and equity delivery carry history. */
function sttScheduleFor(segment: Segment): SttLevy[] {
  switch (segment) {
    case "future":
      return STT_FUTURES;
    case "index_option":
    case "stock_option":
      return STT_OPTIONS;
    case "eq_delivery":
    case "eq_mtf":
      return STT_DELIVERY;
    case "eq_intraday":
      return [{ from: EPOCH_START, pct: 0.00025, side: "sell" }]; // 0.025% sell (FATAX73524 row 3, No Change)
    case "commodity_future":
      return [{ from: EPOCH_START, pct: 0.0001, side: "sell" }]; // CTT 0.01% sell — a different levy
    case "commodity_option":
      return [{ from: EPOCH_START, pct: 0.0005, side: "sell" }]; // CTT 0.05% sell — a different levy
  }
}

// --- Exchange transaction charges + NSE IPFT, EFFECTIVE-DATED ----------------
/**
 * THE EXCHANGE CHARGE EPOCHS (v4.3.0 C-8; owner ruling: fix every figure a
 * skeptic CONFIRMED against the exchange's own circular, rates only — charges
 * already stored on trades are not rewritten). Each side, as a fraction of
 * traded value (of PREMIUM for options). Before 1 Oct 2024 NSE and BSE charged
 * slab-wise on a member's monthly turnover; the seed carries the TOP slab, the
 * rate brokers billed clients (Zerodha's page, Jul 2024: 0.00322% / 0.00188% /
 * 0.0495%).
 *
 * IPFT is a SEPARATE line in NSE's circulars and a separate column here. Folding
 * it into the transaction charge double-counts: from 1 Mar 2026 the charge is
 * Rs 306.99/crore AND IPFT Rs 0.01/crore (307 in all), not 306.99 + 10.
 *
 * NSE  (circular · dated · effective → cash / futures / options per LAKH; IPFT per CRORE)
 *   NSE/FA/46730 (15/2020) · 18 Dec 2020 · 1 Jan 2021 → 3.45 / 2.00 / 53.00;  IPFT 0.01
 *   NSE/FA/56129 (1/2023)  · 24 Mar 2023 · 1 Apr 2023 → 3.25 / 1.90 / 50.00;  IPFT 10 cash+futures, 50 options
 *   NSE/FA/61137 (2/2024)  · 14 Mar 2024 · 1 Apr 2024 → 3.22 / 1.88 / 49.50;  IPFT unchanged
 *   NSE/FA/64232 (5/2024)  · 27 Sep 2024 · 1 Oct 2024 → 2.97 / 1.73 / 35.03 flat (SEBI "true to label",
 *                                                       SEBI/HO/MRD/TPD-1/P/CIR/2024/92, 1 Jul 2024); IPFT unchanged
 *   NSE/FA/73061           · 27 Feb 2026 · 1 Mar 2026 → Rs 306.99 / 182.99 / 3,552.99 per crore; IPFT back to 0.01
 * BSE equity cash, Group A / B / non-exclusive scrips (no BSE IPFT is seeded: 0)
 *   20210210-42 · 10 Feb 2021 · 1 Mar 2021 → slab Rs 345…320/crore, top slab 345
 *   20221109-7  ·  9 Nov 2022 · 1 Dec 2022 → Rs 375/crore flat, unchanged since
 * BSE equity derivatives
 *   20190819-14 · 19 Aug 2019 · 20 Aug 2019 → every product waived
 *   20220425-2  · 25 Apr 2022 · 2 May 2022  → all options Rs 500/crore of premium; futures stay NIL
 *   20231020-46 · 20 Oct 2023 · 1 Nov 2023  → Sensex options, nearest expiry: slab, top Rs 3,750/crore
 *   20240430-42 · 30 Apr 2024 · 13 May 2024 → Sensex + Bankex options, all expiries: slab, top Rs 4,950/crore
 *   20240927-37 · 27 Sep 2024 · 1 Oct 2024  → Sensex + Bankex Rs 3,250/crore flat; stock and Sensex 50
 *                                             options stay Rs 500/crore; index and stock futures NIL
 *
 * Before the earliest verified boundary the EARLIEST VERIFIED schedule applies
 * (owner ruling), and the gap is recorded rather than guessed: NSE 1970 → 1 Apr
 * 2023 takes FA46730 (whose start before 1 Jan 2021 is unverified); BSE cash
 * 1970 → 1 Dec 2022 takes the 20210210-42 top slab (verified from 1 Mar 2021);
 * BSE options 1970 → 2 May 2022 take the 20 Aug 2019 waiver.
 *
 * The card has ONE BSE index_option rate, so it follows Sensex/Bankex (owner
 * ruling). Sensex 50 options, and from 1 Nov 2023 to 13 May 2024 Bankex and the
 * non-nearest Sensex expiries (Rs 500/crore), stay mis-priced: a per-contract
 * key needs a schema change. The seed has no BSE `future` row (BSE futures are NIL).
 *
 * MCX carries no history and is UNCHANGED: MCX/F&A/631/2024 (1 Oct 2024) is
 * verified, its 2021 predecessors could not be retrieved.
 */
const IPFT_NSE_PCT = 0.000000001; // Rs 0.01/crore — before 1 Apr 2023, and again from 1 Mar 2026
const IPFT_NSE_CASH_FUT_2023 = 0.000001; // Rs 10/crore, cash + futures, 1 Apr 2023 → 1 Mar 2026 (FA56129)
const IPFT_NSE_OPT_2023 = 0.000005; // Rs 50/crore of premium, options, same window

/** One dated exchange schedule entry, in force from `from` (inclusive) to the next entry's `from`. */
type ExchangeLevy = { from: string; txn: number; ipft: number };

const NSE_CASH: ExchangeLevy[] = [
  { from: EPOCH_START, txn: 0.0000345, ipft: IPFT_NSE_PCT }, // FA46730, extended back
  { from: "2023-04-01", txn: 0.0000325, ipft: IPFT_NSE_CASH_FUT_2023 }, // FA56129
  { from: "2024-04-01", txn: 0.0000322, ipft: IPFT_NSE_CASH_FUT_2023 }, // FA61137
  { from: "2024-10-01", txn: 0.0000297, ipft: IPFT_NSE_CASH_FUT_2023 }, // FA64232
  { from: "2026-03-01", txn: 0.000030699, ipft: IPFT_NSE_PCT }, // FA73061
];
const NSE_FUTURES: ExchangeLevy[] = [
  { from: EPOCH_START, txn: 0.00002, ipft: IPFT_NSE_PCT }, // FA46730, extended back
  { from: "2023-04-01", txn: 0.000019, ipft: IPFT_NSE_CASH_FUT_2023 }, // FA56129
  { from: "2024-04-01", txn: 0.0000188, ipft: IPFT_NSE_CASH_FUT_2023 }, // FA61137
  { from: "2024-10-01", txn: 0.0000173, ipft: IPFT_NSE_CASH_FUT_2023 }, // FA64232
  { from: "2026-03-01", txn: 0.000018299, ipft: IPFT_NSE_PCT }, // FA73061
];
const NSE_OPTIONS: ExchangeLevy[] = [
  { from: EPOCH_START, txn: 0.00053, ipft: IPFT_NSE_PCT }, // FA46730, extended back
  { from: "2023-04-01", txn: 0.0005, ipft: IPFT_NSE_OPT_2023 }, // FA56129
  { from: "2024-04-01", txn: 0.000495, ipft: IPFT_NSE_OPT_2023 }, // FA61137
  { from: "2024-10-01", txn: 0.0003503, ipft: IPFT_NSE_OPT_2023 }, // FA64232
  { from: "2026-03-01", txn: 0.000355299, ipft: IPFT_NSE_PCT }, // FA73061
];
const BSE_CASH: ExchangeLevy[] = [
  { from: EPOCH_START, txn: 0.0000345, ipft: 0 }, // 20210210-42 top slab, extended back
  { from: "2022-12-01", txn: 0.0000375, ipft: 0 }, // 20221109-7
];
const BSE_STOCK_OPTIONS: ExchangeLevy[] = [
  { from: EPOCH_START, txn: 0, ipft: 0 }, // 20190819-14 waiver, extended back
  { from: "2022-05-02", txn: 0.00005, ipft: 0 }, // 20220425-2, unchanged by 20240927-37
];
const BSE_INDEX_OPTIONS: ExchangeLevy[] = [
  { from: EPOCH_START, txn: 0, ipft: 0 }, // 20190819-14 waiver, extended back
  { from: "2022-05-02", txn: 0.00005, ipft: 0 }, // 20220425-2
  { from: "2023-11-01", txn: 0.000375, ipft: 0 }, // 20231020-46, Sensex nearest-expiry top slab
  { from: "2024-05-13", txn: 0.000495, ipft: 0 }, // 20240430-42, Sensex + Bankex top slab
  { from: "2024-10-01", txn: 0.000325, ipft: 0 }, // 20240927-37
];

/** The exchange schedule for a seeded (segment, exchange), oldest first. */
function exchangeScheduleFor(segment: Segment, exchange: Exchange): ExchangeLevy[] {
  const isEq = segment === "eq_delivery" || segment === "eq_mtf" || segment === "eq_intraday";
  if (exchange === "NSE") {
    if (isEq) return NSE_CASH;
    if (segment === "index_option" || segment === "stock_option") return NSE_OPTIONS;
    if (segment === "future") return NSE_FUTURES;
  }
  if (exchange === "BSE") {
    if (isEq) return BSE_CASH;
    if (segment === "index_option") return BSE_INDEX_OPTIONS;
    if (segment === "stock_option") return BSE_STOCK_OPTIONS;
  }
  if (exchange === "MCX") {
    if (segment === "commodity_future") return [{ from: EPOCH_START, txn: 0.000021, ipft: 0 }];
    if (segment === "commodity_option") return [{ from: EPOCH_START, txn: 0.000418, ipft: 0 }];
  }
  // A combo with no verified schedule must not be seeded at a guessed 0.
  throw new Error(`No verified exchange-charge schedule for ${segment} on ${exchange}`);
}

/** The entry of an oldest-first schedule in force on `on`. */
function inForce<T extends { from: string }>(schedule: T[], on: string): T {
  let hit = schedule[0];
  for (const e of schedule) if (e.from <= on) hit = e;
  return hit;
}

// --- Stamp duty (BUY side) by segment ---------------------------------------
function stampFor(segment: Segment): number {
  switch (segment) {
    case "eq_delivery":
    case "eq_mtf":
      return 0.00015; // 0.015%
    case "eq_intraday":
      return 0.00003; // 0.003%
    case "future":
    case "commodity_future":
      return 0.00002; // 0.002%
    case "index_option":
    case "stock_option":
    case "commodity_option":
      return 0.00003; // 0.003%
  }
}

// --- Brokerage by broker + segment ------------------------------------------
function brokerageFor(
  broker: Broker,
  segment: Segment,
): { flat: number | null; pct: number; cap: number | null; floor: number } {
  const FLAT20 = { flat: 20, pct: 0, cap: null as number | null, floor: 0 };
  const ZERO = { flat: 0, pct: 0, cap: null as number | null, floor: 0 };

  if (broker === "zerodha") {
    switch (segment) {
      case "eq_delivery":
        return ZERO;
      case "eq_mtf":
        return { flat: null, pct: 0.003, cap: 20, floor: 0 }; // min(20, 0.3%)
      case "eq_intraday":
      case "future":
      case "commodity_future":
        return { flat: null, pct: 0.0003, cap: 20, floor: 0 }; // min(20, 0.03%)
      case "index_option":
      case "stock_option":
      case "commodity_option":
        return FLAT20;
    }
  }

  if (broker === "dhan") {
    switch (segment) {
      case "eq_delivery":
        return ZERO;
      case "eq_mtf":
      case "eq_intraday":
        return { flat: null, pct: 0.0003, cap: 20, floor: 0 }; // min(20, 0.03%)
      case "future":
      case "commodity_future":
      case "index_option":
      case "stock_option":
      case "commodity_option":
        return FLAT20;
    }
  }

  // Angel One — angelone.in: equity DELIVERY IS FREE (₹0); flat ₹20 on
  // intraday, F&O, currency and commodity. Previously seeded as "₹20 or 0.1%",
  // which overstated every delivery trade.
  if (broker === "angelone") {
    switch (segment) {
      case "eq_delivery":
        return ZERO;
      case "eq_mtf":
      case "eq_intraday":
      case "future":
      case "commodity_future":
      case "index_option":
      case "stock_option":
      case "commodity_option":
        return FLAT20;
    }
  }

  // Upstox BASIC (the free default) — upstox.com/help-center/t-248665, read
  // 2026-09-22. Delivery and MTF are "₹20 or 2.5%, whichever is lower"; only
  // INTRADAY is the 0.1% form. D2 (v4.5.0): all three were seeded at 0.1%,
  // which under-billed every Upstox delivery order below ₹20,000 (a ₹5,000 buy
  // priced ₹5 where Upstox bills ₹20). The cap is unchanged at ₹20.
  if (broker === "upstox") {
    switch (segment) {
      case "eq_delivery":
      case "eq_mtf":
        return { flat: null, pct: 0.025, cap: 20, floor: 0 }; // min(20, 2.5%)
      case "eq_intraday":
        return { flat: null, pct: 0.001, cap: 20, floor: 0 }; // min(20, 0.1%)
      case "future":
      case "commodity_future":
      case "index_option":
      case "stock_option":
      case "commodity_option":
        return FLAT20;
    }
  }

  // Kotak Neo — "Trade Free Plan" (free, lifetime), the default a new account
  // gets. kotakneo.com/pricing: 0.20% delivery; intraday "₹10 or 0.05%,
  // whichever is LOWER" (a cap, not a floor); ₹10 F&O carry-forward.
  // MTF follows the delivery rate — MTF is a delivery product and Kotak
  // publishes no separate MTF brokerage.
  if (broker === "kotakneo") {
    switch (segment) {
      case "eq_delivery":
      case "eq_mtf":
        return { flat: null, pct: 0.002, cap: null, floor: 0 }; // 0.20%
      case "eq_intraday":
        return { flat: null, pct: 0.0005, cap: 10, floor: 0 }; // min(10, 0.05%)
      case "future":
      case "commodity_future":
      case "index_option":
      case "stock_option":
      case "commodity_option":
        return { flat: 10, pct: 0, cap: null, floor: 0 };
    }
  }

  // Paytm Money — paytmmoney.com/stocks/pricing.
  // Delivery "2.5% or up to ₹20, whichever is lower"; intraday "0.05% or up to
  // ₹20, whichever is lower"; F&O up to ₹20/executed order.
  // MTF is billed at "0.1% of trade value OR current brokerage, whichever is
  // HIGHER" — a floor, not a cap, and 0.1% dominates at any real size.
  if (broker === "paytm") {
    switch (segment) {
      case "eq_delivery":
        return { flat: null, pct: 0.025, cap: 20, floor: 0 }; // min(20, 2.5%)
      case "eq_intraday":
        return { flat: null, pct: 0.0005, cap: 20, floor: 0 }; // min(20, 0.05%)
      case "eq_mtf":
        return { flat: null, pct: 0.001, cap: null, floor: 0 }; // 0.1%, uncapped
      case "future":
      case "commodity_future":
      case "index_option":
      case "stock_option":
      case "commodity_option":
        return FLAT20;
    }
  }

  // Sahi — sahi.com/pricing. Flat ₹10/order across segments; equity (BOTH
  // delivery and intraday) is "₹10 or 0.05%, whichever is lower". Note that
  // delivery is NOT free here, unlike most discount brokers.
  if (broker === "sahi") {
    switch (segment) {
      case "eq_delivery":
      case "eq_intraday":
      case "eq_mtf":
        return { flat: null, pct: 0.0005, cap: 10, floor: 0 }; // min(10, 0.05%)
      case "future":
      case "commodity_future":
      case "index_option":
      case "stock_option":
      case "commodity_option":
        return { flat: 10, pct: 0, cap: null, floor: 0 };
    }
  }

  // groww
  switch (segment) {
    case "eq_delivery":
    case "eq_intraday":
      return { flat: null, pct: 0.001, cap: 20, floor: 5 }; // min(20, 0.1%) floored at 5
    case "eq_mtf":
      return { flat: null, pct: 0.001, cap: null, floor: 0 }; // 0.1%/order
    case "future":
    case "commodity_future":
    case "index_option":
    case "stock_option":
    case "commodity_option":
      return FLAT20;
  }
}

// --- DP charges (delivery + MTF sell, per scrip) by broker ------------------
function dpFor(broker: Broker): {
  dpCharge: number;
  dpPct?: number;
  dpGstApplicable: boolean;
  dpMinValue: number;
} {
  switch (broker) {
    case "zerodha":
      return { dpCharge: 15.34, dpGstApplicable: false, dpMinValue: 0 }; // incl GST
    case "dhan":
      return { dpCharge: 12.5, dpGstApplicable: true, dpMinValue: 0 };
    case "groww":
      return { dpCharge: 20.0, dpGstApplicable: true, dpMinValue: 100 }; // 3.5 + 16.5
    case "angelone":
      return { dpCharge: 20.0, dpGstApplicable: true, dpMinValue: 0 };
    // D3 (v4.5.0, owner ruling U2): upstox.com/brokerage-charges states "₹ 20.0
    // per scrip per day only on sell" (read 2026-09-22), not the 18.50 seeded
    // here. The date it changed is published nowhere, so the whole history
    // prices at ₹20 in FUTURE previews; no stored charge moves either way.
    case "upstox":
      return { dpCharge: 20.0, dpGstApplicable: true, dpMinValue: 0 };
    // Kotak Neo bills DP as a PERCENTAGE with a floor: 0.04% of the value
    // sold, minimum ₹20, per scrip per day on delivery/BTST sells. It is the
    // only broker here that does, which is why `dpPct` exists at all.
    case "kotakneo":
      return { dpCharge: 20, dpPct: 0.0004, dpGstApplicable: true, dpMinValue: 0 };
    // Paytm Money: ₹20 from 1 Feb 2025 (incl ₹3.50 CDSL), excluding GST.
    case "paytm":
      return { dpCharge: 20, dpGstApplicable: true, dpMinValue: 0 };
    // Sahi: ₹13.50 per company on SELL transactions.
    case "sahi":
      return { dpCharge: 13.5, dpGstApplicable: true, dpMinValue: 0 };
  }
}

// --- MTF interest by broker --------------------------------------------------
function mtfFor(broker: Broker): {
  mtfInterestAnnual: number;
  mtfRateUnknown?: boolean;
  mtfTiers: { upTo: number | null; rate: number }[] | null;
  pledgeCharge: number;
  unpledgeCharge: number;
} {
  switch (broker) {
    case "dhan":
      return {
        mtfInterestAnnual: 0, // tiered
        mtfTiers: [
          { upTo: 500000, rate: 0.1249 },
          { upTo: 1000000, rate: 0.1349 },
          { upTo: 2500000, rate: 0.1449 },
          { upTo: null, rate: 0.1549 },
        ],
        pledgeCharge: 20,
        unpledgeCharge: 20,
      };
    case "zerodha":
      return {
        mtfInterestAnnual: 0.146, // 0.04%/day per Zerodha's own MTF calculator
        mtfTiers: null,
        pledgeCharge: 15, // ₹15 + GST per ISIN per pledge request (zerodha.com/calculators/mtf-calculator)
        unpledgeCharge: 15, // ₹15 + GST per unpledge request
      };
    case "groww":
      return {
        mtfInterestAnnual: 0.1495,
        mtfTiers: null,
        pledgeCharge: 20,
        unpledgeCharge: 20,
      };
    case "angelone":
      return {
        // angelone.in: "interest starts from 18% p.a." — was seeded at 14.25%,
        // which understated financing on every MTF position.
        mtfInterestAnnual: 0.18,
        mtfTiers: null,
        pledgeCharge: 20,
        unpledgeCharge: 20,
      };
    case "upstox":
      return {
        // Upstox bills ₹20/day per ₹40,000 slab = 0.05%/day ≈ 18.25% p.a.
        // Was seeded at 14.95%, an unsourced estimate.
        mtfInterestAnnual: 0.1825,
        mtfTiers: null,
        pledgeCharge: 20,
        unpledgeCharge: 20,
      };
    // Kotak Neo publishes 9.69% p.a., but ONLY on Trade Free Pro (₹249/month).
    // The free plan quotes no MTF rate at all — so the free row says so, and
    // the 9.69% lives on the Pro row where it was actually offered. Carrying
    // the Pro rate on the free plan advertised a discount nobody unsubscribed
    // would receive, in the very report meant to compare cost.
    case "kotakneo":
      return {
        mtfInterestAnnual: 0,
        mtfRateUnknown: true,
        mtfTiers: null,
        pledgeCharge: 20,
        unpledgeCharge: 20,
      };
    // Paytm Money publishes a TIERED book-size rate, and note it is not
    // monotonic — the middle band is the most expensive:
    //   up to ₹1L 7.99% · ₹1L–1Cr 9.99% · above ₹1Cr 8.99%
    case "paytm":
      return {
        mtfInterestAnnual: 0,
        mtfTiers: [
          { upTo: 100000, rate: 0.0799 },
          { upTo: 10000000, rate: 0.0999 },
          { upTo: null, rate: 0.0899 },
        ],
        pledgeCharge: 20,
        unpledgeCharge: 20,
      };
    // Sahi names margin funding as a revenue source but publishes NO rate.
    // Seeding a guess would make Sahi look artificially cheap in exactly the
    // comparison this report exists to answer. `eq_mtf` is therefore left out
    // of Sahi's seeded combos entirely (see COMBOS_BY_BROKER), so it reports
    // as UNPRICED rather than as free.
    case "sahi":
      return {
        mtfInterestAnnual: 0,
        // Sahi names margin funding as a revenue source but publishes NO rate.
        mtfRateUnknown: true,
        mtfTiers: null,
        pledgeCharge: 15, // ₹15 per transaction/ISIN + GST, from their pricing page
        unpledgeCharge: 15,
      };
  }
}

// Which (segment, exchange) combos to seed for each broker.
const COMBOS: { segment: Segment; exchanges: Exchange[] }[] = [
  { segment: "eq_delivery", exchanges: ["NSE", "BSE"] },
  { segment: "eq_mtf", exchanges: ["NSE", "BSE"] },
  { segment: "eq_intraday", exchanges: ["NSE", "BSE"] },
  { segment: "index_option", exchanges: ["NSE", "BSE"] },
  { segment: "stock_option", exchanges: ["NSE", "BSE"] },
  { segment: "future", exchanges: ["NSE"] },
  { segment: "commodity_future", exchanges: ["MCX"] },
  { segment: "commodity_option", exchanges: ["MCX"] },
];

/**
 * Paid plans, in addition to the free "default" every broker has.
 *
 * Kotak Neo and Upstox are the two that sell one — Angel One, Dhan, Zerodha,
 * Groww, Paytm and Sahi all run a single flat structure. Each entry
 * lists ONLY the segments the paid plan actually changes; everything else
 * falls through to the broker's default rates.
 *
 * The monthly fee is carried on the row so the comparison can amortise it.
 * A paid plan judged on brokerage alone would always look cheaper than it is —
 * the fee is the entire reason it is a decision.
 */
interface PaidPlan {
  plan: string;
  label: string;
  monthly: number;
  /** Segment overrides; anything absent uses the default plan's rate. */
  brokerage?: Partial<Record<Segment, { flat: number | null; pct: number; cap: number | null; floor: number }>>;
  mtfInterestAnnual?: number;
}

const PAID_PLANS: Partial<Record<Broker, PaidPlan[]>> = {
  // kotakneo.com/pricing — "Trade Free Pro", ₹249/month. It buys a cheaper
  // delivery rate (0.10% vs 0.20%) and MTF at 9.69%.
  kotakneo: [
    {
      plan: "pro",
      label: "Trade Free Pro",
      monthly: 249,
      brokerage: {
        eq_delivery: { flat: null, pct: 0.001, cap: null, floor: 0 },
        eq_mtf: { flat: null, pct: 0.001, cap: null, floor: 0 },
      },
      mtfInterestAnnual: 0.0969,
    },
  ],
  /**
   * Upstox Plus (v4.5.0). upstox.com/plus/ and help-center 264072, both read
   * 2026-09-22: "The flat fee per order increases from ₹20 to ₹30, but the
   * percentage-based caps remain identical across both plans." So every
   * segment's ₹20 — a FLAT in F&O, a CAP on equity — becomes ₹30 and every
   * percentage is Basic's. Nothing else moves: DP, pledge and every statutory
   * head fall through to the broker's default rows (`emit`).
   *
   * `monthly: 0` — OWNER RULING U3, verbatim: "No subscription charges, just
   * few changes to other fees they charge". The ₹10/order premium IS the price
   * of the tier, so the comparison must not amortise a fee nobody is billed;
   * D4 gates the "· paid" badge on `subscriptionMonthly > 0` for that reason.
   *
   * MTF interest 14.60% p.a. = the published "₹20 per ₹50K borrowed" per day
   * (0.04%/day × 365), against Basic's ₹20 per ₹40,000 slab (0.05%/day,
   * 18.25%). Invariant 3: the figure is a RATE ROW here, never a literal in
   * logic.
   *
   * NOT modelled, deliberately (owner addendum B): Plus's free net-banking
   * transfers and instant withdrawals are cash-ledger lines, not per-trade
   * charges, so they are not charge_config's; and the "Strategy Builder
   * discount on multi-leg options" is a secondary-source claim the owner's own
   * 2026-08-28 day contradicts (it backs out ₹29.86/order, no discount), so no
   * multi-leg rule is seeded.
   */
  upstox: [
    {
      plan: "plus",
      label: "Upstox Plus",
      monthly: 0,
      brokerage: {
        eq_delivery: { flat: null, pct: 0.025, cap: 30, floor: 0 }, // min(30, 2.5%)
        eq_mtf: { flat: null, pct: 0.025, cap: 30, floor: 0 }, // min(30, 2.5%)
        eq_intraday: { flat: null, pct: 0.001, cap: 30, floor: 0 }, // min(30, 0.1%)
        future: { flat: 30, pct: 0, cap: null, floor: 0 },
        commodity_future: { flat: 30, pct: 0, cap: null, floor: 0 },
        index_option: { flat: 30, pct: 0, cap: null, floor: 0 },
        stock_option: { flat: 30, pct: 0, cap: null, floor: 0 },
        commodity_option: { flat: 30, pct: 0, cap: null, floor: 0 },
      },
      mtfInterestAnnual: 0.146,
    },
  ],
};

const BROKER_LIST: Broker[] = [
  "dhan", "zerodha", "groww", "angelone", "upstox", "kotakneo", "paytm", "sahi",
];



export function buildChargeConfigSeed(): ChargeSeedRow[] {
  const rows: ChargeSeedRow[] = [];

  /** Emit one broker's full rate card under a given plan. */
  const emit = (broker: Broker, plan: PaidPlan | null) => {
    for (const { segment, exchanges } of COMBOS) {
      for (const exchange of exchanges) {
        // A paid plan overrides only what it actually changes; everything
        // else falls through to the broker's standard rates.
        const b = plan?.brokerage?.[segment] ?? brokerageFor(broker, segment);
        // The key's dated levies, and every date on which one of them moves —
        // the UNION of the STT and exchange schedules' boundaries, oldest first.
        const sttSched = sttScheduleFor(segment);
        const exchSched = exchangeScheduleFor(segment, exchange);
        const bounds = [...new Set([...sttSched, ...exchSched].map((e) => e.from))].sort();
        const levies = (on: string) => {
          const s = inForce(sttSched, on);
          const e = inForce(exchSched, on);
          return { sttPct: s.pct, sttSide: s.side, exchangeTxnPct: e.txn, ipftPct: e.ipft };
        };
        const newest = bounds[bounds.length - 1];
        const now = levies(newest);
        const isDeliveryLike = segment === "eq_delivery" || segment === "eq_mtf";
        const isMtf = segment === "eq_mtf";
        const dp = isDeliveryLike
          ? dpFor(broker)
          : { dpCharge: 0, dpPct: 0, dpGstApplicable: false, dpMinValue: 0 };
        const baseMtf = isMtf
          ? mtfFor(broker)
          : { mtfInterestAnnual: 0, mtfRateUnknown: false, mtfTiers: null, pledgeCharge: 0, unpledgeCharge: 0 };
        const mtf =
          isMtf && plan?.mtfInterestAnnual != null
            ? { ...baseMtf, mtfInterestAnnual: plan.mtfInterestAnnual, mtfTiers: null, mtfRateUnknown: false }
            : baseMtf;

        rows.push({
          broker,
          plan: plan?.plan ?? "default",
          planLabel: plan?.label ?? null,
          subscriptionMonthly: plan?.monthly ?? 0,
          segment,
          exchange,
          brokerageFlat: b.flat,
          brokeragePct: b.pct,
          brokerageCap: b.cap,
          brokerageFloor: b.floor,
          sttPct: now.sttPct,
          sttSide: now.sttSide,
          exchangeTxnPct: now.exchangeTxnPct,
          sebiPct: SEBI_PCT,
          stampPct: stampFor(segment),
          ipftPct: now.ipftPct,
          gstPct: GST,
          dpCharge: dp.dpCharge,
          dpPct: dp.dpPct ?? 0,
          dpGstApplicable: dp.dpGstApplicable,
          dpMinValue: dp.dpMinValue,
          mtfInterestAnnual: mtf.mtfInterestAnnual,
          mtfRateUnknown: mtf.mtfRateUnknown ?? false,
          mtfTiers: mtf.mtfTiers,
          pledgeCharge: mtf.pledgeCharge,
          unpledgeCharge: mtf.unpledgeCharge,
        });

        /**
         * The earlier epochs: one further row per window of the key's boundary
         * union, newest first, each closed at the next boundary, so a trade is
         * priced at the levies that actually applied on its own date. They
         * differ from the current row in STT and the exchange charge + IPFT
         * ONLY. A key neither schedule moves (MCX) keeps one open-ended row
         * exactly as before — no needless history where nothing changed.
         */
        if (bounds.length > 1) {
          const current = rows[rows.length - 1];
          current.effectiveFrom = newest;
          for (let i = bounds.length - 2; i >= 0; i--) {
            rows.push({ ...current, ...levies(bounds[i]), effectiveFrom: bounds[i], effectiveTo: bounds[i + 1] });
          }
        }
      }
    }
  };

  /**
   * The two ETF STT rows for one (broker, plan) — one per exchange an ETF
   * trades on, epoch-split exactly like a product row.
   *
   * They are emitted under EVERY plan, not only "default": `findRates` keys on
   * the plan, and a missing `upstox|plus|etf_equity|NSE` row would send a Plus
   * account's ETF sale back to the equity-share rate — silently, since the
   * overlay falls back rather than throwing. Nothing on these rows is
   * plan-dependent; STT is statute.
   *
   * `segment` is CAST: `etf_equity`/`etf_other` are rate-row keys and must stay
   * out of the `Segment` union that trades store (design review item 18) — the
   * seed's own COMBOS, the preview-equals-save matrix and broker-compare all
   * enumerate the segments a TRADE can carry. See lib/engine/etf-class.ts.
   */
  const rateKey = (s: EtfRateSegment) => s as unknown as Segment;
  const emitEtf = (broker: Broker, plan: PaidPlan | null) => {
    const schedules: [EtfRateSegment, SttLevy[]][] = [
      ["etf_equity", STT_ETF_EQUITY],
      ["etf_other", STT_ETF_OTHER],
    ];
    for (const [segment, sched] of schedules) {
      for (const exchange of ["NSE", "BSE"] as Exchange[]) {
        for (let i = sched.length - 1; i >= 0; i--) {
          const levy = sched[i];
          rows.push({
            broker,
            plan: plan?.plan ?? "default",
            planLabel: plan?.label ?? null,
            subscriptionMonthly: plan?.monthly ?? 0,
            segment: rateKey(segment),
            exchange,
            // Every non-STT column is 0 and is NEVER read: the overlay takes
            // sttPct/sttSide only, and everything else comes from the trade's
            // own product row (wave3-tax-designs.md, "Rates only from
            // charge_config").
            brokerageFlat: null,
            brokeragePct: 0,
            brokerageCap: null,
            brokerageFloor: 0,
            sttPct: levy.pct,
            sttSide: levy.side,
            exchangeTxnPct: 0,
            sebiPct: 0,
            stampPct: 0,
            ipftPct: 0,
            gstPct: 0,
            dpCharge: 0,
            dpPct: 0,
            dpGstApplicable: false,
            dpMinValue: 0,
            mtfInterestAnnual: 0,
            mtfRateUnknown: false,
            mtfTiers: null,
            pledgeCharge: 0,
            unpledgeCharge: 0,
            effectiveFrom: levy.from,
            effectiveTo: i === sched.length - 1 ? null : sched[i + 1].from,
          });
        }
      }
    }
  };

  for (const broker of BROKER_LIST) {
    emit(broker, null);
    emitEtf(broker, null);
    for (const plan of PAID_PLANS[broker] ?? []) {
      emit(broker, plan);
      emitEtf(broker, plan);
    }
  }
  return rows;
}

