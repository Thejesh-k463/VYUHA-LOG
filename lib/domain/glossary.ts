// GLOSSARY (PURE — data only; v4.6.0 W4, owner ruling H4).
//
// The terms a first-time Indian retail trader meets in Vyuha, each said the way THIS app uses it — a descriptive
// fact, never advice. The help dialog links the first occurrence of a term (or an alias) to its meaning.
//
// Rules a test pins (tests/glossary.test.ts): every term and alias is unique, case-insensitively, across the whole
// list; a meaning is <= 40 words; `metricId` is set only where the term IS a METRIC_HELP entry
// (lib/domain/metric-help.ts), and its meaning then agrees with that entry's. No session time is written here —
// timings live only in lib/domain/market-calendar.ts.

export interface GlossaryTerm {
  term: string;
  aliases?: string[];
  /** <= 40 words; what the term means in this app. */
  meaning: string;
  /** A METRIC_HELP key, when the term is a metric. */
  metricId?: string;
}

export const GLOSSARY: GlossaryTerm[] = [
  {
    term: "R-multiple",
    aliases: ["R", "Avg R"],
    meaning:
      "A trade's net P&L divided by the risk planned at entry, from its recorded stop. A trade earns an R only when a stop captured that risk; Avg R averages it over the trades that have one.",
    metricId: "avgR",
  },
  {
    term: "Expectancy",
    meaning:
      "What one average priced closed trade was worth in rupees, after charges. It is not R-expectancy: no risk normalisation is applied, and Avg R is the R figure.",
    metricId: "expectancy",
  },
  {
    term: "Profit factor",
    meaning:
      "Winning trades' net P&L divided by losing trades' net P&L, after charges. Above 1 the book made money, whatever the win rate says; with no losing trade yet it reads infinity.",
    metricId: "profitFactor",
  },
  {
    term: "Drawdown",
    aliases: ["max drawdown"],
    meaning:
      "The fall from the book's running peak to a later trough, from realised P&L. Performance walks your configured capital day by day; the dashboard walks cumulative P&L trade by trade from zero, so the two can differ.",
    metricId: "maxDrawdown",
  },
  {
    term: "Win rate",
    meaning:
      "The share of closed trades that ended green, counting only trades with a cost basis, so an unpriceable sale cannot pass as a winner. It says nothing about how large wins and losses are.",
    metricId: "winRate",
  },
  {
    term: "MTF",
    aliases: ["margin trading facility"],
    meaning:
      "Margin Trading Facility: the broker funds part of a delivery purchase and charges interest on it. Vyuha records your own margin share, the funded portion and the accrued interest, and never guesses MTF from a file.",
  },
  {
    term: "STT",
    aliases: ["securities transaction tax"],
    meaning:
      "Securities Transaction Tax, a statutory tax on exchange trades in equity and F&O, at the rate held in the charge tables and rounded to the rupee. It is a business expense, not a capital-gains deduction.",
  },
  {
    term: "CTT",
    aliases: ["commodities transaction tax"],
    meaning:
      "Commodities Transaction Tax, the commodity-derivatives counterpart of STT on MCX trades, at the rate held in the charge tables and rounded to the rupee.",
  },
  {
    term: "Stamp duty",
    meaning: "A state levy on the buy side of a trade, at the rate held in the charge tables and rounded to the rupee.",
  },
  {
    term: "DP charge",
    aliases: ["DP fee", "depository charge"],
    meaning:
      "The depository participant fee a broker bills when delivery shares leave your demat account on a sale, at the rate on that broker's rate card.",
  },
  {
    term: "Brokerage plan",
    aliases: ["broker plan"],
    meaning:
      "The pricing plan an account trades on with its broker. Charge rates are keyed by broker, plan, segment and exchange, so one trade can cost differently on two plans of the same broker.",
  },
  {
    term: "Closing auction session",
    aliases: ["CAS", "closing auction"],
    meaning:
      "The exchange's end-of-day auction for equities, in force from 3 August 2026. Vyuha waits for the official close it produces before writing a day's mark; its timing comes from the bundled market calendar.",
  },
  {
    term: "Pre-open",
    aliases: ["pre-open session"],
    meaning:
      "The call auction before the regular market opens, where the opening price is discovered. Its timing comes from the bundled market calendar, which carries the revised session from 7 September 2026.",
  },
  {
    term: "F&O",
    aliases: ["futures and options", "derivatives"],
    meaning:
      "Futures and options: exchange-traded contracts on an index, a stock or a commodity. Vyuha keeps them in the Trade F&O bucket, and their results are non-speculative business income for tax.",
  },
  {
    term: "Lot",
    aliases: ["lot size"],
    meaning:
      "The fixed contract size of a futures or options contract. An F&O quantity is a whole number of lots, and the Sizing Lab and Instruments respect it.",
  },
  {
    term: "Premium",
    aliases: ["option premium"],
    meaning:
      "The price of an option, per unit. A buyer pays it and can lose no more than it; a seller collects it and carries the obligation.",
  },
  {
    term: "Strike",
    aliases: ["strike price"],
    meaning: "The price at which an option can be exercised. A call is in the money above its strike, a put below it.",
  },
  {
    term: "Expiry",
    aliases: ["expiry day", "DTE", "days to expiry"],
    meaning:
      "The date an F&O contract settles and stops trading. Days to expiry (DTE) count down to it, and the Expiry tab splits expiry-day P&L from other days.",
  },
  {
    term: "ITR",
    aliases: ["income tax return"],
    meaning:
      "Income Tax Return. The ITR Pack lays out realised results in the return's own schedule item codes and indicates ITR-2 or ITR-3; it is a preparation aid, and your CA remains the source of record.",
  },
  {
    term: "AIS",
    aliases: ["annual information statement", "Form 26AS", "26AS"],
    meaning:
      "The Annual Information Statement: what reporting entities told the tax department about you, such as dividends, TDS and sales. AIS Reconcile compares rows you paste with the journal.",
  },
  {
    term: "Tax-loss harvest",
    aliases: ["tax harvest", "harvesting"],
    meaning:
      "Realising an unrealised loss before year-end so it sets off realised gains that year. Tax Harvest shows the arithmetic for delivery lots, names no security, and states that India has no wash-sale rule.",
  },
  {
    term: "FMV",
    aliases: ["fair market value", "grandfathering"],
    meaning:
      "Fair Market Value on 31 January 2018. Long-term gains on equity held from before then are grandfathered against it; you enter the per-share FMV on Tax Summary.",
  },
  {
    term: "ISIN",
    meaning:
      "The 12-character International Securities Identification Number of a security. Vyuha resolves symbols through it, and a superseded ISIN, as after a face-value split, maps to its successor.",
  },
  {
    term: "Workspace",
    aliases: ["workspace mode"],
    meaning:
      "Which book you trade: equity, F&O or both. It hides navigation and sets defaults; it deletes no data, and a hidden screen still opens from a link.",
  },
  {
    term: "Pro",
    aliases: ["Vyuha Pro"],
    meaning:
      "Vyuha Pro, the licence tier that unlocks analytics. The core journal, your own record of trades, is never gated, and a locked figure shows a Pro chip rather than a blank.",
  },
  {
    term: "OpenAlgo",
    meaning:
      "Separate open-source software you install and run yourself, reached over HTTP. It is off by default; switched on behind its disclosure, it offers same-day pulls and a Live Desk price source.",
  },
  {
    term: "Mark",
    aliases: ["MTM", "mark-to-market"],
    meaning:
      "The current price recorded for an open position; mark-to-market (MTM) values the position at it. One mark per position per day reaches the journal, and an unmarked holding has no unrealised result.",
  },
  {
    term: "Staged position",
    aliases: ["staged"],
    meaning:
      "A position built or exited in several tranches. It is priced at the weighted average, its quantity is consumed first in, first out, and its R stays frozen at the first entry.",
  },
  {
    term: "Tranche",
    meaning:
      "One entry or exit fill of a staged position. The remaining tranches' prices do not sum to the remaining cost basis, by design.",
  },
  {
    term: "FIFO",
    aliases: ["first in, first out"],
    meaning:
      "First in, first out: the oldest lot is consumed first. Staged positions use it, and an imported sale closes a position you already hold oldest lot first.",
  },
  {
    term: "ROM",
    aliases: ["return on margin"],
    meaning:
      "Return on Margin: net P&L over the capital the market actually blocked, such as premium for a long option or margin for a short one. ROM per day is weighted by capital-days.",
  },
  {
    term: "Setup",
    aliases: ["setup tag"],
    meaning:
      "The tag naming the pattern a trade was taken on, often a playbook. The Setups tab reports expectancy, win rate and Avg R per setup.",
  },
  {
    term: "Process Score",
    meaning:
      "One number for how the week was traded rather than what it made: the mean of five habits the journal records, withheld below ten closed trades. It says nothing about profit.",
    metricId: "processScore",
  },
  {
    term: "Cap band",
    aliases: ["market-cap band"],
    meaning:
      "A company's size class, large, mid or small, from AMFI's market-cap ranking in the bundled stock universe. NSE Emerge SME listings carry no band; index membership is a separate lens.",
  },
  {
    term: "Sector",
    aliases: ["industry"],
    meaning:
      "A stock's industry, from the exchanges' own classification in the bundled stock universe. A sector you tag yourself is never overwritten.",
  },
];

const INDEX: Map<string, GlossaryTerm> = new Map(
  GLOSSARY.flatMap((t) => [t.term, ...(t.aliases ?? [])].map((w) => [w.trim().toLowerCase(), t] as const)),
);

/** The glossary term whose name or alias is `word`, case-insensitively; undefined when none is. */
export function findTerm(word: string): GlossaryTerm | undefined {
  return INDEX.get(word.trim().toLowerCase());
}
