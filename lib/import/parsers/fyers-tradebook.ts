/**
 * Fyers **Tradebook report** (`.csv`) — v4.6.0 W9, VERIFIED against one real
 * owner export (2026-07-25 → 2026-08-25, 179 data rows; docs/BROKER_FORMATS.md
 * § Fyers). Layout:
 *
 *   rows 0-5  `Report Title,Tradebook report` · `Date Range,From dd/mm/yyyy to
 *             dd/mm/yyyy` · `Client Name,` · `Client ID,` · `PAN,` ·
 *             `Download Timestamp,… IST` — IDENTITY rows, read for nothing
 *   row 6     blank
 *   row 7     `Symbol name,Symbol code,Date & time,Side,Product type,Qty,
 *              Traded price,Total value,Segment,Exchange order ID,OMS order ID`
 *   rows 8+   one row per fill, NEWEST first
 *
 * THE BROKER'S NAME IS NOT IN THE CONTENT. Nothing inside the file says
 * "Fyers" — so the claim needs the name in the FILENAME (Fyers' own download
 * is `FYERS_tradebook_<client>_<from>_to_<to>.csv`) on top of the exact title
 * line and header. A file with the same header and no name is refused and
 * falls to the generic column mapper (AGENTS.md: no name, no claim).
 *
 * MIRROR ROWS ARE NOT TRADES. Every real fill carried overnight has a second
 * row of the OPPOSITE side, same quantity and price, stamped `12:00:00 AM`,
 * product `-`, and ids `NDIR…` instead of the exchange's numbers. On the real
 * export 81 of 179 rows are mirrors, and Fyers' own Realised P&L states buy
 * and sell quantities that equal the REAL rows only (21 of 21 symbols). A row
 * is a mirror only when ALL THREE signs are present; each is skipped and they
 * are counted in one warning line.
 *
 * IDENTICAL ROWS ARE SEPARATE FILLS. The order ids are printed in scientific
 * notation (`2.2E+15`) — unusable as identity — so two fills of the same
 * order at the same second and price are byte-identical rows. The P&L proves
 * they are both real (ANGELONE: 2 × 2,500 = 5,000 bought), so nothing here
 * ever collapses a row.
 *
 * Pairing is `zerodha.ts`'s tradebook rule: fills summed per symbol + product
 * + DAY + side into legs, `pairLegs` FIFO, every fill kept in `executions`.
 * The file states no charges; the engine estimates them.
 */

import Papa from "papaparse";
import { extractDate, extractTime } from "../time-parse";
import { fillSidesOf, isShortableSymbol, pairLegs, summarisePairing, type Leg } from "../pair-legs";
import { allocateSymbolLegs, executionsByAllocation, matchAllocations } from "../leg-allocation";
import type { Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { ParseContext, ParsedFile } from "../types";

export const FYERS_TRADEBOOK_SOURCE_ID = "fyers-tradebook";

/** The exact 11-column header of the verified export. */
export const FYERS_TRADEBOOK_HEADER = [
  "Symbol name", "Symbol code", "Date & time", "Side", "Product type", "Qty",
  "Traded price", "Total value", "Segment", "Exchange order ID", "OMS order ID",
] as const;

/** The phrase the preview shows beside an equity row (owner answer, 2026-09-25). */
export const FYERS_NUVAMA_EQUITY_UNVERIFIED =
  "Fyers/Nuvama equity row layout not yet verified against a real export";

const toNum = (v: unknown): number => {
  if (v == null) return 0;
  const x = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

function rowsOf(text: string): string[][] {
  return ((Papa.parse<string[]>(text, { skipEmptyLines: false }).data ?? []) as string[][])
    .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "").trim()) : []));
}

/** Index of the exact header row, or -1. Every one of the 11 cells, in order. */
export function fyersHeaderIndex(rows: string[][], header: readonly string[]): number {
  return rows.findIndex(
    (r) => r.length >= header.length && header.every((h, i) => (r[i] ?? "").toLowerCase() === h.toLowerCase()),
  );
}

/** The title line Fyers writes as line 0 of every report, e.g. `Report Title,Tradebook report`. */
export function fyersTitleIs(text: string, title: string): boolean {
  const first = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const cells = first.split(",").map((c) => c.trim().toLowerCase());
  return cells[0] === "report title" && cells[1] === title.toLowerCase();
}

/**
 * Detection. All three are required for the claim: the broker's NAME in the
 * filename (the content never states it), the title line, and the exact
 * header. Without the name the score is 0 — the generic mapper asks.
 */
export function detectFyersTradebook(ctx: ParseContext): number {
  const text = ctx.text;
  if (text == null || !text) return 0;
  if (!/fyers/i.test(ctx.filename)) return 0;
  if (!fyersTitleIs(text, "Tradebook report")) return 0;
  return fyersHeaderIndex(rowsOf(text).slice(0, 30), FYERS_TRADEBOOK_HEADER) >= 0 ? 0.95 : 0;
}

/** An exchange order id Fyers printed as a number (`2.2E+15`, `1100000012345`). */
const numericLike = (s: string) => /^\d+(?:\.\d+)?(?:e\+?\d+)?$/i.test(s.trim());

/**
 * A MIRROR row: product `-`, a non-numeric exchange order id (`NDIR…`), and a
 * `12:00:00 AM` stamp — all three. Exported for the tests that pin the rule.
 */
export function isFyersMirrorRow(product: string, exchangeOrderId: string, dateTime: string): boolean {
  return product.trim() === "-" && !numericLike(exchangeOrderId) && /\b12:00:00\s*AM\b/i.test(dateTime);
}

function legProductOf(raw: string): { leg: Leg["product"]; hint: ProductHint } {
  const p = raw.trim().toLowerCase();
  if (p === "overnight" || p === "cnc" || p === "margin") return { leg: "delivery", hint: "delivery" };
  if (p === "intraday") return { leg: "intraday", hint: "intraday" };
  return { leg: "unknown", hint: null };
}

export function parseFyersTradebook(ctx: ParseContext): ParsedFile {
  const base = { sourceId: FYERS_TRADEBOOK_SOURCE_ID, broker: "fyers" as const, format: "tradebook" };
  const rows = rowsOf(ctx.text ?? "");
  const h = fyersHeaderIndex(rows, FYERS_TRADEBOOK_HEADER);
  if (h < 0) {
    return { ...base, trades: [], warnings: ["Could not find the Fyers tradebook header (Symbol name, Symbol code, Date & time, Side, …) — is this a Fyers Tradebook report?"] };
  }

  type Group = {
    symbol: string;
    productRaw: string;
    hint: ProductHint;
    legs: Map<string, Leg>;
    /** Earliest fill time per leg — the file is NEWEST-first, so print order cannot sequence a day. */
    firstTime: Map<Leg, string>;
    /** Each leg's own fills — the ladder is cut from these by the quantity FIFO took. */
    fillsOf: Map<Leg, Execution[]>;
  };
  const groups = new Map<string, Group>();
  const warnings: string[] = [];
  const unreadable: string[] = [];
  let mirrors = 0;
  let fills = 0;
  let equityRows = 0;
  let valueDisagrees = 0;
  let dashNotMirror = 0;
  let unallocated = 0;

  for (const r of rows.slice(h + 1)) {
    if (!r.some((c) => c !== "")) continue;
    const [symbolName, , dateTime, sideRaw, productRaw, qtyRaw, priceRaw, totalRaw, segment, exchId] = r;
    const symbol = (symbolName ?? "").toUpperCase();
    if (!symbol) continue;

    if (isFyersMirrorRow(productRaw ?? "", exchId ?? "", dateTime ?? "")) {
      mirrors++;
      continue;
    }
    if ((productRaw ?? "").trim() === "-") dashNotMirror++;

    const side = /^b/i.test(sideRaw ?? "") ? "buy" : /^s/i.test(sideRaw ?? "") ? "sell" : null;
    const date = extractDate(dateTime);
    const qty = toNum(qtyRaw);
    const price = toNum(priceRaw);
    // Refuse, never coerce (AGENTS.md): a row with no readable side, date,
    // quantity or price cannot become a fill without inventing one of them.
    if (!side || !date || qty <= 0 || price <= 0) {
      unreadable.push(symbol);
      continue;
    }
    if (!/^derivatives$/i.test((segment ?? "").trim())) equityRows++;
    const total = toNum(totalRaw);
    if (total > 0 && Math.abs(total - qty * price) > 0.01) valueDisagrees++;

    const product = legProductOf(productRaw ?? "");
    const key = `${symbol}|${(productRaw ?? "").trim().toLowerCase()}`;
    const g = groups.get(key) ?? { symbol, productRaw: productRaw ?? "", hint: product.hint, legs: new Map<string, Leg>(), firstTime: new Map<Leg, string>(), fillsOf: new Map<Leg, Execution[]>() };
    const legKey = `${date}|${side}`;
    const leg = g.legs.get(legKey) ?? { symbol, side, date, qty: 0, value: 0, charges: 0, exchange: null, product: product.leg };
    leg.qty += qty;
    leg.value = r2(leg.value + qty * price);
    g.legs.set(legKey, leg);
    const time = extractTime(dateTime);
    const seen = g.firstTime.get(leg);
    if (time && (seen == null || time < seen)) g.firstTime.set(leg, time);
    g.fillsOf.set(leg, [...(g.fillsOf.get(leg) ?? []), { side, qty, price, date, time }]);
    groups.set(key, g);
    fills++;
  }

  const allLegs: Leg[] = [];
  const allPaired: ReturnType<typeof pairLegs> = [];
  const trades: NormalizedTrade[] = [];
  for (const g of groups.values()) {
    // pair-legs reads a day's SEQUENCE off the order legs arrive in (a sell
    // before a buy on one day is a covered intraday short). The file prints
    // newest first, so legs are handed over in TIME order: date, then each
    // leg's earliest fill. In print order every same-day long round trip read
    // as a short (5 on the real export).
    const legs = [...g.legs.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || (g.firstTime.get(a) ?? "99:99").localeCompare(g.firstTime.get(b) ?? "99:99"),
    );
    // v4.6.0 W6: a derivative can be carried short overnight (pair-legs.ts header).
    const shortable = legs.length > 0 && isShortableSymbol(legs[0].symbol);
    const paired = pairLegs(legs, { shortable });
    allLegs.push(...legs);
    allPaired.push(...paired);
    // Each leg's fills oldest-first (the file is newest-first), then cut per
    // position by the quantity FIFO took from each leg (lib/import/leg-allocation.ts):
    // Σ executions per side = the position's qty (invariant 5). A date-window
    // filter over-counted every day-leg split across two positions.
    for (const [leg, fs] of g.fillsOf) g.fillsOf.set(leg, [...fs].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "")));
    const allocs = allocateSymbolLegs(legs, { shortable });
    const cut = executionsByAllocation(allocs, g.fillsOf);
    const matched = matchAllocations(paired, allocs);
    paired.forEach((pos, i) => {
      const a = matched[i];
      if (!a) unallocated++;
      const executions = a ? cut.get(a) ?? [] : [];
      const fillSide = fillSidesOf(pos);
      trades.push({
        broker: "fyers",
        tradingsymbol: pos.symbol,
        isin: null,
        buyQty: pos.buyQty,
        avgBuyPrice: pos.buyQty > 0 ? r2(pos.buyValue / pos.buyQty) : 0,
        buyValue: pos.buyValue,
        sellQty: pos.sellQty,
        avgSellPrice: pos.sellQty > 0 ? r2(pos.sellValue / pos.sellQty) : 0,
        sellValue: pos.sellValue,
        closingPrice: null,
        // Only a CLOSED position has a knowable P&L (invariant 6).
        grossPnl: pos.kind === "closed" ? r2(pos.sellValue - pos.buyValue) : 0,
        unrealisedPnl: 0,
        buyDate: pos.buyDate,
        sellDate: pos.sellDate,
        entryTime: executions.find((e) => e.side === fillSide.entry)?.time ?? null,
        exitTime: [...executions].reverse().find((e) => e.side === fillSide.exit)?.time ?? null,
        productHint: g.hint,
        // No exchange column: the classifier resolves SENSEX/BANKEX to BSE and
        // everything else to NSE from the contract name itself.
        exchangeHint: null,
        sourceFile: ctx.filename,
        executions: executions.length > 0 ? executions : null,
        basisUnknown: pos.basisUnknown,
        importNotes: pos.notes.length > 0 ? pos.notes : null,
        side: pos.side,
      });
    });
  }

  const check = summarisePairing(allLegs, allPaired);
  warnings.push(`${fills} fill${fills === 1 ? "" : "s"} → ${trades.length} position${trades.length === 1 ? "" : "s"} (FIFO per symbol + product + day). The file states no charges; Vyuha's rate card estimates them.`);
  if (mirrors > 0) {
    warnings.push(
      `${mirrors} mirror row${mirrors === 1 ? " was" : "s were"} skipped: Fyers prints each carried-over fill a second time at 12:00:00 AM with the opposite side, product "-" and an NDIR… id. They are not trades — Fyers' own Realised P&L counts the real rows only.`,
    );
  }
  if (equityRows > 0) {
    warnings.push(`${equityRows} equity row${equityRows === 1 ? "" : "s"} read — ${FYERS_NUVAMA_EQUITY_UNVERIFIED}. Check ${equityRows === 1 ? "it" : "them"} against your contract note.`);
  }
  if (dashNotMirror > 0) {
    warnings.push(`${dashNotMirror} row${dashNotMirror === 1 ? "" : "s"} carried product "-" without the rest of the mirror signature and ${dashNotMirror === 1 ? "was" : "were"} imported as fills with no product.`);
  }
  if (valueDisagrees > 0) {
    warnings.push(`${valueDisagrees} row${valueDisagrees === 1 ? "" : "s"} state a Total value that differs from Qty × Traded price by more than ₹0.01 — Vyuha used Qty × Traded price.`);
  }
  if (unreadable.length > 0) {
    warnings.push(`${unreadable.length} row${unreadable.length === 1 ? "" : "s"} had no readable side, date, quantity or price and ${unreadable.length === 1 ? "was" : "were"} refused rather than guessed: ${[...new Set(unreadable)].slice(0, 5).join(", ")}.`);
  }
  if (check.openingSells > 0) {
    warnings.push(`${check.openingSells} sell${check.openingSells === 1 ? " had" : "s had"} no matching buy in this file — bought before the export window; cost basis unknown, P&L left blank until you supply it.`);
  }
  if (unallocated > 0) {
    warnings.push(`${unallocated} position${unallocated === 1 ? "" : "s"} could not be traced to the fills behind ${unallocated === 1 ? "it" : "them"}, so ${unallocated === 1 ? "it carries" : "they carry"} no execution ladder — please report this file.`);
  }
  if (!check.conserved) {
    warnings.push(`Pairing conservation check FAILED (qty delta ${check.qtyDelta}, value delta ${check.valueDelta} against a ${check.valueTolerance} rounding tolerance) — please report this file.`);
  }

  return { ...base, trades, sourceRows: fills, warnings };
}
