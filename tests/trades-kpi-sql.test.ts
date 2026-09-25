import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { summariseAcquisitions, ipoAllottedPnl, hasKnownBasis } from "@/lib/analytics/acquisition";
import { isMarked } from "@/lib/analytics/trade-status";

/**
 * v4.6.0 W6 — the /trades speed lever.
 *
 * app/trades/page.tsx used to read the WHOLE book (`getJournalTrades()`,
 * ~340–390 ms at All accounts on the 25,001-row perf book) for four consumers:
 * the KPI strip and three side panels. It now reads
 *
 *   - `getTradeStatsSql()`    — one SQL aggregate over integer paise, and
 *   - `getJournalPanelRows()` — only the rows the panels can act on.
 *
 * This file pins both against the old whole-book path in every view the
 * account switcher offers: the KPI figures BIT-identical (`toBe`, never
 * `toBeCloseTo`), the panel rows equal to the whole book filtered by the
 * panels' own JS predicate INCLUDING order, and every panel output equal.
 *
 * ONE temp database for the file (lib/db caches its connection on globalThis).
 */

let t: TempDb;
let trades: typeof import("@/lib/queries/trades");

// Deterministic PRNG, so the float-error-prone money values are the same every run.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260925);
/** A rupee figure with paise — the kind whose float sum drifts off the paisa. */
const money = (span: number) => Math.round((rnd() * 2 - 1) * span * 100) / 100;
const pos = (span: number) => Math.round((rnd() * span + 1) * 100) / 100;

// Every value the page's predicates branch on.
const ACQUISITIONS = [null, "", "unknown", "ipo", "bonus", "gift"] as const;
const CLOSING = [null, 0, -5, 123.45, Infinity, -Infinity, Number.NaN] as const;
/** The flagged-sale rows cycle these, so every account holds an IPO sale. */
const SALE_FLAGS = ["ipo", "unknown", "bonus", "gift", "ipo", null, ""] as const;

/** The one tie block: shared sell_date AND created_at, so only `id` orders it. */
const TIE_SELL = "2026-03-31";
const TIE_CREATED = "2026-04-01 09:15:00";

function seedAccount(accountId: number, n: number) {
  const rows: ReturnType<typeof tradeRow>[] = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 6;
    // Offset by the cycle number, or every row of one `kind` would share one flag.
    const acquisition = ACQUISITIONS[(i + Math.floor(i / 6)) % ACQUISITIONS.length];
    const cycle = Math.floor(i / 6);
    const closingPrice = CLOSING[i % CLOSING.length];
    const tie = i % 5 === 0;
    const sellDate = tie ? TIE_SELL : `2026-0${1 + (i % 9)}-${String(1 + (i % 27)).padStart(2, "0")}`;
    const createdAt = tie ? TIE_CREATED : `2026-04-0${1 + (i % 9)} 10:00:0${i % 10}`;
    const sellValue = pos(50_000);
    const charges = pos(80);
    let row: Record<string, unknown>;
    if (kind === 0 || kind === 1) {
      // Closed win / closed loss.
      const gross = kind === 0 ? pos(9_000) : -pos(9_000);
      row = {
        isOpen: false, buyQty: 10, sellQty: 10, sellValue, buyValue: Math.round((sellValue - gross) * 100) / 100,
        grossPnl: gross, chargesTotal: charges, netPnl: Math.round((gross - charges) * 100) / 100,
      };
    } else if (kind === 2) {
      // Open long, marked or not by `closingPrice`.
      const u = money(3_000);
      row = {
        isOpen: true, buyQty: 7, sellQty: 0, sellValue: 0, buyValue: pos(30_000), closingPrice,
        unrealisedPnl: u, grossPnl: 0, chargesTotal: charges, netPnl: -charges,
      };
    } else if (kind === 3) {
      // Open sell-to-open (an opening sell is stored isOpen).
      row = {
        isOpen: true, buyQty: 0, sellQty: 5, sellValue, buyValue: 0, closingPrice,
        grossPnl: 0, chargesTotal: charges, netPnl: -charges, acquisition: i % 2 ? "unknown" : null,
      };
    } else if (kind === 4) {
      // A flagged SALE with no purchase: basis pending, 0 (bonus), or priced.
      const basis = cycle % 3 === 0 ? null : cycle % 3 === 1 ? 0 : pos(900);
      row = {
        acquisition: SALE_FLAGS[cycle % SALE_FLAGS.length],
        isOpen: false, buyQty: 0, sellQty: 12, sellValue, buyValue: 0, acquisitionPrice: basis,
        acquisitionDate: basis == null ? null : "2025-12-01",
        grossPnl: sellValue, chargesTotal: charges, netPnl: Math.round((sellValue - charges) * 100) / 100,
      };
    } else {
      // An open DERIVATIVE, unmarked — the panel must leave it out.
      row = {
        isOpen: true, instrumentType: "option", segment: "fno_options", buyQty: 50, sellQty: 0, buyValue: pos(8_000),
        sellValue: 0, closingPrice, grossPnl: 0, chargesTotal: charges, netPnl: -charges,
      };
    }
    rows.push(tradeRow({
      accountId, symbol: `S${accountId}_${i}`, tradingsymbol: `S${accountId}_${i}`,
      sellDate, createdAt, buyDate: "2025-11-15",
      acquisition, ...row,
    }));
  }
  return rows;
}

/** The whole-book predicate the three panels act on (app/trades/page.tsx). */
const panelPredicate = (r: import("@/lib/queries/trades").JournalTrade) =>
  !!r.acquisition || (r.isOpen && !isMarked(r) && r.instrumentType === "equity");

/** Exactly what app/trades/page.tsx derives from its rows (minus the IPO-link map, a separate read). */
function panels(rows: import("@/lib/queries/trades").JournalTrade[]) {
  const basisRows = rows.map((r) => ({
    id: r.id, symbol: r.symbol, sellValue: r.sellValue, buyValue: r.buyValue,
    sellQty: r.sellQty, netPnl: r.netPnl, chargesTotal: r.chargesTotal, sellDate: r.sellDate,
    acquisition: r.acquisition, acquisitionPrice: r.acquisitionPrice, acquisitionDate: r.acquisitionDate,
  }));
  const pending = rows.filter((r) => !hasKnownBasis(r)).map((r) => ({
    id: r.id, symbol: r.symbol, sellQty: r.sellQty, sellValue: r.sellValue,
    sellDate: r.sellDate, chargesTotal: r.chargesTotal,
    acquisition: r.acquisition, acquisitionPrice: r.acquisitionPrice,
    suggestedPrice: r.suggestedBasisPrice ?? null,
  }));
  const unmarked = rows
    .filter((r) => r.isOpen && !isMarked(r) && r.instrumentType === "equity")
    .map((r) => ({ id: r.id, symbol: r.symbol, buyQty: r.buyQty, buyValue: r.buyValue, buyDate: r.buyDate, acquisition: r.acquisition }));
  return {
    pending,
    unknownBasisIds: pending.map((p) => p.id),
    acq: summariseAcquisitions(basisRows),
    ipo: ipoAllottedPnl(basisRows),
    unmarked,
  };
}

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

beforeAll(async () => {
  t = await openTempDb("trades-kpi-sql", { seed: true });
  trades = await import("@/lib/queries/trades");
  t.db.insert(t.schema.accounts).values({ id: 2, name: "Swing", isDefault: false }).run();
  t.db.insert(t.schema.accounts).values({ id: 3, name: "Zero", isDefault: false }).run();
  t.db.transaction((tx) => {
    tx.insert(t.schema.trades).values(seedAccount(1, 48)).run();
    tx.insert(t.schema.trades).values(seedAccount(2, 30)).run();
    // Account 3 nets to exactly ₹0, in an order whose float reduce lands a hair
    // BELOW zero: 0 + 0.30 − 0.10 − 0.20 = −2.8e-17.
    tx.insert(t.schema.trades).values([
      tradeRow({ accountId: 3, symbol: "Z1", isOpen: false, sellDate: "2026-03-03", netPnl: 0.3, grossPnl: 0.3, chargesTotal: 0 }),
      tradeRow({ accountId: 3, symbol: "Z2", isOpen: false, sellDate: "2026-03-02", netPnl: -0.1, grossPnl: -0.1, chargesTotal: 0 }),
      tradeRow({ accountId: 3, symbol: "Z3", isOpen: false, sellDate: "2026-03-01", netPnl: -0.2, grossPnl: -0.2, chargesTotal: 0 }),
    ]).run();
  });
});

afterAll(() => t?.cleanup());

describe("the seeded book exercises every branch", () => {
  it("has ≥ 60 rows, a tie block, both infinities, '' and null acquisition, and non-equity opens", () => {
    const q = <T>(s: string) => t.sqlite.prepare(s).get() as T;
    expect(q<{ n: number }>("select count(*) n from trades where account_id in (1,2)").n).toBeGreaterThanOrEqual(60);
    expect(q<{ n: number }>(`select count(*) n from trades where sell_date = '${TIE_SELL}' and created_at = '${TIE_CREATED}'`).n).toBeGreaterThan(5);
    expect(q<{ n: number }>("select count(*) n from trades where closing_price = 9e999").n, "+Inf is stored").toBeGreaterThan(0);
    expect(q<{ n: number }>("select count(*) n from trades where closing_price = -9e999").n, "-Inf is stored").toBeGreaterThan(0);
    expect(q<{ n: number }>("select count(*) n from trades where acquisition = ''").n).toBeGreaterThan(0);
    expect(q<{ n: number }>("select count(*) n from trades where acquisition is null").n).toBeGreaterThan(0);
    expect(q<{ n: number }>("select count(*) n from trades where is_open = 1 and instrument_type <> 'equity'").n).toBeGreaterThan(0);
    // NaN cannot be stored: SQLite binds a NaN REAL as NULL — so `isMarked`'s
    // NaN branch reaches the SQL predicate as a NULL mark.
    expect(q<{ n: number }>("select count(*) n from trades where typeof(closing_price) = 'real' and closing_price <> closing_price").n).toBe(0);
  });
});

describe.each([
  ["account 1", 1],
  ["account 2", 2],
  ["All accounts", 0],
])("%s", (_label, accountId) => {
  it("KPI strip: getTradeStatsSql() is bit-identical to tradeStatsOf(getJournalTrades())", () => {
    select(accountId);
    const sql = trades.getTradeStatsSql();
    const js = trades.tradeStatsOf(trades.getJournalTrades());
    expect(Object.keys(sql).sort()).toEqual(Object.keys(js).sort());
    for (const k of Object.keys(js) as (keyof typeof js)[]) expect(sql[k], k).toBe(js[k]);
    expect(sql.count).toBeGreaterThan(0);
    expect(sql.open).toBeGreaterThan(0);
  });

  it("panel rows: getJournalPanelRows() equals the whole book filtered by the panels' predicate, in order", () => {
    select(accountId);
    const whole = trades.getJournalTrades();
    const panelRows = trades.getJournalPanelRows();
    expect(panelRows).toStrictEqual(whole.filter(panelPredicate));
    expect(panelRows.length).toBeLessThan(whole.length);
  });

  it("every panel output is the same from the narrow rows as from the whole book", () => {
    select(accountId);
    const narrow = panels(trades.getJournalPanelRows());
    const wide = panels(trades.getJournalTrades());
    expect(narrow).toStrictEqual(wide);
    expect(narrow.pending.length).toBeGreaterThan(0);
    expect(narrow.unmarked.length).toBeGreaterThan(0);
    expect(narrow.ipo.trades + narrow.ipo.pending).toBeGreaterThan(0);
  });
});

describe("the one deliberate difference: a book that nets to exactly zero", () => {
  it("the float reduce says -0, the integer-paise sum says 0 — every other figure equal", () => {
    select(3);
    const sql = trades.getTradeStatsSql();
    const js = trades.tradeStatsOf(trades.getJournalTrades());
    // net and gross carry the same three values here, so both land on -0.
    expect([Object.is(js.net, -0), Object.is(js.gross, -0)], "the reduce lands on -0").toEqual([true, true]);
    expect([Object.is(sql.net, 0), Object.is(sql.gross, 0)], "the paise sum lands on +0").toEqual([true, true]);
    expect({ ...sql, net: 0, gross: 0 }).toStrictEqual({ ...js, net: 0, gross: 0 });
  });
});
