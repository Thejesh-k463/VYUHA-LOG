/**
 * Groww **Stocks Order History** (XLSX) — one row per executed order.
 *
 * ── Provenance (docs/BROKER_FORMATS.md, 2026-08-12) ─────────────────────────
 *
 * Layout VERIFIED against a real export. The word "Groww" appears nowhere in
 * the file — not in a header, a cell, or a sheet name — and its filename
 * (`Stocks_Order_History_<code>_<from>_<to>.xlsx`) names no broker either.
 * That anonymity is exactly how one of these was once imported as Zerodha:
 * a shape-scoring detector saw `Symbol` + `ISIN` and claimed it. The one
 * distinctive marker is the `Unique Client Code` metadata label — Groww's own
 * phrasing — and that is the fingerprint required here.
 *
 * The sample carried ZERO data rows, so column MAPPING is verified but value
 * behaviour (date formats, `Order status` vocabulary, `Type` vocabulary) is
 * INFERRED and coded defensively: a row this parser cannot read is refused
 * with a warning, never coerced — a trade for zero shares at zero rupees is
 * worse than no trade (AGENTS.md).
 *
 * ── What the file does not carry ────────────────────────────────────────────
 *
 *   - **No price column.** Price is derived as Value / Quantity per order.
 *   - **No charges at all.** The engine computes estimates from Groww's rate
 *     card; the warning says so instead of pretending they were stated.
 *   - **No product column.** Same-day round trips are tagged intraday and
 *     cross-day ones delivery — DERIVED, flagged as such, and MTF cannot be
 *     seen at all (same warning discipline as the Dhan GTR).
 */

import * as XLSX from "xlsx";
import type { Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import type { ParseContext, ParsedFile } from "../types";
import { pairLegs, summarisePairing, type Leg } from "../pair-legs";
import { extractTime } from "../time-parse";

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[\s_.]/g, "");

const toNum = (v: unknown): number => {
  const x = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};

function toMatrix(ctx: ParseContext): string[][] {
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

/** The header row: Groww's exact phrasing, all three present. */
function findHeader(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = rows[i].map(norm);
    if (cells.includes("stockname") && cells.includes("executiondateandtime") && cells.includes("orderstatus")) {
      return i;
    }
  }
  return -1;
}

/** The metadata rows above the table carry a `Unique Client Code` label. */
function hasUccLabel(rows: string[][]): boolean {
  return rows.slice(0, 10).some((r) => r.some((c) => norm(c) === "uniqueclientcode"));
}

/**
 * Detection. Qualification is the `Unique Client Code` label (in-content,
 * Groww-specific phrasing) or a filename that matches Groww's own export
 * pattern. The header set alone is SHAPE and cannot claim the file.
 */
export function detectGrowwOrders(ctx: ParseContext): number {
  if (!ctx.buffer) return 0;
  const rows = toMatrix(ctx);
  const h = findHeader(rows);
  if (h < 0) return 0; // without Groww's exact header this parser cannot read it anyway

  const named = /groww|stocks_order_history/i.test(ctx.filename);
  const ucc = hasUccLabel(rows);
  if (!named && !ucc) return 0; // No name, no fingerprint, no claim.

  let score = 0.3; // the verified header set, counted only after qualification
  if (ucc) score += 0.45;
  if (named) score += 0.2;
  return Math.min(1, score);
}

/** `12-05-2026`, `12/05/2026`, `2026-05-12`, `12 May 2026` → ISO, else null. */
export function parseOrderDate(raw: string): string | null {
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  if (m) {
    const MONTHS: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const mm = MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

const EXECUTED_RE = /executed|complete|success|traded|filled/i;

export function parseGrowwOrders(ctx: ParseContext): ParsedFile {
  const rows = toMatrix(ctx);
  const h = findHeader(rows);
  const warnings: string[] = [];
  if (h < 0) {
    return {
      sourceId: "groww-orders", broker: "groww", format: "transactions", trades: [],
      warnings: ["Could not find the order-history header row in this file."],
    };
  }

  const idx = rows[h].map(norm);
  const col = (name: string) => idx.indexOf(norm(name));
  const cSymbol = col("Symbol");
  const cStock = col("Stock name");
  const cIsin = col("ISIN");
  const cType = col("Type");
  const cQty = col("Quantity");
  const cValue = col("Value");
  const cExch = col("Exchange");
  const cWhen = col("Execution date and time");
  const cStatus = col("Order status");

  const dataRows = rows.slice(h + 1).filter((r) => r.some((c) => c.trim() !== ""));

  const skippedStatuses = new Map<string, number>();
  const unreadable: string[] = [];
  const legs: Leg[] = [];
  const fills = new Map<string, Execution[]>();
  const isinOf = new Map<string, string | null>();

  for (const r of dataRows) {
    const symbol = (r[cSymbol] || r[cStock] || "").trim();
    if (!symbol) continue;

    // Only executed orders are trades. The status vocabulary is INFERRED
    // (schema-only sample); anything unrecognised is counted, not imported.
    const status = (cStatus >= 0 ? r[cStatus] : "").trim();
    if (status && !EXECUTED_RE.test(status)) {
      skippedStatuses.set(status, (skippedStatuses.get(status) ?? 0) + 1);
      continue;
    }

    const qty = toNum(r[cQty]);
    const value = toNum(r[cValue]);
    const rawSide = norm(cType >= 0 ? r[cType] : "");
    const side = rawSide.startsWith("b") ? "buy" : rawSide.startsWith("s") ? "sell" : null;
    const date = parseOrderDate(cWhen >= 0 ? r[cWhen] : "");

    // Refuse, never coerce: a row without a readable side, quantity, value or
    // date cannot become a trade without inventing one of them.
    if (!side || qty <= 0 || value <= 0 || !date) {
      unreadable.push(symbol);
      continue;
    }

    legs.push({ symbol, side, date, qty, value, charges: 0, exchange: (r[cExch] || "").toUpperCase() || null, product: "unknown" });
    isinOf.set(symbol, cIsin >= 0 ? r[cIsin] || null : null);
    const f = fills.get(symbol) ?? [];
    f.push({ side, qty, price: value / qty, date, time: extractTime(cWhen >= 0 ? r[cWhen] : null) });
    fills.set(symbol, f);
  }

  const paired = pairLegs(legs);
  const check = summarisePairing(legs, paired);
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const trades: NormalizedTrade[] = paired.map((p) => {
    // Product is DERIVED from the calendar, not stated: a same-day round trip
    // is intraday; a position held across a date boundary is delivery.
    const sameDay = p.kind === "closed" && p.buyDate != null && p.buyDate === p.sellDate;
    const hint: ProductHint = sameDay ? "intraday" : "delivery";

    // Give each position only the fills inside its own window, so a staged
    // ladder is built from its own executions rather than the symbol's whole
    // history. Approximate for re-entered symbols; the aggregate stays exact.
    const all = fills.get(p.symbol) ?? [];
    const executions = all.filter(
      (e) =>
        (p.buyDate == null || (e.date ?? "") >= p.buyDate) &&
        (p.sellDate == null || (e.date ?? "") <= p.sellDate),
    );

    return {
      broker: "groww",
      tradingsymbol: p.symbol,
      isin: isinOf.get(p.symbol) ?? null,
      buyQty: p.buyQty,
      avgBuyPrice: p.buyQty > 0 ? r2(p.buyValue / p.buyQty) : 0,
      buyValue: p.buyValue,
      sellQty: p.sellQty,
      avgSellPrice: p.sellQty > 0 ? r2(p.sellValue / p.sellQty) : 0,
      sellValue: p.sellValue,
      closingPrice: null,
      grossPnl: p.kind === "closed" ? r2(p.sellValue - p.buyValue) : 0,
      unrealisedPnl: 0,
      buyDate: p.buyDate,
      sellDate: p.sellDate,
      productHint: hint,
      exchangeHint: (p.exchange as Exchange | null) ?? null,
      sourceFile: ctx.filename,
      entryTime: executions.find((e) => e.side === "buy")?.time ?? null,
      exitTime: [...executions].reverse().find((e) => e.side === "sell")?.time ?? null,
      executions: executions.length > 0 ? executions : null,
      basisUnknown: p.basisUnknown,
      productDerived: true,
      importNotes: p.notes.length ? p.notes : null,
    };
  });

  warnings.push(
    "This file carries no charges at all — Vyuha estimated them from Groww's rate card. The Stocks P&L export or a contract note has the real figures.",
  );
  warnings.push(
    "No price column either: prices are Value ÷ Quantity per order, and delivery vs intraday is derived from same-day round trips. MTF cannot be identified from this file — confirm any delivery rows that were actually MTF.",
  );
  if (skippedStatuses.size > 0) {
    const parts = [...skippedStatuses.entries()].map(([s, n]) => `${n} ${s}`);
    warnings.push(`Non-executed orders ignored: ${parts.join(", ")}.`);
  }
  if (unreadable.length > 0) {
    warnings.push(
      `${unreadable.length} row${unreadable.length === 1 ? "" : "s"} had no readable side, quantity, value or date and ${unreadable.length === 1 ? "was" : "were"} refused rather than guessed: ${[...new Set(unreadable)].slice(0, 5).join(", ")}.`,
    );
  }
  if (check.qtyDelta !== 0 || check.valueDelta !== 0) {
    warnings.push(`Pairing conservation check FAILED (qty delta ${check.qtyDelta}, value delta ${check.valueDelta}) — please report this file.`);
  }
  if (check.openingSells > 0) {
    warnings.push(
      `${check.openingSells} holding${check.openingSells === 1 ? " was" : "s were"} sold without a matching purchase in this window — cost basis is unknown until you set it.`,
    );
  }

  return {
    sourceId: "groww-orders",
    broker: "groww",
    format: "transactions",
    trades,
    sourceRows: legs.length,
    warnings,
  };
}
