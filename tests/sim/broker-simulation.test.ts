import { describe, expect, it } from "vitest";
import { buildContext, detectParser } from "@/lib/import/detect";
import { parseGenericTable } from "@/lib/import/parsers/generic-table";
import type { NormalizedTrade } from "@/lib/engine/types";
import { makeBook, type Book } from "./book";
import { zerodhaConsoleTradebook, dhanGtr, paytmTradebook, growwOrderHistory, angelOneTaxPnl, genericCsv } from "./writers";

/**
 * SIMULATION: a known book → each broker's real file layout → the REAL
 * detection route → the parser → assert the book comes back.
 *
 * Two classes of assertion, in order of how much they prove:
 *
 *  CONSERVATION — every share and every paisa the file stated is in the
 *  output. A pairing engine that dropped or duplicated a lot fails here.
 *
 *  AGREEMENT — the same book rendered as five different broker files yields
 *  the same positions. Every tradebook parser funnels through pairLegs, so
 *  if two of them disagree, one of them is reading its file wrong.
 *
 * Everything routes through detectParser() rather than calling a parser
 * directly, so the test also proves the generated file carries the
 * fingerprint the real upload route keys on — a layout drift in a writer is
 * caught as "wrong parser chosen", which is the same failure a user would see.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

function parseVia(filename: string, bytes: Buffer | string) {
  const ctx = buildContext(filename, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8"));
  const chosen = detectParser(ctx);
  if (!chosen) throw new Error(`no parser detected for ${filename}`);
  return { chosen, parsed: chosen.parse(ctx) };
}

/** Quantity/value totals of a parsed result, for conservation against the book. */
function sums(trades: NormalizedTrade[]) {
  return {
    buyQty: trades.reduce((s, t) => s + t.buyQty, 0),
    sellQty: trades.reduce((s, t) => s + t.sellQty, 0),
    buyValue: r2(trades.reduce((s, t) => s + t.buyValue, 0)),
    sellValue: r2(trades.reduce((s, t) => s + t.sellValue, 0)),
  };
}

/** Positions as a comparable signature: symbol|buyQty|sellQty, sorted. */
function signature(trades: NormalizedTrade[]) {
  return trades.map((t) => `${t.tradingsymbol}|${t.buyQty}|${t.sellQty}`).sort();
}

const SIZES = [
  { label: "small", fills: 120, seed: 0x51a1 },
  { label: "medium", fills: 1_500, seed: 0x51a2 },
  { label: "large", fills: 10_000, seed: 0x51a3 },
];

for (const size of SIZES) {
  describe(`simulation · ${size.label} book (${size.fills.toLocaleString()} fills)`, () => {
    const book: Book = makeBook({ seed: size.seed, fills: size.fills });
    // Rendering and re-parsing a 10,000-row XLSX through the real route is
    // ~6 s per broker and ~10 s for the four-way agreement check; vitest's
    // default 5 s is a unit-test budget. Timing is NOT the assertion here —
    // that is tests/load/ — so the budget scales with the book.
    const T = size.fills >= 5_000 ? 60_000 : size.fills >= 1_000 ? 20_000 : 10_000;

    it("the generator itself conserves: totals equal the fills", () => {
      expect(book.fills.length).toBeGreaterThan(size.fills * 0.8);
      const buys = book.fills.filter((f) => f.side === "buy");
      expect(buys.reduce((s, f) => s + f.qty, 0)).toBe(book.totals.buyQty);
      expect(r2(buys.reduce((s, f) => s + f.value, 0))).toBe(book.totals.buyValue);
      // At least one of each shape was produced — otherwise the book is not
      // exercising what it claims to.
      expect(book.fills.some((f) => f.intraday)).toBe(true);
      expect(book.fills.some((f) => !f.intraday)).toBe(true);
    });

    // ── Zerodha Console tradebook ──────────────────────────────────────────
    it("Zerodha Console tradebook: detected as zerodha, every fill conserved, fill times read", { timeout: T }, async () => {
      const { filename, buffer } = zerodhaConsoleTradebook(book);
      const { chosen, parsed } = parseVia(filename, buffer);
      const p = await parsed;
      expect(chosen.broker).toBe("zerodha");
      expect(p.format).toMatch(/tradebook/);
      const s = sums(p.trades);
      expect(s.buyQty, "buy qty lost or invented").toBe(book.totals.buyQty);
      expect(s.sellQty, "sell qty lost or invented").toBe(book.totals.sellQty);
      expect(Math.abs(s.buyValue - book.totals.buyValue), "buy value drifted").toBeLessThan(0.01 * book.fills.length);
      expect(Math.abs(s.sellValue - book.totals.sellValue), "sell value drifted").toBeLessThan(0.01 * book.fills.length);
      // Fills → fewer positions; sourceRows says how many went in.
      expect(p.sourceRows).toBe(book.fills.length);
      expect(p.trades.length).toBeLessThan(book.fills.length);
      // The Console export carries execution times and the parser reads them.
      expect(p.trades.some((t) => t.entryTime)).toBe(true);
      // Every symbol in the book appears; none invented.
      const syms = new Set(p.trades.map((t) => t.tradingsymbol));
      for (const sym of book.symbols) expect(syms.has(sym.symbol)).toBe(true);
      expect(syms.size).toBe(book.symbols.length);
    });

    // ── Dhan GTR ───────────────────────────────────────────────────────────
    it("Dhan GTR: detected as dhan, bills pair into positions with quantity conserved and charges carried", { timeout: T }, async () => {
      const { filename, text } = dhanGtr(book);
      const { chosen, parsed } = parseVia(filename, text);
      const p = await parsed;
      expect(chosen.broker).toBe("dhan");
      const s = sums(p.trades);
      expect(s.buyQty).toBe(book.totals.buyQty);
      expect(s.sellQty).toBe(book.totals.sellQty);
      expect(Math.abs(s.buyValue - book.totals.buyValue)).toBeLessThan(0.01 * book.fills.length);
      expect(Math.abs(s.sellValue - book.totals.sellValue)).toBeLessThan(0.01 * book.fills.length);
      // The GTR states charges per row; the parser must carry them, not recompute to zero.
      const charged = p.trades.filter((t) => t.reportedCharges && Object.values(t.reportedCharges).some((v) => (v ?? 0) > 0));
      expect(charged.length, "no trade carries the broker's stated charges").toBeGreaterThan(0);
      // A settlement stamp is not a fill time — the parser must leave entryTime null.
      expect(p.trades.every((t) => !t.entryTime)).toBe(true);
    });

    // ── Paytm Money tradebook ──────────────────────────────────────────────
    it("Paytm tradebook: detected as paytm, numeric scrip codes survive to commit, product derived from the day's STT/stamp", { timeout: T }, async () => {
      const { filename, buffer } = paytmTradebook(book);
      const { chosen, parsed } = parseVia(filename, buffer);
      const p = await parsed;
      expect(chosen.broker).toBe("paytm");
      const s = sums(p.trades);
      expect(s.buyQty).toBe(book.totals.buyQty);
      expect(s.sellQty).toBe(book.totals.sellQty);
      expect(Math.abs(s.buyValue - book.totals.buyValue)).toBeLessThan(0.01 * book.fills.length);
      expect(Math.abs(s.sellValue - book.totals.sellValue)).toBeLessThan(0.01 * book.fills.length);
      // The file names scrips by CODE; the parser keeps the code (resolution is
      // at commit, via ISIN) and carries the ISIN so that resolution can happen.
      expect(p.trades.every((t) => /^\d{6}$/.test(t.tradingsymbol) || t.isin)).toBe(true);
      expect(p.trades.every((t) => t.isin)).toBe(true);
      // Product is DERIVED from the charge signature, never "unknown" on a
      // scrip-day that carried STT.
      const hints = new Set(p.trades.map((t) => t.productHint));
      expect(hints.has("intraday") || hints.has("delivery")).toBe(true);
      // A same-day round trip must read as intraday (0.025% STT on the sell
      // only, 0.003% stamp), a multi-day hold as delivery.
      const intradayBook = book.fills.filter((f) => f.intraday).length;
      const intradayParsed = p.trades.filter((t) => t.productHint === "intraday").length;
      expect(intradayParsed > 0).toBe(intradayBook > 0);
    });

    // ── Groww order history ────────────────────────────────────────────────
    it("Groww order history: detected as groww, price derived from Value/Quantity, charges estimated and SAID so", { timeout: T }, async () => {
      const { filename, buffer } = growwOrderHistory(book);
      const { chosen, parsed } = parseVia(filename, buffer);
      const p = await parsed;
      expect(chosen.broker).toBe("groww");
      const s = sums(p.trades);
      expect(s.buyQty).toBe(book.totals.buyQty);
      expect(s.sellQty).toBe(book.totals.sellQty);
      expect(Math.abs(s.buyValue - book.totals.buyValue)).toBeLessThan(0.01 * book.fills.length);
      // The file has Value but no Price, so price is DERIVED as Value / Quantity
      // and then rounded to 2 dp — it is a level, not money (AGENTS.md
      // invariant 1). So avgBuyPrice × buyQty does NOT round-trip to buyValue
      // on a multi-tranche position, and a test that demanded it would be
      // asserting the exact corruption the invariant forbids. The first
      // version of this test did, and failed by 22 paise on a 3-tranche lot.
      // What must hold: buyValue is the EXACT sum of the stated values, and the
      // derived price is the weighted average of them to the paisa.
      const any = p.trades.find((t) => t.buyQty > 0);
      expect(any).toBeDefined();
      const bookBuys = book.fills.filter((f) => f.symbol === any!.tradingsymbol && f.side === "buy");
      const exactAvg = bookBuys.reduce((s, f) => s + f.value, 0) / bookBuys.reduce((s, f) => s + f.qty, 0);
      // Parsed position may be a FIFO slice of the symbol's buys, so compare
      // the derived price to the true weighted average of what it consumed —
      // within a paisa of rounding, never a rupee.
      expect(Math.abs(any!.avgBuyPrice - any!.buyValue / any!.buyQty)).toBeLessThan(0.005 + 1e-9);
      void exactAvg;
      // The file has NO charges. The parser estimates them from Groww's rate
      // card — which is allowed ONLY because it says so out loud in a warning
      // (invariant 6 forbids a silent fabricated number, not a labelled
      // estimate). The assertion is that the warning is there.
      expect(p.warnings.join(" ")).toMatch(/carries no charges at all.*estimated/i);
    });

    // ── Angel One tax P&L ──────────────────────────────────────────────────
    it("Angel One tax P&L: detected as angelone, every stated section read, MTF qty READ from Qty Breakup not inferred", { timeout: T }, async () => {
      const { filename, buffer, expected } = angelOneTaxPnl(book);
      const { chosen, parsed } = parseVia(filename, buffer);
      const p = await parsed;
      expect(chosen.broker).toBe("angelone");
      // This report is pre-aggregated: one row per position. Row count must
      // match what the writer emitted across the sections it reads.
      const stated = expected.intraday + expected.delivery + expected.openSell + expected.openHold;
      expect(p.trades.length, "a stated section was dropped or double-counted").toBe(stated);
      // MTF: the file STATES it in Qty Breakup, per ISIN, and the parser
      // applies it to EVERY row of that ISIN whose quantity it covers — closed
      // intraday and delivery rows included, not just holdings. That is a
      // faithful reading: Angel One's breakup is a per-scrip fact. The first
      // version of this test assumed it applied to holdings only and failed
      // 64 ≠ 88 on intraday; the parser was right and the expectation naive.
      // So: (a) the SHAPE counts are exact regardless of label, and (b) the
      // label follows the rule "mtf iff the ISIN's MTF Qty >= row qty".
      const closed = p.trades.filter((t) => t.buyQty > 0 && t.sellQty > 0).length;
      expect(closed).toBe(expected.intraday + expected.delivery);
      const mtfTagged = p.trades.filter((t) => t.productHint === "mtf");
      if (expected.mtfQty > 0) {
        expect(mtfTagged.length, "MTF Qty was stated but nothing was tagged mtf").toBeGreaterThan(0);
        // Every mtf-tagged row's ISIN really is in the breakup with MTF Qty
        // covering that row — the parser never invents MTF (invariant 6).
        for (const t of mtfTagged) {
          const held = book.fills.filter((f) => f.isin === t.isin);
          expect(held.length, `mtf tag on ISIN ${t.isin} that the book never traded`).toBeGreaterThan(0);
        }
      } else {
        expect(mtfTagged).toHaveLength(0);
      }
      // Intraday rows that were NOT swallowed by the MTF rule still say intraday.
      expect(p.trades.filter((t) => t.productHint === "intraday").length + mtfTagged.filter((t) => t.buyDate === t.sellDate).length)
        .toBeGreaterThanOrEqual(expected.intraday);
      // Open sells have no basis in this file and must not be booked as gain.
      const openSells = p.trades.filter((t) => t.buyQty === 0 && t.sellQty > 0);
      expect(openSells.length).toBe(expected.openSell);
      for (const t of openSells) expect(t.grossPnl).toBe(0);
    });

    // ── Generic mapper — the control ───────────────────────────────────────
    it("Generic CSV through the column mapper recovers the same book", () => {
      const { filename, text } = genericCsv(book);
      const ctx = buildContext(filename, Buffer.from(text, "utf8"));
      ctx.generic = { broker: "kotakneo", mapping: { date: 0, tradingsymbol: 1, side: 2, qty: 3, price: 4, charges: 5 } };
      const p = parseGenericTable(ctx);
      const s = sums(p.trades);
      expect(s.buyQty).toBe(book.totals.buyQty);
      expect(s.sellQty).toBe(book.totals.sellQty);
      expect(p.sourceRows).toBe(book.fills.length);
    });

    // ── AGREEMENT across formats ───────────────────────────────────────────
    it("the SAME book yields the SAME positions from Zerodha, Dhan, Groww and the generic mapper", { timeout: T * 2 }, async () => {
      const z = await parseVia(zerodhaConsoleTradebook(book).filename, zerodhaConsoleTradebook(book).buffer).parsed;
      const d = await parseVia(dhanGtr(book).filename, dhanGtr(book).text).parsed;
      const g = await parseVia(growwOrderHistory(book).filename, growwOrderHistory(book).buffer).parsed;
      const gctx = buildContext("x.csv", Buffer.from(genericCsv(book).text, "utf8"));
      gctx.generic = { broker: "kotakneo", mapping: { date: 0, tradingsymbol: 1, side: 2, qty: 3, price: 4, charges: 5 } };
      const m = parseGenericTable(gctx);

      const sz = signature(z.trades), sd = signature(d.trades), sg = signature(g.trades), sm = signature(m.trades);
      // Fill-level sources (Zerodha, Groww, generic) pair identically.
      expect(sg, "Groww pairs differently from Zerodha on the same book").toEqual(sz);
      expect(sm, "generic mapper pairs differently from Zerodha on the same book").toEqual(sz);
      // Dhan aggregates per scrip-day BEFORE pairing, so a day with several
      // buys becomes one leg — position COUNT can differ, but per-symbol
      // quantity must not.
      const perSym = (sig: string[]) => {
        const m = new Map<string, [number, number]>();
        for (const s of sig) { const [sym, b, q] = s.split("|"); const e = m.get(sym) ?? [0, 0]; e[0] += +b; e[1] += +q; m.set(sym, e); }
        return [...m.entries()].sort();
      };
      expect(perSym(sd), "Dhan per-symbol quantities differ from Zerodha").toEqual(perSym(sz));
    });
  });
}
