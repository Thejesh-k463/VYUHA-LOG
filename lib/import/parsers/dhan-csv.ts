import Papa from "papaparse";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParseContext, ParsedFile } from "../types";

const toNum = (v: unknown): number => {
  if (v == null) return 0;
  const x = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};

/** Confidence this is a Dhan P&L CSV. */
export function detectDhanCsv(ctx: ParseContext): number {
  const text = ctx.text ?? "";
  if (!text) return 0;
  let score = 0;
  if (/dhan/i.test(ctx.filename)) score += 0.3;
  if (/^PnL report/i.test(text.trimStart())) score += 0.4;
  if (/Scrip Name,.*Realised P&L/i.test(text)) score += 0.4;
  if (/Net P&L,.*Brokerage,.*Gross P&L,.*Total Charges/i.test(text)) score += 0.2;
  return Math.min(1, score);
}

/**
 * Dhan P&L CSV: 5-row identity header, blank line, scrip-aggregated table, then a
 * footer `Net P&L,.,Brokerage,.,Gross P&L,.,Total Charges,.`.
 * Row P&L is GROSS. No per-trade dates, no segment tag, no per-scrip charges.
 * Rows with Sell Qty = 0 are open positions (use Closing Price for MTM).
 */
export function parseDhanCsv(ctx: ParseContext): ParsedFile {
  const text = ctx.text ?? "";
  const { data } = Papa.parse<string[]>(text, { skipEmptyLines: false });
  const rows = data;
  const warnings: string[] = [];

  const hdr = rows.findIndex((r) => r[0] === "Scrip Name");
  if (hdr < 0) {
    return {
      sourceId: "dhan-csv",
      broker: "dhan",
      format: "pnl",
      trades: [],
      warnings: ["Could not find the 'Scrip Name' header row — is this a Dhan P&L CSV?"],
    };
  }

  const trades: NormalizedTrade[] = [];
  let reported: Record<string, number> | undefined;

  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    if (r[0].startsWith("Net P&L")) {
      reported = {
        netPnl: toNum(r[1]),
        brokerage: toNum(r[3]),
        grossPnl: toNum(r[5]),
        totalCharges: toNum(r[7]),
      };
      continue;
    }
    if (r[0].startsWith("NOTE")) continue;
    if (r.length < 12) continue;

    trades.push({
      broker: "dhan",
      tradingsymbol: r[0],
      isin: null,
      buyQty: toNum(r[1]),
      avgBuyPrice: toNum(r[2]),
      buyValue: toNum(r[3]),
      sellQty: toNum(r[4]),
      avgSellPrice: toNum(r[5]),
      sellValue: toNum(r[6]),
      closingPrice: toNum(r[7]) || null,
      grossPnl: toNum(r[8]),
      unrealisedPnl: toNum(r[10]),
      buyDate: null,
      sellDate: null,
      productHint: null, // Dhan P&L carries no segment tag → equity defaults to delivery
      exchangeHint: null,
      sourceFile: ctx.filename,
    });
  }

  warnings.push(
    "Dhan P&L has no segment/MTF flag or per-trade dates — equity rows default to delivery; re-tag MTF/intraday in Trades.",
  );

  return { sourceId: "dhan-csv", broker: "dhan", format: "pnl", trades, reported, warnings };
}
