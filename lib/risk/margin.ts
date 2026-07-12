// P1.2 margin slice — PURE margin-requirement estimator (no DB/React).
// Rates come from the editable margin_config table (never hard-coded here):
// a % of notional per segment, approximating SPAN+exposure for derivatives and
// the leverage haircut for intraday/MTF. Rules:
//   - long options: margin = premium paid (qty × entry) — no rate applied.
//   - short options: rate% × notional, notional = qty × (spot ?? strike ?? entry).
//   - futures & intraday equity: rate% × qty × mtm (current contract value).
//   - MTF / delivery equity: rate% × qty × entry (own-funds portion; delivery = 100%).
// This is an ESTIMATE for the utilisation gauge — real broker SPAN files differ.

export type MarginRates = Map<string, number>; // "broker|segment" → pct (e.g. 12 = 12%)

/** Lookup key for MarginRates — matches the broker|segment convention already
 * used for charge_config (lib/engine/rates-db.ts). */
export function marginKey(broker: string, segment: string): string {
  return `${broker}|${segment}`;
}

// Fallback own-margin % for MTF when margin_config has no eq_mtf row (should not
// happen post-seed, but keeps callers safe). Matches the seeded default.
export const DEFAULT_MTF_OWN_MARGIN_PCT = 25;

/**
 * MTF's broker-financed principal = position value MINUS the trader's own margin
 * (the eq_mtf `margin_pct` from margin_config is the OWN-funds share, same number
 * the /risk margin gauge already uses). Interest accrues only on this financed
 * portion, never on the full position value — treating the whole value as
 * broker-funded overstates MTF interest by roughly 1/(1-ownMarginPct/100)×.
 */
export function defaultMtfFundedAmount(positionValue: number, ownMarginPct: number): number {
  const pct = Number.isFinite(ownMarginPct) ? Math.min(100, Math.max(0, ownMarginPct)) : 0;
  return Math.max(0, r2(positionValue * (1 - pct / 100)));
}

export interface MarginPositionInput {
  id: number;
  symbol: string;
  bucket: string; // equity | active
  broker: string;
  segment: string;
  side: "long" | "short";
  qty: number;
  entry: number;
  mtm: number;
  strike: number | null;
  optionType: string | null; // CE | PE | null
  spot?: number | null;
}

export interface PositionMargin {
  id: number;
  symbol: string;
  bucket: string;
  segment: string;
  margin: number; // ₹ estimated blocked
  basis: string; // human explanation, e.g. "12% × notional ₹5,40,000"
  rateUsed: number | null; // pct applied (null = premium-paid rule)
}

export interface BucketMargin {
  bucket: string;
  margin: number;
  capital: number;
  utilisationPct: number; // margin / capital × 100 (0 when capital unknown)
}

export interface MarginSummary {
  positions: PositionMargin[];
  byBucket: BucketMargin[];
  totalMargin: number;
  missingRateSegments: string[]; // segments that fell back to 100%
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const inrFmt = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export function estimateMargin(
  positions: MarginPositionInput[],
  rates: MarginRates,
  capitals: Record<string, number>,
): MarginSummary {
  const out: PositionMargin[] = [];
  const missing = new Set<string>();

  for (const p of positions) {
    const isOption = p.optionType === "CE" || p.optionType === "PE";
    let margin: number;
    let basis: string;
    let rateUsed: number | null;

    if (isOption && p.side === "long") {
      margin = p.qty * p.entry;
      basis = `premium paid ${inrFmt(margin)}`;
      rateUsed = null;
    } else {
      const configured = rates.get(marginKey(p.broker, p.segment));
      const pct = configured ?? 100;
      if (configured == null) missing.add(`${p.broker}|${p.segment}`);
      rateUsed = pct;
      if (isOption) {
        const ref = p.spot ?? p.strike ?? p.entry;
        const notional = p.qty * ref;
        margin = (pct / 100) * notional;
        basis = `${pct}% × notional ${inrFmt(notional)} (short ${p.optionType})`;
      } else if (p.segment === "eq_mtf" || p.segment === "eq_delivery") {
        const value = p.qty * p.entry;
        margin = (pct / 100) * value;
        basis = `${pct}% × invested ${inrFmt(value)}`;
      } else {
        // futures (index/stock/commodity) + intraday equity: current contract value
        const value = p.qty * p.mtm;
        margin = (pct / 100) * value;
        basis = `${pct}% × value ${inrFmt(value)}`;
      }
    }

    out.push({
      id: p.id,
      symbol: p.symbol,
      bucket: p.bucket,
      segment: p.segment,
      margin: r2(margin),
      basis,
      rateUsed,
    });
  }

  const byBucketMap = new Map<string, number>();
  for (const p of out) byBucketMap.set(p.bucket, (byBucketMap.get(p.bucket) ?? 0) + p.margin);
  const byBucket: BucketMargin[] = [...byBucketMap.entries()]
    .map(([bucket, margin]) => {
      const capital = capitals[bucket] ?? 0;
      return {
        bucket,
        margin: r2(margin),
        capital,
        utilisationPct: capital > 0 ? r2((margin / capital) * 100) : 0,
      };
    })
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  return {
    positions: out.sort((a, b) => b.margin - a.margin),
    byBucket,
    totalMargin: r2(out.reduce((s, p) => s + p.margin, 0)),
    missingRateSegments: [...missing].sort(),
  };
}
