import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import {
  ORACLE_A1, ORACLE_A2, ORACLE_A3, loadOracleConsumers, seedOracleBook, selectOracleAccount,
} from "./helpers/oracle-book";
// PURE (no DB, no React) — safe to import statically beside openTempDb.
import { computeKpis, equityCurve, dailyPnl, bySegment, bySetup } from "@/lib/analytics/metrics";
import { dashboardQuery, type DashboardAggregate, type DashboardFilters, type DashRow } from "@/lib/analytics/dashboard-aggregate";

/**
 * v4.7.0 C0 — THE DASHBOARD AGGREGATE ACROSS THE SEAM, over the counted-once
 * oracle book (tests/helpers/oracle-book.ts) plus a dated multi-segment tail.
 *
 * `tests/dashboard-aggregate.test.ts` proves the maths equals the old client's
 * on a synthetic book. This file proves the halves that ship it:
 *   1. `getDashboardAggregate` reads the SAME scoped rows as `getDashboardTrades`
 *      (invariant 8: `accountId > 0 ? filter : all`), in every view;
 *   2. the page hands DashboardClient that aggregate — and no row array — with
 *      its search params applied;
 *   3. GET /api/dashboard/export (app/api/dashboard/export/route.ts) returns
 *      the filtered rows of the SELECTED account only, read on the call.
 *
 * WRONG looks like: the aggregate of account 1 on account 3's screen, a
 * DashboardClient prop that is the whole book again, or an export that ignores
 * the filters it was given.
 *
 * ONE temp database for the whole file (AGENTS.md Testing).
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));

let t: TempDb;
let q: typeof import("@/lib/queries/trades");
let page: (props?: { searchParams?: Promise<Record<string, string>> }) => unknown;
let exportRoute: typeof import("@/app/api/dashboard/export/route");

const NO_FILTER: DashboardFilters = { broker: "", bucket: "", segment: "", from: "", to: "" };
const VIEWS = [0, ORACLE_A1, ORACLE_A2, ORACLE_A3] as const;

// Measured locally 2026-10-01: this hook ~4.3 s (migrate + seed + the oracle book +
// app/page's import graph); tests/breach-scan-scope.test.ts, which imports the same
// page, measures the same ~4.3 s. The ten `it`s are 6–35 ms each. 120 s is for the
// Windows runner (> 15x slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("dashboard-aggregate-db", { seed: true });
  await loadOracleConsumers();
  await seedOracleBook(t);
  q = await import("@/lib/queries/trades");
  page = (await import("@/app/page")).default as typeof page;
  exportRoute = await import("@/app/api/dashboard/export/route");

  // A dated, multi-segment tail per account, so the curve, the calendar, the
  // segment bars and the per-lot line all have something to say.
  const rows: Record<string, unknown>[] = [];
  let n = 0;
  for (const accountId of [ORACLE_A1, ORACLE_A2, ORACLE_A3]) {
    for (let i = 0; i < 12; i++) {
      n++;
      const fno = i % 3 === 0;
      const net = ((n * 7919) % 5000) - 2200 + (i % 2 ? 0.37 : 0.61);
      rows.push(tradeRow({
        accountId,
        broker: i % 2 ? "zerodha" : "dhan",
        bucket: fno ? "active" : "equity",
        segment: fno ? "index_option" : i % 4 === 1 ? "eq_intraday" : "eq_delivery",
        instrumentType: fno ? "option" : "equity",
        symbol: fno ? "NIFTY" : `SYM${i}`,
        tradingsymbol: fno ? `NIFTY26MAR2${i}000CE` : `SYM${i}`,
        expiry: fno ? "2026-03-26" : null,
        lotSize: fno ? 65 : null,
        buyQty: fno ? 130 : 10, sellQty: fno ? 130 : 10,
        avgBuyPrice: 100, avgSellPrice: 110,
        buyValue: 10_000, sellValue: 11_000,
        isOpen: i === 11,
        buyDate: `2026-0${1 + (i % 3)}-0${1 + (i % 9)}`,
        sellDate: i === 11 ? null : `2026-0${1 + (i % 3)}-1${i % 10}`,
        netPnl: Math.round(net * 100) / 100,
        grossPnl: Math.round((net + 40) * 100) / 100,
        chargesTotal: 40,
        rMultiple: i % 5 === 4 ? null : Math.round((net / 1000) * 100) / 100,
        riskAmount: i % 5 === 4 ? null : 1000,
        riskSource: i % 2 ? "cap" : "set",
        slPlanned: i % 2 ? null : 90,
        setupTag: i % 3 === 1 ? "breakout" : null,
      }));
    }
  }
  t.db.insert(t.schema.trades).values(rows as never).run();
}, 120_000);

afterAll(() => t?.cleanup());

/** The HEAD client's filter predicate (dashboard-client.tsx @ 19ecdcf), verbatim. */
const headFilter = (rows: DashRow[], f: DashboardFilters) => rows.filter((x) => {
  if (f.broker && x.broker !== f.broker) return false;
  if (f.bucket && x.bucket !== f.bucket) return false;
  if (f.segment && x.segment !== f.segment) return false;
  const d = x.sellDate ?? x.buyDate;
  if (f.from && d && d < f.from) return false;
  if (f.to && d && d > f.to) return false;
  return true;
});

const accountOfRows = () =>
  new Map((t.db.select({ id: t.schema.trades.id, a: t.schema.trades.accountId }).from(t.schema.trades).all()).map((r) => [r.id, r.a]));

type El = { type: unknown; props: Record<string, unknown> };
function findEl(node: unknown, match: (e: El) => boolean): El | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findEl(n, match);
      if (f) return f;
    }
    return undefined;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const el = node as El;
  if (match(el)) return el;
  return findEl(el.props?.children, match);
}

const named = (n: string) => (e: El) => typeof e.type === "function" && (e.type as { name?: string }).name === n;

/**
 * Render `/` to the DashboardClient element: the page, then its async figures
 * child. A page that renders DashboardClient DIRECTLY (the pre-C0 shape) is
 * followed too, so a revert fails on what the client is handed, not on a name.
 */
async function dashboardClientProps(sp: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const tree = page({ searchParams: Promise.resolve(sp) });
  const figures = findEl(tree, named("DashboardFigures"));
  const client = figures
    ? ((await (figures.type as (p: Record<string, unknown>) => Promise<El>)(figures.props)) as El)
    : findEl(tree, named("DashboardClient"));
  expect(client, "no <DashboardClient> reachable from the page").toBeDefined();
  expect((client!.type as { name?: string }).name).toBe("DashboardClient");
  return client!.props;
}

describe("the aggregate reads the selected account's rows — the same read the page always used", () => {
  it.each(VIEWS)("view %i: the KPIs, curve, calendar and groups equal the old client maths over getDashboardTrades()", (id) => {
    selectOracleAccount(t, id);
    const rows = q.getDashboardTrades() as DashRow[];
    const owner = accountOfRows();
    const ids = new Set(rows.map((r) => owner.get(r.id!)));
    // Invariant 8: one account's rows, or every account's in the aggregate view.
    expect([...ids].sort()).toEqual(id === 0 ? [ORACLE_A1, ORACLE_A2, ORACLE_A3] : [id]);

    for (const f of [NO_FILTER, { ...NO_FILTER, bucket: "equity" }, { ...NO_FILTER, segment: "index_option" },
      { ...NO_FILTER, broker: "zerodha", from: "2026-02-01" }]) {
      const a = q.getDashboardAggregate(f);
      const filtered = headFilter(rows, f);
      expect(a.bookCount).toBe(rows.length);
      expect(a.filteredCount).toBe(filtered.length);
      expect(a.kpis).toEqual(computeKpis(filtered));
      expect(a.curve).toEqual(equityCurve(filtered));
      expect(Object.entries(a.daily)).toEqual([...dailyPnl(filtered).entries()]);
      expect(a.segStats).toEqual(bySegment(filtered));
      expect(a.setupStats).toEqual(bySetup(filtered));
    }
    expect(q.getDashboardAggregate(NO_FILTER).kpis.closedCount, "not a vacuous comparison").toBeGreaterThan(5);
  });
});

describe("the page ships the aggregate, not the rows", () => {
  it.each(VIEWS)("view %i: DashboardClient's props carry no trade row array, and the payload does not scale with the book", async (id) => {
    selectOracleAccount(t, id);
    const bookRows = q.getDashboardTrades().length;
    const props = await dashboardClientProps();
    expect(props, "the whole book rode the RSC payload again").not.toHaveProperty("trades");
    expect(Object.keys(props).sort()).toEqual(["aggregate", "monthlyBase", "monthlyStretch", "workspace"]);
    const agg = props.aggregate as DashboardAggregate;
    expect(agg.bookCount).toBe(bookRows);
    expect(agg.kpis).toEqual(q.getDashboardAggregate(agg.filters).kpis);
    // Nothing in the payload is a per-trade record: no value anywhere carries a row's `symbol`.
    expect(JSON.stringify(agg)).not.toMatch(/"symbol"/);
  });

  it("the search params reach the maths: ?broker=zerodha&segment=index_option&from=2026-01-15", async () => {
    selectOracleAccount(t, 0);
    const props = await dashboardClientProps({ broker: "zerodha", segment: "index_option", from: "2026-01-15", bucket: "all" });
    const agg = props.aggregate as DashboardAggregate;
    const f = { broker: "zerodha", bucket: "", segment: "index_option", from: "2026-01-15", to: "" };
    expect(agg.filters).toEqual(f);
    expect(agg.kpis).toEqual(computeKpis(headFilter(q.getDashboardTrades() as DashRow[], f)));
    expect(agg.filteredCount).toBeGreaterThan(0);
    expect(agg.filteredCount).toBeLessThan(agg.bookCount);
  });

  it("GET /api/dashboard/export returns the SELECTED account's filtered rows, read on the call", async () => {
    const owner = accountOfRows();
    const get = async (qs: string) => {
      const res = await exportRoute.GET(new Request(`http://localhost/api/dashboard/export${qs}`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; rows: Record<string, unknown>[] };
      expect(body.ok).toBe(true);
      return body.rows;
    };
    for (const id of [ORACLE_A3, 0]) {
      selectOracleAccount(t, id);
      // The query the client sends: `dashboardQuery(aggregate.filters, "")`.
      const props = await dashboardClientProps({ broker: "dhan", bucket: "all" });
      const agg = props.aggregate as DashboardAggregate;
      const f = { ...NO_FILTER, broker: "dhan" };
      expect(agg.filters).toEqual(f);
      const got = await get(dashboardQuery(agg.filters, ""));
      const want = headFilter(q.getDashboardTrades() as DashRow[], f);
      expect(got.length).toBe(agg.filteredCount);
      expect(got.map((r) => r.netPnl)).toEqual(want.map((r) => r.netPnl));
      expect(got.map((r) => r.symbol)).toEqual(want.map((r) => r.symbol));
      if (id !== 0) for (const r of want) expect(owner.get(r.id!)).toBe(id);
      // A bucket filter the route is handed explicitly is applied.
      const eq = await get("?bucket=equity");
      expect(eq.length).toBe(headFilter(q.getDashboardTrades() as DashRow[], { ...NO_FILTER, bucket: "equity" }).length);
      expect(eq.every((r) => r.bucket === "equity")).toBe(true);
      // A hand-crafted filter from the browser widens to "no filter", never reaches SQL.
      const crafted = await get(`?broker=${encodeURIComponent("'; drop table trades;--")}&segment=crypto&from=yesterday`);
      expect(crafted.length).toBe(q.getDashboardTrades().length);
    }
  });
});
