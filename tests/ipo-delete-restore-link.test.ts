import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * IPO-TRASH (v4.3.0 wave 2I) — the IPO ↔ holding link survives a delete and a
 * restore, so the counted-once rule the wave built still holds afterwards.
 *
 * CAP-IPO-LINK / TAX-IPO-LINK count a linked, exited IPO's sale ONCE by keying
 * on `ipos.trade_id`. `deleteTradesByIds` nulls that column (the IPO record is
 * deliberately KEPT — lib/queries/delete.ts's header) but wrote NO `ipoRefs`
 * into the trash envelope, while `restoreTrashSnapshot`'s re-link loop reads
 * exactly that field (lib/trash.ts: only `removeBrokerRows` ever wrote it).
 * So a /trades delete followed by a Trash restore brought the trade back under
 * its own id with the link silently gone, and the same sale was then counted
 * twice in the capital summary (and through it `available`/compounding), in the
 * tax pack, in the ITR export and on both AIS sides — the exact wrong number
 * wave 2H had just fixed, with nothing on screen saying the link had gone.
 *
 * ONE temp database for this file (AGENTS.md Testing).
 */

let t: TempDb;
let del: typeof import("@/lib/queries/delete");
let trash: typeof import("@/lib/trash");
let capital: typeof import("@/lib/queries/capital");
let taxItr: typeof import("@/lib/queries/tax-itr");
let ipoQueries: typeof import("@/lib/queries/ipos");
let ais: typeof import("@/app/api/ais/route");

const TRADE_NET = 490.25;
const FY = "2025-26"; // allotment 2026-02-20 and exit 2026-03-02 both fall in it
const SYM = "TRASHIPO";

let tradeId = 0;
let ipoId = 0;

const ipoRow = () => t.db.select().from(t.schema.ipos).all().find((r) => r.id === ipoId)!;

/** The three consumers, read exactly as their pages read them. */
function counted() {
  const c = capital.getCapitalSummary();
  return {
    capital: [c.equityRealised, c.ipoRealised, c.totalRealised],
    itrScrips: taxItr.getItrExportRows().map((r) => r.scrip),
    itrCount: taxItr.countItrRows(),
  };
}

async function aisTotals(): Promise<Record<string, number | null>> {
  const res = await ais.POST(
    new Request("http://local/api/ais", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "nothing to parse" }) }),
  );
  expect(res.status).toBe(200);
  const { recon } = (await res.json()) as { recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] } };
  return Object.fromEntries(recon.fyTotals.map((f) => [`${f.fy} ${f.kind}`, f.journal]));
}

beforeAll(async () => {
  t = await openTempDb("ipo-delete-restore-link", { seed: true });
  del = await import("@/lib/queries/delete");
  trash = await import("@/lib/trash");
  capital = await import("@/lib/queries/capital");
  taxItr = await import("@/lib/queries/tax-itr");
  ipoQueries = await import("@/lib/queries/ipos");
  ais = await import("@/app/api/ais/route");
  t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();

  tradeId = t.db
    .insert(t.schema.trades)
    .values(tradeRow({
      accountId: 1, broker: "zerodha", segment: "eq_delivery", symbol: SYM, tradingsymbol: SYM,
      buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20",
      sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02",
      grossPnl: 500, chargesTotal: 500 - TRADE_NET, netPnl: TRADE_NET, isOpen: false,
    }))
    .returning({ id: t.schema.trades.id })
    .get()!.id;

  ipoId = t.db
    .insert(t.schema.ipos)
    .values({
      accountId: 1, name: "TRASH-IPO", broker: "zerodha", exchange: "NSE",
      appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10,
      listingPrice: 130, exitPrice: 150,
      allotmentDate: "2026-02-20", listingDate: "2026-02-24", exitDate: "2026-03-02",
      tradeId,
    })
    .returning({ id: t.schema.ipos.id })
    .get()!.id;
}, 30_000);

afterAll(() => t?.cleanup());

describe("a linked IPO's sale is still counted ONCE after a delete and a restore", () => {
  let snapshotId = "";

  it("baseline: the sale is counted once, from the holding", async () => {
    // A vacuous test guard: the IPO's own net must differ from the holding's.
    const ipoNet = ipoQueries.getIposComputed().summary.realisedNet;
    expect(ipoNet).toBeGreaterThan(400);
    expect(ipoNet).not.toBe(TRADE_NET);

    expect(counted()).toEqual({ capital: [TRADE_NET, 0, TRADE_NET], itrScrips: [SYM], itrCount: 1 });
    expect(await aisTotals()).toEqual({ [`${FY} purchase`]: 1000, [`${FY} sale`]: 1500 });
  });

  it("deleted on /trades: the holding is gone and only the IPO counts (nothing lost)", async () => {
    const res = del.deleteTradesByIds([tradeId], "wave 2I probe");
    expect([res.ok, res.deleted]).toEqual([true, 1]);
    snapshotId = res.snapshotId!;
    expect(snapshotId).toBeTruthy();

    const ipoNet = ipoQueries.getIposComputed().summary.realisedNet;
    expect(ipoRow().tradeId).toBeNull();
    expect(counted()).toEqual({ capital: [0, ipoNet, ipoNet], itrScrips: ["TRASH-IPO (IPO)"], itrCount: 1 });
    expect(await aisTotals()).toEqual({ [`${FY} purchase`]: 1000, [`${FY} sale`]: 1500 });
  });

  it("restored from Trash: ipos.trade_id points at the restored trade again", () => {
    const res = trash.restoreTrashSnapshot(snapshotId, "wave 2I probe");
    expect([res.ok, res.restored]).toEqual([true, 1]);
    expect(t.db.select().from(t.schema.trades).all().map((r) => r.id)).toEqual([tradeId]);
    // THE assertion: the link the delete took away comes back with the trade.
    expect(ipoRow().tradeId).toBe(tradeId);
  });

  it("and the capital summary, the tax pack / ITR export and AIS each count the sale ONCE, not twice", async () => {
    expect(counted()).toEqual({ capital: [TRADE_NET, 0, TRADE_NET], itrScrips: [SYM], itrCount: 1 });
    expect(await aisTotals()).toEqual({ [`${FY} purchase`]: 1000, [`${FY} sale`]: 1500 });
  });
});
