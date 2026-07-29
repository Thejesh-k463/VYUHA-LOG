/**
 * Trades whose COST BASIS is not in the data.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── The situation ─────────────────────────────────────────────────────────
 *
 * A transaction report covers a window. Sell a holding you bought before that
 * window and the file contains the sale and nothing else — no purchase price,
 * no purchase date, no way to derive either. In Indian retail this is most
 * often an **IPO allotment**: shares are credited on allotment without ever
 * appearing as a buy in the tradebook, then sold on listing day.
 *
 * ── Why this needs its own rule ───────────────────────────────────────────
 *
 * With `buyValue = 0`, the arithmetic still "works": sell ₹21,904, buy ₹0, so
 * profit ₹21,904 and a 100% return. Every one of those numbers is false, and
 * they are exactly the sort of false that flatters — a book of IPO flips would
 * show a 100% win rate and an infinite Return on Margin.
 *
 * So these trades are counted in CASH (the money and the charges are real and
 * did happen) but excluded from every EDGE statistic — win rate, expectancy,
 * profit factor, ROM — until the user supplies a basis. Once supplied they
 * become ordinary trades and rejoin the statistics.
 */

export type AcquisitionKind = "unknown" | "ipo" | "bonus" | "gift";

export const ACQUISITION_LABELS: Record<AcquisitionKind, string> = {
  unknown: "Acquired before this window",
  ipo: "IPO allotment",
  bonus: "Bonus / split",
  gift: "Transfer in / gift",
};

export const ACQUISITION_HINTS: Record<AcquisitionKind, string> = {
  unknown: "Sold without a matching purchase — tell Vyuha how you got these shares.",
  ipo: "Allotted in a public issue. Cost basis is the issue price you paid.",
  bonus: "Credited by a corporate action. Basis is usually zero or the adjusted cost.",
  gift: "Received by transfer, gift or inheritance. Basis carries over from the giver.",
};

export interface BasisTrade {
  id: number;
  symbol: string;
  sellValue: number;
  buyValue: number;
  sellQty: number;
  netPnl: number;
  chargesTotal: number;
  sellDate: string | null;
  acquisition: string | null;
  acquisitionPrice: number | null;
  acquisitionDate: string | null;
}

/**
 * Does this trade have a usable cost basis?
 *
 * A trade is basis-complete when it was bought normally (no acquisition flag),
 * OR when the user has supplied a per-share price for a flagged one. A
 * supplied price of exactly 0 counts as known — bonus shares genuinely have a
 * zero basis, and refusing to accept that would make them permanently
 * unreportable.
 */
export function hasKnownBasis(t: Pick<BasisTrade, "acquisition" | "acquisitionPrice" | "buyValue">): boolean {
  if (!t.acquisition) return true;
  if (t.buyValue > 0) return true;
  return t.acquisitionPrice != null;
}

/** Trades that must be held out of edge statistics. */
export function unknownBasisTrades<T extends Pick<BasisTrade, "acquisition" | "acquisitionPrice" | "buyValue">>(
  trades: T[],
): T[] {
  return trades.filter((t) => !hasKnownBasis(t));
}

/** Trades safe to compute win rate, expectancy and ROM from. */
export function basisCompleteTrades<T extends Pick<BasisTrade, "acquisition" | "acquisitionPrice" | "buyValue">>(
  trades: T[],
): T[] {
  return trades.filter((t) => hasKnownBasis(t));
}

/**
 * Apply a user-supplied per-share cost to a flagged trade.
 *
 * Returns the derived buy value and the corrected P&L, leaving charges alone —
 * the charges were always real and were never in doubt.
 */
export function applyBasis(
  t: Pick<BasisTrade, "sellQty" | "sellValue" | "chargesTotal">,
  pricePerShare: number,
): { buyValue: number; grossPnl: number; netPnl: number } {
  const buyValue = Math.round(t.sellQty * pricePerShare * 100) / 100;
  const grossPnl = Math.round((t.sellValue - buyValue) * 100) / 100;
  const netPnl = Math.round((grossPnl - t.chargesTotal) * 100) / 100;
  return { buyValue, grossPnl, netPnl };
}

export interface DerivedBasis {
  /** Total P&L the orphan legs contributed, per the broker's own footer. */
  orphanGross: number;
  /** Implied total cost of the orphan stock. */
  impliedCost: number;
  /** Implied per-share cost — only meaningful for a SINGLE orphan. */
  pricePerShare: number | null;
  /** True when exactly one orphan exists, so the figure is exact rather than
   *  an aggregate spread across several unknown holdings. */
  exact: boolean;
}

/**
 * Recover an unknowable cost basis from the broker's own footer.
 *
 * A transaction report's rows may omit the purchase, but the FOOTER states the
 * broker's realised gross P&L for the window — and the broker knows the basis
 * even when the rows do not. So:
 *
 *   orphanGross  = footerGross − grossOfEverythingWeCouldMatch
 *   impliedCost  = orphanProceeds − orphanGross
 *
 * Verified against a real report: matched gross came to −₹8,268.27 against a
 * footer of −₹8,489.60, leaving −₹221.33 for the one unmatched holding — 37
 * shares sold for ₹21,904, implying ₹598.01 a share. A plausible price, from
 * arithmetic alone.
 *
 * With exactly ONE orphan this is exact. With several it is only the total, so
 * `pricePerShare` is withheld and `exact` is false — dividing a pooled figure
 * across different stocks would invent per-stock costs that were never stated.
 */
export function deriveBasisFromFooter(
  footerGross: number | undefined,
  matchedGross: number,
  orphans: { sellQty: number; sellValue: number }[],
): DerivedBasis | null {
  if (footerGross == null || orphans.length === 0) return null;

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const orphanGross = r2(footerGross - matchedGross);
  const proceeds = orphans.reduce((s, o) => s + o.sellValue, 0);
  const impliedCost = r2(proceeds - orphanGross);
  if (impliedCost <= 0) return null;

  const qty = orphans.reduce((s, o) => s + o.sellQty, 0);
  const exact = orphans.length === 1 && qty > 0;

  return {
    orphanGross,
    impliedCost,
    pricePerShare: exact ? Math.round((impliedCost / qty) * 100) / 100 : null,
    exact,
  };
}

export interface AcquisitionSummary {
  /** Every flagged trade, whatever its basis state. */
  total: number;
  /** Flagged AND still missing a basis — the ones held out of statistics. */
  pending: number;
  /** Flagged but resolved — back in the statistics. */
  resolved: number;
  /** Proceeds sitting behind pending trades; real cash, unusable P&L. */
  pendingProceeds: number;
  /** Charges on pending trades — real, and counted in cash terms. */
  pendingCharges: number;
  byKind: { kind: string; label: string; count: number; proceeds: number }[];
}

export function summariseAcquisitions(trades: BasisTrade[]): AcquisitionSummary {
  const flagged = trades.filter((t) => !!t.acquisition);
  const pending = flagged.filter((t) => !hasKnownBasis(t));

  const byKindMap = new Map<string, { count: number; proceeds: number }>();
  for (const t of flagged) {
    const k = t.acquisition ?? "unknown";
    const cur = byKindMap.get(k) ?? { count: 0, proceeds: 0 };
    cur.count += 1;
    cur.proceeds += t.sellValue;
    byKindMap.set(k, cur);
  }

  return {
    total: flagged.length,
    pending: pending.length,
    resolved: flagged.length - pending.length,
    pendingProceeds: Math.round(pending.reduce((s, t) => s + t.sellValue, 0) * 100) / 100,
    pendingCharges: Math.round(pending.reduce((s, t) => s + t.chargesTotal, 0) * 100) / 100,
    byKind: [...byKindMap.entries()]
      .map(([kind, v]) => ({
        kind,
        label: ACQUISITION_LABELS[kind as AcquisitionKind] ?? kind,
        count: v.count,
        proceeds: Math.round(v.proceeds * 100) / 100,
      }))
      .sort((a, b) => b.proceeds - a.proceeds),
  };
}

/**
 * Realised P&L for IPO-allotted stock specifically, which traders track apart
 * from their trading edge — a listing-day pop is not a repeatable skill and
 * blending it into expectancy overstates the edge.
 */
export interface IpoPnl {
  trades: number;
  proceeds: number;
  cost: number;
  charges: number;
  netPnl: number;
  /** Trades still missing an issue price, so not included in the totals. */
  pending: number;
}

export function ipoAllottedPnl(trades: BasisTrade[]): IpoPnl {
  const ipo = trades.filter((t) => t.acquisition === "ipo");
  const priced = ipo.filter((t) => hasKnownBasis(t));

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const cost = priced.reduce(
    (s, t) => s + (t.buyValue > 0 ? t.buyValue : (t.acquisitionPrice ?? 0) * t.sellQty),
    0,
  );
  const proceeds = priced.reduce((s, t) => s + t.sellValue, 0);
  const charges = priced.reduce((s, t) => s + t.chargesTotal, 0);

  return {
    trades: priced.length,
    proceeds: r2(proceeds),
    cost: r2(cost),
    charges: r2(charges),
    netPnl: r2(proceeds - cost - charges),
    pending: ipo.length - priced.length,
  };
}
