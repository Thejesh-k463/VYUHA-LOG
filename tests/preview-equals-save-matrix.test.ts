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
// D20 (wave 2O): a STAGED parent is priced by its ladder alone, so the staged
// cells below build the ladder through its OWN door rather than faking legs.
let stagedQ: typeof import("@/lib/queries/staged");
// No margin-estimate imports: since Q-A neither half of the matrix estimates a
// funded amount, so the broker own-margin table is not a dimension of it.
let findRates: typeof import("@/lib/engine/rates").findRates;
let loadRatesMap: typeof import("@/lib/engine/rates-db").loadRatesMap;

/** (broker, plan) as charge_config actually holds them. */
let BROKER_PLANS: { broker: string; plan: string }[] = [];

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
  stagedQ = await import("@/lib/queries/staged");
  ({ findRates } = await import("@/lib/engine/rates"));
  ({ loadRatesMap } = await import("@/lib/engine/rates-db"));

  // THE broker dimension, from the table itself (invariant 3: rates come only
  // from charge_config, so the list of rate cards does too).
  BROKER_PLANS = t.sqlite.prepare("SELECT DISTINCT broker, plan FROM charge_config ORDER BY broker, plan").all() as typeof BROKER_PLANS;
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
      // sends what the row STATES — buy value minus the stored funded amount —
      // and NOTHING for a row the journal never priced (Q-A, wave 2N: the
      // broker's own-margin estimate it used to send back is what turned an
      // unpriced row into a stated margin-default amount on a notes-only save).
      const positionValue = seg.qty * seg.entry;
      const stated = w.mtfFundedAmount;
      const fields = {
        buyQty: seg.qty,
        avgBuyPrice: seg.entry,
        sellQty: seg.qty,
        avgSellPrice: seg.exit,
        buyDate: buyRaw,
        sellDate: exitRaw === "" ? null : exitRaw,
        ownCapitalUsed: seg.segment === "eq_mtf" && stated != null ? Math.max(0, Math.round((positionValue - stated) * 100) / 100) : null,
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
 * re-estimated, V3/X2; a NULL accrues nothing either since Q-A — neither half
 * estimates a principal the journal does not state; ₹16,000 accrues on every
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
  // PIN MOVED (Q-A, owner ruling, wave 2N): `funded=null` joins `stated-0`.
  // Both halves keep the null and bill 0 — on revert of either, this slice goes
  // red as a DIVERGENCE (one half estimating and the other not), which is the
  // matrix's own point.
  if (ft === "stated-0" || ft === "null" || !datedExit) expect(interest.every((v) => v === 0), "nothing to accrue on").toBe(true);
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

/**
 * D4 (v4.3.0 wave 2N, `ipo` new_defects[2]) — THE OTHER HALF OF "the preview is the
 * save": an edit that changes NO charge input.
 *
 * `updateManualTrade` used to re-price on every save, so a notes-only save replaced
 * an IMPORTED row's broker-stated bill with the engine's estimate and an IPO-synced
 * holding's charges with a delivery round trip's (purchase STT on an allotment,
 * which is not due), stripping the sync's provenance marker with them. It now keeps
 * every stored head — and so must the preview, or the dialog states ₹52.72 beside a
 * row that keeps ₹37.97.
 */
describe("G3 — an edit that changes no charge input: the preview shows what the save keeps", () => {
  /** A CLOSED row whose ten heads are figures no engine would produce. */
  const statedRow = (over: Record<string, unknown>) =>
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          broker: "zerodha", symbol: `KEPT${++seq}`, tradingsymbol: `KEPT${seq}`,
          buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: BUY_ISO, buyOrderCount: 1,
          sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-08-14", sellOrderCount: 1,
          isOpen: false, grossPnl: 500,
          chargesTotal: 41.25, brokerage: 20, sttCtt: 15, exchangeTxn: 0.5, sebi: 0.15, stampDuty: 1, ipft: 0.1, gst: 4.5,
          dpCharges: 0, mtfInterest: 0, pledgeCharges: 0, netPnl: 458.75,
          ...over,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

  /** The dialog's own fields for a row it has not changed a number on. */
  const untouched = (id: number) => {
    const w = wire(id);
    return { buyQty: w.buyQty, avgBuyPrice: w.avgBuyPrice, sellQty: w.sellQty, avgSellPrice: w.avgSellPrice, buyDate: w.buyDate, sellDate: w.sellDate, ownCapitalUsed: null };
  };

  const cells: [label: string, over: Record<string, unknown>, edit: Record<string, unknown>][] = [
    ["an acquisition:'ipo' holding × notes-only", { acquisition: "ipo", acquisitionPrice: 100, acquisitionDate: BUY_ISO, chargesTotal: 2.06, brokerage: 0, sttCtt: 2, exchangeTxn: 0.05, sebi: 0, stampDuty: 0, ipft: 0, gst: 0.01, netPnl: 497.94 }, { notes: "journal only" }],
    ["an imported row with the broker's own charges × notes-only", { importNotes: "dedup-alias:abc" }, { notes: "journal only" }],
    ["a risk-amount-only edit", { riskAmount: 200, rMultiple: 2.29 }, { riskAmount: 100 }],
  ];

  it.each(cells)("%s: preview and save agree, and both keep the stored bill", async (label, over, edit) => {
    const id = statedRow(over);
    const before = saved(id);
    const fields = untouched(id);

    const shown = await preview(editPreviewBody(wire(id), fields));
    const res = commit.updateManualTrade(id, { ...fields, ...edit });
    expect(res.ok, label).toBe(true);

    // THE assertions: the row keeps what it stated, and the dialog showed it.
    expect(saved(id), `${label}: the save re-priced a row it should have kept`).toEqual(before);
    expect(shown, `${label}: preview ≠ save`).toEqual(saved(id));
  });

  it("the marker and the risk figure follow the same rule: nothing priced, R from the KEPT net", () => {
    const id = statedRow({ acquisition: "ipo", importNotes: "Exit charges computed from the linked IPO record's exit price and date; not stated by a broker.", riskAmount: 200 });
    expect(commit.updateManualTrade(id, { ...untouched(id), riskAmount: 100 }).ok).toBe(true);
    const r = row(id);
    expect(r.importNotes).toContain("Exit charges computed from the linked IPO record");
    expect([r.chargesTotal, r.netPnl, r.rMultiple]).toEqual([41.25, 458.75, 4.59]);
  });
});

/**
 * D14 / D15 (v4.3.0 fix wave 2O, dates-charges#1 and #2) — THE ALLOTMENT CELLS
 * THIS MATRIX DID NOT HAVE.
 *
 * D4(b) taught the SAVE an IPO mode (`ipoEditCharges ?? computeCharges`) but the
 * preview route learned only the KEEP branch, so on any editor edit that MOVES a
 * charge input on an `acquisition:'ipo'` row the fall-through priced
 * `computeCharges`, which has no IPO mode: measured on a 10 @100 allotment sold
 * 10 @160, the dialog showed charges 18.43 / net 581.57 (sttCtt 3, the purchase
 * STT ruling row (1) says is not due) while the row stored 17.40 / 582.60
 * (sttCtt 2). The stored figure is right; the figure the user approves was wrong
 * — exactly the class this file exists for, and it had no cell crossing `ipo` ×
 * re-price, nor an OPEN allotment on either half.
 *
 * ONE helper (`ipoEditCharges`, lib/analytics/ipo.ts — pure, with the charger
 * injected by each door) is now read by both.
 */
describe("G3 — an allotment-derived row the editor RE-PRICES (D14/D15, wave 2O)", () => {
  const HEADS = ["brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty", "ipft", "gst", "dpCharges", "mtfInterest", "pledgeCharges"] as const;

  /** The route's whole answer, not just the four figures. */
  async function previewFull(body: unknown) {
    const res = await POST(new Request("http://localhost:3011/api/charges/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(res.status).toBe(200);
    return (await res.json()) as { breakdown: Record<string, number>; grossPnl: number; netPnl: number; keptCharges?: boolean };
  }
  const headsOf = (r: Record<string, unknown>) => Object.fromEntries(HEADS.map((k) => [k, Number(r[k]) || 0]));
  const allotment = (over: Record<string, unknown>) =>
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          broker: "zerodha", symbol: `IPO${++seq}`, tradingsymbol: `IPO${seq}`,
          acquisition: "ipo", acquisitionPrice: 100, acquisitionDate: BUY_ISO,
          buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: BUY_ISO, buyOrderCount: 1,
          sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-08-14", sellOrderCount: 1,
          isOpen: false, grossPnl: 500,
          chargesTotal: 2.06, brokerage: 0, sttCtt: 2, exchangeTxn: 0.05, sebi: 0, stampDuty: 0, ipft: 0, gst: 0.01,
          dpCharges: 0, mtfInterest: 0, pledgeCharges: 0, netPnl: 497.94,
          ...over,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

  it("D14 · a moved exit price on an acquisition:'ipo' holding: the dialog's ten heads equal the stored ones, and sttCtt is 2 not 3", async () => {
    const id = allotment({});
    const fields = { buyQty: 10, avgBuyPrice: 100, sellQty: 10, avgSellPrice: 160, buyDate: BUY_ISO, sellDate: "2026-08-14", ownCapitalUsed: null };

    const shown = await previewFull(editPreviewBody(wire(id), fields));
    expect(commit.updateManualTrade(id, fields).ok).toBe(true);
    const stored = row(id) as unknown as Record<string, unknown>;

    // THE assertions (HEAD: the dialog shows sttCtt 3 / total 18.43 / net 581.57
    // beside a row that stores sttCtt 2 / 17.40 / 582.60).
    expect(headsOf(shown.breakdown)).toEqual(headsOf(stored));
    expect([shown.breakdown.total, shown.netPnl, shown.grossPnl]).toEqual([stored.chargesTotal, stored.netPnl, stored.grossPnl]);
    expect(saved(id)).toEqual([shown.grossPnl, shown.breakdown.total, shown.netPnl, shown.breakdown.mtfInterest]);
    // The purchase STT ruling row (1): 0.1% of the SALE alone (1600 → 2), never
    // of the allotment beside it (2600 → 3).
    expect(shown.breakdown.sttCtt).toBe(2);
  });

  it("D15 · an OPEN allotment: neither half bills purchase STT, and the preview says the bill was kept", async () => {
    const id = allotment({
      isOpen: true, sellQty: 0, avgSellPrice: 0, sellValue: 0, sellDate: null, sellOrderCount: 0, grossPnl: 0,
      chargesTotal: 0, sttCtt: 0, exchangeTxn: 0, gst: 0, netPnl: 0,
    });
    const ZERO = Object.fromEntries(HEADS.map((k) => [k, 0]));
    // A notes-only save, and then a quantity correction — the row states no
    // charge at all, so `statesNoCharges` forces the re-price path on both.
    for (const fields of [
      { buyQty: 10, avgBuyPrice: 100, sellQty: 0, avgSellPrice: 0, buyDate: BUY_ISO, sellDate: null, ownCapitalUsed: null },
      { buyQty: 20, avgBuyPrice: 100, sellQty: 0, avgSellPrice: 0, buyDate: BUY_ISO, sellDate: null, ownCapitalUsed: null },
    ]) {
      const shown = await previewFull(editPreviewBody(wire(id), fields));
      expect(commit.updateManualTrade(id, fields).ok).toBe(true);
      const stored = row(id) as unknown as Record<string, unknown>;
      // THE assertions (HEAD: sttCtt 1, exchangeTxn 0.03, gst 0.01, total 1.04,
      // net -1.04 on BOTH halves — money the journal fabricates).
      expect(headsOf(shown.breakdown), JSON.stringify(fields)).toEqual(ZERO);
      expect(headsOf(stored), JSON.stringify(fields)).toEqual(ZERO);
      expect([shown.breakdown.total, shown.netPnl], JSON.stringify(fields)).toEqual([0, 0]);
      expect([stored.chargesTotal, stored.netPnl], JSON.stringify(fields)).toEqual([0, 0]);
      expect(shown.keptCharges, "the dialog says whose figure it is showing").toBe(true);
    }
    expect(row(id).buyQty).toBe(20);
  });
});

/**
 * D20 (v4.3.0 fix wave 2O) — THE STAGED CELLS THIS MATRIX DID NOT HAVE.
 *
 * D20 made `rebuildStagedTrade` the SINGLE writer of a staged parent's priced
 * heads (invariant 5, parent = Σ legs): `updateManualTrade` never prices such a
 * row — a patch that moves no fill saves the journal fields and hands the pricing
 * back to the ladder, and a patch that MOVES one is refused outright. The preview
 * route knew nothing of legs, so it priced the FLAT round trip `computeCharges`
 * bills on the aggregate.
 *
 * MEASURED by the wave 2O seam round (`wave2h-reports/wave2o-S-FIX.md`, readers
 * left #1) on a 100 @100 + 50 @110 delivery ladder — parent
 * `[buyQty 150, avgBuyPrice 103.33, buyValue 15500]`: the dialog's own body over
 * the real route answered `{"total":17.59,"kept":false,"netPnl":-17.59}` while the
 * row stores the ladder's **19.59**, because two entry tranches pay two lots of
 * every per-order head and a round trip bills an exit nobody made. The stored
 * figure is right; the figure the user approves was wrong — exactly this file's
 * class, and it had no cell crossing `staged` × the editor at all.
 *
 * `editPreviewBody` sends `buyValue: buyQty × avgBuyPrice` (15,499.4999…), which
 * is why the flat predicate could never answer "kept" for a ladder either: a
 * staged parent's `buyValue` is Σ its LEG values while its `avgBuyPrice` is the
 * rounded weighted average.
 */
describe("G3 — a STAGED parent: the ladder prices it, and the dialog shows the ladder's bill (D20, wave 2O)", () => {
  const HEADS = ["brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty", "ipft", "gst", "dpCharges", "mtfInterest", "pledgeCharges"] as const;
  const headsOf = (r: Record<string, unknown>) => Object.fromEntries(HEADS.map((k) => [k, Number(r[k]) || 0]));

  /** The route's whole answer, including what it says about whose figure it is. */
  async function previewFull(body: unknown) {
    const res = await POST(new Request("http://localhost:3011/api/charges/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const j = (await res.json()) as { breakdown: Record<string, number>; grossPnl: number; netPnl: number; keptCharges?: boolean; keptReason?: string };
    expect(res.status, JSON.stringify(j)).toBe(200);
    return j;
  }

  /** A flat delivery row, 100 @100 on the buy side and nothing sold. */
  const flatRow = (tag: string) =>
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          broker: "zerodha", symbol: `${tag}${++seq}`, tradingsymbol: `${tag}${seq}`,
          buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: BUY_ISO, buyOrderCount: 1,
          sellQty: 0, avgSellPrice: 0, sellValue: 0, sellDate: null, sellOrderCount: 0, isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

  /**
   * A two-tranche ladder built through the ladder's OWN door (`convertToStaged`
   * then `addLeg`), so the parent really is Σ its legs before anything is
   * previewed — a hand-written `staged: true` row would prove nothing about the
   * figures the rebuild writes.
   */
  function ladderRow(): number {
    const id = flatRow("LADDER");
    const conv = stagedQ.convertToStaged(id);
    expect(conv.ok, conv.message).toBe(true);
    const add = stagedQ.addLeg({ tradeId: id, kind: "entry", tradeDate: "2026-07-20", qty: 50, price: 110 });
    expect(add.ok, add.message).toBe(true);
    return id;
  }

  /** The dialog's own fields for a row it has not changed a number on. */
  const untouched = (id: number) => {
    const w = wire(id);
    return { buyQty: w.buyQty, avgBuyPrice: w.avgBuyPrice, sellQty: w.sellQty, avgSellPrice: w.avgSellPrice, buyDate: w.buyDate, sellDate: w.sellDate, ownCapitalUsed: null };
  };

  it("a notes-only patch on a ladder: the ten heads the dialog shows are the ladder's own, before and after the save", async () => {
    const id = ladderRow();
    const parent = row(id);
    // The premise of the whole divergence, stated rather than assumed.
    expect(
      [parent.staged, parent.buyQty, parent.avgBuyPrice, parent.buyValue, Math.round(parent.buyQty * parent.avgBuyPrice * 100) / 100],
      "the parent's roll-up is not its own average × quantity",
    ).toEqual([true, 150, 103.33, 15500, 15499.5]);
    const before = headsOf(parent as unknown as Record<string, unknown>);
    const fields = untouched(id);

    const shown = await previewFull(editPreviewBody(wire(id), fields));
    const res = commit.updateManualTrade(id, { ...fields, notes: "journal only" });
    expect(res.ok, res.message).toBe(true);
    const after = row(id);

    // THE assertions (HEAD: the dialog shows the flat round trip's 17.59 / net
    // −17.59 beside a row storing the ladder's 19.59).
    expect(headsOf(shown.breakdown), "preview ≠ the bill the row states").toEqual(before);
    expect(headsOf(after as unknown as Record<string, unknown>), "the save re-priced a row its ladder owns").toEqual(before);
    expect([shown.breakdown.total, shown.netPnl, shown.grossPnl], "preview ≠ save").toEqual([after.chargesTotal, after.netPnl, after.grossPnl]);
    expect(shown.keptCharges, "the dialog says whose figure it is showing").toBe(true);
    expect(shown.keptReason ?? "", "…and why").toContain("ladder");
    expect(after.notes, "and the journal field really was saved").toBe("journal only");

    // NOT VACUOUS: the same aggregate as a FLAT row is billed differently, so the
    // staged branch is what produced the figures above (17.59 vs 19.59 — two
    // tranches pay two lots of every per-order head).
    const twin = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          broker: "zerodha", symbol: `FLATTWIN${++seq}`, tradingsymbol: `FLATTWIN${seq}`,
          buyQty: 150, avgBuyPrice: 103.33, buyValue: 15500, buyDate: BUY_ISO, buyOrderCount: 1,
          sellQty: 0, avgSellPrice: 0, sellValue: 0, sellDate: null, sellOrderCount: 0, isOpen: true,
          chargesTotal: parent.chargesTotal, stampDuty: parent.stampDuty, exchangeTxn: parent.exchangeTxn, gst: parent.gst, netPnl: parent.netPnl,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const flat = await previewFull(editPreviewBody(wire(twin), untouched(twin)));
    expect([flat.keptCharges ?? false, flat.breakdown.total === shown.breakdown.total], "a FLAT row of the same aggregate is still priced fresh, and differently").toEqual([false, false]);
  });

  it("a moved fill on a ladder: the preview carries the save's own refusal, and neither half changes a figure", async () => {
    const id = ladderRow();
    const before = row(id);
    // An exit typed into the editor — the fills of a staged position ARE its
    // ladder, so the save refuses this outright (D20).
    const fields = { ...untouched(id), sellQty: 150, avgSellPrice: 120, sellDate: "2026-08-14" };

    const shown = await previewFull(editPreviewBody(wire(id), fields));
    const res = commit.updateManualTrade(id, fields);
    expect(res.ok, "a patch that moves a fill on a ladder is refused").toBe(false);

    // THE assertion (HEAD: `keptReason` is undefined and the dialog shows a full
    // flat ROUND TRIP — gross 3,500 and its charges — for a save that stores
    // nothing at all).
    expect(shown.keptReason, "the preview states the refusal in the save's own words").toBe(res.message);
    expect(headsOf(shown.breakdown), "and the figures it shows are the ones the row keeps").toEqual(headsOf(before as unknown as Record<string, unknown>));
    expect([shown.breakdown.total, shown.netPnl, shown.grossPnl], "preview ≠ save").toEqual([before.chargesTotal, before.netPnl, before.grossPnl]);
    expect(row(id), "nothing was written").toEqual(before);
  });
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
