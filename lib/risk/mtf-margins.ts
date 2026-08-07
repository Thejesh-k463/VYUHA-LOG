/**
 * Per-stock MTF own-margin resolution (PURE — no DB, no React).
 *
 * The chain, most specific wins:
 *
 *   1. a user-uploaded override row        (mtf_margins table, passed in)
 *   2. the bundled broker stock list       (lib/data/mtf-margins.json)
 *   3. the broker's published rule default (Angel 40, Dhan 25 — from the bundle)
 *   4. the broker-level margin_config rate (the /risk editable table)
 *   5. DEFAULT_MTF_OWN_MARGIN_PCT (25)
 *
 * Every resolution names its source and the snapshot's as-of date, because a
 * margin from a nine-month-old list is a different fact from today's — the
 * UI shows both and never pretends a stale number is current.
 */

import bundled from "@/lib/data/mtf-margins.json";
import { DEFAULT_MTF_OWN_MARGIN_PCT } from "@/lib/risk/margin";

export type MtfMarginSource =
  | "upload" // user-uploaded broker file (DB override)
  | "stock-list" // bundled per-stock list
  | "broker-rule" // bundled published rule (Angel/Dhan)
  | "margin-config" // the app's broker-level editable rate
  | "default"; // the 25% fallback

export interface MtfMarginResolution {
  pct: number;
  source: MtfMarginSource;
  /** As-of date of the number when it came from a snapshot/upload. */
  asOf: string | null;
  /** Bundle coverage for the broker — lets the UI say "partial list". */
  coverage: string | null;
  note: string | null;
}

interface BundleShape {
  asOf: string;
  brokers: Record<
    string,
    {
      coverage: string;
      rule?: string;
      note?: string;
      defaultPct?: number;
      count: number;
      stocks: Record<string, { m: number; isin: string | null }>;
    }
  >;
}

const BUNDLE = bundled as unknown as BundleShape;

export const MTF_BUNDLE_AS_OF = BUNDLE.asOf;

/** Days after which the bundled snapshot is flagged stale on screen. */
export const MTF_STALE_AFTER_DAYS = 60;

export function mtfBundleIsStale(today: string, asOf = BUNDLE.asOf, staleDays = MTF_STALE_AFTER_DAYS): boolean {
  const t = Date.parse(today);
  const a = Date.parse(asOf);
  if (!Number.isFinite(t) || !Number.isFinite(a)) return false;
  return t - a > staleDays * 86_400_000;
}

/**
 * @param overrides user-uploaded rows for this broker: symbol → { pct, asOf }
 * @param brokerConfigPct the broker-level rate from margin_config, if any
 */
export function resolveMtfMargin(
  broker: string,
  symbol: string,
  overrides?: Map<string, { pct: number; asOf: string }> | null,
  brokerConfigPct?: number | null,
): MtfMarginResolution {
  const sym = symbol.toUpperCase();

  const o = overrides?.get(sym);
  if (o && o.pct > 0) return { pct: o.pct, source: "upload", asOf: o.asOf, coverage: null, note: null };

  const b = BUNDLE.brokers[broker];
  if (b) {
    const hit = b.stocks[sym];
    if (hit && hit.m > 0) {
      return {
        pct: hit.m,
        source: "stock-list",
        asOf: BUNDLE.asOf,
        coverage: b.coverage,
        note: b.coverage === "partial" ? (b.note ?? "partial list") : null,
      };
    }
    if (b.defaultPct && b.defaultPct > 0) {
      return { pct: b.defaultPct, source: "broker-rule", asOf: BUNDLE.asOf, coverage: b.coverage, note: b.rule ?? null };
    }
  }

  if (brokerConfigPct != null && brokerConfigPct > 0) {
    return { pct: brokerConfigPct, source: "margin-config", asOf: null, coverage: b?.coverage ?? null, note: null };
  }

  return {
    pct: DEFAULT_MTF_OWN_MARGIN_PCT,
    source: "default",
    asOf: null,
    coverage: b?.coverage ?? null,
    note: b?.coverage === "no-mtf" ? (b.note ?? null) : null,
  };
}

/** Human line for badges: "Zerodha list 25.9% · as of 2026-08-07". */
export function mtfSourceLabel(r: MtfMarginResolution): string {
  switch (r.source) {
    case "upload": return `your uploaded list · as of ${r.asOf}`;
    case "stock-list": return `broker stock list · as of ${r.asOf}${r.coverage === "partial" ? " (partial list)" : ""}`;
    case "broker-rule": return `broker's published rule`;
    case "margin-config": return `your margin-config rate`;
    default: return `app default ${DEFAULT_MTF_OWN_MARGIN_PCT}%`;
  }
}
