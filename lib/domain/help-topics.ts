// HELP TOPICS — the task-first layer of every help entry (PURE — data only; v4.6.0 W4, owner ruling H4).
//
// Keyed by the SAME href as HELP_ENTRIES in ./help-content.ts. A test joins the two and fails on a missing or an
// orphan href. The card budget (title + answers + steps + watchOut) is <= 120 words, pinned by test (written to
// <= 110); the entry's body and refusals are NOT in the budget — they render under "In detail" unchanged.
//
// Voice: steps say what the trader DOES on the screen, in order, and name only controls the screen really has
// (read from its page component where the entry's body is thin). watchOut is the one real trap, taken from the
// entry's refusals or the screen's honesty rule. Descriptive, never prescriptive (SEBI copy rule); no alert is
// promised, no counterfactual rupee figure is offered, and no session time is written here — timings live only
// in lib/domain/market-calendar.ts.
//
// Hub tab keys are DERIVED through `tab()` (the one spelling, `hubTabHref`), never typed as a second literal
// list; a typo in a hub path or tab id throws at load.

import { hubForHref, hubTabHref } from "@/lib/domain/hubs";

/** The task-first layer of a help topic. Structurally identical to HelpTask in ./help-content.ts. */
export interface HelpTask {
  /** 3–5 imperative steps, each one sentence, <= 20 words. */
  steps: string[];
  /** The one thing that goes wrong on this screen, one or two sentences. */
  watchOut: string;
  /** hrefs of other HELP_ENTRIES (never ids); 0–4. */
  related: string[];
  /** File stem under public/help/<name>.webp — only for a top-level screen with stable demo content. */
  screenshot?: string;
}

/** `/reports/costs?tab=charges`, spelled by hubs.ts; throws on an unknown hub or tab. */
function tab(hubPath: string, tabId: string): string {
  const hub = hubForHref(hubPath);
  if (!hub || !hub.tabs.some((t) => t.id === tabId)) throw new Error(`help-topics: no hub tab ${hubPath}?tab=${tabId}`);
  return hubTabHref(hub, tabId);
}

const SETUPS = tab("/reports/edge-clinic", "setups");
const DISCIPLINE = tab("/reports/edge-clinic", "discipline");
const SCALING = tab("/reports/edge-clinic", "scaling");
const ROM = tab("/reports/capital", "rom");
const EXPIRY = tab("/reports/capital", "expiry");
const CHARGES = tab("/reports/costs", "charges");
const BROKER_COMPARE = tab("/reports/costs", "broker-compare");

export const HELP_TASKS: Record<string, HelpTask> = {
  "/": {
    steps: [
      "Read the equity curve and its drawdown for the shape of the whole book.",
      "Scan the daily P&L calendar, where each day is scaled by the size of its result.",
      "Click a headline KPI to open its derivation, such as Net P&L split into gross minus every charge.",
      "Follow a derivation row to the exact trades that add up to it.",
    ],
    watchOut:
      "The dashboard's Max DD walks realised P&L trade by trade from zero, so it can differ from Performance, which walks your configured capital day by day.",
    related: ["/trades", "/reports/performance", "/data-quality"],
    screenshot: "dashboard",
  },
  "/live": {
    steps: [
      "Read each open position's mark, unrealised P&L, open R and risk at stop.",
      "Pick the price source in Settings → Live feed; the stored end-of-day bhavcopy is the default.",
      "Type a mark or press Save today's mark to record that day's price.",
      "Move through rows with j and k, press Enter to expand one, and l to open the Sizing Lab.",
    ],
    watchOut:
      "A row with no stop recorded is left out of heat and says so, rather than counted as risk-free. A stop is not an assured fill.",
    related: ["/settings", "/risk", "/sizing-lab", "/equity"],
    screenshot: "live",
  },
  "/risk": {
    steps: [
      "Read live exposure, open risk at stop, allocation and sector concentration.",
      "Enter a current mark price for any holding that has none.",
      "Check VaR and CVaR, beta-weighted exposure and the NIFTY stress scenarios.",
      "Read option Greeks, whose IV falls back through three tiers ending at India VIX.",
    ],
    watchOut:
      "A holding with no mark has no unrealised result anywhere in the app until one is entered. A limit override is recorded, not hidden.",
    related: ["/live", "/surveillance", "/instruments"],
  },
  "/strategies": {
    steps: [
      "Open Signal book to read each option trade's recorded signal and its T1 / T2 / SL ladder.",
      "Record a signal on the Add trade form: F&O, Option, then Record the signal.",
      "Open Structures you hold to see open legs grouped per underlying, with payoff and breakevens.",
      "Follow a named card to its write-up in the Options section of the Help Desk.",
    ],
    watchOut:
      "On a group with more than one expiry the curve is drawn at the nearest one, and the far legs are valued at intrinsic only.",
    related: ["/options-journal", "/active", "/help"],
  },
  "/options-journal": {
    steps: [
      "Read premium capture, IV at entry and exit, DTE and hedge status per contract.",
      "Compare expectancy across the days-to-expiry bands.",
      "Read hedged against unhedged as a gap, and each roll chain against its first leg alone.",
      "Check IV rank and premium kept per day of risk.",
    ],
    watchOut:
      "IV rank is a percentile of your own recorded entries, not a market feed. Hedged versus unhedged is not a controlled experiment.",
    related: ["/strategies", "/active", EXPIRY],
  },
  "/equity": {
    steps: [
      "Filter holdings by funding: all, broker-funded (MTF) or user-funded only.",
      "Read invested value, unrealised P&L, days held and R per position.",
      "On MTF rows, read the funded portion, accrued interest and effective leverage.",
      "Enter a manual or end-of-day price under Update MTM.",
    ],
    watchOut: "An MTF row carries a warning when accrued interest has eaten its entire unrealised gain.",
    related: ["/live", "/cash", "/targets/equity", CHARGES],
  },
  "/active": {
    steps: [
      "Filter open futures and options by segment.",
      "Read entry, mark, unrealised P&L and current R against plan per position.",
      "Read days to expiry on each row.",
      "Enter a manual or end-of-day price under Update MTM.",
    ],
    watchOut: "Current R needs a stop recorded at entry; a position without one carries no R.",
    related: ["/live", "/strategies", EXPIRY, "/targets/active"],
  },
  "/atlas": {
    steps: [
      "Store bhavcopy bars on Instruments or backfill from Coverage; every figure comes from stored bars.",
      "Read the regime card: two voting inputs, thresholds printed and editable in Settings.",
      "On Sectors, toggle sector or industry and median or mean; each column states its priced count.",
      "My names compares each open position with its industry cohort's median, falling up to sector.",
    ],
    watchOut:
      "A thin group prints an em dash, not a zero, and a tile under 30% coverage shows its coverage instead. The index filter restricts every tab; the header says so.",
    related: ["/instruments", SETUPS],
    screenshot: "atlas",
  },
  "/targets/equity": {
    steps: [
      "Read per-trade max loss and max open positions against the equity bucket's capital.",
      "Track the monthly target ladder across the combined buckets.",
      "Check MTF interest and the break-even move each funded position needs.",
      "Review the top concentration in the book.",
    ],
    watchOut: "Goal progress is measured against your own realised record, never a projection.",
    related: ["/targets/active", "/equity", "/settings", "/sizing-lab"],
  },
  "/targets/active": {
    steps: [
      "Check today's day net against the daily loss stop and the loss budget left.",
      "Read trades taken today against max trades per day and the per-segment sub-limits.",
      "Read each trade against the per-trade cap.",
      "Track the monthly ladder and sizing for the F&O bucket.",
    ],
    watchOut: "With no daily loss stop set, the screen says so rather than inventing a limit; the risk limits live in Settings.",
    related: ["/targets/equity", "/active", "/settings", DISCIPLINE],
  },
  "/surveillance": {
    steps: [
      "Upload fo_secban.csv or a REG_IND file from NSE; the category comes from the file type.",
      "Or paste any restriction list by hand.",
      "Read each match against your open positions, with its severity and what the listing means.",
      "Check the As of date beside each list.",
    ],
    watchOut: "The desktop app fetches nothing, so a list is only as current as the file you last loaded.",
    related: ["/risk", "/live", "/equity"],
  },
  "/calculator": {
    steps: [
      "Choose broker, plan, exchange and side, then enter entry, quantity, stop-loss and target.",
      "Read round-trip charges, net at target, net at stop and the breakeven move.",
      "Enter a risk budget and press Size it for me for a quantity.",
      "Project the result across N trades.",
    ],
    watchOut: "Reward : risk here is after charges, so it reads lower than the raw distance between the levels.",
    related: ["/sizing-lab", BROKER_COMPARE, "/settings"],
    screenshot: "calculator",
  },
  "/sizing-lab": {
    steps: [
      "Enter one setup and pick the stop method: manual, structure, ATR or percent.",
      "Read seven sizing methods side by side, each with its formula beside the size.",
      "Turn the charges toggle on to fold round-trip charges into the risk.",
      "Press the write-back button to store risk %, deploy cap or stop settings in Settings.",
    ],
    watchOut:
      "Nothing changes your Live Desk defaults until you press write-back. A missing input gives a typed reason, not a size.",
    related: ["/calculator", "/live", "/settings"],
    screenshot: "sizing-lab",
  },
  "/trades": {
    steps: [
      "Add a trade, or open one to edit, journal, stage or close it.",
      "Filter with the one dropdown for status and outcome; every option carries a live count.",
      "Tick rows for bulk delete; past ten trades the confirmation asks you to type the count.",
      "Press Un-close on a row an import closed to reopen the position exactly as it was.",
    ],
    watchOut:
      "An open position with no current price sits under Open but in neither 'in gain' nor 'in loss'; a missing price is never read as breakeven.",
    related: ["/review", "/lenses", "/import", "/audit"],
    screenshot: "trades",
  },
  "/lenses": {
    steps: [
      "Pick a cut from the tab strip: month, broker, trade type, import file, setup or outcome.",
      "Open a group to see its trades and the figures for that group alone.",
      "Use the import-file cut to see exactly what one imported file produced.",
      "Delete a group here; a snapshot is saved first and can be undone from Backup & Restore.",
    ],
    watchOut:
      "A blank win rate means nothing priced has closed in that group; a locked figure shows a Pro chip, never a blank.",
    related: ["/trades", "/import", "/backup"],
  },
  "/sessions": {
    steps: [
      "Before the open, enter watchlist symbols, planned playbooks, max trades, a loss budget and a last entry time.",
      "Write the thesis and invalidation, then press Save session plan.",
      "After the close, read the diff of plan against journal and press Mark reviewed.",
    ],
    watchOut:
      "The verdict compares the journal only with what the plan states; the same inputs always give the same verdict, with no model in the loop.",
    related: ["/playbooks", "/review", DISCIPLINE],
  },
  "/review": {
    steps: [
      "Read the open week's Process Score and the five components beside it.",
      "Work the queue of closed trades with no review stamp; each row opens the journal dialog.",
      "Save the journal to stamp a trade, or stamp one with nothing to add directly.",
      "Run the weekly ritual for the week that has ended, and complete it to store the score.",
    ],
    watchOut: "A week with fewer than ten closed trades says so instead of scoring. The ritual sends no reminder.",
    related: ["/trades", DISCIPLINE, "/reports/monthly"],
  },
  "/arjuns-eye": {
    steps: [
      "Read expectancy by Indian session and by weekday.",
      "Check whether winners are cut early and losers held, and how a loss changes the next trade.",
      "See whether your largest positions are also your most profitable.",
    ],
    watchOut:
      "No finding appears below 15 trades, and a trade with no recorded time gets no session. Every finding is an observation.",
    related: [SETUPS, "/review", "/trades"],
  },
  "/playbooks": {
    steps: [
      "Browse the 25 preset setups and add the ones you trade, or create your own.",
      "Edit a playbook's rules to match how you trade it.",
      "Journal a trade against its playbook to tick each rule as followed or broken.",
      "Read broken rules and their cost on Discipline.",
    ],
    watchOut: "Nothing is auto-seeded: a preset becomes yours only when you add it, so an empty list is the starting state.",
    related: [DISCIPLINE, "/trades", "/sessions", SETUPS],
  },
  "/ipos": {
    steps: [
      "Record each application through allotment, listing and exit.",
      "Enter the issue price; an allotment linked from Trades takes its cost basis from it.",
      "Read category discounts, SME lots, refund amounts and the tax estimate.",
    ],
    watchOut: "The issue price here is the one source of a linked allotment's cost basis, so a wrong price moves that trade's P&L.",
    related: ["/trades", "/reports/tax", "/data-quality"],
  },
  "/import": {
    steps: [
      "Drop a broker file; its broker and kind are detected, or the column mapper asks whose it is.",
      "Read the preview: duplicates, the charge reconciliation and any position a sale would close.",
      "Answer the product question a P&L file raises, then commit.",
      "Tick Keep sells as separate rows to stop a sale closing a held position for that import.",
      "Delete an imported file from the list below; it asks whether its trades go too.",
    ],
    watchOut: "MTF is never guessed from a file: most exports cannot tell it from delivery, so the app asks.",
    related: ["/import-help", "/trades", "/lenses", "/data-quality"],
    screenshot: "import",
  },
  "/import-help": {
    steps: [
      "Find the card for your broker and the exports it reads.",
      "Follow the card's path to download that file from the broker.",
      "Set up an API connection, or the two-part OpenAlgo path, from its card.",
      "Read the verification status stated on each card.",
    ],
    watchOut: "A broker with no published format goes to the column mapper on Import, where you say whose file it is.",
    related: ["/import", "/settings"],
  },
  "/reports/reconcile": {
    steps: [
      "Import one of the seven statement files, such as a Dhan Realised P&L.",
      "Read the broker's figures beside Vyuha's, per segment, financial year and scrip.",
      "Read each difference with the counted reasons that account for it.",
      "Check the charges table for DP fees, contract-note charges and ledger charge tables.",
    ],
    watchOut:
      "Nothing is averaged or corrected: the two sides stay two sides, and a gap with no knowable cause is shown with no cause.",
    related: ["/import", "/reports/ais", "/cash"],
  },
  "/cash": {
    steps: [
      "Add a ledger entry for a deposit, withdrawal, charge, dividend, TDS or margin penalty.",
      "Import a Dhan ledger to bring in the broker's own weekly MTF interest postings.",
      "Compare the MTF interest the broker charged with Vyuha's estimate.",
      "Read net fund flows and total available against opening capital.",
    ],
    watchOut: "With no opening capital configured the page says so, and the running balance has no starting point.",
    related: ["/settings", "/corporate-actions", "/equity", CHARGES],
  },
  "/corporate-actions": {
    steps: [
      "Add an event: symbol, type, ex-date and a ratio or rupees per share.",
      "Apply a split or bonus to raise quantity and lower cost and stops, invested value preserved.",
      "Apply a dividend to post it to the ledger with its TDS.",
    ],
    watchOut: "Each event applies once and is then locked, so the ratio is worth checking before it is applied.",
    related: ["/cash", "/equity", "/instruments"],
  },
  "/reports/performance": {
    steps: [
      "Read Sharpe, Sortino, Calmar, CAGR, volatility and max drawdown.",
      "Compare XIRR (money-weighted) with TWR (time-weighted) and the monthly returns.",
      "Paste NIFTY 50 daily closes into the benchmark panel for alpha and beta.",
      "Build the share card: pick its metrics and show % of capital, real rupees or no amounts.",
    ],
    watchOut: "These figures run on realised days only, so open-position pain never registers. The share card uploads nothing.",
    related: ["/", "/reports/monthly", "/settings"],
    screenshot: "reports-performance",
  },
  "/reports/monthly": {
    steps: [
      "Read the scorecard, equity curve and monthly matrix.",
      "Check top playbooks and mistake economics for the period.",
      "Press Print and save the page as PDF.",
    ],
    watchOut: "Mistake economics reports the expectancy gap against untagged trades, never a P&L you would have had.",
    related: ["/reports/performance", "/review", "/playbooks"],
  },
  "/reports/edge-clinic": {
    steps: [
      "Open Setups for expectancy by setup, segment and NSE theme, with stop tuning and MAE/MFE.",
      "Open Discipline for the weekly Process Score and what broken rules cost.",
      "Open Scaling & Replay to see whether adding to a position helped.",
    ],
    watchOut: "Stop tuning describes where past stops sat in R; it names no stop to use.",
    related: [SETUPS, DISCIPLINE, SCALING],
    screenshot: "reports-edge-clinic",
  },
  "/reports/capital": {
    steps: [
      "Open Return on Margin for P&L over the capital the market actually blocked.",
      "Open Expiry for expiry-day P&L against other days, and the upcoming expiries.",
      "Bookmark a tab; its link opens that tab directly.",
    ],
    watchOut: "An equity-only workspace leaves the Expiry tab off the strip; a link to it still opens.",
    related: [ROM, EXPIRY, "/active"],
    screenshot: "reports-capital",
  },
  "/reports/costs": {
    steps: [
      "Open Charges & MTF Leak for every charge head over time and the peak-margin penalty tracker.",
      "Open Broker Costs to see your whole book re-priced on every broker's rate card.",
      "Bookmark a tab; its link opens that tab directly.",
    ],
    watchOut: "A broker that cannot price every trade is marked partial and left out of the cheapest ranking.",
    related: [CHARGES, BROKER_COMPARE, "/calculator"],
    screenshot: "reports-costs",
  },
  [CHARGES]: {
    steps: [
      "Read total charges, brokerage, STT / CTT and the average break-even move.",
      "Break charges down by segment and by month.",
      "Read MTF interest as its own leak column.",
      "Log a peak-margin penalty in Cash & Ledger with type Margin Penalty to see it here.",
    ],
    watchOut: "A penalty the broker billed appears only once it is logged in Cash & Ledger; the contract note is where it shows.",
    related: [BROKER_COMPARE, "/cash", "/reports/costs"],
  },
  [BROKER_COMPARE]: {
    steps: [
      "Read your whole book re-priced on every broker's rate card, brokerage, GST and statutory split out.",
      "Compare free and paid plans, listed separately with subscriptions amortised.",
      "Read the charges actually recorded against the cheapest broker and the headroom.",
    ],
    watchOut: "A broker that priced only some trades is marked Partial, listed last with an asterisk and never called cheapest, because a partial total always flatters.",
    related: [CHARGES, "/calculator", "/settings"],
  },
  "/reports/advance-tax": {
    steps: [
      "Read the 15/45/75/100 schedule prefilled from realised FY P&L.",
      "Record each challan: date and amount, plus the BSR code and serial where the receipt shows them.",
      "Read each instalment against what was paid by its own due date, with deferment interest.",
    ],
    watchOut:
      "A payment after 31 March is self-assessment tax and counts toward no rung. The s.424 interest is a caveat, not computed.",
    related: ["/reports/tax", "/reports/itr", "/reports/harvest"],
  },
  "/reports/harvest": {
    steps: [
      "Read open delivery lots with unrealised losses against realised FY gains, with the estimated tax saved.",
      "Check which losses can meet gains this year rather than only future business income.",
      "Read STT deductible on business-head legs against STT forfeited on delivery legs.",
      "Read how many days each open lot has until it turns long-term.",
    ],
    watchOut: "F&O and intraday are excluded, since business income does not harvest. India has no wash-sale rule.",
    related: ["/reports/tax", "/reports/advance-tax", "/equity"],
  },
  [EXPIRY]: {
    steps: [
      "Read expiry-day net against other-day net, and the expiry edge.",
      "Check expiry-day concentration in the F&O book.",
      "Read the upcoming expiries of your open positions.",
    ],
    watchOut: "Only F&O trades count here, and an open position with no future expiry is left off the calendar.",
    related: ["/reports/capital", ROM, "/active", "/options-journal"],
  },
  [ROM]: {
    steps: [
      "Read ROM and ROM per day over closed trades with establishable capital.",
      "Compare segments by where capital works hardest, then each playbook.",
      "Open How capital blocked is calculated to see the basis per trade type.",
      "Scan the most capital-efficient trades.",
    ],
    watchOut:
      "Annualised figures are clamped and marked once the extrapolation leaves the meaningful range, instead of printing an impossible number.",
    related: ["/reports/capital", EXPIRY, "/reports/performance"],
  },
  [SETUPS]: {
    steps: [
      "Read expectancy, win rate, profit factor and Avg R by setup tag and by segment.",
      "Load the bundled NSE map on Instruments to fill the By NSE theme table.",
      "Read MAE / MFE excursions taken from your stored EOD history.",
      "Read stop tuning in R: winners' heat and losers past 1.1R.",
    ],
    watchOut: "NSE themes overlap: one stock sits in up to ten indices, so theme P&L is a lens, not a partition of the book.",
    related: ["/reports/edge-clinic", DISCIPLINE, "/playbooks", "/instruments"],
  },
  [SCALING]: {
    steps: [
      "Read closed ladders and how many were improved or harmed by scaling.",
      "Compare each staged position with its first-entry-only line.",
      "Replay a trade in the visual EOD replay, with entries, exits and stops marked.",
    ],
    watchOut:
      "The first-entry-only line is a labelled comparison that isolates the money scaling added; it is not a path you could have traded unchanged.",
    related: ["/reports/edge-clinic", SETUPS, "/trades"],
  },
  [DISCIPLINE]: {
    steps: [
      "Read the weekly Process Score and its five components, each with numerator, denominator and coverage.",
      "Read the cost of mistakes as an expectancy gap per mistake tag.",
      "Check trading by emotion, entry-time limit breaches and the per-rule cost table.",
      "Read the SEBI reality-check card beside your F&O results.",
    ],
    watchOut: "A per-trade cap or daily stop never configured is not replaced by a default; that component drops out of the score.",
    related: ["/reports/edge-clinic", "/review", "/playbooks", "/settings"],
  },
  "/reports/tax": {
    steps: [
      "Choose the tax person when the All-accounts view holds more than one.",
      "Read realised results by head and by month, at the rate for each sell date.",
      "Enter per-share FMV for grandfathering, and any brought-forward losses from before the journal.",
      "Read the loss ledger's carry-forward vintages and dividend TDS by company.",
    ],
    watchOut: "The scope is one tax person across every account carrying that identity, not the selected account alone.",
    related: ["/reports/itr", "/reports/advance-tax", "/reports/harvest", "/reports/ais"],
    screenshot: "reports-tax",
  },
  "/reports/itr": {
    steps: [
      "Read the head-wise segregation and the ICAI Guidance Note turnover.",
      "Read the 44AB / 44AD audit read for the year.",
      "Export the schedule line items: CG, BP and CFL in the return's own item codes.",
    ],
    watchOut:
      "STT is excluded from capital-gains deductions but allowed as a business expense, so Schedule CG reads higher than net P&L elsewhere.",
    related: ["/reports/tax", "/reports/advance-tax", "/reports/ais"],
  },
  "/reports/ais": {
    steps: [
      "Paste your AIS or Form 26AS rows.",
      "Read each row reconciled against the journal's dividends, TDS and equity sales.",
      "Work through the differences between the AIS and journal columns.",
    ],
    watchOut: "Only the rows you paste are compared; nothing is fetched from the tax department.",
    related: ["/reports/tax", "/cash", "/reports/reconcile"],
  },
  "/audit": {
    steps: [
      "Filter the log by category.",
      "Read each change with its before and after snapshot.",
      "Find a deleted trade's full row here after the delete.",
    ],
    watchOut: "After a delete this log holds the only in-app record of the trade; its notes, tags and attachments went with it.",
    related: ["/trades", "/backup"],
  },
  "/data-quality": {
    steps: [
      "Read the confidence score and the open issue groups.",
      "Start with Critical issues, which change money; info issues affect coverage.",
      "Follow an issue's route to fix it, such as Open in Trades or Open Import.",
      "Fix duplicate and stale-lot issues in place where the screen offers it.",
    ],
    watchOut: "A figure elsewhere can look normal while an issue here says it cannot be trusted yet.",
    related: ["/trades", "/import", "/instruments"],
  },
  "/rule-packs": {
    steps: [
      "Read the active pack's SEBI derivatives rules and broker-rate assumptions.",
      "Check each rule's effective date, source URL, version and review date.",
      "Press Mark source reviewed once a source has been checked.",
    ],
    watchOut: "The compliance radar reads the active pack, not hard-coded copy, so a stale pack is what the radar runs on.",
    related: ["/settings", DISCIPLINE],
  },
  "/backup": {
    steps: [
      "Export a complete versioned backup of every table and attachment.",
      "Type a password of 8 or more characters to encrypt it, or leave it blank.",
      "To restore, pick a backup and read the preview before anything is replaced.",
      "Find the snapshots saved before a delete under Deleted items.",
    ],
    watchOut: "Restore replaces all current data; it is atomic, so any failure leaves the journal exactly as it was.",
    related: ["/lenses", "/audit", "/settings"],
  },
  "/aliases": {
    steps: [
      "Enter the broker's scrip name, such as ADANI TOTAL GAS LIMITED.",
      "Enter the ticker it maps to, such as ATGL, with an optional note.",
      "Delete an alias from the mappings table when it no longer applies.",
    ],
    watchOut: "An alias makes every report treat two names as one instrument, so a wrong mapping merges two companies.",
    related: ["/instruments", "/import"],
  },
  "/instruments": {
    steps: [
      "Fill sectors from the bundled NSE map or from an NSE file.",
      "Add or edit an instrument's name, ISIN, sector and lot size.",
      "Read the stored bhavcopy history, which Portfolio Risk's Auto-MTM from bhavcopy builds up.",
      "Check the as-of date and sha256 shown for each bundled map.",
    ],
    watchOut: "A sector you tagged yourself is never overwritten by a bundled map fill.",
    related: ["/atlas", "/aliases", SETUPS, "/risk"],
    screenshot: "instruments",
  },
  "/settings": {
    steps: [
      "Set capital buckets, risk limits and the charge and margin rate tables.",
      "Choose theme, accent skin and colorblind-safe mode.",
      "Pick the Live Desk price source under Live feed.",
      "Switch OpenAlgo on under Integrations after reading and accepting its disclosure.",
      "Return to My Default Settings in one click.",
    ],
    watchOut: "Restoring My Default Settings resets preferences and the margin and risk tables; trades and journal data are never part of it.",
    related: ["/live", "/import", "/backup", "/rule-packs"],
    screenshot: "settings",
  },
  "/help": {
    steps: [
      "Search by what you are trying to do, such as stop loss, tax or delete.",
      "Open a topic for its steps, what goes wrong and what the screen will not do.",
      "Follow the topic's link to open that screen.",
    ],
    watchOut: "Each screen's refusals are design, not missing features, and they are listed under What it will not do.",
    related: ["/import-help"],
  },
};
