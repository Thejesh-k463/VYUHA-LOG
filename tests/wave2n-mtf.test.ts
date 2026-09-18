import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  deriveOpenPositions,
  fundingSide,
  MTF_INTEREST_WHOLE_LEG_NOTE,
  ownCapitalNote,
  ownCapitalTotal,
  statesOwnCapital,
  type PositionTrade,
} from "@/lib/analytics/positions";
import { MtfDriftCard } from "@/components/risk/mtf-drift-card";
import { money } from "@/components/live/desk-format";

/**
 * D7 (v4.3.0 fix wave 2N) — ONE PREDICATE FOR MTF OWN CAPITAL, AND NO ESTIMATE
 * ON ANY SCREEN.
 *
 * The wave-2L re-check found four shapes the L2 predicate walked past, each of
 * them a rupee figure on /equity that the journal never recorded (invariant 6):
 *
 *   close-readers#0  an OPEN row whose sells exceed its buys (sellQty > buyQty)
 *                    is not "partly sold" by `sellQty < buyQty`, so ownCapital
 *                    went NEGATIVE again — −8,000 straight into the KPI.
 *   close-readers#5  a sell-to-open row (buyQty 0) was credited with 5,000 of
 *                    own capital derived from the SALE value: a figure behind
 *                    which there is no buy leg at all.
 *   close-readers#1  a row the journal never priced (`mtfFundedAmount` null —
 *                    EVERY imported MTF buy) was estimated at the margin
 *                    default, so /equity stated funded 15,000 / own 5,000 for
 *                    the same row /risk called "not priced" and /trades called
 *                    "funding not yet resolved". Since M1 removed the accrual's
 *                    write-back, that estimate is permanent, not transient.
 *   close-readers#3  the drift card pointed at "the table below" when no table
 *                    renders (the common case for an imported MTF book).
 *
 * The rule: an open MTF row STATES own capital only when it is a plain held buy
 * leg (`buyQty > 0 && sellQty === 0`) AND its funded amount is stated. Anything
 * else states NONE, and every total says how many rows it left out and WHY.
 *
 * PURE — no database, no route: this file drives the analytics module, the
 * drift card's own render and the desk formatter, plus the source shape of the
 * four surfaces that read them.
 */

const mtfTrade = (over: Partial<PositionTrade>): PositionTrade => ({
  id: 1,
  broker: "zerodha",
  bucket: "equity",
  segment: "eq_mtf",
  instrumentType: "equity",
  exchange: "NSE",
  symbol: "X",
  tradingsymbol: "X",
  optionType: null,
  strike: null,
  expiry: null,
  isOpen: true,
  buyQty: 100,
  sellQty: 0,
  avgBuyPrice: 200,
  avgSellPrice: 0,
  closingPrice: 200,
  buyDate: "2026-08-20",
  sellDate: null,
  mtfFundedAmount: 16000,
  mtfInterest: 0,
  riskAmount: null,
  slPlanned: null,
  targetPlanned: null,
  ...over,
});

const one = (over: Partial<PositionTrade>) => deriveOpenPositions([mtfTrade(over)], new Map(), "2026-09-19")[0];

/** A file's CODE, with comment lines dropped: a comment quoting the old shape
 *  is the false positive the AST guard exists to avoid (G3), and these pins
 *  must not re-introduce it. */
const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, "");

describe("D7 — the four shapes that stated a figure the journal never recorded", () => {
  it("close-readers#0 — an open leg whose SELLS exceed its buys states no own capital (was −8,000 in the KPI)", () => {
    const p = one({ buyQty: 100, avgBuyPrice: 200, sellQty: 140, avgSellPrice: 200, mtfFundedAmount: 16000 });
    expect([p.qty, p.invested], "the remaining quantity is priced off the sale, as before").toEqual([40, 8000]);
    // THE assertion (on revert: ownCapital −8,000, statesOwnCapital true, and
    // the KPI total −8,000 while the per-row cell printed "—").
    expect([p.ownCapital, p.roiOnCapitalPct]).toEqual([null, null]);
    expect(p.ownCapitalUnstated).toBe("overSold");
    expect(statesOwnCapital(p)).toBe(false);
    const t = ownCapitalTotal([p]);
    expect([t.total, t.funded, t.unstated]).toEqual([0, 0, 1]);
    expect(t.unstatedWhy.overSold).toBe(1);
  });

  it("close-readers#5 — a sell-to-open MTF row states nothing: there is no buy leg behind the figure", () => {
    const p = one({ buyQty: 0, sellQty: 100, avgBuyPrice: 0, avgSellPrice: 200, mtfFundedAmount: null });
    expect(p.invested, "the sale value, as the short branch has always priced it").toBe(20000);
    // THE assertion (on revert: fundedAmount 15,000 — 75% of a SALE — and
    // ownCapital 5,000 in "Own capital in MTF").
    expect([p.fundedAmount, p.ownCapital]).toEqual([null, null]);
    expect(p.ownCapitalUnstated).toBe("sellToOpen");
    // PIN MOVED, deliberately (D9, wave 2O — mtf#4): the SHAPE of the row is still
    // `sellToOpen` (asserted above, and it is what the Live Desk wire ships), but
    // the TALLY every surface reads out states the reason the user can act on, and
    // this row states no funded amount at all. /risk already calls it "not priced"
    // and /targets "funding not recorded"; three screens now give one answer.
    const why = ownCapitalTotal([p]).unstatedWhy;
    expect([why.sellToOpen, why.unpriced]).toEqual([0, 1]);
    // …and with its funding recorded the shape reason is what is counted.
    const stated = one({ buyQty: 0, sellQty: 100, avgBuyPrice: 0, avgSellPrice: 200, mtfFundedAmount: 16000 });
    expect(ownCapitalTotal([stated]).unstatedWhy.sellToOpen).toBe(1);
  });

  it("close-readers#1 — a row the journal never priced states NO funded amount and NO own capital", () => {
    const p = one({ mtfFundedAmount: null });
    // THE assertion (on revert: [15000, 5000, 10] — the 25% margin default
    // presented as money on the same screen /risk calls "not priced").
    expect([p.fundedAmount, p.ownCapital, p.roiOnCapitalPct]).toEqual([null, null, null]);
    expect(p.ownCapitalUnstated).toBe("unpriced");
    const t = ownCapitalTotal([p]);
    expect([t.total, t.funded, t.unstated]).toEqual([0, 0, 1]);
    expect(t.unstatedWhy.unpriced).toBe(1);
  });

  it("a partly sold leg is unchanged (L2[0]), and a STATED 0 states its 0 everywhere", () => {
    const partly = one({ sellQty: 40, avgSellPrice: 210 });
    expect([partly.ownCapital, partly.ownCapitalUnstated]).toEqual([null, "partlySold"]);

    // funded == invested: the position is 100% broker-financed, and 0 own
    // capital is a STATEMENT, not a missing figure (V3/X2).
    const zeroOwn = one({ mtfFundedAmount: 20000 });
    expect([zeroOwn.fundedAmount, zeroOwn.ownCapital, zeroOwn.ownCapitalUnstated]).toEqual([20000, 0, null]);
    expect(statesOwnCapital(zeroOwn)).toBe(true);
    const t = ownCapitalTotal([zeroOwn]);
    expect([t.total, t.funded, t.unstated], "a stated 0 is inside the total, not left out of it").toEqual([0, 20000, 0]);

    // A stated funded 0 (paid for in full) is the mirror image.
    const allOwn = one({ mtfFundedAmount: 0 });
    expect([allOwn.fundedAmount, allOwn.ownCapital, allOwn.roiOnCapitalPct]).toEqual([0, 20000, 0]);
  });

  it("a NON-MTF row is untouched: funded 0, ownCapital 0, never null and never counted", () => {
    const p = one({ segment: "eq_delivery", sellQty: 40, avgSellPrice: 210 });
    expect([p.isMtf, p.fundedAmount, p.ownCapital, p.ownCapitalUnstated]).toEqual([false, 0, 0, null]);
    expect(ownCapitalTotal([p]).unstated).toBe(0);
  });
});

describe("D7 — the total names every reason it left a row out", () => {
  const book = () =>
    deriveOpenPositions(
      [
        mtfTrade({ id: 1 }), //                                               states 5,000 own / 16,000 funded (the only stating row wait: 20,000 − 16,000)
        mtfTrade({ id: 2, sellQty: 40, avgSellPrice: 210 }), //               partly sold
        mtfTrade({ id: 3, sellQty: 30, avgSellPrice: 210 }), //               partly sold
        mtfTrade({ id: 4, mtfFundedAmount: null }), //                        unpriced
        mtfTrade({ id: 5, sellQty: 140, avgSellPrice: 200 }), //              over-sold
        mtfTrade({ id: 6, buyQty: 0, sellQty: 100, avgSellPrice: 200 }), //   sell-to-open
      ],
      new Map(),
      "2026-09-19",
    );

  it("the counts are per reason, and the note reads them out", () => {
    const t = ownCapitalTotal(book());
    expect([t.total, t.funded, t.unstated]).toEqual([4000, 16000, 5]);
    expect(t.unstatedWhy).toEqual({ partlySold: 2, overSold: 1, sellToOpen: 1, unpriced: 1 });
    // THE assertion (on revert: "own capital not stated for 5 partly sold MTF
    // rows" — four of the five are not partly sold at all).
    expect(ownCapitalNote(t)).toBe("own capital not stated for 2 partly sold, 1 over-sold, 1 sell-to-open, 1 unpriced MTF rows");
  });

  it("the singular, and a book with nothing left out says nothing", () => {
    const only = ownCapitalTotal(deriveOpenPositions([mtfTrade({ mtfFundedAmount: null })], new Map(), "2026-09-19"));
    expect(ownCapitalNote(only)).toBe("own capital not stated for 1 unpriced MTF row");
    const whole = ownCapitalTotal(deriveOpenPositions([mtfTrade({})], new Map(), "2026-09-19"));
    expect(ownCapitalNote(whole)).toBeNull();
    // The old numeric call site (the seam suite's) still answers.
    expect(ownCapitalNote(0)).toBeNull();
    expect(ownCapitalNote(2)).toContain("2");
  });

  it("fundingSide reads null as neither side — an unpriced row is not 'user funded'", () => {
    expect(fundingSide(one({ mtfFundedAmount: null }))).toBeNull();
    expect(fundingSide(one({ mtfFundedAmount: 0 }))).toBe("user");
    expect(fundingSide(one({ mtfFundedAmount: 16000 }))).toBe("broker");
    expect(fundingSide(one({ segment: "eq_delivery" }))).toBe("user");
  });
});

describe("D7 — the KPI dialog's three MTF money rows come from ONE set (close-readers#2)", () => {
  const text = src("components/trackers/tracker-client.tsx");

  it("Broker-funded is the stating rows' financing, not the whole-book reduce", () => {
    // THE assertion (on revert: `positions.reduce((s, p) => s + p.fundedAmount, 0)`
    // — ₹32,000 of financing beside ₹4,000 of own capital and a 5.00x ratio, so
    // the two rows above the leverage imply 9.00x).
    expect(text, "the component still reduces fundedAmount itself").not.toMatch(/\.reduce\([\s\S]{0,80}?p\.fundedAmount/);
    // D8 (wave 2O): the reduce stays out, and each figure comes from ONE exported
    // helper — `mtfFundedStated` for the card face and this row, `ownCapitalTotal`
    // for own capital and the leverage ratio.
    expect(text).toContain("mtfFundedStated(positions)");
    expect(text).toContain("ownCap.funded");
  });

  it("the note is attached to all THREE money rows, and a fourth line states what is left out", () => {
    const lines = (re: RegExp) => text.split(/\r?\n/).filter((l) => re.test(l)).length;
    // the const + "Own capital in MTF" + Your own capital + leverage + the
    // "not in these figures" line.
    //
    // PIN MOVED, deliberately (D8, wave 2O — mtf#2 ≡ seams#0): was 6, with
    // "Broker-funded" reading `ownCap.funded` and carrying this note. That is what
    // pointed the KPI FACE at the own-capital subset too, so a book of partly sold
    // MTF rows whose funding IS recorded printed "MTF funded ₹0" beside cells of
    // 16,000. Broker-funded is now `mtfFundedStated` — the same figure as the face
    // and /targets — and states THAT set in its own hint, which is a different set
    // from the one this note names.
    expect(lines(/ownCapNote/), "a money row is rendered without saying what it left out").toBe(5);
    expect(text, "the Broker-funded row states the set it describes").toMatch(/every MTF row that states funding/);
    expect(text, "the leverage row states its own inputs").toMatch(/"row that states", "rows that state"\)\} own capital/); // 2P D12: the plural() helper states noun and verb
    expect(text, "the dialog never states the financing it excluded without counting it").toMatch(/not in these figures/i);
  });

  it("the per-row cells read the predicate alone — a stated 0 prints 0, an unpriced row prints the dash", () => {
    // The extra `> 0` on top of the shared predicate is what made a stated own
    // capital of 0 render "—" while the total counted it (close-readers#0).
    expect(text).not.toMatch(/statesOwnCapital\(p\) && \(p\.ownCapital \?\? 0\) > 0/);
    expect(text).toMatch(/accessorKey: "ownCapital"[\s\S]{0,220}?statesOwnCapital/);
    // The funding filter and the "MTF-funded positions" count read the shared
    // rule, never `<= 0` / `> 0` over a nullable figure.
    expect(text).not.toMatch(/p\.fundedAmount (?:<=|>) 0/);
    expect(text).toContain("fundingSide");
  });

  it("Q-B — the interest hint says what the whole-leg estimate is, for a row with a sale on it", () => {
    // ONE sentence, from the module that owns the rule — /equity, the KPI and
    // the Live Desk cannot word it differently.
    expect(MTF_INTEREST_WHOLE_LEG_NOTE).toBe("interest estimated on the whole funded amount until the row closes");
    expect(text).toContain("MTF_INTEREST_WHOLE_LEG_NOTE");
    expect(text).toMatch(/interestOnWholeLeg\(p\)/);
  });
});

describe("D7 — the drift card names what it is not showing (close-readers#3)", () => {
  const render = (drift: Parameters<typeof MtfDriftCard>[0]["drift"], unpriced: number) =>
    renderToStaticMarkup(React.createElement(MtfDriftCard, { drift, unpriced, bundleAsOf: "2026-09-01", stale: false }))
      .replace(/<[^>]*>/g, " ")
      .replace(/&#x27;|&apos;/g, "'")
      .replace(/\s+/g, " ");

  it("with NO drift table on the page the sentence points at no table", () => {
    const out = render([], 2);
    // THE assertion (on revert: "…they are left out of the table below", with
    // no table in the output at all).
    expect(out).not.toContain("the table below");
    expect(out).toContain("left out of the margin check");
    expect(out).toContain("2 open MTF positions are not priced");
  });

  it("with a table on the page it still names it", () => {
    const out = render(
      [{ id: 1, symbol: "X", broker: "zerodha", storedOwnPct: 25, currentPct: 40, deltaPct: 15, topUpAtCurrent: 3000, source: "stock-list" }],
      1,
    );
    expect(out).toContain("the table below");
  });
});

describe("D7 — the Live Desk half is pinned, not left to tsc (close-readers#4)", () => {
  it("both MTF money fields cross the wire through toPaiseOrNull", () => {
    const desk = src("components/live/load-desk.ts");
    // THE assertion (on revert: `toPaise(p.fundedAmount)`, which types fine and
    // renders "₹0" — a STATED zero — for a row nobody priced).
    expect(desk).toMatch(/fundedP: toPaiseOrNull\(p\.fundedAmount\)/);
    expect(desk).toMatch(/ownCapitalP: toPaiseOrNull\(p\.ownCapital\)/);
    expect(src("components/live/desk-types.ts")).toMatch(/fundedP: number \| null/);
  });

  it("the formatter really does tell the two apart, so the pin above is worth having", () => {
    expect(money(null)).not.toBe(money(0));
    expect(money(0)).toBe("₹0");
  });

  it("the desk block prints the dash for a null and names the reason beside it", () => {
    const client = src("components/live/tracker-client.tsx");
    expect(client).toMatch(/row\.mtf\.fundedP === null/);
    expect(client).toContain("MTF_INTEREST_WHOLE_LEG_NOTE");
    // D9 (wave 2O, mtf#4): both note sites resolve the reason through the ONE
    // exported predicate, so a row that is partly sold AND states no funding is no
    // longer told "the stored funding covers the whole original leg" — and the
    // interest block's Q-B caveat is the same `interestOnWholeLeg` /equity reads,
    // which an unpriced row (accruing nothing under Q-A) does not satisfy.
    expect(client).toContain("mtfDashReason(");
    expect(client).toContain("interestOnWholeLeg(");
    expect(client, "the shape reason is no longer read on its own").not.toMatch(/MTF_UNSTATED_NOTE\[row\.mtf\.unstated/);
  });
});

/**
 * D12 (wave 2O, mtf#5) — THE FIVE PLEDGE COMMENTS STATE WHAT THE CODE DOES.
 *
 * All five said the pledge charge is still billed for a null-funded MTF row. It is
 * not: `lib/engine/charges.ts:106` gates interest AND pledge on the same
 * `input.mtf.fundedAmount > 0`, so `closePosition` on such a row stores
 * `[mtfFundedAmount null, mtfInterest 0, pledgeCharges 0]` — the DECISIONS entry's
 * recorded deviation. A comment stating removed behaviour as current is the rc7
 * mtf-accrual#3 class, and the next builder reads it as the contract.
 *
 * No behaviour changed: `tests/seams-v43-fixF.test.ts` F44 ([null, 0, 0] across the
 * five writers) and `tests/seams-v43-fixE.test.ts` E-c X2 already hold it.
 */
describe("D12 — no comment claims the pledge charge survives an unrecorded principal", () => {
  const COMMENT_SITES = [
    "lib/import/commit.ts",
    "app/api/charges/preview/route.ts",
    "lib/queries/staged.ts",
  ];

  it("none of the writer sites claims the pledge fee stands", () => {
    const claims = [
      /pledge charge stands/i,
      /pledge charge still/i,
      /keeps its pledge charge/i,
      /pledge charge below still applies/i,
      /pledge charge still applies/i,
    ];
    const hits: string[] = [];
    for (const rel of COMMENT_SITES) {
      const text = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      text.split(/\r?\n/).forEach((line, i) => {
        if (claims.some((re) => re.test(line))) hits.push(`${rel}:${i + 1} ${line.trim()}`);
      });
    }
    // THE assertion (on revert: five lines, each stating the opposite of the code
    // and of the DECISIONS entry).
    expect(hits, "a comment states behaviour the engine does not have").toEqual([]);
  });

  it("and each of the three files states the deviation instead", () => {
    for (const rel of COMMENT_SITES) {
      const text = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(text, `${rel} does not cite the engine's own gate`).toMatch(/charges\.ts:106|gates (?:interest AND pledge|BOTH)/);
    }
  });
});

describe("D7 — the two pages that priced an unpriced row", () => {
  it("/equity invents no breakeven for a row with no stated funding", () => {
    const page = src("app/equity/page.tsx");
    // THE assertion (on revert: `mtf: { fundedAmount: p.fundedAmount, … }` with
    // the estimate inside it, so the Breakeven column stated a price built on
    // financing the journal never recorded).
    expect(page).toMatch(/p\.fundedAmount == null/);
  });

  it("/targets leaves a null-funded row out of every MTF figure it states", () => {
    const page = src("app/targets/equity/page.tsx");
    expect(page).toMatch(/fundedRow == null|p\.fundedAmount == null/);
    expect(page).not.toMatch(/funded \+= p\.fundedAmount;/);
  });
});

describe("D7 — Data Quality says what the missing amount costs the user", () => {
  it("the mtf_funding detail names the three surfaces that leave the row out", () => {
    const dq = src("lib/analytics/data-quality.ts");
    expect(dq).toContain("own capital, leverage and the margin check leave the row out until it is recorded");
  });
});
