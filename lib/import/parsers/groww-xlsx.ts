import * as XLSX from "xlsx";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParseContext, ParsedFile } from "../types";

const toNum = (v: unknown): number => {
  if (v == null) return 0;
  const x = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};

/** Confidence this is a Groww stocks P&L XLSX. */
export function detectGrowwXlsx(ctx: ParseContext): number {
  if (!ctx.buffer) return 0;
  let score = 0;
  if (/groww|stocks_pnl/i.test(ctx.filename)) score += 0.4;
  try {
    const wb = XLSX.read(ctx.buffer, { type: "buffer", bookSheets: true });
    if (wb.SheetNames.includes("Trade Level")) score += 0.4;
    if (wb.SheetNames.includes("Scrip Level")) score += 0.2;
  } catch {
    return 0;
  }
  return Math.min(1, score);
}

/**
 * Groww XLSX: "Trade Level" sheet holds a Summary block (full charge breakdown),
 * a "Realised trades" table (buy/sell dates, values, Realised P&L, Remark) and an
 * "Unrealised trades" table. Realised P&L is GROSS. Remark "Intraday trade" → intraday.
 */
export function parseGrowwXlsx(ctx: ParseContext): ParsedFile {
  if (!ctx.buffer) {
    return { sourceId: "groww-xlsx", broker: "groww", format: "xlsx", trades: [], warnings: ["No file buffer."] };
  }
  const wb = XLSX.read(ctx.buffer, { type: "buffer" });
  const ws = wb.Sheets["Trade Level"];
  if (!ws) {
    return {
      sourceId: "groww-xlsx",
      broker: "groww",
      format: "xlsx",
      trades: [],
      warnings: ["No 'Trade Level' sheet — is this a Groww stocks P&L export?"],
    };
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });

  const pick = (label: string): number => {
    const row = rows.find((r) => r[0] === label);
    return row ? toNum(row[1]) : 0;
  };
  const reported: Record<string, number> = {
    realisedPnl: pick("Realised P&L"),
    unrealisedPnl: pick("Unrealised P&L"),
    exchangeTxn: pick("Exchange Transaction Charges"),
    sebi: pick("SEBI Charges"),
    stt: pick("STT"),
    stamp: pick("Stamp Duty"),
    ipft: pick("IPFT Charges"),
    brokerage: pick("Brokerage"),
    cdslDp: pick("CDSL DP Charges"),
    growwDp: pick("Groww DP Charges"),
    mtfPledge: pick("MTF Pledge Charges"),
    mtfUnpledge: pick("MTF Unpledge Charges"),
    mtfInterest: pick("MTF interest"),
    gst: pick("Total GST"),
    total: pick("Total"),
  };

  const trades: NormalizedTrade[] = [];
  const warnings: string[] = [];

  const realHdr = rows.findIndex((r) => r[0] === "Stock name" && r.includes("Sell date"));
  const unrealMarker = rows.findIndex((r) => r[0] === "Unrealised trades");
  const realEnd = unrealMarker >= 0 ? unrealMarker : rows.length;
  if (realHdr >= 0) {
    for (let i = realHdr + 1; i < realEnd; i++) {
      const r = rows[i];
      if (!r || !r[0]) continue;
      const remark = String(r[10] ?? "").trim();
      trades.push({
        broker: "groww",
        tradingsymbol: String(r[0]),
        isin: r[1] ? String(r[1]) : null,
        buyQty: toNum(r[2]),
        avgBuyPrice: toNum(r[4]),
        buyValue: toNum(r[5]),
        sellQty: toNum(r[2]),
        avgSellPrice: toNum(r[7]),
        sellValue: toNum(r[8]),
        closingPrice: null,
        grossPnl: toNum(r[9]),
        unrealisedPnl: 0,
        buyDate: r[3] ? String(r[3]) : null,
        sellDate: r[6] ? String(r[6]) : null,
        productHint: remark === "Intraday trade" ? "intraday" : "delivery",
        exchangeHint: null,
        sourceFile: ctx.filename,
      });
    }
  }

  const unrealHdr = rows.findIndex((r) => r[0] === "Stock name" && r.includes("Closing date"));
  if (unrealHdr >= 0) {
    for (let i = unrealHdr + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r[0]) continue;
      if (String(r[0]).startsWith("Disclaimer")) break;
      trades.push({
        broker: "groww",
        tradingsymbol: String(r[0]),
        isin: r[1] ? String(r[1]) : null,
        buyQty: toNum(r[2]),
        avgBuyPrice: toNum(r[4]),
        buyValue: toNum(r[5]),
        sellQty: 0,
        avgSellPrice: 0,
        sellValue: 0,
        closingPrice: toNum(r[7]) || null,
        grossPnl: 0,
        unrealisedPnl: toNum(r[9]),
        buyDate: r[3] ? String(r[3]) : null,
        sellDate: null,
        productHint: "delivery",
        exchangeHint: null,
        sourceFile: ctx.filename,
      });
    }
  }

  warnings.push(
    "Groww trade rows don't flag MTF — pledge/interest charges in the summary indicate some holdings were MTF; re-tag in Trades.",
  );

  return { sourceId: "groww-xlsx", broker: "groww", format: "xlsx", trades, reported, warnings };
}
