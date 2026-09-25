import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * v4.6.0 W7 (D1, R-2) — THE SEAM: a staged ladder bought across two financial
 * years, written through the REAL write path (`convertToStaged` + `addLeg`, so
 * `rebuildStagedTrade` stores the parent), read back through the REAL
 * POST /api/ais. The purchase side must state each entry in the FY of its own
 * leg date, and the two years must sum to the parent's stored buyValue.
 *
 *   e1  100 @ 20   2026-03-20   (the conversion's own leg)  -> FY 2025-26: 2,000
 *   e2   40 @ 21   2026-04-10                                -> FY 2026-27:   840
 *
 * ONE temp database for the FILE (tests/helpers/temp-db.ts).
 */

let t: TempDb;
let ais: typeof import("@/app/api/ais/route");
let tradeId = 0;

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
  t = await openTempDb("ais-purchase-legs-db", { seed: true });
  const staged = await import("@/lib/queries/staged");
  ais = await import("@/app/api/ais/route");
  t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();

  tradeId = t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        accountId: 1, broker: "zerodha", segment: "eq_delivery",
        symbol: "W7PUR", tradingsymbol: "W7PUR",
        buyQty: 100, avgBuyPrice: 20, buyValue: 2000, buyDate: "2026-03-20",
        isOpen: true,
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;

  expect(staged.convertToStaged(tradeId).ok, "staged mode on").toBe(true);
  const res = staged.addLeg({ tradeId, direction: "long", kind: "entry", tradeDate: "2026-04-10", qty: 40, price: 21 });
  expect(res.ok, res.message).toBe(true);
});

afterAll(() => t?.cleanup());

describe("AIS purchase side — one entry per FY of its own leg date", () => {
  it("states 2,000 in 2025-26 and 840 in 2026-27, summing to the parent's stored buyValue", async () => {
    const parent = t.sqlite.prepare("SELECT buy_value_paise AS v, buy_date AS d FROM trades WHERE id = ?").get(tradeId) as {
      v: number;
      d: string;
    };
    expect(parent.v / 100, "rebuildStagedTrade stored the aggregate (invariant 5)").toBe(2840);
    expect(parent.d, "the parent's buyDate is the FIRST entry").toBe("2026-03-20");

    const totals = await aisTotals();
    expect(totals["2025-26 purchase"], "e1, in the year it was bought").toBe(2000);
    expect(totals["2026-27 purchase"], "e2, in the NEXT year").toBe(840);
    expect(
      Math.round(((totals["2025-26 purchase"] ?? 0) + (totals["2026-27 purchase"] ?? 0)) * 100) / 100,
      "the years sum to the parent, to the paisa",
    ).toBe(parent.v / 100);
    expect(totals["2025-26 sale"] ?? undefined, "nothing sold, nothing stated").toBeUndefined();
  });
});
