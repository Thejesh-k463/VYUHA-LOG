import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * WAVE 3b-ii (P1) — THE SEAM: a staged ladder written through the REAL write
 * path, read back through the REAL consumers.
 *
 * tests/realised-rows.test.ts pins the split as arithmetic over hand-built
 * ladders. What it cannot see is whether the split agrees with what
 * `rebuildStagedTrade` actually STORES on the parent (invariant 5) once the
 * charges engine has priced every leg — and whether the fills then reach the
 * tax base, the ITR export and the AIS sale side in the FY of their OWN exit
 * date. That is I/O, so it is tested against a database.
 *
 * ── THE LADDER ──────────────────────────────────────────────────────────────
 *
 *   e1  100 @ 20   2024-06-10     (the conversion's own leg, from the parent)
 *   e2  100 @ 30   2024-08-12
 *   x1  100 @ 40   2025-02-10     <- FY 2024-25
 *   x2  100 @ 50   2025-06-16     <- FY 2025-26
 *
 * The moving average at x1 is (2000 + 3000) / 200 = 25.00, so x1 books
 * (40 − 25) × 100 = 1500 of gross and FIFO retires e1 whole. The remaining 100
 * still cost 25.00, so x2 books (50 − 25) × 100 = 2500 and retires e2. Two
 * fills, two tranches, two financial years, one row each.
 *
 * Every MONEY literal below is that arithmetic. Every CHARGE figure is READ —
 * out of `trade_legs`, which the engine priced (invariant 3) — so nothing here
 * re-implements the charges engine and then agrees with itself.
 *
 * ONE temp database for the FILE: `lib/db` caches its connection on
 * `globalThis`, so a second `openTempDb()` here would silently reuse this one.
 */

let t: TempDb;
let staged: typeof import("@/lib/queries/staged");
let taxItr: typeof import("@/lib/queries/tax-itr");
let tax: typeof import("@/lib/analytics/tax");
let ais: typeof import("@/app/api/ais/route");
let realised: typeof import("@/lib/analytics/realised-rows");

const ACCOUNT = 1; // the seeded default
const SYMBOL = "RRSTG";
let tradeId = 0;

/** Every stored column of every trade row, as SQLite holds it. */
const dumpTrades = () => JSON.stringify(t.sqlite.prepare("SELECT * FROM trades ORDER BY id").all());
const dumpLegs = () => JSON.stringify(t.sqlite.prepare("SELECT * FROM trade_legs ORDER BY id").all());

const parentRow = () =>
  t.db.select().from(t.schema.trades).where(eqId(tradeId)).get()!;
// drizzle's eq, imported lazily with the schema to keep lib/db out of the
// static graph (tests/helpers/temp-db.ts: the dynamic-import rule).
let eqId: (id: number) => ReturnType<typeof import("drizzle-orm").eq>;

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (ns: number[]) => r2(ns.reduce((a, b) => a + b, 0));

/** POST /api/ais with nothing to parse: the journal's own FY totals surface. */
async function aisTotals(): Promise<Record<string, number | null>> {
  const res = await ais.POST(
    new Request("http://local/api/ais", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "nothing to parse" }),
    }),
  );
  expect(res.status, "the AIS route answered").toBe(200);
  const { recon } = (await res.json()) as {
    recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] };
  };
  return Object.fromEntries(recon.fyTotals.map((f) => [`${f.fy} ${f.kind}`, f.journal]));
}

beforeAll(async () => {
  t = await openTempDb("realised-rows-db", { seed: true });
  const { eq } = await import("drizzle-orm");
  eqId = (id: number) => eq(t.schema.trades.id, id);

  staged = await import("@/lib/queries/staged");
  taxItr = await import("@/lib/queries/tax-itr");
  tax = await import("@/lib/analytics/tax");
  ais = await import("@/app/api/ais/route");
  realised = await import("@/lib/analytics/realised-rows");

  t.db.update(t.schema.settings).set({ selectedAccountId: ACCOUNT }).run();

  tradeId = t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        accountId: ACCOUNT, broker: "zerodha", segment: "eq_delivery",
        symbol: SYMBOL, tradingsymbol: SYMBOL,
        buyQty: 100, avgBuyPrice: 20, buyValue: 2000, buyDate: "2024-06-10",
        isOpen: true,
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;

  // THE REAL WRITE PATH — `convertToStaged` seeds e1 from the parent, `addLeg`
  // appends and reprices the whole ladder through `rebuildStagedTrade`.
  expect(staged.convertToStaged(tradeId).ok, "staged mode on").toBe(true);
  for (const leg of [
    { kind: "entry" as const, tradeDate: "2024-08-12", qty: 100, price: 30 },
    { kind: "exit" as const, tradeDate: "2025-02-10", qty: 100, price: 40 },
    { kind: "exit" as const, tradeDate: "2025-06-16", qty: 100, price: 50 },
  ]) {
    const res = staged.addLeg({ tradeId, direction: "long", ...leg });
    expect(res.ok, `${leg.kind} ${leg.tradeDate}: ${res.message}`).toBe(true);
  }
});

afterAll(() => t?.cleanup());

/** The ladder as the database now holds it, and the split over it. */
function ladderNow() {
  const view = staged.getStagedView(tradeId)!;
  const legs = staged.toDomainLegs(view.legs);
  const parent = parentRow();
  const rows = realised.splitStagedRow(
    parent as unknown as import("@/lib/analytics/realised-rows").RealisedParent & { id: number },
    legs,
    view.position,
  );
  return { view, legs, parent, rows };
}

/** One leg's stored charges, by kind and date — the engine's own figure. */
const legCharges = (kind: string, tradeDate: string) => {
  const rows = t.sqlite
    .prepare("SELECT charges_total_paise AS c FROM trade_legs WHERE trade_id = ? AND kind = ? AND trade_date = ?")
    .all(tradeId, kind, tradeDate) as { c: number }[];
  expect(rows.length, `exactly one ${kind} leg on ${tradeDate}`).toBe(1);
  return rows[0].c / 100; // paise in the DB, rupees at runtime (invariant 1)
};

describe("the ladder the real write path stored", () => {
  it("closed, with the aggregate on the parent (invariant 5)", () => {
    const p = parentRow();
    expect([p.staged, p.isOpen], "four legs in, the position is closed").toEqual([true, false]);
    expect([p.buyQty, p.buyValue, p.sellQty, p.sellValue], "100+100 in at 20 and 30, 100+100 out at 40 and 50")
      .toEqual([200, 5000, 200, 9000]);
    expect([p.buyDate, p.sellDate], "the parent states the FIRST entry and the LAST exit")
      .toEqual(["2024-06-10", "2025-06-16"]);
    expect(p.grossPnl, "9000 − 5000").toBe(4000);
    expect(p.netPnl, "gross less every leg's charges").toBe(
      r2(4000 - sum([
        legCharges("entry", "2024-06-10"), legCharges("entry", "2024-08-12"),
        legCharges("exit", "2025-02-10"), legCharges("exit", "2025-06-16"),
      ])),
    );
  });

  it("splits into one row per fill, and reconciles to the STORED parent on every field", () => {
    const { parent, rows } = ladderNow();
    expect(rows.map((r) => [r.realisedQty, r.buyDate, r.sellDate])).toEqual([
      [100, "2024-06-10", "2025-02-10"],
      [100, "2024-08-12", "2025-06-16"],
    ]);
    // THE seam: the split's target is the parent the rebuild wrote, so the two
    // halves of the wave cannot drift apart by a paisa.
    expect(
      reconcile(parent, rows),
      "a closed ladder's split IS the parent's aggregate",
    ).toEqual([
      ["buyValue", 0], ["sellValue", 0], ["grossPnl", 0], ["chargesTotal", 0], ["netPnl", 0],
      ["sttCtt", 0], ["mtfInterest", 0], ["pledgeCharges", 0],
    ]);
    // …and each row's money is the fixture's arithmetic, not a re-derivation.
    expect(rows.map((r) => [r.sellValue, r.grossPnl])).toEqual([[4000, 1500], [5000, 2500]]);
    expect(rows.map((r) => r.chargesTotal)).toEqual([
      r2(legCharges("exit", "2025-02-10") + legCharges("entry", "2024-06-10")),
      r2(legCharges("exit", "2025-06-16") + legCharges("entry", "2024-08-12")),
    ]);
  });
});

function reconcile(parent: unknown, rows: unknown) {
  return realised
    .reconcileStagedSplit(
      parent as never,
      rows as never,
    )
    .map((d) => [d.field, d.diff]);
}

describe("each fill is taxed in the FY of its OWN exit date", () => {
  it("taxByFy books 2024-25 and 2025-26 separately, and the two sum to the parent", () => {
    const base = taxItr.getTaxBase();
    expect(base.scope.accountIds, "one account, one person").toEqual([ACCOUNT]);
    const fyRows = tax.taxByFy(base.taxRows, 4);
    expect(fyRows.map((r) => r.fy), "TWO years — before this wave the whole aggregate sat in 2025-26 alone")
      .toEqual(["2024-25", "2025-26"]);
    const byFy = new Map(fyRows.map((r) => [r.fy, r.totalRealised]));
    // 1500 − (x1's charges + e1's, which x1 consumed whole), and
    // 2500 − (x2's charges + e2's). Both read out of `trade_legs`.
    expect(byFy.get("2024-25")).toBe(r2(1500 - legCharges("exit", "2025-02-10") - legCharges("entry", "2024-06-10")));
    expect(byFy.get("2025-26")).toBe(r2(2500 - legCharges("exit", "2025-06-16") - legCharges("entry", "2024-08-12")));
    expect(sum([...byFy.values()]), "and together they are the parent's stored net")
      .toBe(parentRow().netPnl);
  });

  it("the ITR export states each fill ONCE, with the tranche's own acquisition date", () => {
    const rows = taxItr.getItrExportRows().filter((r) => r.scrip === SYMBOL);
    expect(rows.map((r) => [r.acquired, r.sold, r.consideration, r.cost]), "cost = qty x the moving average at the exit")
      .toEqual([
        ["2024-06-10", "2025-02-10", 4000, 2500],
        ["2024-08-12", "2025-06-16", 5000, 2500],
      ]);
    expect(sum(rows.map((r) => r.consideration)), "the parent's whole sale, counted once").toBe(9000);
    expect(sum(rows.map((r) => r.cost)), "and its whole cost basis").toBe(5000);
    expect(taxItr.countItrRows(), "the page's own row count agrees").toBe(rows.length);
  });

  it("the AIS sale side states each fill in its own year; the purchase side is unchanged", async () => {
    const totals = await aisTotals();
    expect(totals["2024-25 sale"], "the February fill, in the year it was sold").toBe(4000);
    expect(totals["2025-26 sale"], "the June fill, in the next one").toBe(5000);
    // Since v4.6.0 W7 (D1) the purchase side IS split per entry leg
    // (app/api/ais/route.ts, `purchaseRows`), each in the FY of its own leg
    // date. Both of THIS ladder's entries (2024-06-10 and 2024-08-12) fall in
    // 2024-25, so e1's 2000 and e2's 3000 still state 5000 there; the
    // cross-FY split is pinned in tests/ais-purchase-legs-db.test.ts.
    expect(totals["2024-25 purchase"]).toBe(5000);
    expect(totals["2025-26 purchase"], "no purchase in the second year").toBeUndefined();
  });
});

describe("the whole realised render is READ-ONLY", () => {
  it("a full getTaxBase / taxByFy / ITR export pass writes no stored column", async () => {
    const beforeTrades = dumpTrades();
    const beforeLegs = dumpLegs();

    const base = taxItr.getTaxBase();
    const fyRows = tax.taxByFy([...base.taxRows, ...base.ipoTaxRows], 4);
    const exported = taxItr.getItrExportRows();
    await aisTotals();

    expect(fyRows.length).toBeGreaterThan(0);
    expect(exported.length).toBeGreaterThan(0);
    // The split happens in memory: nothing about it is persisted, so the ladder
    // and its parent are byte-identical afterwards (mirrors
    // tests/tax-heads-readonly.test.ts).
    expect(dumpTrades()).toBe(beforeTrades);
    expect(dumpLegs()).toBe(beforeLegs);
  });
});
