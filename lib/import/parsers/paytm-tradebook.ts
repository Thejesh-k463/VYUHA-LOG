/**
 * Paytm Money **Tradebook** (XLSX) — per execution, WITH per-trade charges.
 *
 * ── Provenance (docs/BROKER_FORMATS.md, 2026-08-12) ─────────────────────────
 *
 * Layout VERIFIED against a real export: four metadata rows (`UCC`, `Name`,
 * `PAN Number`, `Period`), the header on row 5, then one row per execution
 * with a full charge breakdown — Brokerage, ETT, GST, STT, SEBI, Stamp Duty.
 * That makes it the richest tradebook of the brokers examined: Zerodha's has
 * granularity but no charges; Dhan's GTR has charges but only bill-level
 * granularity. The sample carried ZERO data rows, so column mapping is
 * verified and value behaviour is INFERRED, coded defensively.
 *
 * AGENTS.md forbids inventing a parser for an unpublished format — that rule
 * existed because Paytm documents these columns nowhere. It is deliberately
 * set aside here because a REAL export now pins the layout; the deviation is
 * recorded in docs/DECISIONS.md (2026-08-12).
 *
 * Fingerprints (in-content, both verified): the `UCC` metadata label above
 * the table, and the `Script` (sic) + `ETT` header pair — Paytm's own
 * vocabulary, used by no other broker examined.
 */

import * as XLSX from "xlsx";
import Papa from "papaparse";
import type { ChargeBreakdown, Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import type { ParseContext, ParsedFile } from "../types";
import { extractTime } from "../time-parse";

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[\s_.]/g, "");

const toNum = (v: unknown): number => {
  const x = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

function toMatrix(ctx: ParseContext): string[][] {
  if (ctx.text != null) {
    return (Papa.parse<string[]>(ctx.text, { skipEmptyLines: true }).data ?? []).map((r) =>
      r.map((c) => String(c ?? "")),
    );
  }
  if (!ctx.buffer) return [];
  try {
    const wb = XLSX.read(ctx.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]!];
    if (!ws) return [];
    return (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" }) as unknown[][]).map(
      (r) => r.map((c) => String(c ?? "")),
    );
  } catch {
    return [];
  }
}

/** The header row: Paytm's `Script` (sic) and `ETT` together. */
function findHeader(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = rows[i].map(norm);
    if (cells.includes("script") && cells.includes("ett")) return i;
  }
  return -1;
}

function hasUccLabel(rows: string[][]): boolean {
  return rows.slice(0, 8).some((r) => norm(r[0]) === "ucc");
}

export function detectPaytmTradebook(ctx: ParseContext): number {
  const rows = toMatrix(ctx);
  const h = findHeader(rows);
  if (h < 0) return 0; // without Paytm's own header this parser cannot read it
  const named = /paytm/i.test(ctx.filename);
  const ucc = hasUccLabel(rows);
  if (!named && !ucc) return 0; // No name, no fingerprint, no claim.
  let score = 0.35; // the Script+ETT pair, counted only after qualification
  if (ucc) score += 0.4;
  if (named) score += 0.2;
  return Math.min(1, score);
}

const MONTH_NO: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function flexDate(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})/);
  if (m) {
    const mm = MONTH_NO[m[2].toLowerCase().slice(0, 3)];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

function productHint(raw: string): ProductHint {
  const s = norm(raw);
  if (!s) return null;
  // MTF first: normalised "margintradefunding" CONTAINS "intra"
  // (marg-intra-defunding), so testing intraday first mis-tagged funded
  // positions as intraday — caught by the synthetic-row test.
  if (/mtf|margin/.test(s)) return "mtf";
  if (/^intra|intraday|mis/.test(s)) return "intraday";
  if (/del|cnc/.test(s)) return "delivery";
  return null;
}

function exchangeFrom(raw: string): Exchange | null {
  const s = norm(raw);
  if (s.startsWith("mcx")) return "MCX";
  if (s.startsWith("bse")) return "BSE";
  if (s.startsWith("nse")) return "NSE";
  return null;
}

export function parsePaytmTradebook(ctx: ParseContext): ParsedFile {
  const rows = toMatrix(ctx);
  const h = findHeader(rows);
  if (h < 0) {
    return {
      sourceId: "paytm-tradebook", broker: "paytm", format: "tradebook", trades: [],
      warnings: ["Could not find the tradebook header row in this Paytm Money file."],
    };
  }

  const idx = rows[h].map(norm);
  const col = (name: string) => idx.indexOf(norm(name));
  const cDate = col("Date"), cScript = col("Script"), cIsin = col("ISIN"), cExch = col("Exchange");
  const cProduct = col("Product Type"), cType = col("Type"), cQty = col("Quantity"), cPrice = col("Price");
  const cBrok = col("Brokerage"), cEtt = col("ETT"), cGst = col("GST"), cStt = col("STT");
  const cSebi = col("SEBI"), cStamp = col("Stamp Duty"), cTime = col("Trade Time");

  const dataRows = rows.slice(h + 1).filter((r) => r.some((c) => c.trim() !== ""));
  const warnings: string[] = [];
  const unreadable: string[] = [];

  // Aggregate per Script + Product Type — the same round-trip shape the
  // Zerodha tradebook path produces — keeping every fill AND summing the
  // stated charges, which is what Zerodha's tradebook cannot offer.
  type Acc = {
    symbol: string; isin: string | null; product: string; exch: string;
    firstBuyDate: string | null; lastSellDate: string | null;
    buyQty: number; buyVal: number; sellQty: number; sellVal: number;
    charges: { brokerage: number; exchangeTxn: number; gst: number; sttCtt: number; sebi: number; stampDuty: number };
    executions: Execution[];
  };
  const groups = new Map<string, Acc>();

  for (const r of dataRows) {
    const symbol = (r[cScript] ?? "").trim();
    if (!symbol) continue;
    const qty = toNum(r[cQty]);
    const price = toNum(r[cPrice]);
    const rawSide = norm(cType >= 0 ? r[cType] : "");
    const side = rawSide.startsWith("b") ? "buy" : rawSide.startsWith("s") ? "sell" : null;
    const date = flexDate(cDate >= 0 ? r[cDate] : "");
    // Refuse rather than coerce — a zero-share or priceless execution is not a trade.
    if (!side || qty <= 0 || price <= 0) {
      unreadable.push(symbol);
      continue;
    }

    const product = cProduct >= 0 ? r[cProduct] : "";
    const key = `${symbol}|${product}`;
    const acc = groups.get(key) ?? {
      symbol, isin: cIsin >= 0 ? r[cIsin] || null : null, product,
      exch: cExch >= 0 ? r[cExch] : "",
      firstBuyDate: null, lastSellDate: null,
      buyQty: 0, buyVal: 0, sellQty: 0, sellVal: 0,
      charges: { brokerage: 0, exchangeTxn: 0, gst: 0, sttCtt: 0, sebi: 0, stampDuty: 0 },
      executions: [],
    };

    if (side === "buy") {
      acc.buyQty += qty; acc.buyVal += qty * price;
      if (date && (!acc.firstBuyDate || date < acc.firstBuyDate)) acc.firstBuyDate = date;
    } else {
      acc.sellQty += qty; acc.sellVal += qty * price;
      if (date && (!acc.lastSellDate || date > acc.lastSellDate)) acc.lastSellDate = date;
    }
    acc.charges.brokerage += toNum(r[cBrok]);
    acc.charges.exchangeTxn += toNum(r[cEtt]); // ETT = exchange transaction tax/charge
    acc.charges.gst += toNum(r[cGst]);
    acc.charges.sttCtt += toNum(r[cStt]);
    acc.charges.sebi += toNum(r[cSebi]);
    acc.charges.stampDuty += toNum(r[cStamp]);
    acc.executions.push({ side, qty, price, date, time: extractTime(cTime >= 0 ? r[cTime] : null) });
    groups.set(key, acc);
  }

  const trades: NormalizedTrade[] = [];
  for (const a of groups.values()) {
    const c = a.charges;
    const reported: Partial<ChargeBreakdown> = {
      brokerage: r2(c.brokerage), exchangeTxn: r2(c.exchangeTxn), gst: r2(c.gst),
      sttCtt: r2(c.sttCtt), sebi: r2(c.sebi), stampDuty: r2(c.stampDuty),
      total: r2(c.brokerage + c.exchangeTxn + c.gst + c.sttCtt + c.sebi + c.stampDuty),
    };
    trades.push({
      broker: "paytm",
      tradingsymbol: a.symbol,
      isin: a.isin,
      buyQty: a.buyQty,
      avgBuyPrice: a.buyQty ? r2(a.buyVal / a.buyQty) : 0,
      buyValue: r2(a.buyVal),
      sellQty: a.sellQty,
      avgSellPrice: a.sellQty ? r2(a.sellVal / a.sellQty) : 0,
      sellValue: r2(a.sellVal),
      closingPrice: null,
      grossPnl: a.sellQty > 0 ? r2(a.sellVal - a.buyVal) : 0,
      unrealisedPnl: 0,
      buyDate: a.firstBuyDate,
      sellDate: a.sellQty > 0 ? a.lastSellDate : null,
      entryTime: a.executions.find((e) => e.side === "buy")?.time ?? null,
      exitTime: [...a.executions].reverse().find((e) => e.side === "sell")?.time ?? null,
      productHint: productHint(a.product),
      exchangeHint: exchangeFrom(a.exch),
      sourceFile: ctx.filename,
      executions: a.executions,
      reportedCharges: reported,
    });
  }

  warnings.push(
    "Charges are the broker's own per-execution figures (Brokerage, ETT, GST, STT, SEBI, Stamp Duty), summed per position — not computed.",
  );
  warnings.push("Paytm Money tradebook aggregated per Script + Product Type; verify F&O classification.");
  if (unreadable.length > 0) {
    warnings.push(
      `${unreadable.length} row${unreadable.length === 1 ? "" : "s"} had no readable side, quantity or price and ${unreadable.length === 1 ? "was" : "were"} refused rather than guessed.`,
    );
  }

  return { sourceId: "paytm-tradebook", broker: "paytm", format: "tradebook", trades, warnings };
}
