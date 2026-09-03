import { createHash } from "node:crypto";
import type { NormalizedTrade } from "@/lib/engine/types";

/**
 * The fields the dedup hash is built from — a NormalizedTrade satisfies this,
 * and so does a `trades` row read back from SQLite (lib/db/data-fixes.ts
 * re-keys stored rows with exactly this function, so the two can never drift).
 */
export interface DedupInput {
  broker: string;
  tradingsymbol: string;
  isin?: string | null;
  buyQty: number;
  avgBuyPrice: number;
  buyValue: number;
  sellQty: number;
  avgSellPrice: number;
  sellValue: number;
  buyDate?: string | null;
  sellDate?: string | null;
}

/** The broker id `trades.broker` stores for Paytm Money (registry-meta.ts). */
export const PAYTM_BROKER = "paytm";

/**
 * The symbol segment of the hash.
 *
 * Every broker keys on the trimmed, upper-cased label the file carried —
 * byte-for-byte what the hash has always been. Paytm is the one exception
 * (owner ruling 2026-09-04): its `Script` column flips between the ticker and
 * the BSE scrip code from one export to the next, so the same position hashed
 * two ways and re-imported as a duplicate. The ISIN is the identity Paytm does
 * keep stable, so when a Paytm row carries one the segment is `ISIN:<isin>`;
 * a Paytm row WITHOUT an ISIN falls back to the label like everyone else.
 */
export function dedupSymbolKey(broker: string, tradingsymbol: string, isin: string | null | undefined): string {
  if (broker === PAYTM_BROKER) {
    const id = (isin ?? "").trim().toUpperCase();
    if (id) return `ISIN:${id}`;
  }
  return tradingsymbol.trim().toUpperCase();
}

/**
 * Stable per-broker dedup hash from broker + symbol key + qty + prices + dates.
 * Used to skip duplicates on overlapping re-imports and to key manual overrides.
 */
export function dedupHash(t: DedupInput | NormalizedTrade): string {
  const parts = [
    t.broker,
    dedupSymbolKey(t.broker, t.tradingsymbol, t.isin),
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
