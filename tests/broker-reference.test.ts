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
    expect(result.enrichApplied).toBe(3);
    expect(result.warnings).toEqual(expect.arrayContaining(["Fill times applied to 3 of 4 contract-note lines"]));
    expect(result.warnings!.some((w) => /1 contract-note line matched no trade/.test(w))).toBe(true);

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
    const agree = reconcileFrom(refs, [trade({ segment: "opt_stock" })]);
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
