// HELP DESK CONTENT (PURE — data only).
//
// One entry per screen, keyed by the SAME href the sidebar uses, so the help
// desk can never describe a screen that does not exist or miss one that does —
// a test joins this registry against NAV_ITEMS and fails on any drift.
//
// Voice rules, same as the rest of the product: say what the screen answers,
// name its honesty rules where it has them, and never oversell. "What it will
// NOT do" is part of the description wherever the product deliberately refuses
// something, because those refusals are design, not gaps.

export interface HelpEntry {
  href: string;
  title: string;
  /** The question this screen answers, in one line. */
  answers: string;
  body: string[];
  /** Terms a trader might search for. */
  keywords: string[];
  /** Things this screen deliberately does not do. */
  refusals?: string[];
}

export const HELP_ENTRIES: HelpEntry[] = [
  {
    href: "/",
    title: "Dashboard",
    answers: "How is my trading doing overall, right now?",
    body: [
      "Equity curve with drawdown, a magnitude-scaled daily P&L calendar, win rate, profit factor and streaks — the whole book at a glance.",
      "Every headline KPI is clickable and opens a derivation: Net P&L splits into gross minus every charge with your best and worst day, and those rows deep-link to the trades that add up to them exactly.",
    ],
    keywords: ["overview", "equity curve", "calendar", "kpi", "net pnl", "win rate"],
  },
  {
    href: "/risk",
    title: "Portfolio Risk",
    answers: "What am I exposed to at this moment, and what would a bad day cost?",
    body: [
      "Live exposure, open risk at stop, allocation and sector concentration; VaR/CVaR, beta-weighted exposure and NIFTY stress scenarios; option Greeks with a three-tier IV fallback ending at the real India VIX.",
      "Pre-trade limit checks are advisory with an override — and overrides are recorded, so you can later see what ignoring the guardrail cost.",
      "This is also where you enter a current (mark) price for holdings that have none — an unmarked holding has no unrealised result anywhere in the app.",
    ],
    keywords: ["var", "cvar", "greeks", "margin", "exposure", "stress", "mark price", "current price", "sebi"],
    refusals: ["Never places, closes or modifies an order. Breach alerts say 'check a live quote' — the app acts on nothing by itself."],
  },
  {
    href: "/strategies",
    title: "Option Strategies",
    answers: "What do my open option legs add up to?",
    body: [
      "Groups open legs by underlying and expiry, recognises the structure (straddle, strangle, spread, iron condor…), and draws the exact expiry payoff with breakevens and max profit/loss.",
    ],
    keywords: ["payoff", "straddle", "strangle", "iron condor", "spread", "breakeven"],
  },
  {
    href: "/options-journal",
    title: "Options Seller Journal",
    answers: "As an option seller, where does my premium actually go — and which habits pay?",
    body: [
      "Premium capture, IV recorded at entry and exit, DTE, hedge status and expiry outcomes per contract.",
      "Depth reports: expectancy by days-to-expiry band, hedged vs unhedged as an honest gap (you chose which trades to hedge, so it is not a controlled experiment), roll chains against what the first leg alone booked, IV rank within your own recorded history, and premium kept per day of risk.",
    ],
    keywords: ["theta", "premium", "iv", "dte", "hedge", "roll", "adjustment", "seller"],
    refusals: ["IV rank is a percentile of your own recorded entries, not a market feed — and it says so on the card."],
  },
  {
    href: "/equity",
    title: "Equity Tracker",
    answers: "What are my delivery and MTF holdings worth, and what is the financing costing me?",
    body: [
      "Every equity position with invested value, unrealised P&L, days held and R — MTF rows show the broker-funded portion, accrued interest, effective leverage and a warning when interest has eaten the paper gain.",
    ],
    keywords: ["holdings", "delivery", "mtf", "interest", "leverage", "unrealised"],
  },
  {
    href: "/active",
    title: "Trade F&O Tracker",
    answers: "Where do my open F&O positions stand?",
    body: ["Open futures and options with entry, mark, unrealised P&L, current R against plan, and days to expiry."],
    keywords: ["fno", "futures", "options", "open positions", "expiry"],
  },
  {
    href: "/targets/equity",
    title: "Targets — Equity",
    answers: "Am I on plan in the equity book?",
    body: ["Position sizing against bucket capital, monthly target ladder and progress."],
    keywords: ["targets", "sizing", "capital"],
  },
  {
    href: "/targets/active",
    title: "Targets — Trade F&O",
    answers: "Am I on plan in the F&O book?",
    body: ["The same target ladder and sizing view for the active/F&O bucket."],
    keywords: ["targets", "fno", "sizing"],
  },
  {
    href: "/surveillance",
    title: "Surveillance",
    answers: "Is anything I hold on an exchange watchlist?",
    body: ["Upload the official NSE files — fo_secban.csv (F&O ban) and REG_IND (ASM/GSM/ESM stages) — or paste any list by hand; either way it is matched against your open positions with severity and what each listing means. Offline-first: you supply the file, nothing is fetched."],
    keywords: ["asm", "gsm", "ban", "circuit", "watchlist"],
  },
  {
    href: "/calculator",
    title: "Trade Calculator",
    answers: "What will this trade cost, and what is it worth at target and at stop?",
    body: ["Exact round-trip charges from the same engine that books real trades, net at target, net at stop, charge-adjusted reward:risk and breakeven — equity, F&O or MTF, projected across N trades."],
    keywords: ["charges", "breakeven", "reward risk", "brokerage", "calculator"],
  },
  {
    href: "/trades",
    title: "Trades",
    answers: "The journal itself — every trade with its charges, R and tags.",
    body: [
      "Add, open, close, edit, journal, stage and delete trades. One dropdown covers status and outcome together, and every option carries a live count so the numbers always add up.",
      "Select rows with the checkboxes for bulk delete — the confirmation shows exactly what will go, and past ten trades you type the count. Deleting a trade takes its notes, tags and chart attachments with it.",
      "An open position with no current price appears under Open but in neither 'in gain' nor 'in loss' — a missing price is never read as breakeven.",
    ],
    keywords: ["journal", "add trade", "delete", "bulk", "select", "filter", "unmarked"],
  },
  {
    href: "/lenses",
    title: "Lenses",
    answers: "Where do these trades come from, and which slice of the book is actually working?",
    body: [
      "The same journal cut six ways — by month, broker, trade type, import file, setup and outcome. A tab strip switches the cut without leaving the page; each group carries its own net P&L and charges, and — with a Pro licence — win rate, profit factor, expectancy and average R.",
      "Open a group to see the trades behind it and the figures for that group alone. This is the fastest way to see exactly what one imported file produced, in isolation, when an import has gone wrong.",
      "Every cut is a partition: each trade appears in exactly one group and the groups add up to the whole book. Trades with no usable date, no setup recorded, or an import record that has since been deleted get their own honest group rather than being dropped.",
      "Any group can be deleted from here. The confirmation shows the same resolved set the group counted, and a snapshot is saved first so it can be undone from Backup & Restore.",
    ],
    keywords: ["group", "by month", "by broker", "by import", "breakdown", "tabs", "setup", "outcome", "segment", "per-file"],
    refusals: [
      "Overlapping cuts are not offered here. One trade belongs to several NSE themes and can carry several mistake tags, so those totals exceed the book by design — they live in their own reports, labelled as lenses rather than breakdowns.",
      "Win rate, profit factor and expectancy are blank for a group with nothing closed, rather than shown as zero — and a LOCKED figure looks like a Pro chip, never like a blank, so \"not entitled\" can never be mistaken for \"no data\".",
      "Grouping, counts, P&L and deleting a group are free on every tier: isolating and undoing a bad import is journal hygiene, not analytics.",
    ],
  },
  {
    href: "/sessions",
    title: "Session Plan",
    answers: "Did I trade the plan I wrote before the open?",
    body: ["Watchlist, playbooks, trade-count and loss budgets, and a cutoff — reviewed after the close by a deterministic diff of plan against journal. The same inputs always give the same verdict; there is no model in the loop."],
    keywords: ["plan", "review", "watchlist", "cutoff", "discipline", "adherence"],
  },
  {
    href: "/arjuns-eye",
    title: "Arjun's Eye",
    answers: "What kind of trader am I, and where does my edge actually come from?",
    body: [
      "Expectancy by Indian session and weekday, whether you cut winners and hold losers, how a loss changes your next trade, and whether your biggest positions are your best.",
      "Three honesty rules are enforced in code: no finding below 15 trades, no invented session for a trade whose time is unknown, and every finding is an observation — there is a test asserting none says 'you should'.",
    ],
    keywords: ["behaviour", "session", "tilt", "revenge", "expectancy", "edge"],
  },
  {
    href: "/playbooks",
    title: "Playbooks",
    answers: "Which setups do I trade, and do I follow their rules?",
    body: ["25 preset setups across 7 global ecosystems plus your own, each with editable rules. Journaling a trade shows its playbook's rules as a followed/broken checklist; broken rules land on Discipline with their real cost. Nothing is auto-seeded — a playbook becomes yours only when you add it."],
    keywords: ["setups", "rules", "checklist", "orb", "vcp", "canslim"],
  },
  {
    href: "/ipos",
    title: "IPOs",
    answers: "What happened to my IPO applications, allotments and exits?",
    body: ["Applications through allotment, listing and exit with category discounts, SME lots, refund amounts and a tax estimate. An allotment linked from Trades gets its cost basis from the issue price you enter here — one source of truth, so the numbers cannot drift."],
    keywords: ["ipo", "allotment", "listing", "gmp", "issue price"],
  },
  {
    href: "/import",
    title: "Import",
    answers: "Get broker files into the journal, honestly.",
    body: [
      "Eight brokers, auto-detected, de-duplicated, with a charge reconciliation panel before anything commits. Tradebooks and P&L exports are treated as different kinds because they are — a P&L file states neither product nor time, so the product question is asked once, before commit.",
      "If a file's rows look like trades already recorded from a different file kind, the preview says so before you commit — the two kinds state different facts, so the duplicate check cannot match them silently.",
      "Imported files are listed below with the trades each still owns; deleting one asks whether the trades go too.",
      "Live API pulls for Zerodha, Dhan and Angel One are built in. A fourth path — OpenAlgo — appears here only after you switch it on in Settings → Integrations: it is separate open-source software you run yourself, and through it Groww, Upstox, Paytm Money and Kotak also get a same-day pull. It reads today's executed trades only, and sizes are repaired and counted when the API reports zero, so check a repaired row against your contract note before committing.",
    ],
    keywords: ["dhan", "zerodha", "groww", "csv", "duplicate", "delete import", "reconciliation", "openalgo", "api pull"],
    refusals: ["MTF is never inferred from a file — it is indistinguishable from delivery there, so the app asks instead of guessing."],
  },
  {
    href: "/cash",
    title: "Cash & Ledger",
    answers: "What has moved in and out of the account besides trades?",
    body: ["Deposits, withdrawals, charges, dividends, TDS, margin penalties and MTF interest — the running balance the trades sit on. Dhan ledger files import directly, including the broker's own weekly MTF interest postings."],
    keywords: ["ledger", "deposit", "withdrawal", "dividend", "tds", "penalty"],
  },
  {
    href: "/corporate-actions",
    title: "Corporate Actions",
    answers: "A split, bonus or dividend happened — keep my positions honest.",
    body: ["Applies splits and bonuses to open positions (quantity up, cost and stops down, invested value provably preserved) and posts dividends to the ledger with TDS handling. Each event applies once and is locked."],
    keywords: ["split", "bonus", "dividend", "corporate action"],
  },
  {
    href: "/reports/performance",
    title: "Performance",
    answers: "Risk-adjusted, how good is this really?",
    body: ["Sharpe, Sortino, Calmar, CAGR, volatility, max drawdown, monthly returns, XIRR and TWR, benchmark alpha/beta against a pasted NIFTY series, Monte-Carlo risk of ruin, and a shareable stat card that defaults to percentages and never uploads anything."],
    keywords: ["sharpe", "xirr", "twr", "alpha", "beta", "monte carlo", "share card"],
  },
  {
    href: "/reports/monthly",
    title: "Report (PDF)",
    answers: "One printable monthly statement.",
    body: ["Scorecard, equity curve, monthly matrix, top playbooks and mistake economics, print-styled — use the Print button and save as PDF."],
    keywords: ["pdf", "print", "monthly report"],
  },
  {
    href: "/reports/charges",
    title: "Charges & MTF Leak",
    answers: "Where does my gross P&L actually go?",
    body: ["Every charge head over time, MTF interest as its own leak, and the peak-margin penalty tracker."],
    keywords: ["charges", "leak", "stt", "brokerage", "penalty"],
  },
  {
    href: "/reports/broker-compare",
    title: "Broker Costs",
    answers: "Would my history have been cheaper on another broker?",
    body: ["Your entire book re-priced on every broker's rate card, free and paid plans listed separately with subscriptions amortised. Only a broker that priced every trade can be called cheapest — a partial total always flatters, so it is marked and excluded from the ranking."],
    keywords: ["broker comparison", "cheapest", "rate card", "plans"],
  },
  {
    href: "/reports/advance-tax",
    title: "Advance Tax",
    answers: "What are my instalments, and what does missing one cost?",
    body: ["The 15/45/75/100 schedule prefilled from realised FY P&L, with 234C interest per instalment. 234B is stated as a caveat, not computed — it cannot be assessed in a forward planner."],
    keywords: ["advance tax", "234b", "234c", "instalment"],
  },
  {
    href: "/reports/harvest",
    title: "Tax Harvest",
    answers: "Which unrealised losses are worth realising before year-end?",
    body: ["Open delivery lots with unrealised losses set against realised FY gains, with the estimated tax saved. F&O and intraday are excluded — business income does not harvest."],
    keywords: ["harvesting", "ltcg", "stcg", "losses"],
  },
  {
    href: "/reports/expiry",
    title: "Expiry Analytics",
    answers: "How do I trade expiry day, and what expires next?",
    body: ["Expiry-day P&L split against ordinary days, and the calendar of upcoming expiries from open positions."],
    keywords: ["expiry", "weekly", "calendar"],
  },
  {
    href: "/reports/rom",
    title: "Return on Margin",
    answers: "What did the capital actually blocked earn?",
    body: [
      "The denominator is what the market really blocks: premium for long options, margin against the underlying for short ones, a percentage for futures, only your own capital for MTF. ROM per day is weighted by capital-days, so a scalper and a swing trader become comparable.",
      "Annualised figures are clamped and marked — a book losing 10% a day extrapolates to an impossible number, and the report says so rather than printing it.",
    ],
    keywords: ["rom", "margin", "capital", "return"],
  },
  {
    href: "/reports/edge",
    title: "Edge / Setups",
    answers: "Which setups make money, and are my stops in the right place?",
    body: ["Expectancy by setup tag and segment, MAE/MFE excursions from your own EOD history, and a stop-tuning report in R — explicitly descriptive, not prescriptive."],
    keywords: ["expectancy", "mae", "mfe", "stops", "setup"],
  },
  {
    href: "/reports/scaling",
    title: "Scaling & Replay",
    answers: "Did adding to positions help, and what did the trade look like day by day?",
    body: ["Staged positions against a clearly-labelled first-entry-only counterfactual, and an EOD replay of any trade with entries, exits and stops marked."],
    keywords: ["scaling", "pyramid", "replay", "average down"],
  },
  {
    href: "/reports/discipline",
    title: "Discipline",
    answers: "What are my broken rules costing me, in rupees?",
    body: ["Weekly adherence, cost of mistakes as an expectancy gap (never a fake counterfactual), trading by emotion, entry-time breaches, and the per-rule cost table. The SEBI reality-check card sets your F&O results against the published loss statistics."],
    keywords: ["mistakes", "rules", "emotion", "sebi", "adherence"],
  },
  {
    href: "/reports/tax",
    title: "Tax Summary",
    answers: "STCG, LTCG, set-off and carry-forward for my book.",
    body: ["Dual-regime rates around the 23-Jul-2024 cutover, 31-Jan-2018 grandfathering with per-share FMV entry, full sections 70–74 set-off and carry-forward, and dividend TDS by company and FY."],
    keywords: ["stcg", "ltcg", "set-off", "carry forward", "grandfathering", "fmv"],
  },
  {
    href: "/reports/itr",
    title: "ITR Pack (India)",
    answers: "What goes in which box of the return?",
    body: [
      "Head-wise segregation, ICAI Guidance Note turnover, a 44AB/44AD read, and schedule-format line items — Schedule CG, BP and CFL in the return's own item codes, with the form indicated (ITR-2 or ITR-3).",
      "STT is excluded from capital-gains deductions but allowed as a business expense, so the Schedule CG balance is deliberately higher than the net P&L shown elsewhere — that is the law, not a bug.",
    ],
    keywords: ["itr", "44ab", "turnover", "schedule cg", "audit"],
    refusals: ["A preparation aid, not filing advice — the cautions are part of the output and your CA remains the source of record."],
  },
  {
    href: "/reports/ais",
    title: "AIS Reconcile",
    answers: "Does my journal agree with what the tax department was told?",
    body: ["Paste your AIS/Form 26AS rows and they are reconciled against the journal's dividends, TDS and equity sales, difference by difference."],
    keywords: ["ais", "26as", "reconcile", "tds"],
  },
  {
    href: "/audit",
    title: "Audit Log",
    answers: "Who changed what, when — including deletes.",
    body: ["Append-only history of every mutation with before/after snapshots. A deleted trade's full row lives here — it is the only in-app record after a delete."],
    keywords: ["audit", "history", "changes", "deleted"],
  },
  {
    href: "/data-quality",
    title: "Data Quality",
    answers: "Which numbers elsewhere in the app cannot be trusted yet, and why?",
    body: ["One confidence score over missing cost basis, marks, stops, MTF funding, option metadata, instrument coverage, IPO links and missing attachment files — each with a direct route to fix it. Critical means it changes money; info means coverage."],
    keywords: ["quality", "score", "missing", "confidence"],
  },
  {
    href: "/rule-packs",
    title: "Rule & Rate Packs",
    answers: "Which dated regulatory assumptions is the app running on?",
    body: ["SEBI derivatives rules and broker-rate assumptions carry effective dates, source URLs, versions and review dates. The compliance radar reads the active pack — not hard-coded copy."],
    keywords: ["sebi", "rules", "rates", "sources", "versions"],
  },
  {
    href: "/backup",
    title: "Backup & Restore",
    answers: "Your entire trading life, in one file you control.",
    body: [
      "Complete versioned exports of every table and screenshot attachment, optional AES-256 encryption, and a restore preview before anything is replaced. Restore is atomic — any failure leaves the journal exactly as it was.",
      "This is also the honest way to start over: export first, then restore an empty backup. There is deliberately no one-click wipe anywhere in the app.",
    ],
    keywords: ["backup", "restore", "export", "encrypt", "sqlite"],
  },
  {
    href: "/aliases",
    title: "Symbol Aliases",
    answers: "Map broker scrip names to one canonical symbol.",
    body: ["'BHARAT COKING COAL LTD' and its ticker are the same instrument — aliases make every report agree on that."],
    keywords: ["alias", "symbol", "mapping"],
  },
  {
    href: "/instruments",
    title: "Instruments",
    answers: "Sectors, ISINs and lot sizes for everything you trade.",
    body: ["The instrument master behind sector concentration and lot-size checks. Curate it here as new names enter the book."],
    keywords: ["instruments", "sector", "isin", "lot size"],
  },
  {
    href: "/settings",
    title: "Settings",
    answers: "Capital, risk limits, rates, appearance — and your saved defaults.",
    body: [
      "Capital buckets, risk and charge/margin rate tables (every statutory rate is editable — nothing is hard-coded), theme, accent skins, colorblind-safe mode and licence activation.",
      "Your first configuration is kept as My Default Settings; change anything freely and one click brings the whole configuration back to your baseline. Trades and journal data are never part of that restore.",
      "Integrations (advanced) is where the OpenAlgo connection is switched on. It is off on every install, the switch opens a disclosure you have to accept, and the acceptance is written to the Audit Log with the version of the risks you read. Turning it off hides it again and leaves every trade already imported exactly where it is.",
    ],
    keywords: ["settings", "capital", "rates", "theme", "default", "restore defaults", "licence", "integrations", "openalgo"],
  },
  {
    href: "/help",
    title: "Help Desk",
    answers: "This screen — what every part of Vyuha does, searchable.",
    body: ["Every screen described with what it answers, what it refuses to do, and a direct link. Search by what you are trying to accomplish — 'stop loss', 'tax', 'delete'."],
    keywords: ["help", "guide", "documentation", "how to"],
  },
];

/** Case-insensitive search across title, answers, body and keywords. */
export function searchHelp(entries: HelpEntry[], query: string): HelpEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) =>
    [e.title, e.answers, ...e.body, ...e.keywords, ...(e.refusals ?? [])].some((s) => s.toLowerCase().includes(q)),
  );
}
