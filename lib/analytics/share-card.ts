// Shareable stat card (T1.4) — PURE metric selection + privacy masking.
//
// India's trading culture posts P&L screenshots constantly. This builds an
// honest, *self-reported* card the user fully controls: they pick the metrics,
// choose whether real ₹ amounts appear at all, and every card is watermarked as
// self-reported (never "broker-verified" — Vyuha is offline and cannot verify
// anything with a broker).
//
// The card is rendered and exported entirely client-side; nothing is uploaded.

export interface ShareStats {
  netPnl: number;
  winRatePct: number;
  profitFactor: number;
  avgR: number | null;
  trades: number;
  expectancy: number;
  maxDrawdown: number;
  charges: number;
  bestTrade: number;
  worstTrade: number;
}

export type ShareMetricId =
  | "netPnl" | "winRate" | "profitFactor" | "avgR" | "trades"
  | "expectancy" | "maxDrawdown" | "charges" | "bestTrade" | "worstTrade";

/** "amount" metrics are the ones privacy mode has to transform. */
export const SHARE_METRICS: { id: ShareMetricId; label: string; kind: "amount" | "ratio" | "count" }[] = [
  { id: "netPnl", label: "Net P&L", kind: "amount" },
  { id: "winRate", label: "Win rate", kind: "ratio" },
  { id: "profitFactor", label: "Profit factor", kind: "ratio" },
  { id: "avgR", label: "Avg R", kind: "ratio" },
  { id: "trades", label: "Trades", kind: "count" },
  { id: "expectancy", label: "Expectancy", kind: "amount" },
  { id: "maxDrawdown", label: "Max drawdown", kind: "amount" },
  { id: "charges", label: "Charges paid", kind: "amount" },
  { id: "bestTrade", label: "Best trade", kind: "amount" },
  { id: "worstTrade", label: "Worst trade", kind: "amount" },
];

export type PrivacyMode = "amounts" | "percent" | "r";

export interface ShareCardOptions {
  metrics: ShareMetricId[];
  privacy: PrivacyMode;
  /** Capital base for percent mode. Percent is meaningless without it. */
  capital?: number;
  period?: string;
}

export interface ShareCardValue {
  id: ShareMetricId;
  label: string;
  display: string;
  tone: "profit" | "loss" | "neutral";
}

const inr = (n: number) => {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  return `${sign}₹${Math.round(abs)}`;
};

const toneOf = (n: number): ShareCardValue["tone"] => (n > 0 ? "profit" : n < 0 ? "loss" : "neutral");

/**
 * Render the selected metrics under the chosen privacy mode.
 *  - "amounts": real ₹ figures.
 *  - "percent": ₹ metrics become % of capital (needs `capital`; falls back to
 *    "—" rather than inventing a denominator).
 *  - "r": ₹ metrics become R-multiples using avg risk implied by expectancy…
 *    NO — that would be a fabricated denominator. R mode instead hides ₹
 *    metrics entirely except those already expressed in R.
 */
export function buildShareCard(stats: ShareStats, opts: ShareCardOptions): ShareCardValue[] {
  const out: ShareCardValue[] = [];
  for (const id of opts.metrics) {
    const meta = SHARE_METRICS.find((m) => m.id === id);
    if (!meta) continue;

    if (meta.kind === "ratio" || meta.kind === "count") {
      const display =
        id === "winRate" ? `${stats.winRatePct.toFixed(1)}%`
        : id === "profitFactor" ? (Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "∞")
        : id === "avgR" ? (stats.avgR == null ? "—" : `${stats.avgR.toFixed(2)}R`)
        : `${stats.trades}`;
      const tone: ShareCardValue["tone"] =
        id === "avgR" && stats.avgR != null ? toneOf(stats.avgR)
        : id === "profitFactor" ? toneOf(stats.profitFactor - 1)
        : "neutral";
      out.push({ id, label: meta.label, display, tone });
      continue;
    }

    // amount metric
    const raw =
      id === "netPnl" ? stats.netPnl
      : id === "expectancy" ? stats.expectancy
      : id === "maxDrawdown" ? -Math.abs(stats.maxDrawdown)
      : id === "charges" ? -Math.abs(stats.charges)
      : id === "bestTrade" ? stats.bestTrade
      : stats.worstTrade;

    if (opts.privacy === "amounts") {
      out.push({ id, label: meta.label, display: inr(raw), tone: toneOf(raw) });
    } else if (opts.privacy === "percent") {
      const cap = opts.capital ?? 0;
      out.push({
        id,
        label: `${meta.label} (% of capital)`,
        display: cap > 0 ? `${((raw / cap) * 100).toFixed(2)}%` : "—",
        tone: toneOf(raw),
      });
    } else {
      // "r" mode — ₹ metrics are omitted rather than converted with a
      // denominator we don't actually have. Honest > impressive.
      out.push({ id, label: meta.label, display: "hidden", tone: "neutral" });
    }
  }
  return out;
}

/** The line every card carries. Deliberately not editable by the user. */
export const SHARE_WATERMARK = "Self-reported from my own journal · not broker-verified · Vyuha";
