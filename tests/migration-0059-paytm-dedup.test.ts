import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * Migration 0059 + data fix `paytm-dedup-isin-v1` (owner ruling 2026-09-04).
 *
 * Paytm's tradebook labels a scrip by ticker in one export and by BSE code in
 * the next; the dedup hash keyed on that label, so the same position came
 * back as a "new" trade. Paytm rows with an ISIN now hash on `ISIN:<isin>`
 * — every other broker's hash is byte-for-byte what it was — and the stored
 * Paytm rows are re-keyed once by lib/db/data-fixes.ts.
 *
 * One temp database per FILE (tests/helpers/temp-db.ts).
 */

const FIX = "paytm-dedup-isin-v1";
const migrationsDir = path.join(process.cwd(), "drizzle");

/** The hash exactly as every release before 0059 computed it: on the label. */
function legacyHash(t: {
  broker: string; tradingsymbol: string; buyQty: number; avgBuyPrice: number; buyValue: number;
  sellQty: number; avgSellPrice: number; sellValue: number; buyDate: string | null; sellDate: string | null;
}): string {
  const parts = [t.broker, t.tradingsymbol.trim().toUpperCase(), t.buyQty, t.avgBuyPrice, t.buyValue,
    t.sellQty, t.avgSellPrice, t.sellValue, t.buyDate ?? "", t.sellDate ?? ""];
  return createHash("sha1").update(parts.join("|")).digest("hex");
}

const ZERODHA = {
  broker: "zerodha", tradingsymbol: "TCS", isin: "INE467B01029",
  buyQty: 10, avgBuyPrice: 3000, buyValue: 30000, sellQty: 10, avgSellPrice: 3100, sellValue: 31000,
  buyDate: "2026-08-03", sellDate: "2026-08-04",
};
const PAYTM_TICKER = {
  broker: "paytm", tradingsymbol: "SYNALPHA", isin: "INE0SYN01001",
  // NOT the fixture's own numbers — the commit-path test below imports the
  // fixture into this same database and must not de-dup against this row.
  buyQty: 7, avgBuyPrice: 209.51, buyValue: 1466.57, sellQty: 0, avgSellPrice: 0, sellValue: 0,
  buyDate: "2026-08-03", sellDate: null,
};
const PAYTM_CODE = { ...PAYTM_TICKER, tradingsymbol: "999001" };

let t: TempDb;
let dedup: typeof import("@/lib/import/dedup");
let fixes: typeof import("@/lib/db/data-fixes");

const hashOf = (id: number) =>
  (t.sqlite.prepare("SELECT dedup_hash AS h FROM trades WHERE id = ?").get(id) as { h: string }).h;
const marker = () => t.sqlite.prepare("SELECT name FROM data_fixes WHERE name = ?").get(FIX);

beforeAll(async () => {
  t = await openTempDb("m0059", { seed: true });
  dedup = await import("@/lib/import/dedup");
  fixes = await import("@/lib/db/data-fixes");
});

afterAll(() => t?.cleanup());

describe("migration 0059 — data_fixes ledger", () => {
  it("is journalled and creates data_fixes(name PK, applied_at NOT NULL)", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string; version: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.tag === "0059_paytm-dedup-data-fixes");
    expect(entry, "0059 is not in _journal.json — nothing would apply it").toBeTruthy();
    expect(entry!.idx).toBe(59);
    expect(entry!.version).toBe("6");
    expect(entry!.breakpoints).toBe(true);
    const cols = t.sqlite.prepare("PRAGMA table_info(data_fixes)").all() as { name: string; pk: number; notnull: number }[];
    expect(cols.map((c) => c.name).sort()).toEqual(["applied_at", "name"]);
    expect(cols.find((c) => c.name === "name")!.pk).toBe(1);
    expect(cols.find((c) => c.name === "applied_at")!.notnull).toBe(1);
  });

  it("openTempDb applies the fixes after migrating — the marker is already there", () => {
    expect(marker()).toBeTruthy();
  });
});

describe("dedupHash — Paytm keys on ISIN, everyone else is unchanged", () => {
  it("pins a Zerodha hash byte-for-byte to its pre-0059 value", () => {
    // sha1("zerodha|TCS|10|3000|30000|10|3100|31000|2026-08-03|2026-08-04")
    expect(dedup.dedupHash(ZERODHA)).toBe("b873f574cddcd800c917a54997f3666b3c4a626f");
    expect(dedup.dedupHash(ZERODHA)).toBe(legacyHash(ZERODHA));
    expect(dedup.dedupSymbolKey("zerodha", " tcs ", "INE467B01029")).toBe("TCS");
  });

  it("a Paytm row with an ISIN hashes the same under either label, and not on the label", () => {
    expect(dedup.dedupSymbolKey("paytm", "SYNALPHA", "INE0SYN01001")).toBe("ISIN:INE0SYN01001");
    expect(dedup.dedupHash(PAYTM_TICKER)).toBe(dedup.dedupHash(PAYTM_CODE));
    expect(dedup.dedupHash(PAYTM_TICKER)).not.toBe(legacyHash(PAYTM_TICKER));
    // The exact recipe: the label segment is replaced, nothing else moves.
    const expected = createHash("sha1")
      .update("paytm|ISIN:INE0SYN01001|7|209.51|1466.57|0|0|0|2026-08-03|")
      .digest("hex");
    expect(dedup.dedupHash(PAYTM_TICKER)).toBe(expected);
  });

  it("a Paytm row WITHOUT an ISIN still keys on the label", () => {
    const noIsin = { ...PAYTM_TICKER, isin: null };
    expect(dedup.dedupHash(noIsin)).toBe(legacyHash(noIsin));
    expect(dedup.dedupHash({ ...noIsin, isin: "  " })).toBe(legacyHash(noIsin));
  });

  it("uses the broker id the trades table stores", () => {
    expect(dedup.PAYTM_BROKER).toBe("paytm");
  });
});

describe("data fix paytm-dedup-isin-v1 — re-keys stored Paytm rows once", () => {
  let paytmId = 0, zerodhaId = 0, dupA = 0, dupB = 0;
  const zerodhaOld = legacyHash(ZERODHA);
  const paytmOld = legacyHash(PAYTM_TICKER);

  beforeAll(() => {
    // A book that pre-dates the fix: rows keyed the old way, no marker yet.
    t.sqlite.prepare("DELETE FROM data_fixes WHERE name = ?").run(FIX);
    const ins = (over: Record<string, unknown>) =>
      t.db.insert(t.schema.trades).values(tradeRow(over)).returning({ id: t.schema.trades.id }).get()!.id;
    paytmId = ins({ ...PAYTM_TICKER, symbol: "SYNALPHA", dedupHash: paytmOld });
    zerodhaId = ins({ ...ZERODHA, symbol: "TCS", dedupHash: zerodhaOld });
    // The duplicate the old hash let in: one position, two labels. Same
    // account, same broker — the unique index is (account_id, broker, hash).
    const dup = { ...PAYTM_TICKER, tradingsymbol: "SYNBETA", isin: "INE0SYN01002", buyQty: 5, buyValue: 1047.55 };
    dupA = ins({ ...dup, symbol: "SYNBETA", dedupHash: legacyHash(dup) });
    const dupCoded = { ...dup, tradingsymbol: "999002" };
    dupB = ins({ ...dupCoded, symbol: "999002", dedupHash: legacyHash(dupCoded) });
    // An override saved against the old key must follow the row.
    t.sqlite
      .prepare("INSERT INTO classification_overrides (broker, dedup_hash, segment) VALUES ('paytm', ?, 'eq_intraday')")
      .run(paytmOld);
  });

  it("re-keys the Paytm row to the ISIN hash and leaves the Zerodha row untouched", () => {
    expect(hashOf(paytmId)).toBe(paytmOld);
    const [r] = fixes.runDataFixes(t.sqlite);
    expect(r).toMatchObject({ name: FIX, applied: true, rekeyed: 2, skippedCollisions: 1 });
    expect(hashOf(paytmId)).toBe(dedup.dedupHash(PAYTM_TICKER));
    expect(hashOf(paytmId)).not.toBe(paytmOld);
    expect(hashOf(zerodhaId)).toBe(zerodhaOld);
  });

  it("the first of two colliding duplicates is re-keyed, the second is left as it was", () => {
    const dup = { ...PAYTM_TICKER, tradingsymbol: "SYNBETA", isin: "INE0SYN01002", buyQty: 5, buyValue: 1047.55 };
    expect(hashOf(dupA)).toBe(dedup.dedupHash(dup));
    expect(hashOf(dupB)).toBe(legacyHash({ ...dup, tradingsymbol: "999002" }));
  });

  it("moves a classification override to the new key", () => {
    const rows = t.sqlite.prepare("SELECT dedup_hash AS h FROM classification_overrides WHERE broker = 'paytm'").all() as { h: string }[];
    expect(rows.map((r) => r.h)).toEqual([dedup.dedupHash(PAYTM_TICKER)]);
  });

  it("writes the marker and a second run changes nothing", () => {
    expect(marker()).toBeTruthy();
    const before = t.sqlite.prepare("SELECT id, dedup_hash FROM trades ORDER BY id").all();
    const [r] = fixes.runDataFixes(t.sqlite);
    expect(r).toMatchObject({ name: FIX, applied: false, rekeyed: 0, skippedCollisions: 0 });
    expect(t.sqlite.prepare("SELECT id, dedup_hash FROM trades ORDER BY id").all()).toEqual(before);
  });

  it("is a silent no-op on a database with no data_fixes table yet", () => {
    t.sqlite.exec("ALTER TABLE data_fixes RENAME TO data_fixes_hidden");
    try {
      expect(fixes.runDataFixes(t.sqlite)).toEqual([]);
    } finally {
      t.sqlite.exec("ALTER TABLE data_fixes_hidden RENAME TO data_fixes");
    }
  });
});

describe("commit path — a Paytm file re-imported under the other label adds nothing", () => {
  it("parses the redacted v2 tradebook once as tickers, once as BSE codes, and the second adds 0 rows", async () => {
    // The Paytm parser directly rather than through detect.ts: this test is
    // about the dedup key, and detect.ts pulls in every parser in the registry.
    const { detectPaytmTradebook, parsePaytmTradebook } = await import("@/lib/import/parsers/paytm-tradebook");
    const { commitParsedFile } = await import("@/lib/import/commit");
    const bytes = fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "redacted", "paytm-tradebook-v2.xlsx"));
    const ctx = { filename: "paytm-tradebook-v2.xlsx", buffer: bytes };
    expect(detectPaytmTradebook(ctx)).toBeGreaterThan(0);
    const coded = parsePaytmTradebook(ctx);
    expect(coded.broker).toBe("paytm");
    expect(coded.trades.length).toBeGreaterThan(0);
    // The fixture labels every scrip by BSE code; every row carries an ISIN.
    for (const tr of coded.trades) {
      expect(tr.tradingsymbol).toMatch(/^\d+$/);
      expect(tr.isin).toBeTruthy();
    }
    // The same export as Paytm labels it on another day: by ticker.
    const ticker = { ...coded, trades: coded.trades.map((tr) => ({ ...tr, tradingsymbol: `SYN${tr.tradingsymbol}` })) };
    // Under the pre-0059 recipe the two would NOT have matched.
    expect(legacyHash(ticker.trades[0])).not.toBe(legacyHash(coded.trades[0]));

    const first = commitParsedFile(ticker, "paytm-aug-tickers.xlsx");
    expect(first.added).toBe(coded.trades.length);
    expect(first.skipped).toBe(0);

    const second = commitParsedFile(coded, "paytm-aug-codes.xlsx");
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(coded.trades.length);

    const stored = t.sqlite
      .prepare("SELECT dedup_hash AS h FROM trades WHERE broker = 'paytm' AND tradingsymbol LIKE 'SYN999%'")
      .all() as { h: string }[];
    expect(new Set(stored.map((r) => r.h))).toEqual(new Set(coded.trades.map((tr) => dedup.dedupHash(tr))));
  });
});

describe("lib/db/index.ts runs the fixes when a connection opens", () => {
  it("a fresh connection to a migrated file whose marker is missing writes it", async () => {
    t.sqlite.prepare("DELETE FROM data_fixes WHERE name = ?").run(FIX);
    expect(marker()).toBeFalsy();
    // Force lib/db to open a NEW connection to the same file: drop the
    // globalThis cache and the module registry, then import it again.
    const g = globalThis as unknown as { __vyuhaSqlite?: unknown };
    const cached = g.__vyuhaSqlite;
    delete g.__vyuhaSqlite;
    vi.resetModules();
    let fresh: typeof import("@/lib/db") | undefined;
    try {
      fresh = await import("@/lib/db");
      expect(path.resolve(fresh.sqlite.name)).toBe(path.resolve(t.dbPath));
      expect(marker(), "lib/db/index.ts did not run the data fixes on open").toBeTruthy();
    } finally {
      // Close even on failure, or cleanup() cannot unlink the file (EBUSY).
      fresh?.sqlite.close();
      g.__vyuhaSqlite = cached;
      vi.resetModules();
    }
  });
});
