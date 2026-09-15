import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * L3 (v4.3.0 wave 2L) — commit.ts reads a date or REFUSES it; it never invents one.
 *
 * `normalizeDate` matched the two shapes by digit count alone and never checked the
 * calendar, so '31-02-2026' was reordered into '2026-02-31' and '99-99-9999' into
 * '9999-99-99' and both were stored as real days. Downstream that is two different
 * failures:
 *
 *   • `closePosition` on an eq_mtf row THREW an unhandled SqliteError — `new
 *     Date('9999-99-99')` is Invalid, the MTF day count went NaN, the charge total
 *     went NaN and the UPDATE failed on `NOT NULL constraint failed:
 *     trades.charges_total_paise`. The server action 500s instead of answering
 *     {ok:false} (re-check finding close-readers [2], pre-existing);
 *   • on any other row the impossible day was simply stored, and every reader that
 *     dates the trade (the tax pack's financial year, the MTF holding period) then
 *     reads a day that does not exist.
 *
 * The rule now: a date that is not a real calendar day reads as NO date, and a
 * writer that was GIVEN one refuses the whole write, naming what it could not read.
 * An EMPTY exit date still falls back to today — that is a blank field, not a bad
 * one. A row a parser cannot date is still refused by the parser (AGENTS.md: never
 * coerce a bad cell), and the import path's own callers keep passing null through.
 *
 * ONE temp database for this file (AGENTS.md Testing); commit.ts is server-only and
 * reaches lib/db, so it is imported dynamically after the helper sets the path.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let todayIstIso: typeof import("@/lib/domain/trading-day").todayIstIso;

// Measured locally 2026-09-15: migrate + seed + the commit import well inside the
// 3 s local hook budget; the raised timeout is headroom for the Windows runner
// (> 15x slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("normalize-date", { seed: true });
  commit = await import("@/lib/import/commit");
  ({ todayIstIso } = await import("@/lib/domain/trading-day"));
}, 60_000);
afterAll(() => t?.cleanup());

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;

function open(symbol: string, over: Record<string, unknown> = {}): number {
  return t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        broker: "angelone", segment: "eq_delivery", symbol, tradingsymbol: symbol,
        buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-08-20",
        sellQty: 0, avgSellPrice: 0, sellValue: 0, isOpen: true, buyOrderCount: 1, sellOrderCount: 0,
        ...over,
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;
}

describe("L3 · normalizeDate reads the formats the importers emit, unchanged", () => {
  it.each([
    ["19-09-2026", "2026-09-19"],
    ["19/09/2026", "2026-09-19"],
    ["2026-09-19", "2026-09-19"],
    ["2026-09-19T10:04:00", "2026-09-19"],
    ["2024-02-29", "2024-02-29"],
    ["01-01-1996", "1996-01-01"],
    ["", null],
    [null, null],
    ["not-a-date", null],
  ])("%j → %j", (input, expected) => {
    expect(commit.normalizeDate(input as string | null)).toBe(expected);
  });
});

describe("L3 · a date that is not a real calendar day reads as NO date, never as a reordered one", () => {
  it.each([
    ["2026-02-31", "February has no 31st"],
    ["31-02-2026", "the same day, written day-first"],
    ["99-99-9999", "the value that threw on an MTF close"],
    ["2026-13-01", "there is no month 13"],
    ["2026-00-10", "there is no month 0"],
    ["2026-09-00", "there is no day 0"],
    ["0002-06-15", "a date input's intermediate year"],
    ["2026-02-29", "2026 is not a leap year"],
  ])("%j → null (%s)", (input) => {
    expect(commit.normalizeDate(input)).toBeNull();
  });
});

describe("L3 · closePosition refuses an exit date it cannot read, and writes nothing", () => {
  it("eq_mtf, exit date '99-99-9999': {ok:false} naming the date — not an unhandled SqliteError", () => {
    const id = open("BADDATEMTF", { segment: "eq_mtf", mtfFundedAmount: 16000 });
    const before = row(id);
    // THE assertion (before: this THREW `NOT NULL constraint failed:
    // trades.charges_total_paise`, and the server action 500d).
    const res = commit.closePosition(id, 255, "99-99-9999");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("99-99-9999");
    expect(row(id)).toEqual(before);
  });

  it("eq_delivery, exit date '2026-02-31': refused too — the impossible day is not stored", () => {
    const id = open("BADDATEDEL");
    const before = row(id);
    const res = commit.closePosition(id, 255, "2026-02-31");
    // Before: {ok:true} with sell_date '2026-02-31' stored and the position closed.
    expect([res.ok, row(id).sellDate, row(id).isOpen]).toEqual([false, null, true]);
    expect(row(id)).toEqual(before);
  });

  it("an EMPTY exit date still falls back to today, and a readable day-first date still closes on it", () => {
    const blank = open("BLANKDATE");
    expect(commit.closePosition(blank, 255, null).ok).toBe(true);
    expect(row(blank).sellDate).toBe(todayIstIso());

    const dmy = open("DMYDATE");
    expect(commit.closePosition(dmy, 255, "19-09-2026").ok).toBe(true);
    expect([row(dmy).sellDate, row(dmy).isOpen]).toEqual(["2026-09-19", false]);
  });
});

describe("L3 · the trade editor refuses a date it cannot read rather than clearing it", () => {
  it("a sell date of '2026-02-31' is refused, naming it, and not one column moves", () => {
    const id = open("EDITBADSELL");
    const before = row(id);
    const res = commit.updateManualTrade(id, { sellQty: 100, avgSellPrice: 255, sellDate: "2026-02-31" });
    // Before this fix: {ok:true} with sell_date '2026-02-31' stored (and, once
    // normalizeDate validates the calendar, a silently CLEARED sell date on a
    // closed row — worse than either).
    expect(res.ok).toBe(false);
    expect(res.message).toContain("2026-02-31");
    expect(row(id)).toEqual(before);
  });

  it("a buy date of '99-99-9999' is refused the same way; a readable date still saves", () => {
    const id = open("EDITBADBUY");
    const before = row(id);
    expect(commit.updateManualTrade(id, { buyDate: "99-99-9999" }).ok).toBe(false);
    expect(row(id)).toEqual(before);

    expect(commit.updateManualTrade(id, { buyDate: "21-08-2026" }).ok).toBe(true);
    expect(row(id).buyDate).toBe("2026-08-21");
  });

  it("an empty date still clears the field (blank means 'clear this', as the editor's other fields do)", () => {
    const id = open("EDITBLANK");
    expect(commit.updateManualTrade(id, { buyDate: "" }).ok).toBe(true);
    expect(row(id).buyDate).toBeNull();
  });
});
