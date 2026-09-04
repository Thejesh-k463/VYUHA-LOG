import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * v3.9 "Trust the numbers" — the /reports/reconcile screen ("Broker truth").
 *
 * THE ONE PROMISE THIS FILE KEEPS: every figure the screen prints comes out of
 * `reconcile()`. A report that recomputes a total on its way to the page is a
 * second arithmetic path over the same cells, and two screens then show two
 * numbers for one file — the defect `dhanReferenceRows` was written to avoid.
 * So the numbers are seeded here against a temp database, read back through
 * `reconcile()`, and the page's own view model (`lib/analytics/reconcile.ts`,
 * pure) is asserted to reproduce them WITHOUT arithmetic of its own.
 *
 * One temp database per FILE (AGENTS.md), and lib/queries is imported
 * dynamically so `VYUHA_DB_PATH` is set before lib/db binds its connection.
 */

let t: TempDb;
let refq: typeof import("@/lib/queries/reference");
let view: typeof import("@/lib/analytics/reconcile");

const ACCOUNT = 1;
const ROOT = path.resolve(__dirname, "..");

/** Two trades, one closed and one open, both in the same scrip family. */
const SEED = {
  closed: {
    isin: "INE600Y01019", symbol: "DYCL", segment: "eq_delivery",
    sellDate: "2026-07-20", buyQty: 300, sellQty: 300,
    buyValue: 124830.87, sellValue: 125686.47, grossPnl: 855.6, netPnl: 700.6, chargesTotal: 155,
  },
  open: {
    isin: "INE669E01016", symbol: "IDEA", segment: "eq_delivery",
    sellDate: null, buyQty: 500, sellQty: 0,
    buyValue: 5000, sellValue: 0, grossPnl: 0, netPnl: 0, chargesTotal: 0,
  },
};

function insertTrades() {
  const { db, schema } = t;
  db.insert(schema.trades).values([
    tradeRow({
      accountId: ACCOUNT, broker: "dhan", isin: SEED.closed.isin, symbol: SEED.closed.symbol,
      tradingsymbol: SEED.closed.symbol, segment: SEED.closed.segment, sellDate: SEED.closed.sellDate,
      buyQty: SEED.closed.buyQty, sellQty: SEED.closed.sellQty, buyValue: SEED.closed.buyValue,
      sellValue: SEED.closed.sellValue, grossPnl: SEED.closed.grossPnl, netPnl: SEED.closed.netPnl,
      chargesTotal: SEED.closed.chargesTotal, isOpen: false,
    }),
    tradeRow({
      accountId: ACCOUNT, broker: "dhan", isin: SEED.open.isin, symbol: SEED.open.symbol,
      tradingsymbol: SEED.open.symbol, segment: SEED.open.segment, sellDate: null,
      buyQty: SEED.open.buyQty, sellQty: 0, buyValue: SEED.open.buyValue, sellValue: 0,
      grossPnl: 0, netPnl: 0, chargesTotal: 0, isOpen: true,
    }),
  ]).run();
}

function insertReference() {
  const { db, schema } = t;
  const base = { accountId: ACCOUNT, broker: "dhan", sourceId: "dhan-realised-pnl", importBatchId: null as number | null };
  db.insert(schema.brokerReference).values([
    // The Dhan Realised P&L states SEGMENT totals and states its charges.
    {
      ...base, scope: "segment", key: "equity", isin: null, symbol: null, fy: "2026-27", asOf: null,
      figuresJson: JSON.stringify({ buyValue: 124830.87, sellValue: 125686.47, grossPnl: 860, totalCharges: 155, netPnl: 705 }),
      note: null,
    },
    // A Paytm-style FY total and scrip row: no charges stated at all.
    {
      accountId: ACCOUNT, broker: "paytm", sourceId: "paytm-realised-pnl", importBatchId: null,
      scope: "fy", key: "2026-27", isin: null, symbol: null, fy: "2026-27", asOf: null,
      figuresJson: JSON.stringify({ qty: 300, buyValue: 124830.87, sellValue: 125686.47, grossPnl: 855.6 }), note: null,
    },
    {
      accountId: ACCOUNT, broker: "paytm", sourceId: "paytm-realised-pnl", importBatchId: null,
      scope: "scrip", key: SEED.closed.isin, isin: SEED.closed.isin, symbol: "Dynamic Cables Limited",
      fy: "2026-27", asOf: "2026-07-20",
      figuresJson: JSON.stringify({ qty: 300, buyValue: 124830.87, sellValue: 125686.47, grossPnl: 2000 }), note: null,
    },
    // A holdings statement: the broker says 400, the book holds 500 open.
    {
      ...base, sourceId: "dhan-holdings", scope: "holding", key: SEED.open.isin, isin: SEED.open.isin,
      symbol: SEED.open.symbol, fy: null, asOf: "2026-07-01",
      figuresJson: JSON.stringify({ qty: 400, freeQty: 400, closingPrice: 10, valuation: 4000 }), note: null,
    },
  ] as never).run();
}

beforeAll(async () => {
  t = await openTempDb("reconcile-screen", { seed: true });
  refq = await import("@/lib/queries/reference");
  view = await import("@/lib/analytics/reconcile");
  insertTrades();
  insertReference();
});

afterAll(() => t?.cleanup());

describe("reconcile() states every figure the screen shows", () => {
  it("compares the broker's SEGMENT total against the book's own segment family", () => {
    const rec = refq.reconcile(ACCOUNT);
    const eq = rec.segment.find((l) => l.key === "equity");
    expect(eq, "a Dhan Realised P&L states segment totals and nothing else — with no segment line the owner's own file reconciles to an empty screen").toBeTruthy();
    expect(eq!.stated.grossPnl).toBe(860);
    expect(eq!.vyuha.grossPnl).toBe(SEED.closed.grossPnl);
    expect(eq!.delta.grossPnl).toBe(4.4);
    expect(eq!.matched).toBe(true); // ₹4.40 apart, inside max(₹10, 0.5%)
  });

  it("carries the FY on every line, so the scrip table can be filtered by it", () => {
    const rec = refq.reconcile(ACCOUNT);
    expect(rec.scrip.map((l) => l.fy)).toEqual(["2026-27"]);
    expect(rec.fy[0].fy).toBe("2026-27");
  });

  it("keeps a HOLDINGS statement out of the realised scrip figures and states it on its own", () => {
    const rec = refq.reconcile(ACCOUNT);
    expect(rec.scrip.map((l) => l.key), "a demat qty is not a realised qty; summing them invents a delta")
      .toEqual([SEED.closed.isin]);
    expect(rec.holdings).toHaveLength(1);
    const h = rec.holdings[0];
    expect(h.key).toBe(SEED.open.isin);
    expect(h.brokerQty).toBe(400);
    expect(h.vyuhaQty).toBe(500);
    expect(h.delta).toBe(-100);
    expect(h.asOf).toBe("2026-07-01");
  });

  it("names charges the file omits with the figure, and never a generic mismatch", () => {
    const rec = refq.reconcile(ACCOUNT);
    const scrip = rec.scrip[0];
    expect(scrip.matched).toBe(false);
    const charges = scrip.reasons.find((r) => r.code === "charges_omitted");
    expect(charges?.amount).toBe(SEED.closed.chargesTotal);
    // Dhan's segment row DOES state charges, so no omission is claimed there.
    const eq = rec.segment.find((l) => l.key === "equity")!;
    expect(eq.reasons.some((r) => r.code === "charges_omitted")).toBe(false);
  });
});

describe("the view model prints reconcile()'s numbers and computes none of its own", () => {
  it("reads its status off the delta the query stated", () => {
    const rec = refq.reconcile(ACCOUNT);
    const scrip = rec.scrip[0];
    expect(view.lineStatus(scrip)).toBe("broker_higher");
    expect(view.STATUS_LABEL[view.lineStatus(scrip)]).toBe("Broker higher");
    const eq = rec.segment.find((l) => l.key === "equity")!;
    expect(view.lineStatus(eq)).toBe("matched");
    expect(view.STATUS_LABEL.vyuha_higher).toBe("Vyuha higher");
  });

  it("says which identity the row was joined on", () => {
    const rec = refq.reconcile(ACCOUNT);
    expect(view.joinedOn(rec.scrip[0])).toBe("isin");
    expect(view.joinedOn({ ...rec.scrip[0], isin: null, key: "DYCL" })).toBe("symbol");
  });

  it("sorts by the SIZE of the gap, not its sign", () => {
    const lines: { key: string; delta: Record<string, number> }[] = [
      { key: "a", delta: { grossPnl: -5000 } },
      { key: "b", delta: { grossPnl: 12 } },
      { key: "c", delta: {} },
    ];
    expect(view.sortByAbsDelta(lines, "desc").map((l) => l.key)).toEqual(["a", "b", "c"]);
    expect(view.sortByAbsDelta(lines, "asc").map((l) => l.key)).toEqual(["c", "b", "a"]);
  });

  it("filters the scrip table by FY and by broker", () => {
    const rec = refq.reconcile(ACCOUNT);
    expect(view.filterLines(rec.scrip, { fy: "2026-27" })).toHaveLength(1);
    expect(view.filterLines(rec.scrip, { fy: "2025-26" })).toHaveLength(0);
    expect(view.filterLines(rec.scrip, { broker: "paytm" })).toHaveLength(1);
    expect(view.filterLines(rec.scrip, { broker: "dhan" })).toHaveLength(0);
  });

  it("summarises the loaded statements: broker, source, as-of range and row count", () => {
    const rows = refq.getReferenceRows(ACCOUNT);
    const sources = view.summariseSources(rows);
    const paytm = sources.find((s) => s.sourceId === "paytm-realised-pnl")!;
    expect(paytm.broker).toBe("paytm");
    expect(paytm.rows).toBe(2);
    expect(paytm.label).toMatch(/Paytm/i);
    expect(paytm.asOfFrom).toBe("2026-07-20");
    const holdings = sources.find((s) => s.sourceId === "dhan-holdings")!;
    expect(holdings.asOfFrom).toBe("2026-07-01");
    expect(holdings.asOfTo).toBe("2026-07-01");
  });

  it("names the statements that feed the screen, from the import registry", () => {
    expect(view.RECONCILE_FEEDS.length).toBeGreaterThanOrEqual(4);
    for (const f of view.RECONCILE_FEEDS) expect(f.label.length).toBeGreaterThan(0);
  });
});

describe("the page does its arithmetic nowhere but in reconcile()", () => {
  const pageSrc = () => fs.readFileSync(path.join(ROOT, "app", "reports", "reconcile", "page.tsx"), "utf8");
  const tableSrc = () =>
    fs.readFileSync(path.join(ROOT, "components", "reports", "reconcile-tables.tsx"), "utf8");

  it("the page reads reconcile() and hands it over", () => {
    expect(pageSrc()).toMatch(/reconcile\(/);
    expect(pageSrc()).toMatch(/force-dynamic/);
    expect(pageSrc()).toMatch(/ProGate/);
  });

  it("neither file adds, subtracts or divides a stated figure", () => {
    for (const src of [pageSrc(), tableSrc()]) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, "a delta computed on the way to the screen is a second arithmetic path")
        .not.toMatch(/\b(stated|vyuha|delta)\.\w+\s*[-+*/]\s/);
    }
  });
});
