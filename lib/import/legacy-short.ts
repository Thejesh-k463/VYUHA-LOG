/**
 * v4.6.0 W6 (contract D5) — the pre-W6 overnight F&O short, at import time.
 *
 * SERVER GRAPH ONLY: it hashes (`dedup.ts` → node:crypto), so it lives apart
 * from `close-open-lots.ts`, which a client component reaches through
 * lib/analytics/data-quality.ts.
 */

import { sideOf } from "@/lib/domain/side";
import { normalizeDate } from "@/lib/domain/trading-day";
import { dedupHash, dedupSymbolKey } from "./dedup";
import { dedupLabelFromNotes } from "./trade-identity";
import { DEDUP_ALIAS_PREFIX, heldIdentityHashes } from "./close-open-lots";
import { pairSymbolLegs, type Leg, type PairedPosition } from "./pair-legs";

// ─── v4.6.0 W6 (contract D5, design review R-6) — the pre-W6 overnight short ──
//
// Before W6 an F&O overnight short (sold day N, bought back day N+1) was filed as
// TWO rows: an opening sell (buyQty 0, acquisition 'unknown') and an open long
// (sellQty 0). Re-importing the same file now pairs it as ONE closed short whose
// `dedupHash` matches neither row (the hash is NEVER changed), so a plain hash
// check would insert the sale's turnover and sell-side charges a second time —
// and deleting the phantom long, or joining the pair, cannot stop that either.
// The refusal is therefore PER LEG: a new closed short whose sell leg IS a stored
// sell-only row of the same book and symbol key, or whose buy leg IS a stored
// buy-only row, is a duplicate. Read by the preview AND the commit.

/** The stored columns the legacy-leg check reads (rupees at runtime, invariant 1). */
export interface LegacyLegRow {
  id: number;
  broker: string;
  tradingsymbol: string;
  isin: string | null;
  importNotes: string | null;
  buyQty: number;
  avgBuyPrice: number;
  buyValue: number;
  buyDate: string | null;
  sellQty: number;
  avgSellPrice: number;
  sellValue: number;
  sellDate: string | null;
}

/** An incoming row, as the check reads it. */
export interface LegacyLegIncoming {
  broker: string;
  tradingsymbol: string;
  isin: string | null;
  dedupLabel?: string | null;
  side?: string | null;
  buyQty: number;
  avgBuyPrice: number;
  buyValue: number;
  buyDate: string | null;
  sellQty: number;
  avgSellPrice: number;
  sellValue: number;
  sellDate: string | null;
}

const paise = (n: number) => Math.round(n * 100);
const sameLeg = (q1: number, p1: number, v1: number, d1: string | null, q2: number, p2: number, v2: number, d2: string | null) =>
  Math.abs(q1 - q2) < 1e-9 && paise(p1) === paise(p2) && paise(v1) === paise(v2) && normalizeDate(d1) != null && normalizeDate(d1) === normalizeDate(d2);

/**
 * Which stored single-leg rows restate this incoming CLOSED SHORT's legs — the
 * pre-W6 two-row shape. Empty for anything else (a long, an open row, a row
 * whose legs match nothing), so every other import de-duplicates exactly as before.
 */
export function legacyShortLegMatch(t: LegacyLegIncoming, stored: readonly LegacyLegRow[]): { saleId: number | null; purchaseId: number | null } {
  const none = { saleId: null, purchaseId: null };
  if (!(t.buyQty > 0 && t.buyQty === t.sellQty) || sideOf(t) !== "short") return none;
  const key = dedupSymbolKey(t.broker, t.tradingsymbol, t.isin, t.dedupLabel);
  let saleId: number | null = null;
  let purchaseId: number | null = null;
  for (const r of stored) {
    if (r.broker !== t.broker || dedupSymbolKey(r.broker, r.tradingsymbol, r.isin, dedupLabelFromNotes(r.importNotes)) !== key) continue;
    if (saleId == null && r.buyQty === 0 && r.sellQty > 0 && sameLeg(r.sellQty, r.avgSellPrice, r.sellValue, r.sellDate, t.sellQty, t.avgSellPrice, t.sellValue, t.sellDate)) saleId = r.id;
    if (purchaseId == null && r.sellQty === 0 && r.buyQty > 0 && sameLeg(r.buyQty, r.avgBuyPrice, r.buyValue, r.buyDate, t.buyQty, t.avgBuyPrice, t.buyValue, t.buyDate)) purchaseId = r.id;
  }
  return { saleId, purchaseId };
}

// ─── fix wave (finding 1) — the pre-W6 pairing, per SYMBOL GROUP ──────────────
//
// The per-leg check above matches only when ONE incoming leg equals ONE stored
// single-leg row. Two shapes defeat it: a PARTLY covered short (pre-W6: opening
// sale 100 + open long 60; post-W6: closed short 60 + opening sale 40 — the
// closed 60 is refused, the leftover 40 is new and would insert, 140 sold) and a
// MULTI-LOT short (pre-W6: opening sales 50 + 50 + open long 130; post-W6: closed
// short 100 + open long 30 — no leg matches, both insert). So for every symbol
// group this file pairs into an overnight short, the file's PRE-W6 pairing is
// recomputed (`pairSymbolLegs` with `shortable` off, over the group's legs), and
// if ANY row of that pairing that the post-W6 pairing does NOT also state is
// already in the book — by `dedupHash` (own or alias), or by its legs — the
// WHOLE group is refused, in preview and commit. The per-leg check stays as the
// second net.
//
// The group's legs are rebuilt from the rows the parser handed over: from the
// fills (`executions`) when they state the row's quantity on a side, else from
// the row's aggregate leg. Aggregates lose the date of each covered lot, so a
// pre-aggregated multi-lot short is recognised by the rows its pairing keeps
// exact (the open long); a tradebook's fills rebuild every pre-W6 row.

/** An incoming row as the group check reads it: its legs, and its fills when the file had them. */
export interface LegacyGroupIncoming extends LegacyLegIncoming {
  executions?: readonly { side: "buy" | "sell"; qty: number; price: number; date: string | null }[] | null;
}

/** A stored row as the group check reads it: its legs, and every hash it answers to. */
export interface LegacyGroupStored extends LegacyLegRow {
  dedupHash: string;
  side?: string | null;
}

export interface LegacyGroupRefusal {
  symbol: string;
  /** Indexes into the incoming array — every row of the group, none inserted. */
  rows: number[];
  /** The stored rows that already state the pre-4.6 pairing. */
  storedIds: number[];
  reason: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const nearMoney = (a: number, b: number) => Math.abs(a - b) <= 0.011;
const sameQty = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** A flat row that sold before it bought, on two different days: what only `shortable` pairs. */
function isOvernightClosedShort(t: LegacyLegIncoming): boolean {
  if (!(t.buyQty > 0 && sameQty(t.buyQty, t.sellQty))) return false;
  const s = normalizeDate(t.sellDate);
  const b = normalizeDate(t.buyDate);
  return s != null && b != null && s < b;
}

/** The group's legs, one per (side, day), or null when a leg states no day. */
function groupLegs(symbol: string, rows: readonly LegacyGroupIncoming[]): Leg[] | null {
  const acc = new Map<string, Leg>();
  for (const t of rows) {
    for (const side of ["buy", "sell"] as const) {
      const qty = side === "buy" ? t.buyQty : t.sellQty;
      if (!(qty > 0)) continue;
      const value = side === "buy" ? t.buyValue : t.sellValue;
      const fills = (t.executions ?? []).filter((e) => e.side === side);
      const fillQty = fills.reduce((s, e) => s + e.qty, 0);
      const fillValue = fills.reduce((s, e) => s + e.qty * e.price, 0);
      const useFills = fills.length > 0 && sameQty(fillQty, qty) && fillValue > 0 && fills.every((e) => normalizeDate(e.date) != null);
      // Fills keep each lot's day; their values are scaled so the side's total is the row's own value.
      const pieces = useFills
        ? fills.map((e) => ({ date: normalizeDate(e.date)!, qty: e.qty, value: (value * e.qty * e.price) / fillValue }))
        : [{ date: normalizeDate(side === "buy" ? t.buyDate : t.sellDate), qty, value }];
      for (const p of pieces) {
        if (p.date == null) return null;
        const key = `${side}|${p.date}`;
        const leg = acc.get(key) ?? { symbol, side, date: p.date, qty: 0, value: 0, charges: 0 };
        leg.qty += p.qty;
        leg.value += p.value;
        acc.set(key, leg);
      }
    }
  }
  return [...acc.values()].map((l) => ({ ...l, value: r2(l.value) }));
}

/** The row a pre-W6 parser built from a paired position (avg = value ÷ qty, to the paisa). */
function preW6Row(p: PairedPosition, t: LegacyLegIncoming) {
  return {
    broker: t.broker,
    tradingsymbol: t.tradingsymbol,
    isin: t.isin,
    dedupLabel: t.dedupLabel ?? null,
    buyQty: p.buyQty,
    avgBuyPrice: p.buyQty > 0 ? r2(p.buyValue / p.buyQty) : 0,
    buyValue: p.buyValue,
    sellQty: p.sellQty,
    avgSellPrice: p.sellQty > 0 ? r2(p.sellValue / p.sellQty) : 0,
    sellValue: p.sellValue,
    buyDate: p.buyDate,
    sellDate: p.sellDate,
  };
}

/** Do two rows state the same legs — quantities, values to the paisa, and each stated leg's day? */
function sameLegs(
  a: { buyQty: number; buyValue: number; buyDate: string | null; sellQty: number; sellValue: number; sellDate: string | null },
  b: { buyQty: number; buyValue: number; buyDate: string | null; sellQty: number; sellValue: number; sellDate: string | null },
): boolean {
  if (!sameQty(a.buyQty, b.buyQty) || !sameQty(a.sellQty, b.sellQty)) return false;
  if (!nearMoney(a.buyValue, b.buyValue) || !nearMoney(a.sellValue, b.sellValue)) return false;
  if (a.buyQty > 0 && normalizeDate(a.buyDate) !== normalizeDate(b.buyDate)) return false;
  if (a.sellQty > 0 && normalizeDate(a.sellDate) !== normalizeDate(b.sellDate)) return false;
  return true;
}

/**
 * Which symbol groups of this file are already in the book under their PRE-W6
 * pairing. Every row of a returned group is refused (listed as a duplicate,
 * never inserted); an empty result leaves the import exactly as before.
 */
export function legacyShortGroupRefusals(
  incoming: readonly LegacyGroupIncoming[],
  stored: readonly LegacyGroupStored[],
): LegacyGroupRefusal[] {
  const keyOf = (broker: string, sym: string, isin: string | null, label: string | null | undefined) =>
    `${broker}|${dedupSymbolKey(broker, sym, isin, label)}`;
  const groups = new Map<string, number[]>();
  incoming.forEach((t, i) => {
    const k = keyOf(t.broker, t.tradingsymbol, t.isin, t.dedupLabel);
    groups.set(k, [...(groups.get(k) ?? []), i]);
  });
  let storedByKey: Map<string, LegacyGroupStored[]> | null = null;
  const out: LegacyGroupRefusal[] = [];
  for (const [k, idx] of groups) {
    const rows = idx.map((i) => incoming[i]!);
    if (!rows.some(isOvernightClosedShort)) continue;
    if (!storedByKey) {
      storedByKey = new Map();
      for (const r of stored) {
        const sk = keyOf(r.broker, r.tradingsymbol, r.isin, dedupLabelFromNotes(r.importNotes));
        storedByKey.set(sk, [...(storedByKey.get(sk) ?? []), r]);
      }
    }
    const book = storedByKey.get(k) ?? [];
    if (book.length === 0) continue;
    const first = rows[0]!;
    const legs = groupLegs(first.tradingsymbol, rows);
    if (!legs) continue;
    const after = pairSymbolLegs(legs, { shortable: true });
    // Only the rows the two pairings DISAGREE on: a closed long both state is
    // not the pre-W6 shape of the short, and an earlier import of it proves nothing.
    const legacyOnly = pairSymbolLegs(legs).filter((p) => !after.some((q) => sameLegs(p, q)));
    const hits = new Set<number>();
    const held = book.map((r) => ({ r, hashes: heldIdentityHashes(r) }));
    for (const p of legacyOnly) {
      const row = preW6Row(p, first);
      const hash = dedupHash(row);
      for (const { r, hashes } of held) {
        if (!hits.has(r.id) && (hashes.includes(hash) || sameLegs(r, row))) hits.add(r.id);
      }
    }
    if (hits.size === 0) continue;
    const storedIds = [...hits].sort((a, b) => a - b);
    out.push({
      symbol: first.tradingsymbol,
      rows: idx,
      storedIds,
      reason:
        `${first.tradingsymbol}: already imported under the pre-4.6 pairing — ${storedIds.length} row${storedIds.length === 1 ? "" : "s"} ` +
        `(${storedIds.map((id) => `#${id}`).join(", ")}). Nothing of this contract in this file is imported again, so neither the sale ` +
        `nor the purchase is counted twice. Join the pair from Data Quality.`,
    });
  }
  return out;
}

/** The sentence a refused legacy-leg row carries, naming both stored rows. */
export function legacyShortDuplicateReason(symbol: string, m: { saleId: number | null; purchaseId: number | null }): string {
  const ids = [m.saleId != null ? `sale #${m.saleId}` : null, m.purchaseId != null ? `purchase #${m.purchaseId}` : null].filter(Boolean).join(" and ");
  return `${symbol}: this overnight short is already in the journal as two rows from a pre-4.6 import (${ids}) — not imported again, so the sale is not counted twice. Join them in Data Quality.`;
}

/**
 * The hash the pre-W6 pair's JOIN records as an alias (contract D5, R-6): what a
 * post-W6 re-import of the same file will hash the closed short as. Built from
 * the two stored rows' own legs, so it equals `dedupHash` of the parser's row.
 */
export function joinedShortHash(sale: LegacyLegRow, purchase: LegacyLegRow): string {
  return dedupHash({
    broker: sale.broker,
    tradingsymbol: sale.tradingsymbol,
    isin: sale.isin,
    dedupLabel: dedupLabelFromNotes(sale.importNotes),
    buyQty: purchase.buyQty,
    avgBuyPrice: purchase.avgBuyPrice,
    buyValue: purchase.buyValue,
    sellQty: sale.sellQty,
    avgSellPrice: sale.avgSellPrice,
    sellValue: sale.sellValue,
    buyDate: normalizeDate(purchase.buyDate),
    sellDate: normalizeDate(sale.sellDate),
  });
}

/** Append one `dedup-alias:` segment (idempotent). */
export function withDedupAlias(importNotes: string | null, hash: string): string {
  const parts = (importNotes ?? "").split("|").map((x) => x.trim()).filter(Boolean);
  const alias = `${DEDUP_ALIAS_PREFIX}${hash}`;
  if (!parts.includes(alias)) parts.push(alias);
  return parts.join(" | ");
}
