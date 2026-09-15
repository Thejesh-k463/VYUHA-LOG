import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * ACCDEL-IPO-REFS (v4.3.0 wave 2J) — an account delete writes `ipoRefs`, so a
 * restore puts the IPO ↔ holding links back the way `lib/queries/delete.ts`
 * does (wave 2I) and `removeBrokerRows` always has.
 *
 * Both branches of `deleteAccount` move SURVIVING `ipos` rows off a trade they
 * are about to destroy — the purge branch unlinks them after deleting the
 * account's own IPO rows; the merge branch, since wave 2K, RE-POINTS them at
 * the target's surviving copy of the dropped duplicate (ACCDEL-IPO-RELINK,
 * tests/account-merge-ipo-relink.test.ts) and unlinks only what has no such
 * copy. Either way the pre-merge/pre-delete link must be stated in the
 * envelope. The snapshot carried `ledgerRefs` and no `ipoRefs`, so
 * `restoreTrashSnapshot`'s re-link loop (lib/trash.ts) had nothing to read and
 * the trade came back under its own id with the link silently gone — a fact the
 * user recorded (this allotment BECAME that holding) destroyed by a recoverable
 * operation, and the counted-once rule wave 2H built on `ipos.trade_id`
 * (CAP-IPO-LINK / TAX-IPO-LINK) left keyed on a null.
 *
 * ONE temp database for this file (AGENTS.md Testing).
 */

let t: TempDb;
let mod: typeof import("@/lib/queries/account-delete");
let trash: typeof import("@/lib/trash");
let capital: typeof import("@/lib/queries/capital");
let trashDir: string;

/** Net of the closed holding each IPO record was linked to. */
const NET = 490.25;

beforeAll(async () => {
  t = await openTempDb("accdel-ipo-refs", { seed: true });
  mod = await import("@/lib/queries/account-delete");
  trash = await import("@/lib/trash");
  capital = await import("@/lib/queries/capital");
  trashDir = (await import("@/lib/db")).trashDir;
  // The seed's account 1 ("Primary", default, live) is the last-live anchor and
  // holds the LEGACY cross-account IPO rows; 2 is purged, 3 merges into 4.
  for (const [id, name] of [[2, "Purged"], [3, "Merged"], [4, "Target"]] as [number, string][]) {
    t.db.insert(t.schema.accounts).values({ id, name }).run();
  }
  select(1);
}, 30_000);

afterAll(() => t?.cleanup());

function select(accountId: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: accountId }).run();
}

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

const ipoTradeId = (id: number) => t.db.select().from(t.schema.ipos).all().find((r) => r.id === id)!.tradeId;
const ipoAccountId = (id: number) => t.db.select().from(t.schema.ipos).all().find((r) => r.id === id)!.accountId;

function ipoRefsOf(snapshotId: string): { ipoId: number; tradeId: number }[] {
  const env = JSON.parse(fs.readFileSync(path.join(trashDir, snapshotId, "snapshot.json"), "utf8")) as {
    ipoRefs?: { ipoId: number; tradeId: number }[];
  };
  return (env.ipoRefs ?? []).slice().sort((a, b) => a.ipoId - b.ipoId);
}

/** The capital summary as the account's own page reads it. */
function realisedIn(accountId: number) {
  select(accountId);
  const c = capital.getCapitalSummary();
  return { equityRealised: c.equityRealised, ipoRealised: c.ipoRealised, totalRealised: c.totalRealised };
}

describe("purge: the links a purge unlinks come back with the restore", () => {
  let tradeId = 0;
  let ownIpo = 0;
  let legacyIpo = 0;
  let snapshotId = "";

  it("baseline: the linked sale is counted once in the purged account", () => {
    tradeId = closedTrade(2, "PURGEIPO");
    ownIpo = exitedIpo(2, "PURGE-IPO", tradeId);
    // A LEGACY row: account 1's allotment naming a holding filed in account 2.
    legacyIpo = exitedIpo(1, "LEGACY-IPO", tradeId);

    expect(realisedIn(2)).toEqual({ equityRealised: NET, ipoRealised: 0, totalRealised: NET });
  });

  it("the snapshot carries an ipoRef for every ipos row pointing at a doomed trade", () => {
    select(1);
    const res = mod.deleteAccount({ accountId: 2, mode: "purge", connections: "delete" });
    expect([res.ok, res.snapshotId != null]).toEqual([true, true]);
    snapshotId = res.snapshotId!;

    // Both rows point at the trade this purge destroys: account 2's own (deleted
    // with the book) and account 1's legacy row (unlinked where it stands).
    expect(ipoRefsOf(snapshotId)).toEqual([
      { ipoId: ownIpo, tradeId },
      { ipoId: legacyIpo, tradeId },
    ].sort((a, b) => a.ipoId - b.ipoId));
    // The purge did what it says: account 1's row survives, unlinked.
    expect(ipoTradeId(legacyIpo)).toBeNull();
  });

  it("restored: ipos.trade_id points at the restored trade again, in both accounts", () => {
    const res = trash.restoreTrashSnapshot(snapshotId, "wave 2J probe");
    expect([res.ok, res.restored]).toEqual([true, 1]);
    expect(t.db.select().from(t.schema.trades).all().map((r) => r.id)).toContain(tradeId);

    expect(ipoTradeId(ownIpo)).toBe(tradeId);
    // THE assertion: the survivor the purge unlinked is re-linked too.
    expect(ipoTradeId(legacyIpo)).toBe(tradeId);
  });

  it("and the capital summary counts that sale ONCE, not twice", () => {
    expect(realisedIn(2)).toEqual({ equityRealised: NET, ipoRealised: 0, totalRealised: NET });
  });
});

describe("merge: the snapshot records the pre-merge links the merge re-points", () => {
  const HASH = "accdel-ipo-refs-dup";
  let targetTrade = 0;
  let sourceTrade = 0;
  let ownIpo = 0;
  let legacyIpo = 0;
  let snapshotId = "";

  it("the snapshot carries an ipoRef for every ipos row pointing at a skipped duplicate", () => {
    // The target already records this sale, so the source row is a dedup
    // collision: snapshotted and DELETED rather than moved.
    targetTrade = closedTrade(4, "MERGEIPO", { dedupHash: HASH });
    sourceTrade = closedTrade(3, "MERGEIPO", { dedupHash: HASH });
    ownIpo = exitedIpo(3, "MERGE-IPO", sourceTrade);
    legacyIpo = exitedIpo(1, "LEGACY-MERGE-IPO", sourceTrade);

    select(1);
    const res = mod.deleteAccount({ accountId: 3, mode: "merge", targetId: 4, connections: "delete" });
    expect([res.ok, res.skippedTrades]).toEqual([true, 1]);
    snapshotId = res.snapshotId!;

    expect(ipoRefsOf(snapshotId)).toEqual([
      { ipoId: ownIpo, tradeId: sourceTrade },
      { ipoId: legacyIpo, tradeId: sourceTrade },
    ].sort((a, b) => a.ipoId - b.ipoId));
    // CHANGED by ACCDEL-IPO-RELINK (wave 2K), deliberately: the source's own
    // record survives the merge, moves to the target and names the TARGET's
    // surviving copy of that trade instead of being left unlinked. Unlinked was
    // a silent double count: the target's own copy stayed, so the merged book
    // counted the sale once through the trade and once through the IPO (wave
    // 2H's counted-once rule keys on `ipos.trade_id`). See
    // tests/account-merge-ipo-relink.test.ts for the figures.
    expect([ipoAccountId(ownIpo), ipoTradeId(ownIpo)]).toEqual([4, targetTrade]);
    // MOVED by L7 (wave 2L), deliberately: ONE trade takes ONE IPO record —
    // `pushTradeToIpoAction` refuses to create a second, and two rows both
    // marked linked to one holding each sync onto it when edited while
    // `getIpoTradeLinks()` keeps only the last. `ownIpo` (the book being merged,
    // and the record that travels with the trade) takes the survivor; account
    // 1's legacy row is SKIPPED — left where it stands, unlinked, which is
    // numerically neutral in its own book because the trade it named was never
    // in it. The envelope states the pre-merge link (asserted above) and the
    // restore below puts it back.
    expect([ipoAccountId(legacyIpo), ipoTradeId(legacyIpo)]).toEqual([1, null]);
  });

  it("restored: the duplicate comes back and the merge's re-point is left alone", () => {
    const res = trash.restoreTrashSnapshot(snapshotId, "wave 2J probe");
    expect([res.ok, res.restored]).toEqual([true, 1]);
    expect(t.db.select().from(t.schema.trades).all().map((r) => r.id)).toContain(sourceTrade);

    // CHANGED by wave 2K, deliberately: the re-link loop writes only where
    // `trade_id` is still NULL — "a link someone re-linked by hand since the
    // delete is their decision, not this restore's to overwrite" (lib/trash.ts)
    // — and the merge itself set this one, so it stays on the target's copy,
    // which is the row the IPO now sits beside.
    expect(ipoTradeId(ownIpo)).toBe(targetTrade);
    // L7 (wave 2L): the row the merge SKIPPED is still null, so the envelope's
    // `ipoRefs` re-links it to the duplicate that just came back — the MERGE
    // branch's `ipoRefs` doing the work the purge branch's cannot (there the
    // rows ride back inside `accountRows.ipos` with `trade_id` intact).
    expect(ipoTradeId(legacyIpo)).toBe(sourceTrade);
  });
});
