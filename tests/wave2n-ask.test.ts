import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { collisionBadge, collisionDialogCopy, dialogCollisions, PULL_FORCE_ROUTE_TAIL } from "@/components/import/broker-connect";
import {
  collisionsToList,
  detectCrossSourceDuplicates,
  type ExistingRow,
  type IncomingRow,
} from "@/lib/import/cross-source";

/**
 * D8 (v4.3.0 fix wave 2N) — the wave-2L re-check's `ask` findings #0 and #1.
 *
 * An incoming row can be blocked by TWO real rows at once: today's earlier
 * snapshot of this same pull, and an older row from a DIFFERENT file (a P&L or
 * tradebook import). Only one was ever reported, so the user was sent through
 * two rounds in either order — and after wave 2L the sentence they met first
 * (the snapshot one) makes a definite promise ("the earlier row can be deleted
 * from Trades and the pull run again, which records the position as the broker
 * now states it") that is FALSE while the cross-file row also blocks it (#0).
 * With the ask ON the supersede key it was worse: that sentence names no remedy
 * at all, and the older duplicate was absent from `collisions` entirely (#1).
 *
 * The fix: per incoming row the pick is a SET of at most two — the snapshot
 * candidate AND the most severe RISKY cross-file candidate — so ONE 409 names
 * both remedies and one round of them ends the ask.
 */

const FILE = "dhan-api-2026-09-10";
const DAY = "2026-09-10";

/** The evening /positions pull: TWOEX CNC 20 @100.5, nothing on its key (M1). */
const evening = (over: Partial<IncomingRow> = {}): IncomingRow => ({
  broker: "dhan",
  symbol: "TWOEX",
  tradingsymbol: "TWOEX",
  buyQty: 20,
  sellQty: 0,
  buyValue: 2010,
  sellValue: 0,
  buyDate: DAY,
  sellDate: null,
  dedupHash: "evening",
  snapshotIds: [1],
  snapshotOffKey: true,
  ...over,
});

/** The noon /positions pull, committed: TWOEX INTRADAY 10 @100 — this pull's own file. */
const noon = (over: Partial<ExistingRow> = {}): ExistingRow => ({
  id: 1,
  broker: "dhan",
  symbol: "TWOEX",
  tradingsymbol: "TWOEX",
  buyQty: 10,
  sellQty: 0,
  buyValue: 1000,
  sellValue: 0,
  buyDate: DAY,
  sellDate: null,
  sourceFile: FILE,
  dedupHash: "noon",
  ...over,
});

/** The earlier `dhan-pnl.csv` import: TWOEX buy 20 @100.5 — a risky cross-FILE row. */
const pnl = (over: Partial<ExistingRow> = {}): ExistingRow =>
  noon({ id: 5, sourceFile: "dhan-pnl.csv", buyQty: 20, buyValue: 2010, buyDate: null, dedupHash: "pnl", ...over });

const CROSS_FILE_ONE =
  "1 row in this file (TWOEX) look like trades already recorded from a different file. " +
  "The two file kinds state different facts — a transaction report has dates and both legs, a P&L export has neither — so the duplicate check cannot match them and importing both would record the same trade twice. " +
  "Nothing is merged automatically: merging means choosing whose numbers to keep, and getting that wrong silently corrupts cost basis and holding period. Delete the earlier import first if these are the same trades.";

const ON_KEY_ONE =
  "1 row in this pull (TWOEX) restates a position today's earlier pull already recorded, and is not written over it: " +
  "the recorded row carries detail a replacement would lose (a ladder of fills, a Data Quality join, a segment or exchange you set, or a cost basis or journal entry you recorded), or more than one position shares its instrument. " +
  "Nothing is merged or overwritten automatically; committing anyway adds this pull's row beside the earlier one.";

const CONVERTED_ONE =
  "1 row in this pull (TWOEX) restates an instrument today's earlier pull already recorded under another product, segment or exchange, and is not written over that row. " +
  "If the broker converted the position between the two pulls, the earlier row can be deleted from Trades and the pull run again, " +
  "which records the position as the broker now states it; committing anyway adds this pull's row beside the earlier one. " +
  "That row may carry a cost basis or journal entry you recorded; a deleted row can be put back from Backup & Restore → Deleted items.";

describe("D8 — one incoming row, both blockers, one round (ask#0)", () => {
  it("the OFF-KEY ask reports today's snapshot row AND the older cross-file row, with both remedies", () => {
    const r = detectCrossSourceDuplicates([evening()], [pnl(), noon()], FILE);
    // THE assertion (red before the fix: only [[1, true]] — the `break` at :303
    // ended the scan the moment the snapshot candidate was met).
    expect(r.collisions.map((c) => [c.symbol, c.existing.id, c.sameSnapshot, c.existing.sourceFile])).toEqual([
      ["TWOEX", 1, true, FILE],
      ["TWOEX", 5, undefined, "dhan-pnl.csv"],
    ]);
    // Both remedies, one message: the cross-file sentence first (it carries the
    // conditional "Delete the earlier import first"), then the converted one.
    expect(r.message).toBe(`${CROSS_FILE_ONE} ${CONVERTED_ONE}`);
    // Unchanged in kind: one symbol, and nothing commits silently.
    expect([r.symbols, r.risky]).toEqual([["TWOEX"], true]);
  });

  it("the report reads the same in either rowid order, and the collision objects keep their shape", () => {
    const pnlFirst = detectCrossSourceDuplicates([evening()], [pnl(), noon()], FILE);
    expect(detectCrossSourceDuplicates([evening()], [noon(), pnl()], FILE)).toEqual(pnlFirst);
    // 6 keys on the snapshot report (the `sameSnapshot` flag), 5 on a cross-file one.
    expect(pnlFirst.collisions.map((c) => Object.keys(c).length)).toEqual([6, 5]);
  });

  it("deleting exactly the rows the ONE 409 named leaves nothing to ask — the second round is gone", () => {
    const round1 = detectCrossSourceDuplicates([evening()], [pnl(), noon()], FILE);
    const named = new Set(round1.collisions.map((c) => c.existing.id));
    // The user does exactly what the single 409 says. Nothing of today's
    // snapshot is left, so the next pull names no snapshot ids either.
    const round2 = detectCrossSourceDuplicates(
      [evening({ snapshotIds: [], snapshotOffKey: false })],
      [pnl(), noon()].filter((e) => !named.has(e.id)),
      FILE,
    );
    // THE assertion (red before the fix: `named` holds only the noon row, so
    // round 2 is refused again on the P&L row).
    expect([round2.collisions, round2.risky, round2.message]).toEqual([[], false, null]);
  });
});

describe("D8 — the ON-KEY ask names the older duplicate too (ask#1)", () => {
  it("an ask on the supersede key behind an older cross-file row carries the remedy it had none of", () => {
    const r = detectCrossSourceDuplicates([evening({ snapshotOffKey: false })], [pnl(), noon()], FILE);
    // THE assertions (red before the fix: the on-key sentence alone, no remedy,
    // and the older duplicate absent from `collisions`).
    expect(r.collisions.map((c) => [c.existing.id, c.sameSnapshot])).toEqual([
      [1, true],
      [5, undefined],
    ]);
    expect(r.message).toBe(`${CROSS_FILE_ONE} ${ON_KEY_ONE}`);
    expect(r.message).toContain("Delete the earlier import first");
    expect(r.risky).toBe(true);
  });
});

describe("D8 — what does NOT move", () => {
  it("a SOFTER cross-file candidate is not a blocker and is not reported beside the snapshot", () => {
    // 3 against 20: no relation, no risk — the ask stands on the snapshot alone.
    const softer = pnl({ id: 7, buyQty: 3, buyValue: 301.5, sourceFile: "old.csv", dedupHash: "soft" });
    const r = detectCrossSourceDuplicates([evening()], [softer, noon()], FILE);
    expect(r.collisions.map((c) => [c.existing.id, c.sameSnapshot])).toEqual([[1, true]]);
    expect(r.message).toBe(CONVERTED_ONE);
  });

  it("cross-file only, and snapshot only, read exactly as they did", () => {
    expect(detectCrossSourceDuplicates([evening({ snapshotIds: undefined, snapshotOffKey: false })], [pnl()], FILE).message).toBe(CROSS_FILE_ONE);
    expect(detectCrossSourceDuplicates([evening()], [noon()], FILE).message).toBe(CONVERTED_ONE);
    expect(detectCrossSourceDuplicates([evening({ snapshotOffKey: false })], [noon()], FILE).message).toBe(ON_KEY_ONE);
  });

  it("an ordinary import (no snapshot ids) still stops at the first risky candidate — its cost is unchanged", () => {
    const hits = { n: 0 };
    // `buyQty` is read ONLY inside the candidate loop: the bucket keys on
    // broker + tradingsymbol and the filter reads dedupHash, sourceFile and id.
    const watched = (row: ExistingRow): ExistingRow => {
      const value = row.buyQty;
      return Object.defineProperty({ ...row }, "buyQty", {
        get() {
          hits.n += 1;
          return value;
        },
        enumerable: true,
        configurable: true,
      }) as ExistingRow;
    };
    const second = watched(pnl({ id: 6, sourceFile: "b.csv", dedupHash: "pnl2" }));
    detectCrossSourceDuplicates([evening({ snapshotIds: undefined, snapshotOffKey: false })], [pnl(), second], FILE);
    expect(hits.n, "the early break still fires for an import that can meet no snapshot").toBe(0);
    // And with ids: the scan ends as soon as BOTH picks are held — the third
    // candidate is never examined.
    hits.n = 0;
    detectCrossSourceDuplicates([evening()], [noon(), pnl(), second], FILE);
    expect(hits.n, "the scan ends once both a snapshot and a risky cross-file pick are held").toBe(0);
  });
});

describe("D8 — the dialog lists ROWS, not collisions", () => {
  const routeMessage = (m: string | null) => `${m}${PULL_FORCE_ROUTE_TAIL}`;

  it("one incoming row with two blockers renders ONE entry carrying both sentences", () => {
    const r = detectCrossSourceDuplicates([evening()], [pnl(), noon()], FILE);
    const listed = dialogCollisions(r.collisions);
    // THE assertion (red before the fix: two entries for one row, so the dialog
    // printed the symbol twice).
    expect(listed).toHaveLength(1);
    expect(listed[0]!.symbol).toBe("TWOEX");
    expect([collisionBadge(listed[0]!.kind), ...(listed[0]!.also ?? []).map((c) => collisionBadge(c.kind))]).toEqual([
      "today's earlier pull",
      "same quantity",
    ]);
    expect((listed[0]!.also ?? []).map((c) => c.existing.id)).toEqual([5]);
    // Every fact stays the server's.
    expect(listed[0]).toMatchObject({ detail: r.collisions[0]!.detail, incoming: r.collisions[0]!.incoming, existing: r.collisions[0]!.existing });
  });

  it("the description counts ROWS, and a cross-file blocker still brings the other-source words", () => {
    const r = detectCrossSourceDuplicates([evening()], [pnl(), noon()], FILE);
    const copy = collisionDialogCopy({ collisions: r.collisions, message: routeMessage(r.message) });
    // THE assertion (red before the fix: two collisions read "these rows" for
    // ONE incoming row).
    expect(copy.description).toMatch(/cannot vouch for this row\.$/);
    expect(copy.otherSourceFooter).toBe(true);
    expect(copy.serverMessage).toBe(r.message);
  });

  it("two DIFFERENT incoming rows are still two rows", () => {
    const r = detectCrossSourceDuplicates(
      [evening(), evening({ symbol: "OTHEX", tradingsymbol: "OTHEX", dedupHash: "e2", snapshotIds: undefined, snapshotOffKey: false })],
      [pnl(), noon(), pnl({ id: 8, symbol: "OTHEX", tradingsymbol: "OTHEX", dedupHash: "o" })],
      FILE,
    );
    expect(dialogCollisions(r.collisions).map((c) => [c.symbol, (c.also ?? []).length])).toEqual([
      ["TWOEX", 1],
      ["OTHEX", 0],
    ]);
    expect(collisionDialogCopy({ collisions: r.collisions }).description).toMatch(/cannot vouch for these rows\.$/);
  });
});

describe("D8 — the preview list slices by SYMBOL", () => {
  it("six distinct symbols are listed with every entry of each, and the tail counts the symbols left", () => {
    const many = Array.from({ length: 8 }, (_, i) => [
      { symbol: `S${i}`, detail: "snapshot", kind: "partial-quantity", sameSnapshot: true },
      { symbol: `S${i}`, detail: "cross-file", kind: "same-quantity" },
    ]).flat();
    const { rows, more } = collisionsToList(many);
    // THE assertion (red before the fix: `.slice(0, 6)` listed three symbols
    // and said "…and 10 more" — a count of collisions, not of symbols).
    expect(new Set(rows.map((c) => c.symbol)).size).toBe(6);
    expect(rows).toHaveLength(12);
    expect(more).toBe(2);
  });

  it("nothing to elide: every collision is listed and the tail is 0", () => {
    const { rows, more } = collisionsToList([{ symbol: "A" }, { symbol: "A" }, { symbol: "B" }]);
    expect([rows.length, more]).toEqual([3, 0]);
  });
});

describe("D8 — the surfaces read those helpers rather than re-typing them", () => {
  const load = async (p: string) => (await readFile(new URL(p, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

  it("the blocked-commit dialog renders each entry's `also` beside it", async () => {
    const code = await load("../components/import/broker-connect.tsx");
    expect(code).toContain("{dialogCollisions(collisionPrompt?.collisions ?? []).map((c, i) => (");
    // THE assertion (red before the fix: the card knew nothing of a second blocker).
    expect(code).toMatch(/\[c, \.\.\.\(c\.also \?\? \[\]\)\]/);
  });

  /**
   * Wave 2N, the edit B-MTF was BLOCKED on: `app/targets/equity/page.tsx` counts
   * the open MTF rows whose funded amount the journal never recorded and leaves
   * them out of every ₹ figure (D7 / Q-A), but `MtfSummary` and its card had no
   * way to say so, so the omission was silent — half of invariant 6.
   */
  it("the /targets MTF card states the rows its figures leave out", async () => {
    const card = await load("../components/targets/target-equity-client.tsx");
    // THE assertions (red before the edit: no `unstated` anywhere, and the page
    // discarded its own count with `void unstatedFunding;`).
    expect(card).toContain("unstated: number;");
    expect(card).toContain("{mtf.unstated} MTF {mtf.unstated === 1 ? \"row is\" : \"rows are\"} not in these figures: funding not recorded.");
    const page = await load("../app/targets/equity/page.tsx");
    expect(page).toContain("unstated: unstatedFunding,");
    expect(page).not.toContain("void unstatedFunding;");
  });

  it("the import preview lists collisionsToList(…), never a slice of the collisions", async () => {
    const code = await load("../components/import/import-client.tsx");
    // THE assertion (red before the fix: `collisions.slice(0, 6)`).
    expect(code).toContain("collisionsToList(p?.crossSource?.collisions ?? [])");
    expect(code).not.toContain("collisions.slice(0, 6)");
  });
});
