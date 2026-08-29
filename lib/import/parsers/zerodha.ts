import Papa from "papaparse";
import * as XLSX from "xlsx";
import { extractDate, extractTime } from "../time-parse";
import { pairLegs, summarisePairing, type Leg } from "../pair-legs";
import type { Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import type { ParseContext, ParsedFile } from "../types";

const toNum = (v: unknown): number => {
  if (v == null) return 0;
  const x = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};

const norm = (s: string) => s.toLowerCase().replace(/[\s_.]/g, "");

/** Convert a CSV/XLSX file into a matrix of rows. */
function toMatrix(ctx: ParseContext): string[][] {
  if (ctx.text != null) {
    return (Papa.parse<string[]>(ctx.text, { skipEmptyLines: true }).data ?? []).map((r) =>
      r.map((c) => String(c ?? "")),
    );
  }
  if (ctx.buffer) {
    const wb = XLSX.read(ctx.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]!];
    return (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" }) as unknown[][]).map(
      (r) => r.map((c) => String(c ?? "")),
    );
  }
  return [];
}

/** Find the header row index (first row that contains a recognizable column).
 *
 *  Scans 100 rows, not 25: the Console P&L opens with a preamble, a summary
 *  block and the full charges ledger before its trade table, and on a real
 *  export (verified 2026-08-12) the header sits past row 25. At 25 this
 *  function missed it, detection fell into the no-header clamp, and Zerodha's
 *  own P&L was claimed at 0.30 by accident of its filename. */
function findHeader(rows: string[][]): number {
  const wanted = ["symbol", "tradingsymbol", "trade type", "trade_type", "isin", "quantity"];
  for (let i = 0; i < Math.min(rows.length, 100); i++) {
    const cells = rows[i].map(norm);
    if (wanted.some((w) => cells.includes(norm(w)))) return i;
  }
  return -1;
}

function colFinder(header: string[]) {
  const idx = header.map(norm);
  return (...cands: string[]): number => {
    for (const c of cands) {
      const i = idx.indexOf(norm(c));
      if (i >= 0) return i;
    }
    return -1;
  };
}

/**
 * Detection. THE RULE (AGENTS.md): a broker-named parser must see the broker's
 * NAME before it claims a file — in the filename or as an in-content
 * fingerprint no other broker emits. This detector used to score on column
 * SHAPE (`symbol`+`isin` = 0.30, the word "tradebook" in a filename = 0.35),
 * and on 2026-08-12 that claimed a Groww order-history export AND a Paytm
 * Money tradebook as Zerodha, importing one of them priced at Zerodha's
 * rates. Shape is common to every Indian broker; it now only refines a score
 * after the file has qualified.
 *
 * Fingerprints, each verified against a real export (docs/BROKER_FORMATS.md):
 *   - Tradebook: the `Auction` column — no other broker emits it — or the
 *     `Trade ID` + `Order ID` pair.
 *   - Console P&L: charge account heads suffixed "- Z" ("Brokerage - Z",
 *     "Central GST - Z", … 9 heads on a real export).
 */
export function detectZerodha(ctx: ParseContext): number {
  // Only strings that actually name the broker. "tradebook" and "console" are
  // generic English — Paytm's export is literally called "… - Tradebook.xlsx".
  const named = /zerodha|kite/i.test(ctx.filename);
  const rows = toMatrix(ctx);
  const h = findHeader(rows);
  if (h < 0) {
    // A named file with no readable table still routes here so the parser can
    // say "no recognizable header" by name, rather than the mapper offering
    // columns that do not exist.
    return named ? 0.3 : 0;
  }
  const cells = rows[h].map(norm);

  const tradebookFp =
    cells.includes("auction") || (cells.includes("tradeid") && cells.includes("orderid"));
  // The "- Z" heads live in the charges block, one per ROW ("Brokerage - Z" /
  // "Central GST - Z" / …), not in the trade-table header — so this counts
  // across the sheet, bounded. Two are required: one "- Z"-suffixed label
  // could be anyone's abbreviation; a column of them is Zerodha's Console.
  const consoleFp =
    rows
      .slice(0, 100)
      .flat()
      .filter((c) => /\s-\s?Z$/.test(String(c).trim())).length >= 2;

  if (!named && !tradebookFp && !consoleFp) return 0; // No name, no fingerprint, no claim.

  // The FINGERPRINT carries the claim on its own — the filename only adds to
  // it. Real Console exports are named "Tradebook_EQ…" / "statement…" and name
  // no broker, so a fingerprint weighted below the 0.7 routing threshold left
  // the real files under-scored (measured 2026-08-20: tradebook 0.65, Console
  // P&L 0.55 under a neutral filename) while their redacted, broker-named
  // copies routed fine. Neither `Auction`/`Trade ID`+`Order ID` nor a column of
  // "- Z" charge heads appears in any other broker's export.
  let score = named ? 0.35 : 0;
  if (tradebookFp) score += 0.5;
  if (consoleFp) score += 0.55;
  // Shape refines a qualified score; it can no longer create one.
  if (cells.includes("tradingsymbol") || (cells.includes("symbol") && cells.includes("isin")))
    score += 0.15;
  if (cells.includes("tradetype") && cells.includes("orderid")) score += 0.1;
  return Math.min(1, score);
}

function exchangeFrom(raw: string): Exchange | null {
  const s = norm(raw);
  if (!s) return null;
  if (s.startsWith("mcx")) return "MCX";
  if (s.startsWith("bse") || s.startsWith("bfo")) return "BSE";
  if (s.startsWith("nse") || s.startsWith("nfo") || s.startsWith("cds")) return "NSE";
  return null;
}

function productHint(raw: string): ProductHint {
  const s = norm(raw);
  if (s === "cnc") return "delivery";
  if (s === "mis") return "intraday";
  if (s === "mtf") return "mtf";
  return null; // NRML (F&O) → let the classifier decide from the name
}

/**
 * Zerodha importer. Supports:
 *  - Tradebook (granular, one row per execution with Trade Type buy/sell) →
 *    paired FIFO per tradingsymbol+product into positions.
 *  - Console P&L (already aggregated) → mapped directly.
 *
 * ── Why FIFO pairing and not whole-file aggregation (2026-08-20) ────────────
 *
 * This branch used to sum every fill of a symbol into ONE row and set
 * grossPnl = sellValue − buyValue. On a real Console tradebook (1,554 fills,
 * Apr–Jun) that produced 23 rows of which 8 were sell-only — holdings bought
 * before the export window — and each of those was booked as 100 % profit
 * because buyValue was zero. That is the fabrication invariant 6 forbids, and
 * it came to ≈₹31 lakh of invented P&L. Every row also carried the FIRST
 * fill's date as BOTH buyDate and sellDate, so 10 of 23 positions reported a
 * zero-day hold they never had.
 *
 * `pairLegs` (lib/import/pair-legs.ts) is the same FIFO used by the Groww
 * order-history parser: an unmatched sell becomes an `opening-sell` with
 * `basisUnknown` and NO P&L, leftover buys become `open`, and re-entries in
 * one symbol become separate positions with their own real dates.
 *
 * Note: Zerodha F&O tradingsymbols (e.g. NIFTY26JUN24500CE) are not Dhan-style; the
 * classifier will treat unrecognized symbols as equity — re-tag F&O in Trades until a
 * real Zerodha F&O sample is available to pin the exact symbol grammar.
 */
export function parseZerodha(ctx: ParseContext): ParsedFile {
  const rows = toMatrix(ctx);
  const h = findHeader(rows);
  if (h < 0) {
    return {
      sourceId: "zerodha",
      broker: "zerodha",
      format: "unknown",
      trades: [],
      warnings: ["Could not find a recognizable header row in the Zerodha file."],
    };
  }
  const header = rows[h];
  const find = colFinder(header);
  const dataRows = rows.slice(h + 1).filter((r) => r.some((c) => c.trim() !== ""));

  const cTradeType = find("trade type", "trade_type", "type");
  const cSymbol = find("tradingsymbol", "symbol", "scrip", "instrument");
  const cIsin = find("isin");
  const cQty = find("quantity", "qty");
  const cPrice = find("price", "trade price", "average price", "avg price");
  const cProduct = find("product", "product type");
  const cExch = find("exchange", "segment");
  const cDate = find("trade date", "order execution time", "date", "trade_date");
  // The fill CLOCK lives in its own column on the real Console export
  // ("Order Execution Time", "2026-04-01 11:14:28"); "Trade Date" there is a
  // bare date, so reading the time off it yields null and loses every fill
  // time in the file. Looked up separately, with the date cell as fallback
  // for exports that put a full timestamp in the date column.
  const cTime = find("order execution time", "trade time", "execution time", "order_execution_time");

  const warnings: string[] = [];

  if (cTradeType >= 0) {
    // ---- Tradebook: FIFO-pair per tradingsymbol + product ----
    const r2 = (n: number) => Math.round(n * 100) / 100;

    // A LEG is a scrip-DAY, not a fill.
    //
    // `pairSymbolLegs` emits one closed position per SELL leg and one open per
    // leftover BUY leg, so feeding it raw fills makes an SME tradebook that
    // fills 11 + 2 + 2 + 3 shares at a time report hundreds of "trades" nobody
    // took (measured 2026-08-20: 1,554 fills → 936 positions). The Dhan GTR
    // parser's legs are per BILL — one scrip-day — and that is the honest unit
    // here too: fills are summed per symbol|product|date|side BEFORE pairing,
    // while every individual fill survives in `executions` for the ladder.
    type Group = {
      symbol: string;
      productRaw: string;
      isin: string | null;
      /** Keyed `date|side` — one leg per scrip-day-side. */
      legs: Map<string, Leg>;
      fills: Execution[];
    };
    const groups = new Map<string, Group>();
    const unreadable: string[] = [];
    let fillCount = 0;

    for (const r of dataRows) {
      const symbol = (r[cSymbol] ?? "").trim();
      if (!symbol) continue;

      const productRaw = cProduct >= 0 ? (r[cProduct] ?? "").trim() : "";
      const key = `${symbol}|${norm(productRaw)}`;

      const dateCell = cDate >= 0 ? r[cDate] || null : null;
      const timeCell = cTime >= 0 ? r[cTime] || null : null;
      const qty = toNum(r[cQty]);
      const price = toNum(r[cPrice]);
      const rawSide = norm(cTradeType >= 0 ? r[cTradeType] : "");
      const side = rawSide.startsWith("b") ? "buy" : rawSide.startsWith("s") ? "sell" : null;
      const date = extractDate(dateCell) ?? extractDate(timeCell);

      // Refuse, never coerce (AGENTS.md): a row with no readable side, date,
      // quantity or price cannot become a fill without inventing one of them.
      if (!side || !date || qty <= 0 || price <= 0) {
        unreadable.push(symbol);
        continue;
      }

      const g = groups.get(key) ?? {
        symbol,
        productRaw,
        isin: cIsin >= 0 ? r[cIsin] || null : null,
        legs: new Map<string, Leg>(),
        fills: [],
      };
      if (!g.isin && cIsin >= 0 && r[cIsin]) g.isin = r[cIsin];

      const p = norm(productRaw);
      // MTF has no counterpart in pairLegs' product union; the group key keeps
      // it separate and the column supplies the hint further down.
      const legProduct: Leg["product"] =
        p === "cnc" ? "delivery" : p === "mis" ? "intraday" : "unknown";

      const legKey = `${date}|${side}`;
      const existing = g.legs.get(legKey);
      if (existing) {
        existing.qty += qty;
        existing.value = r2(existing.value + qty * price);
      } else {
        g.legs.set(legKey, {
          symbol,
          side,
          date,
          qty,
          value: r2(qty * price),
          charges: 0,
          exchange: cExch >= 0 ? (r[cExch] || "").trim() || null : null,
          product: legProduct,
        });
      }
      fillCount += 1;
      g.fills.push({
        side,
        qty,
        price,
        date,
        time: extractTime(timeCell) ?? extractTime(dateCell),
      });
      groups.set(key, g);
    }

    const allLegs: Leg[] = [];
    const allPaired: ReturnType<typeof pairLegs> = [];
    const trades: NormalizedTrade[] = [];

    for (const g of groups.values()) {
      const dayLegs = [...g.legs.values()];
      const paired = pairLegs(dayLegs);
      allLegs.push(...dayLegs);
      allPaired.push(...paired);

      for (const pos of paired) {
        // Product is STATED when the export carries the column; the real
        // Console tradebook does not, so it is derived from the calendar and
        // flagged — a derived fact never wears a reported fact's clothes.
        const stated = cProduct >= 0 ? productHint(g.productRaw) : null;
        const sameDay = pos.kind === "closed" && pos.buyDate != null && pos.buyDate === pos.sellDate;
        const hint: ProductHint = cProduct >= 0 ? stated : sameDay ? "intraday" : "delivery";

        // Each position sees only the fills inside its own window, so a staged
        // ladder is rebuilt from its own executions rather than the symbol's
        // whole history. Approximate for re-entered symbols; totals stay exact.
        const executions = g.fills.filter(
          (e) =>
            (pos.buyDate == null || (e.date ?? "") >= pos.buyDate) &&
            (pos.sellDate == null || (e.date ?? "") <= pos.sellDate),
        );

        trades.push({
          broker: "zerodha",
          tradingsymbol: pos.symbol,
          isin: g.isin,
          buyQty: pos.buyQty,
          avgBuyPrice: pos.buyQty > 0 ? r2(pos.buyValue / pos.buyQty) : 0,
          buyValue: pos.buyValue,
          sellQty: pos.sellQty,
          avgSellPrice: pos.sellQty > 0 ? r2(pos.sellValue / pos.sellQty) : 0,
          sellValue: pos.sellValue,
          closingPrice: null,
          // Only a CLOSED position has a knowable P&L. An opening sell has no
          // purchase price anywhere in the file, so zero is the honest answer
          // and `basisUnknown` says why.
          grossPnl: pos.kind === "closed" ? r2(pos.sellValue - pos.buyValue) : 0,
          unrealisedPnl: 0,
          buyDate: pos.buyDate,
          sellDate: pos.sellDate,
          entryTime: executions.find((e) => e.side === "buy")?.time ?? null,
          exitTime: [...executions].reverse().find((e) => e.side === "sell")?.time ?? null,
          productHint: hint,
          exchangeHint: exchangeFrom(pos.exchange ?? ""),
          sourceFile: ctx.filename,
          executions: executions.length > 0 ? executions : null,
          basisUnknown: pos.basisUnknown,
          ...(cProduct >= 0 ? {} : { productDerived: true }),
          importNotes: pos.notes.length > 0 ? pos.notes : null,
        });
      }
    }

    const check = summarisePairing(allLegs, allPaired);

    warnings.push(
      `${fillCount} fill${fillCount === 1 ? "" : "s"} → ${trades.length} position${trades.length === 1 ? "" : "s"} (FIFO per symbol + day). Verify F&O classification.`,
    );
    if (cProduct < 0) {
      warnings.push(
        "This tradebook has no Product column — delivery vs intraday is DERIVED from same-day round trips, and MTF cannot be identified at all. Confirm any delivery rows that were actually MTF.",
      );
    }
    if (unreadable.length > 0) {
      warnings.push(
        `${unreadable.length} row${unreadable.length === 1 ? "" : "s"} had no readable trade type, date, quantity or price and ${unreadable.length === 1 ? "was" : "were"} refused rather than guessed: ${[...new Set(unreadable)].slice(0, 5).join(", ")}.`,
      );
    }
    if (check.openingSells > 0) {
      warnings.push(
        `${check.openingSells} sell${check.openingSells === 1 ? " had" : "s had"} no matching buy in this file — acquired before the export window; cost basis unknown, P&L left blank until you supply it.`,
      );
    }
    if (!check.conserved) {
      warnings.push(
        `Pairing conservation check FAILED (qty delta ${check.qtyDelta}, value delta ${check.valueDelta} against a ${check.valueTolerance} rounding tolerance) — please report this file.`,
      );
    }

    return {
      sourceId: "zerodha",
      broker: "zerodha",
      format: "tradebook",
      trades,
      sourceRows: fillCount,
      warnings,
    };
  }

  // ---- Console P&L: already aggregated ----
  const cBuyVal = find("buy value", "buy_value", "buyvalue");
  const cSellVal = find("sell value", "sell_value", "sellvalue");
  const cBuyAvg = find("buy average", "buy avg", "buy price", "average buy price");
  const cSellAvg = find("sell average", "sell avg", "sell price", "average sell price");
  const cRealized = find("realized p&l", "realized profit", "realised p&l", "realized pnl", "pnl");
  const cBuyQty = find("buy quantity", "buy qty");
  const cSellQty = find("sell quantity", "sell qty");

  const trades: NormalizedTrade[] = [];
  for (const r of dataRows) {
    const symbol = cSymbol >= 0 ? r[cSymbol] : "";
    if (!symbol) continue;
    const qty = cQty >= 0 ? toNum(r[cQty]) : 0;
    const buyQty = cBuyQty >= 0 ? toNum(r[cBuyQty]) : qty;
    const sellQty = cSellQty >= 0 ? toNum(r[cSellQty]) : qty;
    const buyVal = cBuyVal >= 0 ? toNum(r[cBuyVal]) : 0;
    const sellVal = cSellVal >= 0 ? toNum(r[cSellVal]) : 0;
    // A row with nothing bought, nothing sold and no value on either side is
    // not a trade. The real Console export carries three of them, whose
    // "Symbol" cell holds an ISIN — importing them creates empty positions.
    if (buyQty === 0 && sellQty === 0 && buyVal === 0 && sellVal === 0) continue;
    trades.push({
      broker: "zerodha",
      tradingsymbol: symbol,
      isin: cIsin >= 0 ? r[cIsin] || null : null,
      buyQty,
      avgBuyPrice: cBuyAvg >= 0 ? toNum(r[cBuyAvg]) : buyQty ? buyVal / buyQty : 0,
      buyValue: buyVal,
      sellQty,
      avgSellPrice: cSellAvg >= 0 ? toNum(r[cSellAvg]) : sellQty ? sellVal / sellQty : 0,
      sellValue: sellVal,
      closingPrice: null,
      grossPnl: cRealized >= 0 ? toNum(r[cRealized]) : sellVal - buyVal,
      unrealisedPnl: 0,
      buyDate: cDate >= 0 ? r[cDate] || null : null,
      sellDate: null,
      productHint: cProduct >= 0 ? productHint(r[cProduct]) : null,
      exchangeHint: cExch >= 0 ? exchangeFrom(r[cExch]) : null,
      sourceFile: ctx.filename,
    });
  }
  warnings.push("Zerodha Console P&L is aggregated; segment/MTF may need re-tagging.");
  return { sourceId: "zerodha", broker: "zerodha", format: "console", trades, warnings };
}
