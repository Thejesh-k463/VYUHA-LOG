import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * ACCDEL-IPO-RELINK (v4.3.0 wave 2K) — a MERGE never leaves an IPO naming a
 * trade it dropped.
 *
 * A source IPO linked to a source trade the TARGET already records (a dedup
 * identity collision: the same hash, or a hash a target lot holds as a
 * `dedup-alias:` — wave 2I's `heldIdentityHashes` rule) had its holding dropped
 * as the duplicate, and the IPO row then moved to the target UNLINKED. The
 * target's own copy of that trade stayed, so the merged book counted the sale
 * TWICE: once through the target's trade and once through the now-unlinked IPO,
 * because wave 2H's counted-once rule (CAP-IPO-LINK / TAX-IPO-LINK) keys on
 * `ipos.trade_id`. Probe before the fix: capital {equity 490.25, ipo 482.6},
 * and AIS FY totals of 2,000 / 3,000 for ONE allotment of 10 shares.
 *
 * The rule: a dropped duplicate's IPO links are RE-POINTED at the target's
 * surviving collision partner — they are the same trade, which is exactly why
 * the merge drops one — and move to the target like every other IPO row. The
 * snapshot's `ipoRefs` (wave 2J) still records the ORIGINAL (ipoId → source
 * trade), the pre-merge fact.
 *
 * ONE temp database for this file, one account pair per scenario
 * (AGENTS.md Testing).
 */

let t: TempDb;
let mod: typeof import("@/lib/queries/account-delete");
let trash: typeof import("@/lib/trash");
let capital: typeof import("@/lib/queries/capital");
let taxItr: typeof import("@/lib/queries/tax-itr");
let ipoQueries: typeof import("@/lib/queries/ipos");
let ais: typeof import("@/app/api/ais/route");
let trashDir: string;

/** Net of the closed holding both books record. */
const NET = 490.25;
const FY = "2025-26"; // allotment 2026-02-20 and exit 2026-03-02 both fall in it
/** A 40-hex dedup hash, the only shape `lotIdentityHashes` reads as an alias. */
const ALIAS = "0123456789abcdef0123456789abcdef01234567";

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

/** One closed round trip: 10 shares bought at 100, sold at 150, net NET. */
function closedTrade(accountId: number, symbol: string, over: Record<string, unknown> = {}): number {
  return t.db
    .insert(t.schema.trades)
    .values(tradeRow({
      accountId, broker: "zerodha", segment: "eq_delivery", symbol, tradingsymbol: symbol,
      buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20",
      sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02",
      grossPnl: 500, chargesTotal: 500 - NET, netPnl: NET, isOpen: false,
      ...over,
    }))
    .returning({ id: t.schema.trades.id })
    .get()!.id;
}

/** A sell-only open row — the shape a Data Quality join consumes into a lot. */
function saleRow(accountId: number, symbol: string, over: Record<string, unknown> = {}): number {
  return t.db
    .insert(t.schema.trades)
    .values(tradeRow({
      accountId, broker: "zerodha", segment: "eq_delivery", symbol, tradingsymbol: symbol,
      sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", isOpen: true,
      ...over,
    }))
    .returning({ id: t.schema.trades.id })
    .get()!.id;
}

/** An exited allotment, optionally linked to a holding. */
function exitedIpo(accountId: number, name: string, tradeId: number | null): number {
  return t.db
    .insert(t.schema.ipos)
    .values({
      accountId, name, broker: "zerodha", exchange: "NSE",
      appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10,
      listingPrice: 130, exitPrice: 150,
      allotmentDate: "2026-02-20", listingDate: "2026-02-24", exitDate: "2026-03-02",
      tradeId,
    })
    .returning({ id: t.schema.ipos.id })
    .get()!.id;
}

const ipoRow = (id: number) => t.db.select().from(t.schema.ipos).all().find((r) => r.id === id)!;
const linkOf = (id: number) => [ipoRow(id).accountId, ipoRow(id).tradeId];

function ipoRefsOf(snapshotId: string): { ipoId: number; tradeId: number }[] | undefined {
  const env = JSON.parse(fs.readFileSync(path.join(trashDir, snapshotId, "snapshot.json"), "utf8")) as {
    ipoRefs?: { ipoId: number; tradeId: number }[];
  };
  return env.ipoRefs;
}

/** The capital summary as the account's own page reads it. */
function realisedIn(accountId: number) {
  select(accountId);
  const c = capital.getCapitalSummary();
  return { equityRealised: c.equityRealised, ipoRealised: c.ipoRealised, totalRealised: c.totalRealised };
}

/** The tax base as /reports/tax and /api/tax-itr read it. */
function taxIn(accountId: number) {
  select(accountId);
  const base = taxItr.getTaxBase();
  return { ipoNames: base.exitedIpos.map((r) => r.name), cgNets: base.cgTrades.map((r) => r.netPnl), itrRows: taxItr.countItrRows() };
}

/** POST /api/ais with nothing to parse: every journal FY total surfaces as its own figure. */
async function aisIn(accountId: number): Promise<Record<string, number | null>> {
  select(accountId);
  const res = await ais.POST(
    new Request("http://local/api/ais", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "nothing to parse" }) }),
  );
  expect(res.status).toBe(200);
  const { recon } = (await res.json()) as { recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] } };
  return Object.fromEntries(recon.fyTotals.map((f) => [`${f.fy} ${f.kind}`, f.journal]));
}

// The raised hook timeout is for the Windows runner, >15x slower on SQLite-file
// work (AGENTS.md Testing); locally the hook is migrate + seed only.
beforeAll(async () => {
  t = await openTempDb("account-merge-ipo-relink", { seed: true });
  mod = await import("@/lib/queries/account-delete");
  trash = await import("@/lib/trash");
  capital = await import("@/lib/queries/capital");
  taxItr = await import("@/lib/queries/tax-itr");
  ipoQueries = await import("@/lib/queries/ipos");
  ais = await import("@/app/api/ais/route");
  trashDir = (await import("@/lib/db")).trashDir;
  // The seed's account 1 ("Primary", default, live) is the last-live anchor.
  for (const [id, name] of [
    [11, "K1 target"], [12, "K1 source"],
    [13, "K1 alias target"], [14, "K1 alias source"],
    [15, "K1 plain target"], [16, "K1 plain source"],
    [17, "L7 claimed target"], [18, "L7 claimed source"],
    [19, "L7 two target"], [20, "L7 two source"],
  ] as [number, string][]) {
    t.db.insert(t.schema.accounts).values({ id, name }).run();
  }
  select(1);
}, 60_000);

afterAll(() => t?.cleanup());

describe("a same-hash duplicate's IPO follows the target's surviving copy", () => {
  const HASH = "k1-merge-ipo-same";
  let targetTrade = 0;
  let sourceTrade = 0;
  let ipoId = 0;
  let snapshotId = "";

  it("baseline: the source book counts its linked sale once before any merge", () => {
    // The two rows carry the SAME (broker, dedup identity) — that is what makes
    // the source row a duplicate the merge drops.
    targetTrade = closedTrade(11, "K1SAME", { dedupHash: HASH });
    sourceTrade = closedTrade(12, "K1SAME", { dedupHash: HASH });
    ipoId = exitedIpo(12, "K1-SAME-IPO", sourceTrade);
    expect(realisedIn(12)).toEqual({ equityRealised: NET, ipoRealised: 0, totalRealised: NET });
  });

  it("the preview names the link that will be re-pointed, before the user presses anything", () => {
    select(1);
    const pv = mod.previewAccountDelete({ accountId: 12, mode: "merge", targetId: 11 });
    expect(pv.dedupCollisions).toBe(1);
    expect(pv.warnings?.join(" ")).toContain("re-pointed");
  });

  it("the merge re-points it at the target's surviving copy", () => {
    select(1);
    const res = mod.deleteAccount({ accountId: 12, mode: "merge", targetId: 11, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 1]);
    snapshotId = res.snapshotId!;
    // THE assertion: the row moved to the target AND names the target's copy —
    // never null, which is what counted the sale twice.
    expect(linkOf(ipoId)).toEqual([11, targetTrade]);
    expect(res.message).toContain("1 IPO link re-pointed");
  });

  it("so the merged book counts that sale ONCE — capital, tax base and the AIS sale side", async () => {
    // Unfixed, this read capital {equity 490.25, ipo 482.6, total 972.85},
    // tax {ipoNames ["K1-SAME-IPO"], cgNets [490.25, 482.6], itrRows 2} and AIS
    // {purchase 2000, sale 3000} — one allotment of 10 shares, counted twice.
    expect(realisedIn(11)).toEqual({ equityRealised: NET, ipoRealised: 0, totalRealised: NET });
    expect(taxIn(11)).toEqual({ ipoNames: [], cgNets: [NET], itrRows: 1 });
    expect(await aisIn(11)).toEqual({ [`${FY} purchase`]: 1000, [`${FY} sale`]: 1500 });
    // /ipos reads the IPO book alone (wave 2H), so a re-point must not have
    // changed the row's own figures.
    select(11);
    expect(ipoQueries.getIposComputed().summary.realisedNet).toBeGreaterThan(400);
  });

  it("the snapshot still records the ORIGINAL link (ipoRefs, wave 2J) and the duplicate restores", () => {
    expect(ipoRefsOf(snapshotId)).toEqual([{ ipoId, tradeId: sourceTrade }]);
    const back = trash.restoreTrashSnapshot(snapshotId, "wave 2K probe");
    expect([back.ok, back.restored]).toEqual([true, 1]);
    expect(t.db.select().from(t.schema.trades).all().map((r) => r.id)).toContain(sourceTrade);
    // The re-point is a link the MERGE set, and `restoreTrashSnapshot` re-links
    // only a row whose `trade_id` is still NULL — "a link someone set since the
    // delete is their decision, not this restore's to overwrite". So the IPO
    // keeps naming the target's copy (the row it now sits beside), the restored
    // duplicate comes back unlinked, and the sale is still counted once in each
    // book. The pre-merge fact is in the envelope either way.
    expect(linkOf(ipoId)).toEqual([11, targetTrade]);
  });
});

describe("an alias collision's IPO follows the target LOT that holds the dropped sale", () => {
  let lotId = 0;
  let sourceSale = 0;
  let ipoId = 0;

  it("the source sale is dropped as a duplicate and its IPO names the lot, in the target", () => {
    lotId = closedTrade(13, "K1ALIAS", { importNotes: `dedup-alias:${ALIAS}` });
    sourceSale = saleRow(14, "K1ALIAS", { dedupHash: ALIAS });
    ipoId = exitedIpo(14, "K1-ALIAS-IPO", sourceSale);

    select(1);
    const res = mod.deleteAccount({ accountId: 14, mode: "merge", targetId: 13, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 1]);
    expect(linkOf(ipoId)).toEqual([13, lotId]);
    expect(t.db.select().from(t.schema.trades).all().map((r) => r.id)).not.toContain(sourceSale);
  });
});

/**
 * L7 (v4.3.0 wave 2L) — K1's re-point, bounded by the rule the rest of the app
 * already keeps: ONE trade takes ONE IPO record.
 *
 * `pushTradeToIpoAction` refuses to create a second record for a holding that
 * already has one ("Already linked to an IPO record"). The merge could reach that
 * state anyway: when the TARGET's surviving copy already carries its own IPO, the
 * dropped duplicate's record was re-pointed onto the same trade, so /ipos listed
 * two rows both marked linked to one holding, either of which syncs onto that one
 * trade row when edited, and `getIpoTradeLinks()` kept only the last (the /trades
 * badge pointing at the foreign record).
 *
 * So a record whose partner is already spoken for is SKIPPED, exactly as its
 * trade is: this account's own copy is snapshotted and deleted, so the source
 * book restores whole, and the envelope's `ipoRefs` states the pre-merge link
 * either way.
 */
describe("L7 · a duplicate IPO record is skipped, never re-pointed onto a trade that already has one", () => {
  const HASH = "l7-merge-ipo-claimed";
  let targetTrade = 0;
  let sourceTrade = 0;
  let targetIpo = 0;
  let sourceIpo = 0;
  let snapshotId = "";

  const naming = (tradeId: number) =>
    t.db.select().from(t.schema.ipos).all().filter((r) => r.tradeId === tradeId).map((r) => r.id);

  it("the merge leaves exactly ONE ipos row naming the surviving copy", () => {
    targetTrade = closedTrade(17, "L7DBL", { dedupHash: HASH });
    sourceTrade = closedTrade(18, "L7DBL", { dedupHash: HASH });
    targetIpo = exitedIpo(17, "L7-DBL-TGT", targetTrade);
    sourceIpo = exitedIpo(18, "L7-DBL-SRC", sourceTrade);

    select(1);
    const res = mod.deleteAccount({ accountId: 18, mode: "merge", targetId: 17, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 1]);
    snapshotId = res.snapshotId!;
    // THE assertion: the target's own record is the one record that names it.
    expect(naming(targetTrade), "one trade takes one IPO record").toEqual([targetIpo]);
    expect(t.db.select().from(t.schema.ipos).all().map((r) => r.id)).not.toContain(sourceIpo);
    // Reported in the same breath as the duplicate trade, and recoverable the
    // same way — a record that just vanished would be the silent drop the merge
    // counts exist to prevent.
    expect(res.message).toBe(
      "Merged “L7 claimed source” into “L7 claimed target” — 0 trades moved, 1 duplicate skipped (saved to Deleted items), " +
        "1 duplicate IPO record skipped (“L7 claimed target”'s own copy of that trade already carries one; saved to Deleted items).",
    );
    expect(res.message).not.toContain("IPO link re-pointed");
  });

  it("the merged book still counts that sale once", async () => {
    expect(realisedIn(17)).toEqual({ equityRealised: NET, ipoRealised: 0, totalRealised: NET });
    expect(taxIn(17)).toEqual({ ipoNames: [], cgNets: [NET], itrRows: 1 });
    expect(await aisIn(17)).toEqual({ [`${FY} purchase`]: 1000, [`${FY} sale`]: 1500 });
  });

  it("the skipped record is in the snapshot and rides back with the source book", () => {
    expect(ipoRefsOf(snapshotId)).toEqual([{ ipoId: sourceIpo, tradeId: sourceTrade }]);
    const back = trash.restoreTrashSnapshot(snapshotId, "wave 2L probe");
    expect([back.ok, back.restored]).toEqual([true, 1]);
    // The source book is whole again: its duplicate AND the record that named it,
    // in its own account, still linked.
    expect(linkOf(sourceIpo)).toEqual([18, sourceTrade]);
    expect(linkOf(targetIpo)).toEqual([17, targetTrade]);
  });
});

describe("L7 · the preview counts dropped TRADES, and a second record on one dropped trade is skipped too", () => {
  const HASH = "l7-merge-ipo-two";

  it("“1 dropped trade carries 2 IPO records”, and only the first follows the survivor", () => {
    const targetTrade = closedTrade(19, "L7TWO", { dedupHash: HASH });
    const sourceTrade = closedTrade(20, "L7TWO", { dedupHash: HASH });
    const first = exitedIpo(20, "L7-TWO-A", sourceTrade);
    const second = exitedIpo(20, "L7-TWO-B", sourceTrade);

    select(1);
    const pv = mod.previewAccountDelete({ accountId: 20, mode: "merge", targetId: 19 });
    expect(pv.dedupCollisions).toBe(1);
    // THE assertion: the count that pluralises is the dropped TRADES, not the
    // records they carry — one dropped trade reading as "2 … are linked to those
    // trades" described a blast radius twice the size of the real one.
    expect(pv.warnings?.find((w) => w.includes("IPO record"))).toBe(
      "1 dropped trade carries 2 IPO records — 1 will be re-pointed to “L7 two target”'s own copy of that trade, " +
        "never left unlinked (an unlinked exited IPO beside the target's copy counts that sale twice); " +
        "1 will be skipped, because one trade takes one IPO record (this account's own copy is saved to Deleted items; " +
        "a record filed in another account is left unlinked).",
    );

    const res = mod.deleteAccount({ accountId: 20, mode: "merge", targetId: 19, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 1]);
    expect(
      t.db.select().from(t.schema.ipos).all().filter((r) => r.tradeId === targetTrade).map((r) => r.id),
      "the survivor takes one record, not both",
    ).toEqual([first]);
    expect(t.db.select().from(t.schema.ipos).all().map((r) => r.id)).not.toContain(second);
    expect(res.message).toContain("1 IPO link re-pointed");
    expect(res.message).toContain("1 duplicate IPO record skipped");
  });
});

describe("a dropped trade with no IPO changes nothing", () => {
  const HASH = "k1-merge-ipo-plain";
  let movingTrade = 0;
  let linkedIpo = 0;
  let looseIpo = 0;

  it("the moving trade keeps its own link and an unlinked IPO stays unlinked; the snapshot carries no ipoRefs", () => {
    closedTrade(15, "K1PLAIN", { dedupHash: HASH });
    closedTrade(16, "K1PLAIN", { dedupHash: HASH });
    movingTrade = closedTrade(16, "K1MOVES");
    linkedIpo = exitedIpo(16, "K1-MOVES-IPO", movingTrade);
    looseIpo = exitedIpo(16, "K1-LOOSE-IPO", null);

    select(1);
    const res = mod.deleteAccount({ accountId: 16, mode: "merge", targetId: 15, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 1]);
    expect(res.message).not.toContain("IPO link re-pointed");
    expect(linkOf(linkedIpo)).toEqual([15, movingTrade]);
    expect(linkOf(looseIpo)).toEqual([15, null]);
    expect(ipoRefsOf(res.snapshotId!)).toBeUndefined();
  });
});
