import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import {
  AUTO_CLOSE_NOTE,
  CLOSED_BY_PREFIX,
  DEDUP_ALIAS_PREFIX,
  PARTIAL_CLOSE_NOTE,
  closedByHash,
  lotIdentityHashes,
} from "@/lib/import/close-open-lots";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * v4.5.0 W2a — the auto-close APPLIER, against a real database, DORMANT.
 *
 * Everything here passes `{ autoClose: true }` explicitly (the 5th argument of
 * `commitParsedFile` / `previewParsedFile`). Nothing in production does, which
 * is what tests/auto-close-off.test.ts pins; this file pins what the applier
 * DOES once W2b asks for it, so the behaviour is proven before it is switched
 * on rather than after.
 *
 * The rules under test, and where each comes from:
 *   · D3 seq 2  — an acquisition "unknown" row is never a lot (openLotOf).
 *   · R72 / A2  — a dateless execution closes nothing, and the refusal is only
 *                 SAID when a lot was actually there.
 *   · R4        — a lot dated after the sale is never closed by it.
 *   · rev 9     — ONE execution hash, ONE holder: a reduced lot carries the
 *                 provenance sentence and no alias.
 *   · R6 / M-1  — every charge component splits by remainder and conserves.
 *   · R3        — a stated broker bill is never swapped for the engine's.
 *   · R41       — the closed row's entry time is the LOT's.
 *   · R2        — the preview's Net P&L is the commit's, to the paisa.
 *   · R14/R15   — what the sentences may claim.
 *   · R31       — a closed row is no longer an "opening sell".
 *   · M-2/R58   — a lot this file opened is a lot a later row can close.
 *   · inv 1/5/6/8/9 and counted-once, on the stored book.
 *
 * ONE temp database per FILE (AGENTS.md Testing): `lib/db` caches its
 * connection on globalThis, so every case below owns its own account id.
 * Measured locally 2026-09-22: the hook 1.0-1.2 s, every `it` under 300 ms.
 */

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let oracle: typeof import("./helpers/oracle-book");

const r2 = (n: number) => Math.round(n * 100) / 100;
const AC = { autoClose: true } as const;

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

const buyRow = (symbol: string, qty: number, price: number, date: string | null, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: symbol, buyQty: qty, avgBuyPrice: price, buyValue: r2(qty * price), buyDate: date, ...over });

const sellRow = (symbol: string, qty: number, price: number, date: string | null, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: symbol, sellQty: qty, avgSellPrice: price, sellValue: r2(qty * price), sellDate: date, ...over });

const unknownSell = (symbol: string, qty: number, price: number, date: string | null) =>
  sellRow(symbol, qty, price, date, { basisUnknown: true } as Partial<NormalizedTrade>);

function parsed(trades: NormalizedTrade[], broker: NormalizedTrade["broker"] = "dhan"): ParsedFile {
  return {
    sourceId: broker === "zerodha" ? "zerodha-tradebook" : "dhan-gtr",
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
  t.db
    .select()
    .from(t.schema.trades)
    .where(eq(t.schema.trades.accountId, accountId))
    .all()
    .sort((a, b) => a.id - b.id);

type Row = ReturnType<typeof rowsOf>[number];

const HEADS = [
  "brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty",
  "ipft", "gst", "dpCharges", "mtfInterest", "pledgeCharges",
] as const;

const headSum = (rows: Row[]) =>
  Object.fromEntries(HEADS.map((h) => [h, r2(rows.reduce((s, x) => s + ((x as unknown as Record<string, number>)[h] ?? 0), 0))]));

/** Every numeric column of every row is a real number (never NaN). */
function expectNoNaN(rows: Row[]) {
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === "number") expect(Number.isFinite(v), `${k} on row ${row.id}`).toBe(true);
    }
  }
}

beforeAll(async () => {
  t = await openTempDb("auto-close-applier", { seed: true });
  commit = await import("@/lib/import/commit");
  oracle = await import("./helpers/oracle-book");
  await oracle.loadOracleConsumers();
}, 120_000);
afterAll(() => t?.cleanup());

// ═══ 1 · openLotOf — an acquisition "unknown" row is never a lot (D3 seq 2) ══

describe("1 · D3 sequence 2 — an opening SELL of unknown basis is not a short lot", () => {
  const ACC = 801;

  it("the opening sell lands with acquisition 'unknown'", () => {
    newAccount(ACC, "d3-seq2");
    const res = commit.commitParsedFile(parsed([unknownSell("TCS", 100, 120, "2026-04-01")]), "sell.csv", null, ACC, AC);
    expect(res.added).toBe(1);
    expect(rowsOf(ACC)[0]).toMatchObject({ sellQty: 100, buyQty: 0, isOpen: true, acquisition: "unknown" });
  });

  it("a later BUY is a NEW long, never a cover: two rows, and the sell is untouched", () => {
    const before = { ...rowsOf(ACC)[0] };
    const res = commit.commitParsedFile(parsed([buyRow("TCS", 100, 100, "2026-05-01")]), "buy.csv", null, ACC, AC);
    const rows = rowsOf(ACC);
    expect(rows, "covering it would book a P&L against a basis nobody stated (invariant 6)").toHaveLength(2);
    expect(rows[0], "every column of the opening sell, as it was").toEqual(before);
    expect(rows[1]).toMatchObject({ buyQty: 100, sellQty: 0, isOpen: true });
    expect(res.autoClose).toMatchObject({ closedWhole: 0, reduced: 0, closedAgainstStoredLot: 0 });
    expect((res.warnings ?? []).some((w) => w.includes("closed")), "no sentence may claim a close").toBe(false);
  });
});

// ═══ 2 · a dateless execution matches nothing; refusedNoDate needs a lot ═════

describe("2 · an execution that states no date closes nothing", () => {
  const ACC = 802;
  const ACC_EMPTY = 803;

  it("the sale is written as its own row, both stay open, and the refusal is SAID", () => {
    newAccount(ACC, "no-date");
    commit.commitParsedFile(parsed([buyRow("INFY", 100, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    const lotBefore = { ...rowsOf(ACC)[0] };

    const file = parsed([sellRow("INFY", 40, 120, null)]);
    const p = commit.previewParsedFile(file, null, ACC, "sell.csv", AC);
    expect(p.autoClose?.refusedNoDate).toBe(1);

    const res = commit.commitParsedFile(file, "sell.csv", null, ACC, AC);
    expect(res.added).toBe(1);
    expect(res.autoClose).toMatchObject({ refusedNoDate: 1, closedWhole: 0, reduced: 0 });
    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(2);
    expect(rows[0], "the lot is untouched").toEqual(lotBefore);
    expect(rows[1]).toMatchObject({ sellQty: 40, isOpen: true, sellDate: null });
    expect(res.warnings?.some((w) => w.includes("states no date"))).toBe(true);
    expect(
      res.warnings?.some((w) => w.includes("Open positions with their closing trade stored beside them")),
      "the refusal must point at the one screen that can settle it",
    ).toBe(true);
  });

  it("a dateless sale in a book holding NOTHING is an ordinary open row, and says nothing", () => {
    newAccount(ACC_EMPTY, "no-date-empty");
    const res = commit.commitParsedFile(parsed([sellRow("WIPRO", 40, 120, null)]), "sell.csv", null, ACC_EMPTY, AC);
    expect(res.added).toBe(1);
    expect(res.autoClose?.refusedNoDate, "no lot was there to refuse").toBe(0);
    expect(res.warnings?.some((w) => w.includes("states no date"))).toBe(false);
  });
});

// ═══ 3 · R4 — a lot dated AFTER the sale is never closed by it ═══════════════

describe("3 · R4 — a lot opened after the sale is never the lot it closed", () => {
  const ACC = 804;

  it("both rows stay open and neither is touched", () => {
    newAccount(ACC, "r4");
    commit.commitParsedFile(parsed([buyRow("HDFCBANK", 100, 100, "2026-05-10")]), "buy.csv", null, ACC, AC);
    const lotBefore = { ...rowsOf(ACC)[0] };

    const res = commit.commitParsedFile(parsed([sellRow("HDFCBANK", 100, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    expect(res.added).toBe(1);
    expect(res.autoClose).toMatchObject({ closedWhole: 0, reduced: 0, refusedNoDate: 0 });
    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(2);
    expect(rows[0], "a share bought on the 10th cannot have been sold on the 1st").toEqual(lotBefore);
    expect(rows[1]).toMatchObject({ sellQty: 100, isOpen: true });
  });
});

// ═══ 4 · a REDUCED lot carries the sentence and NO alias (rev 9) ═════════════

describe("4 · a partly consumed lot: one holder, one sentence, no alias", () => {
  const ACC = 805;
  let lotBefore: Row;

  it("the lot is reduced to 60 and a closing slice is written beside it", () => {
    newAccount(ACC, "reduced");
    commit.commitParsedFile(parsed([buyRow("SBIN", 100, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    lotBefore = { ...rowsOf(ACC)[0] };

    const res = commit.commitParsedFile(parsed([sellRow("SBIN", 40, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    expect(res.added, "the slice is the row this file added").toBe(1);
    expect(res.autoClose).toMatchObject({ closedWhole: 0, reduced: 1, closedAgainstStoredLot: 1 });

    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: lotBefore.id, buyQty: 60, sellQty: 0, isOpen: true, buyValue: 6000 });
    expect(rows[1]).toMatchObject({ buyQty: 40, sellQty: 40, isOpen: false, avgBuyPrice: 100, avgSellPrice: 120, grossPnl: 800 });
  });

  it("the lot keeps its OWN identity and gains no alias — one hash, one holder", () => {
    const [lot, slice] = rowsOf(ACC);
    expect(lot.dedupHash, "a lot's identity is frozen at birth").toBe(lotBefore.dedupHash);
    expect(lot.importNotes).toBe(AUTO_CLOSE_NOTE);
    expect(lot.importNotes, "two holders lost 40 shares of P&L on a Trash restore").not.toContain(DEDUP_ALIAS_PREFIX);
    expect(lotIdentityHashes(lot)).toEqual([lotBefore.dedupHash]);
    // The slice is the one row that holds the execution's hash — as its OWN
    // hash, with the alias restating it so `isLotIdentityFrozen` says yes. The
    // alias de-dupes, so the slice gains no SECOND identity.
    expect(slice.importNotes).toContain(AUTO_CLOSE_NOTE);
    expect(slice.importNotes).toContain(`${DEDUP_ALIAS_PREFIX}${slice.dedupHash}`);
    expect(lotIdentityHashes(slice)).toEqual([slice.dedupHash]);
    expect(slice.dedupHash, "the lot's identity and the sale's are two different hashes").not.toBe(lot.dedupHash);
  });

  it("R14 — the sentence says REDUCED, never closed", () => {
    const res = commit.previewParsedFile(parsed([sellRow("SBIN", 10, 130, "2026-05-02")]), null, ACC, "s2.csv", AC);
    expect(res.autoClose).toMatchObject({ reduced: 1, closedWhole: 0 });
    expect(res.warnings.some((w) => w.includes("reduced, not closed"))).toBe(true);
    expect(res.warnings.some((w) => /position(s)? closed/.test(w))).toBe(false);
  });

  it("re-importing the SAME sale file is a duplicate, not a second slice", () => {
    const again = commit.commitParsedFile(parsed([sellRow("SBIN", 40, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    expect([again.added, again.skipped]).toEqual([0, 1]);
    expect(rowsOf(ACC)).toHaveLength(2);
  });
});

// ═══ 5 · whole consumption: the lot row itself converts; remainder shape ═════

describe("5 · a lot consumed WHOLE becomes the closed row", () => {
  const ACC = 806;
  let lotBefore: Row;

  it("no slice is inserted: added 0, closedWhole 1, the lot row converted in place", () => {
    newAccount(ACC, "whole");
    commit.commitParsedFile(parsed([buyRow("ITC", 100, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    lotBefore = { ...rowsOf(ACC)[0] };

    const res = commit.commitParsedFile(parsed([sellRow("ITC", 100, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    expect(res.added, "nothing was inserted — the lot became the closed row").toBe(0);
    expect(res.autoClose).toMatchObject({ closedWhole: 1, reduced: 0, closedAgainstStoredLot: 1, openedNew: 0 });

    const rows = rowsOf(ACC);
    expect(rows, "no slice beside it").toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: lotBefore.id,
      dedupHash: lotBefore.dedupHash,
      buyQty: 100,
      sellQty: 100,
      isOpen: false,
      avgBuyPrice: 100,
      avgSellPrice: 120,
      buyDate: "2026-04-01",
      sellDate: "2026-05-01",
      grossPnl: 2000,
    });
    expect(rows[0].importNotes).toContain(AUTO_CLOSE_NOTE);
    expect(rows[0].importNotes).toContain(DEDUP_ALIAS_PREFIX);
    expect(lotIdentityHashes(rows[0]), "its own hash first, then the sale's").toHaveLength(2);
    expect(res.warnings?.some((w) => w.includes("1 position closed against open positions this account already held"))).toBe(true);
  });

  it("re-importing the sale is skipped: 0 added, 1 skipped, still one row", () => {
    const again = commit.commitParsedFile(parsed([sellRow("ITC", 100, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    expect([again.added, again.skipped]).toEqual([0, 1]);
    expect(rowsOf(ACC)).toHaveLength(1);
  });

  it("re-importing the BUY is skipped too — the lot's own hash is still its own", () => {
    const again = commit.commitParsedFile(parsed([buyRow("ITC", 100, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    expect([again.added, again.skipped], "wave 1's phantom 100-share lot must not come back").toEqual([0, 1]);
    expect(rowsOf(ACC)).toHaveLength(1);
  });

  it("a sale BIGGER than the lot: the CONVERTED LOT holds the hash, the remainder carries closed-by", () => {
    const ACC2 = 807;
    newAccount(ACC2, "remainder");
    commit.commitParsedFile(parsed([buyRow("LT", 60, 100, "2026-04-01")]), "buy.csv", null, ACC2, AC);
    const res = commit.commitParsedFile(parsed([sellRow("LT", 100, 120, "2026-05-01")]), "sell.csv", null, ACC2, AC);
    // 60 closed the lot whole (in place) and 40 is left over as a new open row.
    expect(res.autoClose).toMatchObject({ closedWhole: 1, reduced: 0, openedNew: 1 });
    expect(res.added, "the remainder is the row added").toBe(1);

    const rows = rowsOf(ACC2);
    expect(rows).toHaveLength(2);
    const closed = rows.find((r) => !r.isOpen)!;
    const remainder = rows.find((r) => r.isOpen)!;
    expect(closed).toMatchObject({ buyQty: 60, sellQty: 60, grossPnl: 1200 });
    expect(remainder).toMatchObject({ sellQty: 40, buyQty: 0, sellValue: 4800, isOpen: true });
    // The one-holder rule, in its stated order (commit.ts, revision 9): a lot
    // consumed WHOLE wins the execution's hash, so the remainder is NOT the
    // holder — it takes a hash re-derived from its own legs and carries only
    // the thread back.
    expect(closed.importNotes).toContain(AUTO_CLOSE_NOTE);
    const held = lotIdentityHashes(closed);
    expect(held, "its own hash and the sale's").toHaveLength(2);
    expect(remainder.importNotes).toContain(CLOSED_BY_PREFIX);
    expect(closedByHash(remainder.importNotes), "the thread back to the execution").toBe(held[1]);
    expect(remainder.dedupHash, "the remainder may not also claim the file's hash").not.toBe(held[1]);
    expect(lotIdentityHashes(remainder), "closed-by is provenance, never an identity").toEqual([remainder.dedupHash]);
    expect(remainder.importNotes, "nothing here was left OVER of a hash it holds").not.toContain(PARTIAL_CLOSE_NOTE);
  });

  it("re-importing that bigger sale is skipped whole — the converted lot answers for it", () => {
    const ACC2 = 807;
    const again = commit.commitParsedFile(parsed([sellRow("LT", 100, 120, "2026-05-01")]), "sell.csv", null, ACC2, AC);
    expect([again.added, again.skipped], "no phantom second remainder").toEqual([0, 1]);
    expect(rowsOf(ACC2)).toHaveLength(2);
  });
});

// ═══ 6 · every money component conserves to the paisa (R6 / M-1) ════════════

describe("6 · charges conserve: lot bill + slice bill = what was charged", () => {
  const ACC = 808;

  it("a ₹0.01 head split in half never becomes ₹0.02 of its own", () => {
    newAccount(ACC, "conserve");
    const ACC_REF = 820; // the SAME two files, with nothing to close
    newAccount(ACC_REF, "conserve-ref");
    const lotCharges = { brokerage: 20, sebi: 0.01, total: 20.01 };
    const sellCharges = { brokerage: 10, sebi: 0.01, total: 10.01 };
    const buyFile = () => parsed([buyRow("ONGC", 100, 100, "2026-04-01", { reportedCharges: lotCharges } as Partial<NormalizedTrade>)]);
    const sellFile = () => parsed([sellRow("ONGC", 50, 120, "2026-05-01", { reportedCharges: sellCharges } as Partial<NormalizedTrade>)]);

    // The reference book: the same two rows written with auto-close OFF, so
    // each row carries the bill it would have carried on its own. That is what
    // the closed book must still add up to — a close merges bills, never mints.
    commit.commitParsedFile(buyFile(), "buy.csv", null, ACC_REF);
    commit.commitParsedFile(sellFile(), "sell.csv", null, ACC_REF);
    const refRows = rowsOf(ACC_REF);
    expect(refRows).toHaveLength(2);
    const refHeads = headSum(refRows);
    const refTotal = r2(refRows.reduce((s, r) => s + r.chargesTotal, 0));

    commit.commitParsedFile(buyFile(), "buy.csv", null, ACC, AC);
    const lotBefore = { ...rowsOf(ACC)[0] };
    expect(lotBefore.chargesTotal, "the lot's stated bill, kept verbatim").toBe(20.01);
    commit.commitParsedFile(sellFile(), "sell.csv", null, ACC, AC);

    const rows = rowsOf(ACC);
    expect(rows, "the lot reduced to 50 plus the closing slice").toHaveLength(2);
    expect(r2(rows.reduce((s, r) => s + r.chargesTotal, 0)), "every paisa the two files charged, and not one more").toBe(refTotal);

    // Per COMPONENT, never on the total alone (the round-2 M-1 rule): a ₹0.01
    // SEBI fee on a lot sold half was once stored as 0.01 + 0.01.
    const afterHeads = headSum(rows);
    for (const h of HEADS) expect(afterHeads[h], `${h} conserved`).toBe(refHeads[h]);
    expect(afterHeads.sebi, "the odd paisa, once").toBe(r2(refHeads.sebi));
    expectNoNaN(rows);
  });
});

// ═══ 7/8/9 · stated bills, preview==commit charges, and the entry time ══════

describe("7-9 · the bill each side STATES, and what the closed row carries", () => {
  const ACC = 809;
  const lotCharges = { brokerage: 100, dpCharges: 18.44, total: 118.44 };
  const sellCharges = { brokerage: 12, sebi: 0.34, total: 12.34 };
  let preview: ReturnType<typeof commit.previewParsedFile>;

  it("R3 — a stated broker total is never swapped for the engine's", () => {
    newAccount(ACC, "stated");
    commit.commitParsedFile(
      parsed([
        buyRow("MARUTI", 10, 1000, "2026-04-01", {
          reportedCharges: lotCharges,
          entryTime: "09:31:07",
        } as Partial<NormalizedTrade>),
      ]),
      "buy.csv", null, ACC, AC,
    );
    const lot = rowsOf(ACC)[0];
    expect(lot.chargesTotal, "the file's own figure, kept verbatim").toBe(118.44);

    const file = parsed([
      sellRow("MARUTI", 10, 1200, "2026-05-01", { reportedCharges: sellCharges, exitTime: "14:02:00" } as Partial<NormalizedTrade>),
    ]);
    preview = commit.previewParsedFile(file, null, ACC, "sell.csv", AC);
    const res = commit.commitParsedFile(file, "sell.csv", null, ACC, AC);
    expect(res.autoClose?.closedWhole).toBe(1);

    const closed = rowsOf(ACC)[0];
    expect(closed.chargesTotal, "118.44 + 12.34 — two stated bills, merged, nothing invented").toBe(130.78);
    expect(closed.grossPnl).toBe(2000);
    expect(closed.netPnl).toBe(r2(2000 - 130.78));
  });

  it("R2/R60 — the preview's charges and net for that row are the ones stored", () => {
    const closed = rowsOf(ACC)[0];
    expect(preview.summary.chargesTotal).toBe(closed.chargesTotal);
    expect(preview.summary.netPnl).toBe(closed.netPnl);
    expect(preview.summary.grossPnl).toBe(closed.grossPnl);
  });

  it("R41 — a lot converted in place keeps its entry time and takes the execution's exit time", () => {
    const closed = rowsOf(ACC)[0];
    expect(closed.entryTime, "a close must not erase when the position was opened").toBe("09:31:07");
    expect(closed.exitTime).toBe("14:02:00");
  });

  it("R41 — an INSERTED slice carries the LOT's entry time, not the sale's", () => {
    // The whole-consumption path keeps `entry_time` by never patching it, so it
    // proves nothing about the plumbing. The slice is a brand-new row: its
    // entry time can only come from `piece.entryTime`, which is the lot row's.
    const ACC2 = 822;
    newAccount(ACC2, "r41-slice");
    commit.commitParsedFile(
      parsed([buyRow("BAJFINANCE", 100, 1000, "2026-04-01", { entryTime: "09:15:42" } as Partial<NormalizedTrade>)]),
      "buy.csv", null, ACC2, AC,
    );
    const res = commit.commitParsedFile(
      parsed([sellRow("BAJFINANCE", 40, 1200, "2026-05-01", { exitTime: "15:12:30" } as Partial<NormalizedTrade>)]),
      "sell.csv", null, ACC2, AC,
    );
    expect(res.autoClose).toMatchObject({ reduced: 1, closedWhole: 0 });
    const slice = rowsOf(ACC2).find((r) => !r.isOpen)!;
    expect(slice.entryTime, "the position was opened at the lot's time, not the sale's").toBe("09:15:42");
    expect(slice.exitTime).toBe("15:12:30");
    expect(slice.buyDate).toBe("2026-04-01");
    expect(slice.sellDate).toBe("2026-05-01");
  });
});

// ═══ 10/11 · R2 — preview Net P&L === commit Net P&L ════════════════════════

describe("10-11 · R2 — the preview's Net P&L is the commit's, to the paisa", () => {
  it("(a) a sale against a lot the book already stored", () => {
    const ACC = 810;
    newAccount(ACC, "r2-stored");
    commit.commitParsedFile(parsed([buyRow("TATASTEEL", 100, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    const file = parsed([sellRow("TATASTEEL", 70, 133.33, "2026-05-01")]);
    const p = commit.previewParsedFile(file, null, ACC, "sell.csv", AC);
    const res = commit.commitParsedFile(file, "sell.csv", null, ACC, AC);
    expect(p.summary.netPnl).toBe(res.netPnl);
    expect(p.autoClose).toEqual(res.autoClose);
    const slice = rowsOf(ACC).find((r) => !r.isOpen)!;
    expect(res.netPnl, "and it is what the row stores").toBe(slice.netPnl);
  });

  it("(b) a BUY and a SELL in ONE file — the virtual lot the preview builds", () => {
    const ACC = 811;
    newAccount(ACC, "r2-virtual");
    const file = parsed([buyRow("BEL", 100, 100, "2026-04-01"), sellRow("BEL", 100, 120, "2026-04-05")]);
    const p = commit.previewParsedFile(file, null, ACC, "both.csv", AC);
    const res = commit.commitParsedFile(file, "both.csv", null, ACC, AC);
    expect(p.summary.netPnl, "R2 — the two halves word the same book the same way").toBe(res.netPnl);
    expect(p.autoClose).toEqual(res.autoClose);

    // What the BOOK holds: one closed row carrying both legs' bills, once.
    // (The file-level summary above is a DIFFERENT figure here — it counts the
    // buy row's own bill and then again inside the merged close. W2a finding
    // F1, reported: it is consistent preview-to-commit, which is what R2 asks,
    // but it over-states a same-file B+S import's charges by the buy's bill.)
    const ref = 821;
    newAccount(ref, "r2-virtual-ref");
    commit.commitParsedFile(file, "both.csv", null, ref);
    const refTotal = r2(rowsOf(ref).reduce((s, r) => s + r.chargesTotal, 0));
    const rows = rowsOf(ACC);
    expect(rows, "one closed row, not two open ones").toHaveLength(1);
    expect(r2(rows[0].chargesTotal), "the stored book charges each leg exactly once").toBe(refTotal);
    expect(rows[0].netPnl).toBe(r2(rows[0].grossPnl - rows[0].chargesTotal));
  });
});

// ═══ 12/14 · the sentences over a real book, and M-2/R58 ════════════════════

describe("12/14 · a lot this FILE opened is a lot a later row can close (M-2/R58)", () => {
  const ACC = 812;

  it("B then S in one file leaves ONE closed row, and R15's wording says so", () => {
    newAccount(ACC, "m2");
    const res = commit.commitParsedFile(
      parsed([buyRow("NTPC", 100, 100, "2026-04-01"), sellRow("NTPC", 100, 120, "2026-04-05")]),
      "both.csv", null, ACC, AC,
    );
    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ buyQty: 100, sellQty: 100, isOpen: false, grossPnl: 2000 });
    expect(res.autoClose).toMatchObject({ closedWhole: 1, closedAgainstThisFilesLot: 1, closedAgainstStoredLot: 0 });
    const said = (res.warnings ?? []).find((w) => w.includes("closed"))!;
    expect(said, "R15 — these two rows were never 'already held'").not.toContain("already held");
    expect(said).toContain("against positions opened earlier in this same file");
  });

  it("R15 — a file closing BOTH a stored lot and its own says both clauses", () => {
    const ACC2 = 813;
    newAccount(ACC2, "m2-both");
    commit.commitParsedFile(parsed([buyRow("COALINDIA", 50, 100, "2026-04-01")]), "buy.csv", null, ACC2, AC);
    const res = commit.commitParsedFile(
      parsed([
        sellRow("COALINDIA", 50, 120, "2026-05-01"),
        buyRow("GAIL", 10, 200, "2026-05-02"),
        sellRow("GAIL", 10, 220, "2026-05-03"),
      ]),
      "mixed.csv", null, ACC2, AC,
    );
    expect(res.autoClose).toMatchObject({ closedWhole: 2, closedAgainstStoredLot: 1, closedAgainstThisFilesLot: 1 });
    expect((res.warnings ?? []).some((w) => w.includes("some this account already held, some opened earlier in this same file"))).toBe(true);
  });
});

// ═══ 13 · R31 — a closed row is no longer an "opening sell" ═════════════════

describe("13 · R31 — a sale the plan closed is neither an opening sell nor an open row", () => {
  const ACC = 814;

  it("shape.openingSells drops to 0 and the row carries no 'unknown' acquisition", () => {
    newAccount(ACC, "r31");
    commit.commitParsedFile(parsed([buyRow("CIPLA", 100, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    const file = parsed([unknownSell("CIPLA", 100, 120, "2026-05-01")]);

    const p = commit.previewParsedFile(file, null, ACC, "sell.csv", AC);
    expect(p.shape.openingSells, "the basis was never unknown — the book was holding it").toBe(0);
    expect(p.shape.open).toBe(0);

    const res = commit.commitParsedFile(file, "sell.csv", null, ACC, AC);
    expect(res.shape.openingSells).toBe(0);
    expect(res.shape.open).toBe(0);
    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isOpen: false, acquisition: null, buyQty: 100, sellQty: 100, grossPnl: 2000 });
  });
});

// ═══ 15 · the OFF default ═══════════════════════════════════════════════════

describe("15 · with no option at all, nothing changes (the dormant default)", () => {
  const ACC = 815;

  it("B and S in one file land as TWO open rows and the result states no plan", () => {
    newAccount(ACC, "off-default");
    const res = commit.commitParsedFile(
      parsed([buyRow("DRREDDY", 100, 100, "2026-04-01"), sellRow("DRREDDY", 100, 120, "2026-04-05")]),
      "both.csv", null, ACC,
    );
    expect(res.added).toBe(2);
    expect(res.autoClose, "the applier is dormant until a caller asks").toBeUndefined();
    expect(rowsOf(ACC).every((r) => r.isOpen)).toBe(true);
    const p = commit.previewParsedFile(parsed([sellRow("DRREDDY", 10, 130, "2026-04-06")]), null, ACC, "s.csv");
    expect("autoClose" in p).toBe(false);
  });

  it("`{ autoClose: false }` is the same as saying nothing", () => {
    const ACC2 = 816;
    newAccount(ACC2, "off-explicit");
    const res = commit.commitParsedFile(
      parsed([buyRow("SUNPHARMA", 100, 100, "2026-04-01"), sellRow("SUNPHARMA", 100, 120, "2026-04-05")]),
      "both.csv", null, ACC2, { autoClose: false },
    );
    expect(res.added).toBe(2);
    expect(res.autoClose).toBeUndefined();
  });
});

// ═══ 16 · invariants over the stored book, and counted-once ═════════════════

describe("16 · the stored book: invariant 5, no NaN, and realised P&L counted ONCE", () => {
  const ACC = 817;
  let closed: Row;

  it("the parent row holds the aggregate and has no legs of its own (invariant 5)", () => {
    newAccount(ACC, "counted-once");
    commit.commitParsedFile(parsed([buyRow("AXISBANK", 100, 100, "2025-06-10")]), "buy.csv", null, ACC, AC);
    const res = commit.commitParsedFile(parsed([sellRow("AXISBANK", 100, 120, "2025-09-20")]), "sell.csv", null, ACC, AC);
    expect(res.autoClose?.closedWhole).toBe(1);

    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(1);
    closed = rows[0];
    expect(closed).toMatchObject({ buyQty: 100, sellQty: 100, isOpen: false, staged: false, grossPnl: 2000 });
    expect(closed.netPnl).toBe(r2(closed.grossPnl - closed.chargesTotal));
    const legs = t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, closed.id)).all();
    expect(legs, "one fill against one lot is not a staged position (invariant 4)").toEqual([]);
    expectNoNaN(rows);
  });

  it("invariant 9 — nothing was ever written to account 0", () => {
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, 0)).all()).toEqual([]);
  });

  it("the realised net is counted EXACTLY once by capital, the tax base, the ITR export and the /trades KPI", async () => {
    const view = await oracle.readOracleView(t, ACC);
    expect(view.capital.equityRealised, "capital").toBe(closed.netPnl);
    expect(view.capital.totalRealised).toBe(closed.netPnl);
    expect(view.taxNets, "the tax base counts one gain, once").toEqual([closed.netPnl]);
    expect(view.itrCount, "one exported ITR row").toBe(1);
    expect(view.itrScrips).toEqual([closed.symbol]);
    expect(view.deliveryConsideration).toBe(closed.sellValue);
    expect(view.kpi, "the /trades KPI strip").toMatchObject({ count: 1, open: 0, net: closed.netPnl });
    expect(view.fyRealised["2025-26"]).toBe(closed.netPnl);
    expect(view.ais["2025-26 sale"]).toBe(closed.sellValue);
  });
});

// ═══ 16b · the MTF accrual can no longer reach a lot the import closed ══════

describe("16b · design seq 12 — MTF accrual after an auto-close", () => {
  const ACC = 823;

  it("a closed MTF row is out of the accrual's reach; a REDUCED one accrues on what is LEFT", async () => {
    newAccount(ACC, "mtf-seq12");
    const mtfBuy = (sym: string) =>
      parsed([buyRow(sym, 100, 100, "2026-04-01", { productHint: "mtf" } as Partial<NormalizedTrade>)]);
    commit.commitParsedFile(mtfBuy("VEDL"), "mtf-a.csv", null, ACC, AC);
    commit.commitParsedFile(mtfBuy("NMDC"), "mtf-b.csv", null, ACC, AC);
    const seeded = rowsOf(ACC);
    expect(seeded.map((r) => r.segment), "both lots are MTF").toEqual(["eq_mtf", "eq_mtf"]);

    // VEDL closed whole; NMDC reduced to 60.
    commit.commitParsedFile(
      parsed([sellRow("VEDL", 100, 120, "2026-05-01", { productHint: "mtf" } as Partial<NormalizedTrade>)]),
      "mtf-close.csv", null, ACC, AC,
    );
    commit.commitParsedFile(
      parsed([sellRow("NMDC", 40, 120, "2026-05-01", { productHint: "mtf" } as Partial<NormalizedTrade>)]),
      "mtf-part.csv", null, ACC, AC,
    );

    const closed = rowsOf(ACC).find((r) => r.tradingsymbol === "VEDL")!;
    expect(closed.isOpen, "the accrual selects segment=eq_mtf AND is_open=true").toBe(false);
    const reduced = rowsOf(ACC).find((r) => r.tradingsymbol === "NMDC" && r.isOpen)!;
    expect(reduced.buyQty, "the remaining stated principal is 60 shares").toBe(60);
    expect(reduced.buyValue).toBe(6000);

    const job = await import("@/lib/jobs/mtf-accrual");
    const before = rowsOf(ACC).map((r) => [r.id, r.mtfInterest, r.chargesTotal, r.netPnl]);
    job.accrueMtfInterest("2026-05-10");
    const after = rowsOf(ACC);
    expect(after.find((r) => r.id === closed.id), "a closed row must not re-accrue").toEqual(closed);
    expectNoNaN(after);
    // Whatever it did to the open row, it did on the legs that row now states.
    const openAfter = after.filter((x) => x.isOpen);
    expect(openAfter.map((r) => [r.tradingsymbol, r.buyQty, r.buyValue])).toEqual([["NMDC", 60, 6000]]);
    for (const r of openAfter) expect(r.netPnl, "net stays gross minus charges").toBe(r2(r.grossPnl - r.chargesTotal));
    expect(after).toHaveLength(before.length);
  });
});

// ═══ 17 · the Account-#3 class — a manual, batchless book is never touched ══

describe("17 · a manual, batchless Dhan closed OPTION book survives byte-identical", () => {
  const ACC = 818; // holds the manual book
  const OTHER = 819; // the import lands here

  /** A hand-entered closed option position: no batch, no source file. */
  const manual = (over: Record<string, unknown>) =>
    tradeRow({
      accountId: ACC,
      broker: "dhan",
      bucket: "fno",
      segment: "option",
      instrumentType: "option",
      exchange: "NSE",
      symbol: "NIFTY",
      tradingsymbol: "NIFTY26MAY25000CE",
      optionType: "CE",
      strike: 25000,
      expiry: "2026-05-28",
      buyQty: 75,
      avgBuyPrice: 100,
      buyValue: 7500,
      sellQty: 75,
      avgSellPrice: 120,
      sellValue: 9000,
      buyDate: "2026-04-10",
      sellDate: "2026-04-20",
      grossPnl: 1500,
      chargesTotal: 42.17,
      netPnl: 1457.83,
      isOpen: false,
      importBatchId: null,
      sourceFile: null,
      ...over,
    });

  let before: Row[];

  it("the manual book is seeded, batchless, and closed", () => {
    newAccount(ACC, "manual-book");
    newAccount(OTHER, "importer");
    t.db.insert(t.schema.trades).values([
      manual({ dedupHash: "manual-opt-1" }),
      manual({ dedupHash: "manual-opt-2", tradingsymbol: "NIFTY26MAY25200PE", optionType: "PE", strike: 25200, netPnl: -300, grossPnl: -258, chargesTotal: 42 }),
    ] as never).run();
    before = rowsOf(ACC);
    expect(before).toHaveLength(2);
    expect(before.every((r) => r.importBatchId === null && !r.isOpen)).toBe(true);
  });

  it("an autoClose import into ANOTHER account leaves every column of every row identical", () => {
    const res = commit.commitParsedFile(
      parsed([
        buyRow("NIFTY26MAY25000CE", 75, 100, "2026-04-10", { productHint: null } as Partial<NormalizedTrade>),
        sellRow("NIFTY26MAY25000CE", 75, 130, "2026-04-21", { productHint: null } as Partial<NormalizedTrade>),
      ]),
      "other.csv", null, OTHER, AC,
    );
    expect(res.added).toBeGreaterThanOrEqual(0);
    expect(rowsOf(ACC), "invariant 8 — an account-scoped write never crosses the book").toEqual(before);
  });

  it("an autoClose import into the SAME account with no matching lot leaves them identical too", () => {
    const res = commit.commitParsedFile(
      parsed([sellRow("NIFTY26MAY25000CE", 75, 140, "2026-05-02", { productHint: null } as Partial<NormalizedTrade>)]),
      "same.csv", null, ACC, AC,
    );
    expect(res.autoClose, "a CLOSED row is not an open lot — there was nothing to close").toMatchObject({
      closedWhole: 0,
      reduced: 0,
      refusedNoDate: 0,
    });
    const after = rowsOf(ACC);
    expect(after).toHaveLength(3);
    expect(after.filter((r) => before.some((b) => b.id === r.id))).toEqual(before);
    expectNoNaN(after);
  });
});
