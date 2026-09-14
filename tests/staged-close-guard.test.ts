import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * R2-DQ N11 (v4.3.0 fix wave 2R; silent wrong number, pre-existing) — the
 * manual close never touches a STAGED position.
 *
 * `closePosition` (the manual close on /risk and /trades) wrote the closed
 * parent row of a staged position and no exit leg. The ladder kept reading the
 * position open, and the next ladder action rebuilt the parent from its legs:
 * re-opened, realised P&L erased (measured 2026-09-15 by the wave-2 re-check:
 * JSWSTEEL 10+90 @200, closed @250, then a stop on the tranches read the
 * parent back as open with net −23.74). Invariants 4 and 5: the ladder's own
 * exit is the only close of a staged position.
 *
 * Pinned here: `closePosition` refuses a staged lot (or a row holding
 * trade_legs) and changes nothing; the route answers 409 STAGED; and the two
 * close entry points in the UI send a staged row to its ladder, never to the
 * manual close.
 *
 * ONE temp database per FILE (AGENTS.md).
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let staged: typeof import("@/lib/queries/staged");
let route: typeof import("@/app/api/positions/close/route");
let tradesClient: typeof import("@/components/trades/trades-client");
let cockpit: typeof import("@/components/risk/risk-cockpit-client");

const ACC = 901;

const parsed = (trades: NormalizedTrade[]): ParsedFile => ({ sourceId: "dhan-api", broker: "dhan", format: "api", trades, warnings: [] });

function buy(sym: string, executions: NormalizedTrade["executions"] = null): ParsedFile {
  return parsed([
    {
      broker: "dhan",
      tradingsymbol: sym,
      isin: null,
      buyQty: 100,
      avgBuyPrice: 200,
      buyValue: 20000,
      sellQty: 0,
      avgSellPrice: 0,
      sellValue: 0,
      closingPrice: null,
      grossPnl: 0,
      unrealisedPnl: 0,
      buyDate: "2026-08-20",
      sellDate: null,
      productHint: "delivery",
      exchangeHint: "NSE",
      sourceFile: null,
      executions,
    } as NormalizedTrade,
  ]);
}

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;
const legsOf = (id: number) => t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, id)).all().sort((a, b) => a.seq - b.seq);
const lastRowOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => b.id - a.id)[0];

async function postClose(body: unknown) {
  const res = await route.POST(
    new Request("http://local/api/positions/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
  return { status: res.status, json: (await res.json()) as { ok: boolean; message: string; code?: string } };
}

// Measured locally (2026-09-15): the file's tests phase is 2.31 s with the ten
// `it`s summing ~0.11 s, so the hook (migrate + seed + the two client modules)
// is ~2.2 s — inside the 3 s local budget. The raised timeout is for the
// Windows runner, >15x slower on SQLite-file work (AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("staged-close-guard", { seed: true });
  commit = await import("@/lib/import/commit");
  staged = await import("@/lib/queries/staged");
  route = await import("@/app/api/positions/close/route");
  tradesClient = await import("@/components/trades/trades-client");
  cockpit = await import("@/components/risk/risk-cockpit-client");
  t.db.insert(t.schema.accounts).values({ id: ACC, name: "staged-close" }).run();
  t.db.update(t.schema.settings).set({ selectedAccountId: ACC }).run();
}, 120_000);
afterAll(() => t?.cleanup());

describe("R2-DQ N11 — closePosition refuses a staged position and changes nothing", () => {
  let L: ReturnType<typeof row>;

  it("JSWSTEEL bought in two fills (10 + 90 @200) is ONE staged row with two entry legs", () => {
    const exec = (qty: number, time: string) => ({ side: "buy" as const, qty, price: 200, date: "2026-08-20", time });
    expect(commit.commitParsedFile(buy("JSWSTEEL", [exec(10, "10:00:00"), exec(90, "10:05:00")]), "jsw-buy", null, ACC).added).toBe(1);
    L = lastRowOf(ACC);
    expect([L.staged, L.isOpen, L.buyQty]).toEqual([true, true, 100]);
    expect(legsOf(L.id).map((g) => [g.kind, g.qty])).toEqual([["entry", 10], ["entry", 90]]);
  });

  it("closePosition(L, 250, 2026-08-28) is refused with STAGED; the parent, its legs and the ladder are unchanged", () => {
    const beforeRow = row(L.id);
    const beforeLegs = legsOf(L.id);
    const res = commit.closePosition(L.id, 250, "2026-08-28");
    expect([res.ok, res.code]).toEqual([false, "STAGED"]);
    expect(res.message).toMatch(/staged position/);
    expect(res.message).toMatch(/ladder/);
    expect(res.message).toMatch(/Nothing was changed/);
    expect(row(L.id)).toEqual(beforeRow);
    expect(legsOf(L.id)).toEqual(beforeLegs);
    expect(staged.getStagedView(L.id)!.position.openQty).toBe(100);
  });

  it("POST /api/positions/close answers 409 STAGED and writes nothing", async () => {
    const before = row(L.id);
    const { status, json } = await postClose({ tradeId: L.id, exitPrice: 250, exitDate: "2026-08-28" });
    expect([status, json.ok, json.code]).toEqual([409, false, "STAGED"]);
    expect(row(L.id)).toEqual(before);
  });

  it("a row holding trade_legs is refused even when its staged flag is off", () => {
    t.db.update(t.schema.trades).set({ staged: false }).where(eq(t.schema.trades.id, L.id)).run();
    const before = row(L.id);
    expect(commit.closePosition(L.id, 250, "2026-08-28").code).toBe("STAGED");
    expect(row(L.id)).toEqual(before);
    t.db.update(t.schema.trades).set({ staged: true }).where(eq(t.schema.trades.id, L.id)).run();
  });

  it("the ladder's own exit still closes it (the route the refusal names)", () => {
    expect(staged.addLeg({ tradeId: L.id, kind: "exit", tradeDate: "2026-08-28", qty: 100, price: 250 }).ok).toBe(true);
    expect([row(L.id).isOpen, row(L.id).sellQty, row(L.id).grossPnl]).toEqual([false, 100, 5000]);
    expect(legsOf(L.id).map((g) => g.kind)).toEqual(["entry", "entry", "exit"]);
  });

  it("control: an unstaged position with no legs still closes through the manual close", async () => {
    expect(commit.commitParsedFile(buy("JINDALSTEL"), "jindal-buy", null, ACC).added).toBe(1);
    const plain = lastRowOf(ACC);
    const { status, json } = await postClose({ tradeId: plain.id, exitPrice: 250, exitDate: "2026-08-28" });
    expect([status, json.ok]).toEqual([200, true]);
    expect([row(plain.id).isOpen, row(plain.id).grossPnl]).toEqual([false, 5000]);
  });
});

describe("R2-DQ N11 — every close entry point sends a staged row to its ladder, never to the manual close", () => {
  /** The Button inside the Tip the /trades close control returns, with its handler. */
  function closeButtonOf(trade: { isOpen: boolean; staged: boolean }) {
    const onManualClose = vi.fn();
    const onLadder = vi.fn();
    const el = tradesClient.CloseEntryButton({ trade, onManualClose, onLadder }) as React.ReactElement<{ label: string; children: React.ReactElement<{ onClick: () => void; "aria-label": string }> }> | null;
    return { el, onManualClose, onLadder };
  }

  it("/trades: the close icon on a STAGED open row opens its ladder, not the manual close dialog", () => {
    const trade = { isOpen: true, staged: true };
    const { el, onManualClose, onLadder } = closeButtonOf(trade);
    el!.props.children.props.onClick();
    expect(onLadder).toHaveBeenCalledWith(trade);
    expect(onManualClose).not.toHaveBeenCalled();
    expect(el!.props.children.props["aria-label"]).toMatch(/ladder/);
  });

  it("/trades control: an unstaged open row opens the manual close; a closed row has no close icon", () => {
    const trade = { isOpen: true, staged: false };
    const { el, onManualClose, onLadder } = closeButtonOf(trade);
    el!.props.children.props.onClick();
    expect(onManualClose).toHaveBeenCalledWith(trade);
    expect(onLadder).not.toHaveBeenCalled();
    expect(closeButtonOf({ isOpen: false, staged: true }).el).toBeNull();
  });

  it("/risk: a staged position (it carries its tranches) offers the ladder in Trades and no 'Close position' button", () => {
    const html = renderToStaticMarkup(
      React.createElement(cockpit.PositionCloseControl, { p: { symbol: "JSWSTEEL", tranches: [{ qty: 100, price: 200, stop: null }] }, onClose: () => {} }),
    );
    expect(html).toContain('href="/trades?symbol=JSWSTEEL&amp;view=open"');
    expect(html).toContain("Book the exit on its ladder in Trades");
    expect(html).not.toContain("Close position");
  });

  it("/risk control: an unstaged position keeps the manual 'Close position' button", () => {
    const html = renderToStaticMarkup(React.createElement(cockpit.PositionCloseControl, { p: { symbol: "JINDALSTEL", tranches: null }, onClose: () => {} }));
    expect(html).toContain("Close position");
    expect(html).not.toContain("/trades?symbol=");
  });
});
