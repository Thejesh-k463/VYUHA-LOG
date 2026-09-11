import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import {
  AUTO_CLOSE_NOTE,
  DEDUP_ALIAS_PREFIX,
  isLotIdentityFrozen,
  lotIdentityHashes,
  withLotCloseNote,
  withScaledRemainderNote,
} from "@/lib/import/close-open-lots";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v4.3.0 S-1 / S-2 — what a lot is CALLED, once an import has closed part of it.
 *
 * An auto-close collapses two identities (the lot's row and the incoming
 * execution) into one row that can store exactly one `dedup_hash`. Wave 1
 * stored the INCOMING row's hash and re-derived the lot's from the row's
 * current legs — which stops being derivable the moment the legs move:
 *
 *   buy 100 → sell 40 → sell 60 → re-import the BUY file → added 1,
 *   a phantom open 100 lot beside the position it had just finished closing.
 *
 * The ruling: the lot keeps its ORIGINAL hash for ever and every consuming
 * execution's hash becomes an ALIAS on the row. `lotIdentityHashes` is the one
 * door to that answer for the restore re-key and for Data Quality.
 *
 * AUTO-CLOSE IS SWITCHED OFF FOR 4.3.0 (owner ruling 2026-09-11, 06-ANSWERS
 * "v4.3.0 release-level-audit rulings", row 1). lib/import/commit.ts is v4.2.0
 * again: import dedup reads each row's OWN hash and no import writes an alias.
 * So S-1 now pins v4.2.0's dedup on the same buy/sell/sell sequence, and S-2
 * plus the scaled remainder PLANT the frozen rows wave 1 wrote (as
 * tests/data-quality.test.ts plants merged lots) — the restore re-key
 * (lib/db/data-fixes.ts) still reads `isLotIdentityFrozen` and must leave such
 * a row alone whenever one exists.
 *
 * ONE temp database per FILE (AGENTS.md) — `lib/db` caches its connection on
 * globalThis — so every case below uses its own account id.
 */

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let dataFixes: typeof import("@/lib/db/data-fixes");
let dedup: typeof import("@/lib/import/dedup");

const r2 = (n: number) => Math.round(n * 100) / 100;

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

const buyRow = (symbol: string, qty: number, price: number, date: string, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: symbol, buyQty: qty, avgBuyPrice: price, buyValue: r2(qty * price), buyDate: date, ...over });

const sellRow = (symbol: string, qty: number, price: number, date: string, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: symbol, sellQty: qty, avgSellPrice: price, sellValue: r2(qty * price), sellDate: date, ...over });

function parsed(trades: NormalizedTrade[], broker: NormalizedTrade["broker"] = "dhan"): ParsedFile {
  return {
    sourceId: broker === "paytm" ? "paytm-tradebook" : "dhan-gtr",
    broker,
    format: "tradebook",
    trades: trades.map((x) => ({ ...x, broker })),
    warnings: [],
  };
}

function newAccount(id: number, name: string) {
  t.db.insert(t.schema.accounts).values({ id, name }).run();
}

const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all();

beforeAll(async () => {
  t = await openTempDb("auto-close-identity", { seed: true });
  commit = await import("@/lib/import/commit");
  dataFixes = await import("@/lib/db/data-fixes");
  dedup = await import("@/lib/import/dedup");
}, 120_000);
afterAll(() => t?.cleanup());

// ───────────────────────────── the pure helper ──────────────────────────────

describe("lotIdentityHashes — the one door to a row's identity", () => {
  const H1 = "a".repeat(40);
  const H2 = "b".repeat(40);

  it("answers with the row's own hash when there is nothing else", () => {
    expect(lotIdentityHashes({ dedupHash: H1, importNotes: null })).toEqual([H1]);
    expect(lotIdentityHashes({ dedupHash: H1, importNotes: "Tax P&L section: Equity" })).toEqual([H1]);
  });

  it("own hash FIRST, then the aliases, de-duplicated", () => {
    const notes = withLotCloseNote(withLotCloseNote("parser note", H2), H1);
    expect(lotIdentityHashes({ dedupHash: H1, importNotes: notes })).toEqual([H1, H2]);
    expect(notes.split("|").filter((s) => s.trim() === AUTO_CLOSE_NOTE)).toHaveLength(1);
    expect(notes.startsWith("parser note | ")).toBe(true);
  });

  it("never reads prose as a hash", () => {
    expect(lotIdentityHashes({ dedupHash: H1, importNotes: `${DEDUP_ALIAS_PREFIX}not-a-hash` })).toEqual([H1]);
    expect(lotIdentityHashes({ dedupHash: H1, importNotes: `${DEDUP_ALIAS_PREFIX}${"Z".repeat(40)}` })).toEqual([H1]);
  });

  it("frozen means: this row's hash no longer describes its own legs", () => {
    expect(isLotIdentityFrozen({ dedupHash: H1, importNotes: null })).toBe(false);
    expect(isLotIdentityFrozen({ dedupHash: H1, importNotes: withLotCloseNote(null, H2) })).toBe(true);
    // A row written by wave 1 carries the sentence but no alias, and is frozen too.
    expect(isLotIdentityFrozen({ dedupHash: H1, importNotes: AUTO_CLOSE_NOTE })).toBe(true);
  });
});

// ──────── S-1: buy 100 → sell 40 → sell 60 → re-import, under v4.2.0 ───────

describe("S-1 — v4.2.0 dedup: every row answers to its OWN hash, and no import re-keys a lot", () => {
  const ACC = 621;
  const buys = () => parsed([buyRow("TCS", 100, 100, "2026-04-01")]);
  const sell40 = () => parsed([sellRow("TCS", 40, 120, "2026-05-01")]);
  const sell60 = () => parsed([sellRow("TCS", 60, 130, "2026-06-01")]);
  let bornHash = "";

  it("the buy lands, and its hash is recorded", () => {
    newAccount(ACC, "identity-s1");
    expect(commit.commitParsedFile(buys(), "buys.csv", null, ACC).added).toBe(1);
    bornHash = rowsOf(ACC)[0].dedupHash;
    expect(bornHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("a partial sell lands as its OWN row; the lot's hash and notes are unchanged", () => {
    expect(commit.commitParsedFile(sell40(), "sell40.csv", null, ACC).added).toBe(1);
    const lot = rowsOf(ACC).find((r) => r.dedupHash === bornHash)!;
    expect([lot.buyQty, lot.isOpen, lot.importNotes]).toEqual([100, true, null]);
    expect(lotIdentityHashes(lot), "no alias: the lot answers to the buy file alone").toEqual([bornHash]);
    expect(isLotIdentityFrozen(lot)).toBe(false);
  });

  it("the second sell lands as its own row too; nothing is closed and nothing is frozen", () => {
    expect(commit.commitParsedFile(sell60(), "sell60.csv", null, ACC).added).toBe(1);
    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.isOpen)).toBe(true);
    expect(rows.some((r) => isLotIdentityFrozen(r))).toBe(false);
  });

  it("re-importing the BUY file is skipped by its own hash — no phantom second lot", () => {
    const before = rowsOf(ACC).length;
    const again = commit.commitParsedFile(buys(), "buys.csv", null, ACC);
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(1);
    expect(rowsOf(ACC)).toHaveLength(before);
  });

  it("re-importing EITHER sell file is skipped by its own hash", () => {
    const before = rowsOf(ACC).map((r) => [r.id, r.buyQty, r.sellQty, r.isOpen]);
    expect(commit.commitParsedFile(sell40(), "sell40.csv", null, ACC).skipped).toBe(1);
    expect(commit.commitParsedFile(sell60(), "sell60.csv", null, ACC).skipped).toBe(1);
    expect(rowsOf(ACC).map((r) => [r.id, r.buyQty, r.sellQty, r.isOpen])).toEqual(before);
  });
});

// ──────────── S-2: the restore re-key must not touch a frozen lot ───────────

describe("S-2 — rerunDataFixesAfterRestore leaves a frozen lot alone (the lot is PLANTED)", () => {
  const ACC = 622;
  const ISIN = "INE000A01018";
  const buys = () => parsed([buyRow("PAYTMTEST", 100, 100, "2026-04-01", { isin: ISIN })], "paytm");
  const sells = () => parsed([sellRow("PAYTMTEST", 40, 120, "2026-05-01", { isin: ISIN })], "paytm");
  let frozen = "";
  let lotId = 0;

  it("a Paytm lot in the state wave 1 left after SELL 40 — planted, since no 4.3.0 import writes one", () => {
    newAccount(ACC, "identity-s2");
    expect(commit.commitParsedFile(buys(), "paytm-buys.csv", null, ACC).added).toBe(1);
    const lot = rowsOf(ACC)[0];
    frozen = lot.dedupHash;
    lotId = lot.id;
    const hSell = dedup.dedupHash(sells().trades[0]);
    // What wave 1's auto-close wrote: the lot reduced to 60 under its born-with
    // hash, the consuming sale's hash an alias beside it.
    t.db
      .update(t.schema.trades)
      .set({ buyQty: 60, buyValue: 6000, importNotes: withLotCloseNote(lot.importNotes, hSell) })
      .where(eq(t.schema.trades.id, lot.id))
      .run();
    const planted = rowsOf(ACC)[0];
    expect(isLotIdentityFrozen(planted)).toBe(true);
    expect(lotIdentityHashes(planted)).toEqual([frozen, hSell]);
    // The trap S-2 closes: the CURRENT legs hash to a different identity.
    expect(dedup.dedupHash({ ...buys().trades[0], buyQty: 60, buyValue: 6000 })).not.toBe(frozen);
  });

  it("the re-key run on every restore does not re-key it", () => {
    const results = dataFixes.rerunDataFixesAfterRestore(t.sqlite);
    expect(results.length).toBeGreaterThan(0);
    const lot = rowsOf(ACC).find((r) => r.id === lotId)!;
    expect(lot.dedupHash, "a frozen lot's hash survives the restore re-key").toBe(frozen);
    expect(isLotIdentityFrozen(lot), "and it is still frozen").toBe(true);
  });

  it("so the buy file still de-duplicates after the restore", () => {
    const before = rowsOf(ACC).length;
    const again = commit.commitParsedFile(buys(), "paytm-buys.csv", null, ACC);
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(1);
    expect(rowsOf(ACC)).toHaveLength(before);
  });
});

// ───── S-1 (round 2): the row an OVER-CONSUMING execution left behind ─────

describe("S-1 — a scaled-down remainder is frozen too (the remainder is PLANTED)", () => {
  const ACC = 623;
  const ISIN = "INE000A01026";
  const SYM = "PAYTMOVER";
  // Wave 1: 100 sold against a book holding 40 — 40 closed the lot and 60 was
  // left over as its own row, scaled, but stored under the WHOLE file row's
  // hash, because that is the record the file states.
  const sells = () => parsed([sellRow(SYM, 100, 120, "2026-05-01", { isin: ISIN })], "paytm");
  let remainderHash = "";

  it("the 60 left of a stated 100, planted as wave 1 wrote it, is frozen and has one identity", () => {
    newAccount(ACC, "identity-s1-remainder");
    expect(commit.commitParsedFile(sells(), "paytm-sells.csv", null, ACC).added).toBe(1);
    const row = rowsOf(ACC)[0];
    remainderHash = row.dedupHash;
    t.db
      .update(t.schema.trades)
      .set({ sellQty: 60, sellValue: 7200, importNotes: withScaledRemainderNote(row.importNotes, remainderHash) })
      .where(eq(t.schema.trades.id, row.id))
      .run();

    const remainder = rowsOf(ACC)[0];
    expect([remainder.buyQty, remainder.sellQty, remainder.isOpen]).toEqual([0, 60, true]);
    expect(isLotIdentityFrozen(remainder), "its hash no longer describes its own legs").toBe(true);
    expect(lotIdentityHashes(remainder), "and it gains no SECOND identity from saying so").toEqual([remainderHash]);
  });

  it("the restore re-key leaves it alone — it does not become a 60-share sale", () => {
    // What a genuine, separate 60-share sale of this scrip would be called.
    const genuine60 = dedup.dedupHash({
      broker: "paytm",
      tradingsymbol: SYM,
      isin: ISIN,
      buyQty: 0,
      avgBuyPrice: 0,
      buyValue: 0,
      sellQty: 60,
      avgSellPrice: 120,
      sellValue: 7200,
      buyDate: null,
      sellDate: "2026-05-01",
    });

    expect(dataFixes.rerunDataFixesAfterRestore(t.sqlite).length).toBeGreaterThan(0);
    const remainder = rowsOf(ACC)[0];
    expect(remainder.dedupHash, "the remainder's hash survives the restore re-key").toBe(remainderHash);
    expect(remainder.dedupHash, "and never becomes the identity of a sale that never happened")
      .not.toBe(genuine60);
  });

  it("so the sell file still de-duplicates after the restore", () => {
    const before = rowsOf(ACC).length;
    const again = commit.commitParsedFile(sells(), "paytm-sells.csv", null, ACC);
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(1);
    expect(rowsOf(ACC)).toHaveLength(before);
  });
});
