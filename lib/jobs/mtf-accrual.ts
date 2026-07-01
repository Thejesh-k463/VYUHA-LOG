import "server-only";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { findRates } from "@/lib/engine/rates";
import { mtfRateFor } from "@/lib/engine/charges";
import type { Broker, Exchange } from "@/lib/domain/constants";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Daily MTF interest accrual. Recomputes accrued interest for every OPEN eq_mtf
 * position from T+1 (buy date) to `today`, updating charges_total and net_pnl.
 * Idempotent — safe to run on every app open (it recomputes, not increments).
 */
export function accrueMtfInterest(today = new Date().toISOString().slice(0, 10)): {
  updated: number;
  totalAccrued: number;
} {
  const open = db
    .select()
    .from(trades)
    .where(and(eq(trades.segment, "eq_mtf"), eq(trades.isOpen, true)))
    .all();
  if (open.length === 0) return { updated: 0, totalAccrued: 0 };

  const rates = loadRatesMap();
  let updated = 0;
  let totalAccrued = 0;

  for (const t of open) {
    if (!t.buyDate) continue;
    const funded = t.buyValue; // MTF funded ≈ position cost
    const days = Math.max(0, Math.floor((new Date(today + "T00:00:00").getTime() - new Date(t.buyDate + "T00:00:00").getTime()) / 86400000) - 1); // from T+1
    const r = findRates(rates, t.broker as Broker, "eq_mtf", t.exchange as Exchange);
    const rate = mtfRateFor(funded, r);
    const interest = r2((funded * rate * days) / 365);
    if (interest === t.mtfInterest) continue;

    const newCharges = r2(t.chargesTotal - t.mtfInterest + interest);
    const newNet = r2(t.grossPnl - newCharges);
    db.update(trades)
      .set({ mtfInterest: interest, chargesTotal: newCharges, netPnl: newNet })
      .where(eq(trades.id, t.id))
      .run();
    updated++;
    totalAccrued += interest;
  }
  return { updated, totalAccrued: r2(totalAccrued) };
}
