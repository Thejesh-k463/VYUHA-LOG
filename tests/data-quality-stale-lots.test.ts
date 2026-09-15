import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  assessDataQuality,
  hasRecordedBasis,
  staleOpenPairs,
  staleSaleRows,
  type QualityInputs,
  type QualityTrade,
} from "@/lib/analytics/data-quality";
import { computeCharges } from "@/lib/engine/charges";
import { findRates } from "@/lib/engine/rates";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { withStaleCloseNote } from "@/lib/import/close-open-lots";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * R26 (v4.3.0) — Data Quality lists the stale open rows and closes them with
 * the sale the book already stored (owner ruling R10 half b, 06-ANSWERS:224;
 * with auto-close OFF, 06-ANSWERS:353, it is the only remedy).
 *
 * v4.2.0 stored a SELL of a held lot as its own row: an open, sell-only row
 * beside the long it actually closed, and for a Dhan /positions pull with
 * `sell_date` NULL. The pure half pairs such a row with the lot; the DB half
 * drives the real route handler and the real `closeStaleLot`.
 *
 * ONE temp database per FILE (AGENTS.md): `lib/db` caches its connection on
 * globalThis, so the DB cases run one after another on it, each in its own
 * account with its own symbol.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// StaleLotFix calls `useRouter`, which needs a mounted app router: a framework stub.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

// ─────────────────────────────── the pure half ──────────────────────────────

let seq = 0;
const q = (p: Partial<QualityTrade> = {}): QualityTrade => ({
  id: ++seq,
  isOpen: true,
  acquisition: null,
  acquisitionPrice: null,
  closingPrice: null,
  slPlanned: 1,
  riskAmount: 1,
  segment: "eq_delivery",
  mtfFundedAmount: null,
  instrumentType: "equity",
  expiry: null,
  strike: null,
  optionType: null,
  symbol: "MARKSANS",
  tradingsymbol: "MARKSANS",
  accountId: 1,
  broker: "dhan",
  exchange: "NSE",
  buyQty: 0,
  sellQty: 0,
  avgBuyPrice: 0,
  avgSellPrice: 0,
  buyDate: null,
  sellDate: null,
  createdAt: "2026-08-20 04:00:00",
  staged: false,
  ...p,
});

/** An open long: BUY 100 @ 200 on 2026-08-20. */
const lot = (p: Partial<QualityTrade> = {}) => q({ buyQty: 100, avgBuyPrice: 200, buyDate: "2026-08-20", ...p });
/**
 * v4.2.0's Dhan /positions sale: sell-only, open, `sell_date` NULL, pulled at
 * 00:30 IST on 2026-08-28 — which is still 2026-08-27 in UTC, the clock
 * SQLite's `datetime('now')` keeps.
 */
const sale = (p: Partial<QualityTrade> = {}) =>
  q({ sellQty: 100, avgSellPrice: 250, sellDate: null, createdAt: "2026-08-27 19:00:00", ...p });

const inputs = (trades: QualityTrade[]): QualityInputs => ({
  trades,
  markedTradeIds: new Set(trades.map((t) => t.id)),
  knownSymbols: new Set(trades.map((t) => t.symbol.toUpperCase())),
  ipoLinkedTradeIds: new Set(),
  staleMtmCount: 0,
  missingAttachmentFiles: 0,
});

const staleIssues = (trades: QualityTrade[]) => assessDataQuality(inputs(trades)).issues.filter((i) => i.code === "stale_open");

describe("staleOpenPairs + the stale_open issue (pure)", () => {
  it("MARKSANS BUY 100 open + a sell-only 100 with no date: one critical issue on the lot, one-click", () => {
    const L = lot();
    const S = sale();
    const issues = staleIssues([L, S]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "critical", count: 1, href: "/data-quality#stale-open", ids: [L.id] });

    expect(staleOpenPairs([L, S])).toEqual([
      expect.objectContaining({
        lotId: L.id,
        saleId: S.id,
        side: "long",
        lotQty: 100,
        saleQty: 100,
        salePrice: 250,
        // The IST day of the pull, not the UTC one — and flagged as derived.
        saleDate: "2026-08-28",
        saleDateStated: false,
        oneClick: true,
      }),
    ]);
  });

  it("a basis-unknown sale (M-3's Dhan shape) pairs the same way — the lot IS its basis", () => {
    const L = lot();
    const S = sale({ acquisition: "unknown", sellDate: "2026-08-28" });
    expect(staleOpenPairs([L, S]).map((p) => [p.lotId, p.saleId, p.saleDateStated, p.oneClick])).toEqual([[L.id, S.id, true, true]]);
  });

  it("a same-day pair is listed ONCE — the sale is never also read as a short the buy covered", () => {
    const L = lot({ buyDate: "2026-08-28" });
    const S = sale({ sellDate: "2026-08-28" });
    expect(staleOpenPairs([L, S])).toHaveLength(1);
    expect(staleIssues([L, S])[0].ids).toEqual([L.id]);

    // The same on a derivative, where a sell-only row CAN be a genuine short:
    // each row takes one role, so the pair still appears once, read forward.
    const F = { segment: "future", instrumentType: "future", symbol: "NIFTY", tradingsymbol: "NIFTY26SEPFUT" };
    const fBuy = lot({ ...F, buyDate: "2026-08-28" });
    const fSell = sale({ ...F, sellDate: "2026-08-28" });
    expect(staleOpenPairs([fBuy, fSell]).map((p) => [p.lotId, p.saleId, p.side])).toEqual([[fBuy.id, fSell.id, "long"]]);
  });

  it("another account's sale pairs with nothing", () => {
    expect(staleIssues([lot({ accountId: 1 }), sale({ accountId: 2 })])).toEqual([]);
  });

  it("a sale dated BEFORE the buy pairs with nothing (and a delivery sale is never a short)", () => {
    const L = lot({ buyDate: "2026-08-20" });
    const S = sale({ sellDate: "2026-08-10" });
    expect(staleOpenPairs([L, S])).toEqual([]);
    expect(staleIssues([L, S])).toEqual([]);
  });

  it("SELL 40 against 100 open is listed, with no one-click", () => {
    const L = lot();
    const S = sale({ sellQty: 40 });
    const [p] = staleOpenPairs([L, S]);
    expect([p.lotId, p.saleId, p.lotQty, p.saleQty, p.oneClick]).toEqual([L.id, S.id, 100, 40, false]);
    expect(staleIssues([L, S])[0].ids).toEqual([L.id]);
  });

  it("an eq_mtf lot is listed (the remedy prices MTF interest from the confirmed date)", () => {
    const L = lot({ segment: "eq_mtf" });
    const S = sale({ segment: "eq_mtf" });
    expect(staleOpenPairs([L, S]).map((p) => [p.lotId, p.oneClick])).toEqual([[L.id, true]]);
  });

  it("another broker or another exchange never pairs", () => {
    // RE-PINNED (W2-FIXD2, seam defect D2): this line asserted that a staged lot
    // never pairs — measured before: []; after: one listed pair, never
    // one-click. The decided P1/P2 rule lists EVERY open lot with a later sale
    // row in its book; the staged cases live in their own describe below.
    expect(staleOpenPairs([lot({ staged: true }), sale()]).map((p) => [p.staged, p.oneClick])).toEqual([[true, false]]);
    expect(staleOpenPairs([lot(), sale({ broker: "zerodha" })])).toEqual([]);
    expect(staleOpenPairs([lot(), sale({ exchange: "BSE" })])).toEqual([]);
  });

  it("rows without the identity fields (an older caller) are skipped, not guessed at", () => {
    const bare = (p: Partial<QualityTrade>): QualityTrade => {
      const r = q(p) as Partial<QualityTrade>;
      delete r.accountId;
      delete r.tradingsymbol;
      return r as QualityTrade;
    };
    expect(staleIssues([bare({ buyQty: 100, buyDate: "2026-08-20" }), bare({ sellQty: 100, sellDate: "2026-08-28" })])).toEqual([]);
  });
});

describe("W2-FIXD2 (seam D2) — a staged lot is listed against its sale, and never offered the one-step join (pure)", () => {
  it("a holding bought in two fills on one day (ONE staged row of 100) + a sale of 100: listed for all 100, no one-click", () => {
    const L = lot({ staged: true, buyDate: "2026-09-07" });
    const S = sale({ acquisition: "unknown", sellDate: "2026-09-08" });
    const pairs = staleOpenPairs([L, S]);
    expect(pairs.map((p) => [p.lotId, p.saleId, p.lotQty, p.matchedQty, p.staged, p.oneClick])).toEqual([[L.id, S.id, 100, 100, true, false]]);
    expect(staleIssues([L, S])[0].ids, "the critical stale_open issue counts it").toEqual([L.id]);
    // Listed as a PAIR, so the sale is not also a stale_sale warning.
    expect(saleIssues([L, S])).toEqual([]);
  });

  it("a staged short (a contract sold in two fills) is listed the same way, never one-click", () => {
    const F = { segment: "future", instrumentType: "future", symbol: "NIFTY", tradingsymbol: "NIFTY26SEPFUT" };
    const short = q({ ...F, staged: true, sellQty: 50, avgSellPrice: 100, sellDate: "2026-09-01" });
    const cover = q({ ...F, buyQty: 50, avgBuyPrice: 90, buyDate: "2026-09-03" });
    expect(staleOpenPairs([short, cover]).map((p) => [p.lotId, p.side, p.matchedQty, p.staged, p.oneClick])).toEqual([[short.id, "short", 50, true, false]]);
  });
});

// ─────────── W2-DQ P1 / P2 / P3 (v4.3.0 fix wave 2) — the pure half ─────────

const saleIssues = (trades: QualityTrade[]) => assessDataQuality(inputs(trades)).issues.filter((i) => i.code === "stale_sale");

describe("W2-DQ P1 — sales are allocated to lots oldest lot first, and every lot a sale reaches is listed", () => {
  it("L1 100 (09-01) + L2 100 (09-02) + one SELL 200 (09-05): BOTH lots listed, neither one-click", () => {
    const L1 = lot({ buyDate: "2026-09-01" });
    const L2 = lot({ buyDate: "2026-09-02" });
    const S = sale({ sellQty: 200, sellDate: "2026-09-05" });
    expect(staleOpenPairs([L1, L2, S]).map((p) => [p.lotId, p.saleId, p.lotQty, p.saleQty, p.oneClick])).toEqual([
      [L1.id, S.id, 100, 200, false],
      [L2.id, S.id, 100, 200, false],
    ]);
    expect(staleOpenPairs([L1, L2, S]).map((p) => p.matchedQty), "the sale's excess carries to the next lot").toEqual([100, 100]);
    const [issue] = staleIssues([L1, L2, S]);
    expect([issue.count, issue.ids]).toEqual([2, [L1.id, L2.id]]);
  });

  it("whole sale rows covering whole lots exactly stay one-click, each with its own lot (FIFO)", () => {
    const L1 = lot({ buyDate: "2026-09-01" });
    const L2 = lot({ buyDate: "2026-09-02" });
    const S1 = sale({ sellDate: "2026-09-05" });
    const S2 = sale({ sellDate: "2026-09-06" });
    expect(staleOpenPairs([S2, L2, S1, L1]).map((p) => [p.lotId, p.saleId, p.matchedQty, p.oneClick])).toEqual([
      [L1.id, S1.id, 100, true],
      [L2.id, S2.id, 100, true],
    ]);
  });

  it("a lot covered by PART of a sale is listed without the button, and so is the lot that took the rest", () => {
    const L1 = lot({ buyDate: "2026-09-01" });
    const L2 = lot({ buyQty: 50, buyDate: "2026-09-02" });
    const S = sale({ sellQty: 150, sellDate: "2026-09-05" });
    expect(staleOpenPairs([L1, L2, S]).map((p) => [p.lotId, p.lotQty, p.matchedQty, p.oneClick])).toEqual([
      [L1.id, 100, 100, false],
      [L2.id, 50, 50, false],
    ]);
  });

  it("a sale is never allocated to a lot dated after it, and a lot no sale reaches is a holding, not listed", () => {
    const L1 = lot({ buyDate: "2026-09-01" });
    const later = lot({ buyDate: "2026-09-06" });
    const S = sale({ sellQty: 200, sellDate: "2026-09-05" });
    expect(staleOpenPairs([L1, later, S]).map((p) => [p.lotId, p.matchedQty])).toEqual([[L1.id, 100]]);

    const held = lot({ buyDate: "2026-09-02" });
    const S100 = sale({ sellDate: "2026-09-05" });
    expect(staleOpenPairs([L1, held, S100]).map((p) => [p.lotId, p.saleId, p.oneClick])).toEqual([[L1.id, S100.id, true]]);
    expect(staleIssues([L1, held, S100])[0].ids).toEqual([L1.id]);
  });
});

describe("W2-DQ P3 — a sale whose basis the user recorded is never a stale-close candidate", () => {
  it("a CLOSED ESOP sale at 50 beside a held market lot: no pair, no stale_open (was a CRITICAL one-click)", () => {
    const L = lot({ buyDate: "2026-08-01" });
    const S = sale({ isOpen: false, acquisition: "esop", acquisitionPrice: 50, sellDate: "2026-08-15" });
    expect(staleOpenPairs([L, S]).map((p) => [p.lotId, p.saleId, p.lotQty, p.saleQty, p.oneClick])).toEqual([]);
    expect(staleIssues([L, S])).toEqual([]);
    // It is not a stale sale either: it is closed, and its basis is the user's.
    expect(saleIssues([L, S])).toEqual([]);
  });

  it("either half of a recorded basis is enough; 'unknown' with no price is not a recorded basis", () => {
    expect(hasRecordedBasis({ acquisition: "esop", acquisitionPrice: null })).toBe(true);
    expect(hasRecordedBasis({ acquisition: "unknown", acquisitionPrice: 50 })).toBe(true);
    expect(hasRecordedBasis({ acquisition: "unknown", acquisitionPrice: null })).toBe(false);
    expect(hasRecordedBasis({ acquisition: null, acquisitionPrice: 0 })).toBe(false);
    const L = lot({ buyDate: "2026-08-01" });
    expect(staleOpenPairs([L, sale({ acquisition: "gift", sellDate: "2026-08-15" })])).toEqual([]);
    expect(staleOpenPairs([L, sale({ acquisition: "unknown", acquisitionPrice: 50, sellDate: "2026-08-15" })])).toEqual([]);
  });

  it("the short pass reads the same rule: a purchase with a recorded basis never covers a short", () => {
    const F = { segment: "future", instrumentType: "future", symbol: "NIFTY", tradingsymbol: "NIFTY26SEPFUT" };
    const short = q({ ...F, sellQty: 50, avgSellPrice: 100, sellDate: "2026-09-01" });
    const cover = q({ ...F, buyQty: 50, avgBuyPrice: 90, buyDate: "2026-09-03" });
    expect(staleOpenPairs([short, cover]).map((p) => [p.lotId, p.side])).toEqual([[short.id, "short"]]);
    expect(staleOpenPairs([short, { ...cover, acquisitionPrice: 90 }])).toEqual([]);
  });
});

describe("W2-DQ P2 — a closing-trade row left open after its position closed is a WARNING (pure)", () => {
  it("delivery: sales 40 + 60 beside a CLOSED lot 100 entered before them are listed; nothing is stale_open", () => {
    const L = lot({ isOpen: false, sellQty: 100, avgSellPrice: 250, buyDate: "2026-08-20", sellDate: "2026-08-28" });
    const S40 = sale({ sellQty: 40, sellDate: "2026-08-28" });
    const S60 = sale({ sellQty: 60, sellDate: "2026-08-29" });
    const report = assessDataQuality(inputs([L, S40, S60]));
    expect(report.issues.filter((i) => i.code === "stale_open")).toEqual([]);
    const [issue] = report.issues.filter((i) => i.code === "stale_sale");
    expect(issue).toMatchObject({ severity: "warning", count: 2, href: "/data-quality#stale-open", ids: [S40.id, S60.id] });
    expect(`${issue.title} ${issue.detail}`).not.toMatch(/\b(delete|should|must|recommend|consider|suggest)\b/i);
    expect(staleSaleRows([L, S40, S60]).map((s) => [s.saleId, s.side, s.saleQty, s.closedLotIds])).toEqual([
      [S40.id, "long", 40, [L.id]],
      [S60.id, "long", 60, [L.id]],
    ]);
  });

  it("narrow: no closed lot, a closed lot entered AFTER the sale, a sale still paired, or a recorded basis — no warning", () => {
    const S = sale({ sellDate: "2026-08-28" });
    expect(saleIssues([q({ symbol: "OTHER", tradingsymbol: "OTHER" }), S])).toEqual([]);
    const closedLater = lot({ isOpen: false, sellQty: 100, buyDate: "2026-09-01", sellDate: "2026-09-02" });
    expect(saleIssues([closedLater, S])).toEqual([]);
    const closed = lot({ isOpen: false, sellQty: 100, buyDate: "2026-08-01", sellDate: "2026-08-02" });
    const open = lot({ buyDate: "2026-08-20" });
    expect(saleIssues([closed, open, S]), "an open lot still pairs it: stale_open's job").toEqual([]);
    expect(saleIssues([closed, sale({ acquisition: "esop", sellDate: "2026-08-28" })])).toEqual([]);
  });

  it("mirrored for a short, and never in a segment that cannot hold a short", () => {
    const F = { segment: "future", instrumentType: "future", symbol: "NIFTY", tradingsymbol: "NIFTY26SEPFUT" };
    const coveredShort = q({ ...F, isOpen: false, sellQty: 50, buyQty: 50, sellDate: "2026-09-01", buyDate: "2026-09-02" });
    const purchase = q({ ...F, buyQty: 50, avgBuyPrice: 90, buyDate: "2026-09-03" });
    expect(staleSaleRows([coveredShort, purchase]).map((s) => [s.saleId, s.side, s.closedLotIds])).toEqual([
      [purchase.id, "short", [coveredShort.id]],
    ]);
    // Delivery: a closed round trip then a new buy is a holding, never a purchase against a short.
    const roundTrip = lot({ isOpen: false, sellQty: 100, buyDate: "2026-09-01", sellDate: "2026-09-01" });
    expect(staleSaleRows([roundTrip, lot({ buyDate: "2026-09-03" })])).toEqual([]);
  });
});

// ─────────── R2-DQ N7–N12 (v4.3.0 fix wave 2R) — the pure half ─────────

const reviewIssues = (trades: QualityTrade[]) => assessDataQuality(inputs(trades)).issues.filter((i) => i.code === "stale_review");

describe("R2-DQ N7/N8 — after a lot was closed elsewhere, a re-paired sale is listed for review, never one-click", () => {
  it("N7: a staged lot exited on its ladder, a held lot and the recorded sale: the held lot is not critical, the pair is a review warning", () => {
    const L1 = lot({ staged: true, isOpen: false, sellQty: 100, avgSellPrice: 250, buyDate: "2026-08-20", sellDate: "2026-08-28" });
    const L2 = lot({ avgBuyPrice: 210, buyDate: "2026-08-22" });
    const S = sale({ sellDate: "2026-08-28" });
    expect(staleOpenPairs([L1, L2, S]).map((p) => [p.lotId, p.saleId, p.matchedQty, p.ambiguous, p.oneClick, p.closedLotIds])).toEqual([
      [L2.id, S.id, 100, true, false, [L1.id]],
    ]);
    expect(staleIssues([L1, L2, S]), "a held lot is never a CRITICAL stale_open here").toEqual([]);
    const [review] = reviewIssues([L1, L2, S]);
    expect(review).toMatchObject({ severity: "warning", count: 1, ids: [S.id], href: "/data-quality#stale-open" });
    expect(`${review.title} ${review.detail}`).not.toMatch(/\b(delete|should|must|recommend|consider|suggest)\b/i);
    // Listed once, as a pair: not also a stale_sale.
    expect(saleIssues([L1, L2, S])).toEqual([]);
  });

  it("N8: the manual close of the partial lot — S1 re-pairs with the later lot for review only, S2 is a stale_sale", () => {
    const L1 = lot({ isOpen: false, sellQty: 100, avgSellPrice: 250, buyDate: "2026-08-20", sellDate: "2026-08-26" });
    const L2 = lot({ buyQty: 40, avgBuyPrice: 210, buyDate: "2026-08-22" });
    const S1 = sale({ sellQty: 40, sellDate: "2026-08-25" });
    const S2 = sale({ sellQty: 60, sellDate: "2026-08-26" });
    expect(staleOpenPairs([L1, L2, S1, S2]).map((p) => [p.lotId, p.saleId, p.matchedQty, p.ambiguous, p.oneClick])).toEqual([
      [L2.id, S1.id, 40, true, false],
    ]);
    expect(staleIssues([L1, L2, S1, S2])).toEqual([]);
    expect(reviewIssues([L1, L2, S1, S2])[0].ids).toEqual([S1.id]);
    expect(staleSaleRows([L1, L2, S1, S2]).map((s) => [s.saleId, s.closedLotIds])).toEqual([[S2.id, [L1.id]]]);
  });

  it("unambiguous stays one-click: a closed lot entered AFTER the sale, or in another book, changes nothing", () => {
    const L = lot({ buyDate: "2026-08-20" });
    const S = sale({ sellDate: "2026-08-28" });
    const later = lot({ isOpen: false, sellQty: 100, buyDate: "2026-09-01", sellDate: "2026-09-02" });
    const otherBook = lot({ isOpen: false, sellQty: 100, buyDate: "2026-08-01", sellDate: "2026-08-02", accountId: 2 });
    expect(staleOpenPairs([L, S, later, otherBook]).map((p) => [p.lotId, p.ambiguous, p.oneClick, p.closedLotIds])).toEqual([[L.id, false, true, []]]);
    expect(staleIssues([L, S, later, otherBook])[0].ids).toEqual([L.id]);
    expect(reviewIssues([L, S, later, otherBook])).toEqual([]);
  });

  it("a same-day round trip of a contract has no knowable direction, so it CAN have taken the sale: review, not one-click", () => {
    const F = { segment: "future", instrumentType: "future", symbol: "NIFTY", tradingsymbol: "NIFTY26SEPFUT" };
    const sameDay = q({ ...F, isOpen: false, buyQty: 50, sellQty: 50, buyDate: "2026-09-01", sellDate: "2026-09-01" });
    // Re-pinned (R2F-DQ, the narrowed rule): L was entered 09-02, after the round trip's 09-01 exit, which now reads
    // unambiguous (measured: ambiguous true before, false after). L entered the SAME day keeps this pinning the N12 "possible" mode.
    const L = q({ ...F, buyQty: 50, avgBuyPrice: 100, buyDate: "2026-09-01" });
    const S = q({ ...F, sellQty: 50, avgSellPrice: 110, sellDate: "2026-09-03" });
    expect(staleOpenPairs([sameDay, L, S]).map((p) => [p.lotId, p.ambiguous, p.oneClick])).toEqual([[L.id, true, false]]);
  });
});

describe("R2F-DQ — a closed lot makes the book ambiguous ONLY if its exit is on or after the open lot's entry", () => {
  it("MARKSANS: a round trip closed in 2025, bought again in 2026, v4.2.0's sale row beside it — one-click, critical stale_open, no review", () => {
    const older = lot({ isOpen: false, sellQty: 100, avgSellPrice: 180, buyDate: "2025-03-10", sellDate: "2025-06-02" });
    const L = lot({ buyDate: "2026-08-20" });
    const S = sale({ sellDate: "2026-08-28" });
    expect(staleOpenPairs([older, L, S]).map((p) => [p.lotId, p.saleId, p.ambiguous, p.oneClick, p.closedLotIds])).toEqual([
      [L.id, S.id, false, true, []],
    ]);
    expect(staleIssues([older, L, S])[0].ids).toEqual([L.id]);
    expect(reviewIssues([older, L, S])).toEqual([]);
  });

  it("the boundary is inclusive: a closed lot exited ON the open lot's entry day overlapped it — review, not one-click", () => {
    const older = lot({ isOpen: false, sellQty: 100, buyDate: "2026-08-10", sellDate: "2026-08-20" });
    const L = lot({ buyDate: "2026-08-20" });
    const S = sale({ sellDate: "2026-08-28" });
    expect(staleOpenPairs([older, L, S]).map((p) => [p.lotId, p.ambiguous, p.oneClick, p.closedLotIds])).toEqual([[L.id, true, false, [older.id]]]);
  });

  it("a closed lot with no stated exit date cannot be shown to precede the open lot, so it still counts", () => {
    const noExit = lot({ isOpen: false, sellQty: 100, buyDate: "2025-03-10", sellDate: null });
    const L = lot({ buyDate: "2026-08-20" });
    const S = sale({ sellDate: "2026-08-28" });
    expect(staleOpenPairs([noExit, L, S]).map((p) => [p.lotId, p.ambiguous, p.oneClick, p.closedLotIds])).toEqual([[L.id, true, false, [noExit.id]]]);
  });

  it("short side: a closed short's exit is its COVER (buy) date — covered before the new write is one-click, covered after it is review", () => {
    const F = { segment: "future", instrumentType: "future", symbol: "NIFTY", tradingsymbol: "NIFTY26SEPFUT" };
    const L = q({ ...F, sellQty: 50, avgSellPrice: 120, sellDate: "2026-09-02" });
    const S = q({ ...F, buyQty: 50, avgBuyPrice: 110, buyDate: "2026-09-04" });
    const coveredBefore = q({ ...F, isOpen: false, sellQty: 50, buyQty: 50, sellDate: "2026-07-01", buyDate: "2026-07-05" });
    expect(staleOpenPairs([coveredBefore, L, S]).map((p) => [p.lotId, p.side, p.ambiguous, p.oneClick])).toEqual([[L.id, "short", false, true]]);
    const coveredAfter = q({ ...F, isOpen: false, sellQty: 50, buyQty: 50, sellDate: "2026-08-25", buyDate: "2026-09-03" });
    expect(staleOpenPairs([coveredAfter, L, S]).map((p) => [p.lotId, p.side, p.ambiguous, p.oneClick, p.closedLotIds])).toEqual([
      [L.id, "short", true, false, [coveredAfter.id]],
    ]);
  });
});

describe("M2 (wave 2G) — a lot closed by the Data Quality join itself never makes the book ambiguous", () => {
  // Stacked lots L1 100 (08-20) and L2 50 (08-21), each with v4.2.0's sale row: S1 100 (08-25), S2 50 (08-26).
  const SALE_HASH = "a".repeat(40);
  const joined = (p: Partial<QualityTrade>) => lot({ isOpen: false, sellQty: 100, avgSellPrice: 250, importNotes: withStaleCloseNote(null, SALE_HASH), ...p });

  it("L1 joined with S1 from Data Quality: [L2, S2] stays one-click and critical, with no review", () => {
    const L1 = joined({ buyDate: "2026-08-20", sellDate: "2026-08-25" });
    const L2 = lot({ buyQty: 50, avgBuyPrice: 210, buyDate: "2026-08-21" });
    const S2 = sale({ sellQty: 50, avgSellPrice: 260, sellDate: "2026-08-26" });
    expect(staleOpenPairs([L1, L2, S2]).map((p) => [p.lotId, p.saleId, p.ambiguous, p.oneClick, p.closedLotIds])).toEqual([
      [L2.id, S2.id, false, true, []],
    ]);
    expect(staleIssues([L1, L2, S2])[0].ids).toEqual([L2.id]);
    expect(reviewIssues([L1, L2, S2])).toEqual([]);
  });

  it("either join order: L2 joined with S2 first leaves [L1, S1] one-click", () => {
    const L1 = lot({ buyDate: "2026-08-20" });
    const L2 = joined({ buyQty: 50, sellQty: 50, avgBuyPrice: 210, buyDate: "2026-08-21", sellDate: "2026-08-26" });
    const S1 = sale({ sellDate: "2026-08-25" });
    expect(staleOpenPairs([L1, L2, S1]).map((p) => [p.lotId, p.saleId, p.ambiguous, p.oneClick])).toEqual([[L1.id, S1.id, false, true]]);
  });

  it("controls: the same close made elsewhere (no note), or an alias with no Data Quality note, still counts", () => {
    const L2 = lot({ buyQty: 50, avgBuyPrice: 210, buyDate: "2026-08-21" });
    const S2 = sale({ sellQty: 50, avgSellPrice: 260, sellDate: "2026-08-26" });
    const elsewhere = joined({ buyDate: "2026-08-20", sellDate: "2026-08-25", importNotes: null });
    expect(staleOpenPairs([elsewhere, L2, S2]).map((p) => [p.lotId, p.ambiguous, p.oneClick, p.closedLotIds])).toEqual([[L2.id, true, false, [elsewhere.id]]]);
    const aliasOnly = joined({ buyDate: "2026-08-20", sellDate: "2026-08-25", importNotes: `dedup-alias:${SALE_HASH}` });
    expect(staleOpenPairs([aliasOnly, L2, S2]).map((p) => [p.lotId, p.ambiguous, p.oneClick, p.closedLotIds])).toEqual([[L2.id, true, false, [aliasOnly.id]]]);
  });
});

describe("R2-DQ N9/N10 — a sale recorded in several fills (staged)", () => {
  it("N9: left open after its lot closed, a staged sale IS listed by stale_sale", () => {
    const L = lot({ isOpen: false, sellQty: 100, avgSellPrice: 250, buyDate: "2026-08-20", sellDate: "2026-08-28" });
    const S = sale({ staged: true, sellDate: "2026-08-28" });
    expect(staleSaleRows([L, S]).map((s) => [s.saleId, s.side, s.closedLotIds])).toEqual([[S.id, "long", [L.id]]]);
    expect(saleIssues([L, S])[0]).toMatchObject({ severity: "warning", ids: [S.id] });
  });

  it("N10: beside an open lot, a staged sale is listed with no one-click (never joined)", () => {
    const L = lot();
    const S = sale({ staged: true, sellDate: "2026-08-28" });
    expect(staleOpenPairs([L, S]).map((p) => [p.lotId, p.saleId, p.saleStaged, p.staged, p.oneClick])).toEqual([[L.id, S.id, true, false, false]]);
  });
});

describe("R2-DQ N12 — a same-day write-and-cover is not a closed long", () => {
  const OPT = {
    broker: "zerodha",
    segment: "option",
    instrumentType: "option",
    exchange: "NFO",
    symbol: "NIFTY",
    tradingsymbol: "NIFTY26SEP25000CE",
    expiry: "2026-09-29",
    strike: 25000,
    optionType: "CE",
  };

  it("a later genuine write of the same contract is not called a closing trade with no open position", () => {
    const coveredSameDay = q({ ...OPT, isOpen: false, sellQty: 75, buyQty: 75, avgSellPrice: 100, avgBuyPrice: 90, buyDate: "2026-09-01", sellDate: "2026-09-01" });
    const write = q({ ...OPT, sellQty: 75, avgSellPrice: 120, sellDate: "2026-09-03" });
    expect(staleSaleRows([coveredSameDay, write])).toEqual([]);
    expect(saleIssues([coveredSameDay, write])).toEqual([]);
  });

  it("controls: a genuine closed long (bought, sold the next day) still counts, and so does a same-day DELIVERY round trip (no short exists there)", () => {
    const closedLong = q({ ...OPT, isOpen: false, sellQty: 75, buyQty: 75, buyDate: "2026-09-01", sellDate: "2026-09-02" });
    const write = q({ ...OPT, sellQty: 75, avgSellPrice: 120, sellDate: "2026-09-03" });
    expect(staleSaleRows([closedLong, write]).map((s) => [s.saleId, s.side, s.closedLotIds])).toEqual([[write.id, "long", [closedLong.id]]]);

    const roundTrip = lot({ isOpen: false, sellQty: 100, buyDate: "2026-09-01", sellDate: "2026-09-01" });
    const S = sale({ sellDate: "2026-09-03" });
    expect(staleSaleRows([roundTrip, S]).map((s) => [s.saleId, s.closedLotIds])).toEqual([[S.id, [roundTrip.id]]]);
  });
});

// ──────────────────────────────── the DB half ───────────────────────────────

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let route: typeof import("@/app/api/data-quality/close-stale/route");
let dq: typeof import("@/lib/queries/data-quality");
let trash: typeof import("@/lib/trash");
let identity: typeof import("@/lib/import/broker-identity");
let ratesDb: typeof import("@/lib/engine/rates-db");
let StaleLotFix: typeof import("@/components/quality/stale-lot-fix").StaleLotFix;

const r2 = (n: number) => Math.round(n * 100) / 100;

function trade(over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade {
  return {
    broker: "dhan",
    isin: null,
    buyQty: 0,
    avgBuyPrice: 0,
    buyValue: 0,
    sellQty: 0,
    avgSellPrice: 0,
    sellValue: 0,
    closingPrice: null,
    grossPnl: 0,
    unrealisedPnl: 0,
    buyDate: null,
    sellDate: null,
    productHint: "delivery",
    exchangeHint: "NSE",
    sourceFile: null,
    ...over,
  } as NormalizedTrade;
}

const parsed = (trades: NormalizedTrade[]): ParsedFile => ({
  sourceId: "dhan-api",
  broker: "dhan",
  format: "api",
  trades,
  warnings: [],
});

const buyFile = (sym: string, hint: NormalizedTrade["productHint"] = "delivery") =>
  parsed([trade({ tradingsymbol: sym, buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-08-20", productHint: hint })]);
const saleFile = (sym: string, hint: NormalizedTrade["productHint"] = "delivery") =>
  parsed([trade({ tradingsymbol: sym, sellQty: 100, avgSellPrice: 250, sellValue: 25000, sellDate: "2026-08-28", productHint: hint })]);

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get();
const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);
const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

/**
 * A lot and v4.2.0's stored sale of it, through the REAL importer: the buy, then
 * the pull's sale as its own row — re-dated to what v4.2.0's Dhan adapter
 * wrote (`sellDate: closed ? today : null`) and stamped on the pull day.
 */
function seedPair(accountId: number, sym: string, hint: NormalizedTrade["productHint"] = "delivery", name = `stale-${sym}`) {
  t.db.insert(t.schema.accounts).values({ id: accountId, name }).run();
  expect(commit.commitParsedFile(buyFile(sym, hint), "dhan-api-2026-08-20", null, accountId).added).toBe(1);
  expect(commit.commitParsedFile(saleFile(sym, hint), "dhan-api-2026-08-28", null, accountId).added).toBe(1);
  const [L, S] = rowsOf(accountId);
  expect([S.buyQty, S.sellQty, S.isOpen], "v4.2.0 stores the sale as an open sell-only row").toEqual([0, 100, true]);
  t.db
    .update(t.schema.trades)
    .set({ sellDate: null, createdAt: "2026-08-28 05:00:00" })
    .where(eq(t.schema.trades.id, S.id))
    .run();
  return { L: row(L.id)!, S: row(S.id)! };
}

async function post(body: unknown) {
  const res = await route.POST(
    new Request("http://local/api/data-quality/close-stale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as { ok: boolean; message: string; code?: string } };
}

// Measured locally (2026-09-11): the hook takes ~1.1 s (migrate + seed), inside
// the 3 s local budget. The raised timeout is for the Windows runner, which is
// >15x slower on SQLite-file work (AGENTS.md Testing), as on the sibling files.
beforeAll(async () => {
  t = await openTempDb("stale-lots", { seed: true });
  commit = await import("@/lib/import/commit");
  route = await import("@/app/api/data-quality/close-stale/route");
  dq = await import("@/lib/queries/data-quality");
  trash = await import("@/lib/trash");
  identity = await import("@/lib/import/broker-identity");
  ratesDb = await import("@/lib/engine/rates-db");
  ({ StaleLotFix } = await import("@/components/quality/stale-lot-fix"));
}, 120_000);
afterAll(() => t?.cleanup());

describe("closing a stale lot with its recorded sale (POST /api/data-quality/close-stale)", () => {
  const ACC = 801;
  let L: NonNullable<ReturnType<typeof row>>;
  let S: NonNullable<ReturnType<typeof row>>;

  it("the account-scoped query lists the pair, with the pull day offered as the date", () => {
    ({ L, S } = seedPair(ACC, "MARKSANS"));
    selectAccount(ACC);
    const pairs = dq.getStaleOpenPairs();
    expect(pairs.map((p) => [p.lotId, p.saleId, p.oneClick, p.saleDate, p.saleDateStated, p.blocked])).toEqual([
      [L.id, S.id, true, "2026-08-28", false, null],
    ]);
    const issue = dq.getDataQualityReport().issues.find((i) => i.code === "stale_open");
    expect(issue?.ids).toEqual([L.id]);
  });

  it("refuses a write with no confirmed date", async () => {
    const { status, json } = await post({ lotId: L.id, saleId: S.id });
    expect([status, json.ok]).toEqual([400, false]);
    expect(row(L.id)!.isOpen).toBe(true);
  });

  it("closes the lot at the sale's price and quantity on the confirmed date, carrying both stored bills", async () => {
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-28" });
    expect(json.message).toMatch(/Deleted items/);
    expect([status, json.ok]).toEqual([200, true]);

    const closed = row(L.id)!;
    expect(closed).toMatchObject({
      isOpen: false,
      buyQty: 100,
      sellQty: 100,
      avgBuyPrice: 200,
      avgSellPrice: 250,
      sellValue: 25000,
      buyDate: "2026-08-20",
      sellDate: "2026-08-28",
      grossPnl: 5000,
      unrealisedPnl: 0,
    });
    // Both sides stated a bill, so neither is re-derived (never both for one side).
    expect(closed.chargesTotal).toBe(r2(L.chargesTotal + S.chargesTotal));
    expect(closed.netPnl).toBe(r2(5000 - closed.chargesTotal));
    expect(closed.importNotes ?? "").toContain(`dedup-alias:${S.dedupHash}`);
  });

  it("the sale row is gone from the book and sits in Deleted items", () => {
    expect(row(S.id)).toBeUndefined();
    expect(rowsOf(ACC).map((r) => r.id)).toEqual([L.id]);
    const snap = trash.listTrashSnapshots().find((s) => s.reason.includes(`#${L.id}`));
    expect(snap).toMatchObject({ accountId: ACC, trades: 1, symbols: ["MARKSANS"] });
  });

  it("the audit trail records the close on the lot and the delete of the sale", () => {
    const audits = t.db.select().from(t.schema.auditLog).all();
    expect(audits.filter((a) => a.entity === "trade" && a.entityId === L.id && a.action === "close")).toHaveLength(1);
    expect(audits.filter((a) => a.entity === "trade" && a.entityId === S.id && a.action === "delete")).toHaveLength(1);
  });

  it("re-pulling the sale is skipped: the lot answers to the sale's record", () => {
    const again = commit.commitParsedFile(saleFile("MARKSANS"), "dhan-api-2026-08-28", null, ACC);
    expect([again.added, again.skipped]).toEqual([0, 1]);
    expect(dq.getStaleOpenPairs()).toEqual([]);
  });

  it("a second POST is refused and changes nothing", async () => {
    const before = row(L.id);
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-28" });
    expect(json.ok).toBe(false);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(row(L.id)).toEqual(before);
  });
});

describe("refusals", () => {
  it("a POST while another book is selected is refused (invariant 8/9)", async () => {
    const { L, S } = seedPair(802, "BEL");
    selectAccount(801);
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-28" });
    expect([status, json.ok, json.code]).toEqual([403, false, "OTHER_ACCOUNT"]);
    expect(rowsOf(802)).toEqual([L, S]);
  });

  it("a sale carrying the user's own notes is refused and stays listed with the reason", async () => {
    const { L, S } = seedPair(803, "VBL");
    t.db.update(t.schema.trades).set({ notes: "sold on the results" }).where(eq(t.schema.trades.id, S.id)).run();
    selectAccount(803);
    const [listed] = dq.getStaleOpenPairs();
    expect([listed.lotId, listed.saleId]).toEqual([L.id, S.id]);
    expect(listed.blocked).toMatch(/journal entries \(notes\)/);

    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-28" });
    expect([status, json.ok, json.code]).toEqual([409, false, "JOURNAL"]);
    expect(json.message).toMatch(/Nothing was changed/);
    expect(rowsOf(803).map((r) => [r.id, r.isOpen])).toEqual([
      [L.id, true],
      [S.id, true],
    ]);
  });

  it("a date before the position was opened is refused", async () => {
    const { L, S } = seedPair(804, "SBIN", "mtf");
    selectAccount(804);
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-01" });
    expect([status, json.code]).toEqual([400, "BAD_DATE"]);
    expect(row(L.id)!.isOpen).toBe(true);
  });
});

describe("an eq_mtf lot: interest runs to the CONFIRMED date, exactly as the manual close prices it", () => {
  it("joined with an edited date, it carries the same MTF interest as closePosition on a twin lot", async () => {
    const [L, S] = rowsOf(804);
    expect(L.segment).toBe("eq_mtf");
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-09-05" });
    expect([status, json.ok]).toEqual([200, true]);

    t.db.insert(t.schema.accounts).values({ id: 805, name: "stale-twin" }).run();
    commit.commitParsedFile(buyFile("SBIN", "mtf"), "dhan-api-2026-08-20", null, 805);
    const [twin] = rowsOf(805);
    expect(commit.closePosition(twin.id, 250, "2026-09-05").ok).toBe(true);

    const joined = row(L.id)!;
    const manual = row(twin.id)!;
    expect(joined.sellDate).toBe("2026-09-05");
    expect(manual.mtfInterest).toBeGreaterThan(0);
    expect(joined.mtfInterest).toBe(manual.mtfInterest);
    expect(joined.pledgeCharges).toBe(manual.pledgeCharges);
    expect(joined.mtfFundedAmount).toBe(manual.mtfFundedAmount);

    // R26-T (W2-DQ) — the joined row's chargesTotal, GST and net P&L, derived
    // WITHOUT reading anything closeStaleLot wrote: each side's bill as the
    // importer STORED it (L and S above were read before the join), plus the
    // MTF interest and pledge fee (with the GST on the fee) priced by
    // computeCharges over charge_config for the confirmed holding period.
    // Measured 2026-09-14: 209.69 / 12.13 / 4,790.31 (the re-check's figures).
    expect(L.mtfInterest + L.pledgeCharges + S.mtfInterest + S.pledgeCharges, "neither side carried MTF parts to replace").toBe(0);
    const rates = findRates(ratesDb.loadRatesMap(), "dhan", "eq_mtf", "NSE", "2026-09-05");
    const DAYS_HELD = 16; // 2026-08-20 → 2026-09-05, counted by hand
    const mtf = computeCharges(
      { segment: "eq_mtf", buyValue: 0, sellValue: 0, buyQty: 0, sellQty: 0, buyOrderCount: 0, sellOrderCount: 0, mtf: { fundedAmount: manual.mtfFundedAmount!, daysHeld: DAYS_HELD, pledgeScrips: 1 } },
      rates,
    );
    expect(mtf.mtfInterest, "the independent pricing agrees with the twin's interest").toBe(manual.mtfInterest);
    const expectedTotal = r2(L.chargesTotal + S.chargesTotal + mtf.total);
    expect(joined.chargesTotal).toBe(expectedTotal);
    expect(joined.gst).toBe(r2(L.gst + S.gst + mtf.gst));
    expect(joined.netPnl).toBe(r2(5000 - expectedTotal));
  });
});

// ──────────── W2-DQ P3 / P2 / P4 (v4.3.0 fix wave 2) — the DB half ──────────

describe("W2-DQ P3 — a recorded-basis sale is refused by the join itself", () => {
  it("an ESOP sale at 50 beside a held lot: POST close-stale gives NO_PAIR and changes neither row", async () => {
    const ACC = 806;
    t.db.insert(t.schema.accounts).values({ id: ACC, name: "stale-esop" }).run();
    const buy = parsed([trade({ tradingsymbol: "LTIM", buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-08-01" })]);
    const sell = parsed([trade({ tradingsymbol: "LTIM", sellQty: 100, avgSellPrice: 250, sellValue: 25000, sellDate: "2026-08-15" })]);
    expect(commit.commitParsedFile(buy, "ltim-buy", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sell, "ltim-sell", null, ACC).added).toBe(1);
    const [L, S] = rowsOf(ACC);
    // The user confirmed the sale's basis: an ESOP allotment at 50, closed.
    t.db.update(t.schema.trades).set({ isOpen: false, acquisition: "esop", acquisitionPrice: 50 }).where(eq(t.schema.trades.id, S.id)).run();
    selectAccount(ACC);
    const before = rowsOf(ACC);

    expect(dq.getStaleOpenPairs()).toEqual([]);
    expect(dq.getDataQualityReport().issues.filter((i) => i.code === "stale_open")).toEqual([]);
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-15" });
    expect([status, json.ok, json.code]).toEqual([409, false, "NO_PAIR"]);
    expect(rowsOf(ACC)).toEqual(before);
  });
});

describe("W2-DQ P2 — after the manual close, the sale rows are listed as a warning", () => {
  it("lot 100 with sales 40 + 60, closed by closePosition: both sale rows listed, stale_open 0, nothing removed", () => {
    const ACC = 807;
    t.db.insert(t.schema.accounts).values({ id: ACC, name: "stale-manual" }).run();
    const sell = (qty: number, day: string) =>
      parsed([trade({ tradingsymbol: "BHEL", sellQty: qty, avgSellPrice: 250, sellValue: 250 * qty, sellDate: day })]);
    expect(commit.commitParsedFile(buyFile("BHEL"), "bhel-buy", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sell(40, "2026-08-28"), "bhel-s40", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sell(60, "2026-08-29"), "bhel-s60", null, ACC).added).toBe(1);
    const [L, S40, S60] = rowsOf(ACC);
    selectAccount(ACC);
    // The partial path: listed, no button — the card links to the manual close.
    expect(dq.getStaleOpenPairs().map((p) => [p.lotId, p.saleId, p.matchedQty, p.oneClick])).toEqual([
      [L.id, S40.id, 40, false],
      [L.id, S60.id, 60, false],
    ]);

    expect(commit.closePosition(L.id, 250, "2026-08-29").ok).toBe(true);

    const report = dq.getDataQualityReport();
    expect(report.issues.filter((i) => i.code === "stale_open")).toEqual([]);
    const warning = report.issues.find((i) => i.code === "stale_sale");
    expect(warning).toMatchObject({ severity: "warning", count: 2, ids: [S40.id, S60.id], href: "/data-quality#stale-open" });
    const section = dq.getStaleOpenSection();
    expect(section.pairs).toEqual([]);
    expect(section.sales.map((s) => [s.saleId, s.saleQty, s.closedLotIds])).toEqual([
      [S40.id, 40, [L.id]],
      [S60.id, 60, [L.id]],
    ]);
    expect(rowsOf(ACC).map((r) => r.id), "listed, never removed").toEqual([L.id, S40.id, S60.id]);

    // The stale section the warning links to renders them, with no join button.
    const html = renderToStaticMarkup(React.createElement(StaleLotFix, section));
    expect(html).toContain('id="stale-open"');
    expect(html).toContain("Closing trades with no open position left to close");
    expect(html.match(/data-stale-sales/g)).toHaveLength(1);
    expect(html).toContain("recorded sale 40");
    expect(html).toContain("recorded sale 60");
    expect(html).not.toContain("Close with the recorded sale");
  });
});

describe("W2-DQ P4 — a lot joined with its recorded sale stays a cross-account copy of its joined twin", () => {
  /** Seed the same Dhan lot + sale into `accounts`, then join it in `joinIn` through the real route. */
  async function seedTwins(accounts: number[], joinIn: number[], sym: string) {
    const seeded = accounts.map((acc) => ({ acc, ...seedPair(acc, sym, "delivery", `stale-${sym}-${acc}`) }));
    for (const s of seeded.filter((x) => joinIn.includes(x.acc))) {
      selectAccount(s.acc);
      const { status } = await post({ lotId: s.L.id, saleId: s.S.id, exitDate: "2026-08-28" });
      expect(status).toBe(200);
    }
    selectAccount(0);
    return seeded;
  }

  it("joined in BOTH books: every copy is removable under each hash, and the fix takes the joined lot", async () => {
    const [a, b] = await seedTwins([808, 809], [808, 809], "HAL");
    const groups = identity.listDuplicateTradeGroups().filter((g) => g.symbol === "HAL");
    expect(groups.map((g) => g.dedupHash).sort()).toEqual([a.L.dedupHash, a.S.dedupHash].sort());
    for (const g of groups) {
      expect(g.accounts.map((x) => [x.id, x.removable]), `under ${g.dedupHash === a.L.dedupHash ? "the buy" : "the sale"} hash`).toEqual([
        [808, true],
        [809, true],
      ]);
    }
    expect(identity.duplicateTradeIdsIn("dhan", a.L.dedupHash, 808)).toEqual([a.L.id]);
    expect(identity.duplicateTradeIdsIn("dhan", a.S.dedupHash, 809)).toEqual([b.L.id]);
  });

  it("joined in ONE book only: that copy is still not removable, under either hash (fixA S3b's shape)", async () => {
    const [a, b] = await seedTwins([810, 811], [810], "BEML");
    const groups = identity.listDuplicateTradeGroups().filter((g) => g.symbol === "BEML");
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g.accounts.map((x) => [x.id, x.removable])).toEqual([[810, false], [811, true]]);
    expect(identity.duplicateTradeIdsIn("dhan", a.L.dedupHash, 810)).toEqual([]);
    expect(identity.duplicateTradeIdsIn("dhan", a.L.dedupHash, 811)).toEqual([b.L.id]);
  });
});

// ─────────── W2-FIXD2 (seam D2) — a STAGED lot: listed, refused, linked ─────────

describe("W2-FIXD2 — a staged lot (bought in two fills) and its recorded sale: listed, the join refuses it, the card links to the ladder", () => {
  const ACC = 812;
  const SYM = "TATASTEEL";
  let L: NonNullable<ReturnType<typeof row>>;
  let S: NonNullable<ReturnType<typeof row>>;
  const legsOf = (tradeId: number) =>
    t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, tradeId)).all().sort((a, b) => a.seq - b.seq);

  it("the real importer stores ONE staged row of 100 with two entry legs, and the query lists it against all 100", () => {
    t.db.insert(t.schema.accounts).values({ id: ACC, name: "stale-staged" }).run();
    const buy = parsed([
      trade({
        tradingsymbol: SYM,
        buyQty: 100,
        avgBuyPrice: 200,
        buyValue: 20000,
        buyDate: "2026-08-20",
        executions: [
          { side: "buy", qty: 10, price: 200, date: "2026-08-20", time: "10:00:00" },
          { side: "buy", qty: 90, price: 200, date: "2026-08-20", time: "10:05:00" },
        ],
      }),
    ]);
    expect(commit.commitParsedFile(buy, "staged-buy", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(saleFile(SYM), "staged-sale", null, ACC).added).toBe(1);
    [L, S] = rowsOf(ACC);
    expect([L.staged, L.isOpen, L.buyQty, S.sellQty, S.isOpen]).toEqual([true, true, 100, 100, true]);
    expect(legsOf(L.id).map((g) => [g.kind, g.qty])).toEqual([["entry", 10], ["entry", 90]]);

    selectAccount(ACC);
    expect(dq.getStaleOpenPairs().map((p) => [p.lotId, p.saleId, p.matchedQty, p.staged, p.oneClick, p.blocked])).toEqual([
      [L.id, S.id, 100, true, false, null],
    ]);
    expect(dq.getDataQualityReport().issues.find((i) => i.code === "stale_open")?.ids).toEqual([L.id]);
  });

  it("POST close-stale refuses the staged lot with STAGED and changes neither row nor the ladder", async () => {
    const beforeRows = rowsOf(ACC);
    const beforeLegs = legsOf(L.id);
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-28" });
    expect([status, json.ok, json.code]).toEqual([409, false, "STAGED"]);
    expect(json.message).toMatch(/staged position/);
    expect(json.message).toMatch(/Nothing was changed/);
    expect(rowsOf(ACC)).toEqual(beforeRows);
    expect(legsOf(L.id)).toEqual(beforeLegs);
  });

  it("closeStaleLot itself refuses it too, whatever the screen offered (defence in depth)", () => {
    const res = commit.closeStaleLot(L.id, S.id, "2026-08-28");
    expect([res.ok, res.code]).toEqual([false, "STAGED"]);
    expect(row(L.id)!.isOpen).toBe(true);
    expect(row(S.id)).toBeDefined();
  });

  it("the card lists the pair with no join button, and links to the position in Trades where its ladder books the exit", () => {
    const html = renderToStaticMarkup(React.createElement(StaleLotFix, { pairs: dq.getStaleOpenPairs() }));
    const text = html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ");
    expect(text).toContain("open 100 @ 200.00 since 2026-08-20");
    expect(html).not.toContain("Close with the recorded sale");
    expect(text).toContain("staged position");
    expect(html).toContain(`href="/trades?symbol=${SYM}&amp;view=open"`);
    expect(text).not.toMatch(/\b(should|must|recommend|consider|suggest)\b/i);
  });
});

// ─────────── R2-DQ N7 / N8 / N9 / N10 (v4.3.0 fix wave 2R) — the DB half ─────────

const textOf = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const legsOfTrade = (tradeId: number) =>
  t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, tradeId)).all().sort((a, b) => a.seq - b.seq);

describe("R2-DQ N7 — the ladder exit the staged card points to, then a held lot: listed for review, and the join refuses it", () => {
  const ACC = 813;
  const SYM = "HDFCBANK";
  let L1: NonNullable<ReturnType<typeof row>>;
  let L2: NonNullable<ReturnType<typeof row>>;
  let S: NonNullable<ReturnType<typeof row>>;

  it("L1 staged 10+90 (08-20), L2 100 @210 (08-22), sale 100 @250 (08-28): the staged pair first, then the ladder exit", async () => {
    t.db.insert(t.schema.accounts).values({ id: ACC, name: "stale-n7" }).run();
    const exec = (qty: number, time: string) => ({ side: "buy" as const, qty, price: 200, date: "2026-08-20", time });
    const b1 = parsed([trade({ tradingsymbol: SYM, buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-08-20", executions: [exec(10, "10:00:00"), exec(90, "10:05:00")] })]);
    const b2 = parsed([trade({ tradingsymbol: SYM, buyQty: 100, avgBuyPrice: 210, buyValue: 21000, buyDate: "2026-08-22" })]);
    expect(commit.commitParsedFile(b1, "n7-b1", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(b2, "n7-b2", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(saleFile(SYM), "n7-sale", null, ACC).added).toBe(1);
    [L1, L2, S] = rowsOf(ACC);
    expect([L1.staged, L2.staged, S.sellQty, S.isOpen]).toEqual([true, false, 100, true]);
    selectAccount(ACC);
    expect(dq.getStaleOpenPairs().map((p) => [p.lotId, p.saleId, p.staged, p.ambiguous, p.oneClick])).toEqual([[L1.id, S.id, true, false, false]]);
    // The staged card no longer promises where the sale row is listed after the
    // exit: with L2 held, it is a review pair, not a sale with no open position.
    const stagedText = textOf(renderToStaticMarkup(React.createElement(StaleLotFix, { pairs: dq.getStaleOpenPairs() })));
    expect(stagedText).toContain("booked on its own ladder in Trades");
    expect(stagedText).not.toContain("listed here as a closing trade with no open position");

    // As the staged card says: the exit is booked on L1's own ladder.
    const staged = await import("@/lib/queries/staged");
    expect(staged.addLeg({ tradeId: L1.id, kind: "exit", tradeDate: "2026-08-28", qty: 100, price: 250 }).ok).toBe(true);
    expect([row(L1.id)!.isOpen, row(L1.id)!.sellQty]).toEqual([false, 100]);
  });

  it("after the exit, L2 + the same sale is ambiguous: no one-click, no critical stale_open, a stale_review warning", () => {
    expect(dq.getStaleOpenPairs().map((p) => [p.lotId, p.saleId, p.ambiguous, p.oneClick, p.closedLotIds])).toEqual([
      [L2.id, S.id, true, false, [L1.id]],
    ]);
    const report = dq.getDataQualityReport();
    expect(report.issues.filter((i) => i.code === "stale_open"), "a holding still held is never a critical stale lot here").toEqual([]);
    expect(report.issues.find((i) => i.code === "stale_review")).toMatchObject({ severity: "warning", ids: [S.id] });
  });

  it("POST close-stale refuses it with AMBIGUOUS (409) and changes nothing; closeStaleLot itself refuses it too", async () => {
    const before = rowsOf(ACC);
    const { status, json } = await post({ lotId: L2.id, saleId: S.id, exitDate: "2026-08-28" });
    expect([status, json.ok, json.code]).toEqual([409, false, "AMBIGUOUS"]);
    expect(json.message).toMatch(/Nothing was changed/);
    expect(json.message).toContain(`trade #${L1.id}`);
    expect(rowsOf(ACC)).toEqual(before);
    expect(commit.closeStaleLot(L2.id, S.id, "2026-08-28").code).toBe("AMBIGUOUS");
    expect(rowsOf(ACC)).toEqual(before);
  });

  it("the card lists the pair for review with no join button and a link to Trades", () => {
    const html = renderToStaticMarkup(React.createElement(StaleLotFix, dq.getStaleOpenSection()));
    const text = textOf(html);
    expect(html).toContain("data-stale-review");
    expect(html).not.toContain("Close with the recorded sale");
    expect(text).toContain(`already closed (trade #${L1.id})`);
    expect(html).toContain(`href="/trades?symbol=${SYM}"`);
    expect(text).not.toMatch(/\b(should|must|recommend|consider|suggest)\b/i);
  });
});

describe("R2-DQ N8 — the manual close the partial card points to: the leftover sale re-pairs for review only", () => {
  const ACC = 814;
  const SYM = "ITC";

  it("L1 100 (08-20), L2 40 (08-22), S1 40 (08-25), S2 60 (08-26): after closePosition(L1), POST {L2, S1} is AMBIGUOUS and S2 is a stale_sale", async () => {
    t.db.insert(t.schema.accounts).values({ id: ACC, name: "stale-n8" }).run();
    const buy = (qty: number, price: number, day: string) =>
      parsed([trade({ tradingsymbol: SYM, buyQty: qty, avgBuyPrice: price, buyValue: qty * price, buyDate: day })]);
    const sell = (qty: number, day: string) => parsed([trade({ tradingsymbol: SYM, sellQty: qty, avgSellPrice: 250, sellValue: 250 * qty, sellDate: day })]);
    expect(commit.commitParsedFile(buy(100, 200, "2026-08-20"), "n8-l1", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(buy(40, 210, "2026-08-22"), "n8-l2", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sell(40, "2026-08-25"), "n8-s1", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sell(60, "2026-08-26"), "n8-s2", null, ACC).added).toBe(1);
    const [L1, L2, S1, S2] = rowsOf(ACC);
    selectAccount(ACC);
    const partial = dq.getStaleOpenPairs();
    expect(partial.map((p) => [p.lotId, p.saleId, p.matchedQty, p.oneClick])).toEqual([
      [L1.id, S1.id, 40, false],
      [L1.id, S2.id, 60, false],
    ]);
    // The partial card no longer promises where the sale rows are listed next.
    const partialText = textOf(renderToStaticMarkup(React.createElement(StaleLotFix, { pairs: partial })));
    expect(partialText).toContain("Open the manual close");
    expect(partialText).not.toContain("listed here as a closing trade with no open position");

    expect(commit.closePosition(L1.id, 250, "2026-08-26").ok).toBe(true);

    expect(dq.getStaleOpenPairs().map((p) => [p.lotId, p.saleId, p.matchedQty, p.ambiguous, p.oneClick])).toEqual([[L2.id, S1.id, 40, true, false]]);
    const before = rowsOf(ACC);
    const { status, json } = await post({ lotId: L2.id, saleId: S1.id, exitDate: "2026-08-25" });
    expect([status, json.ok, json.code]).toEqual([409, false, "AMBIGUOUS"]);
    expect(rowsOf(ACC), "nothing written: the sale is not counted twice").toEqual(before);
    const report = dq.getDataQualityReport();
    expect(report.issues.filter((i) => i.code === "stale_open")).toEqual([]);
    expect(report.issues.find((i) => i.code === "stale_review")?.ids).toEqual([S1.id]);
    expect(dq.getStaleOpenSection().sales.map((s) => [s.saleId, s.closedLotIds])).toEqual([[S2.id, [L1.id]]]);
  });
});

describe("R2F-DQ — MARKSANS: an older round trip closed before the new lot was bought leaves the join one-click, and the route joins it", () => {
  const ACC = 816;
  const SYM = "MARKSANS";

  it("closed 2025 round trip + 2026 lot + v4.2.0's sale row: listed one-click, POST joins it, the round trip is untouched", async () => {
    t.db.insert(t.schema.accounts).values({ id: ACC, name: "stale-marksans-older" }).run();
    const roundTrip = parsed([
      trade({ tradingsymbol: SYM, buyQty: 100, avgBuyPrice: 150, buyValue: 15000, sellQty: 100, avgSellPrice: 180, sellValue: 18000, grossPnl: 3000, buyDate: "2025-03-10", sellDate: "2025-06-02" }),
    ]);
    expect(commit.commitParsedFile(roundTrip, "marksans-2025", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(buyFile(SYM), "marksans-b", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(saleFile(SYM), "marksans-s", null, ACC).added).toBe(1);
    const [R, L, S] = rowsOf(ACC);
    expect([R.isOpen, L.isOpen, S.isOpen, S.sellQty]).toEqual([false, true, true, 100]);
    selectAccount(ACC);
    expect(dq.getStaleOpenPairs().map((p) => [p.lotId, p.saleId, p.ambiguous, p.oneClick, p.closedLotIds])).toEqual([[L.id, S.id, false, true, []]]);
    const report = dq.getDataQualityReport();
    expect(report.issues.find((i) => i.code === "stale_open")?.ids).toEqual([L.id]);
    expect(report.issues.find((i) => i.code === "stale_review")).toBeUndefined();

    const roundTripBefore = row(R.id);
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-28" });
    expect([status, json.ok, json.code ?? null], json.message).toEqual([200, true, null]);
    expect(row(L.id)).toMatchObject({ isOpen: false, sellQty: 100, avgSellPrice: 250, sellDate: "2026-08-28" });
    expect(row(S.id)).toBeUndefined();
    expect(row(R.id), "the older round trip is not touched").toEqual(roundTripBefore);
  });
});

describe("R2-DQ N9 / N10 — a sale recorded in two fills: named as its fills, refused (FILLS), and listed after the manual close", () => {
  const ACC = 815;
  const SYM = "INFY";

  it("the pair names the sale's recorded fills, links to Trades, POST refuses it with FILLS; after closePosition the sale is a stale_sale", async () => {
    t.db.insert(t.schema.accounts).values({ id: ACC, name: "stale-n9" }).run();
    const exec = (qty: number, time: string) => ({ side: "sell" as const, qty, price: 250, date: "2026-08-28", time });
    const sale2 = parsed([trade({ tradingsymbol: SYM, sellQty: 100, avgSellPrice: 250, sellValue: 25000, sellDate: "2026-08-28", executions: [exec(40, "10:00:00"), exec(60, "10:05:00")] })]);
    expect(commit.commitParsedFile(buyFile(SYM), "n9-buy", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sale2, "n9-sale", null, ACC).added).toBe(1);
    const [L, S] = rowsOf(ACC);
    expect([L.staged, S.staged, S.isOpen, legsOfTrade(S.id).length]).toEqual([false, true, true, 2]);
    selectAccount(ACC);

    const [pair] = dq.getStaleOpenPairs();
    expect([pair.lotId, pair.saleId, pair.saleStaged, pair.oneClick]).toEqual([L.id, S.id, true, false]);
    expect(pair.blocked).toMatch(/recorded in several fills/);
    expect(pair.blocked).not.toMatch(/your own journal entries|moved onto the position/);
    const html = renderToStaticMarkup(React.createElement(StaleLotFix, { pairs: [pair] }));
    expect(html).toContain("data-stale-blocked");
    expect(html).toContain(`href="/trades?symbol=${SYM}&amp;view=open"`);
    expect(html).not.toContain("Close with the recorded sale");

    const before = rowsOf(ACC);
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-28" });
    expect([status, json.ok, json.code]).toEqual([409, false, "FILLS"]);
    expect(json.message).toMatch(/recorded in several fills/);
    expect(json.message).not.toMatch(/your own journal entries/);
    expect(rowsOf(ACC)).toEqual(before);

    // The only remedy left — the manual close — and the sale is then listed.
    expect(commit.closePosition(L.id, 250, "2026-08-28").ok).toBe(true);
    const report = dq.getDataQualityReport();
    expect(report.issues.filter((i) => i.code === "stale_open")).toEqual([]);
    expect(report.issues.find((i) => i.code === "stale_sale")).toMatchObject({ severity: "warning", ids: [S.id] });
    expect(dq.getStaleOpenSection().sales.map((s) => [s.saleId, s.closedLotIds])).toEqual([[S.id, [L.id]]]);
  });
});

describe("M2 (wave 2G) — after the card's own join of [L1, S1], the sibling [L2, S2] is still joined in one step", () => {
  const ACC = 817;
  const SYM = "STACKX";

  it("stacked L1 100 (08-20) + L2 50 (08-21), S1 100 (08-25) + S2 50 (08-26): POST {L1, S1}, then {L2, S2} is one-click and the route joins it", async () => {
    t.db.insert(t.schema.accounts).values({ id: ACC, name: "stale-m2" }).run();
    const buy = (qty: number, price: number, day: string) =>
      parsed([trade({ tradingsymbol: SYM, buyQty: qty, avgBuyPrice: price, buyValue: qty * price, buyDate: day })]);
    const sell = (qty: number, price: number, day: string) =>
      parsed([trade({ tradingsymbol: SYM, sellQty: qty, avgSellPrice: price, sellValue: qty * price, sellDate: day })]);
    expect(commit.commitParsedFile(buy(100, 200, "2026-08-20"), "m2-l1", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(buy(50, 210, "2026-08-21"), "m2-l2", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sell(100, 250, "2026-08-25"), "m2-s1", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sell(50, 260, "2026-08-26"), "m2-s2", null, ACC).added).toBe(1);
    const [L1, L2, S1, S2] = rowsOf(ACC);
    selectAccount(ACC);
    expect(dq.getStaleOpenPairs().map((p) => [p.lotId, p.saleId, p.oneClick])).toEqual([
      [L1.id, S1.id, true],
      [L2.id, S2.id, true],
    ]);

    const first = await post({ lotId: L1.id, saleId: S1.id, exitDate: "2026-08-25" });
    expect([first.status, first.json.ok], first.json.message).toEqual([200, true]);
    expect(row(L1.id)!.importNotes ?? "").toContain(`dedup-alias:${S1.dedupHash}`);

    // L1's exit (08-25) is on or after L2's entry (08-21), but its close IS S1, recorded as its alias: it cannot have taken S2.
    expect(dq.getStaleOpenPairs().map((p) => [p.lotId, p.saleId, p.ambiguous, p.oneClick, p.closedLotIds])).toEqual([[L2.id, S2.id, false, true, []]]);
    const report = dq.getDataQualityReport();
    expect(report.issues.find((i) => i.code === "stale_open")?.ids).toEqual([L2.id]);
    expect(report.issues.find((i) => i.code === "stale_review")).toBeUndefined();

    const second = await post({ lotId: L2.id, saleId: S2.id, exitDate: "2026-08-26" });
    expect([second.status, second.json.ok, second.json.code ?? null], second.json.message).toEqual([200, true, null]);
    expect(rowsOf(ACC).map((r) => [r.id, r.isOpen, r.buyQty, r.sellQty])).toEqual([
      [L1.id, false, 100, 100],
      [L2.id, false, 50, 50],
    ]);
    expect(dq.getStaleOpenSection()).toMatchObject({ pairs: [], sales: [] });
  });
});

describe("R2-DQ N10 — the FILLS guard reads the sale's trade_legs, not only its staged flag", () => {
  const ACC = 818;
  const SYM = "WIPRO";

  it("a sale holding two fills whose staged flag is false: the pure rule offers one-click, POST refuses it with FILLS and changes nothing", async () => {
    t.db.insert(t.schema.accounts).values({ id: ACC, name: "stale-fills-legs" }).run();
    const exec = (qty: number, time: string) => ({ side: "sell" as const, qty, price: 250, date: "2026-08-28", time });
    const sale2 = parsed([trade({ tradingsymbol: SYM, sellQty: 100, avgSellPrice: 250, sellValue: 25000, sellDate: "2026-08-28", executions: [exec(40, "10:00:00"), exec(60, "10:05:00")] })]);
    expect(commit.commitParsedFile(buyFile(SYM), "fl-buy", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sale2, "fl-sale", null, ACC).added).toBe(1);
    const [L, S] = rowsOf(ACC);
    t.db.update(t.schema.trades).set({ staged: false }).where(eq(t.schema.trades.id, S.id)).run();
    expect([row(S.id)!.staged, legsOfTrade(S.id).length]).toEqual([false, 2]);
    selectAccount(ACC);
    expect(dq.getStaleOpenPairs().map((p) => [p.lotId, p.saleId, p.saleStaged, p.oneClick])).toEqual([[L.id, S.id, false, true]]);

    const before = rowsOf(ACC);
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-28" });
    expect([status, json.ok, json.code]).toEqual([409, false, "FILLS"]);
    expect(rowsOf(ACC)).toEqual(before);
    expect(legsOfTrade(S.id)).toHaveLength(2);
  });
});
