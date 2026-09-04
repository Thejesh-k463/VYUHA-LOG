import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import type { ParsedFile } from "@/lib/import/types";
import type { ReconcileTrade, ReferenceRowRecord } from "@/lib/queries/reference";
import { parseDhanRealisedPnl } from "@/lib/import/parsers/dhan-realised-pnl";

/**
 * v3.9 "Trust the numbers" — the broker's figures at rest, and the two things
 * the commit path does with a source that is not a tradebook.
 *
 * The maths (`reconcileFrom`) is pure and tested without a database; the write
 * path needs one, because what is under test IS the I/O. One temp DB per FILE.
 */

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let refq: typeof import("@/lib/queries/reference");
/** Bound in beforeAll — a STATIC import of lib/queries/* binds lib/db to the
 *  real database before openTempDb() can point it at the temp file. */
let reconcileFrom: typeof import("@/lib/queries/reference")["reconcileFrom"];

const ACCOUNT = 1;

const refRows = () =>
  t.sqlite.prepare(`SELECT id, account_id, broker, source_id, scope, "key", isin, symbol, fy, as_of, figures_json, note, import_batch_id FROM broker_reference ORDER BY id`).all() as Record<string, unknown>[];

const auditRows = () =>
  t.sqlite.prepare("SELECT id, entity, entity_id AS entityId, action, summary, before_json AS beforeJson, after_json AS afterJson FROM audit_log ORDER BY id").all() as Record<string, unknown>[];

function referenceFile(over: Partial<ParsedFile> = {}): ParsedFile {
  return {
    sourceId: "paytm-realised-pnl",
    broker: "paytm",
    format: "reference",
    trades: [],
    warnings: [],
    reference: [
      { scope: "fy", key: "2026-27", isin: null, symbol: null, fy: "2026-27", asOf: null, figures: { grossPnl: 21371252.57, buyValue: 758450957.2, sellValue: 779822209.9 }, note: null },
      { scope: "scrip", key: "INE600Y01019", isin: "INE600Y01019", symbol: "Dynamic Cables Limited", fy: "2026-27", asOf: "2026-07-20", figures: { qty: 300, buyValue: 124830.87, sellValue: 125686.47, grossPnl: 855.6 }, note: null },
    ],
    ...over,
  };
}

beforeAll(async () => {
  t = await openTempDb("brokerref", { seed: true });
  commit = await import("@/lib/import/commit");
  refq = await import("@/lib/queries/reference");
  ({ reconcileFrom } = refq);
});

afterAll(() => t?.cleanup());

describe("a reference-only file commits — the sanctioned exception to \"nothing to import\"", () => {
  it("writes the figures, imports no trades, and says how many landed", () => {
    const result = commit.commitParsedFile(referenceFile(), "paytm-realised.xls", null, ACCOUNT);
    expect(result.added, "a reference source never writes the book").toBe(0);
    expect(result.total).toBe(0);
    expect(result.referenceStored).toBe(2);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^2 reference figures stored/)]));
    expect(refRows()).toHaveLength(2);
  });

  it("stores every figure under the WRITE account, with its source and batch", () => {
    const rows = refRows();
    for (const r of rows) {
      expect(r.account_id).toBe(ACCOUNT);
      expect(r.broker).toBe("paytm");
      expect(r.source_id).toBe("paytm-realised-pnl");
      expect(r.import_batch_id).toBeTypeOf("number");
    }
    const scrip = rows.find((r) => r.scope === "scrip")!;
    expect(scrip.key).toBe("INE600Y01019");
    expect(scrip.as_of).toBe("2026-07-20");
    expect(JSON.parse(scrip.figures_json as string)).toEqual({ qty: 300, buyValue: 124830.87, sellValue: 125686.47, grossPnl: 855.6 });
  });

  it("re-importing the same statement OVERWRITES rather than duplicating", () => {
    const before = refRows();
    const restated = referenceFile();
    restated.reference![0].figures.grossPnl = 21371252.64;
    commit.commitParsedFile(restated, "paytm-realised.xls", null, ACCOUNT);
    const after = refRows();
    expect(after, "the broker's side of a reconciliation must never read two rows for one figure").toHaveLength(2);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    const fy = after.find((r) => r.scope === "fy")!;
    expect(JSON.parse(fy.figures_json as string).grossPnl).toBe(21371252.64);
  });

  it("records ONE audit entry per reference import, with a symmetric snapshot pair", () => {
    const entries = auditRows().filter((r) => r.entity === "broker_reference");
    expect(entries, "one entry per import — not one per figure").toHaveLength(2); // two commits above
    for (const e of entries) {
      expect(e.action).toBe("create");
      expect(e.beforeJson, "a create's before is the honest \"there was no row\"").toBeNull();
      expect(Object.keys(JSON.parse(e.afterJson as string) as Record<string, unknown>).sort())
        .toEqual(["accountId", "broker", "figures", "importBatchId", "sourceId"]);
      expect(String(e.summary)).toMatch(/2 broker-stated figures from paytm-realised\.xls/);
    }
  });

  it("a file with neither trades nor reference stores nothing and records no audit entry", () => {
    const before = auditRows().filter((r) => r.entity === "broker_reference").length;
    const result = commit.commitParsedFile(
      { sourceId: "pdf", broker: "paytm", format: "pdf", trades: [], warnings: [] },
      "empty.pdf", null, ACCOUNT,
    );
    expect(result.referenceStored).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(auditRows().filter((r) => r.entity === "broker_reference")).toHaveLength(before);
  });
});

describe("enrichment applies facts to trades the book already holds", () => {
  let withTime: number;
  let withoutTime: number;

  beforeAll(() => {
    withoutTime = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "TCS", tradingsymbol: "TCS-EQ",
      buyDate: "2026-07-10", sellDate: "2026-07-11", buyQty: 100, sellQty: 100,
    })).returning({ id: t.schema.trades.id }).get()!.id;
    withTime = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "INFY", tradingsymbol: "INFY-EQ",
      buyDate: "2026-07-10", sellDate: "2026-07-11", buyQty: 50, sellQty: 50,
      entryTime: "09:20:00", exitTime: "14:05:00",
    })).returning({ id: t.schema.trades.id }).get()!.id;
  });

  it("fills entry/exit time only where NULL, promotes equity→option, and counts what matched", () => {
    const tradeCountBefore = t.sqlite.prepare("SELECT count(*) AS n FROM trades").get() as { n: number };
    const result = commit.commitParsedFile({
      sourceId: "dhan-contract-note", broker: "dhan", format: "contract-note", trades: [], warnings: [],
      enrich: [
        // matches `withoutTime` on symbol; both legs
        { symbol: "tcs", date: "2026-07-10", side: "buy", qty: 100, time: "09:16:31" },
        { symbol: "TCS-EQ", date: "2026-07-11", side: "sell", qty: 100, time: "15:12:04", instrumentType: "option" },
        // matches `withTime`, which already has both times from the tradebook
        { symbol: "INFY", date: "2026-07-10", side: "buy", qty: 50, time: "10:00:00" },
        // matches nothing
        { symbol: "WIPRO", date: "2026-07-10", side: "buy", qty: 7, time: "11:00:00" },
      ],
    }, "contract-note.pdf", null, ACCOUNT);

    expect(result.enrichTotal).toBe(4);
    // TWO, not three. The INFY line matched a trade that already held both
    // times, so its patch was EMPTY — counting it as applied made the number
    // report the lookup rather than the write, which is the one thing it was
    // for. Three outcomes, named separately.
    expect(result.enrichApplied).toBe(2);
    expect(result.warnings).toEqual(expect.arrayContaining([
      "4 contract-note fills aggregated into 4 contract-days: applied 2, already had times 1, unmatched 1.",
    ]));
    expect(result.warnings!.some((w) => /1 contract-day matched no trade/.test(w))).toBe(true);
    expect(result.warnings!.some((w) => /Why: 1× /.test(w)), "the miss says WHY").toBe(true);

    const a = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, withoutTime)).get()!;
    expect(a.entryTime).toBe("09:16:31");
    expect(a.exitTime).toBe("15:12:04");
    expect(a.instrumentType, "a stated derivative beats a defaulted equity").toBe("option");

    const b = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, withTime)).get()!;
    expect(b.entryTime, "a time the tradebook already gave is never overwritten").toBe("09:20:00");
    expect(b.exitTime).toBe("14:05:00");

    const after = t.sqlite.prepare("SELECT count(*) AS n FROM trades").get() as { n: number };
    expect(after.n, "an enrichment must NEVER create a trade").toBe(tradeCountBefore.n);
  });

  it("never demotes an already-classified derivative back to equity", () => {
    const id = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "NIFTY", tradingsymbol: "NIFTY25000CE",
      instrumentType: "option", buyDate: "2026-07-14", buyQty: 75, sellDate: "2026-07-14", sellQty: 75,
    })).returning({ id: t.schema.trades.id }).get()!.id;
    commit.commitParsedFile({
      sourceId: "dhan-contract-note", broker: "dhan", format: "contract-note", trades: [], warnings: [],
      enrich: [{ symbol: "NIFTY", date: "2026-07-14", side: "buy", qty: 75, instrumentType: "future" }],
    }, "cn2.pdf", null, ACCOUNT);
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!.instrumentType).toBe("option");
  });
});

/**
 * The four structural defects that made enrichment match ZERO of 1,161 real
 * fills, each pinned on its own.
 */
describe("what the enrichment is matched ON", () => {
  const note = (enrich: Parameters<typeof commit.commitParsedFile>[0]["enrich"], file = "cn.pdf", broker = "dhan") =>
    commit.commitParsedFile(
      { sourceId: "dhan-contract-note", broker: broker as "dhan", format: "contract-note", trades: [], warnings: [], enrich },
      file, null, ACCOUNT,
    );

  it("aggregates a day's FILLS into the position the book actually holds", () => {
    const id = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "Black Box", tradingsymbol: "Black Box",
      buyDate: "2026-08-03", buyQty: 43, sellDate: "2026-08-04", sellQty: 43,
    })).returning({ id: t.schema.trades.id }).get()!.id;

    // Four fills at four times; NONE of them is 43, which is why a row-for-row
    // (symbol, date, side, qty) lookup could never match a real note.
    const r = note([
      { symbol: "BBOX", isin: "INE676A01027", date: "2026-08-03", side: "buy", qty: 11, time: "10:56:35" },
      { symbol: "BBOX", isin: "INE676A01027", date: "2026-08-03", side: "buy", qty: 19, time: "10:56:35" },
      { symbol: "BBOX", isin: "INE676A01027", date: "2026-08-03", side: "buy", qty: 2, time: "10:56:41" },
      { symbol: "BBOX", isin: "INE676A01027", date: "2026-08-03", side: "buy", qty: 11, time: "11:02:09" },
    ], "cn-agg.pdf");

    expect(r.enrichTotal).toBe(4);
    expect(r.enrichApplied).toBe(1);
    expect(r.warnings).toEqual(expect.arrayContaining([
      "4 contract-note fills aggregated into 1 contract-day: applied 1, already had times 0, unmatched 0.",
    ]));
    // EARLIEST fill, not the last one read.
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!.entryTime).toBe("10:56:35");
  });

  it("resolves an equity through its ISIN when the note's ticker is not the book's name", () => {
    // The note prints `DYCL`; the book prints `Dynamic Cables`. Only the ISIN
    // connects them, and the registered name behind it is what matches.
    const id = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "Dynamic Cables", tradingsymbol: "Dynamic Cables",
      buyDate: "2026-08-05", buyQty: 100, sellDate: "2026-08-05", sellQty: 100,
    })).returning({ id: t.schema.trades.id }).get()!.id;
    note([{ symbol: "DYCL", isin: "INE600Y01019", date: "2026-08-05", side: "sell", qty: 100, time: "14:31:02" }], "cn-isin.pdf");
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!.exitTime).toBe("14:31:02");
  });

  it("addresses a derivative by the BOOK's contract name, so two strikes are two contracts", () => {
    const a = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "NIFTY", tradingsymbol: "OPT NIFTY 21 Apr 2026 24200 CE",
      instrumentType: "option", buyDate: "2026-04-21", buyQty: 75, sellDate: "2026-04-21", sellQty: 75,
    })).returning({ id: t.schema.trades.id }).get()!.id;
    const b = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "NIFTY", tradingsymbol: "OPT NIFTY 21 Apr 2026 24400 CE",
      instrumentType: "option", buyDate: "2026-04-21", buyQty: 75, sellDate: "2026-04-21", sellQty: 75,
    })).returning({ id: t.schema.trades.id }).get()!.id;

    note([
      { symbol: "OPT NIFTY 21 Apr 2026 24400 CE", date: "2026-04-21", side: "buy", qty: 75, time: "09:46:52", instrumentType: "option" },
    ], "cn-strike.pdf");

    const rowA = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, a)).get()!;
    const rowB = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, b)).get()!;
    expect(rowB.entryTime, "the 24400 strike is the one the note names").toBe("09:46:52");
    expect(rowA.entryTime, "the 24200 strike is a different contract and is untouched").toBeNull();
  });

  it("never writes onto ANOTHER broker's position", () => {
    const id = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "zerodha", symbol: "SBIN", tradingsymbol: "SBIN",
      buyDate: "2026-08-06", buyQty: 10, sellDate: "2026-08-06", sellQty: 10,
    })).returning({ id: t.schema.trades.id }).get()!.id;
    const r = note([{ symbol: "SBIN", date: "2026-08-06", side: "buy", qty: 10, time: "09:30:00" }], "cn-broker.pdf");
    expect(r.enrichApplied).toBe(0);
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!.entryTime).toBeNull();
  });

  it("splits a day's fills across two positions by cumulative prefix, and says so", () => {
    const first = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "IDEA", tradingsymbol: "IDEA",
      buyDate: "2026-08-07", buyQty: 30, sellDate: "2026-08-09", sellQty: 30,
    })).returning({ id: t.schema.trades.id }).get()!.id;
    const second = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "IDEA", tradingsymbol: "IDEA",
      buyDate: "2026-08-07", buyQty: 70, sellDate: "2026-08-10", sellQty: 70,
    })).returning({ id: t.schema.trades.id }).get()!.id;

    const r = note([
      { symbol: "IDEA", date: "2026-08-07", side: "buy", qty: 10, time: "09:20:00" },
      { symbol: "IDEA", date: "2026-08-07", side: "buy", qty: 20, time: "09:25:00" },
      { symbol: "IDEA", date: "2026-08-07", side: "buy", qty: 70, time: "11:40:00" },
    ], "cn-prefix.pdf");

    // ONE contract-day, ONE outcome. It used to count one per HIT, so this
    // single day reported "applied 2" beside "aggregated into 1 contract-day".
    expect(r.enrichApplied).toBe(1);
    expect(r.warnings).toEqual(expect.arrayContaining([
      "3 contract-note fills aggregated into 1 contract-day: applied 1, already had times 0, unmatched 0.",
    ]));
    expect(r.warnings!.some((w) => /CUMULATIVE PREFIX/.test(w)), "an inference says it is one").toBe(true);
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, first)).get()!.entryTime).toBe("09:20:00");
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, second)).get()!.entryTime).toBe("11:40:00");
  });

  it("claims a trade's leg once — two identical contract-days cannot both take it", () => {
    const only = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "ONGC", tradingsymbol: "ONGC",
      buyDate: "2026-08-11", buyQty: 5, sellDate: "2026-08-12", sellQty: 5,
    })).returning({ id: t.schema.trades.id }).get()!.id;
    // Two DIFFERENT identities that both resolve to the same book row.
    const r = note([
      { symbol: "ONGC", date: "2026-08-11", side: "buy", qty: 5, time: "10:00:00" },
      { symbol: "ONGC-EQ", date: "2026-08-11", side: "buy", qty: 5, time: "12:00:00" },
    ], "cn-claim.pdf");
    expect(r.enrichApplied).toBe(1);
    expect(r.warnings!.some((w) => /already claimed by an earlier line/.test(w))).toBe(true);
    // WHICH one wins is fixed by the group key order (`ONGC-EQ` sorts before
    // `ONGC|`), not by insertion order — the same file always resolves the
    // same way, which is the property that matters.
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, only)).get()!.entryTime).toBe("12:00:00");
  });

  /**
   * A STATED ISIN DISQUALIFIES. Two ISINs that disagree are two securities,
   * and no name rule may outvote that.
   *
   * `Tata Motors / INE155A01022` in the book and `INE155A01029` (the DVR — a
   * different, separately-listed security) on the note used to fall through to
   * the name rule, where `TATAMOTORS` is a four-character-plus prefix of
   * `TATAMOTORSDVR`. The note's fill times were then written onto the wrong
   * instrument, silently and permanently.
   */
  it("refuses a match when both sides state an ISIN and the ISINs disagree", () => {
    const id = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "Tata Motors", tradingsymbol: "TATAMOTORS",
      isin: "INE155A01022", buyDate: "2026-08-15", buyQty: 50, sellDate: "2026-08-16", sellQty: 50,
    })).returning({ id: t.schema.trades.id }).get()!.id;

    const r = note([
      { symbol: "TATAMOTORSDVR", isin: "INE155A01029", date: "2026-08-15", side: "buy", qty: 50, time: "10:10:10" },
    ], "cn-dvr.pdf");

    expect(r.enrichApplied).toBe(0);
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!.entryTime).toBeNull();
    expect(r.warnings!.some((w) => /carries this security's name or ISIN/.test(w))).toBe(true);
  });

  /**
   * A PREFIX IS A GUESS, and a guess that competes is no evidence at all.
   * `HDFC` is a four-character prefix of both `HDFCBANK` and `HDFCLIFE`.
   */
  it("refuses a prefix match when more than one candidate answers to the prefix", () => {
    const bank = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "HDFCBANK", tradingsymbol: "HDFCBANK",
      buyDate: "2026-08-17", buyQty: 20, sellDate: "2026-08-18", sellQty: 20,
    })).returning({ id: t.schema.trades.id }).get()!.id;
    const life = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "HDFCLIFE", tradingsymbol: "HDFCLIFE",
      buyDate: "2026-08-17", buyQty: 20, sellDate: "2026-08-19", sellQty: 20,
    })).returning({ id: t.schema.trades.id }).get()!.id;

    const r = note([{ symbol: "HDFC", date: "2026-08-17", side: "buy", qty: 20, time: "11:11:11" }], "cn-hdfc.pdf");

    expect(r.enrichApplied).toBe(0);
    expect(r.warnings!.some((w) => /ambiguous: 2 candidates share this security's name by prefix/.test(w))).toBe(true);
    for (const id of [bank, life]) {
      expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!.entryTime).toBeNull();
    }
  });

  /** An exact normalised name beats a prefix, whatever the row ids say. */
  it("prefers the candidate that matches EXACTLY over one that matches by prefix", () => {
    // Inserted FIRST on purpose: `free.find()` took the lowest id, so the
    // prefix candidate used to win simply for being written first.
    const bank = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "HDFCBANK", tradingsymbol: "HDFCBANK",
      buyDate: "2026-08-20", buyQty: 30, sellDate: "2026-08-21", sellQty: 30,
    })).returning({ id: t.schema.trades.id }).get()!.id;
    const hdfc = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "HDFC", tradingsymbol: "HDFC",
      buyDate: "2026-08-20", buyQty: 30, sellDate: "2026-08-22", sellQty: 30,
    })).returning({ id: t.schema.trades.id }).get()!.id;

    const r = note([{ symbol: "HDFC", date: "2026-08-20", side: "buy", qty: 30, time: "12:12:12" }], "cn-hdfc2.pdf");

    expect(r.enrichApplied).toBe(1);
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, hdfc)).get()!.entryTime).toBe("12:12:12");
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, bank)).get()!.entryTime).toBeNull();
  });

  /**
   * Quantity is the last discriminator the note states. Two positions that
   * agree on security, date, side AND quantity are indistinguishable on
   * everything the document knows — `free.find()` picked the lower id.
   */
  it("refuses when two candidates agree on security, date, side and quantity", () => {
    const a = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "Adani Ports", tradingsymbol: "ADANIPORTS",
      isin: "INE742F01042", buyDate: "2026-08-24", buyQty: 40, sellDate: "2026-08-25", sellQty: 40,
    })).returning({ id: t.schema.trades.id }).get()!.id;
    const b = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "Adani Ports", tradingsymbol: "ADANIPORTS",
      isin: "INE742F01042", buyDate: "2026-08-24", buyQty: 40, sellDate: "2026-08-26", sellQty: 40,
    })).returning({ id: t.schema.trades.id }).get()!.id;

    const r = note([
      { symbol: "ADANIPORTS", isin: "INE742F01042", date: "2026-08-24", side: "buy", qty: 40, time: "13:13:13" },
    ], "cn-adani.pdf");

    expect(r.enrichApplied).toBe(0);
    expect(r.warnings!.some((w) => /ambiguous: 2 candidates match this security, date, side and quantity/.test(w))).toBe(true);
    for (const id of [a, b]) {
      expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!.entryTime).toBeNull();
    }
  });

  /**
   * THE COUNTING INVARIANT: applied + alreadyHad + unmatched === contract-days,
   * always. A day that split across positions used to add one to `applied` per
   * HIT, so the sentence contradicted itself in its own second half.
   */
  it("partitions every contract-day into exactly one of the three outcomes", () => {
    t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "COUNTCO", tradingsymbol: "COUNTCO",
      buyDate: "2026-08-27", buyQty: 15, sellDate: "2026-08-28", sellQty: 15,
    })).run();
    t.db.insert(t.schema.trades).values(tradeRow({
      accountId: ACCOUNT, broker: "dhan", symbol: "COUNTCO", tradingsymbol: "COUNTCO",
      buyDate: "2026-08-27", buyQty: 25, sellDate: "2026-08-29", sellQty: 25,
    })).run();

    const r = note([
      // Day one: splits across the two positions, and leaves a tail of 7.
      { symbol: "COUNTCO", date: "2026-08-27", side: "buy", qty: 15, time: "09:15:00" },
      { symbol: "COUNTCO", date: "2026-08-27", side: "buy", qty: 25, time: "09:45:00" },
      { symbol: "COUNTCO", date: "2026-08-27", side: "buy", qty: 7, time: "10:45:00" },
      // Day two: matches nothing at all.
      { symbol: "NOSUCHCO", date: "2026-08-27", side: "buy", qty: 9, time: "10:00:00" },
    ], "cn-count.pdf");

    const line = r.warnings!.find((w) => /aggregated into/.test(w))!;
    const m = /aggregated into (\d+) contract-days?: applied (\d+), already had times (\d+), unmatched (\d+)/.exec(line)!;
    expect(m).not.toBeNull();
    expect(Number(m[2]) + Number(m[3]) + Number(m[4])).toBe(Number(m[1]));
    expect([Number(m[1]), Number(m[2]), Number(m[4])]).toEqual([2, 1, 1]);
    // The leftover fills are reported. They used to call miss() without
    // touching a counter, so the reason lived in a list the warning only
    // prints when `unmatched > 0` — on a file where every day matched, the
    // dropped fills were recorded nowhere at all.
    expect(r.warnings!.some((w) => /still had fills left over/.test(w))).toBe(true);
  });
});

describe("getReferenceRows and reconcile read one account", () => {
  it("filters by broker, scope and FY, and decodes the figures", () => {
    expect(refq.getReferenceRows(ACCOUNT, { scope: "fy" }).map((r) => r.key)).toEqual(["2026-27"]);
    expect(refq.getReferenceRows(ACCOUNT, { broker: "zerodha" })).toEqual([]);
    expect(refq.getReferenceRows(ACCOUNT, { fy: "2026-27" }).length).toBe(2);
    const scrip = refq.getReferenceRows(ACCOUNT, { scope: "scrip" })[0];
    expect(scrip.figures.qty).toBe(300);
    expect(refq.getReferenceBrokers(ACCOUNT)).toEqual(["paytm"]);
  });

  it("never reads another account's broker figures", () => {
    t.db.insert(t.schema.accounts).values({ id: 2, name: "Swing", isDefault: false }).onConflictDoNothing().run();
    commit.commitParsedFile(referenceFile({ broker: "dhan", sourceId: "dhan-realised-pnl" }), "dhan.xls", null, 2);
    expect(refq.getReferenceRows(ACCOUNT).every((r) => r.accountId === ACCOUNT)).toBe(true);
    expect(refq.getReferenceRows(2).every((r) => r.accountId === 2)).toBe(true);
    expect(refq.getReferenceRows(0).length, "the All-accounts view aggregates").toBe(
      refq.getReferenceRows(ACCOUNT).length + refq.getReferenceRows(2).length,
    );
  });

  it("returns a line per FY and per scrip the broker states", () => {
    const rec = refq.reconcile(ACCOUNT);
    expect(rec.fy.map((l) => l.key)).toEqual(["2026-27"]);
    expect(rec.scrip.map((l) => l.key)).toEqual(["INE600Y01019"]);
    expect(rec.fy[0].stated.grossPnl).toBe(21371252.64);
    expect(rec.fy[0].broker).toBe("paytm");
  });
});

describe("reconcileFrom — the reasons are computed facts, never explanations", () => {
  const ref = (over: Partial<ReferenceRowRecord>): ReferenceRowRecord => ({
    id: 1, accountId: 1, broker: "paytm", sourceId: "paytm-realised-pnl", scope: "fy",
    key: "2026-27", isin: null, symbol: null, fy: "2026-27", asOf: null, figures: {},
    note: null, importBatchId: null, createdAt: "2026-09-04", ...over,
  });
  const trade = (over: Partial<ReconcileTrade>): ReconcileTrade => ({
    isin: "INE600Y01019", symbol: "DYCL", tradingsymbol: "DYCL", segment: "eq_delivery",
    sellDate: "2026-07-20", buyQty: 300, sellQty: 300, buyValue: 124830.87, sellValue: 125686.47,
    grossPnl: 855.6, netPnl: 800, chargesTotal: 55.6, isOpen: false, acquisition: null, ...over,
  });

  /**
   * A TICKER IS NOT AN IDENTITY. `scripKeysOf` indexes the book under its
   * ISIN *and* its symbol so that a symbol-keyed reference row (Angel One's
   * P&L statement states `isin: null` on every scrip line) can join at all —
   * but when two securities in the book answer to one ticker, that symbol key
   * held the SUM of both, and the symbol-keyed row read the other company's
   * P&L as its own delta.
   */
  it("states no Vyuha figure for a symbol-keyed row whose ticker covers two securities", () => {
    const rec = reconcileFrom(
      [ref({ scope: "scrip", key: "TWINCO", isin: null, symbol: "TWINCO", figures: { grossPnl: 100 } })],
      [
        trade({ isin: "INE111A01011", symbol: "TWINCO", tradingsymbol: "TWINCO", grossPnl: 100 }),
        trade({ isin: "INE222B01022", symbol: "TWINCO", tradingsymbol: "TWINCO", grossPnl: 200 }),
      ],
    );
    const line = rec.scrip.find((l) => l.key === "TWINCO")!;
    // NOT 300. The sum of two companies is not this row's figure at any price.
    expect(line.vyuha.grossPnl).toBeUndefined();
    expect(line.delta).toEqual({});
    expect(line.matched).toBe(false);
    expect(line.reasons.map((r) => r.code)).toEqual(["ambiguous_symbol"]);
    expect(line.reasons[0].detail).toMatch(/^ambiguous symbol: 2 securities in your book share this ticker/);
  });

  it("still joins a symbol-keyed row when the ticker names exactly one security", () => {
    const rec = reconcileFrom(
      [ref({ scope: "scrip", key: "DYCL", isin: null, symbol: "DYCL", figures: { grossPnl: 855.6 } })],
      [trade({})],
    );
    expect(rec.scrip[0].vyuha.grossPnl).toBe(855.6);
    expect(rec.scrip[0].matched).toBe(true);
  });

  it("matches within the AIS tolerance and reports the delta either way", () => {
    const ok = reconcileFrom([ref({ figures: { grossPnl: 855.6 } })], [trade({})]);
    expect(ok.fy[0].matched).toBe(true);
    expect(ok.fy[0].delta.grossPnl).toBe(0);
    const off = reconcileFrom([ref({ figures: { grossPnl: 2000 } })], [trade({})]);
    expect(off.fy[0].matched).toBe(false);
    expect(off.fy[0].delta.grossPnl).toBe(1144.4);
  });

  it("names unpriced sales — a count and the sell value, not a guess at the cost", () => {
    const r = reconcileFrom([ref({ figures: { grossPnl: 5000 } })], [trade({ acquisition: "unknown" })]);
    const reason = r.fy[0].reasons.find((x) => x.code === "unpriced_sales")!;
    expect(reason).toBeTruthy();
    expect(reason.count).toBe(1);
    expect(reason.amount).toBe(125686.47);
  });

  it("names the charges the file omits, and stays silent when the file states them", () => {
    const silent = reconcileFrom([ref({ figures: { grossPnl: 855.6, totalCharges: 55.6 } })], [trade({})]);
    expect(silent.fy[0].reasons.some((x) => x.code === "charges_omitted")).toBe(false);
    const named = reconcileFrom([ref({ figures: { grossPnl: 855.6 } })], [trade({})]);
    const reason = named.fy[0].reasons.find((x) => x.code === "charges_omitted")!;
    expect(reason.amount).toBe(55.6);
  });

  it("names open lots the broker has already realised", () => {
    const r = reconcileFrom(
      [ref({ scope: "scrip", key: "INE600Y01019", isin: "INE600Y01019", symbol: "DYCL", figures: { qty: 300, grossPnl: 855.6 } })],
      [trade({}), trade({ isOpen: true, buyQty: 100, sellQty: 0 })],
    );
    const reason = r.scrip[0].reasons.find((x) => x.code === "open_lots")!;
    expect(reason.count).toBe(100);
  });

  it("names a product difference only when the two genuinely disagree", () => {
    const refs = [
      ref({ scope: "scrip", key: "INE600Y01019", isin: "INE600Y01019", symbol: "DYCL", figures: { qty: 300, grossPnl: 855.6 } }),
      ref({ id: 2, scope: "segment", key: "fno", figures: { grossPnl: -50987.04 } }),
    ];
    const disagree = reconcileFrom(refs, [trade({ segment: "eq_delivery" })]);
    expect(disagree.scrip[0].reasons.some((x) => x.code === "product_difference")).toBe(true);
    // `stock_option`, from lib/domain/constants.ts#SEGMENTS. This line read
    // "opt_stock" — a segment name that has never existed — which is the same
    // invented vocabulary `FAMILY_OF` was written over (v3.9 fix, 2026-09-04).
    const agree = reconcileFrom(refs, [trade({ segment: "stock_option" })]);
    expect(agree.scrip[0].reasons.some((x) => x.code === "product_difference")).toBe(false);
  });

  it("a bucket Vyuha has no trades for still appears, with zeroes rather than a hidden row", () => {
    const r = reconcileFrom([ref({ key: "2024-25", fy: "2024-25", figures: { grossPnl: 1000 } })], []);
    expect(r.fy).toHaveLength(1);
    expect(r.fy[0].vyuha.grossPnl).toBe(0);
    expect(r.fy[0].delta.grossPnl).toBe(1000);
    expect(r.fy[0].matched).toBe(false);
  });

  it("buckets a closed trade by its SELL date, the way the tax pack does", () => {
    const refs = [ref({ key: "2025-26", fy: "2025-26", figures: { grossPnl: 100 } }), ref({ id: 2, key: "2026-27", figures: { grossPnl: 855.6 } })];
    const r = reconcileFrom(refs, [trade({ sellDate: "2026-04-02", buyDate: undefined } as Partial<ReconcileTrade>)]);
    expect(r.fy.find((l) => l.key === "2026-27")!.vyuha.grossPnl).toBe(855.6);
    expect(r.fy.find((l) => l.key === "2025-26")!.vyuha.grossPnl).toBe(0);
  });
});

describe("Dhan's Realised P&L feeds the same store", () => {
  const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");
  const FILE = "dhan-realised-pnl-2026-04-01_2026-09-03-a2.xls";

  it("emits one segment reference row per segment, from the SAME figures as `reported`", () => {
    if (!fs.existsSync(path.join(DIR, FILE))) return;
    const parsed = parseDhanRealisedPnl({ filename: FILE, buffer: fs.readFileSync(path.join(DIR, FILE)) });
    const refs = parsed.reference!;
    expect(refs.every((r) => r.scope === "segment")).toBe(true);
    expect(refs.map((r) => r.key).sort()).toEqual(["commodity", "currency", "equity", "fno"]);
    const equity = refs.find((r) => r.key === "equity")!;
    // The SAME numbers `reported` carries — not a second arithmetic path.
    expect(equity.figures.grossPnl).toBe(parsed.reported!["equity.grossPnl"]);
    expect(equity.figures.totalCharges).toBe(parsed.reported!["equity.totalCharges"]);
    // No bare (file-wide) key leaks in: that money is the sum of these rows.
    expect(Object.keys(equity.figures)).not.toContain("equity.grossPnl");
  });

  it("files them under no FY, and says so, because the report states no period", () => {
    if (!fs.existsSync(path.join(DIR, FILE))) return;
    const parsed = parseDhanRealisedPnl({ filename: FILE, buffer: fs.readFileSync(path.join(DIR, FILE)) });
    expect(parsed.reference!.every((r) => r.fy == null), "a year the file never stated would be fabricated").toBe(true);
    expect(parsed.warnings.some((w) => /states no period/.test(w))).toBe(true);
  });

  it("referenceFromReported is the fallback for a source that predates the contract", () => {
    const rows = commit.referenceFromReported({ "equity.grossPnl": -101171.29, "equity.totalCharges": 48311.04, grossPnl: -152158.33 });
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe("segment");
    expect(rows[0].key).toBe("equity");
    expect(rows[0].figures, "the bare file-wide total is the SUM of these rows, not a third row").toEqual({ grossPnl: -101171.29, totalCharges: 48311.04 });
    expect(commit.referenceFromReported(undefined)).toEqual([]);
  });
});
