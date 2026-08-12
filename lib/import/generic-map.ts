/**
 * IMPORT ANY BROKER'S FILE, BY TELLING THE APP WHAT THE COLUMNS MEAN.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Vyuha ships hand-written parsers for the brokers whose export formats we
 * have actually seen. That will always be a subset: Kotak Neo and
 * Sahi publish no column specification anywhere — not in their own docs, and
 * not in the third-party journals that support them, which ask users to email
 * a sample file. Writing a parser against guessed header names is the worst
 * possible outcome: the file appears to import, and quantity lands in the
 * price column. A wrong number that looks right is far more damaging than a
 * refusal.
 *
 * So the answer is not more guessing — it is to ask. The user maps each column
 * once, the mapping is remembered for that broker, and every later file from
 * the same broker goes through in one click. This covers every broker that
 * exists, including ones that launch after this release.
 *
 * ── It joins the SAME pipeline ────────────────────────────────────────────
 *
 * A mapped file is not a second-class import. Execution-shaped files are paired
 * by `pairLegs` — the identical FIFO engine the Dhan transaction report uses —
 * so a manually-mapped tradebook produces the same positions, the same
 * opening-sell/basis-unknown handling, and the same staged-position ladders as
 * a natively-parsed one. Downstream (classify → charges → dedup → commit) is
 * untouched and cannot tell the difference.
 *
 * ── Refusing beats coercing ───────────────────────────────────────────────
 *
 * Every other importer in this codebase reads a bad number as 0, which is safe
 * there because the column is known to be numeric. Here the column is whatever
 * the user pointed at, so a non-numeric quantity means the mapping is wrong,
 * not that the trade was for zero shares. Such rows are SKIPPED and counted in
 * a warning. Importing them as zeros would silently manufacture trades.
 */

import type { Broker, Exchange } from "@/lib/domain/constants";
import type { NormalizedTrade, ProductHint } from "@/lib/engine/types";
import { extractDate, extractTime } from "./time-parse";
import { pairLegs, type Leg } from "./pair-legs";

// ── The two shapes a broker file can take ─────────────────────────────────
//
// Everything Indian brokers export is one of these. Which one is in play is
// decided by whether a BUY/SELL side column exists, because that is the single
// fact that distinguishes "a list of fills" from "a list of finished trades".

export type MappingShape = "executions" | "roundtrip";

export const GENERIC_FIELDS = [
  "tradingsymbol", "side", "qty", "price", "date", "time",
  "buyQty", "avgBuyPrice", "sellQty", "avgSellPrice", "buyDate", "sellDate", "grossPnl",
  "exchange", "product", "charges", "isin",
] as const;

export type GenericField = (typeof GENERIC_FIELDS)[number];

/** field → column index in the header row. Absent = not mapped. */
export type ColumnMapping = Partial<Record<GenericField, number>>;

export interface FieldSpec {
  field: GenericField;
  label: string;
  shape: MappingShape | "both";
  required: boolean;
  hint: string;
}

/** What the mapping UI renders, and what validation is checked against. */
export const FIELD_SPECS: FieldSpec[] = [
  { field: "tradingsymbol", label: "Symbol", shape: "both", required: true, hint: "Scrip / tradingsymbol / instrument" },
  { field: "side", label: "Buy or Sell", shape: "executions", required: true, hint: "BUY / SELL, B / S, or Purchase / Sale" },
  { field: "qty", label: "Quantity", shape: "executions", required: true, hint: "Shares or lots in this fill" },
  { field: "price", label: "Price", shape: "executions", required: true, hint: "Per-unit trade price" },
  { field: "date", label: "Trade date", shape: "executions", required: true, hint: "dd-mm-yyyy, yyyy-mm-dd or dd-MMM-yyyy" },
  { field: "time", label: "Trade time", shape: "executions", required: false, hint: "Optional — enables time-of-day analytics" },
  { field: "buyQty", label: "Buy quantity", shape: "roundtrip", required: true, hint: "Quantity bought" },
  { field: "avgBuyPrice", label: "Avg buy price", shape: "roundtrip", required: true, hint: "Average purchase price" },
  { field: "sellQty", label: "Sell quantity", shape: "roundtrip", required: true, hint: "Quantity sold" },
  { field: "avgSellPrice", label: "Avg sell price", shape: "roundtrip", required: true, hint: "Average sale price" },
  { field: "buyDate", label: "Buy date", shape: "roundtrip", required: false, hint: "Optional — without it the trade has no date" },
  { field: "sellDate", label: "Sell date", shape: "roundtrip", required: false, hint: "Optional — needed for the P&L calendar" },
  { field: "grossPnl", label: "Gross P&L", shape: "roundtrip", required: false, hint: "Optional — recomputed from prices when absent" },
  { field: "exchange", label: "Exchange", shape: "both", required: false, hint: "NSE / BSE / MCX" },
  { field: "product", label: "Product", shape: "both", required: false, hint: "Delivery / Intraday / MTF — drives the charge rates" },
  { field: "charges", label: "Charges", shape: "both", required: false, hint: "Broker-reported total charges for the row" },
  { field: "isin", label: "ISIN", shape: "both", required: false, hint: "Optional — improves symbol matching" },
];

// ── Header auto-suggestion ────────────────────────────────────────────────
//
// Ranked synonyms per field. These are only a STARTING POINT shown pre-filled
// in the UI — nothing commits until the user has seen the mapping and the
// preview rows it produces. That is the difference between this and guessing:
// the guess is visible and correctable before it touches the journal.

const SYNONYMS: Record<GenericField, RegExp[]> = {
  tradingsymbol: [/^(trading)?symbol$/, /^scrip(\s*name)?$/, /^instrument$/, /^stock(\s*name)?$/, /^security(\s*name)?$/, /symbol/, /scrip/, /instrument/],
  side: [/^(trade\s*)?type$/, /^side$/, /^buy\s*\/?\s*sell$/, /^transaction(\s*type)?$/, /^b\/s$/, /side/, /buy.*sell/],
  qty: [/^(traded\s*)?(qty|quantity)$/, /^(no\.?\s*of\s*)?(shares|units)$/, /qty/, /quantity/],
  price: [/^(trade\s*|avg\.?\s*|average\s*)?(price|rate)$/, /^price\s*per/, /price/, /^rate$/],
  date: [/^(trade|order|transaction)\s*date$/, /^date$/, /date.*time/, /date/],
  time: [/^(trade|order|execution)\s*time$/, /^time$/, /time/],
  buyQty: [/^buy\s*(qty|quantity)$/, /^qty\.?\s*bought$/, /buy.*qty/, /bought/],
  avgBuyPrice: [/^(avg\.?|average)\s*buy\s*(price|rate)$/, /^buy\s*(price|rate|avg)$/, /buy.*price/, /purchase.*price/],
  sellQty: [/^sell\s*(qty|quantity)$/, /^qty\.?\s*sold$/, /sell.*qty/, /\bsold\b/],
  avgSellPrice: [/^(avg\.?|average)\s*sell\s*(price|rate)$/, /^sell\s*(price|rate|avg)$/, /sell.*price/, /sale.*price/],
  buyDate: [/^buy\s*date$/, /^purchase\s*date$/, /^entry\s*date$/, /buy.*date/],
  sellDate: [/^sell\s*date$/, /^sale\s*date$/, /^exit\s*date$/, /sell.*date/],
  grossPnl: [/^(realised|realized)\s*(p&l|pnl|profit)/, /^gross\s*(p&l|pnl)/, /^(p&l|pnl)$/, /profit.*loss/, /pnl/],
  exchange: [/^exchange$/, /^exch\.?$/, /exchange/],
  product: [/^product(\s*type)?$/, /^order\s*type$/, /product/],
  charges: [/^(total\s*)?(charges|brokerage|taxes)$/, /charges/, /brokerage/],
  isin: [/^isin(\s*code)?$/, /isin/],
};

const norm = (h: string) => h.toLowerCase().replace(/[_\s]+/g, " ").replace(/[^a-z0-9&/. ]/g, "").trim();

/**
 * Best-guess column for every field (PURE). A column is never assigned twice —
 * an earlier, higher-confidence field wins it, so "Buy Price" cannot also be
 * claimed by the generic `price` matcher.
 */
export function suggestMapping(headers: string[]): ColumnMapping {
  const normalized = headers.map(norm);
  const taken = new Set<number>();
  const out: ColumnMapping = {};

  // Two passes over synonym rank: exact-ish patterns first across ALL fields,
  // then the loose `includes`-style fallbacks. Otherwise a loose match on an
  // early field steals a column an exact match on a later field wanted.
  const maxRank = Math.max(...Object.values(SYNONYMS).map((r) => r.length));
  for (let rank = 0; rank < maxRank; rank++) {
    for (const field of GENERIC_FIELDS) {
      if (out[field] !== undefined) continue;
      const pattern = SYNONYMS[field][rank];
      if (!pattern) continue;
      const idx = normalized.findIndex((h, i) => !taken.has(i) && pattern.test(h));
      if (idx >= 0) {
        out[field] = idx;
        taken.add(idx);
      }
    }
  }
  return out;
}

/** Which shape the mapping describes. A side column is the deciding fact. */
export function shapeOf(m: ColumnMapping): MappingShape {
  return m.side !== undefined ? "executions" : "roundtrip";
}

export interface MappingCheck {
  ok: boolean;
  shape: MappingShape;
  /** Required fields for the active shape that are still unmapped. */
  missing: GenericField[];
}

/** Can this mapping be applied? (PURE) */
export function validateMapping(m: ColumnMapping): MappingCheck {
  const shape = shapeOf(m);
  const missing = FIELD_SPECS
    .filter((s) => s.required && (s.shape === shape || s.shape === "both"))
    .filter((s) => m[s.field] === undefined)
    .map((s) => s.field);
  return { ok: missing.length === 0, shape, missing };
}

// ── Cell readers ──────────────────────────────────────────────────────────

/**
 * A number, or null when the cell is not one.
 *
 * Handles ₹, thousands separators (Indian or Western grouping), a trailing
 * minus, and accounting parentheses. Returns NULL rather than 0 for anything
 * else — see the header note on refusing over coercing.
 */
export function readNumber(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === "" || s === "-" || s === "--") return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/-$/.test(s)) { sign = -1; s = s.slice(0, -1); }
  s = s.replace(/[₹,\s]/g, "");
  if (s.startsWith("-")) { sign = -1; s = s.slice(1); }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? sign * n : null;
}

const BUY_WORDS = /^(b|buy|bought|purchase|purchased|p)$/;
const SELL_WORDS = /^(s|sell|sold|sale|sl)$/;

/** BUY/SELL from whatever word the broker used, or null if unrecognisable. */
export function readSide(raw: string | undefined | null): "buy" | "sell" | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (BUY_WORDS.test(s)) return "buy";
  if (SELL_WORDS.test(s)) return "sell";
  // Some files write "BUY 100" or "Sell Order"; fall back to a contains test,
  // checking sell first so "buy/sell" style headers cannot read as buy.
  if (/\bsell|\bsold|\bsale/.test(s)) return "sell";
  if (/\bbuy|\bbought|\bpurchase/.test(s)) return "buy";
  return null;
}

/** Product vocabulary across brokers → the canonical hint. */
export function readProduct(raw: string | undefined | null): ProductHint {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/mtf|margin.*fund|\bmargin\b|e-?margin/.test(s)) return "mtf";
  if (/intra|mis|^i$|bo|co/.test(s)) return "intraday";
  if (/deliv|cnc|^d$|holding|longterm/.test(s)) return "delivery";
  return null;
}

const EXCHANGES = ["NSE", "BSE", "MCX", "NCDEX"] as const;

function readExchange(raw: string | undefined | null): Exchange | null {
  const s = String(raw ?? "").trim().toUpperCase();
  const hit = EXCHANGES.find((e) => s.includes(e));
  return (hit as Exchange | undefined) ?? null;
}

// ── Applying the mapping ──────────────────────────────────────────────────

export interface ApplyResult {
  trades: NormalizedTrade[];
  warnings: string[];
  /** Rows dropped because a required cell could not be read. */
  skipped: number;
}

export interface ApplyOptions {
  broker: Broker;
  filename: string;
  /** Product to assume when the file has no product column. */
  defaultProduct?: ProductHint;
}

const cell = (row: string[], idx: number | undefined): string | undefined =>
  idx === undefined ? undefined : row[idx];

/**
 * Turn mapped rows into the canonical `NormalizedTrade[]` (PURE).
 *
 * Execution-shaped input is routed through `pairLegs`, so it acquires exactly
 * the same FIFO semantics, opening-sell detection and basis-unknown flags as
 * the natively-parsed transaction reports.
 */
export function applyMapping(
  headers: string[],
  rows: string[][],
  mapping: ColumnMapping,
  opts: ApplyOptions,
): ApplyResult {
  const check = validateMapping(mapping);
  if (!check.ok) {
    return {
      trades: [],
      warnings: [`Mapping incomplete — still needed: ${check.missing.join(", ")}.`],
      skipped: rows.length,
    };
  }
  return check.shape === "executions"
    ? applyExecutions(rows, mapping, opts)
    : applyRoundTrips(rows, mapping, opts);
}

function applyExecutions(rows: string[][], m: ColumnMapping, opts: ApplyOptions): ApplyResult {
  const warnings: string[] = [];
  const legs: Leg[] = [];
  const times = new Map<string, { first: string | null; last: string | null }>();
  let skipped = 0;
  let undated = 0;

  for (const row of rows) {
    const symbol = String(cell(row, m.tradingsymbol) ?? "").trim().toUpperCase();
    const side = readSide(cell(row, m.side));
    const qty = readNumber(cell(row, m.qty));
    const price = readNumber(cell(row, m.price));
    const date = extractDate(cell(row, m.date));

    if (!symbol || !side || qty == null || price == null || qty <= 0) { skipped++; continue; }
    if (!date) { skipped++; undated++; continue; }

    legs.push({
      symbol,
      side,
      date,
      qty,
      value: qty * price,
      charges: readNumber(cell(row, m.charges)) ?? 0,
      exchange: readExchange(cell(row, m.exchange)),
      product: "unknown",
    });

    const t = extractTime(cell(row, m.time));
    if (t) {
      const cur = times.get(symbol) ?? { first: null, last: null };
      if (!cur.first || t < cur.first) cur.first = t;
      if (!cur.last || t > cur.last) cur.last = t;
      times.set(symbol, cur);
    }
  }

  if (skipped > 0) {
    warnings.push(
      `${skipped} row${skipped === 1 ? "" : "s"} skipped — symbol, side, quantity, price or date could not be read. ` +
      `If that is most of the file, a column is mapped to the wrong header.`,
    );
  }
  if (undated > 0) {
    warnings.push(`${undated} of those had an unreadable date. Supported: dd-mm-yyyy, yyyy-mm-dd, dd-MMM-yyyy.`);
  }

  const product = productFromRows(rows, m) ?? opts.defaultProduct ?? null;
  const paired = pairLegs(legs);

  const trades: NormalizedTrade[] = paired.map((p) => {
    const t = times.get(p.symbol);
    return {
      broker: opts.broker,
      tradingsymbol: p.symbol,
      isin: null,
      buyQty: p.buyQty,
      avgBuyPrice: p.buyQty > 0 ? round2(p.buyValue / p.buyQty) : 0,
      buyValue: p.buyValue,
      sellQty: p.sellQty,
      avgSellPrice: p.sellQty > 0 ? round2(p.sellValue / p.sellQty) : 0,
      sellValue: p.sellValue,
      closingPrice: null,
      grossPnl: p.kind === "closed" ? round2(p.sellValue - p.buyValue) : 0,
      unrealisedPnl: 0,
      buyDate: p.buyDate,
      sellDate: p.sellDate,
      productHint: product,
      exchangeHint: (p.exchange as Exchange | null) ?? null,
      sourceFile: opts.filename,
      entryTime: t?.first ?? null,
      exitTime: p.kind === "closed" ? t?.last ?? null : null,
      basisUnknown: p.basisUnknown || undefined,
      importNotes: p.notes.length > 0 ? p.notes : null,
    };
  });

  return { trades, warnings, skipped };
}

function applyRoundTrips(rows: string[][], m: ColumnMapping, opts: ApplyOptions): ApplyResult {
  const warnings: string[] = [];
  const trades: NormalizedTrade[] = [];
  let skipped = 0;

  for (const row of rows) {
    const symbol = String(cell(row, m.tradingsymbol) ?? "").trim().toUpperCase();
    const buyQty = readNumber(cell(row, m.buyQty));
    const sellQty = readNumber(cell(row, m.sellQty));
    const avgBuy = readNumber(cell(row, m.avgBuyPrice));
    const avgSell = readNumber(cell(row, m.avgSellPrice));

    if (!symbol || buyQty == null || sellQty == null || avgBuy == null || avgSell == null) { skipped++; continue; }
    if (buyQty <= 0 && sellQty <= 0) { skipped++; continue; }

    const buyValue = round2(buyQty * avgBuy);
    const sellValue = round2(sellQty * avgSell);
    // A stated P&L is trusted over one derived from the averages: the broker
    // knows about part-fills and rounding that an average silently smooths.
    const stated = readNumber(cell(row, m.grossPnl));

    trades.push({
      broker: opts.broker,
      tradingsymbol: symbol,
      isin: String(cell(row, m.isin) ?? "").trim() || null,
      buyQty,
      avgBuyPrice: avgBuy,
      buyValue,
      sellQty,
      avgSellPrice: avgSell,
      sellValue,
      closingPrice: null,
      grossPnl: stated ?? round2(sellValue - buyValue),
      unrealisedPnl: 0,
      buyDate: extractDate(cell(row, m.buyDate)),
      sellDate: extractDate(cell(row, m.sellDate)),
      productHint: readProduct(cell(row, m.product)) ?? opts.defaultProduct ?? null,
      exchangeHint: readExchange(cell(row, m.exchange)),
      sourceFile: opts.filename,
      entryTime: null,
      exitTime: null,
    });
  }

  if (skipped > 0) {
    warnings.push(
      `${skipped} row${skipped === 1 ? "" : "s"} skipped — symbol or a quantity/price cell could not be read as a number. ` +
      `Blank subtotal and header rows are expected here; a large count means a column is mapped wrongly.`,
    );
  }
  return { trades, warnings, skipped };
}

/** The single product the file describes, when every row agrees on one. */
function productFromRows(rows: string[][], m: ColumnMapping): ProductHint {
  if (m.product === undefined) return null;
  const seen = new Set<ProductHint>();
  for (const row of rows) {
    const p = readProduct(cell(row, m.product));
    if (p) seen.add(p);
  }
  return seen.size === 1 ? [...seen][0] : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
