import { describe, expect, it } from "vitest";
import { collisionDialogCopy, PULL_FORCE_ROUTE_TAIL } from "@/components/import/broker-connect";
import {
  detectCrossBrokerEchoes,
  detectCrossSourceDuplicates,
  type ExistingRow,
  type IncomingRow,
} from "@/lib/import/cross-source";

/**
 * The scenario this exists for, reproduced from a real report:
 *
 * A Dhan Global Transaction Report records Reliance as buy 1 @ ₹1,298.90 on
 * 2026-07-01 — an open holding WITH a cost. A P&L export of the same period
 * states the same position with no dates and only the realised side. The two
 * hash differently, both insert, and the journal then shows a second Reliance
 * with "no cost on record" while the real one sits beside it.
 */

const inc = (over: Partial<IncomingRow> = {}): IncomingRow => ({
  broker: "dhan",
  symbol: "RELIANCE",
  tradingsymbol: "Reliance Industries",
  buyQty: 1,
  sellQty: 0,
  buyValue: 1298.9,
  sellValue: 0,
  buyDate: "2026-07-01",
  sellDate: null,
  dedupHash: "incoming-hash",
  ...over,
});

const ex = (over: Partial<ExistingRow> = {}): ExistingRow => ({
  id: 1,
  broker: "dhan",
  symbol: "RELIANCE",
  tradingsymbol: "Reliance Industries",
  buyQty: 1,
  sellQty: 0,
  buyValue: 1298.9,
  sellValue: 0,
  buyDate: "2026-07-01",
  sellDate: null,
  sourceFile: "Dhan_GlobalTransction_Report.csv",
  dedupHash: "existing-hash",
  ...over,
});

describe("the real scenario", () => {
  it("flags the same holding arriving from a second file kind", () => {
    const r = detectCrossSourceDuplicates([inc()], [ex()], "dhan-pnl.csv");
    expect(r.collisions).toHaveLength(1);
    expect(r.collisions[0].kind).toBe("same-quantity");
    expect(r.symbols).toEqual(["RELIANCE"]);
    expect(r.risky).toBe(true);
  });

  it("explains why the ordinary duplicate check missed it", () => {
    const r = detectCrossSourceDuplicates([inc()], [ex()], "dhan-pnl.csv");
    expect(r.message).toMatch(/different file/i);
    expect(r.message).toMatch(/twice/i);
  });

  it("says plainly that nothing is merged automatically", () => {
    // Merging means choosing whose numbers to keep, which silently corrupts
    // cost basis when wrong. The product refuses that class of guess.
    const r = detectCrossSourceDuplicates([inc()], [ex()], "dhan-pnl.csv");
    expect(r.message).toMatch(/nothing is merged/i);
  });
});

describe("what it must NOT flag", () => {
  it("ignores a row whose hash already matches — ordinary dedup handles it", () => {
    const r = detectCrossSourceDuplicates([inc({ dedupHash: "same" })], [ex({ dedupHash: "same" })], "other.csv");
    expect(r.collisions).toEqual([]);
  });

  it("ignores rows from the SAME file — a real second trade in that scrip", () => {
    // Buying the same stock twice in one report is ordinary, not a duplicate.
    const r = detectCrossSourceDuplicates([inc()], [ex({ sourceFile: "same-file.csv" })], "same-file.csv");
    expect(r.collisions).toEqual([]);
  });

  it("ignores a different symbol", () => {
    const r = detectCrossSourceDuplicates([inc({ tradingsymbol: "TCS", symbol: "TCS" })], [ex()], "pnl.csv");
    expect(r.collisions).toEqual([]);
  });

  it("ignores a different broker", () => {
    const r = detectCrossSourceDuplicates([inc({ broker: "zerodha" })], [ex({ broker: "dhan" })], "pnl.csv");
    expect(r.collisions).toEqual([]);
  });

  it("ignores an unrelated quantity and value", () => {
    const r = detectCrossSourceDuplicates(
      [inc({ buyQty: 7, buyValue: 9091.3 })],
      [ex({ buyQty: 500, buyValue: 267500 })],
      "pnl.csv",
    );
    expect(r.collisions).toEqual([]);
  });

  it("returns a null message and empty report for a clean import", () => {
    const r = detectCrossSourceDuplicates([inc({ tradingsymbol: "INFY", symbol: "INFY" })], [], "pnl.csv");
    expect(r.message).toBeNull();
    expect(r.risky).toBe(false);
  });
});

describe("matching without dates", () => {
  it("matches on quantity even when the incoming file states no dates at all", () => {
    // The whole reason the hashes differ: a P&L export has no dates.
    const r = detectCrossSourceDuplicates(
      [inc({ buyDate: null, sellDate: null })],
      [ex()],
      "dhan-pnl.csv",
    );
    expect(r.collisions).toHaveLength(1);
  });

  it("matches on value when quantities are stated differently", () => {
    const r = detectCrossSourceDuplicates(
      [inc({ buyQty: 0, sellQty: 0, buyValue: 267500 })],
      [ex({ buyQty: 500, sellQty: 0, buyValue: 267800 })], // ~0.1% apart
      "pnl.csv",
    );
    expect(r.collisions[0].kind).toBe("same-value");
  });

  it("does not treat a 5% value difference as the same trade", () => {
    const r = detectCrossSourceDuplicates(
      [inc({ buyQty: 0, buyValue: 100000 })],
      [ex({ buyQty: 999, buyValue: 105000 })],
      "pnl.csv",
    );
    expect(r.collisions).toEqual([]);
  });

  it("flags a partial-quantity overlap more softly than an exact one", () => {
    const r = detectCrossSourceDuplicates(
      [inc({ buyQty: 1000, buyValue: 500000 })],
      [ex({ buyQty: 500, buyValue: 267500 })],
      "pnl.csv",
    );
    expect(r.collisions[0].kind).toBe("partial-quantity");
    expect(r.risky).toBe(false); // worth mentioning, not worth blocking on
  });
});

describe("reporting", () => {
  it("reports one collision per incoming row, not one per candidate", () => {
    const r = detectCrossSourceDuplicates(
      [inc()],
      [ex({ id: 1 }), ex({ id: 2 }), ex({ id: 3 })],
      "pnl.csv",
    );
    expect(r.collisions).toHaveLength(1);
  });

  it("names the file the existing rows came from, so the user can act", () => {
    const r = detectCrossSourceDuplicates([inc()], [ex({ sourceFile: "Dhan_GTR_July.csv" })], "pnl.csv");
    expect(r.collisions[0].detail).toMatch(/Dhan_GTR_July\.csv/);
    expect(r.collisions[0].existing.sourceFile).toBe("Dhan_GTR_July.csv");
  });

  it("summarises many symbols without printing all of them", () => {
    const many = Array.from({ length: 9 }, (_, i) => inc({ symbol: `SYM${i}`, tradingsymbol: `SYM${i}` }));
    const existing = Array.from({ length: 9 }, (_, i) => ex({ id: i + 1, symbol: `SYM${i}`, tradingsymbol: `SYM${i}` }));
    const r = detectCrossSourceDuplicates(many, existing, "pnl.csv");
    expect(r.symbols).toHaveLength(9);
    expect(r.message).toMatch(/\+4 more/);
  });

  it("tells the user what to actually do about it", () => {
    const r = detectCrossSourceDuplicates([inc()], [ex()], "pnl.csv");
    expect(r.message).toMatch(/delete the earlier import/i);
  });
});

describe("side-aware (Q-LOOP, 4.3.0): buy against buy, sell against sell", () => {
  // A Dhan catch-up pull brings the SELL of a lot the book holds as a BUY. The
  // old max(buyQty, sellQty) compare called that "same-quantity", answered 409,
  // never moved the stamp — and asked again on every pull.
  const heldBuy = ex({ buyQty: 100, buyValue: 10000, sellQty: 0, sellValue: 0, buyDate: "2026-09-07", sourceFile: "dhan-api-2026-09-07" });

  it("a SELL of a held BUY of the same quantity is no collision", () => {
    const sale = inc({ buyQty: 0, buyValue: 0, sellQty: 100, sellValue: 12000, buyDate: null, sellDate: "2026-09-08" });
    const r = detectCrossSourceDuplicates([sale], [heldBuy], "dhan-api-2026-09-10");
    expect(r.collisions).toEqual([]);
    expect(r.risky).toBe(false);
  });

  it("an opposite-side row of the same VALUE, or a multiple of the quantity, is no collision either", () => {
    const sameValue = inc({ buyQty: 0, buyValue: 0, sellQty: 37, sellValue: 10000, buyDate: null, sellDate: "2026-09-08" });
    const partial = inc({ buyQty: 0, buyValue: 0, sellQty: 50, sellValue: 6000, buyDate: null, sellDate: "2026-09-08" });
    expect(detectCrossSourceDuplicates([sameValue, partial], [heldBuy], "dhan-api-2026-09-10").collisions).toEqual([]);
  });

  it("the same side at the same quantity is still 'same-quantity'", () => {
    const echo = inc({ buyQty: 100, buyValue: 10010, buyDate: null });
    const r = detectCrossSourceDuplicates([echo], [heldBuy], "dhan-pnl.csv");
    expect(r.collisions.map((c) => c.kind)).toEqual(["same-quantity"]);
    expect(r.risky).toBe(true);
  });

  it("a round trip still meets a sell-only P&L row on the sell side, and a held BUY on the buy side", () => {
    const roundTrip = ex({ buyQty: 10, buyValue: 1000, sellQty: 10, sellValue: 1200, sellDate: "2026-07-02" });
    const pnlSell = inc({ buyQty: 0, buyValue: 0, sellQty: 10, sellValue: 1200, buyDate: null, sellDate: null });
    expect(detectCrossSourceDuplicates([pnlSell], [roundTrip], "pnl.csv").collisions.map((c) => c.kind)).toEqual(["same-quantity"]);
    const closedHere = inc({ buyQty: 100, buyValue: 10000, sellQty: 100, sellValue: 12000, sellDate: "2026-09-08" });
    expect(detectCrossSourceDuplicates([closedHere], [heldBuy], "gtr.csv").collisions.map((c) => c.kind)).toEqual(["same-quantity"]);
  });
});

describe("R43 · today's earlier snapshot of the same pull is not 'a second trade in the same file'", () => {
  const FILE = "dhan-api-2026-09-10";
  const DAY = "2026-09-10";
  const morning = (over: Partial<ExistingRow> = {}) =>
    ex({ buyQty: 75, buyValue: 7500, buyDate: DAY, sourceFile: FILE, tradingsymbol: "OPT NIFTY 29 Sep 2026 24000 CE", symbol: "NIFTY", ...over });
  const evening = (over: Partial<IncomingRow> = {}) =>
    inc({
      buyQty: 75, buyValue: 7500, sellQty: 75, sellValue: 9000, buyDate: DAY, sellDate: DAY,
      tradingsymbol: "OPT NIFTY 29 Sep 2026 24000 CE", symbol: "NIFTY", ...over,
    });

  // W2R N3: the commit's plan names the stored rows on the supersede key
  // (`snapshotIds`); wave 2 passed only the day (`snapshotDay`), and every
  // same-file row of that day and tradingsymbol was compared. The inputs are
  // re-pinned to the ids; the assertions are unchanged.
  it("a snapshot row the commit will not replace meets the morning row: reported, risky, marked as the same snapshot", () => {
    const r = detectCrossSourceDuplicates([evening({ snapshotIds: [1] })], [morning()], FILE);
    expect(r.collisions).toHaveLength(1);
    expect(r.collisions[0]).toMatchObject({ kind: "same-quantity", sameSnapshot: true });
    expect(r.risky).toBe(true);
  });

  it("without snapshotIds the same-file row stays hidden, and a same-file row NOT on the key stays hidden too (W2R N3)", () => {
    expect(detectCrossSourceDuplicates([evening()], [morning()], FILE).collisions).toEqual([]);
    // Today's row of the same tradingsymbol in another segment, while the plan named only the key's row 7.
    // (Since W2G M1 the plan itself names such a row when nothing is on the key — tests/r43-supersede-guards.test.ts;
    // this pure function still reports only the ids it is handed.)
    expect(detectCrossSourceDuplicates([evening({ snapshotIds: [7] })], [morning({ id: 1 })], FILE).collisions).toEqual([]);
  });

  it("a PARTIAL overlap with the earlier snapshot is risky: the book grew, it did not gain a second position", () => {
    const grown = evening({ buyQty: 150, buyValue: 15000, sellQty: 0, sellValue: 0, sellDate: null, snapshotIds: [1] });
    const r = detectCrossSourceDuplicates([grown], [morning()], FILE);
    expect(r.collisions.map((c) => c.kind)).toEqual(["partial-quantity"]);
    expect(r.risky).toBe(true);
    // The same partial overlap from ANOTHER file stays the soft note it always was.
    expect(detectCrossSourceDuplicates([grown], [morning({ sourceFile: "other.csv" })], FILE).risky).toBe(false);
  });

  it("W2R N2: a snapshot row with NO quantity or value relation to the key's row is still reported — 'earlier-snapshot', risky", () => {
    // 20 → 25: not the same quantity, not within 1% in value, not a whole multiple.
    const stored = morning({ buyQty: 20, buyValue: 3010 });
    const grown = evening({ buyQty: 25, buyValue: 3770, sellQty: 0, sellValue: 0, sellDate: null, snapshotIds: [1] });
    const r = detectCrossSourceDuplicates([grown], [stored], FILE);
    // THE assertions (no collision and risky false on revert).
    expect(r.collisions).toEqual([
      {
        symbol: "NIFTY",
        incoming: { buyQty: 25, sellQty: 0, buyValue: 3770, sellValue: 0 },
        existing: { id: 1, buyQty: 20, sellQty: 0, sourceFile: FILE },
        kind: "earlier-snapshot",
        detail: `Today's earlier pull recorded 20 bought and 0 sold in ${FILE}; this pull states 25 bought and 0 sold.`,
        sameSnapshot: true,
      },
    ]);
    expect(r.risky).toBe(true);
    // The same two rows from ANOTHER file relate by nothing, so nothing is said.
    expect(
      detectCrossSourceDuplicates([{ ...grown, snapshotIds: undefined }], [{ ...stored, sourceFile: "other.csv" }], FILE).collisions,
    ).toEqual([]);
  });

  it("W2R N2: a snapshot row that shares no side with the key's row is still reported", () => {
    const soldOnly = evening({ buyQty: 0, buyValue: 0, sellQty: 30, sellValue: 3600, buyDate: null, snapshotIds: [1] });
    const r = detectCrossSourceDuplicates([soldOnly], [morning()], FILE);
    // THE assertion (an empty list on revert: the side-aware skip came first).
    expect(r.collisions.map((c) => [c.kind, c.sameSnapshot])).toEqual([["earlier-snapshot", true]]);
    expect(r.risky).toBe(true);
  });

  it("the words for today's earlier snapshot name this pull and never say 'delete the earlier import'; a cross-file collision keeps its words", () => {
    const same = detectCrossSourceDuplicates([evening({ snapshotIds: [1] })], [morning()], FILE).message!;
    // THE assertions ("…from a different file … Delete the earlier import first…" on revert).
    expect(same).toContain("1 row in this pull (NIFTY) restates a position today's earlier pull already recorded");
    expect(same).not.toContain("different file");
    expect(same).not.toContain("Delete the earlier import");
    // W2F OVERRIDE-DOUBLE: a row the user re-classified today is asked about too, so the reasons name it.
    expect(same).toContain("a segment or exchange you set");

    const other = detectCrossSourceDuplicates([inc()], [ex()], "dhan-pnl.csv").message!;
    expect(other.startsWith("1 row in this file (RELIANCE) look like trades already recorded from a different file. ")).toBe(true);
    expect(other.endsWith("Delete the earlier import first if these are the same trades.")).toBe(true);

    const both = detectCrossSourceDuplicates([evening({ snapshotIds: [1] }), inc({ dedupHash: "second" })], [morning(), ex({ id: 2 })], FILE);
    expect(both.collisions.map((c) => c.sameSnapshot === true)).toEqual([true, false]);
    expect(both.message!.startsWith("1 row in this file (RELIANCE) look like")).toBe(true);
    expect(both.message).toContain(" 1 row in this pull (NIFTY) restates");
  });

  /**
   * W2H (v4.3.0, DECISIONS 2026-09-15). An ask the commit's plan made ONLY
   * because nothing of today's snapshot is on the row's supersede key (W2G M1,
   * `snapshotOffKey`) used to read the key's reasons — a ladder, a Data Quality
   * join, a user record, two positions on one key — none of which is true of a
   * broker-side product conversion, and it named no path to the broker's book.
   */
  it("W2H: an ask made only because nothing is on the key names another product, segment or exchange and the delete-and-pull path", () => {
    const stuck = evening({ symbol: "STUCK", tradingsymbol: "STUCK", buyQty: 20, buyValue: 2010, sellQty: 0, sellValue: 0, sellDate: null, snapshotIds: [1], snapshotOffKey: true });
    const r = detectCrossSourceDuplicates([stuck], [morning({ symbol: "STUCK", tradingsymbol: "STUCK", buyQty: 10, buyValue: 1000 })], FILE);
    // The collision itself is the one G1 built: no new field.
    expect(r.collisions.map((c) => [c.kind, c.sameSnapshot, Object.keys(c).length])).toEqual([["partial-quantity", true, 6]]);
    // THE assertion (the key's reasons on revert). W2I re-pinned the tail: the
    // remedy counts the stored rows, and the sentence carries the user-record
    // warning and the way back from Deleted items.
    expect(r.message).toBe(
      "1 row in this pull (STUCK) restates an instrument today's earlier pull already recorded under another product, segment or exchange, and is not written over that row. " +
        "If the broker converted the position between the two pulls, the earlier row can be deleted from Trades and the pull run again, " +
        "which records the position as the broker now states it; committing anyway adds this pull's row beside the earlier one. " +
        "That row may carry a cost basis or journal entry you recorded; a deleted row can be put back from Backup & Restore → Deleted items.",
    );
    expect(r.message).not.toContain("carries detail a replacement would lose");
    // The pull dialog (earlierOnly) shows the route's 409 message less the route's tail, word for word.
    const copy = collisionDialogCopy({ collisions: r.collisions, message: `${r.message}${PULL_FORCE_ROUTE_TAIL}` });
    expect(copy).toEqual({ description: "Nothing has been committed.", serverMessage: r.message, otherSourceFooter: false });
  });

  it("W2H: a pull mixing an ask on the key and an M1-only ask states both sentences; two M1-only rows read in the plural", () => {
    const keyed = evening({ snapshotIds: [1] });
    const conv = (sym: string, id: number) =>
      evening({ symbol: sym, tradingsymbol: sym, dedupHash: `h-${sym}`, buyQty: 20, buyValue: 2010, sellQty: 0, sellValue: 0, sellDate: null, snapshotIds: [id], snapshotOffKey: true });
    const stored = (sym: string, id: number) => morning({ id, symbol: sym, tradingsymbol: sym, buyQty: 10, buyValue: 1000, dedupHash: `m-${sym}` });

    const both = detectCrossSourceDuplicates([keyed, conv("STUCK", 2)], [morning(), stored("STUCK", 2)], FILE);
    expect(both.collisions.map((c) => [c.symbol, c.sameSnapshot])).toEqual([["NIFTY", true], ["STUCK", true]]);
    // THE assertions (on revert: one sentence naming NIFTY and STUCK together, with the key's reasons).
    expect(both.message).toContain(
      "1 row in this pull (NIFTY) restates a position today's earlier pull already recorded, and is not written over it: the recorded row carries detail a replacement would lose",
    );
    expect(both.message).toContain(" 1 row in this pull (STUCK) restates an instrument today's earlier pull already recorded under another product, segment or exchange");

    const two = detectCrossSourceDuplicates([conv("CONVB", 3), conv("CONVA", 2)], [stored("CONVA", 2), stored("CONVB", 3)], FILE);
    // W2I re-pinned the tail (two incoming rows, two stored rows: the remedy counts the stored ones).
    expect(two.message).toBe(
      "2 rows in this pull (CONVA, CONVB) restate instruments today's earlier pull already recorded under another product, segment or exchange, and are not written over those rows. " +
        "If the broker converted these positions between the two pulls, the 2 earlier rows can be deleted from Trades and the pull run again, " +
        "which records the positions as the broker now states them; committing anyway adds this pull's rows beside the earlier ones. " +
        "Those rows may carry a cost basis or journal entry you recorded; a deleted row can be put back from Backup & Restore → Deleted items.",
    );
  });

  it("W2H: the flag alone changes nothing — a cross-file collision keeps its words, and without snapshotIds nothing of this pull file is reported", () => {
    const flagged = inc({ dedupHash: "second", snapshotOffKey: true });
    const r = detectCrossSourceDuplicates([flagged], [ex()], "dhan-pnl.csv");
    expect(r.message!.startsWith("1 row in this file (RELIANCE) look like trades already recorded from a different file. ")).toBe(true);
    expect(r.message).not.toContain("another product, segment or exchange");
    expect(detectCrossSourceDuplicates([evening({ snapshotOffKey: true })], [morning()], FILE).collisions).toEqual([]);
  });

  /**
   * W2I (v4.3.0 fix wave 2I, the wave-2H re-check's two `ask` findings).
   *
   * [0] The M1 ask is raised against EVERY same-tradingsymbol row of today's
   *     snapshot (commit.ts planSnapshot → `snapshotIds`), but its sentence
   *     pluralised on the number of colliding INCOMING rows. One incoming row
   *     whose ask names two stored rows (two exchanges, or two products) read
   *     "the earlier row can be deleted" and reported only one of them, so
   *     following the sentence once left the same pull refused with the same
   *     sentence. The remedy now counts the STORED rows the plan named, so one
   *     round of it clears the ask.
   * [1] An M1 ask never reaches planSnapshot's `carriesUserRecord` check (the
   *     stored row is on another key), so the row it names to delete may carry
   *     a cost basis or a journal entry the user recorded. The on-key sentence
   *     says so; the M1 sentence had lost that warning, and named no way back.
   */
  const conv2 = (over: Partial<IncomingRow> = {}) =>
    evening({
      symbol: "TWOEX", tradingsymbol: "TWOEX", buyQty: 20, buyValue: 2010, sellQty: 0, sellValue: 0, sellDate: null,
      snapshotOffKey: true, ...over,
    });
  const stored2 = (id: number, over: Partial<ExistingRow> = {}) =>
    morning({ id, symbol: "TWOEX", tradingsymbol: "TWOEX", buyQty: 10, buyValue: 1000, dedupHash: `m-${id}`, ...over });

  it("W2I: one incoming row whose ask names TWO stored rows reads the remedy in the plural and counts them, so one round of it clears the ask", () => {
    // The re-check's TWOEX reproduce: NSE_EQ intraday 10 and BSE_EQ intraday 5
    // committed at noon; the evening pull states TWOEX CNC 20 on NSE_EQ, so
    // nothing is on its key and the plan names BOTH stored rows.
    const r = detectCrossSourceDuplicates([conv2({ snapshotIds: [1, 2] })], [stored2(1), stored2(2, { buyQty: 5, buyValue: 495 })], FILE);
    // The collision object is untouched: still one report per incoming row, still 6 keys.
    expect(r.collisions.map((c) => [c.symbol, c.sameSnapshot, Object.keys(c).length])).toEqual([["TWOEX", true, 6]]);
    // THE assertion (on revert: "… is not written over that row. … the earlier
    // row can be deleted … committing anyway keeps both rows.").
    expect(r.message).toBe(
      "1 row in this pull (TWOEX) restates an instrument today's earlier pull already recorded under another product, segment or exchange, and is not written over those rows. " +
        "If the broker converted the position between the two pulls, the 2 earlier rows can be deleted from Trades and the pull run again, " +
        "which records the position as the broker now states it; committing anyway adds this pull's row beside the earlier ones. " +
        "Those rows may carry a cost basis or journal entry you recorded; a deleted row can be put back from Backup & Restore → Deleted items.",
    );
  });

  it("W2I: the M1 sentence carries the on-key sentence's user-record warning and the way back from Deleted items", () => {
    const one = detectCrossSourceDuplicates([conv2({ snapshotIds: [1] })], [stored2(1)], FILE).message!;
    // THE assertions (on revert: the M1 sentence ended at "keeps both rows.").
    expect(one).toContain("may carry a cost basis or journal entry you recorded");
    expect(one).toContain("put back from Backup & Restore → Deleted items");
    // One stored row keeps the singular throughout.
    expect(one).toBe(
      "1 row in this pull (TWOEX) restates an instrument today's earlier pull already recorded under another product, segment or exchange, and is not written over that row. " +
        "If the broker converted the position between the two pulls, the earlier row can be deleted from Trades and the pull run again, " +
        "which records the position as the broker now states it; committing anyway adds this pull's row beside the earlier one. " +
        "That row may carry a cost basis or journal entry you recorded; a deleted row can be put back from Backup & Restore → Deleted items.",
    );
    // Descriptive, not advice (the dialog's own SEBI guard, applied to the server sentence).
    expect(one).not.toMatch(/\b(recommend|suggest|should|consider|buy|sell)\b/i);
  });

  it("W2I: the two NON-M1 sentences are unchanged, byte for byte", () => {
    // THE assertions: only the M1 sentence moved in wave 2I.
    expect(detectCrossSourceDuplicates([inc()], [ex()], "dhan-pnl.csv").message).toBe(
      "1 row in this file (RELIANCE) look like trades already recorded from a different file. " +
        "The two file kinds state different facts — a transaction report has dates and both legs, a P&L export has neither — so the duplicate check cannot match them and importing both would record the same trade twice. " +
        "Nothing is merged automatically: merging means choosing whose numbers to keep, and getting that wrong silently corrupts cost basis and holding period. Delete the earlier import first if these are the same trades.",
    );
    expect(detectCrossSourceDuplicates([evening({ snapshotIds: [1] })], [morning()], FILE).message).toBe(
      "1 row in this pull (NIFTY) restates a position today's earlier pull already recorded, and is not written over it: " +
        "the recorded row carries detail a replacement would lose (a ladder of fills, a Data Quality join, a segment or exchange you set, or a cost basis or journal entry you recorded), or more than one position shares its instrument. " +
        "Nothing is merged or overwritten automatically; committing anyway adds this pull's row beside the earlier one.",
    );
  });

  /**
   * W2L (v4.3.0 fix wave 2L, the wave-2I re-check's `ask` finding).
   *
   * One report is made per incoming row, and the pick used to be the FIRST
   * risky candidate in `existing` order — which is rowid order, so an OLDER
   * cross-FILE row (an earlier P&L or tradebook import) met before today's
   * snapshot rows won it. The pull then read "…already recorded from a
   * different file … Delete the earlier import first", while the row actually
   * blocking the commit was today's own off-key snapshot row: the user deleted
   * an earlier IMPORT, pulled again and was refused again — this time with the
   * M1 sentence. The pick is by candidate PRIORITY now: today's snapshot is the
   * blocker whatever order the rows arrive in, so it is the one reported. Among
   * cross-file candidates the first risky one still wins, and the collision
   * object still carries its 6 keys.
   */
  const olderFile = (id: number, file: string, over: Partial<ExistingRow> = {}) =>
    stored2(id, { sourceFile: file, buyQty: 20, buyValue: 2010, buyDate: null, dedupHash: `p-${id}`, ...over });
  /**
   * W2N (D8, the wave-2L re-check's `ask` findings #0 and #1): the pick is a
   * SET of at most two — today's snapshot blocker AND the most severe risky
   * cross-FILE one — so ONE 409 names both remedies and one round of them ends
   * the ask. The W2L property below is unchanged: the snapshot row is reported
   * and its sentence is present whatever the rowid order. What is new is the
   * second entry beside it, and the cross-file sentence that carries the
   * conditional "Delete the earlier import first if these are the same trades".
   */
  const CROSS_FILE_TWOEX =
    "1 row in this file (TWOEX) look like trades already recorded from a different file. " +
    "The two file kinds state different facts — a transaction report has dates and both legs, a P&L export has neither — so the duplicate check cannot match them and importing both would record the same trade twice. " +
    "Nothing is merged automatically: merging means choosing whose numbers to keep, and getting that wrong silently corrupts cost basis and holding period. Delete the earlier import first if these are the same trades.";
  const M1_ONE =
    "1 row in this pull (TWOEX) restates an instrument today's earlier pull already recorded under another product, segment or exchange, and is not written over that row. " +
    "If the broker converted the position between the two pulls, the earlier row can be deleted from Trades and the pull run again, " +
    "which records the position as the broker now states it; committing anyway adds this pull's row beside the earlier one. " +
    "That row may carry a cost basis or journal entry you recorded; a deleted row can be put back from Backup & Restore → Deleted items.";

  it("W2L: an older cross-file row met FIRST no longer suppresses the M1 sentence, and both rowid orders read the same", () => {
    const incoming = [conv2({ snapshotIds: [1] })];
    const old = olderFile(5, "dhan-pnl.csv");
    const before = detectCrossSourceDuplicates(incoming, [old, stored2(1)], FILE);
    // THE assertions (on revert of W2L: existing.id 5 ALONE, no sameSnapshot, 5
    // keys, and only the cross-file sentence). W2N: the snapshot row is still
    // FIRST and still 6 keys; the older cross-file row rides beside it.
    expect(before.collisions.map((c) => [c.symbol, c.existing.id, c.sameSnapshot, Object.keys(c).length])).toEqual([
      ["TWOEX", 1, true, 6],
      ["TWOEX", 5, undefined, 5],
    ]);
    expect(before.message).toContain(M1_ONE);
    // W2N (ask#0): both blockers, both remedies, one round.
    expect(before.message).toBe(`${CROSS_FILE_TWOEX} ${M1_ONE}`);
    expect(before.risky).toBe(true);
    // The snapshot row first: the same report, byte for byte.
    expect(detectCrossSourceDuplicates(incoming, [stored2(1), old], FILE)).toEqual(before);
  });

  it("W2L: the remedy still counts every stored row the plan named, with an older file in the way", () => {
    const r = detectCrossSourceDuplicates(
      [conv2({ snapshotIds: [1, 2] })],
      [olderFile(5, "dhan-pnl.csv"), stored2(1), stored2(2, { buyQty: 5, buyValue: 495 })],
      FILE,
    );
    // THE assertion (on revert: the cross-file sentence, which names no stored count).
    expect(r.message).toContain("the 2 earlier rows can be deleted from Trades and the pull run again");
    // W2N: the snapshot pick first, the older cross-file blocker beside it.
    expect(r.collisions.map((c) => [c.existing.id, c.sameSnapshot])).toEqual([
      [1, true],
      [5, undefined],
    ]);
  });

  it("W2L: an ask ON the key behind an older cross-file row reads its own sentence too — the blocker is today's pull either way", () => {
    const r = detectCrossSourceDuplicates(
      [conv2({ snapshotIds: [1], snapshotOffKey: false })],
      [olderFile(5, "dhan-pnl.csv"), stored2(1)],
      FILE,
    );
    // THE assertions (on revert of W2L: the cross-file sentence ALONE, and the
    // on-key one absent). W2N (ask#1): the on-key sentence names no remedy, so
    // the older cross-file blocker — which does — is named beside it instead of
    // being dropped, and the user is not left with nothing to do.
    const ON_KEY =
      "1 row in this pull (TWOEX) restates a position today's earlier pull already recorded, and is not written over it: " +
      "the recorded row carries detail a replacement would lose (a ladder of fills, a Data Quality join, a segment or exchange you set, or a cost basis or journal entry you recorded), or more than one position shares its instrument. " +
      "Nothing is merged or overwritten automatically; committing anyway adds this pull's row beside the earlier one.";
    expect(r.message).toContain(ON_KEY);
    expect(r.message).toBe(`${CROSS_FILE_TWOEX} ${ON_KEY}`);
    expect(r.collisions.map((c) => [c.existing.id, c.sameSnapshot])).toEqual([
      [1, true],
      [5, undefined],
    ]);
  });

  it("W2L: with no snapshot among the candidates nothing moves — the first risky cross-file row still wins, byte for byte", () => {
    const two = [olderFile(5, "a.csv"), olderFile(6, "b.csv")];
    const CROSS_FILE =
      "1 row in this file (TWOEX) look like trades already recorded from a different file. " +
      "The two file kinds state different facts — a transaction report has dates and both legs, a P&L export has neither — so the duplicate check cannot match them and importing both would record the same trade twice. " +
      "Nothing is merged automatically: merging means choosing whose numbers to keep, and getting that wrong silently corrupts cost basis and holding period. Delete the earlier import first if these are the same trades.";
    const plain = detectCrossSourceDuplicates([conv2({ snapshotIds: undefined, snapshotOffKey: false })], two, FILE);
    expect(plain.collisions.map((c) => [c.existing.id, c.existing.sourceFile, c.kind])).toEqual([[5, "a.csv", "same-quantity"]]);
    expect(plain.message).toBe(CROSS_FILE);
    // An ask naming a row that is NOT among the candidates scans them all and still picks the first.
    const named = detectCrossSourceDuplicates([conv2({ snapshotIds: [99] })], two, FILE);
    expect(named.collisions.map((c) => [c.existing.id, c.sameSnapshot])).toEqual([[5, undefined]]);
    expect(named.message).toBe(CROSS_FILE);
  });

  it("the most severe overlap is reported: a partial candidate met first does not hide a same-quantity one", () => {
    const partialFirst = ex({ id: 1, buyQty: 500, buyValue: 267500, sourceFile: "a.csv" });
    const exact = ex({ id: 2, buyQty: 1000, buyValue: 900000, sourceFile: "b.csv" });
    const r = detectCrossSourceDuplicates([inc({ buyQty: 1000, buyValue: 500000 })], [partialFirst, exact], "pnl.csv");
    expect(r.collisions).toHaveLength(1);
    expect(r.collisions[0]).toMatchObject({ kind: "same-quantity", existing: { id: 2 } });
    expect(r.risky).toBe(true);
  });
});

describe("detectCrossBrokerEchoes — same instrument, same day, different broker", () => {
  // A trader with accounts at two brokers really can buy the same SENSEX
  // option twice in one day. Both trades are real and both stay — this note
  // only confirms the overlap is intentional. Informational, never a refusal.
  it("names the symbol and the other broker on a same-day overlap", () => {
    const note = detectCrossBrokerEchoes(
      [inc({ broker: "zerodha", tradingsymbol: "OPT SENSEX 27 Aug 2026 77300 PE" })],
      [ex({ broker: "dhan", tradingsymbol: "OPT SENSEX 27 Aug 2026 77300 PE" })],
    );
    expect(note).toMatch(/OPT SENSEX 27 Aug 2026 77300 PE/);
    expect(note).toMatch(/also under dhan/);
    expect(note).toMatch(/separate trades/i);
  });

  it("stays silent when the days differ", () => {
    expect(
      detectCrossBrokerEchoes(
        [inc({ broker: "zerodha", buyDate: "2026-07-02" })],
        [ex({ broker: "dhan", buyDate: "2026-07-01" })],
      ),
    ).toBeNull();
  });

  it("stays silent when the symbols differ", () => {
    expect(
      detectCrossBrokerEchoes(
        [inc({ broker: "zerodha", tradingsymbol: "TCS" })],
        [ex({ broker: "dhan", tradingsymbol: "INFY" })],
      ),
    ).toBeNull();
  });

  it("matches on the sell date too and survives empty inputs", () => {
    expect(detectCrossBrokerEchoes([], [ex()])).toBeNull();
    expect(detectCrossBrokerEchoes([inc()], [])).toBeNull();
    const note = detectCrossBrokerEchoes(
      [inc({ broker: "zerodha", buyDate: null, sellDate: "2026-07-05" })],
      [ex({ broker: "groww", buyDate: null, sellDate: "2026-07-05" })],
    );
    expect(note).toMatch(/also under groww/);
  });
});
