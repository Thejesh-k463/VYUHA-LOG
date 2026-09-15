import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * U2 (v4.3.0 wave 2H seam re-run): the trade EDITOR's live preview sent no
 * buyOrders / sellOrders, so /api/charges/preview billed one order a side, while
 * Save (`updateManualTrade`, lib/import/commit.ts) bills the row's stored counts:
 * `qty > 0 ? stored || settings default : 0`. A Dhan stock option sold in 2
 * orders and 60 covered in 3, covered in the editor as buy 100 @2.6 on 8 Sep,
 * previewed [240, 48.52, 191.48] and saved [240, 119.32, 120.68].
 *
 * Nothing here models either half: the body is the dialog's own
 * `editPreviewBody`, handed to the real route over JSON; the stored row is the
 * real `updateManualTrade` fed the same legs.
 *
 * One temp database for the file (AGENTS.md Testing); every module that reaches
 * lib/db is imported dynamically AFTER it.
 */

let t: TempDb;
let POST: (req: Request) => Promise<Response>;
let updateManualTrade: typeof import("@/lib/import/commit").updateManualTrade;
let editPreviewBody: typeof import("@/components/trades/edit-trade-dialog").editPreviewBody;
let toSlimTrade: typeof import("@/lib/domain/slim-trade").toSlimTrade;

// Measured locally 2026-09-15: migrate + seed + the route, commit and dialog imports
// together 1.8-1.9 s (two runs: vitest "tests" 1.88 / 2.00 s less the its). The raised timeout is for the Windows runner (> 15x slower).
beforeAll(async () => {
  t = await openTempDb("edit-trade-preview-orders", { seed: true });
  ({ POST } = await import("@/app/api/charges/preview/route"));
  ({ updateManualTrade } = await import("@/lib/import/commit"));
  ({ editPreviewBody } = await import("@/components/trades/edit-trade-dialog"));
  ({ toSlimTrade } = await import("@/lib/domain/slim-trade"));
}, 120_000);

afterAll(() => t?.cleanup());

type Legs = { buyQty: number; avgBuyPrice: number; buyDate: string | null; sellQty: number; avgSellPrice: number; sellDate: string | null };

/** A Dhan stock option row as its fills stored it, order counts included. */
function optionRow(sym: string, legs: Record<string, unknown>) {
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
const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;
/** The row as /trades ships it to the client (the RSC payload is JSON). */
const wire = (id: number) => JSON.parse(JSON.stringify(toSlimTrade(row(id)))) as ReturnType<typeof toSlimTrade>;

/** The editor's preview of `legs` on trade `id`: the [gross, charges, net] the route answers. */
async function editorPreview(id: number, legs: Legs): Promise<number[]> {
  const body = editPreviewBody(wire(id), { ...legs, ownCapitalUsed: null });
  const res = await POST(
    new Request("http://localhost:3011/api/charges/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
  const j = (await res.json()) as { breakdown: { total: number }; grossPnl: number; netPnl: number };
  return [j.grossPnl, j.breakdown.total, j.netPnl];
}

/** Save the same legs through the real editor write; the stored [gross, charges, net]. */
function save(id: number, legs: Legs): number[] {
  const res = updateManualTrade(id, legs);
  expect(res.ok, res.message).toBe(true);
  const r = row(id);
  return [r.grossPnl, r.chargesTotal, r.netPnl];
}

describe("the trade editor previews the order counts its save bills (U2)", () => {
  it("short: a Dhan option sold 100 @5 in 2 orders, 60 covered @3 in 3, covered in the editor as buy 100 @2.6 on 8 Sep — preview = save = [240, 119.32, 120.68]", async () => {
    const id = optionRow("EDITCO", {
      sellQty: 100, avgSellPrice: 5, sellValue: 500, sellDate: "2026-09-01", sellOrderCount: 2,
      buyQty: 60, avgBuyPrice: 3, buyValue: 180, buyDate: "2026-09-03", buyOrderCount: 3,
    });
    expect([wire(id).buyOrderCount, wire(id).sellOrderCount]).toEqual([3, 2]);
    const legs: Legs = { buyQty: 100, avgBuyPrice: 2.6, buyDate: "2026-09-08", sellQty: 100, avgSellPrice: 5, sellDate: "2026-09-01" };

    const shown = await editorPreview(id, legs);
    const stored = save(id, legs);
    expect([row(id).buyOrderCount, row(id).sellOrderCount]).toEqual([3, 2]);
    // THE assertions (on revert of the two order-count lines: [240, 48.52, 191.48]).
    expect(shown, "the preview is the save").toEqual(stored);
    expect(shown).toEqual([240, 119.32, 120.68]);
  });

  it("long mirror: bought 100 @5 in 2 orders, 60 sold @7 in 3, the editor sells 100 @8 — preview = save", async () => {
    const id = optionRow("EDITCOL", {
      buyQty: 100, avgBuyPrice: 5, buyValue: 500, buyDate: "2026-09-01", buyOrderCount: 2,
      sellQty: 60, avgSellPrice: 7, sellValue: 420, sellDate: "2026-09-03", sellOrderCount: 3,
    });
    const legs: Legs = { buyQty: 100, avgBuyPrice: 5, buyDate: "2026-09-01", sellQty: 100, avgSellPrice: 8, sellDate: "2026-09-08" };

    const shown = await editorPreview(id, legs);
    const stored = save(id, legs);
    expect(shown, "the preview is the save").toEqual(stored);
    // Floor: one order a side prices this differently, so the equality can tell them apart.
    const oneEach = editPreviewBody(wire(id), { ...legs, ownCapitalUsed: null });
    const res = await POST(new Request("http://localhost:3011/api/charges/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...oneEach, buyOrders: 1, sellOrders: 1 }) }));
    expect(((await res.json()) as { breakdown: { total: number } }).breakdown.total).not.toBe(stored[1]);
  });

  it("an open long (no sell leg stored) closed in the editor: its sell side omits the count, so the route's default stands in for the save's settings default (seeded 1); a side with no quantity sends 0", async () => {
    const id = optionRow("EDITOPEN", {
      buyQty: 50, avgBuyPrice: 4, buyValue: 200, buyDate: "2026-09-01", buyOrderCount: 2,
      sellQty: 0, avgSellPrice: 0, sellValue: 0, sellDate: null, sellOrderCount: 0,
    });
    const open: Legs = { buyQty: 50, avgBuyPrice: 4, buyDate: "2026-09-01", sellQty: 0, avgSellPrice: 0, sellDate: null };
    expect(editPreviewBody(wire(id), { ...open, ownCapitalUsed: null })).toMatchObject({ buyOrders: 2, sellOrders: 0 });

    const closed: Legs = { ...open, sellQty: 50, avgSellPrice: 6, sellDate: "2026-09-08" };
    expect(editPreviewBody(wire(id), { ...closed, ownCapitalUsed: null }).sellOrders).toBeUndefined();
    const shown = await editorPreview(id, closed);
    const stored = save(id, closed);
    expect([row(id).buyOrderCount, row(id).sellOrderCount]).toEqual([2, 1]);
    expect(shown, "the preview is the save").toEqual(stored);
  });

  it("the dialog's live preview sends editPreviewBody's request, fed the typed legs and the dates it saves", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "components/trades/edit-trade-dialog.tsx"), "utf8");
    const at = src.indexOf('"/api/charges/preview"');
    expect(at).toBeGreaterThan(-1);
    const effect = src.slice(at, src.indexOf("]);", at));
    expect(effect).toMatch(/body: JSON\.stringify\(\s*editPreviewBody\(trade, \{/);
    expect(effect).toMatch(/buyQty: bq,\s*avgBuyPrice: bp,\s*sellQty: sq,\s*avgSellPrice: sp,/);
    expect(effect).toMatch(/buyDate: buyDate \|\| null,\s*sellDate: sellDate \|\| null,/);
    expect(effect.slice(effect.lastIndexOf("["))).toMatch(/\btrade\b/);
  });
});
