import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { chargeStatus } from "@/lib/analytics/reconcile";

/**
 * v3.9 "Trust the numbers" — "Charges the broker states".
 *
 * THE HOLE THIS FILE CLOSES: three parsers write `scope: "charge"` reference
 * rows — Dhan's DP charges report, a Dhan contract note's own charge lines and
 * Angel One's ledger charge tables — and until now NOTHING read them. Help,
 * the import registry and the CHANGELOG all said DP charges feed Broker Truth
 * while the rows sat in the database unreferenced. `reconcile().charges` is
 * the read side, and these are its numbers, pinned.
 *
 * The three sources state DIFFERENT THINGS and are compared differently:
 * per FY for a DP fee (levied on a delivery SALE), per note date for a
 * contract note, per type for a ledger table — and a fee the book has no
 * column for gets NO Vyuha side and NO delta at all, because subtracting from
 * nothing is how a fabricated delta reaches a screen (invariant 6).
 *
 * One temp DB per FILE; lib/queries is imported dynamically so VYUHA_DB_PATH
 * is set before lib/db binds its connection.
 */

let t: TempDb;
let refq: typeof import("@/lib/queries/reference");

const ACCOUNT = 1;

/** Money is integer paise in the DB and rupees at runtime (invariant 1) — the
 *  `moneyPaise` type converts at the column boundary, so these are RUPEES. */
const SOLD = {
  // Two delivery sales in FY 2026-27, and one in FY 2025-26.
  fy2627: [
    { symbol: "DYCL", sellDate: "2026-07-20", buyDate: "2026-07-02", dpCharges: 13.5, pledgeCharges: 5, brokerage: 20, sttCtt: 126, exchangeTxn: 4.1, sebi: 0.13, stampDuty: 2, ipft: 0.1, gst: 4.4 },
    { symbol: "IDEA", sellDate: "2026-08-11", buyDate: "2026-08-11", dpCharges: 13.5, pledgeCharges: 0, brokerage: 40, sttCtt: 30, exchangeTxn: 3.2, sebi: 0.11, stampDuty: 1, ipft: 0.05, gst: 7.8 },
  ],
  fy2526: [
    { symbol: "ONGC", sellDate: "2025-11-05", buyDate: "2025-10-30", dpCharges: 20, pledgeCharges: 0, brokerage: 10, sttCtt: 12, exchangeTxn: 1, sebi: 0.05, stampDuty: 0.5, ipft: 0.02, gst: 2 },
  ],
};

function seed() {
  const { db, schema } = t;
  for (const list of [SOLD.fy2627, SOLD.fy2526]) {
    for (const s of list) {
      db.insert(schema.trades).values(tradeRow({
        accountId: ACCOUNT, broker: "dhan", symbol: s.symbol, tradingsymbol: s.symbol,
        segment: "eq_delivery", buyDate: s.buyDate, sellDate: s.sellDate,
        buyQty: 100, sellQty: 100, buyValue: 10000, sellValue: 11000,
        grossPnl: 1000, netPnl: 900, chargesTotal: 100, isOpen: false,
        dpCharges: s.dpCharges, pledgeCharges: s.pledgeCharges, brokerage: s.brokerage,
        sttCtt: s.sttCtt, exchangeTxn: s.exchangeTxn, sebi: s.sebi, stampDuty: s.stampDuty,
        ipft: s.ipft, gst: s.gst,
      })).run();
    }
  }

  type RefRow = typeof schema.brokerReference.$inferInsert;
  const ref = (over: Partial<RefRow> & Pick<RefRow, "sourceId" | "scope" | "key" | "figuresJson">): RefRow => ({
    accountId: ACCOUNT, broker: "dhan", isin: null, symbol: null, fy: null, asOf: null,
    note: null, importBatchId: null, ...over,
  });
  db.insert(schema.brokerReference).values([
    // Dhan DP charges report: one fee per ISIN per day, two days in FY 2026-27.
    ref({ sourceId: "dhan-dp-charges", scope: "charge", key: "INE600Y01019", asOf: "2026-07-20", figuresJson: JSON.stringify({ qty: 100, charges: 13.5 }) }),
    ref({ sourceId: "dhan-dp-charges", scope: "charge", key: "INE669E01016", asOf: "2026-08-11", figuresJson: JSON.stringify({ qty: 100, charges: 15.5 }) }),
    // A THIRD fee, in the previous financial year. It must land on its own FY
    // line: the year comes from the file's own `asOf`, never from today.
    ref({ sourceId: "dhan-dp-charges", scope: "charge", key: "INE213A01029", asOf: "2025-11-05", figuresJson: JSON.stringify({ qty: 100, charges: 45 }) }),
    // A contract note for 2026-08-11 — the day of the INTRADAY position, so
    // the book's charges for that date are exactly one position's.
    ref({ sourceId: "dhan-contract-note", scope: "charge", key: "brokerage", asOf: "2026-08-11", figuresJson: JSON.stringify({ amount: 40 }) }),
    ref({ sourceId: "dhan-contract-note", scope: "charge", key: "stt", asOf: "2026-08-11", figuresJson: JSON.stringify({ amount: 30 }) }),
    ref({ sourceId: "dhan-contract-note", scope: "charge", key: "gst", asOf: "2026-08-11", figuresJson: JSON.stringify({ amount: 7.8 }) }),
    // Angel One's four ledger tables. `dp` and `pledge` have a column in the
    // book; `cuspa` and `interest` have none.
    ref({ broker: "angelone", sourceId: "angelone-ledger", scope: "charge", key: "dp", fy: "2026-27", asOf: "2026-07-20", figuresJson: JSON.stringify({ amount: 30 }) }),
    ref({ broker: "angelone", sourceId: "angelone-ledger", scope: "charge", key: "pledge", fy: "2026-27", asOf: "2026-07-21", figuresJson: JSON.stringify({ amount: 5 }) }),
    ref({ broker: "angelone", sourceId: "angelone-ledger", scope: "charge", key: "cuspa", fy: "2026-27", asOf: "2026-07-22", figuresJson: JSON.stringify({ amount: 118 }) }),
    ref({ broker: "angelone", sourceId: "angelone-ledger", scope: "charge", key: "interest", fy: "2026-27", asOf: "2026-07-23", figuresJson: JSON.stringify({ amount: 412.6 }) }),
  ]).run();
}

beforeAll(async () => {
  t = await openTempDb("reconcharges", { seed: true });
  refq = await import("@/lib/queries/reference");
  seed();
});

afterAll(() => t?.cleanup());

describe("Charges the broker states — the read side of scope: \"charge\"", () => {
  const charges = () => refq.reconcile(ACCOUNT).charges;

  it("compares a DP fee per FINANCIAL YEAR against the book's own dp_charges on trades sold that year", () => {
    const dp = charges().filter((c) => c.kind === "dp");
    // Two years, each from its OWN file dates — never from today.
    expect(dp.map((c) => c.key)).toEqual(["2025-26", "2026-27"]);

    const [prev, cur] = dp;
    // FY 2026-27 — the file: ₹13.50 + ₹15.50. The book: ₹13.50 + ₹13.50 on the
    // two sales of that year; the FY 25-26 sale's ₹20 is not in this line.
    expect(cur.stated.charges).toBe(29);
    expect(cur.vyuha!.charges).toBe(27);
    expect(cur.delta!.charges).toBe(2);
    // The AIS tolerance is the GREATER of ₹10 and 0.5%, so ₹2 is inside it.
    expect(cur.matched).toBe(true);
    expect(cur.broker).toBe("dhan");

    // FY 2025-26 — ₹45 stated against the book's ₹20, and ₹25 is outside it.
    expect(prev.stated.charges).toBe(45);
    expect(prev.vyuha!.charges).toBe(20);
    expect(prev.delta!.charges).toBe(25);
    expect(prev.matched).toBe(false);
  });

  it("compares a contract note's stated charges against the book's charges for that DAY", () => {
    const note = charges().find((c) => c.kind === "note")!;
    expect(note.key).toBe("2026-08-11");
    expect(note.stated).toEqual({ brokerage: 40, stt: 30, gst: 7.8, total: 77.8 });
    // The IDEA position is intraday — bought and sold on 2026-08-11 — so the
    // day's book charges are exactly that one position's.
    expect(note.vyuha).toEqual({ brokerage: 40, stt: 30, gst: 7.8, total: 77.8 });
    expect(note.delta).toEqual({ brokerage: 0, stt: 0, gst: 0, total: 0 });
    expect(note.matched).toBe(true);
    expect(note.note).toBe("1 position in your book touches this date.");
  });

  it("says when a day's positions carry charges the note's own day does not state", () => {
    // 2026-07-20 is the SELL day of a position bought on 2026-07-02: its
    // charges are the whole position's, both legs. The line says so rather
    // than reporting that arithmetic as a disagreement.
    t.db.insert(t.schema.brokerReference).values({
      accountId: ACCOUNT, broker: "dhan", sourceId: "dhan-contract-note", scope: "charge",
      key: "brokerage", isin: null, symbol: null, fy: null, asOf: "2026-07-20",
      figuresJson: JSON.stringify({ amount: 10 }), note: null, importBatchId: null,
    }).run();
    const line = charges().find((c) => c.kind === "note" && c.key === "2026-07-20")!;
    expect(line.stated).toEqual({ brokerage: 10, total: 10 });
    expect(line.vyuha).toEqual({ brokerage: 20, total: 20 });
    expect(line.delta).toEqual({ brokerage: -10, total: -10 });
    expect(line.note).toMatch(/^The note states ONE day's charges; 1 of the 1 position/);
  });

  it("gives a ledger charge with no column in the book NO Vyuha side and NO delta", () => {
    const ledger = charges().filter((c) => c.kind === "ledger");
    const byType = Object.fromEntries(ledger.map((c) => [c.key.split("|")[1], c]));

    // dp and pledge DO have a column, and are compared.
    expect(byType.dp.stated.amount).toBe(30);
    expect(byType.dp.vyuha!.amount).toBe(27);
    expect(byType.dp.delta!.amount).toBe(3);
    expect(byType.pledge.stated.amount).toBe(5);
    expect(byType.pledge.vyuha!.amount).toBe(5);
    expect(byType.pledge.matched).toBe(true);

    // cuspa and interest do NOT. A zero on the Vyuha side would report the
    // whole of the broker's fee as a gap the journal disputes; there is no
    // dispute, there is nothing to compare.
    for (const type of ["cuspa", "interest"]) {
      expect(byType[type].vyuha, `${type} has no counterpart column`).toBeNull();
      expect(byType[type].delta).toBeNull();
      expect(byType[type].matched).toBeNull();
      expect(byType[type].note).toMatch(/^Stated by the broker - no Vyuha counterpart/);
    }
    expect(byType.cuspa.stated.amount).toBe(118);
    expect(byType.interest.stated.amount).toBe(412.6);
  });

  /**
   * "Broker higher" is a CLAIM ABOUT A SIGN, not a synonym for unmatched.
   * `chargeStatus` read only `matched`, so any disagreement printed "Broker
   * higher" — including a note that states LESS than the book, on a screen
   * whose own delta column said a negative number beside it. `lineStatus` has
   * always read the sign; this reads the same sign off the field its own kind
   * is compared on.
   */
  it("says which side is higher, and never the broker when the broker states less", () => {
    const high = charges().find((c) => c.kind === "dp" && c.key === "2025-26")!;
    expect(high.delta!.charges).toBeGreaterThan(0);
    expect(chargeStatus(high)).toBe("broker_higher");

    // A note for the BUY day of the DYCL position, stating a fraction of the
    // brokerage the book holds for that day.
    t.db.insert(t.schema.brokerReference).values({
      accountId: ACCOUNT, broker: "dhan", sourceId: "dhan-contract-note", scope: "charge",
      key: "brokerage", isin: null, symbol: null, fy: null, asOf: "2026-07-02",
      figuresJson: JSON.stringify({ amount: 1 }), note: null, importBatchId: null,
    }).run();
    const low = charges().find((c) => c.kind === "note" && c.key === "2026-07-02")!;
    expect(low.stated.total).toBe(1);
    expect(low.vyuha!.total).toBe(20);
    expect(low.delta!.total).toBe(-19);
    expect(low.matched).toBe(false);
    expect(chargeStatus(low), "the broker stated LESS than the book").toBe("vyuha_higher");

    const none = charges().find((c) => c.key.endsWith("|cuspa|2026-27"))!;
    expect(chargeStatus(none)).toBe("not_compared");
    expect(chargeStatus(charges().find((c) => c.kind === "note" && c.key === "2026-08-11")!)).toBe("matched");
  });

  it("names the broker and the source of every charge line, and invents neither", () => {
    for (const c of charges()) {
      expect(c.broker).toMatch(/^(dhan|angelone)$/);
      expect(["dhan-dp-charges", "dhan-contract-note", "angelone-ledger"]).toContain(c.sourceId);
      expect(c.note.length).toBeGreaterThan(0);
    }
  });
});
