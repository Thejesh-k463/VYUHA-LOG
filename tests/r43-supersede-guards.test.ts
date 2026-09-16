import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { normalizeAngelTrades, toParsedFile, type AngelTradeRow } from "@/lib/import/api/angelone";
import { normalizeDhanPositions, toParsedFile as dhanParsedFile, type DhanPositionRow } from "@/lib/import/api/dhan";
// PURE (no DB, no React): the refusal sentence every typed-date writer states.
import { unreadableDateMessage } from "@/lib/domain/trading-day";

/**
 * v4.3.0 fix wave 2R (W2R-IDENTITY) — the three limits of R43's same-day
 * supersede, through the REAL preview, commit, auto-pull classifier and the
 * REAL writers a user reaches (setAcquisitionAction, the journal route).
 *
 * N1: a stored row the USER recorded something on (a cost basis through
 *     setAcquisition, or anything the journal writes) is never replaced in
 *     place: the incoming row is asked about. Measured before: the evening pull
 *     rewrote buy_qty 50 → 0 and gross 5000 → 0 while keeping acquisition 'ipo'
 *     and its price, so the row still counted as priced.
 * N2: an 'ask' is honoured on its own. Measured before: a laddered row grown
 *     20 → 25 had no quantity or value relation, cross-source found no kind,
 *     the pull committed and the book held 45 against the broker's 25.
 * N3: the same-snapshot comparison uses the supersede key. Measured before: a
 *     new INTRADAY round trip met the morning DELIVERY buy of the same symbol
 *     as a partial overlap and the whole pull was refused.
 *     REVERSED by W2G M1 (DECISIONS 2026-09-15): that narrowing also silenced a
 *     BROKER-side product conversion (intraday 10 → CNC 20 between two same-day
 *     /positions pulls landed as a second position, 30 against the broker's
 *     20). A row with nothing on its key but a same-symbol row in today's
 *     snapshot is asked about again; N3's false ask is the accepted cost.
 *
 * ONE temp database for this file (AGENTS.md); nothing imported statically
 * reaches `@/lib/db`. Each scenario owns its account id. The snapshot day comes
 * from the file name, so no clock is frozen.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const TODAY = "2026-08-12";
const FILE = `angelone-api-${TODAY}`;
const snap = { supersedeSnapshot: { fileName: FILE } };

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let actions: typeof import("@/app/trades/actions");
let journal: typeof import("@/app/api/trades/journal/route");
let job: typeof import("@/lib/jobs/auto-pull");

const ACC_BASIS = 931;
const ACC_JOURNAL = 932;
const ACC_GROWN = 933;
const ACC_TWOPROD = 934;
const ACC_TWOCAND = 935;
const ACC_UNKNOWN = 936;
const ACC_RETAG = 937;
const ACC_RETAG_SAMEKEY = 938;
const ACC_RETAG_CONTROL = 939;
const ACC_COLUMN = 940; // + index, one per annotated column below
const ACC_CONV = 962;
const ACC_CONV_NOREL = 963;
const ACC_STUCK = 964;
const ACC_ACQDATE = 965; // D3 (wave 2M): the typed acquisition day

/** W2H: the sentence an ask made ONLY by W2G M1 carries (lib/import/cross-source.ts). */
const M1_REASON = "another product, segment or exchange";
/** The reasons an ask ON the supersede key carries (unchanged since W2F). */
const KEY_REASONS = "the recorded row carries detail a replacement would lose";

/**
 * W2J: the M1 ask's sentence, asserted part by PART rather than byte by byte.
 * W2I rewrote it deliberately (the remedy counts the STORED rows the plan
 * named, and the ask now carries the on-key user-record warning and the way
 * back), and the byte pin that used to live below went red for that. The
 * word-for-word pin belongs with the pure builder — tests/cross-source.test.ts
 * pins every byte of each shape; what THIS file owns is that every part of the
 * sentence reaches the pre-flight message through the REAL preview. Each part
 * is its own promise to the user: which rows are asked about and why (M1's
 * reason, never the on-key ones), the path back to the broker's book, what
 * committing anyway does, and — an M1 ask never reaches planSnapshot's
 * `carriesUserRecord` check — that the stored row may carry the user's own
 * record, plus the way back from Deleted items.
 */
function expectM1Sentence(message: string, symbol: string): void {
  // which rows are asked about, and M1's own reason rather than the on-key ones
  expect(message).toContain(`1 row in this pull (${symbol}) restates an instrument today's earlier pull already recorded under ${M1_REASON}`);
  expect(message).not.toContain(KEY_REASONS);
  // the stored row (one here, so singular throughout) is not written over
  expect(message).toContain("is not written over that row");
  // the path to the broker's book: that row deleted, the pull run again
  expect(message).toMatch(/the earlier row can be deleted from Trades and the pull run again/);
  expect(message).toContain("records the position as the broker now states it");
  // what a forced commit does
  expect(message).toMatch(/committing anyway adds this pull's row beside the earlier one/);
  // W2I: the user-record warning an M1 ask carries, and the way back
  expect(message).toMatch(/That row may carry a cost basis or journal entry you recorded/);
  expect(message).toContain("Backup & Restore → Deleted items");
}

/** Near misses `expectM1Sentence` must refuse — a guard that cannot fail proves nothing. */
const M1_MUTANTS: [string, string][] = [
  [
    "the superseded W2H sentence: no user-record warning, no way back, and 'keeps both rows'",
    `1 row in this pull (STUCK) restates an instrument today's earlier pull already recorded under ${M1_REASON}, and is not written over that row. ` +
      "If the broker converted the position between the two pulls, the earlier row can be deleted from Trades and the pull run again, " +
      "which records the position as the broker now states it; committing anyway keeps both rows.",
  ],
  [
    "the on-key ask's reason in place of M1's",
    "1 row in this pull (STUCK) restates a position today's earlier pull already recorded, and is not written over it: " +
      `${KEY_REASONS} (a ladder of fills, a Data Quality join, a segment or exchange you set, or a cost basis or journal entry you recorded), or more than one position shares its instrument. ` +
      "Nothing is merged or overwritten automatically; committing anyway adds this pull's row beside the earlier one.",
  ],
  [
    "a remedy counting rows that are not stored: two earlier rows named where one is stored",
    `1 row in this pull (STUCK) restates an instrument today's earlier pull already recorded under ${M1_REASON}, and is not written over those rows. ` +
      "If the broker converted the position between the two pulls, the 2 earlier rows can be deleted from Trades and the pull run again, " +
      "which records the position as the broker now states it; committing anyway adds this pull's row beside the earlier ones. " +
      "Those rows may carry a cost basis or journal entry you recorded; a deleted row can be put back from Backup & Restore → Deleted items.",
  ],
];

const COLUMNS: [string, string, unknown][] = [
  ["acquisition 'bonus'", "acquisition", "bonus"],
  ["an acquisition price", "acquisition_price", 100],
  ["an acquisition date", "acquisition_date", "2025-01-15"],
  ["journal notes", "notes", "thesis: breakout"],
  ["a playbook", "playbook_id", 1],
  ["an emotion tag", "emotion_tag", "calm"],
  ["mistake tags", "mistake_tags", JSON.stringify(["fomo"])],
  ["an exit trigger", "exit_trigger", "target"],
  ["rule violations", "rule_violations", JSON.stringify(["playbook:rule"])],
  ["a review stamp", "reviewed_at", "2026-08-12 15:00:00"],
];

beforeAll(async () => {
  t = await openTempDb("r43-supersede-guards", { seed: true });
  commit = await import("@/lib/import/commit");
  actions = await import("@/app/trades/actions");
  journal = await import("@/app/api/trades/journal/route");
  job = await import("@/lib/jobs/auto-pull");
  t.db
    .insert(t.schema.accounts)
    .values(
      [ACC_BASIS, ACC_JOURNAL, ACC_GROWN, ACC_TWOPROD, ACC_TWOCAND, ACC_UNKNOWN, ACC_RETAG, ACC_RETAG_SAMEKEY, ACC_RETAG_CONTROL, ACC_CONV, ACC_CONV_NOREL, ACC_STUCK, ACC_ACQDATE, ...COLUMNS.map((_, i) => ACC_COLUMN + i)].map((id) => ({
        id,
        name: `r43 guard ${id}`,
        isDefault: false,
      })),
    )
    .run();
});
afterAll(() => t?.cleanup());

const fill = (over: Partial<AngelTradeRow> = {}): AngelTradeRow => ({
  tradingsymbol: "ACME-EQ",
  exchange: "NSE",
  producttype: "DELIVERY",
  transactiontype: "BUY",
  fillsize: "10",
  fillprice: "150",
  filltime: "10:00:00",
  ...over,
});
const parsedOf = (fills: AngelTradeRow[]) => toParsedFile(normalizeAngelTrades(fills, TODAY).trades);

interface Row {
  id: number;
  tradingsymbol: string;
  segment: string;
  buy_qty: number;
  sell_qty: number;
  buy_value_paise: number;
  sell_value_paise: number;
  gross_pnl_paise: number;
  acquisition: string | null;
  acquisition_price: number | null;
  buy_date: string | null;
}
const rowsOf = (accountId: number) =>
  t.sqlite
    .prepare(
      "SELECT id, tradingsymbol, segment, buy_qty, sell_qty, buy_value_paise, sell_value_paise, gross_pnl_paise, acquisition, acquisition_price, buy_date FROM trades WHERE account_id = ? ORDER BY id",
    )
    .all(accountId) as Row[];

// ===========================================================================
// N1 — a row the user recorded something on is never a supersede candidate
// ===========================================================================

describe("N1 · a stored row with a user-recorded basis or journal entry is asked about, never rewritten", () => {
  it("setAcquisitionAction (ipo @ 100) on today's sale, then a pull whose sale grew: no supersede, the pull asks, and a forced commit leaves the recorded basis whole", async () => {
    const sell50 = fill({ tradingsymbol: "BASIS-EQ", transactiontype: "SELL", fillsize: "50", fillprice: "200", filltime: "10:15:33" });
    expect(commit.commitParsedFile(parsedOf([sell50]), FILE, null, ACC_BASIS, snap).added).toBe(1);
    const [sale] = rowsOf(ACC_BASIS);
    expect(sale).toMatchObject({ buy_qty: 0, sell_qty: 50, acquisition: "unknown" });

    const form = new FormData();
    form.set("tradeId", String(sale!.id));
    form.set("acquisition", "ipo");
    form.set("acquisitionPrice", "100");
    form.set("acquisitionDate", "2025-01-15");
    expect((await actions.setAcquisitionAction({ ok: false, message: "" }, form)).ok).toBe(true);
    const recorded = rowsOf(ACC_BASIS);
    expect(recorded).toEqual([
      { ...sale, buy_qty: 50, buy_value_paise: 500_000, gross_pnl_paise: 500_000, acquisition: "ipo", acquisition_price: 100, buy_date: "2025-01-15" },
    ]);

    const pull2 = parsedOf([sell50, fill({ tradingsymbol: "BASIS-EQ", transactiontype: "SELL", fillsize: "30", fillprice: "210", filltime: "14:00:00" })]);
    const pre = commit.previewParsedFile(pull2, null, ACC_BASIS, FILE, snap);
    // THE assertion (supersededCount 1 on revert of the user-record guard).
    expect([pre.summary.newCount, pre.summary.dupCount, pre.summary.supersededCount]).toEqual([1, 0, 0]);
    // …and the ask is honoured although 80 vs 50 has no quantity or value relation (N2).
    expect(pre.crossSource?.risky).toBe(true);
    expect(pre.crossSource?.collisions).toMatchObject([{ symbol: "BASIS", existing: { id: sale!.id }, sameSnapshot: true }]);
    expect(job.classifyPreview(pre)).toBe("collision");
    // W2H control: an ask ON the key keeps the key's reasons, and is not given
    // the conversion sentence (red under a mutant that flags every ask as M1's).
    expect(pre.crossSource?.message).toContain(`1 row in this pull (BASIS) restates a position today's earlier pull already recorded, and is not written over it: ${KEY_REASONS}`);
    expect(pre.crossSource?.message).not.toContain(M1_REASON);

    // A commit forced past the question adds the evening row beside the recorded one; it never rewrites it.
    const res = commit.commitParsedFile(pull2, FILE, null, ACC_BASIS, snap);
    expect((res.warnings ?? []).some((w) => w.includes("updated from today's earlier pull"))).toBe(false);
    const after = rowsOf(ACC_BASIS);
    expect(after[0]).toEqual(recorded[0]);
    expect(after.slice(1)).toMatchObject([{ buy_qty: 0, sell_qty: 80, acquisition: "unknown" }]);
  });

  it("a note saved through the journal route on the morning's open buy: the evening round trip asks instead of replacing it", async () => {
    const buy = fill({ tradingsymbol: "NOTED-EQ" });
    expect(commit.commitParsedFile(parsedOf([buy]), FILE, null, ACC_JOURNAL, snap).added).toBe(1);
    const [row] = rowsOf(ACC_JOURNAL);
    const res = await journal.POST(
      new Request("http://localhost/api/trades/journal", {
        method: "POST",
        body: JSON.stringify({ id: row!.id, notes: "bought the breakout" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);

    const pull2 = parsedOf([buy, fill({ tradingsymbol: "NOTED-EQ", transactiontype: "SELL", fillprice: "160", filltime: "14:00:00" })]);
    const pre = commit.previewParsedFile(pull2, null, ACC_JOURNAL, FILE, snap);
    // THE assertion (supersededCount 1 on revert of the user-record guard).
    expect(pre.summary.supersededCount).toBe(0);
    expect(pre.crossSource?.risky).toBe(true);
  });

  it.each(COLUMNS.map(([label, column, value], i) => [label, column, value, ACC_COLUMN + i] as const))(
    "%s on the stored row makes it no supersede candidate",
    (_label, column, value, accountId) => {
      const sym = `COL${accountId}-EQ`;
      const buy = fill({ tradingsymbol: sym });
      expect(commit.commitParsedFile(parsedOf([buy]), FILE, null, accountId, snap).added).toBe(1);
      t.sqlite.prepare(`UPDATE trades SET ${column} = ? WHERE account_id = ?`).run(value, accountId);
      const pull2 = parsedOf([buy, fill({ tradingsymbol: sym, transactiontype: "SELL", fillprice: "160", filltime: "14:00:00" })]);
      const pre = commit.previewParsedFile(pull2, null, accountId, FILE, snap);
      // THE assertion (supersededCount 1 on revert of the user-record guard).
      expect(pre.summary.supersededCount).toBe(0);
      expect(pre.crossSource?.risky).toBe(true);
    },
  );

  it("the import's own 'unknown' flag is not a user record: a grown sell-only row with no basis IS replaced in place", () => {
    const sell50 = fill({ tradingsymbol: "NOBASIS-EQ", transactiontype: "SELL", fillsize: "50", fillprice: "200" });
    expect(commit.commitParsedFile(parsedOf([sell50]), FILE, null, ACC_UNKNOWN, snap).added).toBe(1);
    const [first] = rowsOf(ACC_UNKNOWN);
    const pull2 = parsedOf([sell50, fill({ tradingsymbol: "NOBASIS-EQ", transactiontype: "SELL", fillsize: "30", fillprice: "210", filltime: "14:00:00" })]);
    const pre = commit.previewParsedFile(pull2, null, ACC_UNKNOWN, FILE, snap);
    // THE assertion (supersededCount 0 under a mutant that reads any acquisition as a user record).
    expect([pre.summary.supersededCount, pre.crossSource?.risky]).toEqual([1, false]);
    commit.commitParsedFile(pull2, FILE, null, ACC_UNKNOWN, snap);
    expect(rowsOf(ACC_UNKNOWN)).toMatchObject([{ id: first!.id, buy_qty: 0, sell_qty: 80, acquisition: "unknown" }]);
  });
});

// ===========================================================================
// N2 — a planSnapshot 'ask' is honoured whether or not cross-source finds a kind
// ===========================================================================

describe("N2 · a laddered row that grew with no quantity or value relation is asked about", () => {
  it("pull 1 BUY 10 + 10 (a two-leg ladder), pull 2 adds BUY 5: risky, 'collision', and nothing is committed by the classifier's path", () => {
    const ladder = [fill({ tradingsymbol: "GROWN-EQ", fillprice: "150" }), fill({ tradingsymbol: "GROWN-EQ", fillprice: "151", filltime: "10:30:00" })];
    expect(commit.commitParsedFile(parsedOf(ladder), FILE, null, ACC_GROWN, snap).added).toBe(1);
    const [stored] = rowsOf(ACC_GROWN);
    const legs = (t.sqlite.prepare("SELECT COUNT(*) AS n FROM trade_legs WHERE trade_id = ?").get(stored!.id) as { n: number }).n;
    expect(legs, "pull 1 wrote a two-leg ladder").toBe(2);

    const pull2 = parsedOf([...ladder, fill({ tradingsymbol: "GROWN-EQ", fillsize: "5", fillprice: "152", filltime: "11:00:00" })]);
    const pre = commit.previewParsedFile(pull2, null, ACC_GROWN, FILE, snap);
    expect(pre.summary.supersededCount).toBe(0);
    // THE assertions (risky false, no collision and 'commit' on revert).
    expect(pre.crossSource?.risky).toBe(true);
    expect(pre.crossSource?.collisions).toMatchObject([
      { symbol: "GROWN", kind: "earlier-snapshot", sameSnapshot: true, incoming: { buyQty: 25 }, existing: { id: stored!.id, buyQty: 20 } },
    ]);
    expect(job.classifyPreview(pre)).toBe("collision");
    // The words say what happened in this pull — not "a different file", not "delete the earlier import".
    expect(pre.crossSource?.message).toContain("today's earlier pull");
    expect(pre.crossSource?.message).not.toContain("Delete the earlier import");
  });

  it("two stored rows on the key (>1 candidates) and an incoming row related to neither: asked about, against the key's rows only", () => {
    expect(commit.commitParsedFile(parsedOf([fill({ tradingsymbol: "TWOCAND-EQ", fillsize: "7" })]), FILE, null, ACC_TWOCAND, snap).added).toBe(1);
    // A second stored row on the SAME key (the trades table has no product column).
    t.sqlite
      .prepare(
        `INSERT INTO trades (account_id, broker, bucket, segment, instrument_type, exchange, symbol, tradingsymbol, buy_qty, avg_buy_price, buy_value_paise, buy_date, source_file, dedup_hash, is_open)
         SELECT account_id, broker, bucket, segment, instrument_type, exchange, symbol, tradingsymbol, 3, 150, 45000, buy_date, source_file, 'r43-second-on-key', 1 FROM trades WHERE account_id = ?`,
      )
      .run(ACC_TWOCAND);
    const ids = rowsOf(ACC_TWOCAND).map((r) => r.id);
    expect(ids).toHaveLength(2);

    const pre = commit.previewParsedFile(parsedOf([fill({ tradingsymbol: "TWOCAND-EQ", fillsize: "11", fillprice: "149" })]), null, ACC_TWOCAND, FILE, snap);
    // THE assertions (risky false on revert of the ask being honoured on its own).
    expect(pre.summary.supersededCount).toBe(0);
    expect(pre.crossSource?.risky).toBe(true);
    expect(pre.crossSource?.collisions).toHaveLength(1);
    expect(ids).toContain(pre.crossSource!.collisions[0]!.existing.id);
  });
});

// ===========================================================================
// N3 (REVERSED by W2G M1) — a same-symbol row of another segment is asked about
// ===========================================================================

describe("N3 → W2G M1 · a new position that only shares a tradingsymbol with today's row of another segment is asked about (the accepted false ask)", () => {
  it("morning DELIVERY BUY 20; evening the same fill + an INTRADAY round trip 10/10: a sameSnapshot collision, 'collision', and a forced commit lands the round trip beside the held buy", () => {
    const delivery = fill({ tradingsymbol: "TWOPROD-EQ", fillsize: "20", fillprice: "100", filltime: "09:30:00" });
    expect(commit.commitParsedFile(parsedOf([delivery]), FILE, null, ACC_TWOPROD, snap).added).toBe(1);
    const held = rowsOf(ACC_TWOPROD);

    const pull2 = parsedOf([
      delivery,
      fill({ tradingsymbol: "TWOPROD-EQ", producttype: "INTRADAY", fillsize: "10", fillprice: "101", filltime: "11:00:00" }),
      fill({ tradingsymbol: "TWOPROD-EQ", producttype: "INTRADAY", transactiontype: "SELL", fillsize: "10", fillprice: "103", filltime: "13:00:00" }),
    ]);
    const pre = commit.previewParsedFile(pull2, null, ACC_TWOPROD, FILE, snap);
    expect([pre.summary.total, pre.summary.newCount, pre.summary.dupCount, pre.summary.supersededCount]).toEqual([2, 1, 1, 0]);
    // RE-PINNED deliberately (DECISIONS 2026-09-15, W2G M1: N3's narrowing is
    // reversed; a question beats a confident wrong answer, and this false ask is
    // the accepted cost). Measured at ec89bbd: collisions [], risky false,
    // 'commit'. After M1: one partial-quantity sameSnapshot collision against
    // the morning row, risky true, 'collision' — what a7e9288 said.
    expect(pre.crossSource?.collisions).toMatchObject([
      { symbol: "TWOPROD", kind: "partial-quantity", sameSnapshot: true, existing: { id: held[0]!.id, buyQty: 20, sellQty: 0 } },
    ]);
    expect(pre.crossSource?.risky).toBe(true);
    expect(job.classifyPreview(pre)).toBe("collision");
    expect(rowsOf(ACC_TWOPROD)).toEqual(held);

    // A commit forced past the question: the round trip lands beside the held buy, which is never rewritten.
    expect(commit.commitParsedFile(pull2, FILE, null, ACC_TWOPROD, snap).added).toBe(1);
    const rows = rowsOf(ACC_TWOPROD);
    expect(rows[0]).toEqual(held[0]);
    expect(rows.map((r) => [r.segment, r.buy_qty, r.sell_qty])).toEqual([
      ["eq_delivery", 20, 0],
      ["eq_intraday", 10, 10],
    ]);
  });
});

// ===========================================================================
// W2G M1 — a broker-side product conversion between two same-day pulls
// ===========================================================================

describe("W2G M1 · a position the BROKER re-classified between two same-day /positions pulls is asked about, never a silent second position", () => {
  const DHAN_FILE = `dhan-api-${TODAY}`;
  const dhanSnap = { supersedeSnapshot: { fileName: DHAN_FILE } };
  const position = (over: Partial<DhanPositionRow> = {}): DhanPositionRow => ({
    tradingSymbol: "CONV",
    exchangeSegment: "NSE_EQ",
    productType: "INTRADAY",
    positionType: "LONG",
    buyAvg: 100,
    buyQty: 10,
    sellAvg: 0,
    sellQty: 0,
    netQty: 10,
    ...over,
  });
  const pullOf = (rows: DhanPositionRow[]) => dhanParsedFile(normalizeDhanPositions(rows, TODAY));
  /** The fields the existing earlier-snapshot collision carries (cross-source.ts), and nothing else. */
  // D18 (v4.3.0 fix wave 2O, ask#0) — SEVEN keys: `row`, the index of the incoming
  // row a collision blocks. A DELIBERATE pin move, and the reason wave 2N rejected
  // adding an id: the dialog keyed a card on symbol + the four incoming figures, so
  // two DIFFERENT incoming rows of one scrip that agree on those five collapsed into
  // ONE card while the server sentence above it read "2 rows in this file (TWOEX)".
  const COLLISION_FIELDS = ["detail", "existing", "incoming", "kind", "row", "sameSnapshot", "symbol"];

  it("noon INTRADAY BUY 10, evening the same position converted to CNC and grown to 20: asked (sameSnapshot, risky, 'collision'), the preview writes nothing, and only a forced commit adds a row", () => {
    expect(commit.commitParsedFile(pullOf([position()]), DHAN_FILE, null, ACC_CONV, dhanSnap).added).toBe(1);
    const noon = rowsOf(ACC_CONV);
    expect(noon.map((r) => [r.segment, r.buy_qty, r.sell_qty])).toEqual([["eq_intraday", 10, 0]]);

    const pull2 = pullOf([position({ productType: "CNC", buyQty: 20, netQty: 20, buyAvg: 100.5 })]);
    const pre = commit.previewParsedFile(pull2, null, ACC_CONV, DHAN_FILE, dhanSnap);
    expect([pre.summary.newCount, pre.summary.dupCount, pre.summary.supersededCount]).toEqual([1, 0, 0]);
    // THE assertions (collisions [], risky false and 'commit' on revert of M1:
    // the eq_delivery row had no candidate on its key and the book held 30 against the broker's 20).
    expect(pre.crossSource?.collisions).toEqual([
      {
        symbol: "CONV",
        // D18 (wave 2O, ask#0): the index of the incoming row this blocks.
        row: 0,
        incoming: { buyQty: 20, sellQty: 0, buyValue: 2010, sellValue: 0 },
        existing: { id: noon[0]!.id, buyQty: 10, sellQty: 0, sourceFile: DHAN_FILE },
        kind: "partial-quantity",
        detail: `20 shares here against 10 already recorded from ${DHAN_FILE} — one may be part of the other.`,
        sameSnapshot: true,
      },
    ]);
    expect(Object.keys(pre.crossSource!.collisions[0]!).sort()).toEqual(COLLISION_FIELDS);
    expect(pre.crossSource?.risky).toBe(true);
    expect(job.classifyPreview(pre)).toBe("collision");
    // RE-PINNED (W2H, DECISIONS 2026-09-15): an ask made only by M1 names its own reason. Measured at 3feb22f:
    // "…restates a position today's earlier pull already recorded, and is not written over it: the recorded row carries detail…".
    expect(pre.crossSource?.message).toContain(`1 row in this pull (CONV) restates an instrument today's earlier pull already recorded under ${M1_REASON}`);
    expect(pre.crossSource?.message).not.toContain(KEY_REASONS);
    // The question comes before any row lands.
    expect(rowsOf(ACC_CONV)).toEqual(noon);

    // Forced past the question (the user's choice), the evening row lands beside the noon row; nothing is rewritten.
    const res = commit.commitParsedFile(pull2, DHAN_FILE, null, ACC_CONV, dhanSnap);
    expect(res.added).toBe(1);
    expect((res.warnings ?? []).some((w) => w.includes("updated from today's earlier pull"))).toBe(false);
    const after = rowsOf(ACC_CONV);
    expect(after[0]).toEqual(noon[0]);
    expect(after.map((r) => [r.segment, r.buy_qty, r.sell_qty])).toEqual([
      ["eq_intraday", 10, 0],
      ["eq_delivery", 20, 0],
    ]);
  });

  it("a conversion that grew by no whole multiple (10 → 25) is asked too, as kind 'earlier-snapshot' with the same fields", () => {
    expect(commit.commitParsedFile(pullOf([position({ tradingSymbol: "CONVX" })]), DHAN_FILE, null, ACC_CONV_NOREL, dhanSnap).added).toBe(1);
    const [noon] = rowsOf(ACC_CONV_NOREL);

    const pull2 = pullOf([position({ tradingSymbol: "CONVX", productType: "CNC", buyQty: 25, netQty: 25, buyAvg: 101 })]);
    const pre = commit.previewParsedFile(pull2, null, ACC_CONV_NOREL, DHAN_FILE, dhanSnap);
    // THE assertions (collisions [], risky false and 'commit' on revert of M1 — silent on every earlier version).
    expect(pre.crossSource?.collisions).toEqual([
      {
        symbol: "CONVX",
        row: 0,
        incoming: { buyQty: 25, sellQty: 0, buyValue: 2525, sellValue: 0 },
        existing: { id: noon!.id, buyQty: 10, sellQty: 0, sourceFile: DHAN_FILE },
        kind: "earlier-snapshot",
        detail: `Today's earlier pull recorded 10 bought and 0 sold in ${DHAN_FILE}; this pull states 25 bought and 0 sold.`,
        sameSnapshot: true,
      },
    ]);
    expect(Object.keys(pre.crossSource!.collisions[0]!).sort()).toEqual(COLLISION_FIELDS);
    expect(job.classifyPreview(pre)).toBe("collision");
    expect(rowsOf(ACC_CONV_NOREL)).toEqual([noon]);
  });

  it("W2H · the M1 ask's sentence names the actual reason and the path to the broker's book, and that path does reach the broker's book", () => {
    // The wave-2G re-check's STUCK reproduce.
    expect(commit.commitParsedFile(pullOf([position({ tradingSymbol: "STUCK" })]), DHAN_FILE, null, ACC_STUCK, dhanSnap).added).toBe(1);
    const [noon] = rowsOf(ACC_STUCK);
    const pull2 = pullOf([position({ tradingSymbol: "STUCK", productType: "CNC", buyQty: 20, netQty: 20, buyAvg: 100.5 })]);
    const pre = commit.previewParsedFile(pull2, null, ACC_STUCK, DHAN_FILE, dhanSnap);
    expect(pre.crossSource?.collisions.map((c) => [c.symbol, c.kind, c.sameSnapshot, c.existing.id])).toEqual([["STUCK", "partial-quantity", true, noon!.id]]);
    // THE assertions (on revert: "…restates a position today's earlier pull already recorded, and is not written over it:
    // the recorded row carries detail a replacement would lose (…), or more than one position shares its instrument. …").
    // W2J: pinned part by part (expectM1Sentence, above) after W2I rewrote this sentence for good reasons.
    const m1 = pre.crossSource?.message ?? "";
    expectM1Sentence(m1, "STUCK");
    // …and that guard can fail: the superseded sentence and two near misses are refused.
    for (const [label, mutant] of M1_MUTANTS) expect(() => expectM1Sentence(mutant, "STUCK"), label).toThrow();
    // The dialog shows this sentence word for word: pinned byte for byte on the pure builder in
    // tests/cross-source.test.ts (importing the client component here would push this file's beforeAll past its 3 s budget).

    // The path the sentence names: the earlier row deleted, the same pull again — no question, and the book is the broker's.
    t.sqlite.prepare("DELETE FROM trades WHERE id = ?").run(noon!.id);
    const again = commit.previewParsedFile(pull2, null, ACC_STUCK, DHAN_FILE, dhanSnap);
    expect([again.crossSource?.collisions, again.crossSource?.message, job.classifyPreview(again)]).toEqual([[], null, "commit"]);
    expect(commit.commitParsedFile(pull2, DHAN_FILE, null, ACC_STUCK, dhanSnap).added).toBe(1);
    expect(rowsOf(ACC_STUCK).map((r) => [r.segment, r.buy_qty, r.sell_qty])).toEqual([["eq_delivery", 20, 0]]);
  });

  it("control: the same INTRADAY position grown on its own key (10 → 20) is still replaced in place (R43) — the same-symbol ask applies only when nothing is on the key", () => {
    expect(commit.commitParsedFile(pullOf([position({ tradingSymbol: "CONVKEY" })]), DHAN_FILE, null, ACC_CONV, dhanSnap).added).toBe(1);
    const [noon] = rowsOf(ACC_CONV).filter((r) => r.tradingsymbol === "CONVKEY");
    const pull2 = pullOf([position({ tradingSymbol: "CONVKEY", buyQty: 20, netQty: 20, buyAvg: 100.5 })]);
    const pre = commit.previewParsedFile(pull2, null, ACC_CONV, DHAN_FILE, dhanSnap);
    // THE assertion (supersededCount 0, a collision and 'collision' under a mutant that asks about every row with a same-symbol stored row).
    expect([pre.summary.newCount, pre.summary.supersededCount, pre.crossSource?.collisions, job.classifyPreview(pre)]).toEqual([0, 1, [], "commit"]);
    commit.commitParsedFile(pull2, DHAN_FILE, null, ACC_CONV, dhanSnap);
    expect(rowsOf(ACC_CONV).filter((r) => r.tradingsymbol === "CONVKEY").map((r) => [r.id, r.segment, r.buy_qty])).toEqual([[noon!.id, "eq_intraday", 20]]);
  });
});

// ===========================================================================
// W2F OVERRIDE-DOUBLE — a row the user re-classified today is a key candidate
// for its tradingsymbol, never replaced in place, always asked
// ===========================================================================

describe("W2F OVERRIDE-DOUBLE · today's snapshot row the user re-tagged is asked about, never doubled silently or rewritten", () => {
  const fullRow = (id: number) => t.sqlite.prepare("SELECT * FROM trades WHERE id = ?").get(id);
  const retag = async (tradeId: number, fields: Record<string, string>) => {
    const form = new FormData();
    form.set("tradeId", String(tradeId));
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    await actions.overrideTrade(form);
  };

  it("DELIVERY BUY 10 re-tagged to MTF (the REAL overrideTrade), then pull 2 BUY 10 + SELL 10: risky, 'collision'; a forced commit adds the round trip beside and never UPDATEs the re-tagged row", async () => {
    const buy = fill({ tradingsymbol: "RETAG-EQ" });
    expect(commit.commitParsedFile(parsedOf([buy]), FILE, null, ACC_RETAG, snap).added).toBe(1);
    const [morning] = rowsOf(ACC_RETAG);
    expect(morning).toMatchObject({ segment: "eq_delivery", buy_qty: 10, sell_qty: 0 });

    await retag(morning!.id, { segment: "eq_mtf", exchange: "NSE", isMtf: "true", setupTag: "" });
    expect(rowsOf(ACC_RETAG).map((r) => r.segment)).toEqual(["eq_mtf"]);
    const retagged = fullRow(morning!.id);

    const pull2 = parsedOf([buy, fill({ tradingsymbol: "RETAG-EQ", transactiontype: "SELL", fillprice: "160", filltime: "14:00:00" })]);
    const pre = commit.previewParsedFile(pull2, null, ACC_RETAG, FILE, snap);
    expect([pre.summary.newCount, pre.summary.dupCount, pre.summary.supersededCount]).toEqual([1, 0, 0]);
    // THE assertions (collisions [], risky false and 'commit' on revert at
    // ec89bbd: the evening eq_delivery row's key missed the eq_mtf row, and the
    // book held 20 bought against 10). Since W2G M1 the same-symbol ask also
    // covers this row, so reverting OVERRIDE-DOUBLE's by-symbol candidates alone
    // keeps it green (measured); the code stays, as decided.
    expect(pre.crossSource?.collisions).toMatchObject([{ symbol: "RETAG", existing: { id: morning!.id }, sameSnapshot: true }]);
    expect(pre.crossSource?.risky).toBe(true);
    expect(job.classifyPreview(pre)).toBe("collision");
    expect(pre.crossSource?.message).toContain("a segment or exchange you set");
    // The preview wrote nothing: the question comes before any row lands.
    expect(fullRow(morning!.id)).toEqual(retagged);
    expect(rowsOf(ACC_RETAG)).toHaveLength(1);

    // A commit forced past the question adds the evening row beside the re-tagged one; it never rewrites it.
    const res = commit.commitParsedFile(pull2, FILE, null, ACC_RETAG, snap);
    expect(res.added).toBe(1);
    expect((res.warnings ?? []).some((w) => w.includes("updated from today's earlier pull"))).toBe(false);
    expect(fullRow(morning!.id)).toEqual(retagged);
    expect(rowsOf(ACC_RETAG).map((r) => [r.segment, r.buy_qty, r.sell_qty])).toEqual([
      ["eq_mtf", 10, 0],
      ["eq_delivery", 10, 10],
    ]);
  });

  it("a re-tag that kept the row on the evening row's key (the Re-tag dialog always writes segment and exchange) is asked about, not replaced in place", async () => {
    const buy = fill({ tradingsymbol: "SAMEKEY-EQ" });
    expect(commit.commitParsedFile(parsedOf([buy]), FILE, null, ACC_RETAG_SAMEKEY, snap).added).toBe(1);
    const [morning] = rowsOf(ACC_RETAG_SAMEKEY);
    await retag(morning!.id, { segment: "eq_delivery", exchange: "NSE", isMtf: "false", setupTag: "breakout" });
    const retagged = fullRow(morning!.id);

    const pull2 = parsedOf([buy, fill({ tradingsymbol: "SAMEKEY-EQ", transactiontype: "SELL", fillprice: "160", filltime: "14:00:00" })]);
    const pre = commit.previewParsedFile(pull2, null, ACC_RETAG_SAMEKEY, FILE, snap);
    // THE assertion (supersededCount 1 and risky false on revert of the single-candidate guard).
    expect([pre.summary.newCount, pre.summary.supersededCount, pre.crossSource?.risky]).toEqual([1, 0, true]);
    commit.commitParsedFile(pull2, FILE, null, ACC_RETAG_SAMEKEY, snap);
    expect(fullRow(morning!.id)).toEqual(retagged);
  });

  it("control: no re-tag on the tradingsymbol — the same flow still replaces the morning row in place (R43), while another symbol re-tagged in the same pull file changes nothing", async () => {
    const buy = fill({ tradingsymbol: "PLAIN-EQ" });
    const other = fill({ tradingsymbol: "OTHERTAG-EQ", fillsize: "5" });
    expect(commit.commitParsedFile(parsedOf([buy, other]), FILE, null, ACC_RETAG_CONTROL, snap).added).toBe(2);
    const [plain, tagged] = rowsOf(ACC_RETAG_CONTROL);
    await retag(tagged!.id, { segment: "eq_mtf", exchange: "NSE", isMtf: "true", setupTag: "" });

    const pull2 = parsedOf([buy, other, fill({ tradingsymbol: "PLAIN-EQ", transactiontype: "SELL", fillprice: "160", filltime: "14:00:00" })]);
    const pre = commit.previewParsedFile(pull2, null, ACC_RETAG_CONTROL, FILE, snap);
    // THE assertions (supersededCount 0, a collision and 'collision' under a mutant that counts every row as re-tagged).
    expect([pre.summary.total, pre.summary.newCount, pre.summary.dupCount, pre.summary.supersededCount]).toEqual([2, 0, 1, 1]);
    expect(pre.crossSource?.collisions).toEqual([]);
    expect(job.classifyPreview(pre)).toBe("commit");
    commit.commitParsedFile(pull2, FILE, null, ACC_RETAG_CONTROL, snap);
    expect(rowsOf(ACC_RETAG_CONTROL).map((r) => [r.id, r.segment, r.buy_qty, r.sell_qty])).toEqual([
      [plain!.id, "eq_delivery", 10, 10],
      [tagged!.id, "eq_mtf", 5, 0],
    ]);
  });
});

// ===========================================================================
// D3 (wave 2M, finding G-G3-1) — the acquisition day a user TYPES
// ===========================================================================

/**
 * `setAcquisitionAction` is the /trades "how were these shares acquired" panel,
 * and the one typed-date writer wave 2M's calendar rule did not reach: it wrote
 * the field RAW into `trades.acquisition_date` and, whenever a cost was given,
 * into `trades.buy_date`. That is the field the IPO pairing reads FIRST
 * (`acquisitionDate ?? buyDate`) and the day the tax pack's financial year, the
 * MTF day count and every holding period are computed from.
 *
 * The panel's input is `type="date"`, so a day-first value needs a non-browser
 * client — but a HALF-TYPED YEAR (`0002-06-15`) is reachable from a real date
 * input, and `2026-02-31` is reachable from any client at all. Both were stored
 * without a word. Measured before this fix: ok true, `acquisition_date` and
 * `buy_date` both '0002-06-15'.
 */
describe("D3 · setAcquisitionAction refuses a day that does not exist, before anything is written", () => {
  it("refuses a half-typed year and an impossible day, and stores a readable one as the ISO day", async () => {
    const sale = fill({ tradingsymbol: "ACQDATE-EQ", transactiontype: "SELL", fillsize: "20", fillprice: "300", filltime: "11:00:00" });
    expect(commit.commitParsedFile(parsedOf([sale]), FILE, null, ACC_ACQDATE, snap).added).toBe(1);
    const [stored] = rowsOf(ACC_ACQDATE);
    const dayOf = () =>
      (t.sqlite.prepare("SELECT acquisition_date AS d FROM trades WHERE account_id = ?").get(ACC_ACQDATE) as { d: string | null }).d;
    const form = (date: string) => {
      const f = new FormData();
      f.set("tradeId", String(stored!.id));
      f.set("acquisition", "ipo");
      f.set("acquisitionPrice", "100");
      f.set("acquisitionDate", date);
      return f;
    };

    for (const bad of ["0002-06-15", "2026-02-31", "31-11-2025", "not a date"]) {
      const res = await actions.setAcquisitionAction({ ok: false, message: "" }, form(bad));
      // THE assertion (before: ok true, the value stored as typed on both columns).
      expect(res.ok, bad).toBe(false);
      expect(res.message, bad).toBe(unreadableDateMessage("acquisition date", bad));
      expect(res.message, bad).toContain("is not a real calendar day");
      expect(res.message, bad).toContain(bad);
      expect(rowsOf(ACC_ACQDATE), `${bad}: nothing was written`).toEqual([stored]);
      expect(dayOf(), `${bad}: nor the acquisition date itself`).toBeNull();
    }

    // A real day still saves, and a day-first one is stored as the day it states.
    const ok = await actions.setAcquisitionAction({ ok: false, message: "" }, form("15-01-2025"));
    expect(ok.ok, ok.message).toBe(true);
    expect(rowsOf(ACC_ACQDATE)[0]).toMatchObject({ acquisition: "ipo", acquisition_price: 100, buy_date: "2025-01-15" });
    expect(dayOf()).toBe("2025-01-15");
  });
});
