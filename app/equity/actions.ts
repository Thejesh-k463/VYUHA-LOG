"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { mtmPrices, trades } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

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
  const asOf = String(formData.get("asOf") || new Date().toISOString().slice(0, 10));
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Index open trades by upper-cased symbol for SL/TSL/target matching.
  const open = db.select().from(trades).where(eq(trades.isOpen, true)).all();
  const bySymbol = new Map<string, typeof open>();
  for (const t of open) {
    const k = t.symbol.toUpperCase();
    const arr = bySymbol.get(k) ?? [];
    arr.push(t);
    bySymbol.set(k, arr);
  }

  let priceCount = 0;
  let stopCount = 0;
  const now = sql`(datetime('now'))`;

  for (const line of lines) {
    let symbol = "";
    let price: number | null = null, sl: number | null = null, tsl: number | null = null, target: number | null = null;

    if (line.includes(",")) {
      const c = line.split(",").map((s) => s.trim());
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

    if (price != null) {
      db.insert(mtmPrices).values({ symbol: key, price, asOfDate: asOf, updatedAt: now }).run();
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
  return {
    ok: priceCount > 0 || stopCount > 0,
    message: parts.length ? `Updated ${parts.join(" + ")}.` : "No valid lines found.",
    updated: priceCount + stopCount,
  };
}
