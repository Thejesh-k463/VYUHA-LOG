import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { normalizeAngelTrades, toParsedFile, type AngelTradeRow } from "@/lib/import/api/angelone";

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
      [ACC_BASIS, ACC_JOURNAL, ACC_GROWN, ACC_TWOPROD, ACC_TWOCAND, ACC_UNKNOWN, ACC_RETAG, ACC_RETAG_SAMEKEY, ACC_RETAG_CONTROL, ...COLUMNS.map((_, i) => ACC_COLUMN + i)].map((id) => ({
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
// N3 — the same-snapshot comparison uses the supersede key
// ===========================================================================

describe("N3 · a new position that only shares a tradingsymbol with today's row of another segment is a new position", () => {
  it("morning DELIVERY BUY 20; evening the same fill + an INTRADAY round trip 10/10: no collision, 'commit', and the round trip lands beside the held buy", () => {
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
    // THE assertions (a partial-quantity sameSnapshot collision, risky true and 'collision' on revert).
    expect(pre.crossSource?.collisions).toEqual([]);
    expect(pre.crossSource?.risky).toBe(false);
    expect(job.classifyPreview(pre)).toBe("commit");

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
    // THE assertions (collisions [], risky false and 'commit' on revert: the
    // evening eq_delivery row's key missed the eq_mtf row, and the book held 20 bought against 10).
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
