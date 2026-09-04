import "server-only";
import { eq } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import { advanceTaxChallans, instruments, playbooks, symbolAliases, tradingSessions } from "@/lib/db/schema";
import { getEntitlement } from "@/lib/queries/license";
import { taxonomyByIsin } from "@/lib/analytics/instruments";
import { HELP_ENTRIES } from "@/lib/domain/help-content";
import { NAV_ITEMS } from "@/components/layout/nav-config";
import isinSymbols from "@/lib/data/isin-symbols.json";
import type { ListingTuple } from "@/lib/import/isin-symbol";
import { ftsMatch, minTrigram, rankCandidates, type Candidate } from "@/lib/domain/search-rank";
import { lockForSource, RESULT_CAP, SOURCE_KEYS, SOURCES, type SearchResult, type SourceKey } from "@/lib/domain/search-scope";

/**
 * SEARCH v1 (v3.8) — the fan-out behind /api/search.
 *
 * ── Trades are IDS ONLY, and this module never orders the trades table ──────
 *
 * `/trades` filters CLIENT-SIDE over a `SlimTrade[]` payload that carries its
 * own ORDER BY (sell_date, created_at). Every figure on that page is a float
 * sum in that order; a server query that re-ordered ties would move the sums.
 * So the trade side of a search is ONE FTS5 query, ordered by FTS `rank`
 * (relevance — a property of the index, not of `trades`), joined to
 * `trades.account_id` purely to SCOPE it, and it hands back ids plus the few
 * columns a deep-link needs. It never imports lib/queries/trades.ts and its
 * SQL contains no ORDER BY on a trades column — tests/search-query.test.ts
 * greps this file for both.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 *
 * Every reader takes `(q, accountId)`; the account-scoped ones (registry
 * `scope: "account"`) apply `accountId > 0 ? filter : all` — invariant 8. The
 * route resolves the id through getSelectedAccountId(); nothing here reads
 * settings. tests/search-scope-guard.test.ts joins the registry against the
 * schema's `account_id` columns and proves each scoped reader really filters.
 *
 * ── Gating ──────────────────────────────────────────────────────────────────
 *
 * Results are never hidden. `lockForSource` marks a help entry or a screen as
 * locked when the screen it opens is on PRO_FEATURES and the entitlement is
 * not Pro; a user's own rows never lock (invariant 7).
 */

// ---------------------------------------------------------------------------
// Trades — FTS5, ids only
// ---------------------------------------------------------------------------

interface TradeHit {
  id: number;
  symbol: string;
  buyDate: string | null;
  sellDate: string | null;
  setupTag: string | null;
}

/**
 * One statement, ordered by the index's own `rank`. `@account = 0` short-circuits
 * the account filter for the All-accounts view. Prepared once per connection.
 */
const TRADE_FTS_SQL =
  "SELECT trades_fts.rowid AS id, trades.symbol AS symbol, trades.buy_date AS buyDate, trades.sell_date AS sellDate, trades.setup_tag AS setupTag " +
  "FROM trades_fts JOIN trades ON trades.id = trades_fts.rowid " +
  "WHERE trades_fts MATCH @match AND (@account = 0 OR trades.account_id = @account) " +
  `ORDER BY rank LIMIT ${RESULT_CAP}`;

let tradeStmt: ReturnType<typeof sqlite.prepare> | null = null;

function tradeHits(q: string, accountId: number): TradeHit[] {
  const match = ftsMatch(q);
  if (!match) return [];
  tradeStmt ??= sqlite.prepare(TRADE_FTS_SQL);
  return tradeStmt.all({ match, account: accountId > 0 ? accountId : 0 }) as TradeHit[];
}

/**
 * The ids of the selected account's trades that match `q`, best first.
 * `accountId` 0 = every account. Empty when no token reaches the trigram
 * minimum — the caller's in-memory prefix search is the answer then.
 */
export function searchTradeIds(q: string, accountId: number): number[] {
  if (!minTrigram(q)) return [];
  return tradeHits(q, accountId).map((h) => h.id);
}

const enc = encodeURIComponent;

/** `/trades?symbol=…&from=…&to=…` — the deep-link keys the Trades page honours. */
function tradeHref(h: { symbol: string; buyDate: string | null; sellDate: string | null }): string {
  const dates = [h.buyDate, h.sellDate].filter((d): d is string => !!d).sort();
  let href = `/trades?symbol=${enc(h.symbol)}`;
  if (dates.length) href += `&from=${enc(dates[0])}&to=${enc(dates[dates.length - 1])}`;
  return href;
}

function readTrades(q: string, accountId: number): SearchResult[] {
  return tradeHits(q, accountId).map((h) => ({
    source: "trades",
    id: h.id,
    title: h.symbol,
    subtitle: [h.sellDate ?? h.buyDate ?? "open", h.setupTag].filter(Boolean).join(" · ") || undefined,
    href: tradeHref(h),
    locked: false,
  }));
}

// ---------------------------------------------------------------------------
// Symbols — the bundled listing snapshot (+ sector taxonomy as the subtitle)
// ---------------------------------------------------------------------------

interface SymbolCandidate extends Candidate {
  id: string; // ISIN
  ticker: string;
  name: string | null;
  bseCode: string | null;
}

let symbolCandidates: SymbolCandidate[] | null = null;

function symbolList(): SymbolCandidate[] {
  if (symbolCandidates) return symbolCandidates;
  const byIsin = (isinSymbols as unknown as { byIsin?: Record<string, ListingTuple> }).byIsin ?? {};
  symbolCandidates = Object.entries(byIsin).map(([isin, t]) => ({
    id: isin,
    label: t[0],
    ticker: t[0],
    name: t[1] || null,
    bseCode: t[3] || null,
  }));
  return symbolCandidates;
}

function sectorLine(isin: string): string | null {
  const tx = taxonomyByIsin(isin);
  if (!tx) return null;
  return [tx.macro, tx.sector, tx.industry].filter(Boolean).join(" · ") || null;
}

function readSymbols(q: string, _accountId: number): SearchResult[] {
  return rankCandidates(q, symbolList(), RESULT_CAP).map(({ candidate: c }) => ({
    source: "symbols",
    id: c.id,
    title: c.ticker,
    subtitle: [c.name, sectorLine(c.id), c.bseCode ? `BSE ${c.bseCode}` : null].filter(Boolean).join(" · ") || undefined,
    href: `/trades?symbol=${enc(c.ticker)}`,
    locked: false,
  }));
}

// ---------------------------------------------------------------------------
// Playbooks / instruments (+ aliases) — global tables, ranked in memory
// ---------------------------------------------------------------------------

function readPlaybooks(q: string, _accountId: number): SearchResult[] {
  const rows = db.select({ id: playbooks.id, name: playbooks.name, description: playbooks.description, rules: playbooks.rules }).from(playbooks).all();
  const cands = rows.map((r) => ({ id: r.id, label: r.name, name: r.description, keywords: r.rules ?? [] }));
  return rankCandidates(q, cands, RESULT_CAP).map(({ candidate: c }) => ({
    source: "playbooks",
    id: c.id,
    title: c.label,
    subtitle: c.name ?? undefined,
    href: "/playbooks",
    locked: false,
  }));
}

function readInstruments(q: string, _accountId: number): SearchResult[] {
  const rows = db.select({ id: instruments.id, symbol: instruments.symbol, name: instruments.name, isin: instruments.isin, sector: instruments.sector }).from(instruments).all();
  const aliases = db.select({ id: symbolAliases.id, alias: symbolAliases.alias, ticker: symbolAliases.ticker, note: symbolAliases.note }).from(symbolAliases).all();
  const cands: (Candidate & { href: string; subtitle?: string })[] = [
    ...rows.map((r) => ({
      id: `instrument:${r.id}`,
      label: r.symbol,
      ticker: r.symbol,
      name: r.name,
      keywords: [r.isin ?? "", r.sector ?? ""],
      href: `/trades?symbol=${enc(r.symbol)}`,
      subtitle: [r.name, r.sector].filter(Boolean).join(" · ") || undefined,
    })),
    ...aliases.map((a) => ({
      id: `alias:${a.id}`,
      label: a.alias,
      ticker: a.ticker,
      name: a.alias,
      keywords: [a.note ?? ""],
      href: `/trades?symbol=${enc(a.ticker)}`,
      subtitle: `alias of ${a.ticker}`,
    })),
  ];
  return rankCandidates(q, cands, RESULT_CAP).map(({ candidate: c }) => ({
    source: "instruments",
    id: c.id,
    title: c.label,
    subtitle: c.subtitle,
    href: c.href,
    locked: false,
  }));
}

// ---------------------------------------------------------------------------
// Sessions / challans — account-scoped tables
// ---------------------------------------------------------------------------

function readSessions(q: string, accountId: number): SearchResult[] {
  const base = db
    .select({
      id: tradingSessions.id,
      sessionDate: tradingSessions.sessionDate,
      thesis: tradingSessions.thesis,
      reviewNotes: tradingSessions.reviewNotes,
      plannedSymbols: tradingSessions.plannedSymbols,
      status: tradingSessions.status,
    })
    .from(tradingSessions);
  const rows = (accountId > 0 ? base.where(eq(tradingSessions.accountId, accountId)) : base).all();
  const cands = rows.map((r) => ({
    id: r.id,
    label: r.sessionDate,
    name: r.thesis,
    keywords: [...(r.plannedSymbols ?? []), r.reviewNotes ?? "", r.status],
    subtitle: [r.status, r.thesis].filter(Boolean).join(" · ") || undefined,
  }));
  return rankCandidates(q, cands, RESULT_CAP).map(({ candidate: c }) => ({
    source: "sessions",
    id: c.id,
    title: `Session ${c.label}`,
    subtitle: c.subtitle,
    href: "/sessions",
    locked: false,
  }));
}

function readChallans(q: string, accountId: number): SearchResult[] {
  const base = db
    .select({
      id: advanceTaxChallans.id,
      fy: advanceTaxChallans.fy,
      paidOn: advanceTaxChallans.paidOn,
      bsrCode: advanceTaxChallans.bsrCode,
      challanSerial: advanceTaxChallans.challanSerial,
      note: advanceTaxChallans.note,
    })
    .from(advanceTaxChallans);
  const rows = (accountId > 0 ? base.where(eq(advanceTaxChallans.accountId, accountId)) : base).all();
  const cands = rows.map((r) => ({
    id: r.id,
    label: `${r.fy} · ${r.paidOn}`,
    name: r.note,
    keywords: [r.fy, r.paidOn, r.bsrCode ?? "", r.challanSerial ?? ""],
    subtitle: [r.challanSerial ? `serial ${r.challanSerial}` : null, r.bsrCode ? `BSR ${r.bsrCode}` : null, r.note].filter(Boolean).join(" · ") || undefined,
  }));
  return rankCandidates(q, cands, RESULT_CAP).map(({ candidate: c }) => ({
    source: "challans",
    id: c.id,
    title: `Challan ${c.label}`,
    subtitle: c.subtitle,
    href: "/reports/advance-tax",
    locked: false,
  }));
}

// ---------------------------------------------------------------------------
// Ledger / audit — FTS5 (migration 0061), ids only
// ---------------------------------------------------------------------------
//
// Same shape as the trades source above and for the same reasons: ONE
// statement per source, ordered by the index's own `rank`, capped, handing
// back ids plus the few columns a row needs to describe itself. Neither
// statement orders a base-table column, so neither can move a figure on the
// screen it links to.
//
// SCOPE. `ledger_fts` declares no `account_id` (an index is not a place data
// lives — 0061 says so), so the filter is a JOIN back to `ledger_entries`,
// with the same `@account = 0` short-circuit the trades statement uses.
// `audit_log` has no account column at all, so `audit_fts` has nothing to
// scope by — global, by the shape of the table.

interface LedgerHit {
  id: number;
  date: string;
  type: string;
  bucket: string | null;
  symbol: string | null;
  note: string | null;
}

const LEDGER_FTS_SQL =
  "SELECT ledger_fts.rowid AS id, ledger_entries.date AS date, ledger_entries.type AS type, " +
  "ledger_entries.bucket AS bucket, ledger_entries.symbol AS symbol, ledger_entries.note AS note " +
  "FROM ledger_fts JOIN ledger_entries ON ledger_entries.id = ledger_fts.rowid " +
  "WHERE ledger_fts MATCH @match AND (@account = 0 OR ledger_entries.account_id = @account) " +
  `ORDER BY rank LIMIT ${RESULT_CAP}`;

let ledgerStmt: ReturnType<typeof sqlite.prepare> | null = null;

function readLedger(q: string, accountId: number): SearchResult[] {
  const match = ftsMatch(q);
  if (!match) return [];
  ledgerStmt ??= sqlite.prepare(LEDGER_FTS_SQL);
  const rows = ledgerStmt.all({ match, account: accountId > 0 ? accountId : 0 }) as LedgerHit[];
  return rows.map((h) => ({
    source: "ledger",
    id: h.id,
    // The ledger is a list of money movements, so the TYPE and the date are
    // what identify a row; the note is the detail underneath it.
    title: `${h.type} · ${h.date}`,
    subtitle: [h.symbol, h.note, h.bucket || null].filter(Boolean).join(" · ") || undefined,
    // /cash reads no search parameters (checked 2026-09-04), so a deep link
    // would be a URL the screen ignores — worse than no link, because it
    // looks like a filter that silently did not apply.
    href: "/cash",
    locked: false,
  }));
}

interface AuditHit {
  id: number;
  ts: string;
  entity: string;
  action: string;
  summary: string | null;
}

const AUDIT_FTS_SQL =
  "SELECT audit_fts.rowid AS id, audit_log.ts AS ts, audit_log.entity AS entity, " +
  "audit_log.action AS action, audit_log.summary AS summary " +
  "FROM audit_fts JOIN audit_log ON audit_log.id = audit_fts.rowid " +
  "WHERE audit_fts MATCH @match " +
  `ORDER BY rank LIMIT ${RESULT_CAP}`;

let auditStmt: ReturnType<typeof sqlite.prepare> | null = null;

/** Global: `audit_log` has no account_id, so `accountId` is accepted and unused. */
function readAudit(q: string, _accountId: number): SearchResult[] {
  const match = ftsMatch(q);
  if (!match) return [];
  auditStmt ??= sqlite.prepare(AUDIT_FTS_SQL);
  const rows = auditStmt.all({ match }) as AuditHit[];
  return rows.map((h) => ({
    source: "audit",
    id: h.id,
    title: `${h.entity} ${h.action}`,
    subtitle: [h.ts.slice(0, 16).replace("T", " "), h.summary].filter(Boolean).join(" · ") || undefined,
    href: "/audit",
    locked: false,
  }));
}

// ---------------------------------------------------------------------------
// Help / screens — static registries
// ---------------------------------------------------------------------------

const HELP_CANDIDATES: (Candidate & { href: string; answers: string })[] = HELP_ENTRIES.map((e) => ({
  id: e.href,
  label: e.title,
  name: e.answers,
  keywords: e.keywords,
  href: e.href,
  answers: e.answers,
}));

function readHelp(q: string, _accountId: number): SearchResult[] {
  return rankCandidates(q, HELP_CANDIDATES, RESULT_CAP).map(({ candidate: c }) => ({
    source: "help",
    id: c.id,
    title: c.label,
    subtitle: c.answers,
    href: c.href,
    locked: false,
  }));
}

const SCREEN_CANDIDATES: (Candidate & { href: string; group: string })[] = NAV_ITEMS.map((n) => ({
  id: n.href,
  label: n.label,
  keywords: [n.group],
  href: n.href,
  group: n.group,
}));

function readScreens(q: string, _accountId: number): SearchResult[] {
  return rankCandidates(q, SCREEN_CANDIDATES, RESULT_CAP).map(({ candidate: c }) => ({
    source: "screens",
    id: c.id,
    title: c.label,
    subtitle: c.group,
    href: c.href,
    locked: false,
  }));
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

/** Every reader takes the account id, whether or not its source is scoped. */
export type SourceReader = (q: string, accountId: number) => SearchResult[];

/** One reader per registry key. The scope guard test calls these directly. */
export const SOURCE_READERS: Readonly<Record<SourceKey, SourceReader>> = {
  trades: readTrades,
  symbols: readSymbols,
  playbooks: readPlaybooks,
  instruments: readInstruments,
  sessions: readSessions,
  challans: readChallans,
  ledger: readLedger,
  help: readHelp,
  screens: readScreens,
  audit: readAudit,
};

export interface SearchAllOptions {
  /** 0 = every account. Resolved by the caller via getSelectedAccountId(). */
  accountId: number;
  /** Which sources to fan out to; every source when omitted. */
  categories?: readonly SourceKey[];
  /** Tests pass one; the route lets getEntitlement() answer. */
  entitlement?: { pro: boolean };
}

export function searchAll(q: string, opts: SearchAllOptions): { results: SearchResult[]; tookMs: number } {
  const t0 = performance.now();
  const query = String(q ?? "").trim();
  const keys = opts.categories ?? SOURCE_KEYS;
  const results: SearchResult[] = [];
  // The account id is the one input here that can silently WIDEN a search.
  // Every scoped reader spells the rule `accountId > 0 ? filter : all`, so a
  // NaN, a float, a negative or an undefined would fall through to "all
  // accounts" and merge two books into one result list with nothing on screen
  // looking wrong (invariant 8). Only a non-negative integer is an account
  // selection; anything else means NO ROWS from the scoped sources, never
  // every row. 0 remains the deliberate "All accounts" view.
  const accountId = Number.isInteger(opts.accountId) && opts.accountId >= 0 ? opts.accountId : null;
  if (query) {
    const entitlement = opts.entitlement ?? getEntitlement();
    for (const key of keys) {
      if (accountId == null && SOURCES[key].scope === "account") continue;
      for (const r of SOURCE_READERS[key](query, accountId ?? 0).slice(0, RESULT_CAP)) {
        const lock = lockForSource(key, r.href, entitlement);
        results.push(lock.locked ? { ...r, locked: true, unlocks: lock.unlocks } : { ...r, locked: false });
      }
    }
  }
  return { results, tookMs: performance.now() - t0 };
}
