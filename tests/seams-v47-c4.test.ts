import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as React from "react";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { todayIstIso } from "@/lib/domain/trading-day";
import { isoMinusDays } from "@/lib/live/positions-view";
import type { DeskRow, LiveDeskData } from "@/components/live/desk-types";
import type { RiskEditDialogProps } from "@/components/risk/risk-edit-dialog";

/**
 * v4.7.0 wave C4 — SEAM PASS over the A → B wire of the `/live` Positions tab.
 *
 * Builder A owns the wire (`components/live/load-desk.ts`, `desk-types.ts`, the pure
 * `lib/live/positions-view.ts`, `components/risk/risk-edit-dialog.tsx`, the risk route,
 * `lib/domain/trades-query.ts`, `app/trades/page.tsx`). Builder B owns what renders it
 * (`components/live/positions-tab.tsx`, `position-card.tsx`, `position-calculator.tsx`).
 * Every case below seeds ONE real temp database, runs A's real `loadLiveDesk`, and hands
 * the payload to B's real components (server-rendered, or — where the value only leaves
 * through a closure — by calling the component inside a harness render and reading the
 * element it builds). Nothing on either side is mocked: `next/cache`, the router, the
 * localStorage hook and `fetch` → route-handler are transport/framework only.
 *
 * | # | crossing value                         | producer (A)                         | consumer (B)                          | unit                   | test |
 * |---|----------------------------------------|--------------------------------------|---------------------------------------|------------------------|------|
 * | 1 | slPlannedP / trailingSlP / targetP     | load-desk.ts:333-335, :481-482       | position-card.tsx:352-365 → risk-edit-dialog.tsx:70-76 → route.ts:36,82-84 | paise → rupee string → REAL | S1 * |
 * | 2 | planned vs trailing, each in its key   | load-desk.ts:481-482                 | position-card.tsx:358-359             | paise                  | S2 |
 * | 3 | pctOfCapital.denominator (bucket)      | tracker-row.ts:297 via load-desk:375 | position-card.tsx:107, positions-tab.tsx:553,655 | paise          | S3 |
 * | 3 | heat.capitalP (total) → headerTotals   | load-desk.ts:498, positions-view:291 | positions-tab.tsx:143,218             | paise / ppm            | S3 |
 * | 3 | pctOfCapital.ppm under "Size"          | tracker-row.ts:297 (RISK / capital)  | positions-tab.tsx:365,630 (was :603)  | ppm                    | S3 (it.fails flipped by the C4 fix builder, F-52) |
 * | 3 | free wire: capitalP / sizing / pctOfCapital null | load-desk.ts:411,474,551   | positions-tab / card locks            | —                      | S3 |
 * | 4 | sizing {capitalP, riskPpm} + markP + effective stop | load-desk.ts:474         | position-calculator.tsx:83-104        | paise / ppm            | S4 |
 * | 4 | sizing null + riskNotSet true (risk % unset) | load-desk.ts:474,541           | position-calculator.tsx:83-86         | —                      | S4 |
 * | 5 | industry / sectorName → cohort         | load-desk.ts:456-457                 | positions-tab.tsx:146 (over `order`)  | paise share ppm        | S5 |
 * | 6 | partial {bookedPpm, closedQty, realisedGrossP} | load-desk.ts:461-469        | positions-tab.tsx:143,321,597; card:244-249 | ppm / paise      | S6 |
 * | 7 | row.id → `/trades?trade=<id>`          | TrackerRow.id                        | position-card.tsx:335 → trades-query.ts parseTradeId → page.tsx:128-138 | string → int | S7 |
 * | 8 | riskAtStopP → riskLensSummary heat share → card | load-desk.ts / positions-view:583 | positions-tab.tsx:145-147,439; card:239-240 | ppm        | S8 (it.fails flipped by the C4 fix builder, F-52) |
 * | 8 | prevCloseP / markP / holdingDays → sinceClose | load-desk.ts:471                 | positions-tab.tsx:790,859-871         | paise                  | S8 |
 * | 9 | every C4 field through applyTicks      | apply-ticks.ts:165-179 (spread)      | tracker-client.tsx:580 → PositionsTab | paise                  | S9 |
 *
 * RECORDED DEFECTS — all three FIXED in the C4 fix wave and flipped to `it`:
 *  - "C4 seam: sub-paisa stop rounded on untouched save" (S1) — fix 3
 *  - "C4 seam: Size column prints risk-at-stop % of capital, not deployed %" (S3) — fix 1
 *  - "C4 seam: filtered heat share printed against the whole book's open risk" (S8) — fix 2
 *
 * ONE temp database for the file (AGENTS.md Testing). Every module reaching `lib/db` is
 * imported dynamically after `openTempDb`.
 */

const cache = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => {
    cache.paths.push(p);
  },
  revalidateTag: () => {},
  unstable_cache: (fn: unknown) => fn,
}));

const router = vi.hoisted(() => ({ refreshes: 0 }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({
    refresh: () => {
      router.refreshes += 1;
    },
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
}));

// localStorage plumbing only: on the server `useStoredValue` always returns the default
// (null), which would keep the Risk lens collapsed and the cohort at Industry. The map
// stands in for what a user's browser stored; the tab's own envelope parsing still runs.
const stored = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock("@/components/layout/use-stored-value", () => ({
  useStoredValue: (k: string) => stored.map.get(k) ?? null,
  writeStored: () => {},
}));

let t: TempDb;
let live: typeof import("@/components/live/load-desk");
let riskRoute: typeof import("@/app/api/positions/risk/route");
let tradesPage: (props: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
let server: typeof import("react-dom/server");
let ui: typeof import("@/components/ui/dialog");
let tabMod: typeof import("@/components/live/positions-tab");
let cardMod: typeof import("@/components/live/position-card");
let editMod: typeof import("@/components/risk/risk-edit-dialog");
let view: typeof import("@/lib/live/positions-view");
let sizing: typeof import("@/lib/risk/sizing");
let fmt: typeof import("@/components/live/desk-format");
let copy: typeof import("@/components/live/desk-copy");

const PRIMARY = 1;
const SWING = 2;
const TODAY = todayIstIso();
const EQUITY_CAPITAL = 1_234_567.89; // rupees → 123_456_789 paise
const ACTIVE_CAPITAL = 400_000; // rupees → 40_000_000 paise

let proAll: LiveDeskData;
let freeAll: LiveDeskData;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

const rowOf = (d: LiveDeskData, id: number): DeskRow => {
  const r = d.rows.find((x) => x.id === id);
  if (!r) throw new Error(`row ${id} missing from the desk`);
  return r;
};

// Measured locally 2026-10-04: migrate + seed + the dynamic imports (app/trades/page's
// client graph is the bulk, ~4 s — tests/live-positions-wire.test.ts records the same)
// + two desk loads ≈ 5–6 s. Above the 3 s hook budget because /trades must be imported
// for S7; 120 s is for the Windows CI runner (> 15× slower on SQLite-file work).
beforeAll(async () => {
  t = await openTempDb("seams-v47-c4", { seed: true });
  live = await import("@/components/live/load-desk");
  riskRoute = await import("@/app/api/positions/risk/route");
  tradesPage = (await import("@/app/trades/page")).default as typeof tradesPage;
  server = await import("react-dom/server");
  ui = await import("@/components/ui/dialog");
  tabMod = await import("@/components/live/positions-tab");
  cardMod = await import("@/components/live/position-card");
  editMod = await import("@/components/risk/risk-edit-dialog");
  view = await import("@/lib/live/positions-view");
  sizing = await import("@/lib/risk/sizing");
  fmt = await import("@/components/live/desk-format");
  copy = await import("@/components/live/desk-copy");

  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();
  t.db.update(t.schema.settings).set({ equityCapital: EQUITY_CAPITAL, activeCapital: ACTIVE_CAPITAL, selectedAccountId: 0 }).run();
  t.db.update(t.schema.riskConfig).set({ riskPctPpm: 7_500, stopAtrMultPermille: 2000 }).run();
  // A user's own sector tag — sector-level only, so it FALLS UP at Industry view (D4).
  t.db.insert(t.schema.instruments).values({ symbol: "ZZTAG", sector: "My Own Bucket" }).run();

  t.db
    .insert(t.schema.trades)
    .values([
      // LONG, partially booked: bought 10 @ 3000, sold 4 @ 3200. Planned 2800 AND trailing 2900.
      tradeRow({
        id: 301, accountId: PRIMARY, symbol: "TCS", tradingsymbol: "TCS", isin: "INE467B01029", isOpen: true,
        buyQty: 10, avgBuyPrice: 3000, buyValue: 30_000, sellQty: 4, avgSellPrice: 3200, sellValue: 12_800,
        buyDate: isoMinusDays(TODAY, 20), sellDate: isoMinusDays(TODAY, 5),
        slPlanned: 2800, trailingSl: 2900, targetPlanned: 3400,
      }),
      // SHORT, partially covered: sold 100 @ 500, bought back 40 @ 450. Planned stop ABOVE entry.
      tradeRow({
        id: 302, accountId: SWING, symbol: "ZZTAG", tradingsymbol: "ZZTAG", isOpen: true, segment: "eq_intraday",
        sellQty: 100, avgSellPrice: 500, sellValue: 50_000, buyQty: 40, avgBuyPrice: 450, buyValue: 18_000,
        sellDate: isoMinusDays(TODAY, 3), buyDate: isoMinusDays(TODAY, 2), slPlanned: 600,
      }),
      // ACTIVE bucket, unclassified, with SUB-PAISA stored levels (prices stay REAL — invariant 1).
      tradeRow({
        id: 303, accountId: PRIMARY, symbol: "ZZNONE", tradingsymbol: "ZZNONE", isOpen: true, bucket: "active",
        buyQty: 50, avgBuyPrice: 1500, buyValue: 75_000, buyDate: isoMinusDays(TODAY, 10),
        slPlanned: 1450.125, trailingSl: 1475.555, targetPlanned: 1600.005,
      }),
    ])
    .run();

  t.db
    .insert(t.schema.priceHistory)
    .values([
      { symbol: "TCS", date: isoMinusDays(TODAY, 2), open: 3000, high: 3100, low: 2990, close: 3050, volume: 1 },
      { symbol: "TCS", date: isoMinusDays(TODAY, 1), open: 3050, high: 3120, low: 3040, close: 3080, volume: 1 },
      { symbol: "TCS", date: TODAY, open: 3080, high: 3150, low: 3070, close: 3120, volume: 1 },
      { symbol: "ZZTAG", date: isoMinusDays(TODAY, 1), open: 480, high: 490, low: 470, close: 480, volume: 1 },
      { symbol: "ZZTAG", date: TODAY, open: 480, high: 490, low: 470, close: 470, volume: 1 },
      { symbol: "ZZNONE", date: isoMinusDays(TODAY, 1), open: 1500, high: 1560, low: 1490, close: 1550, volume: 1 },
      { symbol: "ZZNONE", date: TODAY, open: 1550, high: 1590, low: 1540, close: 1580, volume: 1 },
    ])
    .run();

  selectAccount(0);
  proAll = await live.loadLiveDesk({ pro: true });
  freeAll = await live.loadLiveDesk({ pro: false });
  // Warm /trades once (its first render pays one-off module/statement work).
  await tradesPage({ searchParams: Promise.resolve({}) });
}, 120_000);

afterAll(() => t?.cleanup());

// ─── rendering helpers ────────────────────────────────────────────────────────

const h = React.createElement;

/** Visible text of server markup: tags dropped, the entities React emits decoded. */
function txt(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function renderTab(
  data: LiveDeskData,
  pro: boolean,
  opts: { accountFilter?: number | null; query?: string; lensOpen?: boolean; cohort?: "industry" | "sector" } = {},
): string {
  stored.map.clear();
  if (opts.lensOpen) stored.map.set(tabMod.LENS_KEY, JSON.stringify({ v: 1, open: true }));
  if (opts.cohort) stored.map.set(tabMod.COHORT_KEY, JSON.stringify({ v: 1, level: opts.cohort }));
  return server.renderToStaticMarkup(
    h(tabMod.PositionsTab, {
      rows: data.rows,
      accountFilter: opts.accountFilter ?? null,
      query: opts.query ?? "",
      data,
      pro,
      linkLabel: null,
      now: null,
      onOpenChart: () => {},
      onLab: () => {},
    }),
  );
}

/** The `<td>` texts of one ledger row (`tr[data-trade-id]`). */
function rowCells(html: string, id: number): string[] {
  const start = html.indexOf(`data-trade-id="${id}"`);
  if (start < 0) throw new Error(`ledger row ${id} not rendered`);
  const tr = html.slice(start, html.indexOf("</tr>", start));
  return tr.split("<td").slice(1).map((c) => txt(`<td${c}`));
}

/**
 * `heatShareOfP` is the Σ open risk the share is OF (C4 fix 2 — the tab passes its lens's
 * `openRiskP`). The default is the whole book's, which is what an UNFILTERED lens's Σ is.
 */
function cardProps(row: DeskRow, data: LiveDeskData, pro: boolean, heatSharePpm: number | null, heatShareOfP = data.heat?.openRiskP ?? null) {
  return { row, data, pro, heatSharePpm, heatShareOfP, editOpen: false, onEditOpenChange: () => {}, onOpenChart: () => {}, onLab: () => {} };
}

/** B's card, server-rendered inside a Dialog root (its title/description need the context). */
function renderCard(row: DeskRow, data: LiveDeskData, pro: boolean, heatSharePpm: number | null = null, heatShareOfP?: number | null): string {
  return server.renderToStaticMarkup(h(ui.Dialog, { open: false }, h(cardMod.PositionCard, cardProps(row, data, pro, heatSharePpm, heatShareOfP))));
}

type El = { type: unknown; props: Record<string, unknown> };
function findEl(node: unknown, match: (e: El) => boolean): El | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findEl(n, match);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const el = node as El;
  if (match(el)) return el;
  return findEl(el.props.children, match);
}

/**
 * The props B's card hands the Edit-levels dialog. The card is CALLED inside a harness
 * render (so its one hook, `useRouter`, runs in a render) and the `RiskEditDialog`
 * element it builds is read — the nested Dialog's portal renders nothing on the server.
 */
function editPropsFromCard(row: DeskRow, data: LiveDeskData): RiskEditDialogProps {
  let captured: RiskEditDialogProps | undefined;
  function Harness() {
    const tree = cardMod.PositionCard({ ...cardProps(row, data, true, null), editOpen: true });
    captured = findEl(tree, (e) => e.type === editMod.RiskEditDialog)?.props as RiskEditDialogProps | undefined;
    return null;
  }
  server.renderToStaticMarkup(h(Harness));
  if (!captured) throw new Error(`the card for row ${row.id} built no RiskEditDialog`);
  return captured;
}

/**
 * Open A's real dialog with those props and press Save WITHOUT touching a field. The
 * dialog is called inside a harness render to reach its `save` closure (the Save
 * button's onClick); `fetch` is routed to the REAL route handler on the temp DB.
 */
async function untouchedSave(props: RiskEditDialogProps): Promise<{ html: string; body: Record<string, unknown>; ok: boolean; posted: boolean }> {
  let save: (() => Promise<void>) | undefined;
  function Harness() {
    const tree = editMod.RiskEditDialog(props);
    save = findEl(tree, (e) => e.props.children === "Save" && typeof e.props.onClick === "function")?.props.onClick as typeof save;
    return tree;
  }
  const html = server.renderToStaticMarkup(h(ui.Dialog, { open: false }, h(Harness)));
  if (!save) throw new Error("Save button not found");
  let body: Record<string, unknown> = {};
  let ok = false;
  let posted = false;
  vi.stubGlobal("window", new EventTarget()); // the toaster's event bus
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    posted = true;
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const res = await riskRoute.POST(new Request(`http://localhost${url}`, init));
    ok = res.ok;
    return res;
  });
  try {
    await save();
  } finally {
    vi.unstubAllGlobals();
  }
  return { html, body, ok, posted };
}

const storedLevels = (id: number) => {
  const r = t.db.select().from(t.schema.trades).all().find((x) => x.id === id)!;
  return { slPlanned: r.slPlanned, trailingSl: r.trailingSl, targetPlanned: r.targetPlanned };
};

const ppmFloor = (n: number, d: number) => Math.floor((n * 1_000_000) / d);
const ppmTrunc = (n: number, d: number) => Math.trunc((n * 1_000_000) / d);

// ─── S3 — two capital denominators, and the free wire ────────────────────────

describe("S3 — header bars on TOTAL capital, rows on BUCKET capital; free wire carries neither", () => {
  it("Pro header: deployed % = Σ investedP / heat.capitalP (total), never a bucket", () => {
    const total = proAll.heat!.capitalP!;
    expect(total, "total = equity + active capital").toBe(123_456_789 + 40_000_000);
    const deployed = proAll.rows.reduce((s, r) => s + r.investedP, 0);
    const html = renderTab(proAll, true);
    const shown = fmt.pct(ppmFloor(deployed, total));
    const onEquityBucket = fmt.pct(ppmFloor(deployed, 123_456_789));
    expect(shown).not.toBe(onEquityBucket);
    // The deployed bar's big figure, and the ledger footer's Size total.
    expect(txt(html)).toContain(`${shown} ${fmt.money(deployed)}`);
    expect(txt(html)).not.toContain(`${onEquityBucket} ${fmt.money(deployed)}`);
  });

  it("Pro rows: on-capital P&L uses row.pctOfCapital.denominator — the ACTIVE bucket for an active row", () => {
    const active = rowOf(proAll, 303);
    expect(active.bucket).toBe("active");
    expect(active.pctOfCapital.denominator).toBe(40_000_000);
    const html = renderTab(proAll, true);
    const cell = rowCells(html, 303)[6];
    const onBucket = fmt.signedPct(ppmTrunc(active.unrealisedP!, 40_000_000));
    const onTotal = fmt.signedPct(ppmTrunc(active.unrealisedP!, proAll.heat!.capitalP!));
    expect(onBucket).not.toBe(onTotal);
    expect(cell).toBe(onBucket);
    // The card says the same thing for the same row.
    expect(txt(renderCard(active, proAll, true))).toContain(`${onBucket} on capital`);
  });

  // RECORDED DEFECT — "C4 seam: Size column prints risk-at-stop % of capital, not deployed %".
  // A ships `pctOfCapital = riskAtStopP / bucket capital` (lib/live/tracker-row.ts:297, documented
  // in lib/live/types.ts:197). B prints it under the "Size" column (positions-tab.tsx:603), whose
  // header comment says "Size (% of capital)" and whose FOOTER cell prints Σ deployed / capital
  // (positions-tab.tsx:389). TCS: deployed ₹18,000 of a ₹12,34,568 bucket = 1.46%, risk ₹600 =
  // 0.05% — the row prints the 0.05% (red on HEAD: expected '0.05%' to be '1.46%').
  // FIXED in the C4 fix wave (fix 1): the row prints investedP / its bucket capital; the
  // Book row keeps Σ deployed / TOTAL capital and says so.
  it("Size column: a row prints its DEPLOYED rupees over its bucket capital (C4 seam: Size column prints risk-at-stop % of capital, not deployed %)", () => {
    const tcs = rowOf(proAll, 301);
    const html = renderTab(proAll, true);
    expect(rowCells(html, 301)[3]).toBe(fmt.pct(ppmFloor(tcs.investedP, tcs.pctOfCapital.denominator!)));
    const total = proAll.heat!.capitalP!;
    const deployed = proAll.rows.reduce((s, r) => s + r.investedP, 0);
    const foot = html.slice(html.indexOf("<tfoot"), html.indexOf("</tfoot>"));
    expect(txt(foot)).toContain(`${fmt.pct(ppmFloor(deployed, total))} ${tabMod.SCOPE_COPY.sizeOfTotal}`);
  });

  it("FREE wire: positions.capitalP, every sizing and every pctOfCapital are null — and the tab prints no capital %", () => {
    expect(freeAll.positions.capitalP).toBeNull();
    expect(freeAll.heat).toBeNull();
    for (const r of freeAll.rows) {
      expect(r.sizing, `row ${r.id}`).toBeNull();
      expect(r.pctOfCapital, `row ${r.id}`).toEqual({ ppm: null, denominator: null });
    }
    const deployed = freeAll.rows.reduce((s, r) => s + r.investedP, 0);
    const html = renderTab(freeAll, false);
    // Deployed is free as rupees; the % the Pro header would print is absent.
    expect(txt(html)).toContain(fmt.money(deployed));
    expect(txt(html)).not.toContain(fmt.pct(ppmFloor(deployed, 163_456_789)));
    for (const r of freeAll.rows) {
      const cells = rowCells(html, r.id);
      expect(cells[3], `row ${r.id} Size`).not.toMatch(/\d%/);
      expect(cells[6], `row ${r.id} on capital`).not.toMatch(/\d%/);
    }
    // The free card: no on-capital % either.
    expect(txt(renderCard(rowOf(freeAll, 303), freeAll, false))).not.toMatch(/\d\.\d\d% on capital/);
  });
});

// ─── S4 — the inline calculator's defaults ───────────────────────────────────

describe("S4 — calculator: bucket capital + risk % from the wire, entry = mark, stop = effective stop", () => {
  it("Pro: the card's Qty is sizeFixedFractional over the row's sizing, mark and effective stop", () => {
    for (const id of [301, 302, 303]) {
      const r = rowOf(proAll, id);
      expect(r.sizing, `row ${id}`).toEqual({ capitalP: r.pctOfCapital.denominator, riskPpm: 7_500 });
      expect(r.sizing!.capitalP, `row ${id}: the bucket, not the total`).not.toBe(proAll.heat!.capitalP);
      const res = sizing.sizeFixedFractional({
        capitalP: r.sizing!.capitalP,
        riskPpm: r.sizing!.riskPpm,
        entryP: r.markP!,
        stopP: r.effectiveStopP!,
        lotSize: r.lotSize ?? 1,
        atrP3: r.atrP3,
      });
      const html = renderCard(r, proAll, true);
      const m = html.match(/data-testid="calc-qty"[^>]*>([^<]*)</);
      if (res.ok) {
        expect(m?.[1], `row ${id}`).toBe(fmt.qty(res.qty));
        expect(res.qty, `row ${id}: a real size, not a refusal`).toBeGreaterThan(0);
      } else {
        expect(m, `row ${id}: a refusal prints no Qty`).toBeNull();
      }
    }
    // The short: stop ABOVE the mark must still size (a sign slip refuses it).
    const short = rowOf(proAll, 302);
    expect(short.side).toBe("short");
    expect(renderCard(short, proAll, true)).toMatch(/data-testid="calc-qty"[^>]*>[1-9]/);
  });

  it("risk % unset: sizing null on EVERY row AND riskNotSet true; the calculator prints no Qty", async () => {
    t.db.update(t.schema.riskConfig).set({ riskPctPpm: null }).run();
    try {
      selectAccount(0);
      const d = await live.loadLiveDesk({ pro: true });
      expect(d.riskNotSet).toBe(true);
      for (const r of d.rows) expect(r.sizing, `row ${r.id}`).toBeNull();
      // Capital is still known (Pro) — "unset" is NOT "free".
      expect(d.positions.capitalP).toBe(163_456_789);
      expect(renderCard(rowOf(d, 301), d, true)).not.toContain('data-testid="calc-qty"');
    } finally {
      t.db.update(t.schema.riskConfig).set({ riskPctPpm: 7_500 }).run();
    }
  });
});

// ─── S5 — cohort concentration over the rows B passes ────────────────────────

/** The header cohort panel's `<li>` texts, in order. */
function cohortItems(html: string): string[] {
  const at = html.indexOf('data-testid="positions-cohort"');
  const panel = html.slice(at, html.indexOf("</ul>", at));
  return panel.split("<li").slice(1).map((li) => txt(`<li${li}`));
}

describe("S5 — cohort concentration: deployed rupees of the FILTERED rows, fall-up, Unclassified last", () => {
  it("account filter PRIMARY: only that account's cohorts, shares of its deployed, Unclassified last", () => {
    const primary = proAll.rows.filter((r) => r.accountId === PRIMARY);
    const deployed = primary.reduce((s, r) => s + r.investedP, 0);
    const tcs = rowOf(proAll, 301);
    const none = rowOf(proAll, 303);
    expect(tcs.industry).not.toBeNull();
    expect(none.industry).toBeNull();
    expect(none.sectorName).toBeNull();
    const items = cohortItems(renderTab(proAll, true, { accountFilter: PRIMARY }));
    // Unclassified holds MORE rupees (₹75,000 vs ₹18,000) and still sorts last.
    expect(none.investedP).toBeGreaterThan(tcs.investedP);
    expect(items).toEqual([
      `${tcs.industry} ${fmt.pct(ppmFloor(tcs.investedP, deployed))} (1)`,
      `${copy.POSITIONS_COPY.unclassified} ${fmt.pct(ppmFloor(none.investedP, deployed))} (1)`,
    ]);
    expect(items.join(" ")).not.toContain("My Own Bucket");
  });

  it("aggregate view: the user tag FALLS UP to its sector (labelled); shares sum to 100% of deployed", () => {
    const deployed = proAll.rows.reduce((s, r) => s + r.investedP, 0);
    const items = cohortItems(renderTab(proAll, true));
    const tag = rowOf(proAll, 302);
    expect(tag.classSource).toBe("user");
    expect(items).toContain(`My Own Bucket · ${copy.POSITIONS_COPY.cohortFellUp} ${fmt.pct(ppmFloor(tag.investedP, deployed))} (1)`);
    expect(items[items.length - 1].startsWith(copy.POSITIONS_COPY.unclassified)).toBe(true);
    const printed = items.map((s) => Number(/([\d.]+)% \(\d+\)$/.exec(s)![1]));
    // Each share floors to 0.01%, so the printed sum may fall short by < 0.01% per node.
    const sum = printed.reduce((s, x) => s + x, 0);
    expect(sum).toBeLessThanOrEqual(100);
    expect(sum).toBeGreaterThan(100 - 0.01 * items.length);
  });

  it("symbol filter narrows the cohort to that row: 100% in one node", () => {
    const tcs = rowOf(proAll, 301);
    expect(cohortItems(renderTab(proAll, true, { query: "tcs" }))).toEqual([`${tcs.industry} 100.00% (1)`]);
  });

  it("Sector view (stored): TCS rolls to its exchange sector, the tag to its own", () => {
    const tcs = rowOf(proAll, 301);
    const items = cohortItems(renderTab(proAll, true, { cohort: "sector" }));
    expect(items.some((s) => s.startsWith(`${tcs.sectorName} `))).toBe(true);
    expect(items.join(" ")).not.toContain(copy.POSITIONS_COPY.cohortFellUp);
  });
});

// ─── S6 — partial booking ────────────────────────────────────────────────────

describe("S6 — partial booking from the parent row, long and short, into the header and the row", () => {
  it("row.partial matches the hand arithmetic on both signs (never grossPnl)", () => {
    // Long: sold 4 of 10, (3200 − 3000) × 4 = ₹800. Short: covered 40 of 100, (500 − 450) × 40 = ₹2,000.
    expect(rowOf(proAll, 301).partial).toEqual({ bookedPpm: 400_000, closedQty: 4, realisedGrossP: 80_000 });
    expect(rowOf(proAll, 302).partial).toEqual({ bookedPpm: 400_000, closedQty: 40, realisedGrossP: 200_000 });
    expect(rowOf(proAll, 303).partial).toBeNull();
    // Free carries the same facts.
    expect(rowOf(freeAll, 302).partial).toEqual(rowOf(proAll, 302).partial);
  });

  it("header: '+x% realised on partials' = Σ realisedGrossP over Σ booked entry cost; rows print their own ₹", () => {
    const realised = 80_000 + 200_000;
    const bookedCost = 4 * 300_000 + 40 * 50_000; // closedQty × avgEntryP
    const line = copy.POSITIONS_COPY.realisedOnPartials(fmt.signedPct(ppmTrunc(realised, bookedCost)));
    expect(line.startsWith("+8.75%")).toBe(true);
    for (const pro of [true, false]) {
      const html = renderTab(pro ? proAll : freeAll, pro);
      expect(txt(html), pro ? "pro" : "free").toContain(line);
      expect(rowCells(html, 301)[0]).toContain(copy.POSITIONS_COPY.realisedBeforeCharges(fmt.signedMoney(80_000)));
      expect(rowCells(html, 302)[0]).toContain(copy.POSITIONS_COPY.realisedBeforeCharges(fmt.signedMoney(200_000)));
    }
    // Filtered to SWING, only the short's booking counts: 200000 / 2000000 = +10.00%.
    expect(txt(renderTab(proAll, true, { accountFilter: SWING }))).toContain(copy.POSITIONS_COPY.realisedOnPartials("+10.00%"));
  });
});

// ─── S7 — the trade deep link ────────────────────────────────────────────────

const clientOf = (tree: unknown) => {
  const el = findEl(tree, (e) => "initialRows" in e.props && "initialFilters" in e.props);
  if (!el) throw new Error("TradesClient not found in the /trades tree");
  return el.props as { initialOpenTrade: { id: number } | null };
};
const refusal = (tree: unknown) => findEl(tree, (e) => e.props["data-trade-link"] === "refused");

/** The href of B's "Trade record" action, as rendered. */
function tradeHref(html: string): string {
  const m = /<a [^>]*href="([^"]*)"[^>]*>Trade record<\/a>/.exec(html);
  if (!m) throw new Error("no Trade record link on the card");
  return m[1].replace(/&amp;/g, "&");
}

describe("S7 — `/trades?trade=<id>` from the card opens THAT trade, account-scoped", () => {
  it("SWING selected: the short's card link opens trade 302; PRIMARY selected: the same link is refused", async () => {
    selectAccount(SWING);
    try {
      const d = await live.loadLiveDesk({ pro: false }); // the link is free
      const short = rowOf(d, 302);
      const href = tradeHref(renderCard(short, d, false));
      const url = new URL(href, "http://localhost");
      expect(url.pathname).toBe("/trades");
      let tree = await tradesPage({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) });
      expect(clientOf(tree).initialOpenTrade?.id).toBe(302);
      expect(refusal(tree)).toBeUndefined();

      selectAccount(PRIMARY);
      tree = await tradesPage({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) });
      expect(clientOf(tree).initialOpenTrade, "a SWING trade opened under PRIMARY").toBeNull();
      expect(refusal(tree)).toBeDefined();
    } finally {
      selectAccount(0);
    }
  });

  it("aggregate view: every row's link opens its own trade", async () => {
    for (const r of proAll.rows) {
      const url = new URL(tradeHref(renderCard(r, proAll, true)), "http://localhost");
      const tree = await tradesPage({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) });
      expect(clientOf(tree).initialOpenTrade?.id, `row ${r.id}`).toBe(r.id);
    }
  });
});

// ─── S8 — heat share and since-close keyed by row.id ─────────────────────────

/** The Risk lens's ranked table: [symbol-cell, gives back, share, ATR away] per row, in order. */
function lensRanked(html: string): string[][] {
  const at = html.indexOf(copy.POSITIONS_COPY.lensRankTitle + "</th>");
  if (at < 0) throw new Error("the Risk lens ranked table did not render");
  const body = html.slice(html.indexOf("<tbody>", at), html.indexOf("</tbody>", at));
  return body
    .split("<tr")
    .slice(1)
    .map((tr) => tr.split("<td").slice(1).map((c) => txt(`<td${c}`)));
}

const givesBack = (r: DeskRow, priceP: number) =>
  Math.max(r.qty * (r.side === "short" ? r.effectiveStopP! - priceP : priceP - r.effectiveStopP!), 0);

describe("S8 — the lens rank, the card's heat share and the since-close paragraph agree per row.id", () => {
  it("aggregate: ranked by give-back from the mark; share = risk / Σ risk; the card prints the lens's share", () => {
    const html = renderTab(proAll, true, { lensOpen: true });
    const ranked = lensRanked(html);
    const riskSum = proAll.rows.reduce((s, r) => s + Math.max(r.riskAtStopP ?? 0, 0), 0);
    const want = [...proAll.rows]
      .sort((a, b) => givesBack(b, b.markP!) - givesBack(a, a.markP!))
      .map((r) => ({ r, share: fmt.pct(ppmFloor(r.riskAtStopP!, riskSum)) }));
    // Not vacuous: the tab's own row order (deployed desc) differs from the give-back rank.
    expect(tabMod.positionsOrder(proAll.rows, { accountFilter: null, query: "" }).map((r) => r.symbol)).not.toEqual(
      want.map((w) => w.r.symbol),
    );
    expect(ranked.map((c) => c[0].split(" ")[0])).toEqual(want.map((w) => w.r.symbol));
    for (const [i, w] of want.entries()) {
      expect(ranked[i][1], w.r.symbol).toBe(fmt.signedMoney(-givesBack(w.r, w.r.markP!)));
      expect(ranked[i][2], w.r.symbol).toBe(w.share);
      // The card for the same id, given the share positions-tab.tsx:147 maps by id.
      const lens = view.riskLensSummary(tabMod.positionsOrder(proAll.rows, { accountFilter: null, query: "" }), proAll.heat);
      const share = lens.ranked.find((x) => x.id === w.r.id)!.heatSharePpm;
      expect(txt(renderCard(w.r, proAll, true, share)), w.r.symbol).toContain(
        `${w.share} ${copy.POSITIONS_COPY.ofOpenRisk(fmt.money(proAll.heat!.openRiskP))}`,
      );
    }
    // Unfiltered, the lens's Σ risk IS the heat strip's open risk.
    expect(riskSum).toBe(proAll.heat!.openRiskP);
  });

  it("since-close paragraph: unrealised and give-back at the previous close vs now, from prevCloseP / markP", () => {
    const html = renderTab(proAll, true, { lensOpen: true });
    const rows = proAll.rows.filter((r) => r.holdingDays !== 0 && r.prevCloseP !== null && r.markP !== null);
    expect(rows.length).toBe(3);
    const unrl = (r: DeskRow, p: number) => (r.side === "short" ? r.investedP - r.qty * p : r.qty * p - r.investedP);
    const uClose = rows.reduce((s, r) => s + unrl(r, r.prevCloseP!), 0);
    const uNow = rows.reduce((s, r) => s + unrl(r, r.markP!), 0);
    const gbClose = rows.reduce((s, r) => s + givesBack(r, r.prevCloseP!), 0);
    const gbNow = rows.reduce((s, r) => s + givesBack(r, r.markP!), 0);
    const para = txt(html.slice(html.indexOf('data-testid="positions-since-close"')));
    expect(para).toContain(copy.POSITIONS_COPY.sinceCloseUnrealised(fmt.signedMoney(uClose), fmt.signedMoney(uNow)));
    expect(para).toContain(copy.POSITIONS_COPY.sinceCloseGivesBack(fmt.money(gbClose), fmt.money(gbNow)));
    // The short's give-back GROWS as its price falls away from a stop above entry.
    const short = rowOf(proAll, 302);
    expect(givesBack(short, short.markP!)).toBeGreaterThan(givesBack(short, short.prevCloseP!));
  });

  // RECORDED DEFECT — "C4 seam: filtered heat share printed against the whole book's open risk".
  // positions-tab.tsx:145 runs `riskLensSummary(order, heat)` over the FILTERED rows (account /
  // symbol filter), so each share is of the filtered Σ risk; the card prints it as
  // "x% · of ₹<heat.openRiskP> open risk" (position-card.tsx:239-240) and the lens heads its
  // table with `lensHeat(heat.heatPpm, heat.openRiskP, …)` (positions-tab.tsx:802) — the WHOLE
  // book's figures from A's `portfolioHeat` (load-desk.ts:498). Filtered to PRIMARY, TCS prints
  // 32.93% of ₹7,822 (= ₹2,576) for a ₹600 risk; ZZNONE 67.06% (= ₹5,246) for ₹1,222 (red on
  // HEAD: "ZZNONE: expected 402414.5002 to be less than 100").
  // FIXED in the C4 fix wave (fix 2): the lens states its OWN Σ open risk (`openRiskP`, over
  // the rows it was given) and the tab hands it to the card with the share. The two
  // expectations that named `heat.openRiskP` encoded the defect; they now read the lens's Σ,
  // and the property is unchanged: printed share × printed open risk = the row's risk.
  it("filtered to one account: printed share × printed open risk = the row's own risk (C4 seam: filtered heat share printed against the whole book's open risk)", () => {
    const order = tabMod.positionsOrder(proAll.rows, { accountFilter: PRIMARY, query: "" });
    const lens = view.riskLensSummary(order, proAll.heat);
    const inView = lens.openRiskP!;
    expect(inView, "not vacuous: the filtered Σ differs from the whole book's").not.toBe(proAll.heat!.openRiskP);
    for (const r of order) {
      const share = lens.ranked.find((x) => x.id === r.id)!.heatSharePpm!;
      const card = txt(renderCard(r, proAll, true, share, inView));
      expect(card).toContain(copy.POSITIONS_COPY.ofOpenRisk(fmt.money(inView)));
      expect(card).not.toContain(copy.POSITIONS_COPY.ofOpenRisk(fmt.money(proAll.heat!.openRiskP)));
      // What the card's two figures imply, against what the row risks (to the rupee).
      expect(Math.abs((share * inView) / 1_000_000 - r.riskAtStopP!), r.symbol).toBeLessThan(100);
    }
    // The tab itself: the lens prints the in-view Σ, and labels the whole-book heat as such.
    const tab = txt(renderTab(proAll, true, { accountFilter: PRIMARY, lensOpen: true }));
    expect(tab).toContain(tabMod.SCOPE_COPY.inViewRisk(fmt.money(inView)));
    expect(tab).toContain(tabMod.SCOPE_COPY.wholeBook);
    // Unfiltered, there is no "whole book" caveat to make.
    expect(txt(renderTab(proAll, true, { lensOpen: true }))).not.toContain(tabMod.SCOPE_COPY.wholeBook);
  });
});

// ─── S9 — the ticked rows B actually receives (tracker-client.tsx:580) ───────

describe("S9 — after a live tick, the C4 fields ride through applyTicks and the header follows the tick", () => {
  it("a TCS tick moves the header unrealised and the since-close 'now', and keeps partial / sizing / both stops", async () => {
    const { applyTicks, mergeTicks } = await import("@/lib/live/apply-ticks");
    const tcs = rowOf(proAll, 301);
    const ltp = tcs.markP! + 5_000; // +₹50
    const ticks = mergeTicks(new Map(), [
      { key: { symbol: tcs.symbol, exchange: tcs.exchange, tradingsymbol: tcs.tradingsymbol }, ltp, prevClose: null, asOf: `${TODAY}T10:15:00+05:30`, staleness: "tick" },
    ]);
    const rows = applyTicks(proAll.rows, ticks);
    const ticked = rows.find((r) => r.id === 301)!;
    expect(ticked.markP).toBe(ltp);
    for (const k of ["partial", "sizing", "slPlannedP", "trailingSlP", "prevCloseP", "industry", "sectorName", "corpActions"] as const) {
      expect(ticked[k], k).toEqual(tcs[k]);
    }
    const d = { ...proAll, rows };
    const html = renderTab(d, true, { lensOpen: true });
    const unrealised = rows.reduce((s, r) => s + r.unrealisedP!, 0);
    expect(unrealised - proAll.rows.reduce((s, r) => s + r.unrealisedP!, 0)).toBe(tcs.qty * 5_000);
    expect(txt(html)).toContain(fmt.signedMoney(unrealised));
    expect(txt(html.slice(html.indexOf('data-testid="positions-since-close"')))).toContain(`${fmt.signedMoney(unrealised)} now.`);
  });
});

// ─── S1 / S2 — Edit levels: pre-fill from the wire, untouched save ───────────
// LAST: these write to the database.

// C4 fix 3: the dialog sends ONLY the fields whose text the user changed, and an untouched
// save sends no request at all (it closes through `onDone`). The two cases below pinned the
// old "every level on every save" body; they now pin "nothing posted, nothing written".
describe("S1/S2 — Edit levels pre-fills from the wire and an UNTOUCHED save posts and writes nothing", () => {
  it("S2: planned and trailing ride in their OWN keys — a trailing stop never lands in originalSl", async () => {
    const tcs = rowOf(proAll, 301);
    expect(tcs.effectiveStopSource).toBe("trailing");
    const props = editPropsFromCard(tcs, proAll);
    expect(props).toMatchObject({ tradeId: 301, originalSl: 2800, trailingSl: 2900, target: 3400, avgEntry: 3000, openQty: 6 });
    expect(props.mark, "the /live card is levels-only").toBeUndefined();
    const before = storedLevels(301);
    router.refreshes = 0;
    cache.paths.length = 0;
    const { html, posted } = await untouchedSave(props);
    // The dialog's three level inputs, pre-filled in order: Original SL, Trailing SL, Target.
    expect([...html.matchAll(/<input[^>]*value="([^"]*)"/g)].map((m) => m[1])).toEqual(["2800", "2900", "3400"]);
    expect(posted, "an untouched save sends no request").toBe(false);
    expect(storedLevels(301)).toEqual(before);
    expect(before).toEqual({ slPlanned: 2800, trailingSl: 2900, targetPlanned: 3400 });
    expect(router.refreshes, "the dialog still closes through the card's onDone").toBe(1);
    expect(cache.paths, "no route ran, so nothing was revalidated").toEqual([]);
  });

  it("S1: the short's planned-only stop and absent target survive an untouched save as they were", async () => {
    const short = rowOf(proAll, 302);
    const props = editPropsFromCard(short, proAll);
    expect(props).toMatchObject({ originalSl: 600, trailingSl: null, target: null, avgEntry: 500, openQty: 60 });
    const before = storedLevels(302);
    const { posted } = await untouchedSave(props);
    expect(posted).toBe(false);
    expect(storedLevels(302)).toEqual(before);
    expect(before).toEqual({ slPlanned: 600, trailingSl: null, targetPlanned: null });
  });

  // RECORDED DEFECT — "C4 seam: sub-paisa stop rounded on untouched save". The wire carries the
  // two stops and the target as PAISE (load-desk.ts:333-335 `toPaiseOrNull`), the card divides by
  // 100 (position-card.tsx:358-360) and the dialog posts every level on every save
  // (risk-edit-dialog.tsx:70-72), so a stored REAL 1450.125 is rewritten 1450.13 although the user
  // typed nothing. Builder A recorded it LOW (NSE ticks are 5 paise; prices stay REAL by invariant 1).
  // Red on HEAD: "expected { slPlanned: 1450.13, … } to deeply equal { slPlanned: 1450.125, … }".
  // FIXED in the C4 fix wave (fix 3): an untouched save posts nothing.
  it("S1: sub-paisa stored levels survive an untouched save (C4 seam: sub-paisa stop rounded on untouched save)", async () => {
    const r = rowOf(proAll, 303);
    const before = storedLevels(303);
    expect(before).toEqual({ slPlanned: 1450.125, trailingSl: 1475.555, targetPlanned: 1600.005 });
    await untouchedSave(editPropsFromCard(r, proAll));
    expect(storedLevels(303)).toEqual(before);
  });
});

/**
 * Release-audit U-B1 — the inline calculator re-seeds when the stop the card shows moves.
 *
 * `PositionCalculator` seeds its stop from the row ONCE (`useState` initialisers, never an
 * effect). After Edit levels saves and `router.refresh()` lands, the card stays mounted for the
 * same `row.id` — so a key of `row.id` alone kept the OLD stop in the calculator beside the new
 * one in the card. The key now carries `effectiveStopP`, so a changed stop is a fresh calculator.
 * Read from the element the card builds (the harness pattern of `editPropsFromCard`).
 */
describe("U-B1 — the calculator is keyed on the row AND its effective stop", () => {
  function calculatorKey(row: DeskRow): string | null {
    let key: string | null | undefined;
    function Harness() {
      const tree = cardMod.PositionCard(cardProps(row, proAll, true, null));
      key = (findEl(tree, (e) => e.type === calcMod.PositionCalculator) as { key?: string | null } | undefined)?.key;
      return null;
    }
    server.renderToStaticMarkup(h(Harness));
    if (key === undefined) throw new Error(`the card for row ${row.id} built no PositionCalculator`);
    return key;
  }
  let calcMod: typeof import("@/components/live/position-calculator");
  beforeAll(async () => {
    calcMod = await import("@/components/live/position-calculator");
  });

  it("a moved stop is a NEW calculator; the same stop is the same one; another row is another one", () => {
    const tcs = rowOf(proAll, 301);
    expect(tcs.effectiveStopP).toBe(290_000);
    const same = calculatorKey(tcs);
    expect(calculatorKey({ ...tcs })).toBe(same);
    expect(calculatorKey({ ...tcs, effectiveStopP: 295_000 }), "the calculator kept the old stop after Edit levels").not.toBe(same);
    expect(calculatorKey({ ...tcs, effectiveStopP: null })).not.toBe(same);
    expect(calculatorKey(rowOf(proAll, 303))).not.toBe(same);
  });
});
