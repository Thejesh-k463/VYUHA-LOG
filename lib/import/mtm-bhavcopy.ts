import "server-only";
import { db } from "@/lib/db";
import { trades as tradesTable, mtmPrices, priceHistory } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { parseBhavcopy, type BhavcopyFormat } from "./bhavcopy";
import { recordAudit } from "@/lib/audit";
import { getAliasMap } from "@/lib/queries/aliases";
import { resolveTicker } from "@/lib/analytics/aliases";

// IND-12 / P1.3 — apply a bhavcopy to mark open EQUITY positions to market in one
// step. Cash bhavcopy carries the underlying close, so option/future positions are
// reported as skipped (their mark is a premium, not the underlying spot).

export interface BhavcopyMtmResult {
  ok: boolean;
  message: string;
  format: BhavcopyFormat;
  date: string | null;
  parsed: number; // prices found in the file
  equityHeld: number; // open equity symbols
  priced: number; // matched & updated
  derivativesSkipped: number; // open option/future symbols (need premium)
  unmatched: string[]; // equity symbols not present in the file
  historyRows: number; // OHLC bars persisted to price_history (P1.3)
}

export function applyBhavcopyMtm(text: string): BhavcopyMtmResult {
  const bc = parseBhavcopy(text);
  const base = { format: bc.format, date: bc.date, parsed: bc.count };
  if (bc.count === 0) {
    return { ok: false, message: bc.warnings[0] ?? "No prices parsed.", ...base, equityHeld: 0, priced: 0, derivativesSkipped: 0, unmatched: [], historyRows: 0 };
  }

  const open = db.select().from(tradesTable).where(eq(tradesTable.isOpen, true)).all();
  const equitySyms = [...new Set(open.filter((t) => t.instrumentType === "equity").map((t) => t.symbol.toUpperCase()))];
  const derivativesSkipped = new Set(open.filter((t) => t.instrumentType !== "equity").map((t) => t.symbol.toUpperCase())).size;
  const asOf = bc.date ?? new Date().toISOString().slice(0, 10);
  const aliasMap = getAliasMap();

  // Persist the full EOD snapshot to price_history (P1.3) — builds the OHLC series
  // for every cash symbol in the file, not just held positions. Upsert by symbol+date.
  const barEntries = Object.entries(bc.bars);
  let historyRows = 0;
  db.transaction((tx) => {
    for (const [sym, bar] of barEntries) {
      tx.insert(priceHistory)
        .values({ symbol: sym, date: asOf, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, source: "bhavcopy" })
        .onConflictDoUpdate({
          target: [priceHistory.symbol, priceHistory.date],
          set: { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, source: "bhavcopy" },
        })
        .run();
      historyRows++;
    }
  });

  let priced = 0;
  const unmatched: string[] = [];
  db.transaction((tx) => {
    for (const sym of equitySyms) {
      // Try the held name directly, then its canonical ticker alias (real bhavcopy uses tickers).
      const px = bc.prices[sym] ?? bc.prices[resolveTicker(sym, aliasMap)];
      if (px == null) {
        unmatched.push(sym);
        continue;
      }
      tx.delete(mtmPrices).where(and(eq(mtmPrices.symbol, sym), eq(mtmPrices.asOfDate, asOf))).run();
      tx.insert(mtmPrices).values({ symbol: sym, tradingsymbol: sym, price: px, asOfDate: asOf }).run();
      priced++;
    }
  });

  recordAudit({
    entity: "settings",
    action: "update",
    summary: `bhavcopy auto-MTM (${bc.format}) — priced ${priced}/${equitySyms.length} equity @ ${asOf}; ${historyRows} price_history rows`,
    source: "bhavcopy",
  });

  return {
    ok: true,
    message: `Marked ${priced} of ${equitySyms.length} open equity position${equitySyms.length === 1 ? "" : "s"} to market${
      derivativesSkipped ? `; ${derivativesSkipped} derivative position${derivativesSkipped === 1 ? "" : "s"} skipped (need premium)` : ""
    }. Saved ${historyRows} EOD bar${historyRows === 1 ? "" : "s"} to price history.`,
    ...base,
    equityHeld: equitySyms.length,
    priced,
    derivativesSkipped,
    unmatched,
    historyRows,
  };
}
