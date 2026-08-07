/**
 * Cross-broker MTF comparison (PURE) — feeds the Broker Costs page's MTF
 * section from the bundled per-stock margin lists.
 *
 * Two views, both honest about their limits:
 *
 * 1. PER-BROKER SUMMARY — scrips approved vs actually funded (Kotak approves
 *    ~1,680 but funds ~1,178; the gap matters), median funded margin, best
 *    leverage. Sahi appears explicitly as "no MTF" rather than vanishing.
 * 2. YOUR BOOK — for the delivery/MTF symbols the trader actually trades,
 *    which brokers fund them and at what margin. Margin is the ONLY axis
 *    here: interest rates, plan fees and DP charges differ too, and the cost
 *    table above this section prices those — the footer must say so.
 */

import bundled from "@/lib/data/mtf-margins.json";

interface BundleShape {
  asOf: string;
  brokers: Record<
    string,
    { coverage: string; note?: string; count: number; fundedCount: number; stocks: Record<string, { m: number; isin: string | null; f: 0 | 1 }> }
  >;
}

const BUNDLE = bundled as unknown as BundleShape;

export interface MtfBrokerSummary {
  broker: string;
  coverage: string;
  approved: number;
  funded: number;
  medianMarginPct: number | null; // funded scrips only — never diluted by 100s
  bestLeverage: number | null; // 100 / lowest funded margin
  note: string | null;
}

export interface MtfSymbolRow {
  symbol: string;
  /** broker → own-margin % (funded scrips only; absent = not funded there). */
  margins: Record<string, number>;
  bestBroker: string | null;
  bestMarginPct: number | null;
  fundedBy: number;
}

export interface MtfComparison {
  asOf: string;
  brokers: MtfBrokerSummary[];
  yourBook: MtfSymbolRow[];
  yourBookTotal: number; // symbols considered (incl. ones no broker funds)
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
};

export function mtfComparison(tradedSymbols: string[]): MtfComparison {
  const brokers: MtfBrokerSummary[] = Object.entries(BUNDLE.brokers).map(([broker, b]) => {
    const fundedMargins = Object.values(b.stocks).filter((s) => s.f === 1).map((s) => s.m);
    const best = fundedMargins.length ? Math.min(...fundedMargins) : null;
    return {
      broker,
      coverage: b.coverage,
      approved: b.count,
      funded: b.fundedCount,
      medianMarginPct: median(fundedMargins),
      bestLeverage: best && best > 0 ? Math.round((100 / best) * 100) / 100 : null,
      note: b.note ?? null,
    };
  });

  const seen = new Set<string>();
  const yourBook: MtfSymbolRow[] = [];
  for (const raw of tradedSymbols) {
    const symbol = raw.toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    const margins: Record<string, number> = {};
    for (const [broker, b] of Object.entries(BUNDLE.brokers)) {
      const hit = b.stocks[symbol];
      if (hit && hit.f === 1) margins[broker] = hit.m;
    }
    const entries = Object.entries(margins);
    const best = entries.length ? entries.reduce((a, b2) => (b2[1] < a[1] ? b2 : a)) : null;
    yourBook.push({
      symbol,
      margins,
      bestBroker: best ? best[0] : null,
      bestMarginPct: best ? best[1] : null,
      fundedBy: entries.length,
    });
  }
  // Fundable symbols first, cheapest margins first; unfunded sink but stay.
  yourBook.sort((a, b) => (b.fundedBy - a.fundedBy) || ((a.bestMarginPct ?? 101) - (b.bestMarginPct ?? 101)));

  return { asOf: BUNDLE.asOf, brokers, yourBook, yourBookTotal: seen.size };
}
