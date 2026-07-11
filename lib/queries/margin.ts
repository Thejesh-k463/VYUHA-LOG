import "server-only";
import { db } from "@/lib/db";
import { marginConfig, type MarginConfigRow } from "@/lib/db/schema";
import type { MarginRates } from "@/lib/risk/margin";

export function getMarginConfig(): MarginConfigRow[] {
  return db.select().from(marginConfig).all().sort((a, b) => a.segment.localeCompare(b.segment));
}

export function getMarginRates(): MarginRates {
  const map: MarginRates = new Map();
  for (const r of getMarginConfig()) map.set(r.segment, r.marginPct);
  return map;
}
