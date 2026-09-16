import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveOpenPositions,
  interestOnWholeLeg,
  mtfDashReason,
  mtfFundedStated,
  ownCapitalNote,
  ownCapitalTotal,
  statesOwnCapital,
} from "../lib/analytics/positions";
import type { Trade } from "../lib/db/schema";

const trade = (over: Partial<Trade>): Trade =>
  ({
    id: 1,
    broker: "dhan",
    bucket: "active",
    segment: "stock_option",
    instrumentType: "option",
    exchange: "NSE",
    symbol: "X",
    tradingsymbol: "X",
    isin: null,
    expiry: null,
    strike: null,
    optionType: null,
    lotSize: null,
    buyQty: 0,
    avgBuyPrice: 0,
    buyValue: 0,
    sellQty: 0,
    avgSellPrice: 0,
    sellValue: 0,
    closingPrice: null,
    buyDate: null,
    sellDate: null,
    entryTime: null,
    exitTime: null,
    grossPnl: 0,
    chargesTotal: 0,
    netPnl: 0,
    unrealisedPnl: 0,
    realisedPct: null,
    isOpen: true,
    buyOrderCount: 1,
    sellOrderCount: 1,
    setupTag: null,
    notes: null,
    playbookId: null,
    emotionTag: null,
    slPlanned: null,
    trailingSl: null,
    targetPlanned: null,
    riskAmount: null,
    impliedVol: null,
    fmv31Jan2018: null,
    rMultiple: null,
    ruleViolations: null,
    mistakeTags: null,
    brokerage: 0,
    sttCtt: 0,
    exchangeTxn: 0,
    sebi: 0,
    stampDuty: 0,
    ipft: 0,
    gst: 0,
    dpCharges: 0,
    mtfInterest: 0,
    mtfFundedAmount: null,
    pledgeCharges: 0,
    sourceFile: null,
    importBatchId: null,
    dedupHash: "h",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as Trade;

describe("deriveOpenPositions — long", () => {
  it("qty/entry/invested/unrealised computed off the buy leg", () => {
    const p = deriveOpenPositions(
      [trade({ buyQty: 100, avgBuyPrice: 1000, buyDate: "2026-06-01" })],
      new Map([["X", 1100]]),
      "2026-06-05",
    )[0];
    expect(p.qty).toBe(100);
    expect(p.avgPrice).toBe(1000);
    expect(p.invested).toBe(100000);
    expect(p.mtmPrice).toBe(1100);
    expect(p.unrealised).toBe(10000); // (1100-1000)*100 — profits when price rises
    expect(p.unrealisedPct).toBe(10);
    expect(p.daysHeld).toBe(4);
  });

  it("loses when price falls", () => {
    const p = deriveOpenPositions([trade({ buyQty: 100, avgBuyPrice: 1000 })], new Map([["X", 950]]), "2026-06-05")[0];
    expect(p.unrealised).toBe(-5000);
  });
});

describe("deriveOpenPositions — short (sell-to-open)", () => {
  // Regression: buyQty=0/sellQty=N used to make qty/avgPrice/invested all
  // evaluate to 0 for any open short (written option or short future) —
  // qty = max(0, buyQty - sellQty) and avgPrice = avgBuyPrice, both wrong for
  // a position with no buy leg at all.
  it("qty/entry/invested come off the SELL leg, not zeroed", () => {
    const p = deriveOpenPositions(
      [trade({ sellQty: 75, avgSellPrice: 100, sellDate: "2026-06-01", strike: 24000, optionType: "CE", segment: "stock_option" })],
      new Map([["X", 80]]),
      "2026-06-05",
    )[0];
    expect(p.qty).toBe(75);
    expect(p.avgPrice).toBe(100);
    expect(p.invested).toBe(7500);
    expect(p.mtmPrice).toBe(80);
    expect(p.daysHeld).toBe(4); // measured from sellDate (the open leg for a short), not buyDate
  });

  it("profits when price falls below entry (mirror of long)", () => {
    const p = deriveOpenPositions([trade({ sellQty: 75, avgSellPrice: 100 })], new Map([["X", 80]]), "2026-06-05")[0];
    expect(p.unrealised).toBe(1500); // (100-80)*75
    expect(p.unrealisedPct).toBeCloseTo(20, 5);
  });

  it("loses when price rises above entry", () => {
    const p = deriveOpenPositions([trade({ sellQty: 75, avgSellPrice: 100 })], new Map([["X", 120]]), "2026-06-05")[0];
    expect(p.unrealised).toBe(-1500); // (100-120)*75
  });

  it("rMultiple sign follows the short-corrected unrealised, not the old always-zero value", () => {
    const p = deriveOpenPositions(
      [trade({ sellQty: 75, avgSellPrice: 100, riskAmount: 750 })],
      new Map([["X", 80]]),
      "2026-06-05",
    )[0];
    expect(p.rMultiple).toBe(2); // 1500 / 750
  });
});

describe("deriveOpenPositions — MTF stays long-only and unaffected", () => {
  it("eq_mtf position (always long) is untouched by the short-handling branch", () => {
    const p = deriveOpenPositions(
      [trade({ segment: "eq_mtf", instrumentType: "equity", buyQty: 100, avgBuyPrice: 200, mtfFundedAmount: 15000 })],
      new Map([["X", 210]]),
      "2026-06-05",
    )[0];
    expect(p.isMtf).toBe(true);
    expect(p.qty).toBe(100);
    expect(p.avgPrice).toBe(200);
    expect(p.fundedAmount).toBe(15000);
    expect(p.ownCapital).toBe(5000);
    expect(p.unrealised).toBe(1000); // (210-200)*100
  });
});

/**
 * A-1 (owner ruling, v4.2 fix wave). `mtm_prices` is keyed on `symbol`, and a
 * DERIVATIVE trade carries its UNDERLYING there — so reading the `symbol` rung
 * on an option prices the premium at the underlying's cash price. The write
 * side already refuses a derivative mark (`isCashKey()` in persist-mark,
 * `writeTypedMark()` in lib/queries/mtm.ts); this is the read side of the same
 * rule. The reproduction below is the auditor's: 875 × ₹2.75 against a stored
 * `TCS = 2057.5` printed +₹17,97,906.25 (+74,718 %) — a number nothing in the
 * book ever traded (invariant 6).
 */
describe("deriveOpenPositions — a derivative never reads the underlying's cash mark (A-1)", () => {
  const option = (over: Partial<Trade> = {}) =>
    trade({
      symbol: "TCS",
      tradingsymbol: "OPT TCS 30 JUN 2026 2500 CE",
      instrumentType: "option",
      segment: "stock_option",
      optionType: "CE",
      strike: 2500,
      expiry: "2026-06-30",
      buyQty: 875,
      avgBuyPrice: 2.75,
      buyDate: "2026-06-01",
      ...over,
    });

  it("an open option with a cash mark under its underlying reads its own CLOSE, not the spot", () => {
    const p = deriveOpenPositions([option({ closingPrice: 3.1 })], new Map([["TCS", 2057.5]]), "2026-06-05")[0];
    expect(p.mtmPrice).toBe(3.1);
    expect(p.mtmPrice).not.toBe(2057.5);
    expect(p.unrealised).toBe(306.25); // 875 × (3.10 − 2.75)
    expect(p.unrealised).not.toBe(1797906.25); // what the symbol rung printed
  });

  it("with no recorded close it falls to its own average price, never the spot", () => {
    const p = deriveOpenPositions([option()], new Map([["TCS", 2057.5]]), "2026-06-05")[0];
    expect(p.mtmPrice).toBe(2.75);
    expect(p.unrealised).toBe(0);
  });

  it("a mark stored under the TRADED CONTRACT is still read — only the symbol rung is dropped", () => {
    const p = deriveOpenPositions(
      [option({ closingPrice: 3.1 })],
      new Map([
        ["TCS", 2057.5],
        ["OPT TCS 30 JUN 2026 2500 CE", 4.2],
      ]),
      "2026-06-05",
    )[0];
    expect(p.mtmPrice).toBe(4.2);
  });

  it("a written (short) option is protected by the same rung, in the same direction", () => {
    const p = deriveOpenPositions(
      [option({ buyQty: 0, avgBuyPrice: 0, sellQty: 875, avgSellPrice: 2.75, sellDate: "2026-06-01", closingPrice: 3.1 })],
      new Map([["TCS", 2057.5]]),
      "2026-06-05",
    )[0];
    expect(p.mtmPrice).toBe(3.1);
    expect(p.unrealised).toBe(-306.25);
  });

  it("CONTROL: an equity in the same scrip still reads the cash mark under its symbol", () => {
    const p = deriveOpenPositions(
      [
        trade({
          symbol: "TCS",
          tradingsymbol: "TCS",
          instrumentType: "equity",
          segment: "eq_delivery",
          bucket: "equity",
          buyQty: 10,
          avgBuyPrice: 2000,
          closingPrice: 1990,
          buyDate: "2026-06-01",
        }),
      ],
      new Map([["TCS", 2057.5]]),
      "2026-06-05",
    )[0];
    expect(p.mtmPrice).toBe(2057.5);
    expect(p.unrealised).toBe(575); // 10 × (2057.5 − 2000)
  });

  it("a future is a derivative too — the rung is instrumentType, not optionType", () => {
    const p = deriveOpenPositions(
      [
        option({
          tradingsymbol: "FUT TCS 25 JUN 2026",
          instrumentType: "future",
          segment: "future",
          optionType: null,
          strike: null,
          buyQty: 175,
          avgBuyPrice: 2050,
          closingPrice: 2049,
        }),
      ],
      new Map([["TCS", 2057.5]]),
      "2026-06-05",
    )[0];
    expect(p.mtmPrice).toBe(2049);
  });
});

/**
 * L2 [0] (v4.3.0 wave 2L, PRE-EXISTING — the wave-2I re-check's own probe walked
 * past it). An OPEN eq_mtf row that has already sold PART of its leg reported a
 * NEGATIVE `ownCapital`, and the /equity + Live Desk money totals added that
 * negative in. `mtfFundedAmount` is the amount stored for the WHOLE buy leg,
 * while `invested` is only the REMAINING quantity x avg price, so
 * `invested - funded` drops below zero as soon as more than the own-capital
 * share has been sold. Probe: 100 @200 funded 15,000 with 40 sold ->
 * invested 12,000, ownCapital -3,000, and "Own capital in MTF" across a
 * 5,000-own held row and this one printed 2,000 instead of 5,000 — the trader's
 * own money reduced by a row that put money IN.
 *
 * The fix is the conservative one (invariant 6): the row states NO own capital.
 * The pro-rata alternative (`funded x remaining / bought`) is REJECTED because
 * it assumes how the broker releases funding on a partial sale — a figure the
 * journal never recorded. The KPI excludes such rows and NAMES them, and the
 * per-row cell and the KPI read ONE exported predicate so they cannot disagree.
 */
describe("L2 [0] — a partly sold MTF leg states no own capital, and the total says so", () => {
  const mtf = (over: Partial<Trade>) =>
    trade({
      segment: "eq_mtf",
      instrumentType: "equity",
      bucket: "equity",
      symbol: "X",
      tradingsymbol: "X",
      buyQty: 100,
      avgBuyPrice: 200,
      buyValue: 20000,
      buyDate: "2026-08-20",
      mtfFundedAmount: 15000,
      ...over,
    });
  const MTM = new Map([["X", 210]]);

  it("40 of 100 sold: ownCapital and ROI on capital are BOTH null, never the negative figure", () => {
    const [p] = deriveOpenPositions([mtf({ sellQty: 40, avgSellPrice: 210 })], MTM, "2026-09-19");
    expect(p.qty).toBe(60);
    expect(p.invested).toBe(12000);
    expect(p.fundedAmount).toBe(15000); // the WHOLE leg's, as stored — never rewritten
    // THE assertion (on revert: -3000).
    expect(p.ownCapital).toBeNull();
    expect(p.roiOnCapitalPct).toBeNull();
  });

  it("nothing sold: byte-identical to before — invested / funded / own / ROI all unchanged", () => {
    const [p] = deriveOpenPositions([mtf({})], MTM, "2026-09-19");
    expect([p.invested, p.fundedAmount, p.ownCapital, p.roiOnCapitalPct]).toEqual([20000, 15000, 5000, 20]);
  });

  it("a STATED funded 0 that is partly sold is still null — no special case invents a figure", () => {
    const [p] = deriveOpenPositions([mtf({ sellQty: 40, avgSellPrice: 210, mtfFundedAmount: 0 })], MTM, "2026-09-19");
    // On revert: 12000 — the remaining leg priced by a rule about how the
    // broker releases funding that the journal never recorded.
    expect(p.ownCapital).toBeNull();
    expect(p.roiOnCapitalPct).toBeNull();
    expect(p.fundedAmount).toBe(0); // the stated 0 itself is kept (wave 2I, I1)
  });

  // PIN MOVED, deliberately (wave 2N D7, close-readers#1): a fully held row the
  // journal never priced no longer reads the margin estimate. M1 stopped the
  // accrual job persisting that estimate, so "a row predating the column and its
  // first accrual pass" became the normal, permanent state of every imported MTF
  // buy — and /equity stated funded 15,000 / own 5,000 as money for a row /risk
  // calls "not priced" (invariant 6).
  it("a fully held row whose funding was never resolved states NOTHING, not the estimate", () => {
    const [p] = deriveOpenPositions([mtf({ mtfFundedAmount: null })], MTM, "2026-09-19");
    // On revert: [15000, 5000] — the 25% own-margin default, as money.
    expect([p.fundedAmount, p.ownCapital]).toEqual([null, null]);
    expect(p.ownCapitalUnstated).toBe("unpriced");
  });

  it("a NON-MTF row is untouched: ownCapital stays 0, not null", () => {
    const [p] = deriveOpenPositions([mtf({ segment: "eq_delivery", sellQty: 40, avgSellPrice: 210 })], MTM, "2026-09-19");
    expect(p.isMtf).toBe(false);
    expect(p.ownCapital).toBe(0);
  });

  it("ownCapitalTotal leaves the partly sold row out, counts it, and the note names it", () => {
    const ps = deriveOpenPositions(
      [mtf({ id: 1 }), mtf({ id: 2, sellQty: 40, avgSellPrice: 210 })],
      MTM,
      "2026-09-19",
    );
    const t = ownCapitalTotal(ps);
    // On revert: total 2000 (5000 + -3000) and unstated 0 — the KPI the
    // finding reproduces.
    expect([t.total, t.unstated]).toEqual([5000, 1]);
    expect(t.total).not.toBe(2000);
    // Leverage reads the SAME subset, so the ratio is one book, not two.
    expect(t.funded).toBe(15000);
    // The note is read from the TOTAL now, so it can name the reason (D7).
    expect(ownCapitalNote(t)).toBe("own capital not stated for 1 partly sold MTF row");
  });

  it("with nothing partly sold the total and the note are exactly what they were", () => {
    const ps = deriveOpenPositions([mtf({ id: 1 }), mtf({ id: 2 })], MTM, "2026-09-19");
    const t = ownCapitalTotal(ps);
    expect([t.total, t.funded, t.unstated]).toEqual([10000, 30000, 0]);
    expect(ownCapitalNote(t.unstated)).toBeNull();
    // The old whole-book reduce agreed with it on a fully held book.
    expect(ps.reduce((s, p) => s + (p.ownCapital ?? 0), 0)).toBe(t.total);
  });

  it("the plural is right and a non-MTF row never counts as unstated", () => {
    const ps = deriveOpenPositions(
      [
        mtf({ id: 1, sellQty: 40, avgSellPrice: 210 }),
        mtf({ id: 2, sellQty: 10, avgSellPrice: 210 }),
        mtf({ id: 3, segment: "eq_delivery", sellQty: 40, avgSellPrice: 210 }),
      ],
      MTM,
      "2026-09-19",
    );
    const t = ownCapitalTotal(ps);
    expect([t.total, t.funded, t.unstated]).toEqual([0, 0, 2]);
    expect(ownCapitalNote(t)).toBe("own capital not stated for 2 partly sold MTF rows");
  });

  it("statesOwnCapital is the ONE predicate, and it agrees with the derived value", () => {
    const [held, partly] = deriveOpenPositions(
      [mtf({ id: 1 }), mtf({ id: 2, sellQty: 40, avgSellPrice: 210 })],
      MTM,
      "2026-09-19",
    );
    expect(statesOwnCapital(held)).toBe(true);
    expect(statesOwnCapital(partly)).toBe(false);
    expect(statesOwnCapital({ isMtf: false, ownCapital: 0 })).toBe(false);
  });
});

/**
 * The per-row "Own capital" cell and the bucket KPI must read the SAME rule.
 * Before this wave the cell refused a non-positive value (`v > 0 ? … : "—"`)
 * while the two KPI rows summed `p.ownCapital` straight across the book, so the
 * screen showed "—" on the row and a total quietly reduced by it.
 */
describe("L2 [0] — the tracker reads the shared predicate, not its own reduce", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "components/trackers/tracker-client.tsx"),
    "utf8",
  );

  const lines = (re: RegExp) => src.split(/\r?\n/).filter((l) => re.test(l)).length;

  it("no own-capital figure is summed by the component itself", () => {
    // Deliberately loose: ANY reduce that touches `p.ownCapital` — including
    // `s + (p.ownCapital ?? 0)`, which the first version of this pin walked
    // straight past while restoring the whole-book total.
    expect(src, "the tracker still sums ownCapital itself").not.toMatch(/\.reduce\([\s\S]{0,60}?p\.ownCapital/);
    expect(src).toContain("ownCapitalTotal(positions)");
  });

  it("every rendered own-capital figure reads the shared total", () => {
    // "Own capital in MTF", "Your own capital", and the leverage ratio built
    // from it — three lines, so a reverted one is a failing count.
    expect(lines(/ownCap\.total/), "a rendered own-capital figure stopped reading ownCapitalTotal").toBe(3);
  });

  it("the note travels with the total wherever it is rendered", () => {
    // The const, the three money rows that render a figure derived from the
    // own-capital total (Own capital in MTF, Your own capital, Effective leverage)
    // and the line that states what those figures left out.
    //
    // PIN MOVED, deliberately (D8, wave 2O — mtf#2 ≡ seams#0): was 6, when
    // "Broker-funded" was also `ownCap.funded` and carried this note. It is now
    // `mtfFundedStated` — every MTF row that states funding, the same figure as
    // the card face and /targets — and it states THAT set in its own hint, because
    // "own capital not stated for …" describes a different set from the one the
    // row leaves out. The recorded deviation from D7.2's one-set rule.
    expect(lines(/ownCapNote/), "a total is rendered without saying what it left out").toBe(5);
    expect(src).toContain("ownCapitalNote(ownCap)");
    // …and the Broker-funded row names its own set instead.
    expect(src).toMatch(/every MTF row that states funding/);
  });

  it("the per-row cell reads the same predicate the total does", () => {
    expect(src).toContain("statesOwnCapital");
    expect(src).toMatch(/accessorKey: "ownCapital"[\s\S]{0,200}?statesOwnCapital/);
  });
});

/**
 * D8 / D9 (v4.3.0 fix wave 2O — mtf#2 ≡ seams#0 medium, mtf#4 low).
 *
 * D8: wave 2N repointed the /equity "MTF funded" KPI CARD FACE at
 * `ownCapitalTotal`'s stating subset (`const mtfFunded = ownCap.funded`), and that
 * subset excludes every row which states no OWN capital. So a book of two partly
 * sold MTF rows, each recording ₹16,000 of broker funding, read "MTF funded ₹0" on
 * its headline KPI while the two cells below it printed 16,000 and /targets stated
 * ₹32,000 for the same rows. A partly sold leg's FUNDED amount IS stated — it is
 * the whole leg, which is exactly what Q-B keeps accruing on; only its own capital
 * is unstatable. `mtfFundedStated` is that one figure, read by the face, the
 * dialog's "Broker-funded" row and /targets.
 *
 * D9: the reason ladder tests the SALE before the missing amount, so a row that is
 * both partly sold AND unpriced reported "partlySold" — the desk printed "the
 * stored funding covers the whole original leg" beside a dash for a row with no
 * stored funding, /equity's note said "1 partly sold", the "no funded amount yet"
 * hint never appeared, and /targets and /risk called the same row "not recorded".
 * `mtfDashReason` is the reason the USER CAN ACT ON; `ownCapitalUnstated` keeps its
 * shape meaning (no ladder reorder, no wire change).
 */
describe("D8 — `mtfFundedStated` is the funding the book records, not the own-capital subset", () => {
  const mtfRow = (over: Partial<Trade>) =>
    trade({
      segment: "eq_mtf", instrumentType: "equity", bucket: "equity", symbol: "X", tradingsymbol: "X",
      buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-08-20", mtfFundedAmount: 16000,
      ...over,
    });
  const MTM = new Map([["X", 210]]);
  const book = (...over: Partial<Trade>[]) => deriveOpenPositions(over.map(mtfRow), MTM, "2026-09-19");

  it("two partly sold rows stating 16,000 each: funded 32,000 / unstated 0, where ownCapitalTotal states 0", () => {
    const ps = book({ id: 1, sellQty: 40, avgSellPrice: 210 }, { id: 2, sellQty: 40, avgSellPrice: 210 });
    // The subset the face used to read: nothing, because neither row states own capital.
    expect(ownCapitalTotal(ps).funded, "the own-capital subset really is empty").toBe(0);
    // THE assertion (on revert: 0 — a headline KPI of ₹0 beside two cells of 16,000).
    expect(mtfFundedStated(ps)).toEqual({ funded: 32000, stated: 2, unstated: 0 });
  });

  it("an unpriced row beside them is COUNTED, never filled in; a stated 0 states its 0", () => {
    const withUnpriced = book(
      { id: 1, sellQty: 40, avgSellPrice: 210 },
      { id: 2, sellQty: 40, avgSellPrice: 210 },
      { id: 3, mtfFundedAmount: null },
    );
    expect(mtfFundedStated(withUnpriced)).toEqual({ funded: 32000, stated: 2, unstated: 1 });
    // Every row unpriced is a TRUE ₹0 with the count beside it, not an estimate.
    expect(mtfFundedStated(book({ id: 1, mtfFundedAmount: null }, { id: 2, mtfFundedAmount: null }))).toEqual({ funded: 0, stated: 0, unstated: 2 });
    // A stated 0 (paid for in full) is a statement: inside the total, and counted
    // as a row that states its funding (V3/X2).
    expect(mtfFundedStated(book({ id: 1, mtfFundedAmount: 0 }))).toEqual({ funded: 0, stated: 1, unstated: 0 });
    // A non-MTF row is in neither figure.
    expect(mtfFundedStated(book({ id: 1, segment: "eq_delivery" }))).toEqual({ funded: 0, stated: 0, unstated: 0 });
  });

  it("an over-sold and a sell-to-open row state their funding too — only a null is unstated", () => {
    const ps = book(
      { id: 1, sellQty: 140, avgSellPrice: 200 }, //                                  over-sold, stated
      { id: 2, buyQty: 0, sellQty: 100, avgSellPrice: 200, mtfFundedAmount: null }, // sell-to-open, unpriced
    );
    expect(mtfFundedStated(ps)).toEqual({ funded: 16000, stated: 1, unstated: 1 });
  });

  it("the /equity card FACE no longer reads the own-capital subset (source pin)", () => {
    const text = fs.readFileSync(path.join(process.cwd(), "components/trackers/tracker-client.tsx"), "utf8");
    // THE assertion (on revert: `const mtfFunded = ownCap.funded;` — the face and
    // the dialog's Broker-funded row both read the subset, and nothing on the face
    // disclosed anything).
    expect(text, "the face is back on the own-capital subset").not.toMatch(/mtfFunded\s*=\s*ownCap\.funded/);
    expect(text).toContain("mtfFundedStated(positions)");
    // …and the face's own value is the helper's, never summed with ownCap.funded.
    expect(text).toMatch(/valueNum=\{mtfFunded\.funded\}/);
  });
});

describe("D9 — an unrecorded funded amount is the reason every surface gives", () => {
  const mtfRow = (over: Partial<Trade>) =>
    trade({
      segment: "eq_mtf", instrumentType: "equity", bucket: "equity", symbol: "X", tradingsymbol: "X",
      buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-08-20", mtfFundedAmount: 16000,
      mtfInterest: 276,
      ...over,
    });
  const one = (over: Partial<Trade>) => deriveOpenPositions([mtfRow(over)], new Map([["X", 210]]), "2026-09-19")[0];

  it("partly sold AND unpriced: the reason is 'unpriced' on every reader, and it carries no Q-B caveat", () => {
    const p = one({ sellQty: 40, avgSellPrice: 210, mtfFundedAmount: null });
    // The SHAPE is unchanged — no ladder reorder, no wire change (the desk ships
    // `unstated` verbatim).
    expect(p.ownCapitalUnstated, "the shape reason is untouched").toBe("partlySold");
    // THE assertion (on revert: 'partlySold' — three screens, two reasons, and the
    // one remedy the user has is the one nothing named).
    expect(mtfDashReason(p)).toBe("unpriced");
    expect(ownCapitalTotal([p]).unstatedWhy).toEqual({ partlySold: 0, overSold: 0, sellToOpen: 0, unpriced: 1 });
    expect(ownCapitalNote(ownCapitalTotal([p]))).toBe("own capital not stated for 1 unpriced MTF row");
    // Q-A: such a row accrues nothing, so the whole-leg caveat is not its caveat.
    expect(interestOnWholeLeg(p), "no Q-B label on a row that bills nothing").toBe(false);
  });

  it("partly sold with STATED funding keeps 'partlySold' and keeps the Q-B caveat", () => {
    const p = one({ sellQty: 40, avgSellPrice: 210 });
    expect([p.ownCapitalUnstated, mtfDashReason(p)]).toEqual(["partlySold", "partlySold"]);
    expect(interestOnWholeLeg(p)).toBe(true);
    expect(ownCapitalTotal([p]).unstatedWhy.partlySold).toBe(1);
  });

  it("an over-sold row: stated keeps its shape reason and the caveat, unpriced reports 'unpriced' and loses it", () => {
    const stated = one({ sellQty: 140, avgSellPrice: 200 });
    expect([mtfDashReason(stated), interestOnWholeLeg(stated)]).toEqual(["overSold", true]);
    const unpriced = one({ sellQty: 140, avgSellPrice: 200, mtfFundedAmount: null });
    expect([unpriced.ownCapitalUnstated, mtfDashReason(unpriced), interestOnWholeLeg(unpriced)]).toEqual(["overSold", "unpriced", false]);
  });

  it("a fully held unpriced row, a stated 0 and a non-MTF row answer exactly as before", () => {
    expect(mtfDashReason(one({ mtfFundedAmount: null }))).toBe("unpriced");
    expect(mtfDashReason(one({ mtfFundedAmount: 0 }))).toBeNull();
    expect(mtfDashReason(one({}))).toBeNull();
    expect(mtfDashReason(one({ segment: "eq_delivery", sellQty: 40, avgSellPrice: 210 }))).toBeNull();
  });
});
