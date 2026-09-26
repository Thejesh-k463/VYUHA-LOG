/**
 * LTCG GRANDFATHERING LOTS, GROUPED PER SCRIP (v4.6.0 W7, D3) — pure.
 *
 * ZERO DB and ZERO React imports (invariant 2). The FMV on 31-Jan-2018 is a
 * fact about a SCRIP, not about a trade, so the /reports/tax editor lists one
 * row per scrip (symbol + ISIN) and one Save writes the same per-share figure
 * onto every lot of it. The stored column stays per TRADE
 * (`trades.fmv_31_jan_2018`) — the readers (lib/queries/tax-itr.ts) multiply it
 * by each row's own quantity, unchanged.
 *
 * `grandfatherKey` is THE one key: the page groups by it and the write route
 * (app/api/trades/fmv/route.ts) refuses a multi-id write whose lots do not
 * share it, so an FMV can never land on a second scrip.
 *
 * Every date decision goes through `isGrandfatherEligible` / `normalizeDate` —
 * NEVER a byte comparison against GRANDFATHER_DATE: a legacy DD-MM-YYYY row
 * '15-06-2019' sorts BELOW '2018-02-01' bytewise (it would be listed), and
 * '31-12-2017' sorts above it (it would be hidden).
 */

import { isGrandfatherEligible } from "@/lib/analytics/cg-heads";
import { normalizeDate } from "@/lib/domain/trading-day";

/** One pre-2018 lot as the editor shows it — the PARENT trade row. */
export interface FmvLot {
  id: number;
  symbol: string;
  isin: string | null;
  buyDate: string | null;
  sellDate: string | null;
  isOpen: boolean;
  buyQty: number;
  avgBuyPrice: number;
  /** PER SHARE, as stored. */
  fmv31Jan2018: number | null;
}

export interface FmvGroup {
  key: string;
  symbol: string;
  isin: string | null;
  ids: number[];
  /** The group's lots, oldest eligible buy date first. */
  lots: FmvLot[];
  totalQty: number;
  /** ISO days. */
  firstBuyDate: string;
  lastBuyDate: string;
  /** The shared per-share FMV; null when no lot has one; "mixed" when they differ. */
  fmv: number | null | "mixed";
}

/**
 * THE key a scrip is grouped — and a multi-id FMV write checked — by. The ISIN
 * is trimmed and upper-cased (a stored ' ine009a01021' is the same scrip as
 * 'INE009A01021'); blank after the trim is the same as none.
 */
export function grandfatherKey(row: { symbol: string; isin: string | null }): string {
  return `${row.symbol.toUpperCase()}|${(row.isin ?? "").trim().toUpperCase()}`;
}

/** The parent-row fields the tax page's lot selection reads. */
export interface GrandfatherParent {
  id: number;
  symbol: string;
  isin?: string | null;
  segment: string;
  buyDate: string | null;
  sellDate: string | null;
  isOpen: boolean;
  buyQty: number;
  avgBuyPrice: number;
  fmv31Jan2018?: number | null;
}

/**
 * The FMV editor's lots (v4.6.0 W7, D3 R-5): the DISTINCT parents (by id) that
 * stand behind at least one row of the realised book — NOT the closed rows: a
 * partly-sold pre-2018 staged ladder is open, yet its realised rows already
 * carry its FMV into the tax readers — whose segment is eq_delivery | eq_mtf
 * and whose PARENT buyDate is eligible by `isGrandfatherEligible` (the date,
 * never the bytes). Projected to `FmvLot`, in the parents' order.
 */
export function grandfatherLotsOf(
  parents: readonly GrandfatherParent[],
  realised: readonly { id: number }[],
): FmvLot[] {
  const realisedIds = new Set(realised.map((r) => r.id));
  const seen = new Set<number>();
  const out: FmvLot[] = [];
  for (const t of parents) {
    if (seen.has(t.id) || !realisedIds.has(t.id)) continue;
    if (t.segment !== "eq_delivery" && t.segment !== "eq_mtf") continue;
    if (!isGrandfatherEligible(t.buyDate)) continue;
    seen.add(t.id);
    out.push({
      id: t.id, symbol: t.symbol, isin: t.isin ?? null, buyDate: t.buyDate, sellDate: t.sellDate,
      isOpen: t.isOpen, buyQty: t.buyQty, avgBuyPrice: t.avgBuyPrice, fmv31Jan2018: t.fmv31Jan2018 ?? null,
    });
  }
  return out;
}

/**
 * THE mixed-group test, shared by the editor (Save disabled on a blank) and the
 * route (a blank refused, 400, before its transaction): the lots do not all
 * carry the same stored FMV. NULL counts as a VALUE — one lot without an FMV
 * beside others that agree is mixed — because a blank Save over it would wipe
 * the values that exist (v4.6.0 fix wave, SG-1: only the client refused it, and
 * a crafted POST nulled every lot). A uniform group — every lot the same value,
 * or every lot blank — is not mixed, so clearing it stays one Save.
 */
export function fmvIsMixed(lots: readonly { fmv31Jan2018?: number | null }[]): boolean {
  return new Set(lots.map((l) => l.fmv31Jan2018 ?? null)).size > 1;
}

/**
 * Group the eligible lots per `grandfatherKey`. A lot whose buy date is not
 * eligible (on/after 1-Feb-2018, or unreadable) is left out — the readers
 * ignore an FMV on it anyway. Groups are ordered by symbol, then ISIN; lots by
 * ISO buy date, then id.
 */
export function groupGrandfatherLots(rows: readonly FmvLot[]): FmvGroup[] {
  const byKey = new Map<string, { lot: FmvLot; iso: string }[]>();
  for (const lot of rows) {
    if (!isGrandfatherEligible(lot.buyDate)) continue;
    const iso = normalizeDate(lot.buyDate)!; // eligible ⇒ readable
    const key = grandfatherKey(lot);
    const arr = byKey.get(key) ?? [];
    arr.push({ lot, iso });
    byKey.set(key, arr);
  }

  const groups: FmvGroup[] = [];
  for (const [key, entries] of byKey) {
    entries.sort((a, b) => (a.iso !== b.iso ? (a.iso < b.iso ? -1 : 1) : a.lot.id - b.lot.id));
    const lots = entries.map((e) => e.lot);
    const fmv: FmvGroup["fmv"] = fmvIsMixed(lots) ? "mixed" : lots[0].fmv31Jan2018;
    groups.push({
      key,
      symbol: lots[0].symbol.toUpperCase(),
      isin: (lots[0].isin ?? "").trim().toUpperCase() || null, // as the key reads it
      ids: lots.map((l) => l.id),
      lots,
      totalQty: Math.round(lots.reduce((s, l) => s + l.buyQty, 0) * 1e4) / 1e4,
      firstBuyDate: entries[0].iso,
      lastBuyDate: entries[entries.length - 1].iso,
      fmv,
    });
  }
  groups.sort((a, b) => a.symbol.localeCompare(b.symbol) || (a.isin ?? "").localeCompare(b.isin ?? ""));
  return groups;
}
