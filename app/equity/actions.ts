"use server";

import { todayIstIso } from "@/lib/domain/trading-day";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import { DERIVATIVE_MARK_MESSAGE, isDerivativeInstrument, writeTypedMark } from "@/lib/queries/mtm";

export type MtmState = { ok: boolean; message: string; updated: number };

const numOrNull = (v: unknown): number | null => {
  const x = Number(String(v ?? "").trim());
  return Number.isFinite(x) && String(v ?? "").trim() !== "" ? x : null;
};

/**
 * Bulk MTM/EOD + stops entry. One line per position:
 *   SYMBOL price [SL] [TSL] [target]
 * Space- or comma-separated. Only the price is required; SL/TSL/target are optional
 * and only overwrite when provided. Examples:
 *   RELIANCE 1380.5 1350 1365 1450
 *   ADANI TOTAL GAS LIMITED, 724.35, 705, 715, 760
 *   NIFTY,23450                          (price only)
 * SL/TSL/target update every OPEN position whose symbol matches (case-insensitive)
 * and recompute risk (= |entry − SL| × open qty) + R-multiple.
 */
export async function saveMtmPrices(_prev: MtmState, formData: FormData): Promise<MtmState> {
  const text = String(formData.get("prices") ?? "");
  const asOf = String(formData.get("asOf") || todayIstIso());
  // The row this writes REPLACES the day's mark and every reader takes the
  // newest `as_of_date` as a string, so a date that is not YYYY-MM-DD would
  // sort above every real day and become the permanent "latest" mark.
  if (!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(asOf)) {
    return { ok: false, message: "The as-of date must be YYYY-MM-DD.", updated: 0 };
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Index open trades by upper-cased symbol for SL/TSL/target matching.
  const accountId = getSelectedAccountId();
  const open = db.select().from(trades).where(accountId > 0
    ? and(eq(trades.isOpen, true), eq(trades.accountId, accountId))
    : eq(trades.isOpen, true)).all();
  const bySymbol = new Map<string, typeof open>();
  for (const t of open) {
    const k = t.symbol.toUpperCase();
    const arr = bySymbol.get(k) ?? [];
    arr.push(t);
    bySymbol.set(k, arr);
  }

  let priceCount = 0;
  let stopCount = 0;
  let skipped = 0;
  let zeroed = 0;
  let derivatives = 0;
  const now = sql`(datetime('now'))`;

  for (const line of lines) {
    let symbol = "";
    let price: number | null = null, sl: number | null = null, tsl: number | null = null, target: number | null = null;

    if (line.includes(",")) {
      const c = line.split(",").map((s) => s.trim());
      // "RELIANCE, 3,100.50" splits into "3" and "100.50" — a thousands
      // separator, not a ₹3 price with a ₹100.50 stop. Since this write now
      // REPLACES the day's mark, an ambiguous line is refused rather than
      // read wrongly (invariant 6: no mark beats a wrong one). The same
      // grouping in the space form lands the digits in the symbol cell
      // ("RELIANCE 3" + "100.50"); refused the same way.
      const cells = c.slice(1);
      const grouped =
        cells.some((cell, i) => /^\d{1,3}$/.test(cell) && /^\d{3}(?:\.\d+)?$/.test(cells[i + 1] ?? "")) ||
        (/\s\d{1,3}$/.test(c[0] ?? "") && /^\d{3}(?:\.\d+)?$/.test(cells[0] ?? ""));
      if (grouped) {
        skipped++;
        continue;
      }
      symbol = c[0] ?? "";
      price = numOrNull(c[1]); sl = numOrNull(c[2]); tsl = numOrNull(c[3]); target = numOrNull(c[4]);
    } else {
      const m = line.match(/^(.*?)\s+([\d.]+)(?:\s+([\d.]+))?(?:\s+([\d.]+))?(?:\s+([\d.]+))?\s*$/);
      if (!m) continue;
      symbol = m[1].trim();
      price = numOrNull(m[2]); sl = numOrNull(m[3]); tsl = numOrNull(m[4]); target = numOrNull(m[5]);
    }
    if (!symbol) continue;
    const key = symbol.toUpperCase();

    const book = bySymbol.get(key) ?? [];
    const onlyDerivatives = book.length > 0 && book.every((t) => isDerivativeInstrument(t));
    if (price != null && !(price > 0)) {
      // A pasted 0 is not a mark, and since this write replaces the day's row
      // it would erase the real one — the mark is skipped (stops still apply).
      zeroed++;
    } else if (price != null && onlyDerivatives) {
      // The premium would land under the underlying's symbol and erase its
      // cash mark (owner ruling, fix wave 3 audit) — skipped, and said so.
      derivatives++;
    } else if (price != null) {
      // DELETE-THEN-INSERT for (symbol, as-of day) — the same one transaction
      // the feed and the bhavcopy apply use. A bare insert left a SECOND row
      // for a day that already had one, and every reader takes the first row
      // of the newest `as_of_date` in rowid order, so the price pasted here
      // after the automatic 15:31 mark was stored and then ignored.
      // The paste knows only the symbol; hand over the open trade's
      // tradingsymbol so the feed's key survives the replacement (undefined,
      // not null, lets `writeTypedMark` carry the held row's value).
      const tradingsymbol = (bySymbol.get(key) ?? []).find((t) => t.tradingsymbol)?.tradingsymbol;
      writeTypedMark({ symbol: key, tradingsymbol, price, asOfDate: asOf });
      priceCount++;
    }

    if (sl != null || tsl != null || target != null) {
      for (const t of bySymbol.get(key) ?? []) {
        const qty = Math.max(t.buyQty - t.sellQty, 0) || t.buyQty;
        const riskAmount =
          sl != null && qty > 0 ? Math.round(Math.abs(t.avgBuyPrice - sl) * qty * 100) / 100 : t.riskAmount;
        const rMultiple =
          riskAmount && riskAmount > 0 ? Math.round((t.netPnl / riskAmount) * 100) / 100 : t.rMultiple;
        db.update(trades)
          .set({
            ...(sl != null ? { slPlanned: sl, riskAmount, rMultiple } : {}),
            ...(tsl != null ? { trailingSl: tsl } : {}),
            ...(target != null ? { targetPlanned: target } : {}),
            updatedAt: now,
          })
          .where(eq(trades.id, t.id))
          .run();
        stopCount++;
      }
    }
  }

  revalidatePath("/equity");
  revalidatePath("/active");
  revalidatePath("/risk");
  revalidatePath("/");

  const parts: string[] = [];
  if (priceCount) parts.push(`${priceCount} price${priceCount === 1 ? "" : "s"}`);
  if (stopCount) parts.push(`${stopCount} stop/target update${stopCount === 1 ? "" : "s"}`);
  const notes: string[] = [];
  if (skipped) notes.push(`${skipped} line${skipped === 1 ? "" : "s"} skipped — write prices without thousands separators (3100.50, not 3,100.50).`);
  if (zeroed) notes.push(`${zeroed} line${zeroed === 1 ? "" : "s"} with a price of 0 or less: no mark stored.`);
  if (derivatives) notes.push(`${derivatives} line${derivatives === 1 ? "" : "s"} skipped — ${DERIVATIVE_MARK_MESSAGE.toLowerCase()}`);
  const skippedNote = notes.length ? " " + notes.join(" ") : "";
  return {
    ok: priceCount > 0 || stopCount > 0,
    message: (parts.length ? `Updated ${parts.join(" + ")}.` : "No valid lines found.") + skippedNote,
    updated: priceCount + stopCount,
  };
}
