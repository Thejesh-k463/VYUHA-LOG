export type QualitySeverity = "critical" | "warning" | "info";

export interface QualityIssue {
  code: string;
  severity: QualitySeverity;
  title: string;
  detail: string;
  count: number;
  href: string;
  ids?: number[];
}

export interface QualityTrade {
  id: number;
  isOpen: boolean;
  acquisition: string | null;
  acquisitionPrice: number | null;
  closingPrice: number | null;
  slPlanned: number | null;
  riskAmount: number | null;
  segment: string;
  mtfFundedAmount: number | null;
  instrumentType: string;
  expiry: string | null;
  strike: number | null;
  optionType: string | null;
  symbol: string;
}

/**
 * One broker identity (the client id / API key that names the CLIENT, never
 * the rotating token) found on connections in more than one account.
 *
 * `maskedIdentity` is masked BY THE CALLER — the plaintext identifier never
 * reaches this module, is never put in an issue's title or detail, and is
 * never written to the audit log. What the user sees here is the same masked
 * form the Import screen already shows beside the stored key.
 */
export interface DuplicateConnectionGroup {
  broker: string;
  /** Display label for `broker` ("Dhan", "Angel One", "OpenAlgo (Zerodha)"). */
  brokerLabel: string;
  maskedIdentity: string;
  accounts: { id: number; name: string }[];
}

/**
 * Trade rows sharing one `(broker, dedupHash)` in more than one account.
 *
 * The dedup hash carries NO account id (lib/import/dedup.ts) and the unique
 * index that enforces it is per account (`trades_account_broker_dedup_uq`), so
 * the same broker record imported into two accounts is stored twice and both
 * copies are counted by the All-accounts view.
 */
export interface DuplicateTradeGroup {
  broker: string;
  brokerLabel: string;
  dedupHash: string;
  symbol: string;
  /**
   * The record's own quantity, or NULL when no row in the group still states
   * it — every copy was merged into a lot by an auto-close, and a merged row's
   * quantity belongs to the lot, not to this record. Rendered "—" (invariant 6:
   * a figure nothing states is never borrowed from a different execution).
   */
  qty: number | null;
  buyDate: string | null;
  sellDate: string | null;
  /** Trade rows in the group, across every account holding it. */
  rows: number;
  /** The row ids, for `affected`. */
  ids: number[];
  /**
   * One entry per account holding the group. `removable` is the ONLY thing the
   * screen and the server action may act on — see `isPlainDuplicateCopy`.
   */
  accounts: { id: number; name: string; rows: number; removable: boolean }[];
}

/**
 * A stored row's IDENTITY, as the duplicate scan needs to weigh it (M-5).
 *
 * A row can stand for more than one broker record: an auto-close (R5) folds an
 * incoming execution into the open lot it closed, so the surviving row keeps
 * its own dedup hash AND carries the consumed execution's hash as an alias
 * (`lotIdentityHashes` in lib/import/close-open-lots.ts). Grouping on the own
 * hash alone therefore MISSES a duplicate; deleting on it alone destroys a
 * merged lot.
 */
export interface DuplicateRowIdentity {
  /** Every hash that stands for this row: its OWN first, then its aliases. */
  identityHashes: readonly string[];
  /** True when an auto-close assembled or reduced this row. */
  autoClosed: boolean;
}

/**
 * MAY THIS ROW BE REMOVED as one account's copy of `groupHash`? (M-5, ruling
 * 2026-09-10 — only PLAIN copies get the button; a merged lot is never
 * removable.)
 *
 * Three clauses, and each one alone is enough to refuse:
 *
 *  1. The row's OWN hash is the group hash. A row that joins the group only
 *     through an alias is some OTHER record here; its own record is elsewhere.
 *  2. It carries no aliases. A row with an alias stands for two broker records
 *     at once, and only one of them is the duplicate — deleting the row deletes
 *     the other as well.
 *  3. No auto-close touched it. Clause 2 already catches every alias an
 *     auto-close writes; this clause is stated separately because the alias
 *     derivation is best-effort by construction, and a row the importer MARKED
 *     as merged is not a plain single-source row whatever its hashes say.
 *
 * A group with no plain copy is reported and linked, never offered a delete —
 * `NO_PLAIN_COPY_NOTE`.
 */
export function isPlainDuplicateCopy(row: DuplicateRowIdentity, groupHash: string): boolean {
  const [own, ...aliases] = row.identityHashes;
  return own === groupHash && aliases.length === 0 && !row.autoClosed;
}

/**
 * What a cross-account duplicate group says when NO copy of it is plain.
 * Descriptive only (SEBI copy rule): it states what the rows are and where the
 * duplicate pull itself is ended, and offers nothing destructive.
 */
export const NO_PLAIN_COPY_NOTE =
  "No copy of this record stands alone: each one also carries an execution that closed a position in its own book, so removing one would delete that record too. The duplicate pull itself ends at Import → Disconnect.";

export interface QualityInputs {
  trades: QualityTrade[];
  markedTradeIds: Set<number>;
  knownSymbols: Set<string>;
  ipoLinkedTradeIds: Set<number>;
  staleMtmCount: number;
  missingAttachmentFiles: number;
  /**
   * Cross-account facts, resolved by a DB reader (lib/import/broker-identity.ts).
   * Optional: they span every account by definition, so a caller that has not
   * read them yet gets exactly the report it got before.
   */
  duplicateConnections?: DuplicateConnectionGroup[];
  duplicateTradeGroups?: DuplicateTradeGroup[];
}

export interface QualityReport {
  score: number;
  issues: QualityIssue[];
  affected: number;
  checked: number;
}

/** Where both cross-account issues send the user: the section that can fix them. */
export const DUPLICATES_HREF = "/data-quality#duplicates";

/** "A", "A and B", "A, B and C" — account names read as a sentence. */
function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The two CROSS-ACCOUNT issues (v4.2.1).
 *
 * Both are facts about more than one account at once, which is why they are
 * resolved outside this module and handed in already masked and already
 * grouped. One issue per duplicated identity, and one per duplicated
 * `(broker, dedupHash)` group — a group is the unit a user can actually fix,
 * so ten shared rows are ten issues only if they are ten different records.
 *
 * Severity follows the file's own rule — "critical" is reserved for gaps that
 * change MONEY. Duplicated TRADE rows already do: the All-accounts view sums
 * both copies, so P&L, turnover and expectancy are all overstated today. A
 * duplicated CONNECTION has not changed a number yet; it is the configuration
 * that produces the duplicates at the next pull, so it is a warning.
 */
export function crossAccountIssues(i: Pick<QualityInputs, "duplicateConnections" | "duplicateTradeGroups">): QualityIssue[] {
  const out: QualityIssue[] = [];

  for (const g of i.duplicateConnections ?? []) {
    if (g.accounts.length < 2) continue;
    out.push({
      code: `duplicate_connection:${g.broker}:${g.accounts.map((a) => a.id).join("-")}`,
      severity: "warning",
      title: `Same ${g.brokerLabel} client connected in ${g.accounts.length} accounts`,
      detail: `${g.brokerLabel} ${g.maskedIdentity} is connected in ${nameList(g.accounts.map((a) => a.name))}. A pull from any of them brings the same trades into each book.`,
      count: g.accounts.length,
      href: DUPLICATES_HREF,
      ids: [],
    });
  }

  for (const g of i.duplicateTradeGroups ?? []) {
    if (g.accounts.length < 2) continue;
    const when = g.sellDate ?? g.buyDate;
    out.push({
      code: `duplicate_trades:${g.broker}:${g.dedupHash.slice(0, 12)}`,
      severity: "critical",
      title: `${g.symbol} held in ${g.accounts.length} accounts as the same ${g.brokerLabel} record`,
      detail: `${g.rows} rows carry one ${g.brokerLabel} record (${g.qty ?? "—"} × ${g.symbol}${when ? `, ${when}` : ""}) in ${nameList(g.accounts.map((a) => a.name))}. The All-accounts view counts every copy.`,
      count: g.rows,
      href: DUPLICATES_HREF,
      ids: g.ids.slice(0, 100),
    });
  }

  return out;
}

const ISSUE_WEIGHT = { critical: 12, warning: 6, info: 2 } as const;

/** The completeness score for a set of issues. Capped per issue so one gap
 *  cannot swamp the whole score, and floored at 0. */
export function scoreIssues(issues: QualityIssue[]): number {
  const penalty = issues.reduce((s, x) => s + Math.min(30, x.count * ISSUE_WEIGHT[x.severity]), 0);
  return Math.max(0, 100 - penalty);
}

export function assessDataQuality(i: QualityInputs): QualityReport {
  const issues: QualityIssue[] = [];
  const add = (issue: QualityIssue, ids: number[] = []) => { if (issue.count > 0) issues.push({ ...issue, ids: ids.slice(0, 100) }); };

  const basis = i.trades.filter((t) => t.acquisition != null && (!t.acquisitionPrice || t.acquisitionPrice <= 0));
  add({ code: "unknown_basis", severity: "critical", title: "Unknown acquisition cost", detail: "These sales cannot produce trustworthy P&L, tax, expectancy, or ROM until their basis is confirmed.", count: basis.length, href: "/trades?basis=unknown" }, basis.map((t) => t.id));

  // EQUITY ONLY, and the exclusion is the fix for a real dead end (v4.2).
  //
  // This counted every open DERIVATIVE as an unmarked position and sent the
  // user to /equity to fix it — where a typed mark for a contract is REFUSED:
  // `mtm_prices` is keyed on the SYMBOL, `getMtmMap()` reads mtm[symbol] first,
  // and M1 (`lib/quotes/persist-mark.ts`, `isCashKey()`) skips derivative rows
  // for exactly that reason, so a contract mark would price the cash position
  // at the option's price. An issue nobody can clear is a permanent score
  // penalty and a permanently red card; the honest report is that this check
  // is about cash positions, until a mark store keyed on the traded contract
  // exists. Option contract COMPLETENESS is still checked, below.
  const unmarked = i.trades.filter(
    (t) => t.isOpen && t.instrumentType === "equity" && !(t.closingPrice && t.closingPrice > 0) && !i.markedTradeIds.has(t.id),
  );
  add({ code: "unmarked_open", severity: "critical", title: "Open positions without a mark", detail: "Unrealised P&L and live risk are incomplete for these positions.", count: unmarked.length, href: "/equity" }, unmarked.map((t) => t.id));

  const unstopped = i.trades.filter((t) => t.isOpen && (t.slPlanned == null || t.riskAmount == null));
  add({ code: "missing_stop", severity: "warning", title: "Open positions without complete risk", detail: "Set both a stop and risk amount so limit, R and cockpit calculations reconcile.", count: unstopped.length, href: "/trades?view=open" }, unstopped.map((t) => t.id));

  const mtf = i.trades.filter((t) => t.segment === "eq_mtf" && (!t.mtfFundedAmount || t.mtfFundedAmount <= 0));
  add({ code: "mtf_funding", severity: "warning", title: "MTF positions without funded principal", detail: "Interest, leverage and own-capital return need the broker-funded amount.", count: mtf.length, href: "/equity?funding=mtf" }, mtf.map((t) => t.id));

  const options = i.trades.filter((t) => t.instrumentType === "option" && (!t.expiry || t.strike == null || !t.optionType));
  add({ code: "option_contract", severity: "warning", title: "Incomplete option contracts", detail: "Expiry, strike and CE/PE are required for Greeks, settlement and seller analytics.", count: options.length, href: "/trades" }, options.map((t) => t.id));

  const instrument = i.trades.filter((t) => !i.knownSymbols.has(t.symbol.toUpperCase()));
  add({ code: "instrument_master", severity: "info", title: "Symbols absent from instrument master", detail: "Sector, lot-size and concentration coverage may be incomplete.", count: new Set(instrument.map((t) => t.symbol)).size, href: "/instruments" }, instrument.map((t) => t.id));

  const ipo = i.trades.filter((t) => t.acquisition === "ipo" && !i.ipoLinkedTradeIds.has(t.id));
  add({ code: "ipo_link", severity: "warning", title: "IPO holdings not linked to an IPO record", detail: "Linking makes allotment basis, listing mark and exit flow from one source of truth.", count: ipo.length, href: "/ipos" }, ipo.map((t) => t.id));

  add({ code: "stale_mtm", severity: "info", title: "Stale MTM marks", detail: "Refresh or confirm prices before relying on unrealised P&L and breach alerts.", count: i.staleMtmCount, href: "/risk" });
  add({ code: "missing_attachment", severity: "warning", title: "Attachment records with missing files", detail: "The journal points to images that are no longer present on disk.", count: i.missingAttachmentFiles, href: "/backup" });

  // Cross-account issues last: they are facts about the accounts, not about
  // the trades this call was handed, and a caller that resolved none is left
  // with exactly the report it had before.
  for (const issue of crossAccountIssues(i)) issues.push(issue);

  return { score: scoreIssues(issues), issues, affected: new Set(issues.flatMap((x) => x.ids ?? [])).size, checked: i.trades.length };
}
