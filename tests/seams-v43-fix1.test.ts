import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { todayIstIso } from "@/lib/domain/trading-day";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v4.3.0 AUDIT ROUND 1 — THE SEAMS OF A THREE-BUILDER FIX WAVE.
 *
 * F1 owns the money core (lib/import/commit.ts, lib/import/close-open-lots.ts,
 * lib/db/data-fixes.ts). F2 owns the Dhan adapter (lib/import/api/dhan.ts).
 * F3 owns identity/DQ/UI (lib/import/broker-identity.ts,
 * lib/analytics/data-quality.ts, app/data-quality/actions.ts). Their file sets
 * are disjoint, so no builder ever ran two halves of a crossing together.
 *
 * NOTHING HERE IS MOCKED ON EITHER SIDE OF A SEAM. The only stub is
 * `globalThis.fetch` — that is the NETWORK, not a half of any crossing: every
 * Dhan payload goes through the real `dhanImportSource().fetchTrades()`,
 * the real `normalizeDhanTrades` / `normalizeDhanPositions` / `toParsedFile`,
 * and the real `previewParsedFile` / `commitParsedFile` against ONE real
 * migrated SQLite file (tests/helpers/temp-db.ts). Assertions are on the
 * CONSUMER'S OUTPUT — stored paise, stored dates, group removability, the
 * server action's verdict — never on "the value arrived".
 *
 * ── THE SEAM TABLE ─────────────────────────────────────────────────────────
 *
 * # | crossing value                         | producer (file:line)                    | consumer (file:line)                          | unit / shape                        | test name
 * --|----------------------------------------|-----------------------------------------|-----------------------------------------------|-------------------------------------|---------------------------------------------
 * 1 | NormalizedTrade.reportedCharges        | lib/import/api/dhan.ts:591 (F2)         | lib/import/commit.ts:137 buildRow (F1)        | RUPEES, per position, 6 components  | S1 · every paisa Dhan charged, once
 *   |   ↳ built by allocateFills             | lib/import/api/dhan.ts:413 (F2)         | lib/import/api/dhan.ts:574 pro-rata share     | rupees × (qty taken / fill qty)     |
 * 2 | NormalizedTrade.executions             | lib/import/api/dhan.ts:552 (F2)         | lib/import/commit.ts:249 stagedFromExecutions | Execution[], qty in SHARES          | S1 · trade_legs never outrun the parent
 *   |                                        |                                         | lib/import/commit.ts:1711 trade_legs writer   | trade_legs.qty (integer shares)     |
 * 3 | sell-only row: sellDate + basisUnknown | lib/import/api/dhan.ts:299,300 (F2)     | lib/import/commit.ts:1681 acquisition (F1)    | ISO IST date; boolean → "unknown"   | S2 · a sold-out holding closes the lot
 *   |                                        |                                         | lib/import/commit.ts:395 lotFromNewRow (F1)   | excluded from the FIFO book         | S2 · an empty account keeps it unknown
 * 4 | dedupHash of the SAME sale, two shapes | lib/import/api/dhan.ts:231 + :466 (F2)  | lib/import/commit.ts:461 knownHashes (F1)     | sha1 hex, account-free              | S2 · the next pull's history fill is skipped
 * 5 | import_notes alias segments            | lib/import/close-open-lots.ts:130 (F1)  | lib/import/broker-identity.ts:323 (F3)        | " | "-joined text, `dedup-alias:<sha1>` | S3 · the alias makes the group (planted)
 * 6 | lotIdentityHashes / isLotIdentityFrozen| lib/import/close-open-lots.ts:93,119(F1)| lib/analytics/data-quality.ts:111 (F3)        | string[] own-first; boolean         | S3 · only the plain copy is removable (planted)
 * 7 | DuplicateTradeGroup.accounts[].removable| lib/import/broker-identity.ts:339 (F3)  | app/data-quality/actions.ts:71 (F3) → F1 rows | boolean → a DELETE of trade ids     | S3 · the action refuses the merged lot
 * 8 | the lot a row of THIS file just wrote  | lib/import/commit.ts:1695 (F1)          | lib/import/close-open-lots.ts:265 planner     | OpenLot{qty, price, value, date}    | SWITCHED OFF (4.3.0) — S4 pins preview = commit
 * 9 | PreviewResult.autoClose                | lib/import/commit.ts:990 (F1)           | the commit's own applied closes (F1)          | {closes:int, positions:[{sym,qty}]} | SWITCHED OFF (4.3.0) — S4 pins no autoClose key
 *10 | frozen identity across a RESTORE       | lib/import/close-open-lots.ts:119 (F1)  | lib/db/data-fixes.ts:100 (F1) → :323 (F3)     | dedup_hash left byte-identical      | S5 · the re-key skips the frozen lot (planted)
 *
 * AUTO-CLOSE IS SWITCHED OFF FOR 4.3.0 (owner ruling 2026-09-11, 06-ANSWERS
 * "v4.3.0 release-level-audit rulings", row 1): lib/import/commit.ts is v4.2.0
 * again, so every commit.ts line above is wave 1's (d0eda00). Rows 3–4 now
 * cross into v4.2.0's buildRow and own-hash dedup: S2 pins the dated,
 * basis-unknown sale landing BESIDE the held lot. Rows 5, 6 and 10 run on rows
 * PLANTED in the state wave 1 left (as tests/data-quality.test.ts plants them):
 * no 4.3.0 import writes one, but DQ and the restore re-key still read them.
 * Rows 8 and 9 are switched off; S4 pins that preview and commit agree.
 *
 * DATES. Every date-carrying seam runs at 2026-09-09T19:00:00Z / 2026-09-10T19:00:00Z
 * — 00:30 IST, inside the 18:30–24:00 UTC window where the IST day and the UTC
 * day disagree. A pull stamped there must say the IST day or the whole catch-up
 * window is off by one.
 *
 * TWO SEAM DEFECTS found by this pass, both FIXED in the same wave and pinned at
 * the value they must hold, so a change either way reddens this file and is seen:
 *
 *  D1 (S1) — FIXED. A fill consumed by THREE positions used to round each charge
 *     component to paise three times, so ₹44.00 charged was stored as ₹44.01.
 *     `allocateFills` now splits every fill by REMAINDER (the last take gets
 *     target − sum of the earlier takes; lib/import/api/dhan.ts
 *     `splitChargesByRemainder`), and S1 test 4 pins the exact total.
 *  D2 (S5) — FIXED. `toGroup` read a group's display facts off `rows[0]`
 *     whatever that row's own identity was, so a group keyed on a 40-share SALE
 *     described the 60-share REMAINDER lot, and that text reached the user as a
 *     critical Data Quality issue. The group is now described by a row whose OWN
 *     hash is the group's (lib/import/broker-identity.ts), and S5 pins the
 *     sale's facts.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let dhan: typeof import("@/lib/import/api/dhan");
let importer: typeof import("@/lib/import/commit");
let lots: typeof import("@/lib/import/close-open-lots");
let identity: typeof import("@/lib/import/broker-identity");
let quality: typeof import("@/lib/analytics/data-quality");
let actions: typeof import("@/app/data-quality/actions");
let fixes: typeof import("@/lib/db/data-fixes");
let dedup: typeof import("@/lib/import/dedup");

// One account per seam — the temp database is shared for the whole file.
const CHARGES = 11; // the auditor's probe: ₹11 stated on every fill
const SPLIT = 12; //  a fill big enough for two positions
const LADDER = 13; // the staged-ladder half of the charges seam
const THIRDS = 14; // one fill split three ways — the rounding edge
const HOLDER = 21; // holds an open lot when the sell-only row lands
const EMPTY = 22; //  holds nothing when it lands
const BOOK_A = 31; // the auto-closing book
const BOOK_B = 32; // the plain second copy
const PULL = 41; //   one pull, history BUY + today's SELL
const PAYTM_A = 51;
const PAYTM_B = 52;

/** 00:30 IST on 2026-09-10 — the UTC day is still the 9th. */
const AT_IST_BOUNDARY = new Date("2026-09-09T19:00:00Z");
/** The same instant one day on, so a fill dated the 10th is HISTORY. */
const NEXT_IST_BOUNDARY = new Date("2026-09-10T19:00:00Z");

/** The six charge components Dhan states per fill, summing to ₹11.00. */
const FILL_CHARGES = {
  brokerageCharges: 5,
  serviceTax: 0.9,
  stt: 3,
  sebiTax: 0.1,
  exchangeTransactionCharges: 1.5,
  stampDuty: 0.5,
};

interface FillSpec {
  id: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  at: string;
  symbol?: string;
}

const dhanFill = (f: FillSpec) => ({
  dhanClientId: "1000000009",
  exchangeTradeId: f.id,
  transactionType: f.side,
  exchangeSegment: "NSE_EQ",
  productType: "CNC",
  tradingSymbol: f.symbol ?? "TCS",
  tradedQuantity: f.qty,
  tradedPrice: f.price,
  exchangeTime: f.at,
  ...FILL_CHARGES,
});

/** What the broker ACTUALLY charged across a set of fills, in rupees. */
const chargedTotal = (fills: FillSpec[]) =>
  Math.round(
    fills.length *
      (FILL_CHARGES.brokerageCharges +
        FILL_CHARGES.serviceTax +
        FILL_CHARGES.stt +
        FILL_CHARGES.sebiTax +
        FILL_CHARGES.exchangeTransactionCharges +
        FILL_CHARGES.stampDuty) *
      100,
  ) / 100;

/** A sell-only `/v2/positions` row: sold today out of a holding it cannot see. */
const sellOnlyPosition = (symbol: string, qty: number, price: number) => ({
  dhanClientId: "1000000009",
  tradingSymbol: symbol,
  positionType: "CLOSED",
  exchangeSegment: "NSE_EQ",
  productType: "CNC",
  buyAvg: 0,
  buyQty: 0,
  sellAvg: price,
  sellQty: qty,
  netQty: 0,
});

/** A structurally valid JWT whose own `exp` says it is alive. */
const fakeJwt = () =>
  [
    "e30",
    Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
    "sig",
  ].join(".");

/**
 * ONE REAL DHAN PULL. The network is stubbed; everything above it is the real
 * adapter — `fetchDhanTrades`' page walk, `normalizeDhanTrades`,
 * `normalizeDhanPositions`, `toParsedFile`.
 */
async function realDhanPull(
  range: { from: string; to: string } | null,
  fills: FillSpec[],
  positions: ReturnType<typeof sellOnlyPosition>[] = [],
): Promise<ParsedFile> {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    paths.push(u.pathname);
    const body =
      u.pathname === "/v2/positions"
        ? positions
        : /^\/v2\/trades\/[\d-]+\/[\d-]+\/0$/.test(u.pathname)
          ? fills.map(dhanFill)
          : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const creds = { clientId: "1000000009", accessToken: fakeJwt() };
  const trades = await dhan.dhanImportSource(creds).fetchTrades(range ?? {});
  const parsed = dhan.toParsedFile(trades, range);
  if (range) expect(paths).toContain(`/v2/trades/${range.from}/${range.to}/0`);
  expect(paths, "the pull must always read today's book").toContain("/v2/positions");
  return parsed;
}

const storedRows = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all();

const legsOf = (tradeId: number) =>
  t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, tradeId)).all();

const closeAuditSince = (afterId: number) =>
  t.sqlite
    .prepare("SELECT id, entity_id, action, summary FROM audit_log WHERE id > ? AND action = 'close' ORDER BY id")
    .all(afterId) as { id: number; entity_id: number; action: string; summary: string }[];

const maxAuditId = () =>
  (t.sqlite.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM audit_log").get() as { m: number }).m;

const r2 = (n: number) => Math.round(n * 100) / 100;

beforeAll(async () => {
  t = await openTempDb("seams-v43-fix1", { seed: true });
  dhan = await import("@/lib/import/api/dhan");
  importer = await import("@/lib/import/commit");
  lots = await import("@/lib/import/close-open-lots");
  identity = await import("@/lib/import/broker-identity");
  quality = await import("@/lib/analytics/data-quality");
  actions = await import("@/app/data-quality/actions");
  fixes = await import("@/lib/db/data-fixes");
  dedup = await import("@/lib/import/dedup");
  t.db
    .insert(t.schema.accounts)
    .values([
      { id: CHARGES, name: "Charges", isDefault: false },
      { id: SPLIT, name: "Split", isDefault: false },
      { id: LADDER, name: "Ladder", isDefault: false },
      { id: THIRDS, name: "Thirds", isDefault: false },
      { id: HOLDER, name: "Holder", isDefault: false },
      { id: EMPTY, name: "Empty", isDefault: false },
      { id: BOOK_A, name: "Book A", isDefault: false },
      { id: BOOK_B, name: "Book B", isDefault: false },
      { id: PULL, name: "Pull", isDefault: false },
      { id: PAYTM_A, name: "Paytm A", isDefault: false },
      { id: PAYTM_B, name: "Paytm B", isDefault: false },
    ])
    .run();
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  t?.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ===========================================================================
// SEAM 1 — F2's per-position charges and executions → F1's stored row
// ===========================================================================

/**
 * F2 decides WHICH fills a position consumed and what share of each fill's
 * charges it owes; F1 decides that a stated charge overrides the rate card and
 * writes it to `charges_total_paise`. Neither builder ever ran both.
 *
 * The money claim is CONSERVATION: the rupees stored across the positions one
 * file produced equal the rupees the broker actually levied on its fills —
 * every paisa exactly once. The predecessor gave each position every fill
 * inside its own date WINDOW, so two overlapping positions both claimed the
 * same fill (₹44 stored from ₹22 charged, round-1 audit 2026-09-10).
 */
describe("S1 · every paisa Dhan charged is stored once (F2 allocateFills → F1 buildRow)", () => {
  const AT = "2026-09-07 10:00:00";

  it("BUY 200 on d1, SELL 100 on d2: 16.50 + 5.50 = the ₹22 the two fills were charged", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NEXT_IST_BOUNDARY);
    const fills: FillSpec[] = [
      { id: "P1-B", side: "BUY", qty: 200, price: 100, at: AT },
      { id: "P1-S", side: "SELL", qty: 100, price: 120, at: "2026-09-08 10:00:00" },
    ];
    const parsed = await realDhanPull({ from: "2026-09-07", to: "2026-09-11" }, fills);
    expect(importer.commitParsedFile(parsed, "dhan-api", null, CHARGES).added).toBe(2);

    const rows = storedRows(CHARGES).sort((a, b) => b.sellQty - a.sellQty);
    expect(rows.map((r) => [r.buyQty, r.sellQty])).toEqual([
      [100, 100],
      [100, 0],
    ]);
    // The CLOSED position took half the buy fill and the whole sell fill;
    // the remaining open long took the other half of the buy fill.
    expect(rows.map((r) => r.chargesTotal)).toEqual([16.5, 5.5]);
    expect(
      r2(rows.reduce((s, r) => s + r.chargesTotal, 0)),
      "the file's stored charges must equal the charges Dhan levied on its fills",
    ).toBe(chargedTotal(fills));
  });

  it("BUY d1, BUY d2, SELL d3, SELL d4: two closed positions, ₹22 each, ₹44 charged", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NEXT_IST_BOUNDARY);
    const fills: FillSpec[] = [
      { id: "P2-B1", side: "BUY", qty: 100, price: 100, at: "2026-09-01 10:00:00" },
      { id: "P2-B2", side: "BUY", qty: 100, price: 105, at: "2026-09-02 10:00:00" },
      { id: "P2-S1", side: "SELL", qty: 100, price: 110, at: "2026-09-03 10:00:00" },
      { id: "P2-S2", side: "SELL", qty: 100, price: 120, at: "2026-09-04 10:00:00" },
    ];
    const parsed = await realDhanPull({ from: "2026-09-01", to: "2026-09-11" }, fills);
    expect(importer.commitParsedFile(parsed, "dhan-api", null, SPLIT).added).toBe(2);

    const rows = storedRows(SPLIT).sort((a, b) => (a.buyDate ?? "").localeCompare(b.buyDate ?? ""));
    expect(rows.map((r) => [r.buyDate, r.sellDate])).toEqual([
      ["2026-09-01", "2026-09-03"],
      ["2026-09-02", "2026-09-04"],
    ]);
    expect(rows.map((r) => r.chargesTotal)).toEqual([22, 22]);
    expect(
      r2(rows.reduce((s, r) => s + r.chargesTotal, 0)),
      "two positions whose date windows overlap must not both claim the middle fills",
    ).toBe(chargedTotal(fills));
    // FIFO, not a window: the 09-01 buy is paired with the 09-03 sell.
    expect(rows.map((r) => r.grossPnl)).toEqual([1000, 1500]);
  });

  it("a fill split across two positions: only the twice-filled side is staged, and its legs sum to its own quantity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NEXT_IST_BOUNDARY);
    const fills: FillSpec[] = [
      { id: "P3-B1", side: "BUY", qty: 120, price: 100, at: "2026-09-07 10:00:00" },
      { id: "P3-B2", side: "BUY", qty: 80, price: 100, at: "2026-09-07 11:00:00" },
      { id: "P3-S", side: "SELL", qty: 100, price: 120, at: "2026-09-08 10:00:00" },
    ];
    const parsed = await realDhanPull({ from: "2026-09-07", to: "2026-09-11" }, fills);
    expect(importer.commitParsedFile(parsed, "dhan-api", null, LADDER).added).toBe(2);

    const rows = storedRows(LADDER).sort((a, b) => b.sellQty - a.sellQty);
    const [closed, open] = rows;
    expect([closed.buyQty, closed.sellQty]).toEqual([100, 100]);
    expect([open.buyQty, open.sellQty]).toEqual([100, 0]);
    // The closed position was filled once per side — a round trip is not a
    // ladder, so it gets no legs at all.
    expect([closed.staged, open.staged]).toEqual([false, true]);
    expect(legsOf(closed.id)).toEqual([]);
    // The open long took 20 of the first buy fill and all 80 of the second.
    const legs = legsOf(open.id).sort((a, b) => a.seq - b.seq);
    expect(legs.map((l) => [l.kind, l.qty])).toEqual([
      ["entry", 20],
      ["entry", 80],
    ]);
    expect(
      legs.reduce((s, l) => s + l.qty, 0),
      "trade_legs may never state more shares than the row they hang off",
    ).toBe(open.buyQty);

    expect(rows.map((r) => r.chargesTotal)).toEqual([20.17, 12.83]);
    expect(r2(closed.chargesTotal + open.chargesTotal)).toBe(chargedTotal(fills));
  });

  /**
   * DEFECT D1 — FIXED (F2, 2026-09-10). The pin is now the RIGHT value.
   *
   * `allocateFills`' header claims "the TOTALS are exact, which is what
   * conservation means here". They were exact only for a two-way split, because
   * every component of ₹11 halves onto a paisa; a fill consumed by THREE
   * positions rounded each component per share, so ₹5.00 of brokerage became
   * 1.67 × 3 = ₹5.01 and ₹44.00 charged was stored as ₹44.01. The fix allocates
   * a fill's charges by REMAINDER — every take but the last gets its rounded
   * share, the last gets `stated − sum(earlier)`, per component — so this
   * asserts EXACT equality, not a ±₹0.01 tolerance.
   */
  it("one buy fill consumed by three positions stores exactly the ₹44 Dhan charged (D1, fixed)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NEXT_IST_BOUNDARY);
    const fills: FillSpec[] = [
      { id: "P4-B", side: "BUY", qty: 300, price: 100, at: "2026-09-07 10:00:00" },
      { id: "P4-S1", side: "SELL", qty: 100, price: 120, at: "2026-09-08 10:00:00" },
      { id: "P4-S2", side: "SELL", qty: 100, price: 121, at: "2026-09-09 10:00:00" },
      { id: "P4-S3", side: "SELL", qty: 100, price: 122, at: "2026-09-10 10:00:00" },
    ];
    const parsed = await realDhanPull({ from: "2026-09-07", to: "2026-09-11" }, fills);
    expect(importer.commitParsedFile(parsed, "dhan-api", null, THIRDS).added).toBe(3);

    const rows = storedRows(THIRDS);
    // Two takes of the buy fill get the rounded share, the LAST the remainder.
    expect(rows.map((r) => r.chargesTotal).sort((a, b) => b - a)).toEqual([14.67, 14.67, 14.66]);
    expect(chargedTotal(fills)).toBe(44);
    expect(
      r2(rows.reduce((s, r) => s + r.chargesTotal, 0)),
      "a fill split three ways must still store every paisa Dhan charged, exactly once",
    ).toBe(chargedTotal(fills));
  });
});

// ===========================================================================
// SEAM 2 — F2's sell-only /positions row → F1's book
// ===========================================================================

/**
 * `/v2/positions` states a sale out of a holding it cannot see: sellQty > 0,
 * buyQty === 0. F2 now dates it TODAY and flags `basisUnknown` (M-3); F1 turns
 * that flag into `acquisition: "unknown"`. With auto-close switched off for
 * 4.3.0 (ruling 2026-09-11) it closes nothing: beside a held long it lands as
 * its own row, as v4.2.0 wrote a SELL of a held lot, and a later BUY does not
 * cover it.
 */
describe("S2 · a sold-out holding crosses as a dated, basis-unknown sale (F2 → F1)", () => {
  const BUY_FILL: FillSpec = { id: "H-BUY", side: "BUY", qty: 100, price: 100, at: "2026-09-07 09:30:00", symbol: "INFY" };
  let sellPull: ParsedFile;

  it("the lot is untouched and the sale lands as a dated, basis-unknown row of its own (auto-close off)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT_IST_BOUNDARY);
    expect(todayIstIso(), "19:00Z is already the next day in India").toBe("2026-09-10");

    // Pull 1 — the catch-up history opens the position.
    const buyPull = await realDhanPull({ from: "2026-09-07", to: "2026-09-10" }, [BUY_FILL]);
    expect(importer.commitParsedFile(buyPull, "dhan-api", null, HOLDER).added).toBe(1);
    const lot = storedRows(HOLDER)[0];
    expect([lot.buyQty, lot.sellQty, lot.isOpen]).toEqual([100, 0, true]);

    // Pull 2 — today's book states the sale and no purchase.
    sellPull = await realDhanPull(null, [], [sellOnlyPosition("INFY", 100, 120)]);
    expect(sellPull.trades.map((x) => [x.buyQty, x.sellQty, x.buyDate, x.sellDate, x.basisUnknown ?? false])).toEqual([
      [0, 100, null, "2026-09-10", true],
    ]);

    // 06-ANSWERS 2026-09-11, row 1: no close plan; F1 prices the sale as its own row.
    const preview = importer.previewParsedFile(sellPull, null, HOLDER);
    expect("autoClose" in preview, "the preview plans no close").toBe(false);
    expect(preview.summary.newCount).toBe(1);
    const sellCharges = preview.rows[0].chargesTotal;

    const before = maxAuditId();
    const res = importer.commitParsedFile(sellPull, "dhan-api", null, HOLDER);
    expect([res.added, res.skipped], "the sale is a new row, as v4.2.0 wrote it").toEqual([1, 0]);

    const rows = storedRows(HOLDER).sort((a, b) => a.id - b.id);
    expect(rows).toHaveLength(2);
    expect(rows[0], "the held lot is untouched by the sale").toEqual(lot);
    const sale = rows[1];
    expect([sale.buyQty, sale.sellQty, sale.isOpen]).toEqual([0, 100, true]);
    expect([sale.buyDate, sale.sellDate], "M-3: the exit is dated today in IST, not left null").toEqual([
      null,
      "2026-09-10",
    ]);
    expect(sale.acquisition, "M-3: a sale with no purchase in the pull is unknown-basis").toBe("unknown");
    expect(sale.chargesTotal, "the preview's price for the sale is what the commit stored").toBe(sellCharges);
    expect(closeAuditSince(before), "nothing was closed").toEqual([]);
  });

  it("into an EMPTY account it is stored basis-unknown, and a later BUY does not cover it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT_IST_BOUNDARY);
    expect(importer.commitParsedFile(sellPull, "dhan-api", null, EMPTY).added).toBe(1);
    const sold = storedRows(EMPTY)[0];
    expect([sold.buyQty, sold.sellQty, sold.sellDate]).toEqual([0, 100, "2026-09-10"]);
    expect(sold.acquisition, "a sale with no purchase anywhere is unknown-basis, not a short").toBe("unknown");
    expect(sold.grossPnl, "an unknown basis may never be reported as all-profit").toBe(0);
    const soldNet = sold.netPnl;

    // The next day's catch-up brings a BUY. A short lot would be COVERED by it;
    // an unknown-basis sale must not be.
    vi.setSystemTime(NEXT_IST_BOUNDARY);
    const before = maxAuditId();
    const buyPull = await realDhanPull({ from: "2026-09-10", to: "2026-09-11" }, [
      { id: "E-BUY", side: "BUY", qty: 100, price: 90, at: "2026-09-10 14:00:00", symbol: "INFY" },
    ]);
    expect(importer.commitParsedFile(buyPull, "dhan-api", null, EMPTY).added).toBe(1);

    const rows = storedRows(EMPTY).sort((a, b) => a.id - b.id);
    expect(rows, "the BUY must land as its own open position").toHaveLength(2);
    expect(rows.map((r) => [r.buyQty, r.sellQty, r.isOpen])).toEqual([
      [0, 100, true],
      [100, 0, true],
    ]);
    expect(rows[0].acquisition).toBe("unknown");
    expect(rows[0].netPnl, "the unknown-basis sale is untouched by the purchase").toBe(soldNet);
    expect(closeAuditSince(before), "nothing was covered").toEqual([]);
  });

  it("the SAME sale re-stated as a dated history fill on the next pull is skipped, not added", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NEXT_IST_BOUNDARY);
    expect(todayIstIso()).toBe("2026-09-11");
    const before = storedRows(EMPTY);

    // Tomorrow's window is inclusive of the stamp day, so Dhan re-states
    // yesterday's sale — this time as a dated fill, in the OTHER shape.
    const again = await realDhanPull({ from: "2026-09-10", to: "2026-09-11" }, [
      { id: "E-SELL", side: "SELL", qty: 100, price: 120, at: "2026-09-10 15:00:00", symbol: "INFY" },
    ]);
    // The two shapes must hash to ONE identity, or the sale lands twice.
    expect(dedup.dedupHash(again.trades[0])).toBe(before[0].dedupHash);

    const res = importer.commitParsedFile(again, "dhan-api", null, EMPTY);
    expect([res.added, res.skipped]).toEqual([0, 1]);
    expect(storedRows(EMPTY).map((r) => [r.id, r.buyQty, r.sellQty, r.netPnl])).toEqual(
      before.map((r) => [r.id, r.buyQty, r.sellQty, r.netPnl]),
    );
  });
});

// ===========================================================================
// SEAM 3 — F1's frozen, additive identity → F3's Data Quality and its action
// ===========================================================================

/**
 * The same Dhan sale pulled into two accounts. In A it auto-closed a long, so
 * A's row keeps the BUY file's hash and carries the sale's hash as an alias; in
 * B it is a plain row whose own hash IS the sale's. F3 groups on every hash a
 * row stands for, offers the delete only on a PLAIN copy, and the action
 * re-derives that verdict from the database rather than trusting the button.
 * Auto-close is switched off for 4.3.0 (ruling 2026-09-11), so A's merged lot
 * is PLANTED in the state wave 1 left; F3's half is unchanged and still runs.
 */
describe("S3 · one sale, two accounts, one merged lot (F1 identity → F3 DQ + action)", () => {
  let hBuy = "";
  let hSell = "";
  let aRowId = 0;
  let bRowId = 0;

  it("the alias puts A's merged lot in the group, and only B's copy is removable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NEXT_IST_BOUNDARY);
    const buyPull = await realDhanPull({ from: "2026-09-07", to: "2026-09-11" }, [
      { id: "W-BUY", side: "BUY", qty: 100, price: 100, at: "2026-09-07 10:00:00", symbol: "WIPRO" },
    ]);
    hBuy = dedup.dedupHash(buyPull.trades[0]);
    expect(importer.commitParsedFile(buyPull, "dhan-api", null, BOOK_A).added).toBe(1);

    const sellPull = await realDhanPull({ from: "2026-09-08", to: "2026-09-11" }, [
      { id: "W-SELL", side: "SELL", qty: 100, price: 120, at: "2026-09-08 10:00:00", symbol: "WIPRO" },
    ]);
    hSell = dedup.dedupHash(sellPull.trades[0]);
    expect(hSell).not.toBe(hBuy);
    // PLANTED (06-ANSWERS 2026-09-11, row 1 — no 4.3.0 commit writes a merged
    // lot): A's row in the state wave 1's auto-close left after this sale —
    // closed, realised, the sale's hash an alias — as tests/data-quality.test.ts
    // plants one. B gets the same pull through the real commit.
    const aLot = storedRows(BOOK_A)[0];
    t.db
      .update(t.schema.trades)
      .set({
        sellQty: 100,
        avgSellPrice: 120,
        sellValue: 12000,
        sellDate: "2026-09-08",
        isOpen: false,
        grossPnl: 2000,
        importNotes: lots.withLotCloseNote(aLot.importNotes, hSell),
      })
      .where(eq(t.schema.trades.id, aLot.id))
      .run();
    expect(importer.commitParsedFile(sellPull, "dhan-api", null, BOOK_B).added).toBe(1);

    const a = storedRows(BOOK_A);
    const b = storedRows(BOOK_B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    aRowId = a[0].id;
    bRowId = b[0].id;
    // A's row keeps the hash it was BORN with and carries the sale as an alias.
    expect(a[0].dedupHash, "a merged lot's own hash is the buy's").toBe(hBuy);
    expect(lots.lotIdentityHashes(a[0])).toEqual([hBuy, hSell]);
    expect(lots.isLotIdentityFrozen(a[0])).toBe(true);
    expect(lots.lotIdentityHashes(b[0])).toEqual([hSell]);
    expect(lots.isLotIdentityFrozen(b[0])).toBe(false);

    const found = identity.listDuplicateTradeGroups().filter((g) => g.dedupHash === hSell);
    expect(found.length, "grouping on own hashes alone reports no duplicate at all").toBe(1);
    const group = found[0];
    expect(group.accounts).toEqual([
      { id: BOOK_A, name: "Book A", rows: 1, removable: false },
      { id: BOOK_B, name: "Book B", rows: 1, removable: true },
    ]);
    expect(group.ids).toEqual([aRowId, bRowId].sort((x, y) => x - y));
    // The BUY's own hash is held by one account only — not a duplicate.
    expect(identity.listDuplicateTradeGroups().filter((g) => g.dedupHash === hBuy)).toEqual([]);

    // F3's report surface: one CRITICAL issue naming both books.
    const issues = quality.crossAccountIssues({ duplicateTradeGroups: [group] });
    expect(issues.map((i) => [i.severity, i.count])).toEqual([["critical", 2]]);
    expect(issues[0].detail).toContain("Book A and Book B");
    expect(issues[0].ids).toEqual(group.ids);

    // The ids a fix would delete, per account.
    expect(
      identity.duplicateTradeIdsIn("dhan", hSell, BOOK_A),
      "deleting A's row would take the buy it was merged with",
    ).toEqual([]);
    expect(identity.duplicateTradeIdsIn("dhan", hSell, BOOK_B)).toEqual([bRowId]);
  });

  it("the action refuses A's merged lot, removes B's copy only, and A keeps both identities", async () => {
    t.db.update(t.schema.settings).set({ selectedAccountId: 0 }).run();

    const refused = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: hSell, accountId: BOOK_A });
    expect([refused.ok, refused.removed]).toEqual([false, 0]);
    expect(refused.message).toBe(
      "The copy in Book A is a merged lot — it also records an execution that closed a position in that book. Nothing was removed.",
    );
    expect(storedRows(BOOK_A).map((r) => r.id)).toEqual([aRowId]);

    const removed = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: hSell, accountId: BOOK_B });
    expect([removed.ok, removed.removed]).toEqual([true, 1]);
    expect(storedRows(BOOK_B)).toEqual([]);

    // A's lot survives whole: born-with hash, alias, realised P&L.
    const survivor = storedRows(BOOK_A)[0];
    expect(survivor.dedupHash).toBe(hBuy);
    expect(lots.lotIdentityHashes(survivor)).toEqual([hBuy, hSell]);
    expect([survivor.buyQty, survivor.sellQty, survivor.isOpen]).toEqual([100, 100, false]);
    expect(survivor.grossPnl).toBe(2000);
    // One copy left is no longer a duplicate.
    expect(identity.findDuplicateTradeGroup("dhan", hSell)).toBeNull();
  });
});

// ===========================================================================
// SEAM 4 — one pull whose own earlier row is the lot its later row closes
// ===========================================================================

/**
 * A catch-up pull carries the history BUY and today's `/positions` SELL in ONE
 * ParsedFile. Wave 1 folded the row it had just written back in and closed it
 * (seam rows 8-9). Auto-close is SWITCHED OFF for 4.3.0 (owner ruling
 * 2026-09-11, 06-ANSWERS "v4.3.0 release-level-audit rulings", row 1), so the
 * two halves land as v4.2.0 writes them — an open long plus a dated,
 * basis-unknown opening sell (the shape M-2 was built to prevent; accepted by
 * the ruling, rebuilt in 4.3.1). What must still hold is that preview and
 * commit agree.
 */
describe("S4 · one pull, a Monday BUY and today's SELL: preview and commit agree (F2 ↔ F1, preview ↔ commit)", () => {
  it("the preview plans no close, and the commit writes exactly the rows the preview counted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT_IST_BOUNDARY);
    const range = dhan.catchUpRange("2026-09-06T19:00:00Z");
    expect(range, "a stamp from the 7th IST catches up to today").toEqual({ from: "2026-09-07", to: "2026-09-10" });

    const parsed = await realDhanPull(
      range,
      [{ id: "P-BUY", side: "BUY", qty: 100, price: 100, at: "2026-09-07 09:30:00", symbol: "HDFCBANK" }],
      [sellOnlyPosition("HDFCBANK", 100, 120)],
    );
    expect(parsed.trades.map((x) => [x.buyQty, x.sellQty, x.buyDate, x.sellDate])).toEqual([
      [100, 0, "2026-09-07", null],
      [0, 100, null, "2026-09-10"],
    ]);

    const preview = importer.previewParsedFile(parsed, null, PULL);
    expect("autoClose" in preview, "seam row 9 is switched off: no plan crosses").toBe(false);
    expect(preview.summary.dupCount).toBe(0);
    expect(preview.summary.newCount).toBe(2);
    expect([preview.shape.open, preview.shape.openingSells]).toEqual([1, 1]);

    const before = maxAuditId();
    const res = importer.commitParsedFile(parsed, "dhan-api", null, PULL);
    expect(res.added, "the preview's new rows are the commit's added rows").toBe(preview.summary.newCount);
    expect([res.added, res.skipped, res.total]).toEqual([2, 0, 2]);
    expect((res.warnings ?? []).some((w) => /closed by this/.test(w)), "no sentence claims a close").toBe(false);

    const rows = storedRows(PULL).sort((a, b) => a.id - b.id);
    expect(rows.map((r) => [r.buyQty, r.sellQty, r.isOpen, r.buyDate, r.sellDate, r.acquisition])).toEqual([
      [100, 0, true, "2026-09-07", null, null],
      [0, 100, true, null, "2026-09-10", "unknown"],
    ]);
    // What the preview priced per row is what the commit stored.
    expect(rows.map((r) => r.chargesTotal)).toEqual(preview.rows.map((r) => r.chargesTotal));
    expect(closeAuditSince(before), "nothing was closed").toEqual([]);
  });
});

// ===========================================================================
// SEAM 5 — a frozen identity across the restore re-key, and the DQ group
// ===========================================================================

/**
 * `rerunDataFixesAfterRestore` re-derives every Paytm row's hash FROM ITS OWN
 * LEGS. A lot an auto-close reduced no longer describes the file that created
 * it (100 bought, 60 left), so re-keying it would disconnect that file and let
 * it import again as a phantom open lot. F1's freeze flag stops that; F3's
 * grouping must still resolve the record afterwards.
 */
describe("S5 · the restore re-key skips a frozen lot (F1 close-open-lots → F1 data-fixes → F3)", () => {
  const paytmTrade = (over: Partial<NormalizedTrade>): NormalizedTrade =>
    ({
      broker: "paytm",
      tradingsymbol: "SBIN",
      isin: "INE062A01020",
      buyQty: 0,
      avgBuyPrice: 0,
      buyValue: 0,
      sellQty: 0,
      avgSellPrice: 0,
      sellValue: 0,
      closingPrice: null,
      grossPnl: 0,
      unrealisedPnl: 0,
      buyDate: null,
      sellDate: null,
      productHint: "delivery",
      exchangeHint: "NSE",
      sourceFile: "paytm.csv",
      entryTime: null,
      exitTime: null,
      importNotes: null,
      ...over,
    }) as NormalizedTrade;

  const paytmFile = (trades: NormalizedTrade[]): ParsedFile => ({
    sourceId: "paytm-tradebook",
    broker: "paytm",
    format: "csv",
    trades,
    warnings: [],
  });

  it("the lot keeps its born-with hash through the re-key, the buy file still de-duplicates, and the group resolves", () => {
    const buy = paytmTrade({ buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-09-01" });
    const sell = paytmTrade({ sellQty: 40, avgSellPrice: 120, sellValue: 4800, sellDate: "2026-09-05" });
    const hBuy = dedup.dedupHash(buy);
    const hSell = dedup.dedupHash(sell);

    expect(importer.commitParsedFile(paytmFile([buy]), "paytm-buy.csv", null, PAYTM_A).added).toBe(1);
    // PLANTED (06-ANSWERS 2026-09-11, row 1 — no 4.3.0 commit writes a frozen
    // lot): A's lot in the state wave 1 left after SELL 40 — reduced to 60
    // under its born-with hash, the sale's hash an alias. B gets the real commit.
    const lotRow = storedRows(PAYTM_A)[0];
    t.db
      .update(t.schema.trades)
      .set({ buyQty: 60, buyValue: 6000, importNotes: lots.withLotCloseNote(lotRow.importNotes, hSell) })
      .where(eq(t.schema.trades.id, lotRow.id))
      .run();
    expect(importer.commitParsedFile(paytmFile([sell]), "paytm-sell.csv", null, PAYTM_B).added).toBe(1);

    const reduced = storedRows(PAYTM_A)
      .sort((a, b) => a.id - b.id)
      .find((r) => r.isOpen)!;
    expect([reduced.buyQty, reduced.sellQty], "40 of the 100 went; 60 is left open").toEqual([60, 0]);
    expect(reduced.dedupHash).toBe(hBuy);
    expect(lots.lotIdentityHashes(reduced)).toEqual([hBuy, hSell]);
    // The row's own legs no longer produce its hash — that is what "frozen" means.
    expect(
      dedup.dedupHash({ ...buy, buyQty: 60, buyValue: 6000 }),
      "re-deriving from the CURRENT legs gives a different hash — the trap S-2 closes",
    ).not.toBe(hBuy);

    // ── the restore, for real ───────────────────────────────────────────────
    const results = fixes.rerunDataFixesAfterRestore(t.sqlite);
    expect(results.map((r) => [r.name, r.applied])).toEqual([["paytm-dedup-isin-v1", true]]);
    expect(results[0].rekeyed, "no frozen row may be re-keyed").toBe(0);

    const after = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, reduced.id)).get()!;
    expect(after.dedupHash, "the re-key must leave a frozen lot byte-identical").toBe(hBuy);
    expect(lots.lotIdentityHashes(after)).toEqual([hBuy, hSell]);

    // The consequence the freeze exists for: the BUY file still de-duplicates.
    const reimport = importer.commitParsedFile(paytmFile([buy]), "paytm-buy.csv", null, PAYTM_A);
    expect([reimport.added, reimport.skipped], "a re-imported buy file must not add a phantom 100 lot").toEqual([0, 1]);
    // One row in A: only the lot is planted (wave 1 also wrote a closed 40 slice).
    expect(storedRows(PAYTM_A)).toHaveLength(1);

    // F3 still resolves the record across the two books after the restore.
    const group = identity.findDuplicateTradeGroup("paytm", hSell);
    expect(group, "the alias must still resolve the record across the two books").not.toBeNull();
    expect(group!.accounts).toEqual([
      { id: PAYTM_A, name: "Paytm A", rows: 1, removable: false },
      { id: PAYTM_B, name: "Paytm B", rows: 1, removable: true },
    ]);
    expect(identity.duplicateTradeIdsIn("paytm", hSell, PAYTM_A)).toEqual([]);
    expect(identity.duplicateTradeIdsIn("paytm", hSell, PAYTM_B)).toEqual([storedRows(PAYTM_B)[0].id]);

    // D2, FIXED. The group is ABOUT the 40-share sale of 2026-09-05, and it is
    // described by the row whose OWN hash is the group's — the plain copy in
    // book B — not by whichever row is first, which here is the (planted)
    // 60-share remainder lot.
    expect({ qty: group!.qty, sellDate: group!.sellDate }).toEqual({ qty: 40, sellDate: "2026-09-05" });
  });
});
