import { describe, expect, it } from "vitest";
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

  it("a snapshot row the commit will not replace meets the morning row: reported, risky, marked as the same snapshot", () => {
    const r = detectCrossSourceDuplicates([evening({ snapshotDay: DAY })], [morning()], FILE);
    expect(r.collisions).toHaveLength(1);
    expect(r.collisions[0]).toMatchObject({ kind: "same-quantity", sameSnapshot: true });
    expect(r.risky).toBe(true);
  });

  it("without snapshotDay the same-file row stays hidden, and a same-file row of another day stays hidden too", () => {
    expect(detectCrossSourceDuplicates([evening()], [morning()], FILE).collisions).toEqual([]);
    const yesterday = morning({ buyDate: "2026-09-09" });
    expect(detectCrossSourceDuplicates([evening({ snapshotDay: DAY })], [yesterday], FILE).collisions).toEqual([]);
  });

  it("a PARTIAL overlap with the earlier snapshot is risky: the book grew, it did not gain a second position", () => {
    const grown = evening({ buyQty: 150, buyValue: 15000, sellQty: 0, sellValue: 0, sellDate: null, snapshotDay: DAY });
    const r = detectCrossSourceDuplicates([grown], [morning()], FILE);
    expect(r.collisions.map((c) => c.kind)).toEqual(["partial-quantity"]);
    expect(r.risky).toBe(true);
    // The same partial overlap from ANOTHER file stays the soft note it always was.
    expect(detectCrossSourceDuplicates([grown], [morning({ sourceFile: "other.csv" })], FILE).risky).toBe(false);
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
