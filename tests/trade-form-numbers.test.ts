import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * The trade forms' number fields read by the SIG-1 rule (v4.4.0 fix list; DECISIONS
 * 2026-09-18 "v4.3.0 gains ONE single strategy", "Recorded, not built").
 *
 * `num()` in app/trades/actions.ts stripped EVERY comma, so a decimal-comma price
 * typed as "14,48" was stored as 1448 — a 100x error on a per-unit price, silently,
 * in the qty × price recomputation of every figure downstream. The Signal section
 * had the same bug and was fixed in 4.3.0 (SIG-1) by a rule that reads a comma only
 * as a thousands separator whose LAST group has three digits. The trade forms now
 * read by THAT rule — the one exported helper, `parseFormNumber` in
 * lib/domain/signal.ts — so Indian grouping "1,23,456.50" still reads 123456.5 and
 * "14,48" is refused with a sentence, never stored.
 *
 * Money is rupees at runtime (invariant 1): nothing here converts to paise.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let actions: typeof import("@/app/trades/actions");
let parseFormNumber: typeof import("@/lib/domain/signal").parseFormNumber;

const PREV = { ok: false, message: "" };
const BOOK = 1;

// Measured locally 2026-09-18: migrate + seed + the actions import ~1.5 s, inside
// the 3 s local hook budget; the raised timeout is for the Windows runner.
beforeAll(async () => {
  t = await openTempDb("trade-form-numbers", { seed: true });
  actions = await import("@/app/trades/actions");
  ({ parseFormNumber } = await import("@/lib/domain/signal"));
  t.db.update(t.schema.settings).set({ selectedAccountId: BOOK }).run();
}, 120_000);
afterAll(() => t?.cleanup());

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}
const manual = (sym: string, extra: Record<string, string> = {}) =>
  form({
    broker: "zerodha", tradingsymbol: sym, productHint: "delivery", segment: "eq_delivery", exchange: "NSE",
    buyQty: "10", avgBuyPrice: "1500", buyDate: "2026-04-01", sellQty: "10", avgSellPrice: "1520", sellDate: "2026-04-10",
    ...extra,
  });
const rowsOf = (sym: string) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.tradingsymbol, sym)).all();
const byId = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;
const insertOpen = (sym: string) =>
  t.db
    .insert(t.schema.trades)
    .values(tradeRow({ accountId: BOOK, broker: "zerodha", symbol: sym, tradingsymbol: sym, buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-04-01", buyOrderCount: 1, isOpen: true }))
    .returning({ id: t.schema.trades.id })
    .get()!.id;

describe("parseFormNumber — the ONE form-number rule (SIG-1), now exported for the trade forms", () => {
  it.each([
    ["1,23,456.50", 123456.5],
    ["1,448", 1448],
    ["3,00,000", 300000],
    ["12,34,56,789", 123456789],
    ["1500", 1500],
    [" 14.48 ", 14.48],
    ["-2.5", -2.5],
  ])("reads %j as %d", (raw, n) => {
    expect(parseFormNumber(raw)).toBe(n);
  });

  it.each(["14,48", "1,4", "1,,448", "1e5", "abc", "", "1.2.3", ",448"])("refuses %j", (raw) => {
    expect(parseFormNumber(raw)).toBeNull();
  });
});

describe("createManualTrade reads qty / price by that rule", () => {
  it("an Indian-grouped price and a grouped quantity are stored as the numbers they state", async () => {
    const res = await actions.createManualTrade(PREV, manual("GRPD", { buyQty: "1,000", avgBuyPrice: "1,23,456.50", sellQty: "1,000", avgSellPrice: "1,23,500" }));
    expect(res.ok, res.message).toBe(true);
    const [r] = rowsOf("GRPD");
    expect([r.buyQty, r.avgBuyPrice, r.sellQty, r.avgSellPrice, r.buyValue]).toEqual([1000, 123456.5, 1000, 123500, 123456500]);
  });

  it("a decimal-comma price is REFUSED with its field named — never stored as 1448 — and nothing is written", async () => {
    const res = await actions.createManualTrade(PREV, manual("DECOMMA", { avgBuyPrice: "14,48" }));
    // THE assertion (on revert of actions.ts: {ok:true}, avgBuyPrice 1448 stored).
    expect(res.ok, res.message).toBe(false);
    expect(res.message).toMatch(/^Avg buy price “14,48” is not a number/);
    expect(res.message).toMatch(/Nothing was saved\.$/);
    expect(rowsOf("DECOMMA")).toHaveLength(0);
  });

  it("the same refusal for a level (SL) and for own capital — a refused value is never silently blanked", async () => {
    const sl = await actions.createManualTrade(PREV, manual("SLCOMMA", { slPlanned: "14,48" }));
    expect([sl.ok, sl.message.startsWith("SL “14,48” is not a number")]).toEqual([false, true]);
    const oc = await actions.createManualTrade(PREV, manual("OCCOMMA", { productHint: "mtf", segment: "eq_mtf", ownCapitalUsed: "7,50" }));
    expect([oc.ok, oc.message.startsWith("Own capital used “7,50” is not a number")]).toEqual([false, true]);
    expect([...rowsOf("SLCOMMA"), ...rowsOf("OCCOMMA")]).toHaveLength(0);
  });

  it("the number input's leading-dot spelling still reads (a browser sends \".5\" as typed)", async () => {
    const res = await actions.createManualTrade(PREV, manual("LEADDOT", { avgBuyPrice: ".5", avgSellPrice: "0.75" }));
    expect(res.ok, res.message).toBe(true);
    expect(rowsOf("LEADDOT")[0].avgBuyPrice).toBe(0.5);
  });
});

describe("the edit, close and ladder doors refuse the same value", () => {
  it("updateTradeAction: a decimal-comma sell price is refused and the row is untouched", async () => {
    const id = insertOpen("EDITCOMMA");
    const res = await actions.updateTradeAction(
      PREV,
      form({ tradeId: String(id), buyQty: "10", avgBuyPrice: "100", buyDate: "2026-04-01", sellQty: "10", avgSellPrice: "14,48", sellDate: "2026-04-10" }),
    );
    expect([res.ok, res.message.startsWith("Avg sell price “14,48” is not a number")]).toEqual([false, true]);
    expect([byId(id).isOpen, byId(id).sellQty, byId(id).avgSellPrice]).toEqual([true, 0, 0]);
  });

  it("closeTradeAction: a decimal-comma exit price is refused and the position stays open", async () => {
    const id = insertOpen("CLOSECOMMA");
    const res = await actions.closeTradeAction(PREV, form({ tradeId: String(id), exitPrice: "14,48", exitDate: "2026-04-10" }));
    expect([res.ok, res.message.startsWith("Exit price “14,48” is not a number")]).toEqual([false, true]);
    expect(byId(id).isOpen).toBe(true);
  });

  it("closeTradeAction: an Indian-grouped exit price closes at the number it states", async () => {
    const id = insertOpen("CLOSEGRP");
    const res = await actions.closeTradeAction(PREV, form({ tradeId: String(id), exitPrice: "1,10,000.25", exitDate: "2026-04-10" }));
    expect(res.ok, res.message).toBe(true);
    expect(byId(id).avgSellPrice).toBe(110000.25);
  });

  it("addEntryLegAction: a decimal-comma tranche price is refused before the lot is converted", async () => {
    const id = insertOpen("LEGCOMMA");
    const res = await actions.addEntryLegAction(PREV, form({ tradeId: String(id), qty: "5", price: "14,48", tradeDate: "2026-04-02" }));
    expect([res.ok, res.message.startsWith("Price “14,48” is not a number")]).toEqual([false, true]);
    expect(byId(id).staged).toBe(false);
  });
});
