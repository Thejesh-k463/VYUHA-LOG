import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { PositionTrade } from "@/lib/analytics/positions";
import type { ParsedFile } from "@/lib/import/types";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * V3 (v4.3.0 wave 2H seam re-run 3, pre-existing): a stored MTF funded amount of
 * 0 is a STATED amount — the whole position paid from the trader's own capital —
 * not "never set". `updateManualTrade` (lib/import/commit.ts) read it with
 * `t.mtfFundedAmount && t.mtfFundedAmount > 0` and re-estimated the funding on the
 * next save, even a notes-only one, while the editor's preview
 * (components/trades/edit-trade-dialog.tsx, `trade.mtfFundedAmount ??`) kept 0.
 * Probe 2026-09-15, Zerodha MTF 100 @100 → @110, 1 Aug → 1 Sep: the editor saved
 * own capital 10,000 → funded 0 / interest 0 / net 913.68; the next notes-only
 * save stored funded 8,000 / interest 99.20 / charges 220.92 / net 779.08 beside
 * a preview of [1000, 86.32, 913.68]. closePosition, closeStaleLot and
 * applyOverride read it the same way; all four now keep a stored 0 and re-estimate
 * only a null (never set).
 *
 * The editor's preview is its own `editPreviewBody` over the real route; the
 * own-capital figure the dialog feeds it is its line-138 fallback, restated here
 * and pinned against the dialog source below.
 *
 * ONE temp database per FILE (AGENTS.md Testing); every module that reaches
 * lib/db is imported dynamically after it.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let POST: (req: Request) => Promise<Response>;
let editPreviewBody: typeof import("@/components/trades/edit-trade-dialog").editPreviewBody;
let closePreviewBody: typeof import("@/components/trades/close-trade-dialog").closePreviewBody;
let toSlimTrade: typeof import("@/lib/domain/slim-trade").toSlimTrade;
let accrueMtfInterest: typeof import("@/lib/jobs/mtf-accrual").accrueMtfInterest;
let actions: typeof import("@/app/trades/actions");
let buildManualPreviewBody: typeof import("@/components/trades/manual-preview-body").buildManualPreviewBody;
let deriveOpenPositions: typeof import("@/lib/analytics/positions").deriveOpenPositions;

// Measured locally 2026-09-15: migrate + seed + the commit, route and both dialog
// imports ~2 s, inside the 3 s local hook budget. The raised timeout is for the
// Windows runner (> 15x slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("mtf-funded-zero", { seed: true });
  commit = await import("@/lib/import/commit");
  ({ POST } = await import("@/app/api/charges/preview/route"));
  ({ editPreviewBody } = await import("@/components/trades/edit-trade-dialog"));
  ({ closePreviewBody } = await import("@/components/trades/close-trade-dialog"));
  ({ toSlimTrade } = await import("@/lib/domain/slim-trade"));
  ({ accrueMtfInterest } = await import("@/lib/jobs/mtf-accrual"));
  actions = await import("@/app/trades/actions");
  ({ buildManualPreviewBody } = await import("@/components/trades/manual-preview-body"));
  ({ deriveOpenPositions } = await import("@/lib/analytics/positions"));
}, 120_000);
afterAll(() => t?.cleanup());

const r2 = (n: number) => Math.round(n * 100) / 100;
const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;
const wire = (id: number) => JSON.parse(JSON.stringify(toSlimTrade(row(id)))) as ReturnType<typeof toSlimTrade>;
/** [funded, interest, gross, charges, net] as stored. */
const stored = (id: number) => {
  const r = row(id);
  return [r.mtfFundedAmount, r.mtfInterest, r.grossPnl, r.chargesTotal, r.netPnl];
};

const LEGS = { buyQty: 100, avgBuyPrice: 100, buyDate: "2026-08-01", sellQty: 100, avgSellPrice: 110, sellDate: "2026-09-01" };

function mtfRow(sym: string, over: Record<string, unknown>) {
  return t.db
    .insert(t.schema.trades)
    .values(tradeRow({ broker: "zerodha", segment: "eq_mtf", symbol: sym, tradingsymbol: sym, buyOrderCount: 1, sellOrderCount: 1, ...over }))
    .returning({ id: t.schema.trades.id })
    .get()!.id;
}

async function route(body: unknown): Promise<number[]> {
  const res = await POST(
    new Request("http://localhost:3011/api/charges/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
  expect(res.status).toBe(200);
  const j = (await res.json()) as { breakdown: { total: number; mtfInterest: number }; grossPnl: number; netPnl: number };
  return [j.breakdown.mtfInterest, j.grossPnl, j.breakdown.total, j.netPnl];
}

/** The editor reopened on the stored row, nothing typed in "Own capital used": the dialog's preview. */
async function editorPreview(id: number) {
  const w = wire(id);
  const positionValue = LEGS.buyQty * LEGS.avgBuyPrice;
  // edit-trade-dialog.tsx:138-139 (currentFundedGuess / currentOwnCapitalGuess); the
  // estimate half is not reached for a stored amount, which is all this file previews.
  const fundedGuess = w.mtfFundedAmount ?? Number.NaN;
  const ownCapitalGuess = Math.max(0, r2(positionValue - fundedGuess));
  return route(editPreviewBody(w, { ...LEGS, ownCapitalUsed: ownCapitalGuess }));
}

describe("V3 — a stored MTF funded amount of 0 is kept (all own capital), a null one is estimated", () => {
  it("the probe: an editor save with own capital 10,000 stores funded 0; the next notes-only save keeps funded 0 / interest 0 / net 913.68 and equals the editor's preview", async () => {
    const id = mtfRow("MTFZERO", { ...LEGS, buyValue: 10000, sellValue: 11000, isOpen: false, mtfFundedAmount: null });
    expect(commit.updateManualTrade(id, { ...LEGS, ownCapitalUsed: 10000 }).ok).toBe(true);
    expect(stored(id)).toEqual([0, 0, 1000, 86.32, 913.68]);

    const shown = await editorPreview(id);
    expect(shown).toEqual([0, 1000, 86.32, 913.68]);

    // The Save of that form: every leg sent back, own capital blank (the action reads "" as null).
    expect(commit.updateManualTrade(id, { ...LEGS, notes: "journal only", ownCapitalUsed: null }).ok).toBe(true);
    // THE assertions (on revert: funded 8000, interest 99.2, charges 220.92, net 779.08).
    expect(stored(id)).toEqual([0, 0, 1000, 86.32, 913.68]);
    expect(stored(id).slice(1), "the preview is the save").toEqual(shown);
    expect(row(id).notes).toBe("journal only");
  });

  it("a never-set (null) funded amount is still estimated on a notes-only save", () => {
    const id = mtfRow("MTFNULL", { ...LEGS, buyValue: 10000, sellValue: 11000, isOpen: false, mtfFundedAmount: null });
    expect(commit.updateManualTrade(id, { ...LEGS, notes: "n", ownCapitalUsed: null }).ok).toBe(true);
    // The probe's re-estimate for Zerodha (its bundled own-margin share of 10,000).
    expect(stored(id)).toEqual([8000, 99.2, 1000, 220.92, 779.08]);
  });

  it("closePosition keeps a stored 0: an open MTF lot paid in full closes with no interest, as its close dialog previews", async () => {
    const id = mtfRow("MTFCLOSE", { buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", isOpen: true, sellOrderCount: 0, mtfFundedAmount: 0 });
    const body = closePreviewBody(wire(id), 110, "2026-09-01", { buyDate: "2026-08-01", sellDate: "2026-09-01" });
    const shown = await route(body);
    expect(commit.closePosition(id, 110, "2026-09-01").ok).toBe(true);
    // THE assertions (on revert: funded 8000 and interest 99.2 on the save).
    expect(stored(id)).toEqual([0, 0, 1000, 86.32, 913.68]);
    expect(stored(id).slice(1), "the close preview is the close").toEqual(shown);
  });

  it("applyOverride keeps a stored 0 when the row is re-tagged eq_mtf", () => {
    const id = mtfRow("MTFTAG", { ...LEGS, buyValue: 10000, sellValue: 11000, grossPnl: 1000, isOpen: false, mtfFundedAmount: 0 });
    expect(commit.applyOverride(id, { segment: "eq_mtf" })).toBe(true);
    // On revert: funded 8000, interest 99.2.
    expect(stored(id)).toEqual([0, 0, 1000, 86.32, 913.68]);
  });

  it("closeStaleLot keeps a stored 0, the same funded amount and interest as closePosition on a twin lot", () => {
    const trade = (over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade =>
      ({ broker: "dhan", isin: null, buyQty: 0, avgBuyPrice: 0, buyValue: 0, sellQty: 0, avgSellPrice: 0, sellValue: 0, closingPrice: null, grossPnl: 0, unrealisedPnl: 0, buyDate: null, sellDate: null, productHint: "mtf", exchangeHint: "NSE", sourceFile: null, ...over }) as NormalizedTrade;
    const file = (trades: NormalizedTrade[]): ParsedFile => ({ sourceId: "dhan-api", broker: "dhan", format: "api", trades, warnings: [] });
    const rowsOf = (acc: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, acc)).all().sort((a, b) => a.id - b.id);
    const zeroFunded = (id: number) => t.db.update(t.schema.trades).set({ mtfFundedAmount: 0 }).where(eq(t.schema.trades.id, id)).run();

    t.db.insert(t.schema.accounts).values([{ id: 971, name: "mtf-zero-join" }, { id: 972, name: "mtf-zero-twin" }]).run();
    expect(commit.commitParsedFile(file([trade({ tradingsymbol: "SBIN", buyQty: 20, avgBuyPrice: 500, buyValue: 10000, buyDate: "2026-08-20" })]), "mz-buy", null, 971).added).toBe(1);
    expect(commit.commitParsedFile(file([trade({ tradingsymbol: "SBIN", sellQty: 20, avgSellPrice: 550, sellValue: 11000, sellDate: "2026-09-05" })]), "mz-sell", null, 971).added).toBe(1);
    const [L, S] = rowsOf(971);
    expect(L.segment).toBe("eq_mtf");
    zeroFunded(L.id);
    t.db.update(t.schema.settings).set({ selectedAccountId: 971 }).run();
    const joined = commit.closeStaleLot(L.id, S.id, "2026-09-05");
    expect(joined.ok, joined.message).toBe(true);

    expect(commit.commitParsedFile(file([trade({ tradingsymbol: "SBIN", buyQty: 20, avgBuyPrice: 500, buyValue: 10000, buyDate: "2026-08-20" })]), "mz-twin", null, 972).added).toBe(1);
    const [twin] = rowsOf(972);
    zeroFunded(twin.id);
    expect(commit.closePosition(twin.id, 550, "2026-09-05").ok).toBe(true);

    const j = row(L.id);
    const m = row(twin.id);
    // On revert of the join's read: funded re-estimated above 0 with interest to the date.
    expect([j.mtfFundedAmount, j.mtfInterest]).toEqual([0, 0]);
    expect([m.mtfFundedAmount, m.mtfInterest, m.pledgeCharges]).toEqual([j.mtfFundedAmount, j.mtfInterest, j.pledgeCharges]);
  });

  /**
   * I1 [2] (wave 2I): this scan used to read lib/import/commit.ts ALONE while
   * claiming "every reader", so the three live readers that still treated a
   * stated 0 as never set (lib/analytics/positions.ts:128,
   * app/reports/broker-compare/page.tsx:59, lib/analytics/data-quality.ts:883)
   * passed it untouched — and one of them was a silent wrong number on /equity.
   * It now walks lib/, app/ and components/ with NOTHING allow-listed.
   * Measured locally 2026-09-15: 120 ms for the whole walk (639 files).
   */
  it("every reader in lib/, app/ and components/ uses the same null-vs-0 rule (no `> 0` or truthiness guard left)", () => {
    const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    for (const root of ["lib", "app", "components"]) walk(path.join(process.cwd(), root));

    // The shapes that read a STATED 0 as "never set". The CORRECT reads — `??`,
    // `== null` / `!= null`, and the `?:` of an optional property — are not
    // matched, which is why nothing needs allow-listing.
    const GUARDS = [
      /mtfFundedAmount\s*&&/, // truthiness conjunction
      /mtfFundedAmount\s*(?:>|>=|<|<=)\s*0/, // a comparison against zero
      /!\s*[\w.]*\bmtfFundedAmount\b/, // a negated read
      /mtfFundedAmount\s*\?(?![?:.])/, // a truthiness ternary
    ];
    const hits: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      if (!text.includes("mtfFundedAmount")) continue;
      text.split(/\r?\n/).forEach((line, i) => {
        if (GUARDS.some((re) => re.test(line))) hits.push(`${path.relative(process.cwd(), f).replace(/\\/g, "/")}:${i + 1} ${line.trim()}`);
      });
    }
    expect(hits, "a reader that treats a stated 0 as never set").toEqual([]);
    expect(/const currentFundedGuess = trade\.mtfFundedAmount \?\?/.test(src("components/trades/edit-trade-dialog.tsx")), "the editor preview's null-vs-0 read").toBe(true);
  });
});

/**
 * X2 (v4.3.0 wave 2H seam fix 5, pre-existing) — the daily MTF accrual job
 * (lib/jobs/mtf-accrual.ts, run on every /equity open) read a stored funded 0
 * with `t.mtfFundedAmount && t.mtfFundedAmount > 0` and `<= 0`, so it wrote the
 * margin estimate over it and accrued interest; closePosition (V3) then kept
 * that. Probe 2026-09-15 (seams-v43-fixE V3): funded 0 stated, the job on 20 Aug
 * wrote funded 8,000 / interest 60.80; closed @110 on 1 Sep it stored 8,000 /
 * 99.20 / 220.92 / 779.08 instead of 0 / 0 / 86.32 / 913.68. The job now uses
 * V3's rule: `mtfFundedAmount ?? estimate`.
 */
describe("X2 (i) — the daily accrual job keeps a stated funded 0 and accrues nothing on it; a null one is still estimated", () => {
  it("a stated 0 through the job on 20 Aug, then closePosition on 1 Sep: 0 / 0 / 913.68, as the close dialog previews", async () => {
    const id = mtfRow("ACCZERO", { buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", isOpen: true, sellOrderCount: 0, mtfFundedAmount: 0 });
    const before = stored(id);
    accrueMtfInterest("2026-08-20");
    // On revert: funded 8000 and interest 60.8 written onto the open row.
    expect(stored(id), "the job leaves a stated 0 alone").toEqual(before);

    const shown = await route(closePreviewBody(wire(id), 110, "2026-09-01", { buyDate: "2026-08-01", sellDate: "2026-09-01" }));
    expect(commit.closePosition(id, 110, "2026-09-01").ok).toBe(true);
    // THE assertions (on revert: 8000 / 99.2 / 1000 / 220.92 / 779.08).
    expect(stored(id)).toEqual([0, 0, 1000, 86.32, 913.68]);
    expect(stored(id).slice(1), "the close preview is the close").toEqual(shown);
  });

  it("a never-set (null) funded amount is still estimated by the job, with interest to the date", () => {
    const id = mtfRow("ACCNULL", { buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", isOpen: true, sellOrderCount: 0, mtfFundedAmount: null });
    accrueMtfInterest("2026-08-20");
    const r = row(id);
    // Zerodha's bundled own-margin share of 10,000, 19 days (the probe's 60.80).
    expect([r.mtfFundedAmount, r.mtfInterest]).toEqual([8000, 60.8]);
  });
});

/**
 * X2 (ii) (pre-existing, low) — both trade actions parsed "Own capital used" with
 * `num(...) || null`, so a typed 0 (the whole position broker-funded) was read as
 * blank, while both forms' previews send the typed 0 and price it
 * (edit-trade-dialog.tsx `ownCapitalUsed !== "" ? Number(...)`, manual-trade-form.tsx
 * `Number(...) >= 0 && !== ""`). Probe (seams-v43-fixE V3): the closed row with 0
 * typed previewed interest 124 / charges 245.72 / net 754.28 and saved 0 / 86.32 /
 * 913.68. Now blank (empty or missing) → null, a typed 0 → 0.
 */
describe("X2 (ii) — own capital typed 0 is a stated figure (funded = the full position value); blank stays null", () => {
  const NO_STATE = { ok: false, message: "" };
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return fd;
  };
  const editForm = (id: number, ownCapitalUsed: string | null) =>
    form({
      tradeId: String(id),
      buyQty: "100", avgBuyPrice: "100", buyDate: LEGS.buyDate, sellQty: "100", avgSellPrice: "110", sellDate: LEGS.sellDate,
      ...(ownCapitalUsed == null ? {} : { ownCapitalUsed }),
    });

  it("the trade editor: typed '0' stores funded 10,000 and the interest the editor previewed for it", async () => {
    const id = mtfRow("OWNZERO", { ...LEGS, buyValue: 10000, sellValue: 11000, isOpen: false, mtfFundedAmount: 0 });
    const shown = await route(editPreviewBody(wire(id), { ...LEGS, ownCapitalUsed: 0 }));
    const res = await actions.updateTradeAction(NO_STATE, editForm(id, "0"));
    expect([res.ok, res.message]).toEqual([true, "Trade updated."]);
    // THE assertions (on revert: the 0 read as blank keeps funded 0 — [0, 0, 1000, 86.32, 913.68]).
    expect(stored(id)).toEqual([10000, 124, 1000, 245.72, 754.28]);
    expect(stored(id).slice(1), "the preview is the save").toEqual(shown);
  });

  it("the trade editor: blank or missing own capital is null — a stored amount is kept, a never-set one estimated", async () => {
    const kept = mtfRow("OWNBLANK0", { ...LEGS, buyValue: 10000, sellValue: 11000, isOpen: false, mtfFundedAmount: 0 });
    expect((await actions.updateTradeAction(NO_STATE, editForm(kept, ""))).ok).toBe(true);
    expect(stored(kept)).toEqual([0, 0, 1000, 86.32, 913.68]);
    const estimated = mtfRow("OWNBLANKN", { ...LEGS, buyValue: 10000, sellValue: 11000, isOpen: false, mtfFundedAmount: null });
    expect((await actions.updateTradeAction(NO_STATE, editForm(estimated, null))).ok).toBe(true);
    expect(stored(estimated)).toEqual([8000, 99.2, 1000, 220.92, 779.08]);
  });

  it("the Add-trade form: typed '0' stores funded 10,000 as its preview prices it; blank estimates", async () => {
    t.db.insert(t.schema.accounts).values({ id: 973, name: "mtf-own-zero-create" }).run();
    const preview = (sym: string, own: number | null) =>
      buildManualPreviewBody({
        broker: "zerodha", tradingsymbol: sym, productHint: "mtf", segment: "eq_mtf", exchange: "NSE", direction: "buy", open: false,
        entryQty: 100, entryPrice: 100, entryDate: LEGS.buyDate, exitQty: 100, exitPrice: 110, exitDate: LEGS.sellDate, ownCapitalUsed: own, daysHeld: 31,
      });
    const create = (sym: string, own: string) =>
      actions.createManualTrade(
        NO_STATE,
        form({
          broker: "zerodha", tradingsymbol: sym, productHint: "mtf", segment: "eq_mtf", exchange: "NSE", direction: "buy",
          buyQty: "100", avgBuyPrice: "100", buyDate: LEGS.buyDate, sellQty: "100", avgSellPrice: "110", sellDate: LEGS.sellDate,
          ownCapitalUsed: own, daysHeld: "31", accountId: "973",
        }),
      );
    const bySymbol = (sym: string) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.tradingsymbol, sym)).get()!;

    const shown = await route(preview("MTFADD0", 0));
    const res = await create("MTFADD0", "0");
    expect(res.ok, res.message).toBe(true);
    const zero = bySymbol("MTFADD0");
    // On revert: the 0 read as blank is estimated — funded 8000.
    expect(zero.mtfFundedAmount).toBe(10000);
    expect(stored(zero.id).slice(1), "the Add-trade preview is the save").toEqual(shown);

    expect((await create("MTFADDB", "")).ok).toBe(true);
    expect(bySymbol("MTFADDB").mtfFundedAmount, "blank is estimated").toBe(8000);
  });
});

/**
 * I1 [0] (v4.3.0 wave 2I, introduced by wave 2H) — a stated funded 0 now
 * SURVIVES every writer, so every READER must honour it too.
 * `deriveOpenPositions` still used the old `mtfFundedAmount && > 0` rule and
 * substituted the margin estimate, so the row the journal records as 100% own
 * capital was shown with `ownCapital` = invested − a fabricated estimate and
 * `roiOnCapitalPct` measured against that invented denominator (invariant 6) —
 * the "Own capital in MTF" KPI and the "ROI on capital" column on /equity,
 * /active, /targets and the Live Desk, beside a Trades-table cell
 * (lib/domain/trade-columns.ts `investedSummary`, already `??`-correct) saying
 * the opposite on the same screen. Probe (rc5-close-c): invested 20,000,
 * fundedAmount 15,000, ownCapital 5,000, ROI 40% where the truth was 20,000
 * and 10%.
 *
 * Pure — no database is touched by this block.
 */
describe("I1 [0] — deriveOpenPositions keeps a stated MTF funded 0 (all own capital) and estimates only a null", () => {
  const openMtf = (mtfFundedAmount: number | null): PositionTrade => ({
    id: 1, broker: "angelone", bucket: "equity", segment: "eq_mtf", instrumentType: "equity", exchange: "NSE",
    symbol: "Z", tradingsymbol: "Z", optionType: null, strike: null, expiry: null, isOpen: true,
    buyQty: 100, sellQty: 0, avgBuyPrice: 200, avgSellPrice: 0, closingPrice: 205,
    buyDate: "2026-08-20", sellDate: null, mtfFundedAmount, mtfInterest: 0,
    riskAmount: null, slPlanned: null, targetPlanned: null,
  });

  it("a stated 0: own capital is the whole ₹20,000 invested and ROI on capital is the real 2.5%", () => {
    const [p] = deriveOpenPositions([openMtf(0)], new Map(), "2026-09-19");
    // THE assertions (on revert: [20000, 500, 15000, 5000, 10] — 15,000 of
    // financing the user never took, and four times the true return).
    expect([p.invested, p.unrealised, p.fundedAmount, p.ownCapital, p.roiOnCapitalPct]).toEqual([20000, 500, 0, 20000, 2.5]);
  });

  it("a never-set (null) funded amount is still the margin estimate, unchanged", () => {
    const [p] = deriveOpenPositions([openMtf(null)], new Map(), "2026-09-19");
    // 25% own margin (DEFAULT_MTF_OWN_MARGIN_PCT) on 20,000.
    expect([p.fundedAmount, p.ownCapital, p.roiOnCapitalPct]).toEqual([15000, 5000, 10]);
  });
});
