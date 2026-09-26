import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  fmvIsMixed,
  grandfatherKey,
  grandfatherLotsOf,
  groupGrandfatherLots,
  type FmvGroup,
  type FmvLot,
  type GrandfatherParent,
} from "@/lib/analytics/grandfather-groups";
import { FmvEditor } from "@/components/reports/fmv-editor";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

/**
 * v4.6.0 W7 (D3) — the /reports/tax FMV editor lists ONE row per scrip
 * (symbol + ISIN), not one per trade. Pure; the write route's same-key check
 * is pinned in tests/fmv-route.test.ts.
 */

const lot = (over: Partial<FmvLot> & { id: number }): FmvLot => ({
  symbol: "INFY",
  isin: "INE009A01021",
  buyDate: "2017-05-10",
  sellDate: "2021-03-01",
  isOpen: false,
  buyQty: 10,
  avgBuyPrice: 950,
  fmv31Jan2018: null,
  ...over,
});

describe("groupGrandfatherLots", () => {
  it("two INFY lots and one TCS lot are TWO groups, each lot under its own scrip", () => {
    const groups = groupGrandfatherLots([
      lot({ id: 1, buyDate: "2016-08-01", buyQty: 5 }),
      lot({ id: 2, symbol: "TCS", isin: "INE467B01029", buyDate: "2015-01-02" }),
      lot({ id: 3, buyDate: "2017-11-20", buyQty: 7 }),
    ]);
    expect(groups.map((g) => [g.key, g.ids, g.totalQty, g.firstBuyDate, g.lastBuyDate])).toEqual([
      ["INFY|INE009A01021", [1, 3], 12, "2016-08-01", "2017-11-20"],
      ["TCS|INE467B01029", [2], 10, "2015-01-02", "2015-01-02"],
    ]);
  });

  it("an ISIN-less lot is its own group, apart from the same symbol WITH an ISIN", () => {
    const groups = groupGrandfatherLots([lot({ id: 1 }), lot({ id: 2, isin: null })]);
    expect(groups.map((g) => [g.key, g.isin, g.ids])).toEqual([
      ["INFY|", null, [2]],
      ["INFY|INE009A01021", "INE009A01021", [1]],
    ]);
  });

  it("fmv is the shared value, null when none, 'mixed' when the lots differ", () => {
    expect(groupGrandfatherLots([lot({ id: 1, fmv31Jan2018: 1100 }), lot({ id: 2, fmv31Jan2018: 1100 })])[0].fmv).toBe(1100);
    expect(groupGrandfatherLots([lot({ id: 1 }), lot({ id: 2 })])[0].fmv).toBeNull();
    expect(groupGrandfatherLots([lot({ id: 1, fmv31Jan2018: 1100 }), lot({ id: 2 })])[0].fmv).toBe("mixed");
    expect(groupGrandfatherLots([lot({ id: 1, fmv31Jan2018: 1100 }), lot({ id: 2, fmv31Jan2018: 1090 })])[0].fmv).toBe("mixed");
  });

  it("fmvIsMixed — THE test the route and the editor share: NULL counts as a value; uniform (all equal, all blank) is not mixed", () => {
    expect(fmvIsMixed([{ fmv31Jan2018: 1100 }, { fmv31Jan2018: 1100 }])).toBe(false);
    expect(fmvIsMixed([{ fmv31Jan2018: null }, { fmv31Jan2018: null }])).toBe(false);
    expect(fmvIsMixed([{ fmv31Jan2018: 1100 }, { fmv31Jan2018: 1100 }, { fmv31Jan2018: null }])).toBe(true);
    expect(fmvIsMixed([{ fmv31Jan2018: 1100 }, { fmv31Jan2018: 1090 }])).toBe(true);
    expect(fmvIsMixed([{ fmv31Jan2018: 1100 }])).toBe(false);
    // Both doors read it — never a second, drifting copy.
    for (const f of ["../app/api/trades/fmv/route.ts", "../components/reports/fmv-editor.tsx"]) {
      const src = readFileSync(path.resolve(__dirname, f), "utf8");
      expect(src, f).toMatch(/fmvIsMixed\(/);
    }
  });

  it("eligibility is read through the DATE, never the bytes: DD-MM-YYYY 2019 out, DD-MM-YYYY 2017 in", () => {
    // '15-06-2019' < '2018-02-01' bytewise, and '31-12-2017' > it — a byte
    // filter would list the first and hide the second.
    const groups = groupGrandfatherLots([
      lot({ id: 1, buyDate: "15-06-2019" }),
      lot({ id: 2, buyDate: "31-12-2017" }),
      lot({ id: 3, buyDate: "2018-01-31" }), // the last eligible day
      lot({ id: 4, buyDate: "2018-02-01" }),
      lot({ id: 5, buyDate: null }),
    ]);
    expect(groups.map((g) => g.ids)).toEqual([[2, 3]]);
    expect(groups[0].firstBuyDate, "stated as the ISO day").toBe("2017-12-31");
  });

  it("orders groups by symbol and lots by ISO buy date, then id", () => {
    const groups = groupGrandfatherLots([
      lot({ id: 9, symbol: "ZEEL", isin: "INE256A01028" }),
      lot({ id: 4, buyDate: "10-01-2017" }),
      lot({ id: 2, buyDate: "2017-01-10" }),
      lot({ id: 3, buyDate: "2016-12-31" }),
    ]);
    expect(groups.map((g) => g.symbol)).toEqual(["INFY", "ZEEL"]);
    expect(groups[0].ids).toEqual([3, 2, 4]);
  });
});

describe("grandfatherKey", () => {
  it("folds the symbol's case and keeps a blank ISIN distinct", () => {
    expect(grandfatherKey({ symbol: "infy", isin: "INE009A01021" })).toBe(grandfatherKey({ symbol: "INFY", isin: "INE009A01021" }));
    expect(grandfatherKey({ symbol: "INFY", isin: null })).toBe("INFY|");
    expect(grandfatherKey({ symbol: "INFY", isin: null })).not.toBe(grandfatherKey({ symbol: "INFY", isin: "INE009A01021" }));
  });

  it("groups a lower-case symbol with its upper-case twin", () => {
    const groups = groupGrandfatherLots([lot({ id: 1, symbol: "infy" }), lot({ id: 2 })]);
    expect(groups.map((g) => [g.symbol, g.ids])).toEqual([["INFY", [1, 2]]]);
  });

  it("trims and upper-cases the ISIN; a blank ISIN after trim is the same as none", () => {
    expect(grandfatherKey({ symbol: "INFY", isin: " ine009a01021" })).toBe("INFY|INE009A01021");
    expect(grandfatherKey({ symbol: "INFY", isin: "   " })).toBe(grandfatherKey({ symbol: "INFY", isin: null }));
    const groups = groupGrandfatherLots([lot({ id: 1, isin: " ine009a01021" }), lot({ id: 2, isin: "INE009A01021" })]);
    expect(groups.map((g) => [g.key, g.ids])).toEqual([["INFY|INE009A01021", [1, 2]]]);
  });
});

// v4.6.0 W7 fix wave, item 6 — the tax page's lot selection, pure.
describe("grandfatherLotsOf — the DISTINCT parents behind the realised book", () => {
  const parent = (over: Partial<GrandfatherParent> & { id: number }): GrandfatherParent => ({
    symbol: "INFY",
    isin: "INE009A01021",
    segment: "eq_delivery",
    buyDate: "2017-05-10",
    sellDate: "2021-03-01",
    isOpen: false,
    buyQty: 10,
    avgBuyPrice: 950,
    fmv31Jan2018: null,
    ...over,
  });

  it("an OPEN partly-sold pre-2018 ladder with two realised rows is ONE lot at the parent's own figures", () => {
    const lots = grandfatherLotsOf(
      [parent({ id: 1, isOpen: true, sellDate: null, buyDate: "2017-03-01", buyQty: 30, fmv31Jan2018: 1100 })],
      [{ id: 1 }, { id: 1 }],
    );
    expect(lots).toEqual([
      { id: 1, symbol: "INFY", isin: "INE009A01021", buyDate: "2017-03-01", sellDate: null, isOpen: true, buyQty: 30, avgBuyPrice: 950, fmv31Jan2018: 1100 },
    ]);
  });

  it("a duplicated parent is still one lot; a parent with no realised row is none", () => {
    const p = parent({ id: 4 });
    expect(grandfatherLotsOf([p, p, parent({ id: 5 })], [{ id: 4 }]).map((l) => l.id)).toEqual([4]);
  });

  it("a closed 2020 lot and a non-equity lot are excluded; a lot sold in an earlier FY is included", () => {
    const lots = grandfatherLotsOf(
      [
        parent({ id: 1, buyDate: "2020-02-10" }),
        parent({ id: 2, segment: "eq_intraday" }),
        parent({ id: 3, segment: "eq_mtf", sellDate: "2019-06-01" }),
        parent({ id: 4, sellDate: "2018-09-01" }),
      ],
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    );
    expect(lots.map((l) => l.id)).toEqual([3, 4]);
  });

  it("eligibility is read through the DATE: DD-MM-YYYY '15-06-2019' OUT, '31-12-2017' IN", () => {
    const lots = grandfatherLotsOf(
      [parent({ id: 1, buyDate: "15-06-2019" }), parent({ id: 2, buyDate: "31-12-2017" })],
      [{ id: 1 }, { id: 2 }],
    );
    expect(lots.map((l) => l.id)).toEqual([2]);
  });
});

// v4.6.0 W7 fix wave, item 4 — the editor. Rendered to static markup (the
// repo's node-env pattern); useRouter is stubbed because no app router mounts.
describe("FmvEditor — a blank Save never wipes values that exist", () => {
  const html = (groups: FmvGroup[]) => renderToStaticMarkup(React.createElement(FmvEditor, { groups }));
  const saveButton = (markup: string) => markup.match(/<button[^>]*>Save<\/button>/)?.[0] ?? "";

  it("a MIXED group with a blank input: Save is disabled and the helper names the lots", () => {
    const g = groupGrandfatherLots([lot({ id: 1, fmv31Jan2018: 1100 }), lot({ id: 2 })]);
    expect(g[0].fmv).toBe("mixed");
    const markup = html(g);
    expect(saveButton(markup), "the Save button").toMatch(/\sdisabled=""/);
    // v4.6.0 fix wave (UI-1): the copy states the path that exists — no screen
    // clears one lot at a time.
    expect(markup).toContain("Enter a value to set all 2 lots; to clear a mixed group, set one value first, then save blank");
    expect(markup).not.toContain("one lot at a time");
    // DA-2: s.55(2)(ac) Explanation — the FMV is the HIGHEST price quoted on 31-Jan-2018, not the close.
    expect(markup).toContain("highest price quoted on 31-Jan-2018");
    expect(markup).not.toContain("closing price");
  });

  it("a group with one shared value shows it, and Save is enabled; an all-blank group can Save", () => {
    const shared = html(groupGrandfatherLots([lot({ id: 1, fmv31Jan2018: 1100 }), lot({ id: 2, fmv31Jan2018: 1100 })]));
    expect(shared).toContain('value="1100"');
    expect(saveButton(shared)).not.toMatch(/\sdisabled=""/);
    expect(shared).not.toContain("Enter a value to set all");
    expect(saveButton(html(groupGrandfatherLots([lot({ id: 1 })])))).not.toMatch(/\sdisabled=""/);
  });

  it("the shown value is DERIVED (edits ?? stored) and the page keys the editor by person", () => {
    // router.refresh() keeps client state; a useState initialised once from
    // `groups` would carry one person's typed value onto another's same scrip.
    const editor = readFileSync(path.resolve(__dirname, "../components/reports/fmv-editor.tsx"), "utf8");
    expect(editor, "no useState initialiser reads the groups prop").not.toMatch(/useState[^;]*\bgroups\b/);
    const page = readFileSync(path.resolve(__dirname, "../app/reports/tax/page.tsx"), "utf8");
    // UJ-3 (fix wave): keyed on the RESOLVED person, not the ?person= param.
    expect(page).toMatch(/<FmvEditor\s+key=\{scope\.personKey\}/);
    // DA-9 (fix wave): the footnote pointing at the card is conditioned on the card's own groups.
    expect(page).toMatch(/const hasPreGrandfatherLot = grandfatherGroups\.length > 0;/);
    expect(page).not.toMatch(/cgTrades\.some\(\(t\) => isGrandfatherEligible/);
  });
});
