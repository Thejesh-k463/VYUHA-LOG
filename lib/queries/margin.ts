import "server-only";
import { db } from "@/lib/db";
import { marginConfig, type MarginConfigRow } from "@/lib/db/schema";
import { marginKey, DEFAULT_MTF_OWN_MARGIN_PCT, type MarginRates } from "@/lib/risk/margin";

export function getMarginConfig(): MarginConfigRow[] {
  return db.select().from(marginConfig).all().sort((a, b) => a.broker.localeCompare(b.broker) || a.segment.localeCompare(b.segment));
}

/** All broker×segment margin rates, keyed "broker|segment" (see lib/risk/margin.ts#marginKey). */
export function getMarginRates(): MarginRates {
  const map: MarginRates = new Map();
  for (const r of getMarginConfig()) map.set(marginKey(r.broker, r.segment), r.marginPct);
  return map;
}

/** Convenience single lookup — the own-margin % for one broker+segment (falls
 * back to the seeded default when the row is somehow missing). */
export function getMarginPct(broker: string, segment: string): number {
  return getMarginRates().get(marginKey(broker, segment)) ?? DEFAULT_MTF_OWN_MARGIN_PCT;
}

/** eq_mtf own-margin % for every broker — used to thread a broker-aware
 * default into client forms where the user picks the broker themselves. */
export function getMtfMarginByBroker(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of getMarginConfig()) if (r.segment === "eq_mtf") out[r.broker] = r.marginPct;
  return out;
}
