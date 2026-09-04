/**
 * Paytm Money **Realized P&L** (`.xls`) — a REFERENCE source, not a book.
 *
 * Verified 2026-09-04 against a real 918-lot export (and the two redacted
 * copies of it in tests/fixtures/redacted/). Three sheets, always in this
 * order and always with these names:
 *
 *   `Summary P&L`            two stacked tables (unrealized, then realized)
 *   `Realized P&L Detail`    one row per CLOSED LOT
 *   `Unrealized Transactions`
 *
 * `Realized P&L Detail` is the one that matters:
 *
 *   rows 0-3  `UCC` / `Name` / `PAN number` / `Period`  — IDENTITY. Read for
 *             nothing, emitted nowhere. Not to a warning, not to a note.
 *   row 5     `Scrip Name | ISIN | Quantity | Buy Date | Buy Price |
 *              Buy Value | Sell Date | Sell Price | Sell Value | P&L Value`
 *   rows 6+   one closed lot each
 *   last      `Total` — SKIPPED as a row, USED as a conservation check:
 *             Σ P&L Value must equal it to the paisa, or the file is saying
 *             something this parser did not read.
 *
 * WHY IT EMITS NO TRADES. This file is Paytm's own arithmetic over the same
 * executions the Paytm TRADEBOOK carries, lot-matched by Paytm's rules. The
 * book stays the tradebook (`paytm-tradebook.ts`); importing both would
 * double-count the same trades. What this file states that Vyuha cannot derive
 * — realised P&L per scrip and per FY, as the broker computes it — travels in
 * `reference` and lands in `broker_reference`, beside Vyuha's own figures on
 * the reconciliation screen. `trades` is deliberately empty.
 *
 * NO CHARGES. Unlike the Dhan Realised P&L report, this file states no
 * brokerage, no STT, no GST — nothing. Its "P&L Value" is GROSS. That is said
 * in a warning rather than assumed, because a reconciliation that reads a
 * gross figure as net reports the difference as an error in Vyuha.
 *
 * DATES. The verified export writes `20-Jul-2026` — dd-MMM-yyyy, unambiguous.
 * `lotDate` also reads dd-mm-yyyy, dd/mm/yyyy, yyyy-mm-dd and an Excel serial,
 * because a broker changing its date format silently is the failure mode this
 * codebase has already met twice; a numeric day-first form whose day component
 * never exceeds 12 is genuinely ambiguous and says so in a warning rather than
 * guessing.
 */

import * as XLSX from "xlsx";
import type { ParseContext, ParsedFile, ReferenceRow } from "../types";
import { workbookOf } from "../types";
import { parseTextMoney } from "./dhan-realised-pnl";
import { fyOfDate } from "@/lib/analytics/ais";

export const PAYTM_REALISED_SOURCE_ID = "paytm-realised-pnl";
const DETAIL_SHEET = "Realized P&L Detail";
const SUMMARY_SHEET = "Summary P&L";

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z&%]/g, "");
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The detail sheet's header row: the format fingerprint. */
function isDetailHeader(r: string[]): boolean {
  const c = r.map(norm);
  return c[0] === "scripname" && c.includes("isin") && c.includes("buydate")
    && c.includes("selldate") && c.includes("p&lvalue");
}

/** The realized block on `Summary P&L` — no dates, `Realized P&L` not `P&L Value`. */
function isRealizedSummaryHeader(r: string[]): boolean {
  const c = r.map(norm);
  return c[0] === "scripname" && c.includes("buyaverage") && c.includes("sellaverage")
    && c.includes("realizedp&l");
}

/** The unrealized block on `Summary P&L` — present, read for nothing yet. */
function isUnrealizedSummaryHeader(r: string[]): boolean {
  const c = r.map(norm);
  return c[0] === "scripname" && c.includes("closingprice") && c.includes("unrealizedp&l");
}

const MONTH_NO: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Which notation a cell is written in — so the file, not this file, decides. */
export type DateShape = "dd-mmm-yyyy" | "numeric-day-first" | "iso" | "excel-serial" | null;

export function dateShape(raw: unknown): DateShape {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return "iso";
  if (/^\d{1,2}[-/\s][A-Za-z]{3,}[-/\s]\d{4}/.test(s)) return "dd-mmm-yyyy";
  if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}/.test(s)) return "numeric-day-first";
  if (/^\d{5}(\.\d+)?$/.test(s)) return "excel-serial";
  return null;
}

/**
 * One lot date → ISO yyyy-mm-dd, or null. `raw: false` hands SheetJS's own
 * formatted text for a real date cell, so the serial branch is the fallback
 * for a workbook that stored the column as a bare number.
 */
export function lotDate(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  switch (dateShape(s)) {
    case "iso":
      return s.slice(0, 10);
    case "dd-mmm-yyyy": {
      const m = s.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{4})/)!;
      const mm = MONTH_NO[m[2].toLowerCase().slice(0, 3)];
      return mm ? `${m[3]}-${mm}-${m[1].padStart(2, "0")}` : null;
    }
    case "numeric-day-first": {
      const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/)!;
      return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    }
    case "excel-serial": {
      const d = XLSX.SSF.parse_date_code(Number(s));
      if (!d) return null;
      return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
    }
    default:
      return null;
  }
}

function sheetRows(ctx: ParseContext, name: string): string[][] | null {
  if (!ctx.buffer || !/\.xlsx?$/i.test(ctx.filename)) return null;
  let wb: XLSX.WorkBook;
  try {
    wb = workbookOf(ctx);
  } catch {
    return null;
  }
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" }) as unknown[][])
    .map((r) => r.map((c) => String(c ?? "")));
}

/**
 * Detection.
 *
 * The identity here is the SHEET SET plus the exact detail header — a layout
 * no other broker in this repo writes and one Paytm's own tradebook does not
 * (that file's header is `Script` + `ETT`, which is why the two never collide).
 * The broker never writes the word "Paytm" anywhere inside the workbook —
 * verified on the real 918-lot export and both redacted copies — so the name
 * can only be a BONUS, never the qualification, and a filename alone claims
 * nothing. A CSV is never this file.
 */
export function detectPaytmRealisedPnl(ctx: ParseContext): number {
  if (ctx.text != null) return 0;
  const detail = sheetRows(ctx, DETAIL_SHEET);
  if (!detail || !detail.some(isDetailHeader)) return 0;
  let score = 0.9;
  const summary = sheetRows(ctx, SUMMARY_SHEET);
  const named = /paytm/i.test(ctx.filename)
    || (summary?.some((r) => r.some((c) => /paytm\s*money/i.test(c))) ?? false);
  if (named) score += 0.1;
  return Math.min(1, score);
}

interface ScripAgg {
  isin: string;
  symbol: string;
  asOf: string | null;
  fy: string | null;
  qty: number;
  buyValue: number;
  sellValue: number;
  grossPnl: number;
}

/** Aggregate lots into ONE row per (identity, as-of): the store's own identity. */
function bump(map: Map<string, ScripAgg>, seed: ScripAgg) {
  const k = `${seed.isin}|${seed.asOf ?? ""}`;
  const cur = map.get(k);
  if (!cur) {
    map.set(k, { ...seed });
    return;
  }
  cur.qty += seed.qty;
  cur.buyValue += seed.buyValue;
  cur.sellValue += seed.sellValue;
  cur.grossPnl += seed.grossPnl;
}

const CHARGES_WARNING =
  "Paytm's Realized P&L states no charges — its P&L Value is GROSS. Vyuha's charges come from the tradebook, so the two figures are not comparable head-for-head.";

export function parsePaytmRealisedPnl(ctx: ParseContext): ParsedFile {
  const warnings: string[] = [];
  const base = { sourceId: PAYTM_REALISED_SOURCE_ID, broker: "paytm" as const, format: "reference", trades: [] };

  const detail = sheetRows(ctx, DETAIL_SHEET);
  const summary = sheetRows(ctx, SUMMARY_SHEET);
  const reference: ReferenceRow[] = [];

  const detailHeaderAt = detail?.findIndex(isDetailHeader) ?? -1;
  let sourceRows = 0;

  if (detail && detailHeaderAt >= 0) {
    const h = detail[detailHeaderAt].map(norm);
    const col = (k: string) => h.indexOf(k);
    const cName = col("scripname"), cIsin = col("isin"), cQty = col("quantity");
    const cBuyVal = col("buyvalue"), cSellDate = col("selldate"), cSellVal = col("sellvalue");
    const cPnl = col("p&lvalue");

    const scrips = new Map<string, ScripAgg>();
    let sumPnl = 0;
    let totalRow: string[] | null = null;
    const shapes = new Set<DateShape>();
    let undated = 0;

    for (let i = detailHeaderAt + 1; i < detail.length; i++) {
      const r = detail[i];
      const name = (r[cName] ?? "").trim();
      if (!name) continue;
      if (name.toLowerCase() === "total") {
        totalRow = r;
        continue; // the Total row is a CHECK, never a figure
      }
      sourceRows++;
      const rawSell = r[cSellDate];
      const shape = dateShape(rawSell);
      if (shape) shapes.add(shape);
      const asOf = lotDate(rawSell);
      if (!asOf) undated++;
      const isinCell = (r[cIsin] ?? "").trim().toUpperCase();
      const isin = /^[A-Z]{2}[A-Z0-9]{10}$/.test(isinCell) ? isinCell : "";
      const pnl = parseTextMoney(r[cPnl]);
      sumPnl += pnl;
      bump(scrips, {
        // Keyed by ISIN when the file states one; a scrip with no ISIN is
        // keyed by its own name rather than pooled into a blank bucket with
        // every other unidentified row.
        isin,
        symbol: name,
        asOf,
        fy: asOf ? fyOfDate(asOf) : null,
        qty: parseTextMoney(r[cQty]),
        buyValue: parseTextMoney(r[cBuyVal]),
        sellValue: parseTextMoney(r[cSellVal]),
        grossPnl: pnl,
      });
    }

    // ── Conservation: Σ of the lots against the file's own Total ────────────
    if (totalRow) {
      const stated = parseTextMoney(totalRow[cPnl]);
      if (Math.abs(r2(sumPnl) - r2(stated)) > 0.005) {
        warnings.push(
          `The lot rows sum to ₹${r2(sumPnl).toFixed(2)} but the file's own Total says ₹${r2(stated).toFixed(2)} ` +
            `(difference ₹${r2(sumPnl - stated).toFixed(2)}) — some rows were not read as this parser expects.`,
        );
      }
    } else {
      warnings.push("The Realized P&L Detail sheet carried no Total row, so its figures could not be checked against the file's own sum.");
    }

    if (undated > 0) warnings.push(`${undated} lot row${undated === 1 ? "" : "s"} carried no readable Sell Date and are filed without one.`);
    if (shapes.size > 1) warnings.push(`The Sell Date column mixes ${[...shapes].join(" and ")} notations.`);
    if (shapes.has("numeric-day-first")) {
      warnings.push("Dates are written dd-mm-yyyy; read day-first, the way every Indian broker export in this repo writes them. If a date looks wrong, this is where to check.");
    }

    // ── scrip rows ──────────────────────────────────────────────────────────
    for (const s of [...scrips.values()]) {
      reference.push({
        scope: "scrip",
        key: s.isin || s.symbol.toUpperCase(),
        isin: s.isin || null,
        symbol: s.symbol,
        fy: s.fy,
        asOf: s.asOf,
        figures: { qty: r2(s.qty), buyValue: r2(s.buyValue), sellValue: r2(s.sellValue), grossPnl: r2(s.grossPnl) },
        note: null,
      });
    }

    // ── FY totals ───────────────────────────────────────────────────────────
    const fys = new Map<string, { qty: number; buyValue: number; sellValue: number; grossPnl: number }>();
    for (const s of scrips.values()) {
      if (!s.fy) continue;
      const cur = fys.get(s.fy) ?? { qty: 0, buyValue: 0, sellValue: 0, grossPnl: 0 };
      cur.qty += s.qty; cur.buyValue += s.buyValue; cur.sellValue += s.sellValue; cur.grossPnl += s.grossPnl;
      fys.set(s.fy, cur);
    }
    for (const [fy, f] of fys) {
      reference.push({
        scope: "fy",
        key: fy,
        isin: null,
        symbol: null,
        fy,
        asOf: null,
        figures: { qty: r2(f.qty), buyValue: r2(f.buyValue), sellValue: r2(f.sellValue), grossPnl: r2(f.grossPnl) },
        note: null,
      });
    }
  }

  // ── Summary fallback ──────────────────────────────────────────────────────
  // ONLY when the detail sheet is absent. The two tables state the same book;
  // the detail sheet states it per lot WITH DATES, so it wins outright — and
  // storing both would put two broker figures against one scrip, which is the
  // duplication `broker_reference`'s unique index exists to prevent.
  if (reference.length === 0 && summary) {
    const at = summary.findIndex(isRealizedSummaryHeader);
    if (at >= 0) {
      const h = summary[at].map(norm);
      const col = (k: string) => h.indexOf(k);
      const cName = col("scripname"), cIsin = col("isin"), cQty = col("quantity");
      const cBuyVal = col("buyvalue"), cSellVal = col("sellvalue"), cPnl = col("realizedp&l");
      // The period line (row 3) is read for its FY ONLY. Its text is identity-
      // adjacent file metadata and is never emitted.
      const periodEnd = summary.slice(0, 6).map((r) => r[1] ?? "")
        .map((s) => s.match(/to\s+(.+)$/i)?.[1]?.trim() ?? "")
        .find(Boolean);
      const fy = periodEnd ? fyOfDate(lotDate(periodEnd) ?? "") : null;
      for (let i = at + 1; i < summary.length; i++) {
        const r = summary[i];
        const name = (r[cName] ?? "").trim();
        if (!name) continue;
        if (name.toLowerCase() === "total") break;
        if (isUnrealizedSummaryHeader(r)) break;
        const isinCell = (r[cIsin] ?? "").trim().toUpperCase();
        const isin = /^[A-Z]{2}[A-Z0-9]{10}$/.test(isinCell) ? isinCell : "";
        sourceRows++;
        reference.push({
          scope: "scrip",
          key: isin || name.toUpperCase(),
          isin: isin || null,
          symbol: name,
          fy,
          asOf: null,
          figures: {
            qty: r2(parseTextMoney(r[cQty])),
            buyValue: r2(parseTextMoney(r[cBuyVal])),
            sellValue: r2(parseTextMoney(r[cSellVal])),
            grossPnl: r2(parseTextMoney(r[cPnl])),
          },
          note: "summary",
        });
      }
      if (reference.length) {
        warnings.push("Read from the Summary P&L sheet — this file carries no Realized P&L Detail, so the figures are per scrip for the whole period, with no sell dates.");
      }
    }
  }

  if (reference.length === 0) {
    return { ...base, warnings: ["Could not find Paytm's Realized P&L Detail header (Scrip Name | ISIN | Quantity | Buy Date | … | P&L Value) or a realized Summary table — is this a Paytm Money Realized P&L export?"] };
  }

  warnings.push(CHARGES_WARNING);
  warnings.push(
    `${reference.filter((r) => r.scope === "scrip").length} scrip figures and ` +
      `${reference.filter((r) => r.scope === "fy").length} financial-year total${reference.filter((r) => r.scope === "fy").length === 1 ? "" : "s"} ` +
      "were read as the BROKER'S OWN numbers. They are stored beside your journal for reconciliation and import no trades — the book stays the Paytm tradebook.",
  );

  return { ...base, reference, sourceRows, warnings };
}
