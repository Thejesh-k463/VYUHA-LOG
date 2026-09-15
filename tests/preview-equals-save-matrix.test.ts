import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * G3 (v4.3.0) — THE PREVIEW IS THE SAVE, ONE MATRIX OVER THE WHOLE RATE CARD.
 *
 * Four separate findings in waves 2H–2L were the same sentence: the figure the
 * dialog SHOWED was not the figure its save STORED.
 *
 *   S1  a partly closed row previewed sell 40 for ₹10,200 beside a save of 100 for ₹25,200
 *   U2  the editor omitted the order counts: ₹48.52 previewed, ₹119.32 stored
 *   V4  an omitted count defaulted to 1 in the route and to the SETTING in the save
 *   I1[1] a cleared exit date made `daysHeld` NaN: ₹192.31 previewed, ₹397.46 stored
 *
 * Each was found one cell at a time. This file sweeps the whole space instead:
 * EVERY (broker, plan) in charge_config — read out of the seeded table, never a
 * hard-coded list — × four segments × the MTF funded variants (a stated 0, a
 * null, ₹16,000) × three shapes of exit date (ISO, cleared, dd-mm-yyyy) × the
 * order count sent or omitted, for BOTH halves: the close dialog's exported
 * `closePreviewBody` and the editor's `editPreviewBody`, each POSTed to the
 * REAL /api/charges/preview handler and compared, to the paisa, with what the
 * REAL `closePosition` / `updateManualTrade` store on an identical row.
 *
 * Nothing here models a half: the only arithmetic this file does is `===`.
 *
 * ONE temp database per FILE (AGENTS.md Testing). Every cell is an independent
 * `trades` ROW rather than a copy of the database: the product code under test
 * binds to lib/db's cached connection, so a serialized in-memory copy could not
 * be driven through it, and a fresh row is cheaper than a fresh database
 * anyway. Each `it` is one (segment × exit-date) slice; the cells inside it are
 * collected and asserted as a LIST, so a red names every cell that diverges
 * instead of stopping at the first.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let POST: (req: Request) => Promise<Response>;
let closePreviewBody: typeof import("@/components/trades/close-trade-dialog").closePreviewBody;
let resolveExitIso: typeof import("@/components/trades/close-trade-dialog").resolveExitIso;
let editPreviewBody: typeof import("@/components/trades/edit-trade-dialog").editPreviewBody;
let toSlimTrade: typeof import("@/lib/domain/slim-trade").toSlimTrade;
let getMtfMarginByBroker: typeof import("@/lib/queries/margin").getMtfMarginByBroker;
let defaultMtfFundedAmount: typeof import("@/lib/risk/margin").defaultMtfFundedAmount;
let DEFAULT_MTF_OWN_MARGIN_PCT: number;
let findRates: typeof import("@/lib/engine/rates").findRates;
let loadRatesMap: typeof import("@/lib/engine/rates-db").loadRatesMap;

/** (broker, plan) as charge_config actually holds them. */
let BROKER_PLANS: { broker: string; plan: string }[] = [];
let mtfPct: Record<string, number> = {};

// Measured locally 2026-09-15: migrate + seed + the commit, route and dialog
// imports ~1.5 s, inside the 3 s local hook budget. The raised timeout is for
// the Windows runner (> 15x slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("preview-equals-save-matrix", { seed: true });
  commit = await import("@/lib/import/commit");
  ({ POST } = await import("@/app/api/charges/preview/route"));
  ({ closePreviewBody, resolveExitIso } = await import("@/components/trades/close-trade-dialog"));
  ({ editPreviewBody } = await import("@/components/trades/edit-trade-dialog"));
  ({ toSlimTrade } = await import("@/lib/domain/slim-trade"));
  ({ getMtfMarginByBroker } = await import("@/lib/queries/margin"));
  ({ defaultMtfFundedAmount, DEFAULT_MTF_OWN_MARGIN_PCT } = await import("@/lib/risk/margin"));
  ({ findRates } = await import("@/lib/engine/rates"));
  ({ loadRatesMap } = await import("@/lib/engine/rates-db"));

  // THE broker dimension, from the table itself (invariant 3: rates come only
  // from charge_config, so the list of rate cards does too).
  BROKER_PLANS = t.sqlite.prepare("SELECT DISTINCT broker, plan FROM charge_config ORDER BY broker, plan").all() as typeof BROKER_PLANS;
  mtfPct = getMtfMarginByBroker();
  // Defaults that are NOT 1, so an omitted order count is distinguishable from
  // the route's old hard default (V4).
  t.db.update(t.schema.settings).set({ defaultBuyOrders: 3, defaultSellOrders: 2 }).run();
}, 120_000);
afterAll(() => t?.cleanup());

const BUY_ISO = "2026-07-15";
/** The same day, three ways the field can hold it, plus the cleared field. */
const EXITS: [tag: string, raw: string][] = [
  ["ISO", "2026-08-14"],
  ["cleared", ""],
  ["dd-mm-yyyy", "14-08-2026"],
];
type FundedTag = "stated-0" | "null" | "16000";
const FUNDED: Record<FundedTag, number | null> = { "stated-0": 0, null: null, "16000": 16000 };

interface SegFixture {
  segment: string;
  bucket: string;
  instrumentType: string;
  qty: number;
  entry: number;
  exit: number;
  extra: Record<string, unknown>;
}
const SEGMENTS: SegFixture[] = [
  { segment: "eq_delivery", bucket: "equity", instrumentType: "equity", qty: 100, entry: 200, exit: 255, extra: {} },
  { segment: "eq_mtf", bucket: "equity", instrumentType: "equity", qty: 100, entry: 200, exit: 255, extra: {} },
  { segment: "eq_intraday", bucket: "equity", instrumentType: "equity", qty: 100, entry: 200, exit: 255, extra: {} },
  {
    segment: "stock_option",
    bucket: "active",
    instrumentType: "option",
    qty: 100,
    entry: 5,
    exit: 8,
    extra: { optionType: "CE", strike: 100, expiry: "2026-09-24" },
  },
];

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;
const wire = (id: number) => JSON.parse(JSON.stringify(toSlimTrade(row(id)))) as ReturnType<typeof toSlimTrade>;
/** What the save STORED: gross, charges, net, MTF interest — rupees, to the paisa. */
const saved = (id: number) => {
  const r = row(id);
  return [r.grossPnl, r.chargesTotal, r.netPnl, r.mtfInterest];
};

let seq = 0;
function openRow(seg: SegFixture, broker: string, funded: number | null, storedCloseCount: number): number {
  const sym = `M${++seq}`;
  return t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        broker,
        bucket: seg.bucket,
        segment: seg.segment,
        instrumentType: seg.instrumentType,
        exchange: "NSE",
        symbol: sym,
        tradingsymbol: seg.instrumentType === "option" ? `${sym}100CESEP26` : sym,
        buyQty: seg.qty,
        avgBuyPrice: seg.entry,
        buyValue: seg.qty * seg.entry,
        buyDate: BUY_ISO,
        buyOrderCount: 1,
        sellQty: 0,
        avgSellPrice: 0,
        sellValue: 0,
        sellDate: null,
        sellOrderCount: storedCloseCount,
        isOpen: true,
        mtfFundedAmount: seg.segment === "eq_mtf" ? funded : null,
        ...seg.extra,
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;
}

/** The route's answer as the dialog renders it, or null when it refuses. */
async function preview(body: unknown): Promise<number[] | null> {
  const res = await POST(
    new Request("http://localhost:3011/api/charges/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The WIRE, not the object: NaN only becomes null through JSON.
      body: JSON.stringify(body),
    }),
  );
  if (res.status !== 200) return null;
  const j = (await res.json()) as { breakdown: { total: number; mtfInterest: number }; grossPnl: number; netPnl: number };
  return [j.grossPnl, j.breakdown.total, j.netPnl, j.breakdown.mtfInterest];
}

interface CellResult {
  label: string;
  shown: number[] | null;
  stored: number[] | null;
  ok: boolean;
}

/** One cell: build the row, preview it, save it, compare the four figures. */
function compare(label: string, shown: number[] | null, stored: number[] | null): CellResult {
  const ok = shown != null && stored != null && shown.length === 4 && shown.every((v, i) => v === stored[i]);
  return { label, shown, stored, ok };
}

const divergent = (cells: CellResult[]) =>
  cells.filter((c) => !c.ok).map((c) => `${c.label}: preview ${JSON.stringify(c.shown)} vs save ${JSON.stringify(c.stored)}`);

/** Every cell of one (segment × exit-date × funded) slice, for the CLOSE dialog. */
async function closeSlice(seg: SegFixture, exitRaw: string, exitTag: string, ft: FundedTag): Promise<CellResult[]> {
  const out: CellResult[] = [];
  for (const { broker, plan } of BROKER_PLANS) {
    for (const counts of ["sent", "omitted"] as const) {
      const id = openRow(seg, broker, FUNDED[ft], counts === "sent" ? 2 : 0);
      const w = wire(id);
      const exitIso = resolveExitIso(exitRaw);
      // The dialog's own call site (components/trades/close-trade-dialog.tsx):
      // a long's exit lands on the SELL side, at the resolved date.
      const body = closePreviewBody(w, seg.exit, exitRaw, { buyDate: w.buyDate, sellDate: exitIso });
      const shown = await preview(body);
      // `closeTradeAction`'s own read of the field (str(): "" → null).
      const res = commit.closePosition(id, seg.exit, exitRaw === "" ? null : exitRaw);
      out.push(compare(`close ${broker}/${plan} ${seg.segment} funded=${ft} exit=${exitTag} counts=${counts}`, shown, res.ok ? saved(id) : null));
    }
  }
  return out;
}

/**
 * The same slice through the EDITOR: its preview body against updateManualTrade.
 *
 * `buyRaw` is the BUY date as the field holds it — ISO or dd-mm-yyyy (wave 2M).
 * The editor reads BOTH ends of the holding period, so a dd-mm-yyyy buy date is
 * the same class of divergence as a dd-mm-yyyy exit date and is swept the same way.
 */
async function editSlice(seg: SegFixture, exitRaw: string, exitTag: string, ft: FundedTag, buyRaw: string = BUY_ISO): Promise<CellResult[]> {
  const out: CellResult[] = [];
  for (const { broker, plan } of BROKER_PLANS) {
    for (const counts of ["sent", "omitted"] as const) {
      const id = openRow(seg, broker, FUNDED[ft], counts === "sent" ? 2 : 0);
      const w = wire(id);
      // EditTradeDialog's own call site: an untouched "Own capital used" field
      // sends the guess it displays — the stored funded amount if there is
      // one, else the broker's own-margin estimate (never a generic guess).
      const positionValue = seg.qty * seg.entry;
      const brokerPct = mtfPct[broker] ?? DEFAULT_MTF_OWN_MARGIN_PCT;
      const fundedGuess = w.mtfFundedAmount ?? (positionValue > 0 ? defaultMtfFundedAmount(positionValue, brokerPct) : 0);
      const fields = {
        buyQty: seg.qty,
        avgBuyPrice: seg.entry,
        sellQty: seg.qty,
        avgSellPrice: seg.exit,
        buyDate: buyRaw,
        sellDate: exitRaw === "" ? null : exitRaw,
        ownCapitalUsed: seg.segment === "eq_mtf" ? Math.max(0, Math.round((positionValue - fundedGuess) * 100) / 100) : null,
      };
      const body = editPreviewBody(w, fields);
      const shown = body == null ? null : await preview(body);
      const res = commit.updateManualTrade(id, fields);
      out.push(compare(`edit ${broker}/${plan} ${seg.segment} funded=${ft} exit=${exitTag} buy=${buyRaw} counts=${counts}`, shown, res.ok ? saved(id) : null));
    }
  }
  return out;
}

/**
 * A slice that priced nothing would pass `divergent === []` vacuously, so every
 * slice states what it billed: one cell per rate card × order-count variant,
 * every save succeeded, every save stored a real charge total — and, on MTF,
 * that the funded dimension is LIVE (a stated 0 accrues nothing and is never
 * re-estimated, V3/X2; a null accrues on the estimate; ₹16,000 accrues on every
 * card that quotes a rate).
 */
function notVacuous(cells: CellResult[], seg: SegFixture, ft: FundedTag, datedExit: boolean) {
  expect(cells).toHaveLength(BROKER_PLANS.length * 2);
  expect(cells.every((c) => c.stored != null), "every cell's save succeeded").toBe(true);
  expect(cells.every((c) => (c.stored?.[1] ?? 0) > 0), "every cell stored a real charge total").toBe(true);
  if (seg.segment !== "eq_mtf") return;
  const interest = cells.map((c) => c.stored![3]);
  // A stated 0 accrues nothing; so does a row the save closes with NO exit date
  // (the editor's cleared field clears `sellDate`, and neither half will date a
  // holding period it does not have — they agree on 0, which is the point).
  if (ft === "stated-0" || !datedExit) expect(interest.every((v) => v === 0), "nothing to accrue on").toBe(true);
  else expect(interest.filter((v) => v > 0).length, "the cards that quote an MTF rate billed interest").toBeGreaterThan(5);
}

/** segment × exit date × funded variant — one `it` each, so no `it` runs > 18 cells. */
const slices = SEGMENTS.flatMap((seg) =>
  EXITS.flatMap(([tag, raw]) =>
    (seg.segment === "eq_mtf" ? (["stated-0", "null", "16000"] as FundedTag[]) : (["null"] as FundedTag[])).map(
      (ft) => [seg.segment, tag, ft, seg, raw] as const,
    ),
  ),
);

describe("G3 — the close dialog's preview equals what closePosition stores", () => {
  it.each(slices)("%s, exit %s, funded %s: every rate card × order-count cell agrees to the paisa", async (_s, tag, ft, seg, raw) => {
    const cells = await closeSlice(seg, raw, tag, ft);
    // The close dialog dates a cleared field TODAY, so its exit is always dated.
    notVacuous(cells, seg, ft, true);
    // THE assertion. On revert of S1/U2/V4/I1[1] this names every cell that
    // diverges, with both sets of figures.
    expect(divergent(cells), "close preview ≠ close save").toEqual([]);
  });
});

describe("G3 — the editor's preview equals what updateManualTrade stores", () => {
  /**
   * FINDING G-G3-2 (product, low) — FIXED in v4.3.0 fix wave 2M, so the
   * dd-mm-yyyy MTF slices are back in the ONE green list below, and the BUY date
   * is now a dimension of it too.
   *
   * `editPreviewBody` took its holding period off the RAW date fields
   * (`new Date(f.sellDate)`) — the defect wave 2I fixed in the CLOSE dialog
   * (I1[1], `resolveExitIso`) and never carried across to the editor.
   * `new Date("14-08-2026")` is an Invalid Date, so `daysHeld` was NaN, JSON sent
   * it as null, and the route's `v.daysHeld ?? 0` billed ZERO days of MTF
   * interest — while `updateManualTrade` normalised the same field
   * (`normalizeDate` → 2026-08-14) and charged the real 30 days. Measured
   * 2026-09-15 on this matrix, angelone eq_mtf 100 @200 → @255, funded 16,000:
   * preview [5500, 192.31, 5307.69, 0] against a stored [5500, 397.46, 5102.54,
   * 205.15] — the same ₹205.15 the close dialog used to hide.
   *
   * Both ends are resolved now, through the same `normalizeDate` the save reads
   * (lib/domain/trading-day, pure since wave 2M). A BLANK sell date still bills 0
   * days on both sides — that is `updateManualTrade`'s own semantics, where blank
   * CLEARS the field; the close dialog's blank-is-today belongs to the close.
   */
  const BUYS: [tag: string, raw: string][] = [
    ["ISO", BUY_ISO],
    ["dd-mm-yyyy", "15-07-2026"],
  ];
  /** segment × exit date × funded × BUY-date shape — 36 `it`s of 18 cells each. */
  const editSlices = slices.flatMap(([segName, tag, ft, seg, raw]) =>
    BUYS.map(([btag, braw]) => [`${segName} (buy ${btag})`, tag, ft, seg, raw, braw] as const),
  );

  it.each(editSlices)("%s, exit %s, funded %s: every rate card × order-count cell agrees to the paisa", async (_s, tag, ft, seg, raw, buyRaw) => {
    const cells = await editSlice(seg, raw, tag, ft, buyRaw);
    notVacuous(cells, seg, ft, raw !== "");
    expect(divergent(cells), "editor preview ≠ editor save").toEqual([]);
  });

  it("FINDING G-G3-2, fixed: the dd-mm-yyyy MTF cells agree BECAUSE both halves now bill the same 30 days", async () => {
    const seg = SEGMENTS.find((s) => s.segment === "eq_mtf")!;
    const cells = await editSlice(seg, "14-08-2026", "dd-mm-yyyy", "16000");
    // THE assertion, on the very cells that were red on HEAD 8ff4288.
    expect(divergent(cells), "editor preview ≠ editor save").toEqual([]);
    // …and not because both sides now bill NOTHING: the cards that quote an MTF
    // rate really do charge the ₹205.15-shaped interest, on BOTH sides.
    const billed = cells.filter((c) => c.stored![3] > 0);
    expect(billed.length).toBeGreaterThan(5);
    expect(billed.every((c) => c.shown![3] === c.stored![3]), "the preview bills the interest the save stores").toBe(true);
    // The same day, written ISO, prices identically — so it is the DATE READING
    // that changed and nothing else about the slice. One card, two rows: the
    // whole-slice comparison costs another 18 cells and says no more than this.
    const fieldsFor = (sellDate: string) => ({
      buyQty: seg.qty, avgBuyPrice: seg.entry, sellQty: seg.qty, avgSellPrice: seg.exit,
      buyDate: BUY_ISO, sellDate, ownCapitalUsed: 4000,
    });
    const twin = (sellDate: string) => {
      const id = openRow(seg, "angelone", 16000, 0);
      expect(commit.updateManualTrade(id, fieldsFor(sellDate)).ok).toBe(true);
      return saved(id);
    };
    expect(twin("14-08-2026")).toEqual(twin("2026-08-14"));

    // The source half: BOTH dialogs read the calendar through the shared helper.
    const editSrc = fs.readFileSync(path.join(process.cwd(), "components/trades/edit-trade-dialog.tsx"), "utf8");
    const closeSrc = fs.readFileSync(path.join(process.cwd(), "components/trades/close-trade-dialog.tsx"), "utf8");
    expect(/daysHeld:[^\n]*new Date\(f\.sellDate\)/.test(editSrc), "the editor's raw read is gone").toBe(false);
    expect(/normalizeDate/.test(editSrc) && /from "@\/lib\/domain\/trading-day"/.test(editSrc), "the editor's resolved read").toBe(true);
    expect(/resolveExitIso\(exitDate\)/.test(closeSrc), "the close dialog's resolved read").toBe(true);
    expect(/from "@\/lib\/domain\/trading-day"/.test(closeSrc), "…from the same module").toBe(true);
  });

  /**
   * L3's other half, on the editor: a NON-EMPTY date that is not a real calendar
   * day. The save REFUSES it, so there is no figure to preview — both halves
   * refuse, and nothing is priced or sent (invariant 6).
   */
  it.each([["sell date", "2026-02-31"], ["buy date", "99-99-9999"]] as const)(
    "a %s of %j: the save refuses it and the preview is not built at all",
    async (label, badDate) => {
      const seg = SEGMENTS.find((s) => s.segment === "eq_mtf")!;
      const id = openRow(seg, "angelone", 16000, 0);
      const before = row(id);
      const fields = {
        buyQty: seg.qty,
        avgBuyPrice: seg.entry,
        sellQty: seg.qty,
        avgSellPrice: seg.exit,
        buyDate: label === "buy date" ? badDate : BUY_ISO,
        sellDate: label === "sell date" ? badDate : "2026-08-14",
        ownCapitalUsed: 4000,
      };
      // No body, so no request: the dialog states the refusal where the figure
      // would be (`editDateProblem`), and sends nothing.
      expect(editPreviewBody(wire(id), fields)).toBeNull();

      const res = commit.updateManualTrade(id, fields);
      expect(res.ok).toBe(false);
      expect(res.message).toContain(badDate);
      expect(res.message).toContain(label);
      expect(row(id)).toEqual(before);
    },
  );
});

describe("G3 — the dimensions of the matrix are the real ones", () => {
  it("the broker × plan list comes from charge_config, and covers every seeded broker", () => {
    const brokers = [...new Set(BROKER_PLANS.map((b) => b.broker))];
    const seeded = (t.sqlite.prepare("SELECT DISTINCT broker FROM charge_config ORDER BY broker").all() as { broker: string }[]).map((r) => r.broker);
    expect(brokers).toEqual(seeded);
    expect(BROKER_PLANS.length).toBeGreaterThan(brokers.length); // at least one paid plan
    expect(BROKER_PLANS.some((b) => b.plan !== "default")).toBe(true);
  });

  /**
   * A paid plan cannot split the preview from the save, because NEITHER half
   * passes one: `findRates` defaults to "default" in the route and in
   * `closePosition` alike. Stated as a fact with its consequence measured, so
   * that wiring a plan into one half and not the other reddens here.
   */
  it("neither half prices at a non-default plan, though charge_config holds one that differs", async () => {
    const paid = BROKER_PLANS.find((b) => b.plan !== "default")!;
    const map = loadRatesMap();
    const onDefault = findRates(map, paid.broker as never, "eq_mtf", "NSE", "2026-08-14");
    const onPaid = findRates(map, paid.broker as never, "eq_mtf", "NSE", "2026-08-14", paid.plan);
    // The paid card really is a different rate card (else the pin proves nothing).
    expect(onPaid.mtfInterestAnnual).not.toBe(onDefault.mtfInterestAnnual);

    const seg = SEGMENTS.find((s) => s.segment === "eq_mtf")!;
    const id = openRow(seg, paid.broker, 16000, 0);
    const w = wire(id);
    const shown = await preview(closePreviewBody(w, seg.exit, "2026-08-14", { buyDate: BUY_ISO, sellDate: "2026-08-14" }));
    expect(commit.closePosition(id, seg.exit, "2026-08-14").ok).toBe(true);
    const stored = saved(id);
    expect(shown).toEqual(stored);
    // Both at the DEFAULT card: the interest is 30 days at the default rate.
    expect(stored[3]).toBe(Math.round(((16000 * onDefault.mtfInterestAnnual * 30) / 365) * 100) / 100);
    expect(stored[3]).not.toBe(Math.round(((16000 * onPaid.mtfInterestAnnual * 30) / 365) * 100) / 100);
  });
});
