// SEBI Compliance Radar (T1.2) — PURE, no DB/React.
//
// India's F&O regime changed materially across 2024–2026 and the rules that
// bite hardest are DATE-SENSITIVE (expiry day) or POSITION-SENSITIVE (limits).
// This module turns your open book + today's date into plain warnings.
//
// Sources for the rules encoded here (SEBI "Framework for Strengthening Equity
// Index Derivatives", Oct 2024, phased through 2025, plus exchange circulars):
//   - One weekly-expiry index PER EXCHANGE: NSE = NIFTY, BSE = SENSEX. Weekly
//     BANKNIFTY / FINNIFTY / MIDCPNIFTY / NIFTYNXT50 were discontinued
//     (20 Nov 2024) — those trade monthly only.
//   - Expiry-day extra ELM of 2% on SHORT options expiring that day.
//   - No calendar-spread margin benefit on expiry day for the expiring contract
//     (from 10 Feb 2025).
//   - Full option premium upfront for buyers (Feb 2025).
//   - Index F&O position limits monitored INTRADAY via random snapshots
//     (≥4/day, from Apr 2025): net ₹1,500 cr EOD / gross ₹10,000 cr.
//   - Contract sizes raised to the ₹15–20 lakh band.
//
// EVERYTHING HERE IS INFORMATIONAL. Exchange circulars and your broker's own
// RMS are the source of truth; dates move for holidays. The UI repeats this.

export interface RadarPosition {
  id: number;
  symbol: string;
  segment: string;
  side: "long" | "short";
  optionType: string | null; // CE | PE | null
  expiry: string | null; // ISO
  qty: number;
  entry: number;
  mtm: number;
  exchange: string;
}

export type RadarLevel = "info" | "caution" | "action";

export interface RadarItem {
  id: string;
  level: RadarLevel;
  title: string;
  detail: string;
  positions?: string[]; // affected symbols, when position-specific
}

export interface RadarReport {
  today: string;
  items: RadarItem[];
  /** Σ |qty × mtm| over index-derivative positions — the crude "notional" the
   *  limit warnings are compared against. Not the exchange's own computation. */
  indexNotional: number;
}

// Weekly-expiry survivors, by exchange.
export const WEEKLY_EXPIRY_INDEX: Record<string, string> = { NSE: "NIFTY", BSE: "SENSEX" };

/** Index underlyings whose WEEKLY contracts were discontinued (monthly only). */
export const MONTHLY_ONLY_INDEXES = ["BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"] as const;

export const NET_INDEX_LIMIT = 1_500_00_00_000; // ₹1,500 cr, end-of-day net
export const GROSS_INDEX_LIMIT = 10_000_00_00_000; // ₹10,000 cr gross
export const EXPIRY_DAY_ELM_PCT = 2; // extra ELM on short options expiring today

const DERIVATIVE_SEGMENTS = new Set(["index_option", "stock_option", "future", "commodity_future", "commodity_option"]);
const INDEX_SEGMENTS = new Set(["index_option"]);

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** Uppercased underlying, tolerant of "OPT NIFTY …" style tradingsymbols. */
function underlyingOf(symbol: string): string {
  return symbol.toUpperCase().replace(/^(OPT|FUT)\s+/, "").split(/[\s\d]/)[0] ?? "";
}

export function sebiRadar(positions: RadarPosition[], today = new Date().toISOString().slice(0, 10)): RadarReport {
  const items: RadarItem[] = [];
  const derivatives = positions.filter((p) => DERIVATIVE_SEGMENTS.has(p.segment) && p.qty > 0);

  // ---- 1. Expiry-day rules on positions expiring TODAY --------------------
  const expiringToday = derivatives.filter((p) => p.expiry === today);
  const shortOptionsToday = expiringToday.filter((p) => p.side === "short" && (p.optionType === "CE" || p.optionType === "PE"));

  if (shortOptionsToday.length > 0) {
    items.push({
      id: "expiry-elm",
      level: "action",
      title: `Expiry-day margin: +${EXPIRY_DAY_ELM_PCT}% ELM on ${shortOptionsToday.length} short option${shortOptionsToday.length === 1 ? "" : "s"}`,
      detail:
        `SEBI adds an extra ${EXPIRY_DAY_ELM_PCT}% Extreme Loss Margin on short option contracts expiring today. ` +
        `Your broker will block more margin than the SPAN estimate elsewhere in this app shows — check available margin before adding size.`,
      positions: shortOptionsToday.map((p) => p.symbol),
    });
  }
  if (expiringToday.length > 0) {
    items.push({
      id: "expiry-calendar-spread",
      level: "caution",
      title: "No calendar-spread margin benefit on expiry day",
      detail:
        "For contracts expiring today, the calendar-spread margin offset does not apply. A spread you think is hedged may be margined as two naked legs — verify with your broker's RMS before the close.",
      positions: expiringToday.map((p) => p.symbol),
    });
  }

  // ---- 2. Weekly-expiry regime -------------------------------------------
  const monthlyOnlyHeld = [
    ...new Set(
      derivatives
        .filter((p) => MONTHLY_ONLY_INDEXES.includes(underlyingOf(p.symbol) as (typeof MONTHLY_ONLY_INDEXES)[number]))
        .map((p) => underlyingOf(p.symbol)),
    ),
  ];
  if (monthlyOnlyHeld.length > 0) {
    items.push({
      id: "weekly-discontinued",
      level: "info",
      title: `${monthlyOnlyHeld.join(", ")} — monthly expiry only`,
      detail:
        "Weekly contracts on this index were discontinued (Nov 2024). Only one index per exchange keeps weeklies: NIFTY on NSE, SENSEX on BSE. Plan rollovers on the monthly cycle.",
      positions: monthlyOnlyHeld,
    });
  }

  // ---- 3. Index position-limit proximity ---------------------------------
  const indexPositions = derivatives.filter((p) => INDEX_SEGMENTS.has(p.segment));
  const indexNotional = indexPositions.reduce((s, p) => s + Math.abs(p.qty * (p.mtm || p.entry)), 0);
  if (indexNotional > NET_INDEX_LIMIT * 0.5) {
    items.push({
      id: "position-limit",
      level: indexNotional > NET_INDEX_LIMIT ? "action" : "caution",
      title: `Index exposure ${inr(indexNotional)} vs the ${inr(NET_INDEX_LIMIT)} net limit`,
      detail:
        "Since Apr 2025 exchanges snapshot open positions at random points INTRADAY, not just at close — an intraday spike can breach even if you flatten by EOD. This is a crude Σ|qty × mark|, not the exchange's own delta-based computation.",
    });
  }

  // ---- 4. Always-on standing reminders (only when F&O is actually held) ----
  if (derivatives.length > 0) {
    items.push({
      id: "upfront-premium",
      level: "info",
      title: "Option premium is charged upfront, in full",
      detail:
        "Since Feb 2025 brokers must collect the entire option premium at order placement — no intraday premium credit. Size buys against cleared funds, not expected margin.",
    });
    items.push({
      id: "contract-size",
      level: "info",
      title: "Index contract value sits in the ₹15–20 lakh band",
      detail:
        "Lot sizes were raised so one lot is materially bigger than pre-2024. One lot can now exceed a per-trade risk cap that was set for the old sizes — re-check your risk rules in Settings.",
    });
  }

  const order: Record<RadarLevel, number> = { action: 0, caution: 1, info: 2 };
  items.sort((a, b) => order[a.level] - order[b.level]);
  return { today, items, indexNotional: Math.round(indexNotional) };
}
