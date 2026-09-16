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
let dq: typeof import("@/lib/queries/data-quality");
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

/**
 * The ITR export's scrip column, narrowed to the names ONE scenario owns.
 *
 * The All-accounts view reads every book in this file's single temp database
 * (AGENTS.md: one temp database per FILE), so an absolute total there would be
 * every scenario's. A scrip filter is still absolute about the one thing under
 * test: how many rows the export emits for THIS sale.
 */
function itrScripsIn(accountId: number, names: string[]): string[] {
  select(accountId);
  return taxItr.getItrExportRows().map((r) => r.scrip).filter((s) => names.includes(s)).sort();
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
  dq = await import("@/lib/queries/data-quality");
  ais = await import("@/app/api/ais/route");
  trashDir = (await import("@/lib/db")).trashDir;
  // The seed's account 1 ("Primary", default, live) is the last-live anchor.
  for (const [id, name] of [
    [11, "K1 target"], [12, "K1 source"],
    [13, "K1 alias target"], [14, "K1 alias source"],
    [15, "K1 plain target"], [16, "K1 plain source"],
    [17, "L7 claimed target"], [18, "L7 claimed source"],
    [19, "L7 two target"], [20, "L7 two source"],
    // D5 (fix wave 2N, re-check finding identity#0): a skipped record filed
    // OUTSIDE the book being merged — in a third account, and in the target's.
    [31, "D5 legacy holder"], [32, "D5 third target"], [33, "D5 third source"],
    [34, "D5 own-book target"], [35, "D5 own-book source"],
    // D4 (fix wave 2O, re-check finding identity#0): the un-merge that CANNOT
    // bring the duplicate back, so the record it named has no holding to name.
    [36, "D4 legacy holder"], [37, "D4 taken target"], [38, "D4 taken source"],
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
    // MOVED by D5 (wave 2N, identity#0): "skipped … saved to Deleted items" was
    // true only of the source's OWN copies; a skipped record in any other book
    // was left unlinked, which is a silent double count. Every skipped record is
    // now removed with the duplicate it names, and the message says so.
    expect(res.message).toBe(
      "Merged “L7 claimed source” into “L7 claimed target” — 0 trades moved, 1 duplicate skipped (saved to Deleted items), " +
        "1 duplicate IPO record removed with the duplicate (“L7 claimed target”'s own copy of that trade already carries one; " +
        "saved to Deleted items, an un-merge brings it back).",
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
    // The skipped half MOVED by D5 (wave 2N, identity#0): it promised "a record
    // filed in another account is left unlinked", which was the silent double
    // count itself. Every skipped record is removed with the duplicate it names.
    expect(pv.warnings?.find((w) => w.includes("IPO record"))).toBe(
      "1 dropped trade carries 2 IPO records — 1 will be re-pointed to “L7 two target”'s own copy of that trade, " +
        "never left unlinked (an unlinked exited IPO beside the target's copy counts that sale twice); " +
        "1 will be removed with the duplicate it names, because one trade takes one IPO record " +
        "(saved to Deleted items; an un-merge brings it back).",
    );

    const res = mod.deleteAccount({ accountId: 20, mode: "merge", targetId: 19, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 1]);
    expect(
      t.db.select().from(t.schema.ipos).all().filter((r) => r.tradeId === targetTrade).map((r) => r.id),
      "the survivor takes one record, not both",
    ).toEqual([first]);
    expect(t.db.select().from(t.schema.ipos).all().map((r) => r.id)).not.toContain(second);
    expect(res.message).toContain("1 IPO link re-pointed");
    expect(res.message).toContain("1 duplicate IPO record removed with the duplicate");
  });
});

describe("a dropped trade with no IPO changes nothing", () => {
  const HASH = "k1-merge-ipo-plain";
  let movingTrade = 0;
  let linkedIpo = 0;
  let looseIpo = 0;

  it("the moving trade keeps its own link and an unlinked IPO stays unlinked; the snapshot states an EMPTY ipoRefs", () => {
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
    // MOVED by D1 (wave 2N, counted-once#0/#1): every delete writer STATES
    // `ipoRefs`, `[]` when it broke no link. Omitting the empty list made this
    // envelope byte-identical to a 4.2.x one, so `lib/trash.ts` took the legacy
    // fallback on it and the restore invented a link the user never made.
    expect(ipoRefsOf(res.snapshotId!), "stated, and empty — not absent").toEqual([]);
  });
});

/**
 * D5 (v4.3.0 fix wave 2N, re-check finding "identity#0", silent wrong number) —
 * L7's SKIP re-creates the double count wave 2K exists to prevent whenever the
 * skipped record is NOT filed in the book being merged.
 *
 * A dropped duplicate's record is skipped when the target's survivor already
 * carries one. The source's own copy was deleted into the envelope (harmless);
 * a record in ANY OTHER account was left where it stood and UNLINKED by the
 * blanket unlink — and an unlinked exited IPO is realised on its own figure
 * beside the survivor's equity sale. The same sale, counted twice: measured
 * {equity 490.25, ipo 482.60, total 972.85} on All accounts, two ITR rows for
 * one sale, and the merge message only said the record was "left unlinked in
 * its own account".
 *
 * So the skipped set is no longer filtered by account: EVERY skipped record is
 * snapshotted into the merge envelope with its OWN accountId and deleted inside
 * the transaction. `restoreTrashSnapshot` replays `accountRows.ipos` with its
 * `trade_id` intact, so an un-merge puts it back in its own book still naming its
 * own holding — unless that holding could not come back, when D4 (wave 2O) clears
 * the reference rather than pointing it at whatever now holds the id (the last
 * describe in this file).
 */
describe("D5 · a skipped IPO record filed in a THIRD account is removed with its duplicate", () => {
  const HASH = "d5-merge-ipo-third";
  const SCRIPS = ["D5THIRD", "D5-THIRD-LEG (IPO)", "D5-THIRD-TGT (IPO)"];
  let targetTrade = 0;
  let sourceTrade = 0;
  let targetIpo = 0;
  let strayIpo = 0;
  let snapshotId = "";
  let mergeMessage = "";
  let aisBefore: Record<string, number | null> = {};

  it("baseline: one sale, one ITR row, and the stray record is counted through the source's copy", async () => {
    targetTrade = closedTrade(32, "D5THIRD", { dedupHash: HASH });
    sourceTrade = closedTrade(33, "D5THIRD", { dedupHash: HASH });
    targetIpo = exitedIpo(32, "D5-THIRD-TGT", targetTrade);
    // The legacy cross-account shape lib/queries/ipos.ts names in its own
    // header: the record in one book, the holding it names in another.
    strayIpo = exitedIpo(31, "D5-THIRD-LEG", sourceTrade);
    expect(itrScripsIn(0, SCRIPS), "two copies of the sale, each counted once").toEqual(["D5THIRD", "D5THIRD"]);
    aisBefore = await aisIn(0);
  });

  it("the merge removes it with the duplicate, so All accounts counts that sale ONCE", async () => {
    select(1);
    const res = mod.deleteAccount({ accountId: 33, mode: "merge", targetId: 32, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 1]);
    snapshotId = res.snapshotId!;
    mergeMessage = res.message;

    // THE assertion. On HEAD: ["D5THIRD", "D5-THIRD-LEG (IPO)"] — the dropped
    // duplicate's sale re-stated by a record nobody unlinked on purpose.
    expect(itrScripsIn(0, SCRIPS), "the stray record is not a second statement of the survivor's sale").toEqual(["D5THIRD"]);
    expect(taxIn(0).ipoNames).not.toContain("D5-THIRD-LEG");
    expect(ipoRow(strayIpo), "it is removed with the duplicate it named").toBeUndefined();
    // Both AIS sides fall by exactly the dropped duplicate — on HEAD they did
    // not move at all, because the unlinked record put the same sale back.
    expect(await aisIn(0)).toEqual({
      ...aisBefore,
      [`${FY} purchase`]: (aisBefore[`${FY} purchase`] ?? 0) - 1000,
      [`${FY} sale`]: (aisBefore[`${FY} sale`] ?? 0) - 1500,
    });
    // The target's own record is untouched and still names its own copy.
    expect(linkOf(targetIpo)).toEqual([32, targetTrade]);
  });

  it("the message NAMES the other book it was filed in, and says an un-merge brings it back", () => {
    // Invariant 6 and the wave's own lesson: a row removed from a book the user
    // never named is a fact they are entitled to before and after the press.
    expect(mergeMessage).toContain("1 filed in “D5 legacy holder”");
    expect(mergeMessage).toContain("an un-merge brings it back");
  });

  it("an un-merge brings it back, in its own account, still naming its own holding", async () => {
    const back = trash.restoreTrashSnapshot(snapshotId, "D5 probe");
    expect([back.ok, back.restored], back.message).toEqual([true, 1]);
    expect(linkOf(strayIpo), "its own book, its own holding — replayed verbatim").toEqual([31, sourceTrade]);
    expect(itrScripsIn(0, SCRIPS), "and the book reads exactly as it did before the merge").toEqual(["D5THIRD", "D5THIRD"]);
    expect(await aisIn(0)).toEqual(aisBefore);
  });
});

/**
 * D5, the variant that reaches a SINGLE-account view: the skipped record is
 * filed in the TARGET's own book. Nothing here needs the All-accounts lens —
 * the target's own page read 972.85 for one sale of 10 shares.
 */
describe("D5 · a skipped IPO record filed in the TARGET's own book is removed with its duplicate", () => {
  const HASH = "d5-merge-ipo-own";
  let targetTrade = 0;
  let sourceTrade = 0;
  let ownIpo = 0;
  let strayIpo = 0;
  let snapshotId = "";

  it("the target's own view counts that sale ONCE after the merge", async () => {
    targetTrade = closedTrade(34, "D5OWN", { dedupHash: HASH });
    sourceTrade = closedTrade(35, "D5OWN", { dedupHash: HASH });
    ownIpo = exitedIpo(34, "D5-OWN-TGT", targetTrade);
    // Filed in the TARGET, naming the SOURCE's copy — the shape a Trash restore
    // or an earlier merge can leave behind (lib/queries/ipos.ts:163-177).
    strayIpo = exitedIpo(34, "D5-OWN-LEG", sourceTrade);
    expect(realisedIn(34), "before the merge the record's holding is not in this view").toEqual({
      equityRealised: NET, ipoRealised: 482.6, totalRealised: 972.85,
    });

    select(1);
    const res = mod.deleteAccount({ accountId: 35, mode: "merge", targetId: 34, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 1]);
    snapshotId = res.snapshotId!;

    // THE assertion. On HEAD: {equity 490.25, ipo 482.6, total 972.85} — the
    // same figure wave 2K quoted as the defect it fixed.
    expect(realisedIn(34)).toEqual({ equityRealised: NET, ipoRealised: 0, totalRealised: NET });
    expect(taxIn(34)).toEqual({ ipoNames: [], cgNets: [NET], itrRows: 1 });
    expect(await aisIn(34)).toEqual({ [`${FY} purchase`]: 1000, [`${FY} sale`]: 1500 });
    expect(linkOf(ownIpo), "the target's own record is untouched").toEqual([34, targetTrade]);
  });

  it("an un-merge brings it back to the target's book, still naming its own holding", () => {
    const back = trash.restoreTrashSnapshot(snapshotId, "D5 probe");
    expect([back.ok, back.restored], back.message).toEqual([true, 1]);
    expect(linkOf(strayIpo), "its own account and its own trade_id, replayed verbatim").toEqual([34, sourceTrade]);
    expect(realisedIn(34), "and the target reads what it read before the merge").toEqual({
      equityRealised: NET, ipoRealised: 482.6, totalRealised: 972.85,
    });
  });
});

/**
 * D4 (v4.3.0 fix wave 2O, re-check finding "identity#0", medium) — a restore
 * that cannot bring a holding back leaves its IPO record UNLINKED and says so.
 *
 * D5 (above) routes a FOREIGN book's skipped record through `accountRows.ipos`,
 * which `restoreTrashSnapshot` replayed VERBATIM — the one restore path with no
 * gate on what actually landed. The `ipoRefs` loop (lib/trash.ts:694-700) and
 * the ledger loop (:686-691) both `continue` unless `landed.has(ref.tradeId)`,
 * and D1 wrote the rule into the same file: "a link onto a row this restore did
 * not bring back is not this restore's to make".
 *
 * So when the un-merge cannot land the duplicate the record named — the id is
 * taken (`trades.id` is AUTOINCREMENT, so an ordinary re-import never reuses a
 * freed rowid; the field shape is a snapshot restored against a database whose
 * rowids came from elsewhere, a backup or the desktop template swap) — the
 * record came back stating a link to WHATEVER now holds that id. Measured by the
 * re-check: `getIpoTradeLinks().get(6)` badged an unrelated scrip in another
 * book, All accounts read `ipoRealised` 482.61 instead of 965.22, the ITR export
 * lost the record's row and both AIS sides fell.
 *
 * The gate keys on the ENVELOPE (`envTradeIds`), never on `landed` alone: a
 * reference this delete never touched (a cross-account link on a purge) is kept
 * verbatim — pinned in `tests/trash-restore-ipo-legacy.test.ts`.
 */
describe("D4 · a skipped IPO record whose duplicate CANNOT come back is restored UNLINKED", () => {
  const HASH = "d4-merge-ipo-taken";
  const SCRIPS = ["D4TAKEN", "D4OTHER", "D4-TAKEN-LEG (IPO)", "D4-TAKEN-TGT (IPO)", "D4HOLD"];
  let targetTrade = 0;
  let sourceTrade = 0;
  let targetIpo = 0;
  let strayIpo = 0;
  let heldElsewhere = 0;
  let snapshotId = "";
  let restoreMessage = "";

  const askAbout = (accountId: number, ipoId: number) => {
    select(accountId);
    return dq
      .getDataQualityReport()
      .issues.find((x) => x.code.startsWith("ipo_record_link") && x.detail.includes(`#${ipoId} `));
  };

  it("baseline: the merge removes the stray record with the duplicate it names", () => {
    targetTrade = closedTrade(37, "D4TAKEN", { dedupHash: HASH });
    sourceTrade = closedTrade(38, "D4TAKEN", { dedupHash: HASH });
    // The survivor already carries its OWN record, which is what makes the stray
    // one a SKIP rather than a re-point (L7).
    targetIpo = exitedIpo(37, "D4-TAKEN-TGT", targetTrade);
    strayIpo = exitedIpo(36, "D4-TAKEN-LEG", sourceTrade);
    // An unlinked allotment still HELD in the legacy holder's book, so the
    // question Data Quality raises about the stray record has a holding to name.
    heldElsewhere = t.db
      .insert(t.schema.trades)
      .values(tradeRow({
        accountId: 36, broker: "zerodha", segment: "eq_delivery", symbol: "D4HOLD", tradingsymbol: "D4HOLD",
        buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", isOpen: true,
        acquisition: "ipo", acquisitionPrice: 100, acquisitionDate: "2026-02-20",
      }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    expect(itrScripsIn(0, SCRIPS), "two copies of the sale, each counted once").toEqual(["D4TAKEN", "D4TAKEN"]);

    select(1);
    const res = mod.deleteAccount({ accountId: 38, mode: "merge", targetId: 37, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 1]);
    snapshotId = res.snapshotId!;
    expect(res.message).toContain("1 filed in “D4 legacy holder”");
    expect(ipoRow(strayIpo)).toBeUndefined();
  });

  it("the id the dropped duplicate held now belongs to another closed trade", () => {
    // The field shape: a snapshot restored against a database whose rowids came
    // from elsewhere. Written explicitly here because AUTOINCREMENT never hands
    // the id back on its own.
    t.db
      .insert(t.schema.trades)
      .values(tradeRow({
        id: sourceTrade, accountId: 37, broker: "zerodha", segment: "eq_delivery", symbol: "D4OTHER", tradingsymbol: "D4OTHER",
        buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20",
        sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02",
        grossPnl: 500, chargesTotal: 500 - NET, netPnl: NET, isOpen: false,
      }))
      .run();
    expect(t.db.select().from(t.schema.trades).all().find((r) => r.id === sourceTrade)!.tradingsymbol).toBe("D4OTHER");
  });

  it("the un-merge brings the record back with NO link, and says so", () => {
    const back = trash.restoreTrashSnapshot(snapshotId, "D4 probe");
    restoreMessage = back.message;
    expect([back.restored, back.skipped.length], back.message).toEqual([0, 1]);
    expect(back.skipped[0].reason).toBe("a trade with that id is already in the journal");
    // THE assertion. On HEAD: [36, sourceTrade] — where that id is now D4OTHER,
    // a different scrip in a different book.
    expect(linkOf(strayIpo), "the holding it named is not in the journal, so it names nothing").toEqual([36, null]);
    // The restore says what it did: nothing here is silent (invariant 6).
    expect(restoreMessage).toContain("1 IPO record came back unlinked");
  });

  it("so nothing badges the unrelated trade, and its own sale is stated once", async () => {
    // On HEAD: ["D4OTHER", "D4TAKEN"] — the record's own sale left the ITR
    // export, the capital summary and both AIS sides with the link.
    expect(itrScripsIn(0, SCRIPS)).toEqual(["D4-TAKEN-LEG (IPO)", "D4OTHER", "D4TAKEN"]);
    // On HEAD: `getIpoTradeLinks().get(sourceTrade)` returned the stray record's
    // id, so /trades badged D4OTHER as that allotment's holding.
    select(0);
    expect(ipoQueries.getIpoTradeLinks().get(sourceTrade), "no badge on a trade this record never named").toBeUndefined();
    expect(taxIn(0).ipoNames).toContain("D4-TAKEN-LEG");
    expect(realisedIn(36), "the record's own exit, in its own book").toEqual({
      equityRealised: 0, ipoRealised: 482.6, totalRealised: 482.6,
    });
    expect(linkOf(targetIpo), "and the survivor's own record is untouched").toEqual([37, targetTrade]);
    const ais = await aisIn(36);
    // Purchase 2,000 = the record's own allotment (1,000) + the still-held D4HOLD
    // buy (1,000); sale 1,500 is the record's exit alone, stated once.
    expect([ais[`${FY} purchase`], ais[`${FY} sale`]], "both AIS sides state the record's own allotment").toEqual([2000, 1500]);
  });

  it("and Data Quality asks which holding is the record's", () => {
    // The honest pre-2N state, without leaving the record behind: unlinked and
    // asked about, rather than pointed at another trade.
    const issue = askAbout(36, strayIpo);
    expect(issue?.title, "the record is a candidate again").toBe("IPO records not linked to their holdings");
    expect(issue!.ids).toContain(heldElsewhere);
  });
});
