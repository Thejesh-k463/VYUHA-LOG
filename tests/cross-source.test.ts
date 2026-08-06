import { describe, expect, it } from "vitest";
import { detectCrossSourceDuplicates, type ExistingRow, type IncomingRow } from "@/lib/import/cross-source";

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
