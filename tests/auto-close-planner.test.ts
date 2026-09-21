import { describe, expect, it } from "vitest";
import {
  AUTO_CLOSE_NOTE,
  CLOSED_BY_PREFIX,
  DEDUP_ALIAS_PREFIX,
  PARTIAL_CLOSE_NOTE,
  autoCloseSentences,
  closedByHash,
  emptyAutoCloseCounters,
  isLotIdentityFrozen,
  lotIdentityHashes,
  planLotCloses,
  splitByRemainder,
  withAutoClosedLotNote,
  withClosedByNote,
  withLotCloseNote,
  withScaledRemainderNote,
  type AutoCloseCounters,
  type IncomingRow,
  type OpenLot,
} from "@/lib/import/close-open-lots";

/**
 * v4.5.0 W2a — the PURE half of the rebuilt auto-close applier.
 *
 * tests/auto-close-fifo.test.ts already pins the FIFO/quantity/book-match core
 * that survived the 4.3.0 switch-off. THIS file pins only what W2a ADDED to the
 * pure module (design review revisions 9/12/13), so each case has a named hunk
 * to revert:
 *
 *   - the DATE gate in `planLotCloses` (R4 / R72): a dateless execution matches
 *     nothing, and a lot dated after the sale is never closed by it;
 *   - the one-holder note vocabulary (`withAutoClosedLotNote`,
 *     `withClosedByNote`, `closedByHash`, `CLOSED_BY_PREFIX`);
 *   - `AutoCloseCounters` and `autoCloseSentences` (R14 / R15 / R72).
 *
 * No database: this module imports none (invariant 2). The applier's DB half is
 * tests/auto-close-applier.test.ts.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

const lot = (over: Partial<OpenLot> & { id: number }): OpenLot => ({
  accountId: 1,
  broker: "dhan",
  tradingsymbol: "TCS",
  segment: "eq_delivery",
  exchange: "NSE",
  side: "long",
  qty: 100,
  price: 100,
  value: 10000,
  charges: 20,
  date: "2026-04-01",
  ...over,
});
const row = (over: Partial<IncomingRow> & { key: string }): IncomingRow => ({
  accountId: 1,
  broker: "dhan",
  tradingsymbol: "TCS",
  segment: "eq_delivery",
  exchange: "NSE",
  side: "sell",
  qty: 40,
  price: 120,
  value: 4800,
  charges: 10,
  date: "2026-05-01",
  ...over,
});

// ═════════ (2) a dateless execution matches NOTHING ═════════════════════════

describe("W2a · the date gate — an execution with no date closes nothing", () => {
  it("a dateless SELL falls whole to `untouched` even with a matching lot sitting there", () => {
    // R72 / ruling A2. A close date sets the charge epoch, the holding period
    // and the MTF day count; an unknown date is not evidence of anything
    // (invariant 6), so the sale is written as an ordinary row and Data
    // Quality's stale_open offers the join with a date the user confirms.
    const lots = [lot({ id: 1, qty: 100 })];
    const plan = planLotCloses(lots, [row({ key: "s", qty: 40, date: null })]);
    expect(plan.closes, "nothing may be closed by a row that states no day").toEqual([]);
    expect(plan.remainders, "an untouched lot is not even restated").toEqual([]);
    expect(plan.untouched).toEqual([{ key: "s", qty: 40 }]);
    expect(lots[0].qty, "the planner is pure").toBe(100);
  });

  it("a dateless BUY against a held short is refused the same way", () => {
    const plan = planLotCloses([lot({ id: 4, side: "short", qty: 50, value: 5000 })], [row({ key: "b", side: "buy", qty: 50, date: null })]);
    expect(plan.closes).toEqual([]);
    expect(plan.untouched).toEqual([{ key: "b", qty: 50 }]);
  });

  it("the SAME row dated closes normally — the date is the only difference", () => {
    const plan = planLotCloses([lot({ id: 1, qty: 100 })], [row({ key: "s", qty: 40, date: "2026-05-01" })]);
    expect(plan.closes.map((c) => [c.lotId, c.qty, c.fullyConsumed])).toEqual([[1, 40, false]]);
  });
});

// ═════════ (3) a lot dated AFTER the sale is never closed by it (R4) ════════

describe("W2a · R4 — a lot opened after the sale can never be the lot it closed", () => {
  it("a lot bought the day AFTER the sale is skipped; the sale falls to `untouched`", () => {
    const plan = planLotCloses([lot({ id: 9, qty: 100, date: "2026-05-02" })], [row({ key: "s", qty: 40, date: "2026-05-01" })]);
    expect(plan.closes, "a share bought tomorrow cannot have been sold yesterday").toEqual([]);
    expect(plan.untouched).toEqual([{ key: "s", qty: 40 }]);
  });

  it("a lot with NO open date is skipped too — an unknown date is not a date before", () => {
    const plan = planLotCloses([lot({ id: 8, qty: 100, date: null })], [row({ key: "s", qty: 40 })]);
    expect(plan.closes).toEqual([]);
    expect(plan.untouched).toEqual([{ key: "s", qty: 40 }]);
  });

  it("a SAME-DAY lot is eligible — the rule is 'after', not 'not before'", () => {
    const plan = planLotCloses([lot({ id: 7, qty: 100, date: "2026-05-01" })], [row({ key: "s", qty: 40, date: "2026-05-01" })]);
    expect(plan.closes.map((c) => [c.lotId, c.qty])).toEqual([[7, 40]]);
  });

  it("with an older eligible lot and a later ineligible one, only the older is taken", () => {
    const plan = planLotCloses(
      [lot({ id: 2, qty: 50, value: 5000, date: "2026-05-05" }), lot({ id: 1, qty: 30, value: 3000, date: "2026-04-01" })],
      [row({ key: "s", qty: 70, date: "2026-05-01" })],
    );
    expect(plan.closes.map((c) => [c.lotId, c.qty])).toEqual([[1, 30]]);
    expect(plan.untouched, "the 40 the future lot could not supply stays unmatched").toEqual([{ key: "s", qty: 40 }]);
  });
});

// ═════════ (6) every money component conserves to the paisa ════════════════

describe("W2a · money conserves — the per-component remainder rule", () => {
  // `splitParts` in commit.ts applies exactly this function to each of the ten
  // stored heads, so the invariant it must satisfy is asserted here on the
  // component rule itself; the applier test asserts the STORED sum (lot bill +
  // slice bill = the original bill) end to end.
  const heads = [0, 0.01, 0.02, 1.25, 12.5, 20, 33.33, 0.03, 118.44, 2.5];

  it("a ten-head bill split at any share sums back to itself, never a paisa more", () => {
    for (let pct = 1; pct < 100; pct++) {
      const share = pct / 100;
      for (const h of heads) {
        const { slice, keep } = splitByRemainder(h, share);
        expect(r2(slice + keep), `head ${h} at ${pct}%`).toBe(h);
      }
    }
  });

  it("a ₹0.01 head never becomes ₹0.02 — the remainder takes what is LEFT", () => {
    expect(splitByRemainder(0.01, 0.5)).toEqual({ slice: 0.01, keep: 0 });
    expect(splitByRemainder(0.01, 0.4)).toEqual({ slice: 0, keep: 0.01 });
    expect(splitByRemainder(0.01, 0.6)).toEqual({ slice: 0.01, keep: 0 });
  });

  it("a whole take leaves zero behind, and a zero take takes nothing", () => {
    expect(splitByRemainder(118.44, 1)).toEqual({ slice: 118.44, keep: 0 });
    expect(splitByRemainder(118.44, 0)).toEqual({ slice: 0, keep: 118.44 });
  });

  it("the planner's own apportionment conserves the lot's charges", () => {
    const plan = planLotCloses([lot({ id: 1, qty: 3, value: 300, charges: 0.01 })], [row({ key: "s", qty: 1, value: 120, charges: 0.01 })]);
    expect(r2(plan.closes[0].openCharges + plan.remainders[0].charges), "never ₹0.01 twice").toBe(0.01);
  });
});

// ═════════ (12) the sentences (R14 / R15 / R72) ════════════════════════════

describe("W2a · autoCloseSentences — what the import is allowed to SAY", () => {
  const c = (over: Partial<AutoCloseCounters>): AutoCloseCounters => ({ ...emptyAutoCloseCounters(), ...over });

  it("says nothing at all when nothing happened", () => {
    expect(autoCloseSentences(emptyAutoCloseCounters())).toEqual([]);
    expect(autoCloseSentences(c({ openedNew: 3 })), "opening rows is not an auto-close event").toEqual([]);
  });

  it("R14 — a REDUCED lot is never announced as closed", () => {
    const out = autoCloseSentences(c({ reduced: 1, closedAgainstStoredLot: 1 }));
    expect(out).toHaveLength(1);
    expect(out[0], "'closed' may describe closedWhole and nothing else").not.toMatch(/closed \w*\s*against/);
    expect(out[0]).toContain("1 position reduced, not closed");
    expect(out[0]).toContain("the rest is still open");
  });

  it("R14 — closedWhole is the only figure the word 'closed' counts", () => {
    const out = autoCloseSentences(c({ closedWhole: 2, reduced: 1, closedAgainstStoredLot: 3 }));
    expect(out[0]).toContain("2 positions closed");
    expect(out[0]).not.toContain("3 positions closed");
    expect(out[1]).toContain("1 position reduced, not closed");
  });

  it("R15 — 'already held in this account' is said only of a STORED lot", () => {
    const stored = autoCloseSentences(c({ closedWhole: 1, closedAgainstStoredLot: 1 }))[0];
    const own = autoCloseSentences(c({ closedWhole: 1, closedAgainstThisFilesLot: 1 }))[0];
    const both = autoCloseSentences(c({ closedWhole: 2, closedAgainstStoredLot: 1, closedAgainstThisFilesLot: 1 }))[0];
    expect(stored).toContain("against open positions this account already held");
    expect(own, "a buy and a sell inside ONE file were never 'already held'").not.toContain("already held");
    expect(own).toContain("against positions opened earlier in this same file");
    expect(both).toContain("some this account already held, some opened earlier in this same file");
    for (const s of [stored, own, both]) expect(s).toContain("(FIFO, oldest first).");
  });

  it("R72 — the refusal names the date and points at Data Quality, singular and plural", () => {
    const one = autoCloseSentences(c({ refusedNoDate: 1 }));
    expect(one).toHaveLength(1);
    expect(one[0]).toContain("1 incoming execution states no date");
    expect(one[0]).toContain("both rows stay open");
    expect(one[0]).toContain("Open positions with their closing trade stored beside them");
    expect(autoCloseSentences(c({ refusedNoDate: 2 }))[0]).toContain("2 incoming executions state no date");
  });

  it("plurals agree, and the three sentences arrive in a fixed order", () => {
    const out = autoCloseSentences(c({ closedWhole: 1, reduced: 2, refusedNoDate: 1, closedAgainstStoredLot: 1 }));
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("1 position closed");
    expect(out[1]).toContain("2 positions reduced");
    expect(out[2]).toContain("1 incoming execution states");
  });
});

// ═════════ (4/5, pure half) ONE execution hash, ONE holder ═════════════════

describe("W2a · the note vocabulary — one holder per execution hash (revision 9)", () => {
  const EXEC = "a".repeat(40);
  const OTHER = "b".repeat(40);

  it("a REDUCED lot gets the sentence and NOTHING else — no alias, no identity gained", () => {
    const notes = withAutoClosedLotNote(null);
    expect(notes).toBe(AUTO_CLOSE_NOTE);
    expect(notes, "an alias here is the two-holder bug that lost 40 shares of P&L").not.toContain(DEDUP_ALIAS_PREFIX);
    expect(lotIdentityHashes({ dedupHash: OTHER, importNotes: notes })).toEqual([OTHER]);
    expect(isLotIdentityFrozen({ dedupHash: OTHER, importNotes: notes }), "its legs no longer state its hash").toBe(true);
  });

  it("withAutoClosedLotNote is idempotent and keeps what was already written", () => {
    const once = withAutoClosedLotNote("Imported from Dhan");
    expect(once).toBe(`Imported from Dhan | ${AUTO_CLOSE_NOTE}`);
    expect(withAutoClosedLotNote(once)).toBe(once);
  });

  it("a lot consumed WHOLE holds the execution's hash as a real alias", () => {
    const notes = withLotCloseNote(null, EXEC);
    expect(notes).toBe(`${AUTO_CLOSE_NOTE} | ${DEDUP_ALIAS_PREFIX}${EXEC}`);
    expect(lotIdentityHashes({ dedupHash: OTHER, importNotes: notes })).toEqual([OTHER, EXEC]);
  });

  it("`closed-by:` is provenance and NEVER an identity", () => {
    const notes = withClosedByNote(AUTO_CLOSE_NOTE, EXEC);
    expect(notes).toBe(`${AUTO_CLOSE_NOTE} | ${CLOSED_BY_PREFIX}${EXEC}`);
    expect(closedByHash(notes)).toBe(EXEC);
    expect(
      lotIdentityHashes({ dedupHash: OTHER, importNotes: notes }),
      "reading closed-by as an identity would make a re-import of the file a duplicate",
    ).toEqual([OTHER]);
    expect(withClosedByNote(notes, EXEC), "idempotent").toBe(notes);
  });

  it("closedByHash refuses anything that is not a sha1 digest, and answers null on prose", () => {
    expect(closedByHash(null)).toBe(null);
    expect(closedByHash(AUTO_CLOSE_NOTE)).toBe(null);
    expect(closedByHash(`${CLOSED_BY_PREFIX}not-a-hash`)).toBe(null);
    expect(closedByHash(`${CLOSED_BY_PREFIX}${EXEC.toUpperCase()}`), "stored upper, read lower").toBe(EXEC);
  });

  it("a scaled REMAINDER freezes its own hash without gaining a second identity", () => {
    const notes = withScaledRemainderNote(null, EXEC);
    expect(notes).toContain(PARTIAL_CLOSE_NOTE);
    expect(lotIdentityHashes({ dedupHash: EXEC, importNotes: notes }), "de-duped: still one identity").toEqual([EXEC]);
    expect(isLotIdentityFrozen({ dedupHash: EXEC, importNotes: notes })).toBe(true);
  });

  it("the three vocabularies never collide on one row", () => {
    const notes = withClosedByNote(withAutoClosedLotNote("Imported"), EXEC);
    expect(notes.split(" | ")).toEqual(["Imported", AUTO_CLOSE_NOTE, `${CLOSED_BY_PREFIX}${EXEC}`]);
    expect(closedByHash(notes)).toBe(EXEC);
    expect(lotIdentityHashes({ dedupHash: OTHER, importNotes: notes })).toEqual([OTHER]);
  });
});
