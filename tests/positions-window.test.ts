import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as React from "react";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { todayIstIso } from "@/lib/domain/trading-day";
import {
  corpActionsFor,
  corpActionsOf,
  headerTotals,
  indexCorpActions,
  isoMinusDays,
  stepsToShow,
  windowLimit,
  type CorpActionInput,
} from "@/lib/live/positions-view";
import { nextIndex } from "@/components/live/desk-keys";
import { WINDOW_STEP } from "@/components/ui/show-more";
import type { DeskRow, LiveDeskData } from "@/components/live/desk-types";

/**
 * v4.8.0 wave P1 — the `/live` Positions ledger is a WINDOW, and the desk loader's
 * Positions-only work is done once per load instead of once per row.
 *
 * MEASURED BEFORE (production build, perf book, 3,460 open positions):
 * `/live?tab=positions` was a 12.1 MB document with 3,462 `<tr>` and 80,378 DOM nodes,
 * every row re-rendered on every tick.
 *
 * WHAT IS PINNED HERE, and what each case goes red on:
 *   A1  only the window is rendered as rows; every total reads the FULL filtered book
 *       → red when the row map goes back to `order`, or a total moves onto the window
 *   A2  a book of ≤ WINDOW_STEP rows has no note and no control (the seam tests'
 *       `renderToStaticMarkup` cases are the byte-level half of this)
 *   A3  j / k move over the book, not the window; the window holds the focused / opened row
 *       → `nextFocusIndex`, `windowLimit`, `stepsToShow` (pure)
 *   A4  `PositionRow` is memoised and its call site hands it nothing that defeats the memo
 *   B   OUTPUT-NEUTRAL loader diet: the by-symbol corporate-action index equals the
 *       per-row scan it replaced for every symbol, and the shared sector/classification
 *       read equals the two public functions — same values, same order — from ONE read
 *
 * NOT PINNED HERE: a mounted re-render count (the repo has no DOM test environment —
 * A4 is structural), and the browser half of A3 (`e2e/z-live-positions.spec.ts`).
 *
 * ONE temp database for the file (AGENTS.md Testing); everything reaching `lib/db` is
 * imported dynamically after `openTempDb`.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
}));
// On the server `useStoredValue` returns the default; the map stands in for a browser's storage.
const stored = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock("@/components/layout/use-stored-value", () => ({
  useStoredValue: (k: string) => stored.map.get(k) ?? null,
  writeStored: () => {},
}));

const TODAY = todayIstIso();
/** More than one step, so the window has something to hold back. */
const BOOK = WINDOW_STEP + 11;

// ─── A3 — the window arithmetic (pure) ────────────────────────────────────────

describe("windowLimit — what the user asked for, widened to hold the row that must be in view", () => {
  it("nothing to keep in view: the asked-for window, never more than the book", () => {
    expect(windowLimit(150, 3460, -1, 150)).toBe(150);
    expect(windowLimit(150, 90, -1, 150)).toBe(90);
    expect(windowLimit(0, 0, -1, 150)).toBe(0);
  });

  it("a row inside the window changes nothing — a 150-row book is never widened", () => {
    expect(windowLimit(150, 3460, 0, 150)).toBe(150);
    expect(windowLimit(150, 3460, 149, 150)).toBe(150);
    expect(windowLimit(150, 150, 149, 150)).toBe(150);
  });

  it("the first row past the edge widens by ONE whole step, not one row", () => {
    expect(windowLimit(150, 3460, 150, 150)).toBe(300);
    expect(windowLimit(150, 3460, 299, 150)).toBe(300);
    expect(windowLimit(150, 3460, 300, 150)).toBe(450);
  });

  it("a row far down (a filter cleared under the focus, an opened card) is inside the window it returns", () => {
    for (const need of [150, 151, 899, 900, 3459]) {
      const limit = windowLimit(150, 3460, need, 150);
      expect(limit, `row ${need} is outside a window of ${limit}`).toBeGreaterThan(need);
      expect(limit % 150 === 0 || limit === 3460).toBe(true);
    }
    expect(windowLimit(150, 3460, 3459, 150)).toBe(3460); // clamped to the book
  });

  it("never narrows what the user already asked for", () => {
    expect(windowLimit(600, 3460, 10, 150)).toBe(600);
  });
});

describe("stepsToShow — how many Show-more steps reach a target", () => {
  it("zero when the window already holds the target", () => {
    expect(stepsToShow(150, 150, 150)).toBe(0);
    expect(stepsToShow(300, 151, 150)).toBe(0);
  });

  it("one step for the row just past the edge; the Show more control (limit + 1) always moves", () => {
    expect(stepsToShow(150, 151, 150)).toBe(1);
    expect(stepsToShow(150, 300, 150)).toBe(1);
    expect(stepsToShow(150, 301, 150)).toBe(2);
    // The focus widened the window to 450 while the user had asked for 150: one click must
    // land PAST 450, or the control is a dead button.
    expect(150 + stepsToShow(150, 450 + 1, 150) * 150).toBe(600);
  });
});

// ─── B(i) — the corporate-action index is the scan, for every symbol ──────────

describe("indexCorpActions / corpActionsOf — the per-row scan, built once", () => {
  const actions: CorpActionInput[] = [
    { symbol: " tcs ", type: "bonus", exDate: isoMinusDays(TODAY, 4), fromUnits: 1, toUnits: 1 },
    { symbol: "TCS", type: "split", exDate: isoMinusDays(TODAY, -20), fromUnits: 1, toUnits: 5 },
    // Two more on the SAME ex-date as the first: the tie order must be the scan's (input order).
    { symbol: "TCS", type: "split", exDate: isoMinusDays(TODAY, 4), fromUnits: 2, toUnits: 1 },
    { symbol: "Tcs", type: "bonus", exDate: isoMinusDays(TODAY, 4), fromUnits: 3, toUnits: 1 },
    { symbol: "TCS", type: "split", exDate: isoMinusDays(TODAY, 30), fromUnits: 7, toUnits: 1 }, // boundary, kept
    { symbol: "TCS", type: "split", exDate: isoMinusDays(TODAY, 31), fromUnits: 1, toUnits: 2 }, // too old
    { symbol: "TCS", type: "dividend", exDate: isoMinusDays(TODAY, -5), fromUnits: null, toUnits: null },
    { symbol: "INFY", type: "bonus", exDate: isoMinusDays(TODAY, -3), fromUnits: null, toUnits: 2 }, // no ratio
    { symbol: "INFY", type: "bonus", exDate: isoMinusDays(TODAY, -3), fromUnits: 0, toUnits: 2 }, // zero ratio
    { symbol: "infy", type: "bonus", exDate: isoMinusDays(TODAY, 29), fromUnits: 1, toUnits: 1 },
    { symbol: "ZZ010", type: "split", exDate: "not-a-date", fromUnits: 1, toUnits: 2 },
    { symbol: "zz010", type: "bonus", exDate: isoMinusDays(TODAY, -9), fromUnits: 1, toUnits: 2 },
    { symbol: "ZZ010", type: "split", exDate: isoMinusDays(TODAY, -9), fromUnits: 10, toUnits: 1 },
    { symbol: "NOTHELD", type: "split", exDate: isoMinusDays(TODAY, -1), fromUnits: 1, toUnits: 2 },
  ];
  const asked = ["TCS", "tcs", " Tcs ", "INFY", "ZZ010", "zz010", "NOTHELD", "WIPRO", ""];

  it("equals corpActionsFor for every symbol — same chips, same order, ties included", () => {
    const index = indexCorpActions(actions, TODAY);
    for (const symbol of asked) {
      expect(corpActionsOf(index, symbol), `symbol ${JSON.stringify(symbol)}`).toEqual(corpActionsFor(actions, symbol, TODAY));
    }
    // The fixture is not vacuous: three chips tie on one date, and the scan's order is not sorted by ratio.
    const tcs = corpActionsFor(actions, "TCS", TODAY);
    expect(tcs.map((c) => c.fromUnits)).toEqual([7, 1, 2, 3, 1]);
    expect(corpActionsFor(actions, "INFY", TODAY)).toHaveLength(1);
    expect(corpActionsFor(actions, "ZZ010", TODAY)).toHaveLength(2);
  });

  it("an empty table and an unknown symbol are an empty list, as before", () => {
    expect(corpActionsOf(indexCorpActions([], TODAY), "TCS")).toEqual([]);
    expect(corpActionsOf(indexCorpActions(actions, TODAY), "WIPRO")).toEqual([]);
  });

  it("two rows in one scrip never share an array or a chip (the scan built each afresh)", () => {
    const index = indexCorpActions(actions, TODAY);
    const a = corpActionsOf(index, "TCS");
    const b = corpActionsOf(index, "TCS");
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    a[0].fromUnits = 999;
    a.length = 0;
    expect(corpActionsOf(index, "TCS")).toEqual(corpActionsFor(actions, "TCS", TODAY));
  });
});

// ─── The database half: one book of BOOK + 1 open positions ───────────────────

let t: TempDb;
let live: typeof import("@/components/live/load-desk");
let instrumentsQ: typeof import("@/lib/queries/instruments");
let corpQ: typeof import("@/lib/queries/corporate-actions");
let server: typeof import("react-dom/server");
let tabMod: typeof import("@/components/live/positions-tab");
let fmt: typeof import("@/components/live/desk-format");
let copy: typeof import("@/components/live/desk-copy");
let pro: LiveDeskData;
let free: LiveDeskData;

// Measured locally 2026-10-05: migrate + seed + the dynamic imports + two desk loads over
// 162 positions ≈ 4–5 s (the seam files that load the same desk record 5–6 s). Above the 3 s
// hook budget because the desk loader's import graph is the bulk of it; 120 s is for the
// Windows CI runner (> 15× slower on SQLite-file work, AGENTS.md).
beforeAll(async () => {
  t = await openTempDb("positions-window", { seed: true });
  live = await import("@/components/live/load-desk");
  instrumentsQ = await import("@/lib/queries/instruments");
  corpQ = await import("@/lib/queries/corporate-actions");
  server = await import("react-dom/server");
  tabMod = await import("@/components/live/positions-tab");
  fmt = await import("@/components/live/desk-format");
  copy = await import("@/components/live/desk-copy");

  t.db.insert(t.schema.accounts).values({ id: 2, name: "Swing", isDefault: false }).run();
  t.db.update(t.schema.settings).set({ equityCapital: 5_000_000, activeCapital: 400_000, selectedAccountId: 0 }).run();
  t.db.update(t.schema.riskConfig).set({ riskPctPpm: 7_500, stopAtrMultPermille: 2000 }).run();
  // A user's own tag (sector-only, tier "user") and an untagged row that reaches the taxonomy by ISIN.
  t.db
    .insert(t.schema.instruments)
    .values([{ symbol: "ZZ030", sector: "My Own Bucket" }, { symbol: "ZZ040", sector: null, isin: "INE467B01029" }])
    .run();

  const real = ["TCS", "INFY", "RELIANCE", "HDFCBANK", "ITC", "SBIN", "LT", "WIPRO"];
  const rows = [];
  for (let i = 0; i < BOOK; i++) {
    const symbol = i < real.length ? real[i] : `ZZ${String(i).padStart(3, "0")}`;
    const short = i % 11 === 5;
    const qty = 10 + (i % 7);
    const price = 100 + i * 3.25;
    rows.push(
      tradeRow({
        id: 1000 + i, accountId: i % 4 === 0 ? 2 : 1, symbol, tradingsymbol: symbol, isOpen: true,
        bucket: i % 9 === 0 ? "active" : "equity",
        ...(short
          ? { sellQty: qty, avgSellPrice: price, sellValue: qty * price, sellDate: isoMinusDays(TODAY, 3 + (i % 20)) }
          : { buyQty: qty, avgBuyPrice: price, buyValue: qty * price, buyDate: isoMinusDays(TODAY, i % 30) }),
        slPlanned: i % 3 === 0 ? null : short ? price * 1.05 : price * 0.95,
        closingPrice: i % 13 === 0 ? null : price + ((i % 5) - 2) * 1.5,
      }),
    );
  }
  // A second open trade in one scrip (two accounts under the aggregate view).
  rows.push(tradeRow({ id: 2000, accountId: 2, symbol: "TCS", tradingsymbol: "TCS", isOpen: true, buyQty: 4, avgBuyPrice: 3000, buyValue: 12_000, buyDate: isoMinusDays(TODAY, 2), closingPrice: 3010 }));
  t.db.insert(t.schema.trades).values(rows).run();

  t.db
    .insert(t.schema.corporateActions)
    .values([
      { symbol: " tcs ", type: "bonus", exDate: isoMinusDays(TODAY, 4), fromUnits: 1, toUnits: 1 },
      { symbol: "TCS", type: "split", exDate: isoMinusDays(TODAY, -20), fromUnits: 1, toUnits: 5 },
      { symbol: "TCS", type: "split", exDate: isoMinusDays(TODAY, 4), fromUnits: 2, toUnits: 1 },
      { symbol: "TCS", type: "bonus", exDate: isoMinusDays(TODAY, 4), fromUnits: 3, toUnits: 1 },
      { symbol: "TCS", type: "split", exDate: isoMinusDays(TODAY, 31), fromUnits: 1, toUnits: 2 },
      { symbol: "TCS", type: "dividend", exDate: isoMinusDays(TODAY, -5), dividendPerShare: 10 },
      { symbol: "infy", type: "bonus", exDate: isoMinusDays(TODAY, 30), fromUnits: 1, toUnits: 1 },
      { symbol: "INFY", type: "bonus", exDate: isoMinusDays(TODAY, -3), fromUnits: null, toUnits: 2 },
      { symbol: "ZZ010", type: "split", exDate: isoMinusDays(TODAY, -9), fromUnits: 10, toUnits: 1 },
      { symbol: "zz010", type: "bonus", exDate: isoMinusDays(TODAY, -9), fromUnits: 1, toUnits: 2 },
      { symbol: "NOTHELD", type: "split", exDate: isoMinusDays(TODAY, -1), fromUnits: 1, toUnits: 2 },
    ])
    .run();

  // Through JSON, as the RSC wire carries it.
  pro = JSON.parse(JSON.stringify(await live.loadLiveDesk({ pro: true }))) as LiveDeskData;
  free = JSON.parse(JSON.stringify(await live.loadLiveDesk({ pro: false }))) as LiveDeskData;
}, 120_000);

afterAll(() => t?.cleanup());

// ─── B — the loader's output is what the per-row / two-read path produced ─────

describe("the desk loader after its diet (output-neutral)", () => {
  it("every row's corpActions is the per-row scan's answer — same chips, same order", () => {
    const actions = corpQ.getCorporateActions();
    expect(pro.rows).toHaveLength(BOOK + 1);
    for (const data of [pro, free]) {
      for (const r of data.rows) {
        expect(r.corpActions, `row ${r.id} ${r.symbol}`).toEqual(corpActionsFor(actions, r.symbol, TODAY));
      }
    }
    // Not vacuous: the fixture's chips reached the wire, on BOTH rows of the shared scrip.
    const tcs = pro.rows.filter((r) => r.symbol === "TCS");
    expect(tcs).toHaveLength(2);
    expect(tcs.map((r) => r.corpActions.length)).toEqual([4, 4]);
    expect(pro.rows.find((r) => r.symbol === "INFY")?.corpActions).toHaveLength(1);
    expect(pro.rows.find((r) => r.symbol === "ZZ010")?.corpActions).toHaveLength(2);
    expect(pro.rows.filter((r) => r.corpActions.length > 0)).toHaveLength(4);
  });

  it("every row's sector / tier / industry / class source is the two public functions' answer", () => {
    const sectors = instrumentsQ.getSectorResolution();
    const classes = instrumentsQ.getClassificationResolution();
    for (const r of pro.rows) {
      const s = sectors.get(r.symbol.toUpperCase()) ?? null;
      const c = classes.get(r.symbol.toUpperCase()) ?? null;
      expect(
        { sector: r.sector, tier: r.sectorTier, industry: r.industry, sectorName: r.sectorName, source: r.classSource },
        `row ${r.id} ${r.symbol}`,
      ).toEqual({ sector: s?.sector ?? null, tier: s?.tier ?? null, industry: c?.industry ?? null, sectorName: c?.sector ?? null, source: c?.source ?? null });
    }
    // Not vacuous: a taxonomy row with an industry, a user tag that falls up, and unclassified rows.
    const byS = (sym: string) => pro.rows.find((r) => r.symbol === sym)!;
    expect(byS("TCS").industry).not.toBeNull();
    expect(byS("ZZ040")).toMatchObject({ classSource: "taxonomy", sectorTier: "high" });
    expect(byS("ZZ030")).toMatchObject({ sector: "My Own Bucket", sectorTier: "user", industry: null, sectorName: "My Own Bucket", classSource: "user" });
    expect(byS("ZZ050")).toMatchObject({ sector: null, industry: null, classSource: null });
  });

  it("getSectorAndClassificationResolution is both public maps — same keys, same values, same ORDER", () => {
    const both = instrumentsQ.getSectorAndClassificationResolution();
    const sectors = instrumentsQ.getSectorResolution();
    const classes = instrumentsQ.getClassificationResolution();
    expect(sectors.size).toBeGreaterThan(1000);
    expect(classes.size).toBe(sectors.size);
    expect([...both.sectors.entries()]).toEqual([...sectors.entries()]);
    expect([...both.classes.entries()]).toEqual([...classes.entries()]);
  });

  it("…from ONE read of `instruments` where the two calls made two", () => {
    const spy = vi.spyOn(t.db, "select");
    try {
      instrumentsQ.getSectorAndClassificationResolution();
      expect(spy, "the shared read went back to the table more than once").toHaveBeenCalledTimes(1);
      spy.mockClear();
      instrumentsQ.getSectorResolution();
      instrumentsQ.getClassificationResolution();
      expect(spy, "the counter cannot see a second read — the assertion above proves nothing").toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── A1 / A2 — what the tab renders ───────────────────────────────────────────

const h = React.createElement;

function txt(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function renderTab(data: LiveDeskData, isPro: boolean, rows: readonly DeskRow[], opts: { accountFilter?: number | null; query?: string } = {}): string {
  stored.map.clear();
  return server.renderToStaticMarkup(
    h(tabMod.PositionsTab, {
      rows, accountFilter: opts.accountFilter ?? null, query: opts.query ?? "", data, pro: isPro,
      linkLabel: null, now: null, onOpenChart: () => {}, onLab: () => {},
    }),
  );
}

/** `data-trade-id` of every ledger row, in document order. */
const ledgerIds = (html: string): number[] => [...html.matchAll(/<tr data-pos-index="\d+" data-trade-id="(\d+)"/g)].map((m) => Number(m[1]));
const ledgerIndexes = (html: string): number[] => [...html.matchAll(/<tr data-pos-index="(\d+)"/g)].map((m) => Number(m[1]));
const tfoot = (html: string): string => txt(html.slice(html.indexOf("<tfoot"), html.indexOf("</tfoot>")));
const NOTE = /Showing (\d+) of (\d+) /;

describe("the Positions ledger renders a window of the largest positions", () => {
  it(`a ${BOOK + 1}-row book renders ${WINDOW_STEP} rows — the first ${WINDOW_STEP} of the deployed-₹ order — and says so`, () => {
    const html = renderTab(pro, true, pro.rows);
    const order = tabMod.positionsOrder(pro.rows, { accountFilter: null, query: "" });
    expect(order).toHaveLength(BOOK + 1);

    expect(ledgerIds(html), "the rows are not the head of the deployed-₹ order").toEqual(order.slice(0, WINDOW_STEP).map((r) => r.id));
    expect(ledgerIndexes(html)).toEqual(Array.from({ length: WINDOW_STEP }, (_, i) => i));
    // Largest first: nothing held back is larger than anything shown.
    const smallestShown = order[WINDOW_STEP - 1].investedP;
    expect(order.slice(WINDOW_STEP).every((r) => r.investedP <= smallestShown)).toBe(true);
    for (const r of order.slice(WINDOW_STEP)) expect(html, `row ${r.id} is past the window`).not.toContain(`data-trade-id="${r.id}"`);

    const text = txt(html);
    expect(text).toContain(`Showing ${WINDOW_STEP} of ${BOOK + 1} ${tabMod.WINDOW_NOUN}.`);
    expect(text).toContain(`Show ${BOOK + 1 - WINDOW_STEP} more`);
    // The note sits in the Positions region, after the table — not inside it.
    const region = html.slice(html.indexOf('aria-label="Positions"'));
    expect(region.indexOf("Showing ")).toBeGreaterThan(region.indexOf("</table>"));
  });

  it("every total still reads the FULL filtered book, not the window", () => {
    const html = renderTab(pro, true, pro.rows);
    const text = txt(html);
    const order = tabMod.positionsOrder(pro.rows, { accountFilter: null, query: "" });
    const head = order.slice(0, WINDOW_STEP);
    const all = headerTotals(order, pro.heat);
    const win = headerTotals(head, pro.heat);
    const qtyAll = order.reduce((s, r) => s + r.qty, 0);
    const qtyWin = head.reduce((s, r) => s + r.qty, 0);
    // The fixture separates the two readings of every figure asserted below.
    expect(fmt.money(all.deployedP)).not.toBe(fmt.money(win.deployedP));
    expect(fmt.signedMoney(all.unrealisedP)).not.toBe(fmt.signedMoney(win.unrealisedP));
    expect(fmt.qty(qtyAll)).not.toBe(fmt.qty(qtyWin));
    expect(all.unmarked).toBeGreaterThan(win.unmarked);

    // Header bars.
    expect(text).toContain(fmt.money(all.deployedP));
    expect(text).not.toContain(fmt.money(win.deployedP));
    expect(text).toContain(copy.POSITIONS_COPY.unmarked(all.unmarked));
    // The <tfoot> Book row: the count, Σ qty and Σ unrealised of the whole book.
    const foot = tfoot(html);
    expect(foot).toContain(copy.POSITIONS_COPY.book(BOOK + 1));
    expect(foot).toContain(fmt.qty(qtyAll));
    expect(foot).not.toContain(fmt.qty(qtyWin));
    expect(foot).toContain(fmt.signedMoney(all.unrealisedP));
    // The footer's no-stop list names a row the window holds back.
    const hiddenNoStop = order.slice(WINDOW_STEP).find((r) => r.effectiveStopP === null);
    expect(hiddenNoStop, "the fixture has no un-stopped row past the window").toBeDefined();
    expect(text).toContain(hiddenNoStop!.symbol);
    // Cohort concentration counts every row.
    expect(text).toContain(copy.POSITIONS_COPY.cohortCaveat(order.filter((r) => r.industry || r.sectorName).length, BOOK + 1));
  });

  it("the free wire gets the same window and the same note", () => {
    const html = renderTab(free, false, free.rows);
    expect(ledgerIndexes(html)).toHaveLength(WINDOW_STEP);
    expect(txt(html)).toContain(`Showing ${WINDOW_STEP} of ${BOOK + 1} ${tabMod.WINDOW_NOUN}.`);
  });

  it(`a book of exactly ${WINDOW_STEP} rows, or fewer, has every row and no note or control`, () => {
    for (const n of [WINDOW_STEP, 3, 0]) {
      const html = renderTab(pro, true, pro.rows.slice(0, n));
      expect(ledgerIndexes(html), `${n}-row book`).toHaveLength(n);
      expect(txt(html), `${n}-row book`).not.toMatch(NOTE);
      expect(html, `${n}-row book`).not.toMatch(/Show \d+ more/);
    }
  });

  it("a filter that brings the book inside one step drops the note; the count is the FILTERED book's", () => {
    const filtered = renderTab(pro, true, pro.rows, { accountFilter: 2 });
    const n = pro.rows.filter((r) => r.accountId === 2).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(WINDOW_STEP);
    expect(ledgerIndexes(filtered)).toHaveLength(n);
    expect(txt(filtered)).not.toMatch(NOTE);

    const wide = renderTab(pro, true, pro.rows, { query: "ZZ" });
    const m = pro.rows.filter((r) => r.symbol.includes("ZZ")).length;
    expect(m).toBeGreaterThan(WINDOW_STEP);
    expect(m).toBeLessThan(BOOK + 1);
    expect(txt(wide)).toContain(`Showing ${WINDOW_STEP} of ${m} `);
  });
});

// ─── A3 — j / k over the book ─────────────────────────────────────────────────

describe("nextFocusIndex — j / k move over the BOOK, the window is only what is rendered", () => {
  const TOTAL = 3460;
  const SHOWN = 150;

  it("j on the last shown row lands on the first hidden one — never a dead key", () => {
    expect(tabMod.nextFocusIndex(SHOWN - 1, SHOWN, TOTAL, true)).toBe(SHOWN);
    // …and the window that render derives holds it.
    expect(windowLimit(SHOWN, TOTAL, SHOWN, WINDOW_STEP)).toBeGreaterThan(SHOWN);
  });

  it("inside the window it is desk-keys' nextIndex over the book, unchanged", () => {
    for (const [cur, down] of [[0, true], [0, false], [7, true], [7, false], [-1, true]] as const) {
      expect(tabMod.nextFocusIndex(cur, SHOWN, TOTAL, down)).toBe(nextIndex(cur, TOTAL, down ? 1 : -1));
    }
  });

  it("clamps at the book's last row, not the window's", () => {
    expect(tabMod.nextFocusIndex(TOTAL - 1, TOTAL, TOTAL, true)).toBe(TOTAL - 1);
    expect(tabMod.nextFocusIndex(TOTAL - 2, 150, TOTAL, true)).toBe(TOTAL - 1);
  });

  it("k with nothing focused is the last row SHOWN — one stray key does not mount the book", () => {
    expect(tabMod.nextFocusIndex(-1, SHOWN, TOTAL, false)).toBe(SHOWN - 1);
    // A book inside one step: the last shown row IS the last row, as before the window.
    expect(tabMod.nextFocusIndex(-1, 40, 40, false)).toBe(nextIndex(-1, 40, -1));
  });

  it("an empty book has nothing to focus", () => {
    expect(tabMod.nextFocusIndex(-1, 0, 0, true)).toBe(-1);
    expect(tabMod.nextFocusIndex(-1, 0, 0, false)).toBe(-1);
  });
});

// ─── A4 — the row is memoised ─────────────────────────────────────────────────

describe("PositionRow is memoised, with React's own shallow comparison", () => {
  it("is a React.memo component with no custom comparator", () => {
    const row = tabMod.PositionRow as unknown as { $$typeof: symbol; compare: unknown; type: unknown };
    expect(row.$$typeof).toBe(Symbol.for("react.memo"));
    // A custom comparator is where a "skip this row" bug hides a stale mark; the default
    // compares every prop by identity, and `applyTicks` gives a ticked row a new identity.
    expect(row.compare).toBeNull();
    expect(typeof row.type).toBe("function");
  });
});
