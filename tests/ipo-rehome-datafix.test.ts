import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * IPO-REHOME (v4.3.0 wave 2J) — the startup data fix that re-homes legacy
 * cross-account IPO rows.
 *
 * Until wave 2I, "This holding came from an IPO" inserted the `ipos` row with
 * no accountId at all, so the column took its schema default of 1 whatever
 * account the holding was in. A journal that used that button from a second
 * account therefore stores `ipos` rows in account 1 whose `trade_id` names a
 * trade in ANOTHER account. Under wave 2I's scoping such a row is invisible on
 * its holding's /ipos, unreachable for a sync, and the counted-once consumers
 * read it as unlinked — the same sale then counted twice across "All accounts".
 *
 * The repair is a DATA FIX (lib/db/data-fixes.ts, run by lib/db/index.ts on
 * every open), never a migration: for every `ipos` row whose `trade_id` names
 * an EXISTING trade in a different, existing account, the row moves to that
 * trade's account — the account the user meant. A missing trade, an equal
 * account, a null link and a trade whose account no longer exists are all left
 * exactly as stored; account 0 is a view and is never written (invariant 9);
 * `trades` is never touched.
 *
 * ONE temp database for this file (AGENTS.md Testing).
 */

const FIX = "ipo-account-rehome-v1";

let t: TempDb;
let fixes: typeof import("@/lib/db/data-fixes");
let q: typeof import("@/lib/queries/ipos");

const A1 = 1;
const A2 = 2;
const A3 = 3;
/** Archived (wave 2L): a real book the account switcher never lists. */
const A4 = 4;
/** No `accounts` row carries this id — a trade orphaned from its book. */
const GONE = 77;

const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const iposAll = () =>
  t.sqlite.prepare("SELECT id, name, account_id, trade_id FROM ipos ORDER BY id").all() as {
    id: number;
    name: string;
    account_id: number;
    trade_id: number | null;
  }[];
const named = (name: string) => iposAll().find((r) => r.name === name)!;
const tradesAll = () => t.sqlite.prepare("SELECT id, account_id, symbol FROM trades ORDER BY id").all();
const marker = () => t.sqlite.prepare("SELECT name FROM data_fixes WHERE name = ?").get(FIX);

function holding(accountId: number, symbol: string): number {
  return t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        accountId, broker: "zerodha", segment: "eq_delivery", symbol, tradingsymbol: symbol,
        buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", isOpen: true,
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;
}

function ipoRow(name: string, accountId: number, tradeId: number | null): number {
  return t.db
    .insert(t.schema.ipos)
    .values({
      accountId, name, appliedPrice: 100, lotSize: 10, lotsApplied: 1,
      allotted: true, allottedQty: 10, allotmentDate: "2026-02-20", listingPrice: 130, tradeId,
    })
    .returning({ id: t.schema.ipos.id })
    .get()!.id;
}

/**
 * Open the journal the way the app does — a NEW lib/db connection to the same
 * file, which runs the data fixes as it opens — then close it again.
 */
async function openThroughLibDb(): Promise<void> {
  const g = globalThis as unknown as { __vyuhaSqlite?: unknown };
  const cached = g.__vyuhaSqlite;
  delete g.__vyuhaSqlite;
  vi.resetModules();
  let fresh: typeof import("@/lib/db") | undefined;
  try {
    fresh = await import("@/lib/db");
    expect(path.resolve(fresh.sqlite.name)).toBe(path.resolve(t.dbPath));
  } finally {
    // Close even on failure, or cleanup() cannot unlink the file (EBUSY).
    fresh?.sqlite.close();
    g.__vyuhaSqlite = cached;
    vi.resetModules();
  }
}

let legacy = 0, back = 0, same = 0, nolink = 0, ghost = 0, noacct = 0, archived = 0;
let a1Trade = 0, a2Trade = 0, goneTrade = 0, deadTrade = 0, archTrade = 0;
let tradesBefore: unknown[] = [];

beforeAll(async () => {
  t = await openTempDb("ipo-rehome", { seed: true });
  fixes = await import("@/lib/db/data-fixes");
  q = await import("@/lib/queries/ipos");
  t.db
    .insert(t.schema.accounts)
    .values([
      { id: A2, name: "second book", isDefault: false },
      { id: A3, name: "third book", isDefault: false },
      { id: A4, name: "closed book", isDefault: false, archived: true },
    ])
    .run();

  a1Trade = holding(A1, "REHOMEA1");
  a2Trade = holding(A2, "REHOMEA2");
  holding(A3, "REHOMEA3");
  goneTrade = holding(GONE, "REHOMEGONE");
  archTrade = holding(A4, "REHOMEARCH");
  deadTrade = holding(A2, "REHOMEDEAD");
  t.sqlite.prepare("DELETE FROM trades WHERE id = ?").run(deadTrade);

  // The legacy shape: written to account 1 by the old button, holding elsewhere.
  legacy = ipoRow("REHOME-LEGACY", A1, a2Trade);
  back = ipoRow("REHOME-BACK", A3, a1Trade);
  same = ipoRow("REHOME-SAME", A1, a1Trade);
  nolink = ipoRow("REHOME-NOLINK", A1, null);
  ghost = ipoRow("REHOME-GHOST", A1, deadTrade);
  noacct = ipoRow("REHOME-NOACCT", A1, goneTrade);
  archived = ipoRow("REHOME-ARCHIVED", A1, archTrade);
  tradesBefore = tradesAll();

  // A journal that pre-dates the fix: openTempDb already ran the fixes on an
  // empty file, so forget the marker and let the next open do the work.
  t.sqlite.prepare("DELETE FROM data_fixes WHERE name = ?").run(FIX);
  // Migrate + seed + these fixtures measure 954 ms locally (2026-09-15), inside
  // the 3 s hook budget; the raised timeout is headroom for the Windows CI
  // runner, which is > 15x slower on SQLite-file work (AGENTS.md Testing).
}, 30_000);

afterAll(() => t?.cleanup());

describe("opening the journal re-homes a legacy cross-account IPO row", () => {
  it("moves the row to its holding's account, and writes the marker", async () => {
    expect(named("REHOME-LEGACY").account_id).toBe(A1);
    await openThroughLibDb();
    // THE assertion: the IPO now lives in the account its holding is in.
    expect(named("REHOME-LEGACY").account_id).toBe(A2);
    expect(named("REHOME-BACK").account_id).toBe(A1);
    expect(marker(), "lib/db/index.ts did not run the data fixes on open").toBeTruthy();
  });

  it("leaves every other row exactly as stored, and never writes account 0", () => {
    expect([
      named("REHOME-SAME").account_id,
      named("REHOME-NOLINK").account_id,
      named("REHOME-GHOST").account_id,
      named("REHOME-NOACCT").account_id,
      named("REHOME-ARCHIVED").account_id,
    ]).toEqual([A1, A1, A1, A1, A1]);
    // The links themselves are untouched — this fix moves the row, not the link.
    expect([named("REHOME-GHOST").trade_id, named("REHOME-NOLINK").trade_id]).toEqual([deadTrade, null]);
    expect(iposAll().filter((r) => r.account_id === 0)).toEqual([]);
  });

  it("touches no trade", () => {
    expect(tradesAll()).toEqual(tradesBefore);
    // Five fixtures: A1, A2, A3, the orphaned book and the archived one (wave 2L).
    expect(tradesBefore).toHaveLength(5);
  });
});

describe("the re-homed row reads on its holding's /ipos, and only there", () => {
  it("account 2 sees it, linked; account 1 and account 3 do not", () => {
    selectAccount(A2);
    const row = q.getIposComputed().rows.find((r) => r.name === "REHOME-LEGACY")!;
    expect([row.id, row.linked]).toEqual([legacy, true]);
    selectAccount(A1);
    expect(q.getIposComputed().rows.map((r) => r.name)).not.toContain("REHOME-LEGACY");
    selectAccount(A3);
    expect(q.getIposComputed().rows.map((r) => r.name)).not.toContain("REHOME-LEGACY");
  });

  it("the row moved back to account 1 reads there, linked, and no longer on account 3", () => {
    selectAccount(A1);
    const rows = q.getIposComputed().rows;
    expect(rows.map((r) => r.name)).toContain("REHOME-BACK");
    expect(rows.find((r) => r.id === back)!.linked).toBe(true);
    selectAccount(A3);
    expect(q.getIposComputed().rows.map((r) => r.name)).not.toContain("REHOME-BACK");
  });

  it("an unreachable link stays unreachable rather than being invented", () => {
    selectAccount(A1);
    const rows = q.getIposComputed().rows;
    expect([rows.find((r) => r.id === ghost)!.linked, rows.find((r) => r.id === nolink)!.linked]).toEqual([false, false]);
    expect(rows.find((r) => r.id === noacct)!.linked).toBe(false);
    expect(rows.find((r) => r.id === same)!.linked).toBe(true);
  });
});

/**
 * L3 (v4.3.0 wave 2L) — an ARCHIVED account is as unselectable as a missing one.
 *
 * The fix's own comment already excluded "a book that cannot be selected", but the
 * JOIN tested only that the `accounts` row EXISTS: an archived book is a real row,
 * so a record was moved into it and left every selectable single-account view
 * (components/system/account-switcher.tsx lists `accounts.filter(a => !a.archived)`,
 * and lib/queries/accounts.ts resolves a stored selection over live accounts only).
 * Left where it is, the record stays visible and editable in a book the user can
 * still open; the link itself reads inert under wave 2I's scoped join, exactly as a
 * link to a deleted trade does — the fix moves a row, it never invents a link.
 */
describe("a holding in an ARCHIVED account is not a destination", () => {
  it("the IPO stays in the account it was filed in, and still reads there", () => {
    expect(named("REHOME-ARCHIVED").account_id).toBe(A1);
    selectAccount(A1);
    const rows = q.getIposComputed().rows;
    expect(rows.map((r) => r.name)).toContain("REHOME-ARCHIVED");
    // The cross-account link is inert (wave 2I), never re-pointed and never followed.
    expect(rows.find((r) => r.id === archived)!.linked).toBe(false);
    expect(named("REHOME-ARCHIVED").trade_id).toBe(archTrade);
  });
});

describe("idempotent", () => {
  it("a second open changes nothing — the marker is there and the fix does not run", async () => {
    const before = iposAll();
    const res = fixes.runDataFixes(t.sqlite).find((r) => r.name === FIX)!;
    expect(res.applied).toBe(false);
    await openThroughLibDb();
    expect(iposAll()).toEqual(before);
  });

  it("even re-run from scratch (a restore forgets the markers) it moves nothing more", () => {
    const before = iposAll();
    t.sqlite.prepare("DELETE FROM data_fixes WHERE name = ?").run(FIX);
    const res = fixes.runDataFixes(t.sqlite).find((r) => r.name === FIX)!;
    expect([res.applied, res.rekeyed, res.skippedCollisions]).toEqual([true, 0, 0]);
    expect(iposAll()).toEqual(before);
    expect(marker()).toBeTruthy();
  });
});
