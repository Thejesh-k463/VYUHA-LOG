import "server-only";
import { db } from "@/lib/db";
import { mtfMargins } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { resolveMtfMargin, type MtfMarginResolution } from "@/lib/risk/mtf-margins";
import { getMarginRates } from "@/lib/queries/margin";
import { marginKey } from "@/lib/risk/margin";

/** Uploaded per-stock overrides for one broker: SYMBOL → { pct, asOf }. */
export function getMtfOverrides(broker: string): Map<string, { pct: number; asOf: string }> {
  const out = new Map<string, { pct: number; asOf: string }>();
  for (const r of db.select().from(mtfMargins).where(eq(mtfMargins.broker, broker)).all()) {
    out.set(r.symbol, { pct: r.marginPct, asOf: r.asOf });
  }
  return out;
}

/** Full resolution chain for one broker+symbol — the one the API and pages use. */
export function resolveMtfMarginDb(broker: string, symbol: string): MtfMarginResolution {
  const overrides = getMtfOverrides(broker);
  const configPct = getMarginRates().get(marginKey(broker, "eq_mtf")) ?? null;
  return resolveMtfMargin(broker, symbol, overrides, configPct);
}

/** Resolver over a prefetched cache — for pages resolving many positions. */
export function makeMtfResolver(): (broker: string, symbol: string) => MtfMarginResolution {
  const rates = getMarginRates();
  const overrideCache = new Map<string, Map<string, { pct: number; asOf: string }>>();
  return (broker, symbol) => {
    if (!overrideCache.has(broker)) overrideCache.set(broker, getMtfOverrides(broker));
    return resolveMtfMargin(broker, symbol, overrideCache.get(broker)!, rates.get(marginKey(broker, "eq_mtf")) ?? null);
  };
}
