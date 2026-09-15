import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * V4 (v4.3.0 wave 2H seam re-run 3, pre-existing): ONE default for the order count
 * of a side that gains its first quantity — settings.defaultBuyOrders /
 * defaultSellOrders. The preview route defaulted an omitted count to 1
 * (app/api/charges/preview/route.ts), the editor save billed the setting
 * (updateManualTrade), and the Positions close billed `|| 1`
 * (lib/domain/close-aggregate.ts via closePosition). Probe 2026-09-15, default sell
 * orders 2, a Dhan option bought 100 @5 in 2 orders, exited @8 on 8 Sep: editor
 * preview [300, 72.34, 227.66], editor save [300, 95.94, 204.06] counts [2, 2],
 * Positions close [300, 72.34, 227.66] counts [2, 1].
 *
 * Nothing here models a half: the editor's body is `editPreviewBody`, the close
 * dialog's is `closePreviewBody`, both handed to the real route over JSON; the
 * saves are the real `updateManualTrade` and `closePosition`.
 *
 * ONE temp database per FILE (AGENTS.md Testing).
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let POST: (req: Request) => Promise<Response>;
let editPreviewBody: typeof import("@/components/trades/edit-trade-dialog").editPreviewBody;
let closePreviewBody: typeof import("@/components/trades/close-trade-dialog").closePreviewBody;
let toSlimTrade: typeof import("@/lib/domain/slim-trade").toSlimTrade;

// Measured locally 2026-09-15: migrate + seed + the commit, route and both dialog
// imports ~2 s, inside the 3 s local hook budget. The raised timeout is for the
// Windows runner (> 15x slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("order-count-default", { seed: true });
  commit = await import("@/lib/import/commit");
  ({ POST } = await import("@/app/api/charges/preview/route"));
  ({ editPreviewBody } = await import("@/components/trades/edit-trade-dialog"));
  ({ closePreviewBody } = await import("@/components/trades/close-trade-dialog"));
  ({ toSlimTrade } = await import("@/lib/domain/slim-trade"));
}, 120_000);
afterAll(() => t?.cleanup());

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;
const wire = (id: number) => JSON.parse(JSON.stringify(toSlimTrade(row(id)))) as ReturnType<typeof toSlimTrade>;
const figures = (id: number) => [row(id).grossPnl, row(id).chargesTotal, row(id).netPnl];
const counts = (id: number) => [row(id).buyOrderCount, row(id).sellOrderCount];
const setDefaults = (buy: number, sell: number) => t.db.update(t.schema.settings).set({ defaultBuyOrders: buy, defaultSellOrders: sell }).run();

let seq = 0;
function optionRow(legs: Record<string, unknown>) {
  const sym = `OCD${++seq}`;
  return t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        broker: "dhan", bucket: "active", segment: "stock_option", instrumentType: "option", exchange: "NSE",
        symbol: sym, tradingsymbol: `${sym}100CESEP26`, optionType: "CE", strike: 100, expiry: "2026-09-24", isOpen: true, ...legs,
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;
}

async function route(body: unknown): Promise<number[]> {
  const res = await POST(
    new Request("http://localhost:3011/api/charges/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
  expect(res.status).toBe(200);
  const j = (await res.json()) as { breakdown: { total: number }; grossPnl: number; netPnl: number };
  return [j.grossPnl, j.breakdown.total, j.netPnl];
}

const LONG_OPEN = { buyQty: 100, avgBuyPrice: 5, buyValue: 500, buyDate: "2026-09-01", buyOrderCount: 2, sellQty: 0, avgSellPrice: 0, sellValue: 0, sellDate: null, sellOrderCount: 0 };
const LONG_EXIT = { buyQty: 100, avgBuyPrice: 5, buyDate: "2026-09-01", sellQty: 100, avgSellPrice: 8, sellDate: "2026-09-08" };
const SHORT_OPEN = { sellQty: 100, avgSellPrice: 8, sellValue: 800, sellDate: "2026-09-01", sellOrderCount: 2, buyQty: 0, avgBuyPrice: 0, buyValue: 0, buyDate: null, buyOrderCount: 0 };
const SHORT_EXIT = { sellQty: 100, avgSellPrice: 8, sellDate: "2026-09-01", buyQty: 100, avgBuyPrice: 5, buyDate: "2026-09-08" };

/** The same exit four ways: editor preview, editor save, close dialog preview, Positions close. */
async function fourWays(open: Record<string, unknown>, exit: typeof LONG_EXIT, exitPrice: number, isShort: boolean) {
  const edited = optionRow(open);
  const editorShown = await route(editPreviewBody(wire(edited), { ...exit, ownCapitalUsed: null }));
  expect(commit.updateManualTrade(edited, exit).ok).toBe(true);

  const closed = optionRow(open);
  const exitDate = isShort ? exit.buyDate! : exit.sellDate!;
  const closeShown = await route(
    closePreviewBody(wire(closed), exitPrice, exitDate, { buyDate: isShort ? exitDate : exit.buyDate, sellDate: isShort ? exit.sellDate : exitDate }),
  );
  expect(commit.closePosition(closed, exitPrice, exitDate).ok).toBe(true);
  return { editorShown, editorSaved: figures(edited), editorCounts: counts(edited), closeShown, closeSaved: figures(closed), closeCounts: counts(closed) };
}

describe("V4 — one order-count default for a side that gains its first quantity", () => {
  it("the probe: default sell orders 2, a Dhan option bought 100 @5 in 2 orders, exit @8 — editor preview = editor save = close preview = Positions close = [300, 95.94, 204.06], counts [2, 2]", async () => {
    setDefaults(1, 2);
    const w = await fourWays(LONG_OPEN, LONG_EXIT, 8, false);
    // THE assertions (on revert of the route: the editor preview [300, 72.34, 227.66];
    // of closePosition's default: the close [300, 72.34, 227.66] with counts [2, 1];
    // of the dialog's omission: the close preview [300, 72.34, 227.66]).
    expect(w.editorShown, "editor preview").toEqual([300, 95.94, 204.06]);
    expect(w.editorSaved, "editor save").toEqual([300, 95.94, 204.06]);
    expect(w.closeSaved, "Positions close").toEqual([300, 95.94, 204.06]);
    expect(w.closeShown, "close dialog preview").toEqual([300, 95.94, 204.06]);
    expect([w.editorCounts, w.closeCounts]).toEqual([[2, 2], [2, 2]]);
  });

  it("the short mirror: default buy orders 2, sold 100 @8 in 2 orders, covered @5 — all four equal, counts [2, 2]", async () => {
    setDefaults(2, 1);
    const w = await fourWays(SHORT_OPEN, SHORT_EXIT, 5, true);
    expect([w.editorShown, w.closeShown, w.closeSaved]).toEqual([w.editorSaved, w.editorSaved, w.editorSaved]);
    expect([w.editorCounts, w.closeCounts]).toEqual([[2, 2], [2, 2]]);
  });

  it("with the defaults at 1 nothing changes: all four bill one exit order — [300, 72.34, 227.66], counts [2, 1]", async () => {
    setDefaults(1, 1);
    const w = await fourWays(LONG_OPEN, LONG_EXIT, 8, false);
    expect([w.editorShown, w.editorSaved, w.closeShown, w.closeSaved]).toEqual(Array(4).fill([300, 72.34, 227.66]));
    expect([w.editorCounts, w.closeCounts]).toEqual([[2, 1], [2, 1]]);
  });

  it("the route: a SENT count wins over the setting; an omitted one is the setting", async () => {
    setDefaults(1, 2);
    const id = optionRow(LONG_OPEN);
    // `editPreviewBody` answers null only for a non-empty unreadable date (2M); these dates are ISO.
    const body = editPreviewBody(wire(id), { ...LONG_EXIT, ownCapitalUsed: null })!;
    expect(body.sellOrders).toBeUndefined();
    expect(await route({ ...body, sellOrders: 1 })).toEqual([300, 72.34, 227.66]);
    expect(await route(body)).toEqual([300, 95.94, 204.06]);
    setDefaults(1, 1);
  });
});
