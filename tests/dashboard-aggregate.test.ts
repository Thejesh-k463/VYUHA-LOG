import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeKpis, equityCurve, dailyPnl, bySegment, bySetup, edgeMeasurable,
} from "@/lib/analytics/metrics";
import { provenanceRowOf, rProvenanceCounts, rProvenanceLine } from "@/lib/analytics/win-loss";
import { isLotSegment, perLotAggregateResolved, perLotSecondLine, type PerLotAggregate } from "@/lib/analytics/per-lot";
import { inrCompact } from "@/lib/format";
import { calendarDaysHeld } from "@/lib/domain/trading-day";
import {
  ALL_BUCKETS_PARAM, dashboardAggregate, dashboardExportRows, dashboardQuery, filterDashRows,
  parseDashboardFilters, sanitizeDashboardFilters,
  type DashboardAggregate, type DashboardFilters, type DashRow,
} from "@/lib/analytics/dashboard-aggregate";

/**
 * v4.7.0 C0 — THE DASHBOARD AGGREGATE IS THE OLD CLIENT MATHS, MOVED.
 *
 * `/` used to hand DashboardClient every row (13.1 MB of HTML on the 25,001-row
 * perf book, LEDGER L-51 / D-16) and filter + total them in `useMemo`s. The
 * server now runs `dashboardAggregate` and ships the result. This file is the
 * ORACLE: `headClientMaths` below is the HEAD (19ecdcf) body of
 * components/dashboard/dashboard-client.tsx's memos, copied VERBATIM and frozen,
 * and every field the new aggregate states is compared with it — over a
 * 3-account synthetic book, in every account view, under every filter
 * combination the controls can produce. `toEqual` compares numbers with
 * Object.is, so "identical" here means to the last float bit, not "close".
 *
 * WRONG looks like: a KPI that differs from the old screen by a paisa (a sum
 * re-ordered), a curve with one point more or less, a best day that picks the
 * other of two equal days, or a per-lot line that pools two segments.
 */

// ── the frozen HEAD client maths (dashboard-client.tsx @ 19ecdcf, lines 67-204) ──

function headClientMaths(trades: DashRow[], f: DashboardFilters) {
  const { broker, bucket, segment, from, to } = f;
  const filtered = trades.filter((t) => {
    if (broker && t.broker !== broker) return false;
    if (bucket && t.bucket !== bucket) return false;
    if (segment && t.segment !== segment) return false;
    const d = t.sellDate ?? t.buyDate;
    if (from && d && d < from) return false;
    if (to && d && d > to) return false;
    return true;
  });
  const k = computeKpis(filtered);
  const curve = equityCurve(filtered);
  const undatedNet = filtered.filter((t) => !t.isOpen && !t.sellDate).reduce((s, t) => s + t.netPnl, 0);
  const undatedCount = filtered.filter((t) => !t.isOpen && !t.sellDate).length;
  const daily = Object.fromEntries(dailyPnl(filtered));
  const undatedClosed = filtered.filter((t) => !t.isOpen && !t.sellDate).length;
  const segStats = bySegment(filtered);
  const perLotBySegment = (() => {
    const out = new Map<string, { agg: PerLotAggregate; line: string; rProvLine: string }>();
    const segs = new Set(filtered.map((t) => t.segment).filter(isLotSegment));
    for (const s of segs) {
      const pop = filtered.filter((t) => t.segment === s && !t.isOpen && edgeMeasurable(t));
      if (pop.length === 0) continue;
      const agg = perLotAggregateResolved(pop.map((t) => ({
        lots: t.lots ?? null,
        lotSource: t.lotSource ?? null,
        netPnl: t.netPnl,
        riskAmount: t.riskAmount ?? null,
        rMultiple: t.rMultiple,
      })));
      const prov = rProvenanceLine(rProvenanceCounts(pop.map(provenanceRowOf)));
      out.set(s, { agg, line: perLotSecondLine(agg, prov), rProvLine: prov });
    }
    return out;
  })();
  const setupStats = bySetup(filtered);
  const spark = curve.slice(-30).map((p) => p.cum);
  // weekDelta is NOT frozen here (v4.7.0 release audit M-B2): HEAD's body cut
  // the weeks at a LOCAL midnight read back through toISOString(), which in IST
  // (UTC+5:30) lands on the previous UTC day — an 8-day "this week". Copying it
  // here made the oracle agree with the bug. It is checked below against an
  // independent definition (`weekDeltaByDayCount`) and against concrete dates.
  const dayStats = (() => {
    const entries = Object.entries(daily);
    if (entries.length === 0) return { best: 0, worst: 0, bestDate: null as string | null, worstDate: null as string | null };
    let best = entries[0];
    let worst = entries[0];
    for (const e of entries) {
      if (e[1] > best[1]) best = e;
      if (e[1] < worst[1]) worst = e;
    }
    return { best: best[1], worst: worst[1], bestDate: best[0], worstDate: worst[0] };
  })();
  const rStats = (() => {
    const rs = filtered
      .filter((t) => !t.isOpen && t.rMultiple != null && edgeMeasurable(t))
      .map((t) => t.rMultiple as number);
    return {
      count: rs.length,
      best: rs.length ? Math.max(...rs) : null,
      worst: rs.length ? Math.min(...rs) : null,
    };
  })();
  const monthly = (() => {
    const m = new Map<string, number>();
    for (const [d, v] of Object.entries(daily)) {
      const key = d.slice(0, 7);
      m.set(key, (m.get(key) ?? 0) + v);
    }
    return [...m.entries()].sort().map(([month, net]) => ({ month, net }));
  })();
  return {
    trades, filtered, k, curve, undatedNet, undatedCount, daily, undatedClosed, segStats,
    perLotBySegment, setupStats, spark, dayStats, rStats, monthly,
  };
}

/**
 * The week comparison by its DEFINITION, not by HEAD's code: "this week" is the
 * latest P&L day and the six calendar days before it, "prior week" the seven
 * before those — counted with `calendarDaysHeld` (UTC-parsed ISO dates, so the
 * machine's time zone cannot move a day). Null on an empty book.
 */
function weekDeltaByDayCount(daily: Record<string, number>): number | null {
  const dates = Object.keys(daily).sort();
  if (dates.length === 0) return null;
  const latest = dates[dates.length - 1];
  let thisWeek = 0;
  let lastWeek = 0;
  for (const [d, v] of Object.entries(daily)) {
    const back = calendarDaysHeld(d, latest);
    if (back < 7) thisWeek += v;
    else if (back < 14) lastWeek += v;
  }
  return Math.round(thisWeek - lastWeek);
}

/** What the NEW DashboardClient derives from the aggregate (the two client-side steps). */
function clientFromAggregate(a: DashboardAggregate) {
  const perLotBySegment = new Map<string, { agg: PerLotAggregate; line: string; rProvLine: string }>();
  for (const [s, { agg, rProv }] of Object.entries(a.perLot)) {
    if (!isLotSegment(s)) continue;
    const prov = rProvenanceLine(rProv);
    perLotBySegment.set(s, { agg, line: perLotSecondLine(agg, prov), rProvLine: prov });
  }
  const weekDelta = a.weekDelta == null
    ? null
    : { value: a.weekDelta, label: "vs prior wk", formatted: inrCompact(Math.abs(a.weekDelta)) };
  return { perLotBySegment, weekDelta };
}

function assertIdentical(book: DashRow[], f: DashboardFilters) {
  const old = headClientMaths(book, f);
  const a = dashboardAggregate(book, f);
  const neu = clientFromAggregate(a);
  const tag = JSON.stringify(f);
  expect(a.bookCount, `${tag} bookCount`).toBe(old.trades.length);
  expect(a.filteredCount, `${tag} filteredCount`).toBe(old.filtered.length);
  expect(a.kpis, `${tag} kpis`).toEqual(old.k);
  expect(a.curve, `${tag} curve`).toEqual(old.curve);
  expect(a.curve.map((p) => p.date), `${tag} curve dates`).toEqual(old.curve.map((p) => p.date));
  expect(a.undatedNet, `${tag} undatedNet`).toBe(old.undatedNet);
  expect(a.undatedCount, `${tag} undatedCount`).toBe(old.undatedCount);
  expect(a.undatedCount, `${tag} undatedClosed`).toBe(old.undatedClosed);
  expect(Object.entries(a.daily), `${tag} daily, in order`).toEqual(Object.entries(old.daily));
  expect(a.segStats, `${tag} segStats`).toEqual(old.segStats);
  expect(a.setupStats, `${tag} setupStats`).toEqual(old.setupStats);
  expect([...neu.perLotBySegment.entries()].sort(), `${tag} perLot`).toEqual([...old.perLotBySegment.entries()].sort());
  expect(a.spark, `${tag} spark`).toEqual(old.spark);
  const wd = weekDeltaByDayCount(old.daily);
  expect(a.weekDelta, `${tag} weekDelta`).toBe(wd);
  expect(neu.weekDelta, `${tag} weekDelta chip`).toEqual(
    wd == null ? null : { value: wd, label: "vs prior wk", formatted: inrCompact(Math.abs(wd)) },
  );
  expect(a.dayStats, `${tag} dayStats`).toEqual(old.dayStats);
  expect(a.rStats, `${tag} rStats`).toEqual(old.rStats);
  expect(a.monthly, `${tag} monthly`).toEqual(old.monthly);
  expect(a.filters, `${tag} echoes its filters`).toEqual(f);
  return old;
}

// ── the synthetic book: 3 accounts, 264 rows ────────────────────────────────

type BookRow = DashRow & { accountId: number; side: string; staged: boolean };

/** Deterministic PRNG, so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SEGS = ["eq_delivery", "eq_intraday", "index_option", "stock_option", "future", "mtf"] as const;
const BRK = ["dhan", "zerodha", "groww", "upstox"] as const;

function buildBook(): BookRow[] {
  const r = rng(20261001);
  const out: BookRow[] = [];
  let id = 1;
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const day = (i: number) => {
    const d = new Date(Date.UTC(2025, 3, 1) + i * 86_400_000);
    return d.toISOString().slice(0, 10);
  };
  for (const accountId of [1, 2, 3]) {
    for (let i = 0; i < 88; i++) {
      const segment = pick(SEGS);
      const fno = segment === "index_option" || segment === "stock_option" || segment === "future";
      const bucket = fno ? "active" : pick(["equity", "active"] as const);
      // ~40 distinct exit days, so many same-day ties (the closedSorted tiebreaks).
      const exitDay = Math.floor(r() * 220);
      const isOpen = r() < 0.12;
      const undated = !isOpen && r() < 0.06;
      const net = Math.round((r() - 0.45) * 2_000_000) / 100 * (r() < 0.05 ? 0 : 1); // incl. exact zeros
      const charges = Math.round(r() * 5000) / 100;
      const unpriced = !isOpen && r() < 0.07; // a basis-less acquisition sale
      const hasR = !isOpen && r() < 0.7;
      const riskSource = hasR ? pick(["cap", "set", "frozen", null] as const) : null;
      const lots = fno ? (r() < 0.1 ? null : 1 + Math.floor(r() * 5)) : null;
      out.push({
        id: id++,
        accountId,
        broker: pick(BRK),
        bucket,
        segment,
        symbol: pick(["TCS", "INFY", "NIFTY", "BANKNIFTY", "RELIANCE"]),
        exchange: pick(["NSE", "BSE", "NFO"]),
        side: pick(["long", "short"]),
        staged: r() < 0.15, // a staged parent: the flat row holds the aggregate (invariant 5)
        netPnl: net,
        grossPnl: Math.round((net + charges) * 100) / 100,
        chargesTotal: charges,
        rMultiple: hasR ? Math.round((r() - 0.4) * 600) / 100 : null,
        isOpen,
        sellDate: isOpen || undated ? null : day(exitDay),
        buyDate: undated && r() < 0.5 ? null : day(Math.max(0, exitDay - Math.floor(r() * 30))),
        exitTime: isOpen ? null : pick([null, "09:20:00", "11:05:00", "15:10:00"]),
        setupTag: pick([null, "", "breakout", "pullback", "gap"]),
        acquisition: unpriced ? "ipo" : null,
        acquisitionPrice: null,
        buyValue: unpriced ? 0 : 10_000,
        rPlan: hasR ? r() < 0.5 : false,
        riskSource,
        riskAmount: hasR ? Math.round(r() * 200_000) / 100 : null,
        lots,
        lotSource: lots == null ? null : pick(["trade", "bundled (2026-01-01)"]),
      });
    }
  }
  // Every row newest-first, exactly as `getDashboardTrades` orders them.
  return out.sort((a, b) =>
    (b.sellDate ?? "").localeCompare(a.sellDate ?? "") || b.id! - a.id!);
}

const BOOK = buildBook();
const VIEWS: [string, DashRow[]][] = [
  ["all accounts (0)", BOOK],
  ["account 1", BOOK.filter((t) => t.accountId === 1)],
  ["account 2", BOOK.filter((t) => t.accountId === 2)],
  ["account 3", BOOK.filter((t) => t.accountId === 3)],
];

const WINDOWS: [string, string][] = [["", ""], ["2025-06-01", ""], ["", "2025-09-15"], ["2025-05-10", "2025-08-20"]];
function* filterSweep(): Generator<DashboardFilters> {
  for (const broker of ["", "dhan", "zerodha", "fyers"]) // fyers: a broker with no row
    for (const bucket of ["", "equity", "active"])
      for (const segment of ["", "eq_delivery", "index_option", "future"])
        for (const [from, to] of WINDOWS) yield { broker, bucket, segment, from, to };
}

describe("the fixture is the book the oracle claims", () => {
  it("≥ 200 rows over 3 accounts, with open, undated, unpriced, zero-P&L, staged, both sides and F&O lots", () => {
    expect(BOOK.length).toBeGreaterThanOrEqual(200);
    expect(new Set(BOOK.map((t) => t.accountId))).toEqual(new Set([1, 2, 3]));
    expect(BOOK.filter((t) => t.isOpen).length).toBeGreaterThan(10);
    expect(BOOK.filter((t) => !t.isOpen && !t.sellDate).length).toBeGreaterThan(3);
    expect(BOOK.filter((t) => !edgeMeasurable(t)).length).toBeGreaterThan(3);
    expect(BOOK.filter((t) => !t.isOpen && t.netPnl === 0).length).toBeGreaterThan(0);
    expect(BOOK.filter((t) => t.staged).length).toBeGreaterThan(10);
    expect(new Set(BOOK.map((t) => t.side))).toEqual(new Set(["long", "short"]));
    expect(BOOK.filter((t) => isLotSegment(t.segment) && t.lots == null).length).toBeGreaterThan(0);
    // Same-day ties exist, so the chronological tiebreaks are exercised.
    const days = BOOK.filter((t) => t.sellDate).map((t) => t.sellDate);
    expect(new Set(days).size).toBeLessThan(days.length);
  });
});

describe("oracle — the aggregate equals the HEAD client maths, field by field", () => {
  it.each(VIEWS)("%s, unfiltered", (_label, rows) => {
    const old = assertIdentical(rows, { broker: "", bucket: "", segment: "", from: "", to: "" });
    // Not a vacuous pass: the view has figures to compare.
    expect(old.k.closedCount).toBeGreaterThan(20);
    expect(old.curve.length).toBeGreaterThan(20);
    expect(old.perLotBySegment.size).toBeGreaterThan(0);
  });

  it.each(VIEWS)("%s, every filter combination (4 brokers × 3 buckets × 4 segments × 4 windows)", (_label, rows) => {
    let n = 0;
    let nonEmpty = 0;
    for (const f of filterSweep()) {
      const old = assertIdentical(rows, f);
      n++;
      if (old.filtered.length > 0) nonEmpty++;
    }
    expect(n).toBe(192);
    expect(nonEmpty).toBeGreaterThan(40);
  });

  it("two equal best (and worst) days: the SAME day wins as before — the first in the rows' newest-first order", () => {
    const base = BOOK.find((t) => !t.isOpen && t.sellDate && edgeMeasurable(t))!;
    const row = (id: number, sellDate: string, netPnl: number): DashRow => ({ ...base, id, sellDate, netPnl, grossPnl: netPnl, chargesTotal: 0 });
    const tied = [row(4, "2025-09-03", 500), row(3, "2025-09-02", -300), row(2, "2025-09-01", 500), row(1, "2025-08-29", -300)];
    const old = assertIdentical(tied, { broker: "", bucket: "", segment: "", from: "", to: "" });
    expect(old.dayStats).toEqual({ best: 500, worst: -300, bestDate: "2025-09-03", worstDate: "2025-09-02" });
  });

  it("the empty book: first-run figures, no throw", () => {
    assertIdentical([], { broker: "", bucket: "", segment: "", from: "", to: "" });
    expect(dashboardAggregate([], { broker: "", bucket: "", segment: "", from: "", to: "" }).weekDelta).toBeNull();
  });

  it("a book of only open positions and undated sales plots no curve", () => {
    const rows = BOOK.filter((t) => t.isOpen || !t.sellDate);
    const old = assertIdentical(rows, { broker: "", bucket: "", segment: "", from: "", to: "" });
    expect(old.curve).toEqual([]);
    expect(old.undatedCount).toBeGreaterThan(0);
  });

  it("the export rows are the filtered rows, in order, carrying exactly the export columns", () => {
    const f: DashboardFilters = { broker: "dhan", bucket: "", segment: "", from: "2025-05-10", to: "" };
    const exp = dashboardExportRows(BOOK, f);
    const want = headClientMaths(BOOK, f).filtered;
    expect(exp.length).toBe(want.length);
    const cols = ["sellDate", "symbol", "broker", "segment", "bucket", "exchange", "grossPnl", "chargesTotal", "netPnl", "rMultiple"] as const;
    exp.forEach((row, i) => {
      expect(Object.keys(row).sort()).toEqual([...cols].sort());
      for (const c of cols) expect(row[c]).toBe(want[i][c]);
    });
  });
});

/**
 * v4.7.0 release audit M-B2: the week comparison on CONCRETE dates and sums,
 * not a copy of the code. Each date below is a sale day; the latest is
 * Wed 2026-10-07, so "this week" is 2026-10-01..2026-10-07 and "prior week"
 * 2026-09-24..2026-09-30. Under the old body, a machine in IST cut "this week"
 * at 2026-09-29 (a local midnight read back in UTC) and pulled 2026-09-30 —
 * exactly seven days back — into it. Run under TZ=Asia/Kolkata as well as UTC.
 */
describe("weekDelta on IST calendar dates — concrete days and sums (M-B2)", () => {
  const base = BOOK.find((t) => !t.isOpen && t.sellDate && edgeMeasurable(t))!;
  let id = 9000;
  const sale = (sellDate: string, netPnl: number): DashRow => ({ ...base, id: ++id, buyDate: sellDate, sellDate, netPnl, grossPnl: netPnl, chargesTotal: 0 });
  const NONE: DashboardFilters = { broker: "", bucket: "", segment: "", from: "", to: "" };

  it("seven days back is the PRIOR week, fourteen back is neither", () => {
    const rows = [
      sale("2026-10-07", 100), //  0 days back → this week
      sale("2026-10-01", 10), //   6 days back → this week
      sale("2026-09-30", 1000), // 7 days back → prior week
      sale("2026-09-24", 50), //  13 days back → prior week
      sale("2026-09-23", 5000), // 14 days back → neither
    ];
    // this week 110, prior week 1050 → −940. (The IST bug read 1110 − 5050 = −3940.)
    expect(dashboardAggregate(rows, NONE).weekDelta).toBe(-940);
  });

  it("across a month and a year boundary", () => {
    const rows = [
      sale("2026-01-02", 300), //  0 → this week
      sale("2025-12-27", 7), //    6 → this week
      sale("2025-12-26", 40), //   7 → prior week
      sale("2025-12-20", 2), //   13 → prior week
      sale("2025-12-19", 900), // 14 → neither
    ];
    expect(dashboardAggregate(rows, NONE).weekDelta).toBe(307 - 42);
  });

  it("one sale day: the whole figure is this week's", () => {
    expect(dashboardAggregate([sale("2026-03-31", -250.4)], NONE).weekDelta).toBe(-250);
  });
});

describe("the aggregate is BOUNDED — it never grows with the trade count", () => {
  /** 25,001 rows over ~250 exit days: the perf book's size. */
  const big: DashRow[] = (() => {
    const out: DashRow[] = [];
    for (let i = 0; i < 25_001; i++) out.push({ ...BOOK[i % BOOK.length], id: i + 1 });
    return out;
  })();
  const bigAgg = dashboardAggregate(big, { broker: "", bucket: "", segment: "", from: "", to: "" });

  it("no array in the wire shape is as long as the book, and the whole thing is under 64 KB", () => {
    const walk = (v: unknown, at: string): void => {
      if (Array.isArray(v)) {
        expect(v.length, `${at} scales with the rows`).toBeLessThan(1000);
        v.forEach((x, i) => walk(x, `${at}[${i}]`));
      } else if (v && typeof v === "object") {
        for (const [k2, x] of Object.entries(v)) walk(x, `${at}.${k2}`);
      }
    };
    walk(bigAgg, "aggregate");
    expect(JSON.stringify(bigAgg).length).toBeLessThan(64 * 1024);
    expect(bigAgg.bookCount).toBe(25_001);
  });

  it("…and 95× the rows over the same days is well under 2× the bytes (only the digits grow)", () => {
    const small = JSON.stringify(dashboardAggregate(BOOK, { broker: "", bucket: "", segment: "", from: "", to: "" })).length;
    expect(JSON.stringify(bigAgg).length / small).toBeLessThan(1.5);
  });
});

describe("the filters live in the URL: parse, re-serialise, and refuse what the controls cannot say", () => {
  it("an absent bucket is the workspace default; bucket=all is 'Both buckets'", () => {
    expect(parseDashboardFilters({}, "equity").bucket).toBe("equity");
    expect(parseDashboardFilters({}, "").bucket).toBe("");
    expect(parseDashboardFilters({ bucket: ALL_BUCKETS_PARAM }, "equity").bucket).toBe("");
    expect(parseDashboardFilters({ bucket: "active" }, "equity").bucket).toBe("active");
  });

  it("an unknown value widens to no filter — never reaches the maths", () => {
    const f = parseDashboardFilters({ broker: "robinhood", segment: "crypto", from: "2025-13", to: "yesterday", bucket: "x" }, "");
    expect(f).toEqual({ broker: "", bucket: "", segment: "", from: "", to: "" });
    expect(sanitizeDashboardFilters({ broker: "dhan", bucket: 7, segment: "future", from: "2025-01-01", to: "<script>" }))
      .toEqual({ broker: "dhan", bucket: "", segment: "future", from: "2025-01-01", to: "" });
    expect(sanitizeDashboardFilters(null)).toEqual({ broker: "", bucket: "", segment: "", from: "", to: "" });
  });

  it("dashboardQuery round-trips through parseDashboardFilters under every workspace default", () => {
    for (const def of ["", "equity", "active"]) {
      for (const f of filterSweep()) {
        const qs = dashboardQuery(f, def);
        const sp = Object.fromEntries(new URLSearchParams(qs.replace(/^\?/, "")));
        expect(parseDashboardFilters(sp, def), `${def} ${qs}`).toEqual(f);
      }
    }
    expect(dashboardQuery({ broker: "", bucket: "equity", segment: "", from: "", to: "" }, "equity")).toBe("");
    expect(dashboardQuery({ broker: "", bucket: "", segment: "", from: "", to: "" }, "equity")).toBe("?bucket=all");
  });

  it("filterDashRows is the one filter both the figures and the export use", () => {
    const f: DashboardFilters = { broker: "", bucket: "active", segment: "", from: "", to: "2025-07-01" };
    expect(filterDashRows(BOOK, f)).toEqual(headClientMaths(BOOK, f).filtered);
  });
});

describe("the wiring: the page hands the client the aggregate, never the rows", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

  it("app/page.tsx passes `aggregate`, not `trades`, to DashboardClient", () => {
    const src = read("app/page.tsx");
    expect(src).toContain("getDashboardAggregate(parseDashboardFilters(");
    expect(src).toMatch(/<DashboardClient[\s\S]*?aggregate=\{aggregate\}/);
    expect(src, "the whole book must not ride on the RSC payload").not.toMatch(/<DashboardClient[^>]*\btrades=\{/);
  });

  it("DashboardClient takes no row array and filters nothing itself", () => {
    const src = read("components/dashboard/dashboard-client.tsx");
    expect(src).not.toMatch(/\btrades: DashTrade\[\]/);
    expect(src).not.toMatch(/\bcomputeKpis\(|\bequityCurve\(|\bdailyPnl\(/);
    expect(src).toContain("aggregate: DashboardAggregate;");
  });
});
