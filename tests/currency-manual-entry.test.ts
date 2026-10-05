import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
// PURE (classify + the pair list) — safe to import statically beside openTempDb.
import { isManualCurrencyTrade, MANUAL_CURRENCY_REFUSAL } from "@/lib/import/currency-venue";

/**
 * v4.8.0 wave CU, residual R4 — A CURRENCY DERIVATIVE TYPED BY HAND IS REFUSED
 * ON CREATE, AND ONLY ON CREATE.
 *
 * v4.7.0 made every import refuse a currency derivative (no `charge_config`
 * row covers one, invariant 3) and recorded that the manual Add form did not:
 * `createManualTrade` handed `FUT USDINR 28 Oct 2026` to `commitManualTrade`,
 * which stored an NSE future billed equity-F&O STT and stamp.
 *
 * Three doors, one sentence (`MANUAL_CURRENCY_REFUSAL`), one predicate
 * (`isManualCurrencyTrade`, lib/import/currency-venue.ts):
 *   · the save            — `createManualTrade` (app/trades/actions.ts)
 *   · the charge preview  — /api/charges/preview, for a trade being CREATED
 *   · the form, inline    — before the user submits (components/trades/manual-trade-form.tsx)
 *
 * And what must NOT change: a currency row ALREADY in the book (imported before
 * v4.7.0 — the stranded-open note tells the user to close or delete it by hand)
 * can still be edited, closed and deleted, and its edit / close previews are
 * still priced as their saves price them.
 *
 * Every row here is synthetic. ONE temp database for the file.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let actions: typeof import("@/app/trades/actions");
let POST: (req: Request) => Promise<Response>;
let buildManualPreviewBody: typeof import("@/components/trades/manual-preview-body").buildManualPreviewBody;
let closePreviewBody: typeof import("@/components/trades/close-trade-dialog").closePreviewBody;
let editPreviewBody: typeof import("@/components/trades/edit-trade-dialog").editPreviewBody;
let manualCurrencyRefused: typeof import("@/components/trades/manual-trade-form").manualCurrencyRefused;
let toSlimTrade: typeof import("@/lib/domain/slim-trade").toSlimTrade;

const PREV = { ok: false, message: "" };

beforeAll(async () => {
  t = await openTempDb("currency-manual-entry", { seed: true });
  actions = await import("@/app/trades/actions");
  ({ POST } = await import("@/app/api/charges/preview/route"));
  ({ buildManualPreviewBody } = await import("@/components/trades/manual-preview-body"));
  ({ closePreviewBody } = await import("@/components/trades/close-trade-dialog"));
  ({ editPreviewBody } = await import("@/components/trades/edit-trade-dialog"));
  ({ manualCurrencyRefused } = await import("@/components/trades/manual-trade-form"));
  ({ toSlimTrade } = await import("@/lib/domain/slim-trade"));
  t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();
}, 120_000);
afterAll(() => t?.cleanup());

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get();
const wire = (id: number) => JSON.parse(JSON.stringify(toSlimTrade(row(id)!))) as ReturnType<typeof toSlimTrade>;
const stored = () => t.db.select({ s: t.schema.trades.tradingsymbol }).from(t.schema.trades).all().map((r) => r.s);

/** The Add form's FormData: a closed long, 1,000 @ 84 → 84.5. */
function form(over: Record<string, string> = {}): FormData {
  const fd = new FormData();
  const base: Record<string, string> = {
    broker: "zerodha", tradingsymbol: "USDINR26OCTFUT", direction: "buy",
    buyQty: "1000", avgBuyPrice: "84", buyDate: "2026-10-01", sellQty: "1000", avgSellPrice: "84.5", sellDate: "2026-10-05",
    ...over,
  };
  for (const [k, v] of Object.entries(base)) fd.append(k, v);
  return fd;
}

const preview = (body: unknown) =>
  POST(new Request("http://localhost:3011/api/charges/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

/** What the Add form's preview effect assembles for the same trade. */
const addBody = (tradingsymbol: string, kind: "equity" | "fno", over: Partial<Parameters<typeof buildManualPreviewBody>[0]> = {}) =>
  buildManualPreviewBody({
    broker: "zerodha", tradingsymbol, kind, productHint: null, segment: null, exchange: null, direction: "buy", open: false,
    entryQty: 1000, entryPrice: 84, entryDate: "2026-10-01", exitQty: 1000, exitPrice: 84.5, exitDate: "2026-10-05",
    ownCapitalUsed: null, daysHeld: 0, ...over,
  });

describe("R4 — the save (createManualTrade) refuses a currency derivative and writes nothing", () => {
  // The Equity tab's free-text symbol, then the two contracts the F&O tab constructs.
  it.each([
    ["the Equity tab, Kite-style future", "USDINR26OCTFUT"],
    ["the Equity tab, the bare pair", "usdinr"],
    ["the F&O tab's future", "FUT USDINR 28 Oct 2026"],
    ["the F&O tab's option (decimal strike)", "OPT EURINR 28 Oct 2026 90.5 PE"],
    ["a cross-currency pair", "FUT EURUSD 28 Oct 2026"],
  ])("%s: %s", async (_label, tradingsymbol) => {
    const before = stored();
    const res = await actions.createManualTrade(PREV, form({ tradingsymbol }));
    expect(res).toEqual({ ok: false, message: MANUAL_CURRENCY_REFUSAL });
    expect(stored()).toEqual(before);
  });

  it("a hand-built request whose Exchange / Segment override states a currency venue is refused whatever the name", async () => {
    const before = stored();
    // AUDINR is synthetic — no such contract is listed; it stands for a name outside lib/domain/currency-pairs.ts.
    const overrides: Record<string, string>[] = [{ exchange: "CDS" }, { exchange: "NSE_CURRENCY" }, { segment: "currency" }];
    for (const over of overrides) {
      const res = await actions.createManualTrade(PREV, form({ tradingsymbol: "AUDINR26OCTFUT", ...over }));
      expect(res, JSON.stringify(over)).toEqual({ ok: false, message: MANUAL_CURRENCY_REFUSAL });
    }
    expect(stored()).toEqual(before);
  });

  it("USDINRBEES typed by hand SAVES — the rule is the classified underlying, exact, never a prefix", async () => {
    const res = await actions.createManualTrade(PREV, form({ tradingsymbol: "USDINRBEES", productHint: "delivery", buyQty: "10", sellQty: "10" }));
    expect(res, res.message).toMatchObject({ ok: true });
    expect(row(res.tradeId!)).toMatchObject({ tradingsymbol: "USDINRBEES", symbol: "USDINRBEES", segment: "eq_delivery" });
  });

  it("an equity-F&O future beside them saves and is priced — the refusal is currency's alone", async () => {
    const res = await actions.createManualTrade(PREV, form({ tradingsymbol: "FUT NIFTY 27 Oct 2026", buyQty: "75", avgBuyPrice: "25000", sellQty: "75", avgSellPrice: "25100" }));
    expect(res, res.message).toMatchObject({ ok: true });
    expect(row(res.tradeId!)!.chargesTotal).toBeGreaterThan(0);
  });
});

describe("R4 — the charge preview gives no priced preview for a currency trade being created", () => {
  it.each([
    ["equity tab", "USDINR26OCTFUT", "equity"],
    ["F&O future", "FUT USDINR 28 Oct 2026", "fno"],
    ["F&O option", "OPT EURINR 28 Oct 2026 90.5 PE", "fno"],
  ] as const)("%s: 400 with the save's own sentence", async (_label, tradingsymbol, kind) => {
    const res = await preview(addBody(tradingsymbol, kind));
    expect(res.status).toBe(400);
    const shown = (await res.json()) as { error: string; code: string };
    expect(shown).toEqual({ error: MANUAL_CURRENCY_REFUSAL, code: "CURRENCY_NOT_PRICED" });
    // …and it IS the save's sentence, read off the save.
    expect((await actions.createManualTrade(PREV, form({ tradingsymbol }))).message).toBe(shown.error);
  });

  it("USDINRBEES is previewed and priced", async () => {
    const res = await preview(addBody("USDINRBEES", "equity", { productHint: "delivery", entryQty: 10, exitQty: 10 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { breakdown: { total: number } }).breakdown.total).toBeGreaterThan(0);
  });
});

describe("R4 — a currency row ALREADY in the book can still be edited, closed and deleted", () => {
  /** A USDINR future as a pre-v4.7.0 import stored it: an NSE `future` whose symbol is the pair. */
  const existing = (tradingsymbol: string): number =>
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: 1, broker: "zerodha", bucket: "active", segment: "future", instrumentType: "future", exchange: "NSE",
          symbol: "USDINR", tradingsymbol, buyQty: 1000, avgBuyPrice: 84, buyValue: 84000, buyDate: "2026-09-30", isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

  it("EDIT: the editor's preview is priced (it carries tradeId) and updateTradeAction saves", async () => {
    const id = existing("USDINR26NOVFUT");
    const fields = { buyQty: 1000, avgBuyPrice: 84.25, buyDate: "2026-09-30", sellQty: 0, avgSellPrice: 0, sellDate: "", ownCapitalUsed: null };
    const body = editPreviewBody(wire(id), fields as never);
    expect(body).toMatchObject({ tradeId: id, tradingsymbol: "USDINR26NOVFUT" });
    const shown = await preview(body);
    expect(shown.status).toBe(200);

    const fd = new FormData();
    for (const [k, v] of Object.entries({ tradeId: String(id), buyQty: "1000", avgBuyPrice: "84.25", buyDate: "2026-09-30", sellQty: "", avgSellPrice: "", sellDate: "", notes: "edited by hand" })) fd.append(k, v);
    const res = await actions.updateTradeAction(PREV, fd);
    expect(res, res.message).toMatchObject({ ok: true });
    expect(row(id)).toMatchObject({ avgBuyPrice: 84.25, notes: "edited by hand", isOpen: true });
    expect(((await shown.json()) as { breakdown: { total: number } }).breakdown.total).toBe(row(id)!.chargesTotal);
  });

  it("CLOSE: the close dialog's body (no tradeId — marked by mtfFundingUnstated) is priced, and closeTradeAction stores that figure", async () => {
    const id = existing("USDINR26DECFUT");
    const body = closePreviewBody(wire(id), 84.5, "2026-10-05", { buyDate: "2026-09-30", sellDate: "2026-10-05" });
    // The two facts the route's `pricesExistingRow` reads: this body is NOT an edit, and it says it prices a stored row.
    expect("tradeId" in body).toBe(false);
    expect(body.mtfFundingUnstated).toBe(false);
    const shown = await preview(body);
    expect(shown.status).toBe(200);
    const priced = (await shown.json()) as { breakdown: { total: number }; netPnl: number };

    const fd = new FormData();
    for (const [k, v] of Object.entries({ tradeId: String(id), exitPrice: "84.5", exitDate: "2026-10-05" })) fd.append(k, v);
    const res = await actions.closeTradeAction(PREV, fd);
    expect(res, res.message).toMatchObject({ ok: true });
    const after = row(id)!;
    expect([after.isOpen, after.sellQty, after.avgSellPrice]).toEqual([false, 1000, 84.5]);
    expect([priced.breakdown.total, priced.netPnl]).toEqual([after.chargesTotal, after.netPnl]);
  });

  it("DELETE: deleteTradesAction removes it", async () => {
    const id = existing("USDINR27JANFUT");
    const fd = new FormData();
    fd.append("ids", String(id));
    fd.append("reason", "a currency row from an earlier import");
    const res = await actions.deleteTradesAction(PREV, fd);
    expect(res, res.message).toMatchObject({ ok: true });
    expect(row(id)).toBeUndefined();
  });

  it("the SAME contract typed as a NEW trade is still refused — the existing row is what is exempt, not the name", async () => {
    existing("USDINR27FEBFUT");
    expect(await actions.createManualTrade(PREV, form({ tradingsymbol: "USDINR27FEBFUT" }))).toEqual({ ok: false, message: MANUAL_CURRENCY_REFUSAL });
    expect((await preview(addBody("USDINR27FEBFUT", "equity"))).status).toBe(400);
  });
});

describe("R4 — the form says so BEFORE submit (the save's predicate, derived at render)", () => {
  const f = (over: Partial<Parameters<typeof manualCurrencyRefused>[0]>) =>
    manualCurrencyRefused({ kind: "equity", tradingsymbol: "", underlying: "", segment: "", exchange: "", ...over });

  it("flags the Equity tab's symbol and the F&O tab's contract — and the typed underlying before an expiry exists", () => {
    expect(f({ tradingsymbol: "USDINR26OCTFUT" })).toBe(true);
    expect(f({ tradingsymbol: "usdinr" })).toBe(true);
    expect(f({ kind: "fno", tradingsymbol: "FUT USDINR 28 Oct 2026", underlying: "usdinr" })).toBe(true);
    expect(f({ kind: "fno", tradingsymbol: "OPT JPYINR 28 Oct 2026 56.5 CE", underlying: "JPYINR" })).toBe(true);
    // No expiry yet: the form has built no contract, but the underlying is already a pair.
    expect(f({ kind: "fno", tradingsymbol: "", underlying: " GBPINR " })).toBe(true);
  });

  it("does not flag an ETF whose name starts with a pair, an equity-F&O contract, or an empty form", () => {
    expect(f({ tradingsymbol: "USDINRBEES" })).toBe(false);
    expect(f({ tradingsymbol: "RELIANCE", segment: "eq_delivery", exchange: "NSE" })).toBe(false);
    expect(f({ kind: "fno", tradingsymbol: "FUT NIFTY 27 Oct 2026", underlying: "NIFTY" })).toBe(false);
    expect(f({ kind: "fno", tradingsymbol: "", underlying: "" })).toBe(false);
    expect(f({})).toBe(false);
    // The F&O tab submits no Equity override, so a stale one cannot flag it (N24's rule).
    expect(f({ kind: "fno", tradingsymbol: "FUT NIFTY 27 Oct 2026", underlying: "NIFTY", exchange: "CDS" })).toBe(false);
  });

  it("form and save ask the SAME question", () => {
    for (const s of ["USDINR26OCTFUT", "FUT USDINR 28 Oct 2026", "USDINRBEES", "RELIANCE", "OPT NIFTY 27 Oct 2026 25000 CE"]) {
      expect(f({ tradingsymbol: s }), s).toBe(isManualCurrencyTrade({ tradingsymbol: s }));
    }
  });

  it("the form renders the sentence, hides the priced preview and withholds Save while it holds — and syncs no state for it", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "components/trades/manual-trade-form.tsx"), "utf8");
    expect(src).toMatch(/const currencyRefused = manualCurrencyRefused\(\{ kind, tradingsymbol, underlying, segment, exchange \}\);/);
    expect(src).toMatch(/\{currencyRefused && \(\s*<p role="alert"[^>]*>\s*\{MANUAL_CURRENCY_REFUSAL\}/);
    expect(src).toMatch(/\{preview && !currencyRefused && \(/);
    expect(src).toMatch(/<Button type="submit" disabled=\{pending \|\| currencyRefused\}/);
    // Derived, never set: AGENTS.md "Never silence react-hooks/set-state-in-effect — derive instead".
    expect(src).not.toMatch(/setCurrencyRefused/);
  });
});
