import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * The unreadable-lot finding in `closeStaleLot` (DECISIONS 2026-09-18, "v4.3.0 fix
 * wave 2P BUILT": recorded, not built; wave2p-design-review D7, NARROW). Built in
 * the v4.4.0 fix list.
 *
 * The Data Quality one-click close prices from the LOT's stored buy date, and it
 * was the one writer of that kind that never asked `storedDateProblem` whether
 * the row states a day (`closePosition`, `applyOverride` and `updateManualTrade`
 * all do). Measured on the unfixed code, 2026-09-18:
 *   - a lot stored as '2026-02-31' (a legacy typed date, written before the
 *     calendar check existed) PAIRS with its recorded sale — the pure rule reads
 *     only the ISO shape — and the join WROTE: ok:true, the unreadable day kept
 *     as the joined row's buy date and 0 days of MTF interest billed from it;
 *   - a lot stored as '9999-99-99' was refused NO_PAIR ("the position is closed,
 *     the sale has gone…") — a reason that is not the reason. Before wave 2P's
 *     `calendarDaysHeld` it was the NaN day count and the uncaught
 *     `NOT NULL constraint failed` throw the finding was named for.
 * Now both are refused BAD_DATE with the stored-date sentence the other three
 * writers state, before anything is read for pricing, and nothing is written.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let POST: (req: Request) => Promise<Response>;

// Measured locally 2026-09-18: migrate + seed + the commit and route imports
// ~1.5 s, inside the 3 s local hook budget. The raised timeout is for the
// Windows runner (> 15x slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("stale-lot-unreadable-date", { seed: true });
  commit = await import("@/lib/import/commit");
  ({ POST } = await import("@/app/api/data-quality/close-stale/route"));
}, 120_000);
afterAll(() => t?.cleanup());

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get();
const ins = (o: Record<string, unknown>) =>
  t.db.insert(t.schema.trades).values(tradeRow(o)).returning({ id: t.schema.trades.id }).get()!.id;

/** One book per case: an open long lot stored with `buyDate`, and its recorded sale. */
function pair(acc: number, sym: string, buyDate: string, segment = "eq_mtf") {
  t.db.insert(t.schema.accounts).values({ id: acc, name: `stale-${sym}` }).run();
  const lot = ins({ accountId: acc, segment, symbol: sym, tradingsymbol: sym, buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate, buyOrderCount: 1, isOpen: true });
  const sale = ins({ accountId: acc, segment, symbol: sym, tradingsymbol: sym, sellQty: 10, avgSellPrice: 110, sellValue: 1100, sellDate: "2026-09-01", sellOrderCount: 1, isOpen: false });
  t.db.update(t.schema.settings).set({ selectedAccountId: acc }).run();
  return { lot, sale };
}

describe("closeStaleLot refuses a lot whose stored buy date is not a real day", () => {
  it.each([
    [981, "UNRD1", "2026-02-31", "eq_mtf"],
    [982, "UNRD2", "9999-99-99", "eq_mtf"],
    [983, "UNRD3", "2026-02-31", "eq_delivery"],
  ])("account %i: a %s lot stored as '%s' (%s) → BAD_DATE, the stored-date sentence, nothing written", (acc, sym, buyDate, segment) => {
    const { lot, sale } = pair(acc, sym, buyDate, segment);
    const before = row(lot)!;

    const res = commit.closeStaleLot(lot, sale, "2026-09-01");

    // THE assertion (on revert of the commit.ts refusal: '2026-02-31' reads
    // {ok:true} — the join wrote — and '9999-99-99' reads code NO_PAIR).
    expect(res.ok, res.message).toBe(false);
    expect(res.code).toBe("BAD_DATE");
    expect(res.message).toBe(
      `This trade's stored buy date “${buyDate}” is not a real calendar day, so nothing can be priced from it. Correct the date in Edit trade first. Nothing was changed.`,
    );
    // No partial write: the lot is untouched and the sale is still in the journal.
    const after = row(lot)!;
    expect([after.isOpen, after.sellQty, after.chargesTotal, after.netPnl, after.importNotes]).toEqual([
      before.isOpen, before.sellQty, before.chargesTotal, before.netPnl, before.importNotes,
    ]);
    expect(row(sale), "the recorded sale was removed").toBeTruthy();
  });

  it("the Data Quality route answers 400 with that sentence — a reason the user can act on, not a 500", async () => {
    const { lot, sale } = pair(984, "UNRD4", "2026-02-31");
    const res = await POST(
      new Request("http://localhost:3011/api/data-quality/close-stale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lotId: lot, saleId: sale, exitDate: "2026-09-01" }),
      }),
    );
    const body = (await res.json()) as { ok: boolean; code?: string; message: string };
    expect([res.status, body.ok, body.code]).toEqual([400, false, "BAD_DATE"]);
    expect(body.message).toMatch(/stored buy date “2026-02-31” is not a real calendar day.*Correct the date in Edit trade first/);
    expect(row(lot)!.isOpen).toBe(true);
    expect(row(sale)).toBeTruthy();
  });

  it("a readable lot beside it still joins (the refusal is the unreadable day's alone)", () => {
    const { lot, sale } = pair(985, "RDBL5", "2026-08-20");
    const res = commit.closeStaleLot(lot, sale, "2026-09-01");
    expect(res.ok, res.message).toBe(true);
    expect(row(lot)!.isOpen).toBe(false);
    expect(row(sale)).toBeUndefined();
  });
});
