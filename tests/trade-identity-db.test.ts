import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";

/**
 * v4.5.0 W1 — ONE trade identity, the half that needs a database.
 *
 *   F-L1-7  a file whose rows share a `dedupHash` across two scopes imports
 *           BOTH executions, and re-imports as a pure duplicate. The control —
 *           the same hash in the SAME scope — must still collapse to one row,
 *           because that is what makes the re-key NARROW: every file ever
 *           imported before 4.5.0 has one scope per hash and must hash
 *           byte-for-byte as it did.
 *   F-L1-3  the data fix `dhan-gtr-symbols-v1` puts a stored Dhan report row
 *           under its TICKER and writes `tradingsymbol`, `symbol`, `isin` and
 *           the `gtr-name:` note — and NOTHING else. Every column of the row is
 *           snapshotted before and after and diffed, so "no money moved" is a
 *           fact about all 70-odd columns rather than about the four somebody
 *           remembered to assert.
 *
 * ONE temp database per FILE (AGENTS.md Testing): `lib/db` caches its
 * connection on globalThis, so each case below owns its own account id.
 * Measured locally 2026-09-22: the hook takes ~1.1 s, every `it` under 60 ms.
 */

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let fixes: typeof import("@/lib/db/data-fixes");
let identity: typeof import("@/lib/import/trade-identity");
let dedup: typeof import("@/lib/import/dedup");

const FIX = "dhan-gtr-symbols-v1";

beforeAll(async () => {
  t = await openTempDb("trade-identity", { seed: true });
  commit = await import("@/lib/import/commit");
  fixes = await import("@/lib/db/data-fixes");
  identity = await import("@/lib/import/trade-identity");
  dedup = await import("@/lib/import/dedup");
}, 120_000);
afterAll(() => t?.cleanup());

const newAccount = (id: number, name: string) => t.db.insert(t.schema.accounts).values({ id, name }).run();

const rowsOf = (accountId: number) =>
  t.sqlite.prepare("SELECT * FROM trades WHERE account_id = ? ORDER BY id").all(accountId) as Record<string, unknown>[];

function trade(over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade {
  return {
    broker: "dhan",
    isin: null,
    buyQty: 0,
    avgBuyPrice: 0,
    buyValue: 0,
    sellQty: 0,
    avgSellPrice: 0,
    sellValue: 0,
    closingPrice: null,
    grossPnl: 0,
    unrealisedPnl: 0,
    buyDate: null,
    sellDate: null,
    productHint: "delivery",
    exchangeHint: "NSE",
    sourceFile: null,
    ...over,
  } as NormalizedTrade;
}

/** One round trip of 10 shares, same symbol, same day, same prices. */
const roundTrip = (exchange: "NSE" | "BSE") =>
  trade({
    tradingsymbol: "TCS",
    exchangeHint: exchange,
    buyQty: 10, avgBuyPrice: 3000, buyValue: 30000,
    sellQty: 10, avgSellPrice: 3100, sellValue: 31000,
    grossPnl: 1000,
    buyDate: "2026-08-03", sellDate: "2026-08-03",
  });

const parsedFile = (trades: NormalizedTrade[]): ParsedFile => ({
  sourceId: "dhan-gtr",
  broker: "dhan",
  format: "tradebook",
  trades,
  warnings: [],
});

// ══════════════════ F-L1-7 — one hash, two exchanges, two rows ══════════════

describe("F-L1-7 — an NSE sale and a BSE sale of the same size on the same day", () => {
  const ACC = 910;
  const file = () => parsedFile([roundTrip("NSE"), roundTrip("BSE")]);

  it("the two rows really do share the legacy hash — that IS the defect", () => {
    const [a, b] = file().trades;
    expect(dedup.dedupHash({ ...a!, broker: "dhan" })).toBe(dedup.dedupHash({ ...b!, broker: "dhan" }));
  });

  it("the preview counts TWO new rows and no duplicate", () => {
    newAccount(ACC, "w1-two-scopes");
    const pre = commit.previewParsedFile(file(), null, ACC, "gtr.csv");
    expect(pre.summary.total).toBe(2);
    expect(pre.summary.dupCount).toBe(0);
    expect(pre.summary.newCount).toBe(2);
    expect(pre.rows.map((r) => r.exchange).sort()).toEqual(["BSE", "NSE"]);
  });

  it("the commit adds both — the second no longer dies as a duplicate of the first", () => {
    const res = commit.commitParsedFile(file(), "gtr.csv", null, ACC);
    expect([res.added, res.skipped]).toEqual([2, 0]);
    const rows = rowsOf(ACC);
    expect(rows.map((r) => r.exchange).sort()).toEqual(["BSE", "NSE"]);
    // Both money rows survive whole — integer paise in the DB (invariant 1).
    expect(rows.map((r) => r.sell_value_paise)).toEqual([3100000, 3100000]);
  });

  it("the derived hash is the documented one, and the FIRST scope by sort keeps the legacy hash", () => {
    const legacy = dedup.dedupHash({ ...roundTrip("NSE"), broker: "dhan" });
    const stored = Object.fromEntries(rowsOf(ACC).map((r) => [r.exchange as string, r.dedup_hash as string]));
    // "eq_delivery|BSE" sorts before "eq_delivery|NSE".
    expect(stored.BSE).toBe(legacy);
    expect(stored.NSE).toBe(identity.scopedHash(legacy, "eq_delivery|NSE"));
    expect(stored.NSE).toBe(createHash("sha1").update(`${legacy}|eq_delivery|NSE`).digest("hex"));
  });

  it("re-importing the SAME file adds nothing — the rule is a pure function of the file", () => {
    const pre = commit.previewParsedFile(file(), null, ACC, "gtr.csv");
    expect([pre.summary.dupCount, pre.summary.newCount]).toEqual([2, 0]);
    const res = commit.commitParsedFile(file(), "gtr-again.csv", null, ACC);
    expect([res.added, res.skipped]).toEqual([0, 2]);
    expect(rowsOf(ACC)).toHaveLength(2);
  });
});

/**
 * The case that tells the PREVIEW's re-key apart from the commit's: a book that
 * already holds the BSE row and nothing else. The BSE row keeps the legacy hash
 * and so reads as a duplicate; the NSE row takes the derived one and is new.
 * Without the preview's own `applyScopedIdentity` both rows would hash to the
 * legacy value and the dialog would promise "2 duplicates, nothing to add"
 * while the commit added a row — the preview/commit drift W1 exists to close.
 */
describe("F-L1-7 — the preview agrees with the commit on a partially-held file", () => {
  const ACC = 912;
  const both = () => parsedFile([roundTrip("NSE"), roundTrip("BSE")]);

  it("the BSE sale lands on its own, under the legacy hash", () => {
    newAccount(ACC, "w1-partial");
    expect(commit.commitParsedFile(parsedFile([roundTrip("BSE")]), "bse.csv", null, ACC).added).toBe(1);
    expect(rowsOf(ACC)[0]!.dedup_hash).toBe(dedup.dedupHash({ ...roundTrip("BSE"), broker: "dhan" }));
  });

  it("the preview says one duplicate and one new row — and the commit does exactly that", () => {
    const pre = commit.previewParsedFile(both(), null, ACC, "gtr.csv");
    expect([pre.summary.dupCount, pre.summary.newCount]).toEqual([1, 1]);
    const res = commit.commitParsedFile(both(), "gtr.csv", null, ACC);
    expect([res.added, res.skipped]).toEqual([1, 1]);
    expect(rowsOf(ACC).map((r) => r.exchange).sort()).toEqual(["BSE", "NSE"]);
  });
});

describe("CONTROL — the same hash in the SAME scope is still ONE execution", () => {
  const ACC = 911;
  const file = () => parsedFile([roundTrip("NSE"), roundTrip("NSE")]);

  it("the commit adds 1 and skips 1, and the stored hash is the LEGACY one", () => {
    newAccount(ACC, "w1-one-scope");
    const res = commit.commitParsedFile(file(), "gtr.csv", null, ACC);
    expect([res.added, res.skipped]).toEqual([1, 1]);
    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedup_hash).toBe(dedup.dedupHash({ ...roundTrip("NSE"), broker: "dhan" }));
  });
});

// ═══════════ F-L1-3 — the data fix dhan-gtr-symbols-v1 on stored rows ═══════

describe("data fix dhan-gtr-symbols-v1", () => {
  const ACC = 920;
  /** id → the whole row as it stood before the fix ran. */
  const before = new Map<number, Record<string, unknown>>();
  const ids: Record<string, number> = {};
  let result: { name: string; applied: boolean; rekeyed: number; skippedCollisions: number } | undefined;

  const rowById = (id: number) =>
    t.sqlite.prepare("SELECT * FROM trades WHERE id = ?").get(id) as Record<string, unknown>;

  /** Which columns of a row changed, by name. */
  const diffOf = (id: number) => {
    const now = rowById(id);
    const was = before.get(id)!;
    return Object.keys(now).filter((k) => now[k] !== was[k]).sort();
  };

  const legacy = (label: string, over: Record<string, number | string | null> = {}) => {
    const base = {
      buyQty: 100, avgBuyPrice: 500.78, buyValue: 50078, sellQty: 100, avgSellPrice: 498.14, sellValue: 49814,
      buyDate: "2026-07-21", sellDate: "2026-07-21", ...over,
    } as Record<string, number | string | null>;
    return createHash("sha1")
      .update(["dhan", label.trim().toUpperCase(), base.buyQty, base.avgBuyPrice, base.buyValue,
        base.sellQty, base.avgSellPrice, base.sellValue, base.buyDate ?? "", base.sellDate ?? ""].join("|"))
      .digest("hex");
  };

  beforeAll(() => {
    newAccount(ACC, "w1-gtr-fix");
    // A Dhan batch, and a NON-Dhan batch beside it in the same account.
    const batch = (broker: string, fileName: string) =>
      t.db.insert(t.schema.importBatches).values({ accountId: ACC, broker, fileName })
        .returning({ id: t.schema.importBatches.id }).get()!.id;
    const dhanBatch = batch("dhan", "Dhan_GlobalTransction_Report.csv");
    const zerodhaBatch = batch("zerodha", "tradebook.xlsx");

    const ins = (key: string, over: Record<string, unknown>) => {
      ids[key] = t.db.insert(t.schema.trades)
        .values(tradeRow({ accountId: ACC, ...over }))
        .returning({ id: t.schema.trades.id }).get()!.id;
    };
    const money = {
      buyQty: 100, avgBuyPrice: 500.78, buyValue: 50078, sellQty: 100, avgSellPrice: 498.14, sellValue: 49814,
      buyDate: "2026-07-21", sellDate: "2026-07-21", grossPnl: -264.5, netPnl: -280.12, charges: 15.62,
    };
    // 1. The class the fix exists for: a batched Dhan row labelled by company name.
    ins("named", {
      importBatchId: dhanBatch, broker: "dhan", tradingsymbol: "Aarti Industries", symbol: "Aarti Industries",
      isin: null, dedupHash: legacy("Aarti Industries"), ...money,
    });
    // 2. The account-#3 class: Dhan, a company name, and NO import batch at all.
    ins("batchless", {
      importBatchId: null, broker: "dhan", tradingsymbol: "Anant Raj", symbol: "Anant Raj",
      isin: null, dedupHash: legacy("Anant Raj"), ...money,
    });
    // 3. A frozen identity: the row answers to another execution's hash.
    ins("frozen", {
      importBatchId: dhanBatch, broker: "dhan", tradingsymbol: "Avanti Feeds", symbol: "Avanti Feeds",
      isin: null, dedupHash: legacy("Avanti Feeds"), importNotes: `dedup-alias:${legacy("Avanti Feeds", { sellQty: 50 })}`,
      ...money,
    });
    // 4. Auto-closed: frozen for the same reason, by a different note.
    ins("autoclosed", {
      importBatchId: dhanBatch, broker: "dhan", tradingsymbol: "Gabriel India", symbol: "Gabriel India",
      isin: null, dedupHash: legacy("Gabriel India"),
      importNotes: "Closed automatically against an open position this account already held (FIFO, oldest lot first).",
      ...money,
    });
    // 5. Already a TICKER — no lower case anywhere, so the fix never sees it
    //    even though "Cupid" is a company name that resolves.
    ins("ticker", {
      importBatchId: dhanBatch, broker: "dhan", tradingsymbol: "CUPID", symbol: "CUPID",
      isin: null, dedupHash: legacy("CUPID"), ...money,
    });
    // 6. A company name in a NON-Dhan batch.
    ins("otherBroker", {
      importBatchId: zerodhaBatch, broker: "zerodha", tradingsymbol: "State Bank of India", symbol: "State Bank of India",
      isin: null, dedupHash: legacy("State Bank of India"), ...money,
    });
    // 7. A name that resolves to NOTHING — abbreviated, and counted as such.
    ins("unresolved", {
      importBatchId: dhanBatch, broker: "dhan", tradingsymbol: "Gujarat Narmada Valley Fert & Chem",
      symbol: "Gujarat Narmada Valley Fert & Chem", isin: null,
      dedupHash: legacy("Gujarat Narmada Valley Fert & Chem"), ...money,
    });
    // 8. Unknown import_notes segments must survive the append.
    ins("withNotes", {
      importBatchId: dhanBatch, broker: "dhan", tradingsymbol: "Savita Oil Technologies", symbol: "Savita Oil Technologies",
      isin: null, dedupHash: legacy("Savita Oil Technologies"),
      importNotes: "Bill mixed intraday and delivery; product derived from stamp duty. | MTF interest estimated",
      ...money,
    });

    // 9. A row that ALREADY records the label it is keyed on. Its identity is
    //    settled; re-resolving it from whatever its tradingsymbol says today
    //    would regroup a row whose key is not its tradingsymbol at all. The
    //    fix's own comment calls this the idempotency guard — every restore
    //    forgets the marker and runs it again.
    ins("alreadyLabelled", {
      importBatchId: dhanBatch, broker: "dhan", tradingsymbol: "Reliance Industries", symbol: "Reliance Industries",
      isin: null, dedupHash: legacy("Reliance Industries"),
      importNotes: "gtr-name:Reliance Industries", ...money,
    });

    for (const id of Object.values(ids)) before.set(id, { ...rowById(id) });
    // The marker is already there (openTempDb runs the fixes); take it away so
    // the fix runs against the book seeded above.
    t.sqlite.prepare("DELETE FROM data_fixes WHERE name = ?").run(FIX);
    result = fixes.runDataFixes(t.sqlite).find((r) => r.name === FIX);
  });

  it("re-keys the two batched Dhan rows it can resolve and counts the one it cannot", () => {
    // "Aarti Industries" and "Savita Oil Technologies"; the abbreviated
    // "Gujarat Narmada Valley Fert & Chem" resolves to nothing and is counted,
    // not guessed at (invariant 6).
    //
    // `skippedCollisions` is ONE because `GLOB '*[a-z]*'` keeps every row that
    // is already a ticker out of the scan entirely — drop it and every batched
    // Dhan TCS row in this database (the F-L1-7 accounts above included) joins
    // the scan, resolves to nothing, and is reported to the user as a scrip
    // name the fix could not read.
    expect(result).toMatchObject({ name: FIX, applied: true, rekeyed: 2, skippedCollisions: 1 });
  });

  it("the re-keyed row moves tradingsymbol, symbol, isin and import_notes — and NOTHING else", () => {
    const id = ids.named!;
    expect(diffOf(id)).toEqual(["import_notes", "isin", "symbol", "tradingsymbol"]);
    const row = rowById(id);
    expect(row.tradingsymbol).toBe("AARTIIND");
    expect(row.symbol).toBe("AARTIIND");
    expect(row.isin).toBe("INE769A01020");
    expect(identity.dedupLabelFromNotes(row.import_notes as string)).toBe("Aarti Industries");
  });

  it("its identity, its money and its net P&L are exactly what they were", () => {
    const id = ids.named!;
    const was = before.get(id)!, now = rowById(id);
    expect(now.dedup_hash).toBe(legacy("Aarti Industries"));
    expect(now.dedup_hash).toBe(was.dedup_hash);
    for (const col of ["buy_qty", "avg_buy_price", "buy_value_paise", "sell_qty", "avg_sell_price", "sell_value_paise",
      "gross_pnl_paise", "net_pnl_paise", "buy_date", "sell_date", "segment", "bucket", "exchange", "account_id"]) {
      expect(now[col], `${col} moved`).toBe(was[col]);
    }
  });

  it("a BATCHLESS Dhan row is byte-identical across every column (the account-#3 class)", () => {
    expect(diffOf(ids.batchless!)).toEqual([]);
    expect(rowById(ids.batchless!)).toEqual(before.get(ids.batchless!));
  });

  it.each([
    ["a frozen (dedup-alias) row", "frozen"],
    ["an auto-closed row", "autoclosed"],
    ["a row already keyed on a ticker", "ticker"],
    ["a company name in a non-Dhan batch", "otherBroker"],
    ["a name that resolves to nothing", "unresolved"],
    ["a row that already records the label it is keyed on", "alreadyLabelled"],
  ])("%s is untouched", (_label, key) => {
    expect(diffOf(ids[key]!)).toEqual([]);
    expect(rowById(ids[key]!)).toEqual(before.get(ids[key]!));
  });

  it("keeps the import_notes segments it did not write, in order", () => {
    const id = ids.withNotes!;
    expect(diffOf(id)).toEqual(["import_notes", "isin", "symbol", "tradingsymbol"]);
    expect(rowById(id).import_notes).toBe(
      "Bill mixed intraday and delivery; product derived from stamp duty. | MTF interest estimated | gtr-name:Savita Oil Technologies",
    );
    expect(rowById(id).tradingsymbol).toBe("SOTL");
  });

  it("writes the marker, and a second run re-keys 0 and duplicates no gtr-name: segment", () => {
    expect(t.sqlite.prepare("SELECT name FROM data_fixes WHERE name = ?").get(FIX)).toBeTruthy();
    const snapshot = t.sqlite.prepare("SELECT * FROM trades WHERE account_id = ? ORDER BY id").all(ACC);
    // Force it to run again against rows it has already re-keyed.
    t.sqlite.prepare("DELETE FROM data_fixes WHERE name = ?").run(FIX);
    const again = fixes.runDataFixes(t.sqlite).find((r) => r.name === FIX);
    expect(again).toMatchObject({ applied: true, rekeyed: 0 });
    expect(t.sqlite.prepare("SELECT * FROM trades WHERE account_id = ? ORDER BY id").all(ACC)).toEqual(snapshot);
    const notes = rowById(ids.named!).import_notes as string;
    expect(notes.match(/gtr-name:/g)).toHaveLength(1);
  });

  it("no row moved between books, and the account's net P&L is unchanged", () => {
    const sum = () =>
      (t.sqlite.prepare("SELECT COALESCE(SUM(net_pnl_paise),0) AS s, COUNT(*) AS n FROM trades WHERE account_id = ?")
        .get(ACC) as { s: number; n: number });
    expect(sum().n).toBe(Object.keys(ids).length);
    const wasSum = [...before.values()].reduce((a, r) => a + ((r.net_pnl_paise as number) ?? 0), 0);
    expect(sum().s).toBe(wasSum);
  });
});
