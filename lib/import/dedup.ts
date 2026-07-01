import { createHash } from "node:crypto";
import type { NormalizedTrade } from "@/lib/engine/types";

/**
 * Stable per-broker dedup hash from broker + tradingsymbol + qty + prices + dates.
 * Used to skip duplicates on overlapping re-imports and to key manual overrides.
 */
export function dedupHash(t: NormalizedTrade): string {
  const parts = [
    t.broker,
    t.tradingsymbol.trim().toUpperCase(),
    t.buyQty,
    t.avgBuyPrice,
    t.buyValue,
    t.sellQty,
    t.avgSellPrice,
    t.sellValue,
    t.buyDate ?? "",
    t.sellDate ?? "",
  ];
  return createHash("sha1").update(parts.join("|")).digest("hex");
}
