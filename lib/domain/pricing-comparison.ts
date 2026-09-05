// PRICING COMPARISON — competitor facts for the /pricing page (PURE, zero imports).
//
// Every cell below was read from the named product's public pages on
// COMPARISON_AS_OF (2026-08-15) or from third-party 2026 reviews where the
// official page was unreachable — those rows are flagged `thirdParty` and the
// UI must render the flag. Cells that could not be verified say "Not stated";
// nothing here is a guess dressed as a fact, and nothing is an outcome claim
// (no "trade better", no performance language — SEBI posture, see
// docs/owner/MONETIZATION_PLAN.md §5).
//
// ₹ conversions use ~₹88/USD and are deliberately labelled approximate.
// Owner approved this table for shipping on 2026-08-15 (full seven-product
// version, cheap Indian competitors INCLUDED — hiding them would be the
// dishonesty the product positions against).

/** The date every competitor cell was last read from its source. */
export const COMPARISON_AS_OF = "2026-08-15";

export interface CompetitorRow {
  name: string;
  market: "Global" | "India";
  model: string;
  /** Cheapest paid tier, ₹/yr equivalent, as display text (approx conversions stay approximate). */
  cheapestPaid: string;
  dataLocation: string;
  indianBrokers: string;
  chargesEngine: string;
  limits: string;
  /** Pricing sourced from third-party 2026 reviews (official page unreachable) — rendered as †. */
  thirdParty?: true;
}

export const COMPETITORS: readonly CompetitorRow[] = [
  {
    name: "TradeZella",
    market: "Global",
    model: "Subscription",
    cheapestPaid: "≈ ₹27,700/yr",
    dataLocation: "Web-hosted",
    indianBrokers: "Zerodha listed as coming soon; CSV upload",
    chargesEngine: "Not stated",
    limits: "1 account on base tier",
  },
  {
    name: "Edgewonk",
    market: "Global",
    model: "Subscription",
    cheapestPaid: "≈ ₹17,300/yr",
    dataLocation: "Web-hosted",
    indianBrokers: "Not stated",
    chargesEngine: "Not stated",
    limits: "Unlimited trades",
  },
  {
    name: "TraderSync",
    market: "Global",
    model: "Subscription",
    cheapestPaid: "≈ ₹15,800/yr",
    dataLocation: "Web-hosted",
    indianBrokers: "Not stated",
    chargesEngine: "Not stated",
    limits: "Feature caps per tier",
    thirdParty: true,
  },
  {
    name: "Tradervue",
    market: "Global",
    model: "Subscription",
    cheapestPaid: "≈ ₹31,600/yr",
    dataLocation: "Web-hosted",
    indianBrokers: "Not stated",
    chargesEngine: "Not stated",
    limits: "Limited free tier (stocks/ETFs)",
    thirdParty: true,
  },
  {
    name: "TradesViz",
    market: "Global",
    model: "Subscription",
    cheapestPaid: "₹12,600/yr (their own ₹ price)",
    dataLocation: "Web-hosted",
    indianBrokers: "Yes — Zerodha and others",
    chargesEngine: "Not stated",
    limits: "Free: 3,000 executions/mo, stocks only",
  },
  {
    name: "OneTradeJournal",
    market: "India",
    model: "Freemium subscription",
    cheapestPaid: "₹1,999–2,499/yr",
    dataLocation: "Web-hosted",
    indianBrokers: "Yes — 5 brokers",
    chargesEngine: "Parses charges from the tradebook",
    limits: "Not stated",
  },
  {
    name: "TradeDiary",
    market: "India",
    model: "Freemium subscription",
    cheapestPaid: "₹999/yr",
    dataLocation: "Web-hosted",
    indianBrokers: "Yes — 4 brokers",
    chargesEngine: "Not stated",
    limits: "Free: 10 trades/mo",
  },
];

/** Vyuha's own row, phrased in the same vocabulary as the competitor cells. */
export const VYUHA_ROW = {
  name: "Vyuha",
  model: "Annual ₹9,999/yr · Lifetime ₹29,999 once",
  cheapestPaid: "₹9,999/yr — or ₹29,999 ever",
  dataLocation: "Your own PC with Vyuha Desktop; a web platform is in development",
  indianBrokers: "6 auto-detected parsers + column mapper + 4 broker-API pulls",
  chargesEngine: "Computes STT/CTT, stamp duty, GST, exchange & SEBI charges from configurable rates",
  limits: "Core journal never gated — no trade or account caps",
} as const;

/**
 * Why Vyuha, without outcome claims: every line is architecture or arithmetic,
 * verifiable by reading the product, never a promise about trading results.
 */
export const WHY_VYUHA: readonly { claim: string; detail: string }[] = [
  {
    claim: "Three-year cost is a subtraction, not a subscription",
    detail:
      "Lifetime is ₹29,999 once. Three years of the global journals above runs ≈ ₹47,000–95,000 at their current prices.",
  },
  {
    claim: "Your data lives on your machine",
    detail:
      "There is no Vyuha server to send it to. Every product in this table is a web app with a login; Vyuha is a desktop app with a file.",
  },
  {
    claim: "The only lifetime licence in the table",
    detail: "Every competitor listed is subscription-only. Vyuha is the one product here you can stop paying for and keep.",
  },
  {
    claim: "Indian statutory charges are computed, not copied",
    detail:
      "STT/CTT, stamp duty, GST, exchange and SEBI charges from a broker × segment × exchange rate table — within 0.69% of a real broker report across 92 verified rows. None above states an independent charges engine; parsing the charges a broker already reported is not computing them.",
  },
  {
    claim: "The core journal is never metered",
    detail:
      "Recording trades, every importer, backups — free forever, no monthly trade cap, no account cap. Free tiers above meter trades, executions or accounts.",
  },
  {
    claim: "Works with no internet at all",
    detail: "Journal on a train, in a dealing room, anywhere — the app never needs a connection to record or analyse.",
  },
];
