import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assessDataQuality,
  crossAccountIssues,
  ipoAskPairs,
  ipoOrphanNote,
  ipoOrphanPairs,
  ipoRecordMatchesHolding,
  ipoRecordNamesHolding,
  isPlainDuplicateCopy,
  uniqueIpoRelinks,
  NO_PLAIN_COPY_NOTE,
  type DuplicateConnectionGroup,
  type IpoHoldingFacts,
  type IpoRecordFacts,
  type DuplicateTradeGroup,
  type QualityTrade,
  type QualityInputs,
  type QualityReport,
} from "@/lib/analytics/data-quality";
// PURE (no DB, no React), so a static import here cannot bind lib/db before
// openTempDb() sets VYUHA_DB_PATH.
import { withLotCloseNote } from "@/lib/import/close-open-lots";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

// The fix path is a server action; `revalidatePath` needs a request scope that
// a unit test does not have, and it is not what is under test here.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * B1 — the Data Quality Center's job is to say which numbers elsewhere in the
 * app cannot yet be trusted, and why.
 *
 * Two properties are worth pinning hard. First, severity is not decoration:
 * "critical" is reserved for gaps that change MONEY (an unknown cost basis
 * makes P&L, tax, expectancy and ROM all wrong), while a missing sector tag is
 * merely "info". Second, the score must be bounded and monotone — more gaps can
 * never raise it, and no single issue may swamp the whole score.
 */

const trade = (p: Partial<QualityTrade> = {}): QualityTrade => ({
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

const inputs = (p: Partial<QualityInputs> = {}): QualityInputs => ({
  trades: [],
  markedTradeIds: new Set(),
  knownSymbols: new Set(["ABC"]),
  ipoLinkedTradeIds: new Set(),
  staleMtmCount: 0,
  missingAttachmentFiles: 0,
  ...p,
});

const codes = (r: QualityReport) => r.issues.map((x) => x.code);
const find = (r: QualityReport, code: string) => r.issues.find((x) => x.code === code);

describe("data quality — a clean book", () => {
  it("scores complete records at 100 with no issues raised", () => {
    const r = assessDataQuality(inputs({ trades: [trade()] }));
    expect(r.score).toBe(100);
    expect(r.issues).toHaveLength(0);
    expect(r.affected).toBe(0);
    expect(r.checked).toBe(1);
  });

  it("scores an empty journal at 100 rather than 0", () => {
    // Nothing recorded is not the same as everything broken.
    const r = assessDataQuality(inputs());
    expect(r.score).toBe(100);
    expect(r.checked).toBe(0);
  });

  it("never raises an issue with a zero count", () => {
    const r = assessDataQuality(inputs({ trades: [trade()] }));
    for (const i of r.issues) expect(i.count).toBeGreaterThan(0);
  });
});

describe("data quality — critical gaps change money", () => {
  it("flags a sale with no acquisition cost as critical", () => {
    const r = assessDataQuality(inputs({ trades: [trade({ acquisition: "unknown", acquisitionPrice: null })] }));
    expect(find(r, "unknown_basis")?.severity).toBe("critical");
    expect(find(r, "unknown_basis")?.count).toBe(1);
  });

  it("treats a zero or negative basis as unknown, not as a free acquisition", () => {
    expect(find(assessDataQuality(inputs({ trades: [trade({ acquisition: "ipo", acquisitionPrice: 0 })] })), "unknown_basis")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [trade({ acquisition: "ipo", acquisitionPrice: -5 })] })), "unknown_basis")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [trade({ acquisition: "ipo", acquisitionPrice: 100 })] })), "unknown_basis")).toBeUndefined();
  });

  it("flags an open position with no mark as critical", () => {
    const r = assessDataQuality(inputs({ trades: [trade({ id: 2, isOpen: true, closingPrice: null })] }));
    expect(find(r, "unmarked_open")?.severity).toBe("critical");
  });

  it("accepts a mark from either the trade's own close or the MTM table", () => {
    expect(find(assessDataQuality(inputs({ trades: [trade({ isOpen: true, closingPrice: 105 })] })), "unmarked_open")).toBeUndefined();
    expect(find(assessDataQuality(inputs({ trades: [trade({ id: 7, isOpen: true })], markedTradeIds: new Set([7]) })), "unmarked_open")).toBeUndefined();
  });

  /**
   * v4.2 — AN ISSUE NOBODY CAN CLEAR IS NOT A DATA-QUALITY ISSUE.
   *
   * "Open positions without a mark" counted open FUTURES and OPTIONS and
   * pointed at /equity. A typed mark for a contract is refused there by design:
   * `mtm_prices` is keyed on the SYMBOL and `getMtmMap()` reads mtm[symbol]
   * first, so M1 (`lib/quotes/persist-mark.ts`) skips derivative rows rather
   * than pricing the cash position at the option's price. The result was a
   * permanent critical issue, a permanently depressed score, and a link to a
   * screen that could not fix it.
   */
  it("does not ask a DERIVATIVE for a mark it has no place to put", () => {
    const future = trade({ id: 11, isOpen: true, closingPrice: null, instrumentType: "future" });
    const option = trade({ id: 12, isOpen: true, closingPrice: null, instrumentType: "option", expiry: "2026-09-24", strike: 24000, optionType: "CE" });
    expect(find(assessDataQuality(inputs({ trades: [future] })), "unmarked_open")).toBeUndefined();
    expect(find(assessDataQuality(inputs({ trades: [option] })), "unmarked_open")).toBeUndefined();

    // …and an unmarked CASH position in the same book is still counted, alone.
    const cash = trade({ id: 13, isOpen: true, closingPrice: null });
    const both = find(assessDataQuality(inputs({ trades: [future, option, cash] })), "unmarked_open");
    expect(both?.count).toBe(1);
    expect(both?.ids).toEqual([13]);
    expect(both?.href).toBe("/equity");
  });

  it("does not ask a closed position for a mark", () => {
    const r = assessDataQuality(inputs({ trades: [trade({ isOpen: false, closingPrice: null })] }));
    expect(find(r, "unmarked_open")).toBeUndefined();
  });
});

describe("data quality — warnings", () => {
  it("flags an open position missing either a stop or a risk amount", () => {
    expect(find(assessDataQuality(inputs({ trades: [trade({ isOpen: true, closingPrice: 1, slPlanned: null })] })), "missing_stop")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [trade({ isOpen: true, closingPrice: 1, riskAmount: null })] })), "missing_stop")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [trade({ isOpen: true, closingPrice: 1 })] })), "missing_stop")).toBeUndefined();
  });

  it("asks MTF positions — and only MTF positions — for a funded principal", () => {
    expect(find(assessDataQuality(inputs({ trades: [trade({ segment: "eq_mtf", mtfFundedAmount: null })] })), "mtf_funding")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [trade({ segment: "eq_delivery", mtfFundedAmount: null })] })), "mtf_funding")).toBeUndefined();
  });

  it("asks options for expiry, strike and CE/PE", () => {
    const complete = trade({ instrumentType: "option", expiry: "2026-08-27", strike: 24000, optionType: "CE" });
    expect(find(assessDataQuality(inputs({ trades: [complete] })), "option_contract")).toBeUndefined();
    expect(find(assessDataQuality(inputs({ trades: [{ ...complete, expiry: null }] })), "option_contract")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [{ ...complete, strike: null }] })), "option_contract")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [{ ...complete, optionType: null }] })), "option_contract")?.count).toBe(1);
  });

  it("does not ask an equity trade for option metadata", () => {
    const r = assessDataQuality(inputs({ trades: [trade({ instrumentType: "equity" })] }));
    expect(find(r, "option_contract")).toBeUndefined();
  });

  it("flags an IPO holding that is not linked to an IPO record", () => {
    expect(find(assessDataQuality(inputs({ trades: [trade({ id: 3, acquisition: "ipo", acquisitionPrice: 100 })] })), "ipo_link")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [trade({ id: 3, acquisition: "ipo", acquisitionPrice: 100 })], ipoLinkedTradeIds: new Set([3]) })), "ipo_link")).toBeUndefined();
  });

  it("also names the exited records that unlinked holding could be — one issue per pair", () => {
    // L6 (wave 2L): `ipo_link` says the holding is unlinked; this says WHICH
    // records could be its own, because the pair is what the user can settle.
    const held = trade({ id: 3, acquisition: "ipo", acquisitionPrice: 100, accountId: 7, symbol: "ASKAUTO", tradingsymbol: "ASKAUTO", buyQty: 10 });
    const r = assessDataQuality(inputs({ trades: [held], unlinkedIpoRecords: [{ id: 12, accountId: 7, name: "ASKAUTO", allottedQty: 10, allotted: true, exitPrice: 150 }] }));
    const issue = find(r, "ipo_record_link:3")!;
    expect([issue.severity, issue.title, issue.count, issue.ids]).toEqual(["warning", "IPO record not linked to its holding", 1, [3]]);
    expect(issue.detail).toContain("#12 ASKAUTO");
    expect(issue.detail).toContain("counted once in IPOs and again as the holding's own sale");
    // A caller that has not read the records gets exactly the report it got before.
    expect(find(assessDataQuality(inputs({ trades: [held] })), "ipo_record_link:3")).toBeUndefined();
  });

  it("asks nothing where there is no book to ask in", () => {
    // G-G2-1 (wave 2M): the question is now raised for every unlinked holding
    // that SHARES A BOOK with an unlinked exited record, matched or not — so
    // what silences it is the absence of a book in common, never the absence of
    // a match. Invariant 8 is the whole of the first case and invariant 9 the
    // second: a holding that states no account is in no book.
    const held = trade({ id: 3, acquisition: "ipo", acquisitionPrice: 100, accountId: 7, symbol: "ASKAUTO", tradingsymbol: "ASKAUTO", buyQty: 10 });
    // D1 (wave 2M): the record states what its row states — allotted, with an
    // exit price — because that is what the query hands the report, and an exit
    // stated with no holding attached is what raises the question at all.
    const record = { id: 12, accountId: 7, name: "ASKAUTO", allottedQty: 10, allotted: true, exitPrice: 150 };
    const cases: [string, QualityInputs][] = [
      ["another account's record", inputs({ trades: [held], unlinkedIpoRecords: [{ ...record, accountId: 8 }] })],
      ["a holding that states no account", inputs({ trades: [{ ...held, accountId: undefined }], unlinkedIpoRecords: [record] })],
      ["a holding already linked to a record", inputs({ trades: [held], ipoLinkedTradeIds: new Set([3]), unlinkedIpoRecords: [record] })],
      ["no unlinked exited record at all", inputs({ trades: [held], unlinkedIpoRecords: [] })],
    ];
    for (const [why, i] of cases) expect(find(assessDataQuality(i), "ipo_record_link:3"), why).toBeUndefined();
    // An unstated quantity on EITHER side is not evidence against the pair.
    expect(find(assessDataQuality(inputs({ trades: [{ ...held, buyQty: 0 }], unlinkedIpoRecords: [record] })), "ipo_record_link:3")).toBeDefined();
  });

  it("asks about a holding no record MATCHES, and still guesses nothing (G-G2-1)", () => {
    // Before wave 2M both of these were silent: `ipoOrphanPairs` found no
    // match, so no issue was raised at all and the record's exit and the
    // holding's sale were counted as two sales with nothing on screen saying so.
    //
    // MOVED by D1 (fix wave 2N, counted-once#3): the question is still raised,
    // but a holding NO record's facts match is grouped with the rest of its
    // book into ONE issue per account (`ipo_record_link:account:<id>`). Six such
    // holdings beside one stray record raised six identical warnings and floored
    // the completeness score at 22, every detail naming the same candidate.
    const held = trade({ id: 3, acquisition: "ipo", acquisitionPrice: 100, accountId: 7, symbol: "ASKAUTO", tradingsymbol: "ASKAUTO", buyQty: 10 });
    const record: IpoRecordFacts = { id: 12, accountId: 7, name: "ASKAUTO", allottedQty: 10, allotted: true, exitPrice: 150 };
    const unmatched: [string, IpoRecordFacts][] = [
      ["a record named after the company, not the scrip", { ...record, name: "ASK Automotive Ltd" }],
      ["a different allotted quantity, both stated", { ...record, allottedQty: 25 }],
    ];
    for (const [why, r] of unmatched) {
      const report = assessDataQuality(inputs({ trades: [held], unlinkedIpoRecords: [r] }));
      expect(find(report, "ipo_record_link:3"), `${why}: no per-holding issue`).toBeUndefined();
      const issue = find(report, "ipo_record_link:account:7");
      expect(issue?.severity, why).toBe("warning");
      expect(issue!.ids, why).toEqual([3]);
      expect(issue!.detail, why).toContain(`#12 ${r.name}`);
      // Named as a candidate, NOT presented as the holding's own (invariant 6).
      expect(issue!.detail, why).not.toContain("matches this holding");
      expect(uniqueIpoRelinks([held], [r]), `${why}: and nothing is written`).toEqual([]);
    }
  });

  /**
   * D1 (fix wave 2N, counted-once#3) — the grouping itself: six unlinked IPO
   * holdings and ONE stray record measured `{holdings: 6, records: 1, asks: 6,
   * score: 22}`, six warnings of one title. One issue says the same thing once.
   */
  it("groups a book's unmatched holdings into ONE issue, naming every holding and every record", () => {
    const held = (id: number, symbol: string) =>
      trade({ id, acquisition: "ipo", acquisitionPrice: 100, accountId: 7, symbol, tradingsymbol: symbol, buyQty: 10 });
    const holdings = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].map((s, k) => held(k + 1, s));
    const stray: IpoRecordFacts = { id: 12, accountId: 7, name: "Fan Industries Limited", allottedQty: 25, allotted: true, exitPrice: 150 };
    const report = assessDataQuality(inputs({ trades: holdings, unlinkedIpoRecords: [stray] }));
    const asks = report.issues.filter((x) => x.code.startsWith("ipo_record_link"));
    expect(asks.map((x) => x.code), "one question, not six").toEqual(["ipo_record_link:account:7"]);
    expect(asks[0].ids).toEqual([1, 2, 3, 4, 5, 6]);
    expect(asks[0].detail).toContain("6 holdings are recorded as IPO allotments");
    expect(asks[0].detail).toContain("#12 Fan Industries Limited");
    expect(asks[0].detail).toContain("#1 (AAA)");
    for (const word of ["recommend", "suggest", "should", "consider"]) expect(asks[0].detail.toLowerCase(), word).not.toContain(word);
  });

  it("passes through externally-counted gaps", () => {
    const r = assessDataQuality(inputs({ staleMtmCount: 4, missingAttachmentFiles: 2 }));
    expect(find(r, "stale_mtm")?.count).toBe(4);
    expect(find(r, "stale_mtm")?.severity).toBe("info");
    expect(find(r, "missing_attachment")?.count).toBe(2);
    expect(find(r, "missing_attachment")?.severity).toBe("warning");
  });
});

describe("uniqueIpoRelinks — what a Trash restore may write, and what stays a question", () => {
  const held = (id: number, over: Partial<QualityTrade> = {}) =>
    trade({ id, acquisition: "ipo", acquisitionPrice: 100, accountId: 7, symbol: "ASKAUTO", tradingsymbol: "ASKAUTO", buyQty: 10, ...over });
  const rec = (id: number, over: Partial<{ accountId: number; name: string; allottedQty: number }> = {}) =>
    ({ id, accountId: 7, name: "ASKAUTO", allottedQty: 10, ...over });

  it("links the one record that can only be this holding's", () => {
    expect(uniqueIpoRelinks([held(3)], [rec(12), rec(13, { name: "OTHER" }), rec(14, { accountId: 8 })])).toEqual([{ tradeId: 3, ipoId: 12 }]);
  });

  it("writes nothing when one holding has two candidates", () => {
    expect(uniqueIpoRelinks([held(3)], [rec(12), rec(13)])).toEqual([]);
    expect(ipoOrphanPairs([held(3)], [rec(12), rec(13)])[0].recordIds, "both are still named").toEqual([12, 13]);
  });

  it("writes nothing when two holdings reach for the same record — 'whichever came first' is not an answer", () => {
    expect(uniqueIpoRelinks([held(3), held(4)], [rec(12)])).toEqual([]);
  });

  it("writes nothing when there is no candidate at all", () => {
    expect(uniqueIpoRelinks([held(3)], [])).toEqual([]);
    expect(ipoOrphanPairs([held(3)], [])).toEqual([]);
  });
});

/**
 * G-G2-1 (wave 2M) — TIER B: the record is named after the ISSUE, and the
 * ALLOTMENT is what the two rows state identically.
 *
 * `pushTradeToIpoAction` writes the SYMBOL into `name`, so tier A recognises
 * only a record this app created FROM a holding. A record typed on /ipos, where
 * the field is labelled the IPO's name, reads "Tata Technologies Limited"
 * beside a holding symbol of TATATECH — matched nothing, so a pre-4.3.0 Trash
 * envelope restored the holding unlinked, the record kept realising its own
 * exit, and the one sale was counted twice. Tier B is built only from facts
 * both rows already state, ALL of them required together: no name is resolved
 * to a symbol through any list (a freshly listed issue is in no bundled map,
 * and that is this finding's population).
 */
describe("ipoRecordMatchesHolding — tier B, the allotment's own facts", () => {
  const TATATECH: IpoHoldingFacts = {
    id: 3,
    accountId: 7,
    symbol: "TATATECH",
    tradingsymbol: "TATATECH",
    buyQty: 10,
    acquisitionDate: "2023-11-22",
    buyDate: "2023-11-22",
    sellDate: "2024-02-14",
  };
  const ISSUE: IpoRecordFacts = {
    id: 12,
    accountId: 7,
    name: "Tata Technologies Limited",
    allottedQty: 10,
    allotted: true,
    exitPrice: 1180,
    exitDate: "2024-02-14",
    allotmentDate: "2023-11-22",
  };

  it("matches a record named after the issue on quantity, allotment day and exit day", () => {
    expect(ipoRecordMatchesHolding(ISSUE, TATATECH)).toBe(true);
  });

  /**
   * D1 (fix wave 2N, counted-once#0) — TIER B IS NEVER WHAT A RESTORE WRITES.
   *
   * MOVED: this line read `expect(uniqueIpoRelinks([TATATECH], [ISSUE]))
   * .toEqual([{ tradeId: 3, ipoId: 12 }])`. `ipos` carries no scrip fact, so the
   * four allotment facts are no identity: two IPOs allotted on one day in the
   * same lot size and sold on listing day — an ordinary retail pattern — are
   * indistinguishable to tier B, and the restore linked the wrong issue's
   * record. Its own, genuinely separate sale then left the capital summary, the
   * tax pack, the ITR export and both AIS sides, and the question that had named
   * the pair disappeared with it. Tier B keeps MARKING the candidate.
   */
  it("tier B is never what a restore writes — it marks the candidate and the user settles it", () => {
    expect(ipoRecordMatchesHolding(ISSUE, TATATECH), "still a candidate").toBe(true);
    expect(ipoRecordNamesHolding(ISSUE, TATATECH), "but nothing on the record says it is THIS scrip's").toBe(false);
    expect(uniqueIpoRelinks([TATATECH], [ISSUE]), "so nothing is written").toEqual([]);
    // The scrip-named record beside it IS written: that clause carries the scrip.
    const named = { ...ISSUE, id: 14, name: "TATATECH" };
    expect(uniqueIpoRelinks([{ ...TATATECH, sellQty: 10 }], [named])).toEqual([{ tradeId: 3, ipoId: 14 }]);
  });

  /**
   * D1 (fix wave 2N, counted-once#1) — an EXITED record is no candidate for a
   * holding that records no sale, and an ABSENT `sellQty` refuses rather than
   * assumes.
   */
  it("refuses to write an exited record onto a holding that never sold", () => {
    const sold = { ...TATATECH, symbol: "TATATECH", sellQty: 10 };
    const scripNamed = { ...ISSUE, name: "TATATECH" };
    expect(uniqueIpoRelinks([sold], [scripNamed]), "a holding that sold").toEqual([{ tradeId: 3, ipoId: 12 }]);
    expect(uniqueIpoRelinks([{ ...sold, sellQty: 0 }], [scripNamed]), "a holding still held").toEqual([]);
    expect(uniqueIpoRelinks([{ ...sold, sellQty: undefined }], [scripNamed]), "a holding that states nothing").toEqual([]);
    // A record that states NO exit is unchanged: it may pair with either.
    const unexited = { ...scripNamed, exitPrice: null, exitDate: null };
    expect(uniqueIpoRelinks([{ ...sold, sellQty: 0 }], [unexited]), "no exit stated, no sale needed").toEqual([{ tradeId: 3, ipoId: 12 }]);
  });

  it("refuses the match when any ONE of those facts stops being stated or stops agreeing", () => {
    const cases: [string, IpoRecordFacts, IpoHoldingFacts][] = [
      ["another book", { ...ISSUE, accountId: 8 }, TATATECH],
      ["not allotted", { ...ISSUE, allotted: false }, TATATECH],
      ["allotment not stated at all", { ...ISSUE, allotted: undefined }, TATATECH],
      ["no exit price — the record never exited", { ...ISSUE, exitPrice: null }, TATATECH],
      ["a different quantity", { ...ISSUE, allottedQty: 25 }, TATATECH],
      ["the record states no quantity", { ...ISSUE, allottedQty: 0 }, TATATECH],
      ["the holding states no quantity", ISSUE, { ...TATATECH, buyQty: 0 }],
      ["a different allotment day", { ...ISSUE, allotmentDate: "2023-11-21" }, TATATECH],
      ["no allotment day", { ...ISSUE, allotmentDate: null }, TATATECH],
      ["a different exit day", { ...ISSUE, exitDate: "2024-02-15" }, TATATECH],
      ["no exit day", { ...ISSUE, exitDate: null }, TATATECH],
      ["the holding states no acquisition or buy day", ISSUE, { ...TATATECH, acquisitionDate: null, buyDate: null }],
      ["the holding is still open (no sell day)", ISSUE, { ...TATATECH, sellDate: null }],
      // RE-PINNED (D2, wave 2M). This case used to hold a DAY-FIRST date on
      // both sides ("22-11-2023") and expect no match, because the old `isoDay`
      // was a shape test that read it as no day at all — measured before: false,
      // after: TRUE, and rightly so (the two rows state the same day; the new
      // `it` below pins it). What "neither side can read as a day" really means
      // is a day that does not exist: measured before: TRUE (isoDay accepted
      // 2026-02-31 and the two impossible dates compared EQUAL), after: false.
      ["a day that does not exist, however both sides spell it", { ...ISSUE, allotmentDate: "2026-02-31" }, { ...TATATECH, acquisitionDate: "2026-02-31", buyDate: "2026-02-31" }],
      ["a half-typed year, which a date input reaches", { ...ISSUE, allotmentDate: "0002-06-15" }, { ...TATATECH, acquisitionDate: "0002-06-15", buyDate: "0002-06-15" }],
    ];
    for (const [why, r, t] of cases) {
      expect(ipoRecordMatchesHolding(r, t), why).toBe(false);
      expect(uniqueIpoRelinks([t], [r]), `${why}: and nothing is written`).toEqual([]);
    }
  });

  it("falls back to the holding's buy day when the acquisition day is not stated", () => {
    expect(ipoRecordMatchesHolding(ISSUE, { ...TATATECH, acquisitionDate: null })).toBe(true);
  });

  it("reads a stored day-first date as the day it states — the ONE calendar, on both sides (D2)", () => {
    // Seam finding F29: /ipos stored an allotment date exactly as typed, so a
    // record written day-first could never be recognised as its holding's own
    // — measured before, with the old shape test: false for every line here.
    // The route now normalises what it stores; this is the READER's half, for
    // every row written before it did.
    expect(ipoRecordMatchesHolding({ ...ISSUE, allotmentDate: "22-11-2023" }, TATATECH), "22-11-2023 is 2023-11-22").toBe(true);
    expect(ipoRecordMatchesHolding({ ...ISSUE, exitDate: "14/02/2024" }, TATATECH), "14/02/2024 is 2024-02-14").toBe(true);
    expect(
      ipoRecordMatchesHolding({ ...ISSUE, allotmentDate: "22-11-2023" }, { ...TATATECH, acquisitionDate: "2023-11-22" }),
      "day-first on one side and ISO on the other are the same day",
    ).toBe(true);
    // …and a day-first date that is not a real day is still no day.
    expect(ipoRecordMatchesHolding({ ...ISSUE, allotmentDate: "31-11-2023" }, { ...TATATECH, acquisitionDate: "31-11-2023" })).toBe(false);
  });

  it("two issue-named look-alikes are as ambiguous as two scrip-named ones — nothing is written", () => {
    expect(uniqueIpoRelinks([TATATECH], [ISSUE, { ...ISSUE, id: 13, name: "Tata Technologies Ltd" }])).toEqual([]);
    expect(ipoOrphanPairs([TATATECH], [ISSUE, { ...ISSUE, id: 13 }])[0].recordIds, "both are still named").toEqual([12, 13]);
  });
});

/**
 * G-G2-1 — what is ASKED, which is deliberately wider than what MATCHES: a
 * question costs the user a look, a wrong link costs them a number.
 */
describe("ipoAskPairs — every unlinked holding that shares a book with an unlinked exited record", () => {
  const held = { id: 3, accountId: 7, symbol: "ASKAUTO", tradingsymbol: "ASKAUTO", buyQty: 10 };
  // The record as the query reads it (D1): unlinked, allotted, and — here —
  // stating an exit of its own, which is the sale that can be counted twice.
  const rec = (id: number, over: Partial<IpoRecordFacts> = {}): IpoRecordFacts =>
    ({ id, accountId: 7, name: "ASKAUTO", allottedQty: 10, allotted: true, exitPrice: 150, ...over });

  it("asks even when nothing matches, and says so by marking only the ones that do", () => {
    const pairs = ipoAskPairs([held], [rec(12, { name: "ASK Automotive Ltd" })]);
    expect([pairs.length, pairs[0].recordIds, pairs[0].matched]).toEqual([1, [12], [false]]);
    expect(ipoOrphanPairs([held], [rec(12, { name: "ASK Automotive Ltd" })]), "and it is still no candidate for a WRITE").toEqual([]);
  });

  it("lists the matching records first and marks them", () => {
    const pairs = ipoAskPairs([held], [rec(11, { name: "Some Other Issue Ltd" }), rec(12)]);
    expect([pairs[0].recordIds, pairs[0].recordNames, pairs[0].matched]).toEqual([[12, 11], ["ASKAUTO", "Some Other Issue Ltd"], [true, false]]);
  });

  it("never asks across books (invariant 8) and never about a holding with no book (invariant 9)", () => {
    expect(ipoAskPairs([held], [rec(12, { accountId: 8 })]), "another account's record").toEqual([]);
    expect(ipoAskPairs([{ ...held, accountId: undefined }], [rec(12)]), "a holding filed in no account").toEqual([]);
  });

  it("states the double count and names where it is settled, without advising anything", () => {
    const note = ipoOrphanNote(ipoAskPairs([held], [rec(12, { name: "ASK Automotive Ltd" }), rec(13)])[0]);
    expect(note).toContain("Trade #3 (ASKAUTO)");
    expect(note).toContain("2 exited IPO records");
    expect(note).toContain("#13 ASKAUTO (matches this holding)");
    expect(note).toContain("#12 ASK Automotive Ltd");
    expect(note).toContain("counted once in IPOs and again as the holding's own sale");
    expect(note).toContain("the capital summary, the tax pack, the ITR export and both AIS sides");
    expect(note).toContain("Open IPOs");
    // SEBI-safe: descriptive, no advice words, and no figure it cannot derive.
    for (const word of ["recommend", "suggest", "should", "consider"]) expect(note.toLowerCase(), word).not.toContain(word);
  });
});

/**
 * D1 (v4.3.0 wave 2M, seam finding F28) — ONE candidate set, read by the Trash
 * restore and by this report.
 *
 * `lib/trash.ts` read EVERY unlinked record and `lib/queries/data-quality.ts`
 * only the allotted, exited ones: the pairing function was shared, the SET was
 * not. The row that split them is the one a user records when they APPLY —
 * under the TICKER, never allotted, never exited. It matched tier A on its name
 * (an unstated quantity is not evidence), so the restore saw two candidates and
 * wrote nothing, while the report saw one and said it matched this holding. The
 * sale then stayed counted twice — in the capital summary, the tax pack, the
 * ITR export and both AIS sides — after a restore whose own report called the
 * pairing unambiguous.
 */
describe("the candidate set — a record that states no allotment is no allotment's record", () => {
  const held: IpoHoldingFacts = {
    id: 3, accountId: 7, symbol: "F28IND", tradingsymbol: "F28IND", buyQty: 12,
    acquisitionDate: "2026-02-20", buyDate: "2026-02-20", sellDate: "2026-03-02",
  };
  /** The allotment, typed on /ipos under the ISSUE's name. */
  const allotment: IpoRecordFacts = {
    id: 12, accountId: 7, name: "F28 Industries Limited", allottedQty: 12,
    allotted: true, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2026-02-20",
  };
  /** The application the same user recorded under the ticker: no allotment, no exit. */
  const application: IpoRecordFacts = {
    id: 13, accountId: 7, name: "F28IND", allottedQty: 0,
    allotted: false, exitPrice: null, exitDate: null, allotmentDate: null,
  };

  it("is a candidate nowhere — not matched, not written, not asked about", () => {
    // Measured before: `ipoRecordMatchesHolding` answered TRUE on the name.
    expect(ipoRecordMatchesHolding(application, held)).toBe(false);
    expect(uniqueIpoRelinks([held], [application])).toEqual([]);
    expect(ipoAskPairs([held], [application]), "and it states no exit, so there is no second sale to ask about").toEqual([]);
  });

  it("so the allotment beside it is the ONE candidate the restore weighed", () => {
    // Measured before wave 2M: `[]` — two candidates, so nothing was written,
    // while the report (which never saw the application) named the allotment as
    // matching. MOVED by D1 (wave 2N): this allotment carries the ISSUE's name,
    // so tier B is what recognises it and tier B is never written
    // (counted-once#0) — the set is still ONE, which is what F28 pins.
    expect(ipoOrphanPairs([held], [allotment, application])[0].recordIds, "one candidate, not two").toEqual([12]);
    expect(uniqueIpoRelinks([held], [allotment, application]), "and an issue-named record is asked about").toEqual([]);
    const [pair] = ipoAskPairs([held], [allotment, application]);
    expect([pair.recordIds, pair.matched, pair.exited]).toEqual([[12], [true], [true]]);
    expect(ipoOrphanNote(pair), "the note names the set the restore saw, and no other row").not.toContain("#13");
  });
});

describe("the candidate set — an allotted record with no exit stated", () => {
  const held: IpoHoldingFacts = {
    id: 3, accountId: 7, symbol: "GOMIX", tradingsymbol: "GOMIX", buyQty: 10,
    acquisitionDate: "2026-02-20", buyDate: "2026-02-20", sellDate: "2026-03-02",
  };
  const exited: IpoRecordFacts = {
    id: 12, accountId: 7, name: "Go Mix Industries Limited", allottedQty: 10,
    allotted: true, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2026-02-20",
  };
  const openRecord: IpoRecordFacts = {
    id: 14, accountId: 7, name: "GOMIX", allottedQty: 10,
    allotted: true, exitPrice: null, exitDate: null, allotmentDate: "2026-02-20",
  };

  it("is still a candidate a restore may link on its own — the name tier is unchanged", () => {
    expect(ipoRecordMatchesHolding(openRecord, held)).toBe(true);
    expect(uniqueIpoRelinks([held], [openRecord])).toEqual([{ tradeId: 3, ipoId: 14 }]);
  });

  it("raises no question on its own: nothing states the sale twice", () => {
    expect(ipoAskPairs([held], [openRecord])).toEqual([]);
  });

  it("but is listed beside an exited record, because that is the set the restore weighed", () => {
    const [pair] = ipoAskPairs([held], [exited, openRecord]);
    expect([pair.recordIds, pair.matched, pair.exited]).toEqual([[12, 14], [true, true], [true, false]]);
    expect(uniqueIpoRelinks([held], [exited, openRecord]), "two candidates — nothing is written (invariant 6)").toEqual([]);
    const note = ipoOrphanNote(pair);
    expect(note).toContain("an exited IPO record in the same account states an exit with no holding attached (#12 Go Mix Industries Limited (matches this holding))");
    expect(note).toContain(
      "The same account also holds an allotted IPO record with no holding attached and no exit stated (#14 GOMIX (matches this holding)), which a restore reads as a candidate for this holding too.",
    );
    for (const word of ["recommend", "suggest", "should", "consider"]) expect(note.toLowerCase(), word).not.toContain(word);
  });
});

describe("data quality — instrument master", () => {
  it("counts unknown SYMBOLS, not unknown trades", () => {
    // Twenty trades in one unlisted scrip is one gap to fix, not twenty.
    const trades = [1, 2, 3].map((id) => trade({ id, symbol: "MYSTERY" }));
    const r = assessDataQuality(inputs({ trades, knownSymbols: new Set(["ABC"]) }));
    expect(find(r, "instrument_master")?.count).toBe(1);
  });

  it("matches the instrument master case-insensitively", () => {
    const r = assessDataQuality(inputs({ trades: [trade({ symbol: "abc" })], knownSymbols: new Set(["ABC"]) }));
    expect(find(r, "instrument_master")).toBeUndefined();
  });
});

describe("data quality — the score", () => {
  it("weights critical above warning above info for the same count", () => {
    const critical = assessDataQuality(inputs({ trades: [trade({ acquisition: "unknown" })] })).score;
    const warning = assessDataQuality(inputs({ trades: [trade({ segment: "eq_mtf" })] })).score;
    const info = assessDataQuality(inputs({ staleMtmCount: 1 })).score;
    expect(critical).toBeLessThan(warning);
    expect(warning).toBeLessThan(info);
    expect(info).toBeLessThan(100);
  });

  it("caps any single issue's penalty so one gap cannot swamp the score", () => {
    const many = Array.from({ length: 500 }, (_, i) => trade({ id: i + 1, acquisition: "unknown" }));
    const r = assessDataQuality(inputs({ trades: many }));
    expect(r.score).toBeGreaterThan(0);
  });

  it("never falls below 0 however broken the book is", () => {
    const wrecked = Array.from({ length: 200 }, (_, i) =>
      trade({ id: i + 1, isOpen: true, acquisition: "unknown", slPlanned: null, riskAmount: null, segment: "eq_mtf", instrumentType: "option", symbol: "NOPE" }),
    );
    const r = assessDataQuality(inputs({ trades: wrecked, knownSymbols: new Set(), staleMtmCount: 99, missingAttachmentFiles: 99 }));
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("is monotone — adding a broken trade never raises the score", () => {
    const clean = assessDataQuality(inputs({ trades: [trade()] }));
    const dirty = assessDataQuality(inputs({ trades: [trade(), trade({ id: 2, acquisition: "unknown" })] }));
    expect(dirty.score).toBeLessThanOrEqual(clean.score);
  });
});

describe("data quality — remediation", () => {
  it("gives every issue somewhere to go", () => {
    const r = assessDataQuality(
      inputs({
        trades: [trade({ id: 1, isOpen: true, acquisition: "unknown", slPlanned: null, segment: "eq_mtf", instrumentType: "option", symbol: "NOPE" })],
        knownSymbols: new Set(),
        staleMtmCount: 1,
        missingAttachmentFiles: 1,
      }),
    );
    expect(r.issues.length).toBeGreaterThan(5);
    for (const i of r.issues) {
      expect(i.href.startsWith("/")).toBe(true);
      expect(i.title.length).toBeGreaterThan(0);
      expect(i.detail.length).toBeGreaterThan(0);
    }
  });

  it("counts each affected trade once even when it fails several checks", () => {
    const r = assessDataQuality(inputs({ trades: [trade({ id: 42, isOpen: true, acquisition: "unknown", slPlanned: null, riskAmount: null })] }));
    expect(codes(r).length).toBeGreaterThan(1);
    expect(r.affected).toBe(1);
  });

  it("caps the id list it hands back so a huge book cannot bloat the payload", () => {
    const many = Array.from({ length: 300 }, (_, i) => trade({ id: i + 1, acquisition: "unknown" }));
    const r = assessDataQuality(inputs({ trades: many }));
    const issue = find(r, "unknown_basis")!;
    expect(issue.count).toBe(300); // the real number is still reported
    expect(issue.ids!.length).toBe(100); // only the list is truncated
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * B4 (v4.2.1) — the two CROSS-ACCOUNT issues, and the one-click fix.
 *
 * The dedup hash carries no account id (lib/import/dedup.ts) and the unique
 * index that enforces it is per account (`trades_account_broker_dedup_uq`), so
 * one broker record imported into two accounts is stored twice and the
 * All-accounts view sums both copies. Neither fact is visible to a
 * single-account read, which is why both are resolved outside the pure module
 * and handed in already grouped and already MASKED.
 * ═══════════════════════════════════════════════════════════════════════════ */

const connGroup = (p: Partial<DuplicateConnectionGroup> = {}): DuplicateConnectionGroup => ({
  broker: "dhan",
  brokerLabel: "Dhan",
  maskedIdentity: "110…••••",
  accounts: [
    { id: 1, name: "Primary" },
    { id: 2, name: "Swing" },
  ],
  ...p,
});

const tradeGroup = (p: Partial<DuplicateTradeGroup> = {}): DuplicateTradeGroup => ({
  broker: "dhan",
  brokerLabel: "Dhan",
  dedupHash: "a1b2c3d4e5f6a1b2c3d4",
  symbol: "TCS",
  qty: 10,
  buyDate: "2026-07-01",
  sellDate: "2026-07-09",
  rows: 2,
  ids: [11, 22],
  accounts: [
    { id: 1, name: "Primary", rows: 1, removable: true },
    { id: 2, name: "Swing", rows: 1, removable: true },
  ],
  ...p,
});

const dupTradeIssues = (r: QualityReport) => r.issues.filter((x) => x.code.startsWith("duplicate_trades:"));
const dupConnIssues = (r: QualityReport) => r.issues.filter((x) => x.code.startsWith("duplicate_connection:"));

describe("data quality — trades duplicated across accounts", () => {
  it("raises ONE issue for a (broker, dedupHash) group held in two accounts, naming both", () => {
    const r = assessDataQuality(inputs({ duplicateTradeGroups: [tradeGroup()] }));
    const dup = dupTradeIssues(r);

    // One issue per duplicated RECORD — the unit a user can act on.
    expect(dup).toHaveLength(1);
    // …carrying the ROW count (both copies), not the number of accounts.
    expect(dup[0].count).toBe(2);
    expect(dup[0].severity).toBe("critical");
    expect(dup[0].detail).toContain("Primary");
    expect(dup[0].detail).toContain("Swing");
    expect(dup[0].title).toContain("TCS");
    expect(dup[0].href).toBe("/data-quality#duplicates");
    expect(dup[0].ids).toEqual([11, 22]);
    expect(r.affected).toBe(2);
  });

  it("says nothing about a sole copy", () => {
    const sole = tradeGroup({ rows: 1, ids: [11], accounts: [{ id: 1, name: "Primary", rows: 1, removable: true }] });
    expect(dupTradeIssues(assessDataQuality(inputs({ duplicateTradeGroups: [sole] })))).toHaveLength(0);
    expect(dupTradeIssues(assessDataQuality(inputs({ duplicateTradeGroups: [] })))).toHaveLength(0);
    expect(dupTradeIssues(assessDataQuality(inputs()))).toHaveLength(0);
  });

  it("gives every group its own code, because the screen keys on it", () => {
    const r = assessDataQuality(
      inputs({
        duplicateTradeGroups: [
          tradeGroup(),
          tradeGroup({ dedupHash: "ffffffffffffffffffff", symbol: "INFY", ids: [33, 44] }),
        ],
      }),
    );
    const codes = dupTradeIssues(r).map((x) => x.code);
    expect(codes).toHaveLength(2);
    expect(new Set(codes).size).toBe(2);
  });

  it("counts a critical duplicate against the score", () => {
    const clean = assessDataQuality(inputs()).score;
    const dirty = assessDataQuality(inputs({ duplicateTradeGroups: [tradeGroup()] })).score;
    expect(dirty).toBeLessThan(clean);
  });
});

describe("data quality — one broker client connected in several accounts", () => {
  it("raises one issue per duplicated identity, naming the accounts and the count", () => {
    const r = assessDataQuality(inputs({ duplicateConnections: [connGroup()] }));
    const dup = dupConnIssues(r);

    expect(dup).toHaveLength(1);
    expect(dup[0].count).toBe(2); // accounts holding it
    expect(dup[0].severity).toBe("warning"); // nothing is wrong in the numbers YET
    expect(dup[0].title).toContain("2 accounts");
    expect(dup[0].detail).toContain("Primary");
    expect(dup[0].detail).toContain("Swing");
    expect(dup[0].href).toBe("/data-quality#duplicates");
  });

  it("shows only the masked identity it was handed", () => {
    const r = assessDataQuality(inputs({ duplicateConnections: [connGroup({ maskedIdentity: "110…••••" })] }));
    const text = JSON.stringify(dupConnIssues(r));
    expect(text).toContain("110…••••");
    expect(text).not.toContain("1100112233");
  });

  it("says nothing about a client in one account only", () => {
    const sole = connGroup({ accounts: [{ id: 1, name: "Primary" }] });
    expect(dupConnIssues(assessDataQuality(inputs({ duplicateConnections: [sole] })))).toHaveLength(0);
    expect(dupConnIssues(assessDataQuality(inputs()))).toHaveLength(0);
  });

  it("is exported on its own, so the screen can resolve the two without re-deriving the report", () => {
    const issues = crossAccountIssues({ duplicateConnections: [connGroup()], duplicateTradeGroups: [tradeGroup()] });
    expect(issues.map((x) => x.severity)).toEqual(["warning", "critical"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * M-5 (v4.3.0, ruling 2026-09-10) — REMOVING A COPY MUST NOT DELETE A MERGED
 * LOT.
 *
 * After R5's auto-close a row can be BOTH one account's copy of a record and
 * the row that closed a lot that account was holding: it keeps its own hash and
 * carries the consumed execution's hash as an alias. "Remove the copy in
 * <account>" on such a row is data loss. Only a PLAIN single-source row is
 * removable, and the rule is one function, read by the button and re-read by
 * the server action.
 * ═══════════════════════════════════════════════════════════════════════════ */

const HASH_A = "1".repeat(40);
const HASH_B = "2".repeat(40);

describe("isPlainDuplicateCopy — the removability rule, all three clauses", () => {
  it("passes a plain single-source row: own hash, no alias, no auto-close", () => {
    expect(isPlainDuplicateCopy({ identityHashes: [HASH_A], autoClosed: false }, HASH_A)).toBe(true);
  });

  it("refuses a row that joins the group only through an ALIAS — its own record is elsewhere", () => {
    expect(isPlainDuplicateCopy({ identityHashes: [HASH_A, HASH_B], autoClosed: true }, HASH_B)).toBe(false);
  });

  it("refuses a MERGED LOT even on its own hash — the row stands for two records", () => {
    expect(isPlainDuplicateCopy({ identityHashes: [HASH_A, HASH_B], autoClosed: true }, HASH_A)).toBe(false);
  });

  it("refuses a row the importer marked auto-closed even when no alias survived", () => {
    // Clause 3 is not clause 2: the alias derivation is best effort, the mark
    // is a fact the importer wrote.
    expect(isPlainDuplicateCopy({ identityHashes: [HASH_A], autoClosed: true }, HASH_A)).toBe(false);
  });

  it("refuses a row whose own hash is some other record entirely", () => {
    expect(isPlainDuplicateCopy({ identityHashes: [HASH_A], autoClosed: false }, HASH_B)).toBe(false);
  });
});

describe("isPlainDuplicateCopy — W2-DQ P4's twin clause (a lot joined with its recorded sale)", () => {
  // A lot joined from Data Quality: own hash A (the buy), alias B (the sale),
  // and NOT auto-close-merged. Its twin is the same two records in another book.
  const joined = (accountId: number, hashes = [HASH_A, HASH_B]) => ({ identityHashes: hashes, autoClosed: false, accountId });

  it("is removable under EITHER hash when another account holds a set-equal identity set", () => {
    const group = [joined(1), joined(2, [HASH_B, HASH_A])];
    expect(isPlainDuplicateCopy(group[0], HASH_A, group)).toBe(true);
    expect(isPlainDuplicateCopy(group[0], HASH_B, group)).toBe(true);
    expect(isPlainDuplicateCopy(group[1], HASH_A, group)).toBe(true);
  });

  it("refuses when the other book is unjoined — its rows state {A} and {B}, not {A, B}", () => {
    const group = [joined(1), { identityHashes: [HASH_A], autoClosed: false, accountId: 2 }, { identityHashes: [HASH_B], autoClosed: false, accountId: 2 }];
    expect(isPlainDuplicateCopy(group[0], HASH_A, group)).toBe(false);
    expect(isPlainDuplicateCopy(group[0], HASH_B, group)).toBe(false);
  });

  it("refuses an auto-close merge, a twin in the SAME account, and a caller that passes no group", () => {
    const merged = { identityHashes: [HASH_A, HASH_B], autoClosed: true, accountId: 1 };
    expect(isPlainDuplicateCopy(merged, HASH_A, [merged, joined(2)])).toBe(false);
    expect(isPlainDuplicateCopy(joined(1), HASH_A, [joined(1), joined(1)])).toBe(false);
    expect(isPlainDuplicateCopy(joined(1), HASH_A)).toBe(false);
  });
});

describe("the sentence a group with no plain copy carries", () => {
  it("states what the rows are and where the pull ends — and advises nothing (SEBI copy rule)", () => {
    expect(NO_PLAIN_COPY_NOTE).toMatch(/Import → Disconnect/);
    expect(NO_PLAIN_COPY_NOTE).toMatch(/closed a position/);
    expect(NO_PLAIN_COPY_NOTE).not.toMatch(/\b(recommend|recommended|should|must|consider|suggest)\b/i);
    expect(NO_PLAIN_COPY_NOTE).not.toMatch(/\b(buy|sell)\b/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The fix, against a real migrated database.
 *
 * ONE temp database, one per file (AGENTS.md): lib/db caches its connection on
 * globalThis, so the query modules are imported dynamically AFTER the helper
 * has set VYUHA_DB_PATH.
 * ═══════════════════════════════════════════════════════════════════════════ */

let t: TempDb;
let actions: typeof import("@/app/data-quality/actions");
let identity: typeof import("@/lib/import/broker-identity");

const PRIMARY = 1;
const SWING = 2;
const SHARED_HASH = "shared-dedup-hash";

beforeAll(async () => {
  t = await openTempDb("data-quality", { seed: true });
  actions = await import("@/app/data-quality/actions");
  identity = await import("@/lib/import/broker-identity");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();
});

afterAll(() => t?.cleanup());

/** Both copies of ONE broker record, one per account — what a user gets by
 *  importing the same file into two accounts. */
function seedDuplicate(hash = SHARED_HASH) {
  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({ accountId: PRIMARY, broker: "dhan", symbol: "TCS", tradingsymbol: "TCS", dedupHash: hash, buyQty: 10, sellQty: 10, buyDate: "2026-07-01", sellDate: "2026-07-09" }),
      tradeRow({ accountId: SWING, broker: "dhan", symbol: "TCS", tradingsymbol: "TCS", dedupHash: hash, buyQty: 10, sellQty: 10, buyDate: "2026-07-01", sellDate: "2026-07-09" }),
    ])
    .run();
}

const tradesIn = (accountId: number) =>
  t.db.select().from(t.schema.trades).all().filter((r) => r.accountId === accountId);

const deleteAudits = () =>
  t.db.select().from(t.schema.auditLog).all().filter((a) => a.entity === "trade" && a.action === "delete");

beforeEach(() => {
  t.db.delete(t.schema.trades).run();
  t.db.delete(t.schema.auditLog).run();
  // The All-accounts view is where a cross-account duplicate is visible.
  t.db.update(t.schema.settings).set({ selectedAccountId: 0 }).run();
});

describe("the duplicate scan reads every account", () => {
  it("groups the two copies and counts the rows per account", () => {
    seedDuplicate();
    const groups = identity.listDuplicateTradeGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toBe(2);
    expect(groups[0].symbol).toBe("TCS");
    expect(groups[0].dedupHash).toBe(SHARED_HASH);
    expect(groups[0].accounts).toEqual([
      { id: PRIMARY, name: "Primary", rows: 1, removable: true },
      { id: SWING, name: "Swing", rows: 1, removable: true },
    ]);
  });

  it("says nothing about a sole copy", () => {
    t.db.insert(t.schema.trades).values(tradeRow({ accountId: PRIMARY, broker: "dhan", dedupHash: "only-here" })).run();
    expect(identity.listDuplicateTradeGroups()).toEqual([]);
    expect(identity.findDuplicateTradeGroup("dhan", "only-here")).toBeNull();
  });
});

describe("removeDuplicateCopy — the copy in ONE named account", () => {
  it("deletes that account's rows, leaves the other, and audits each one", async () => {
    seedDuplicate();
    const doomed = tradesIn(SWING).map((r) => r.id);

    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: SHARED_HASH, accountId: SWING });

    expect(res.ok).toBe(true);
    expect(res.removed).toBe(1);
    expect(tradesIn(SWING)).toHaveLength(0);
    expect(tradesIn(PRIMARY)).toHaveLength(1);

    // One audit row per deleted trade, written by the existing delete path.
    const audits = deleteAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(doomed[0]);
    expect(audits[0].source).toBe("data-quality");
  });

  it("refuses account 0 — the aggregate view is a view, not a place", async () => {
    seedDuplicate();
    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: SHARED_HASH, accountId: 0 });

    expect(res.ok).toBe(false);
    // The refusal must be ITS OWN — "that account holds no copy" would be true
    // of id 0 by accident, and the accident is not the rule (invariant 9).
    expect(res.message).toContain("All accounts is a view, not an account");
    expect(res.removed).toBe(0);
    expect(tradesIn(PRIMARY)).toHaveLength(1);
    expect(tradesIn(SWING)).toHaveLength(1);
    expect(deleteAudits()).toHaveLength(0);
  });

  it("refuses a group that is NOT duplicated across accounts, so a stale screen cannot delete the sole copy", async () => {
    t.db.insert(t.schema.trades).values(tradeRow({ accountId: PRIMARY, broker: "dhan", dedupHash: SHARED_HASH })).run();

    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: SHARED_HASH, accountId: PRIMARY });

    expect(res.ok).toBe(false);
    expect(res.removed).toBe(0);
    expect(tradesIn(PRIMARY)).toHaveLength(1);
    expect(deleteAudits()).toHaveLength(0);
  });

  it("refuses an account that holds no copy of the record", async () => {
    seedDuplicate();
    t.db.insert(t.schema.accounts).values({ id: 3, name: "Options", isDefault: false }).onConflictDoNothing().run();

    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: SHARED_HASH, accountId: 3 });

    expect(res.ok).toBe(false);
    expect(tradesIn(PRIMARY)).toHaveLength(1);
    expect(tradesIn(SWING)).toHaveLength(1);
  });

  it("removing the second copy leaves the first: the record survives once", async () => {
    seedDuplicate();
    expect((await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: SHARED_HASH, accountId: SWING })).ok).toBe(true);

    const again = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: SHARED_HASH, accountId: PRIMARY });
    expect(again.ok).toBe(false);
    expect(tradesIn(PRIMARY)).toHaveLength(1);
    expect(identity.listDuplicateTradeGroups()).toEqual([]);
  });

  it("says which view can remove it when another single account is selected", async () => {
    seedDuplicate();
    t.db.update(t.schema.settings).set({ selectedAccountId: PRIMARY }).run();

    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: SHARED_HASH, accountId: SWING });

    expect(res.ok).toBe(false);
    expect(res.message).toContain("Swing");
    expect(tradesIn(SWING)).toHaveLength(1);
  });
});

/* ── M-5, against the database: the merged lot and the plain copy ─────────── */

/**
 * Primary bought TCS in one import and sold it in a later one, so the sale was
 * auto-closed into the lot: ONE row, born with the buy file's hash (`HASH_A`),
 * carrying the sale's hash (`HASH_B`) as an alias. The same sale was also
 * imported on its own into Swing, where it sits as a plain single-source row
 * under `HASH_B`.
 *
 * `HASH_B` is therefore held in two accounts — and exactly one of the two rows
 * may go.
 */
function seedMergedLotAndPlainCopy() {
  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({
        accountId: PRIMARY,
        broker: "dhan",
        symbol: "TCS",
        dedupHash: HASH_A,
        importNotes: withLotCloseNote(null, HASH_B),
        buyQty: 10,
        sellQty: 10,
        buyDate: "2026-07-01",
        sellDate: "2026-07-09",
      }),
      tradeRow({
        accountId: SWING,
        broker: "dhan",
        symbol: "TCS",
        dedupHash: HASH_B,
        importNotes: null,
        buyQty: 0,
        sellQty: 10,
        sellDate: "2026-07-09",
      }),
    ])
    .run();
}

describe("a cross-account duplicate whose other copy is a MERGED LOT", () => {
  it("is a group at all — the scan reads ALIAS hashes, not just own hashes", () => {
    seedMergedLotAndPlainCopy();
    const groups = identity.listDuplicateTradeGroups();

    // Grouping on own hashes alone finds nothing here: the two rows do not
    // share a `dedup_hash` at all.
    expect(groups).toHaveLength(1);
    expect(groups[0].dedupHash).toBe(HASH_B);
    expect(groups[0].accounts.map((a) => a.id)).toEqual([PRIMARY, SWING]);
  });

  it("offers ONLY the plain copy: the merged lot is never removable", () => {
    seedMergedLotAndPlainCopy();
    const group = identity.findDuplicateTradeGroup("dhan", HASH_B)!;

    expect(group.accounts.find((a) => a.id === PRIMARY)!.removable).toBe(false);
    expect(group.accounts.find((a) => a.id === SWING)!.removable).toBe(true);
    // The ids a fix would take, per account — the merged lot's is not among them.
    expect(identity.duplicateTradeIdsIn("dhan", HASH_B, PRIMARY)).toEqual([]);
    expect(identity.duplicateTradeIdsIn("dhan", HASH_B, SWING)).toHaveLength(1);
  });

  it("the ACTION refuses the merged lot even when asked for it directly, and deletes nothing", async () => {
    seedMergedLotAndPlainCopy();

    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: HASH_B, accountId: PRIMARY });

    expect(res.ok).toBe(false);
    expect(res.removed).toBe(0);
    expect(res.message).toContain("merged lot");
    expect(tradesIn(PRIMARY)).toHaveLength(1);
    expect(tradesIn(SWING)).toHaveLength(1);
    expect(deleteAudits()).toHaveLength(0);
  });

  it("removes the plain copy, and the merged lot survives with both its identities", async () => {
    seedMergedLotAndPlainCopy();

    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: HASH_B, accountId: SWING });

    expect(res.ok).toBe(true);
    expect(res.removed).toBe(1);
    expect(tradesIn(SWING)).toHaveLength(0);
    const lot = tradesIn(PRIMARY);
    expect(lot).toHaveLength(1);
    expect(lot[0].dedupHash).toBe(HASH_A);
    expect(lot[0].importNotes).toContain(HASH_B);
    expect(identity.listDuplicateTradeGroups()).toEqual([]);
  });
});

/* ── D2: a group is described by the record it IS, not by its first row ──── */

const HASH_C = "3".repeat(40);

/**
 * The same sale in two books — and the row that comes FIRST is not the record.
 *
 * Primary bought 100 INFY on 2026-09-01 and later sold 40, so the sale was
 * auto-closed into that lot: what is left in Primary is a 60-share REMAINDER,
 * born with the buy file's hash (`HASH_A`) and carrying the sale's hash
 * (`HASH_B`) as an alias. Swing imported that same 40-share sale on its own,
 * where it is a plain single-source row under `HASH_B`.
 *
 * The group is keyed on `HASH_B` — a 40-share sale dated 2026-09-05 — and the
 * remainder lot is its first row. The lot's quantity and dates belong to the
 * BUY, so a group described from `rows[0]` tells the user that "60 × INFY,
 * 2026-09-01" is held twice: a different execution entirely, reported as a
 * critical issue.
 */
function seedRemainderLotAndPlainSale() {
  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({
        accountId: PRIMARY,
        broker: "dhan",
        symbol: "INFY",
        tradingsymbol: "INFY",
        dedupHash: HASH_A,
        importNotes: withLotCloseNote(null, HASH_B),
        buyQty: 60,
        sellQty: 0,
        buyDate: "2026-09-01",
        sellDate: null,
      }),
      tradeRow({
        accountId: SWING,
        broker: "dhan",
        symbol: "INFY",
        tradingsymbol: "INFY",
        dedupHash: HASH_B,
        importNotes: null,
        buyQty: 0,
        sellQty: 40,
        buyDate: null,
        sellDate: "2026-09-05",
      }),
    ])
    .run();
}

describe("what a cross-account duplicate group SAYS it is", () => {
  it("takes its facts from the row whose OWN identity is the group, not from the first row", () => {
    seedRemainderLotAndPlainSale();
    const group = identity.findDuplicateTradeGroup("dhan", HASH_B)!;

    // The remainder lot really is first in the group — the defect's precondition.
    expect(group.ids[0]).toBe(tradesIn(PRIMARY)[0].id);
    expect(group.symbol).toBe("INFY");
    expect({ qty: group.qty, buyDate: group.buyDate, sellDate: group.sellDate }).toEqual({
      qty: 40,
      buyDate: null,
      sellDate: "2026-09-05",
    });
  });

  it("the sentence the user reads names the sale, not the lot that survived it", () => {
    seedRemainderLotAndPlainSale();
    const [issue] = crossAccountIssues({ duplicateTradeGroups: identity.listDuplicateTradeGroups() });

    expect(issue.detail).toContain("(40 × INFY, 2026-09-05)");
    expect(issue.detail).not.toContain("60 × INFY");
    expect(issue.detail).not.toContain("2026-09-01");
  });

  /**
   * U-2 (round 2) — EVERY book merged the sale, so no row here describes it.
   *
   * Both accounts hold a lot the sale was folded into: one 60 bought on the
   * 1st, one 25 bought on the 2nd. The group is real (both books account for
   * that sale) but nothing in it states the sale's own quantity or dates, and
   * borrowing a merged lot's printed "60 × INFY, 2026-09-01" beside a sentence
   * saying each copy closed a position — a different execution entirely.
   */
  function seedTwoMergedLots() {
    t.db
      .insert(t.schema.trades)
      .values([
        tradeRow({ accountId: PRIMARY, broker: "dhan", symbol: "INFY", tradingsymbol: "INFY", dedupHash: HASH_A, importNotes: withLotCloseNote(null, HASH_B), buyQty: 60, sellQty: 0, buyDate: "2026-09-01" }),
        tradeRow({ accountId: SWING, broker: "dhan", symbol: "INFY", tradingsymbol: "INFY", dedupHash: HASH_C, importNotes: withLotCloseNote(null, HASH_B), buyQty: 25, sellQty: 0, buyDate: "2026-09-02" }),
      ])
      .run();
  }

  it("reports the quantity as UNKNOWN when NO row's own identity is the group — it borrows no lot's", () => {
    seedTwoMergedLots();

    const group = identity.findDuplicateTradeGroup("dhan", HASH_B)!;
    // Still a real duplicate, still named and still linked — and still no delete.
    expect(group.symbol).toBe("INFY");
    expect(group.brokerLabel).toBeTruthy();
    expect(group.rows).toBe(2);
    expect(group.accounts.map((a) => a.removable)).toEqual([false, false]);
    // Invariant 6: nothing here states the sale's quantity or its dates.
    expect({ qty: group.qty, buyDate: group.buyDate, sellDate: group.sellDate }).toEqual({
      qty: null,
      buyDate: null,
      sellDate: null,
    });
  });

  it("and the sentence prints “—”, never a merged lot's 60 shares or its buy date", () => {
    seedTwoMergedLots();
    const [issue] = crossAccountIssues({ duplicateTradeGroups: identity.listDuplicateTradeGroups() });

    expect(issue.detail).toContain("(— × INFY)");
    expect(issue.detail).not.toContain("60 × INFY");
    expect(issue.detail).not.toContain("25 × INFY");
    expect(issue.detail).not.toContain("2026-09-01");
    expect(issue.detail).not.toContain("2026-09-02");
  });
});

/* ── the screen, pinned on its source (vitest has no DOM here) ───────────── */

describe("the DuplicateFix card", () => {
  const src = readFileSync(path.join(process.cwd(), "components", "quality", "duplicate-fix.tsx"), "utf8");

  it("M-5 — a button is rendered only for a REMOVABLE account", () => {
    // The span cap is CRLF-safe by margin: the gap is 398 chars on LF and 408 on the
    // Windows CI checkout — a 400 cap went red there (CI 34464285189) while green here.
    expect(src).toMatch(/\.filter\(\(a\) => a\.removable\)[\s\S]{0,800}?Remove the copy in \{a\.name\}/);
    // The unfiltered map is gone: every account no longer gets a button.
    expect(src).not.toMatch(/\{g\.accounts\.map\(\(a\) => \(\r?\n\s*<Button/);
  });

  it("M-5 — a group with no plain copy states why, and links to Import instead", () => {
    expect(src).toMatch(/g\.accounts\.some\(\(a\) => a\.removable\)/);
    expect(src).toMatch(/\{NO_PLAIN_COPY_NOTE\}/);
    expect(src).toMatch(/import \{ NO_PLAIN_COPY_NOTE \} from "@\/lib\/analytics\/data-quality"/);
    // The copy is not re-typed in JSX — one sentence, in the pure module.
    expect(src).not.toMatch(/No copy of this record stands alone/);
  });

  it("U-1 — `busy` is cleared in a finally, so a thrown action cannot brick the dialog", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\r\n]*$/gm, "");
    expect(code).toMatch(/} catch [\s\S]{0,200}?toast\.error\(/);
    expect(code).toMatch(/} finally \{\r?\n\s*setBusy\(false\);\r?\n\s*\}/);
    // …and never the bare unwound form that left it true for ever.
    expect(code).not.toMatch(/await removeDuplicateCopy\(\{[\s\S]*?\}\);\r?\n\s*setBusy\(false\);/);
  });

  it("U-1 (round 2) — the catch toasts a FIXED sentence, never the thrown message", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\r\n]*$/gm, "");
    // `removeDuplicateCopy` is a server action: a production build replaces a
    // server-side error's message with React's redaction boilerplate, so
    // `err.message` shows the user a paragraph about digests. The span cap is
    // CRLF-safe by margin (a 400-char cap went red on the Windows checkout,
    // CI 34464285189).
    expect(code).toMatch(/} catch [\s\S]{0,300}?toast\.error\("Nothing was removed\.[^"]*"\);/);
    expect(code).not.toMatch(/err instanceof Error/);
    // Nothing between `catch` and the toast reads a message off the throw.
    expect(code).not.toMatch(/} catch [\s\S]{0,300}?\.message/);
    // The action's own refusals still arrive as data, with their real sentence.
    expect(code).toMatch(/if \(res\.ok\) toast\.success\(res\.message\);\r?\n\s*else toast\.error\(res\.message\);/);
  });

  it("U-2 — a group with no stated quantity prints “—” rather than a borrowed one", () => {
    expect(src).toMatch(/qty \{g\.qty \?\? "—"\}/);
    expect(src).toMatch(/qty: number \| null;/);
  });

  it("R12 — closing the confirm returns focus to the button that opened it, never <body>", () => {
    // The dialog is opened from state, with no DialogTrigger, so Radix's own
    // restore focuses a null triggerRef and keyboard focus fell to <body>. The
    // opener is kept in a REF (no state, no effect) and focused from
    // onCloseAutoFocus, whose preventDefault skips Radix's own restore.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\r\n]*$/gm, "");
    expect(code).toMatch(/const openerRef = React\.useRef<HTMLButtonElement \| null>\(null\);/);
    expect(code).toMatch(/openerRef\.current = e\.currentTarget;\s*setTarget\(/);
    expect(code).toMatch(/onCloseAutoFocus=\{\(e\) => \{\s*e\.preventDefault\(\);\s*openerRef\.current\?\.focus\(\);/);
  });
});
