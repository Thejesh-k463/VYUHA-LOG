import { expect } from "vitest";
import { tradeRow, type TempDb } from "./temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";

/**
 * THE COUNTED-ONCE ORACLE FIXTURE (v4.3.0 wave 3, guard G1).
 *
 * One seeded book that every identity / IPO / tax / capital change must pass:
 * over it, every realised SALE is counted EXACTLY ONCE in EVERY consumer and
 * EVERY view. `tests/oracle-counted-once.test.ts` is the guard; this file is
 * the book it is stated over, exported so a later guard can reuse the same
 * fixture rather than grow a second one that drifts.
 *
 * WHY: wave 2H/2I/2L's findings were all one shape — a value WRITTEN in one
 * file and READ differently in another (the counted-once rule split across
 * lib/queries/capital.ts and lib/queries/tax-itr.ts; the funded-0 readers), or
 * a stateful sequence nobody enumerated (delete -> restore -> merge; sync ->
 * rate edit -> exit edit). A per-file unit test cannot see either. An oracle
 * that reads SIX consumers in THREE views off ONE book can.
 *
 * ── WHAT IS A LITERAL, AND WHAT IS MEASURED ─────────────────────────────────
 *
 * Every trade row is inserted with its money stated (buyValue, sellValue,
 * grossPnl, chargesTotal, netPnl), so every trade-side expectation below is
 * arithmetic on the fixture's own numbers and is written out in a comment.
 *
 * The IPO rows are NOT: `computeIpo` prices an exit through the real charges
 * engine and `charge_config` (invariant 3), and re-implementing that here
 * would be a test that agrees with itself. So the fixture separates the two
 * questions deliberately:
 *
 *   - WHICH rows count in which view is the fixture's own statement (literal
 *     name sets, per view — that is the rule under test);
 *   - WHAT one IPO row is worth is read ONCE from the IPO book (`ipoNet`), and
 *     `assertLiveFixture` pins its GROSS — pure fixture arithmetic — and pins
 *     that it differs from every trade net, so no assertion below can pass by
 *     coincidence.
 *
 * ── THE BOOK ────────────────────────────────────────────────────────────────
 *
 * Account 1 (the seeded default) and account 2. Dates are all inside FY
 * 2025-26 (buy 2025-06-10, sell 2025-09-20) so the AIS and tax-by-FY figures
 * are one bucket each and a miscount cannot hide in a second year.
 *
 *  account 1
 *   A1SOLD1   closed   10 @100 -> 10 @150   gross 500   charges  9.75  net  490.25
 *   A1SOLD2   closed   20 @50  -> 20 @60    gross 200   charges  8.00  net  192.00
 *   A1OPEN    open     30 @100                                          net    0.00
 *   A1PART    open    100 @10  -> 60 @12    gross 120   charges  5.00  net  115.00
 *                     (partly closed: the realised consumers all skip it while
 *                      it is open — `closePosition` on it is a state-machine op)
 *   A1MTFZ    open eq_mtf 100 @100, mtf_funded_amount STATED 0  (100% own capital)
 *   A1MTFN    open eq_mtf 100 @100, mtf_funded_amount NULL      (states nothing)
 *   A1STG     open, staged, 2 entry legs + 1 exit leg; parent holds the
 *                     aggregate (invariant 5) 100 @20 -> 40 @25  net 194.00
 *                     From v4.5.0 wave 3b-ii the BOOKED FILL is realised in the
 *                     FY of its own exit date: one row, 196.67 (see the fixture
 *                     for the arithmetic). The parent row stays open.
 *   A1JOIN    closed  100 @200 -> 100 @250  gross 5000  charges 30.00  net 4970.00
 *                     carrying `dedup-alias:<hash>` — the Data Quality join's
 *                     shape; the SALE that hash names sits in Trash (deleted
 *                     through the real `deleteTradesByIds`).
 *
 *  account 2
 *   A2SOLD    closed   10 @100 -> 10 @150   gross 500   charges  9.75  net  490.25
 *   A2IPOH    closed   10 @100 -> 10 @150   gross 500   charges  9.75  net  490.25
 *                     pushed to IPOs through the REAL `pushTradeToIpoAction`,
 *                     so the link is the product's own; its exit is then set on
 *                     the record (a direct UPDATE, so the holding's stated money
 *                     stays literal — the route sync is a state-machine op).
 *
 *  ipos
 *   <A2IPOH>  account 2, trade_id = A2IPOH   allotted 10 @100, exit @150
 *   ORACLE-LOOSE   account 2, NO link        allotted 20 @50,  exit @70
 *   ORACLE-LEGACY  account 1, trade_id = A2SOLD  <- the LEGACY CROSS-ACCOUNT
 *                     shape (pre-2I `pushTradeToIpoAction` filed every record in
 *                     account 1 whatever book the holding was in). Inserted
 *                     directly, because no build still writes it.
 *
 *  account 3 (v4.5.0 wave TP — A SECOND TAX PERSON)
 *   A3SOLD    closed   10 @100 -> 10 @200   gross 1000  charges 10.00  net  990.00
 *                     No IPO record, no ledger entry, no open row: the second
 *                     person's book is deliberately the simplest thing that can
 *                     be counted, so "counted ONCE here and ZERO times there" is
 *                     one number in one place.
 *
 * ── THE FOUR VIEWS, AND WHY THEY ARE NOT ADDITIVE ───────────────────────────
 *
 * ORACLE-LEGACY is counted in account 1 (its holding is not in that view) and
 * NOT in All accounts (its holding is). So All ≠ a1 + a2, deliberately: that is
 * the counted-once rule doing its job, and a guard that asserted additivity
 * would demand the double count back.
 *
 * ── TWO SCOPES PER VIEW (v4.5.0 wave TP, owner ruling T1) ───────────────────
 *
 * From v4.5.0 a view reads TWO scopes at once, and the fixture states both:
 *
 *   ACCOUNT-scoped (invariant 8, unchanged): the capital summary, the /trades
 *     KPI strip and /ipos' own book total.
 *   PERSON-scoped (lib/queries/tax-scope.ts): the tax base, the ITR export,
 *     taxByFy and the AIS reconciliation — a return is filed by a PERSON, so
 *     one person's accounts are read together and two persons are NEVER merged.
 *
 * Accounts 1 and 2 carry ONE `tax_identity` (ORACLE_PERSON_1) and account 3
 * carries another (ORACLE_PERSON_2). So:
 *
 *   view account 1  account block = account 1's,  person block = P1 (a1 + a2)
 *   view account 2  account block = account 2's,  person block = P1 (the same)
 *   view account 3  account block = account 3's,  person block = P2 (a3 alone)
 *   view All (0)    account block = every book's, person block = NO FIGURE —
 *                   a total spanning two tax persons is a number nobody can
 *                   file (invariant 6), so the pages show a picker instead.
 *
 * That makes the wave's own rule assertable as arithmetic on READ figures:
 * P1's realised total is the All-accounts capital total MINUS account 3's —
 * i.e. the second person's sale is counted ONCE in its own pack and ZERO times
 * in P1's. (It holds because account 3 owns no IPO record and no record names
 * a trade of its, both pinned in `assertLiveFixture`.)
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

export const ORACLE_A1 = 1; // the seeded default account
export const ORACLE_A2 = 2;
/** The SECOND tax person's only account (v4.5.0 wave TP). */
export const ORACLE_A3 = 3;

/** Accounts 1 and 2 are one person; account 3 is another. Free text, as typed. */
export const ORACLE_PERSON_1 = "Oracle Holder";
export const ORACLE_PERSON_2 = "Oracle Spouse";
export const ORACLE_FY = "2025-26";
export const ORACLE_BUY_DATE = "2025-06-10";
export const ORACLE_SELL_DATE = "2025-09-20";

/** The 40-hex `dedup-alias:` A1JOIN holds — the sale it names is in Trash. */
export const ORACLE_ALIAS = "a1c0ffee0123456789abcdef0123456789abcdef";

export interface OracleIds {
  a1Sold1: number;
  a1Sold2: number;
  a1Open: number;
  a1Part: number;
  a1MtfZero: number;
  a1MtfNull: number;
  a1Staged: number;
  a1Join: number;
  /** The Trash snapshot holding A1JOIN's sale (the alias names its hash). */
  a1JoinSaleSnapshot: string;
  a2Sold: number;
  a2IpoHolding: number;
  /** The second tax person's only realised sale (account 3). */
  a3Sold: number;
  /** ipos.id of the record `pushTradeToIpoAction` created for A2IPOH. */
  linkedIpo: number;
  /** ipos.id of the unlinked exited allotment in account 2. */
  looseIpo: number;
  /** ipos.id of the legacy account-1 record naming A2SOLD (account 2). */
  legacyIpo: number;
}

/**
 * The PERSON-scoped half of a view (v4.5.0 wave TP): what the tax surfaces,
 * the ITR export and the AIS reconciliation read for the tax person the
 * selected account names. Every field is EMPTY when no person is resolved —
 * the All-accounts view over a book with two persons, which yields no figure at
 * all rather than a merged total (owner ruling T1, invariant 6).
 */
export interface OraclePersonFigures {
  /** `resolveTaxScope().label` as the tax base itself resolved it; "" = none. */
  label: string;
  /**
   * The scope line the exports carry, READ OUT OF THE AIS ROUTE's answer — so
   * the route and the tax base are pinned to have resolved the SAME person in
   * two different files.
   */
  header: string;
  /** cgTrades' nets — one entry per gain the tax base counts, sorted. */
  taxNets: number[];
  /** The exited IPOs the tax base folds in, by name, sorted. */
  ipoNames: string[];
  /** The ITR export's scrip column, sorted — one entry per exported row. */
  itrScrips: string[];
  itrCount: number;
  /**
   * The ITR export's own EQUITY-DELIVERY sale consideration and cost (the rows
   * that carry a term — eq_delivery / eq_mtf and the IPO rows). Exactly the set
   * AIS's sale side counts, read out of the OTHER consumer: the two apply the
   * counted-once rule in two files, so `deliveryConsideration` and the AIS sale
   * total must agree in every state (`assertAgreement`).
   */
  deliveryConsideration: number;
  deliveryCost: number;
  /** taxByFy's totalRealised per FY, as /reports/tax prints it. */
  fyRealised: Record<string, number>;
  /** POST /api/ais journal totals, "<fy> purchase" / "<fy> sale". */
  ais: Record<string, number | null>;
}

/** One view of the book: its ACCOUNT-scoped half, and its person's half. */
export interface OracleView {
  capital: { equityRealised: number; activeRealised: number; ipoRealised: number; totalRealised: number };
  /** The /trades KPI strip: tradeStatsOf(getJournalTrades()) — account-scoped. */
  kpi: { count: number; open: number; net: number };
  /** getIpoRealisedNet() with NO countedTradeIds — account-scoped, the IPO book alone. */
  ipoBookNet: number;
  /** Everything the tax person's return is built from (v4.5.0 wave TP). */
  person: OraclePersonFigures;
}

export type OracleSnapshot = { a1: OracleView; a2: OracleView; a3: OracleView; all: OracleView };

export interface OracleBook {
  ids: OracleIds;
  /** Each IPO's own realised net, as the charges engine prices it. */
  ipoNet: { linked: number; loose: number; legacy: number };
  /** The name `pushTradeToIpoAction` gave A2IPOH's record (the symbol). */
  linkedIpoName: string;
  expected: OracleSnapshot;
  /**
   * The ACCOUNT-scoped half of a view over accounts 1 and 2 TOGETHER — what
   * account 1 reads once account 2 has been merged into it. Not a view of the
   * seeded book (the All-accounts view also holds the second person's account
   * 3), so it is stated here rather than read.
   */
  a12: Omit<OracleView, "person">;
}

// ── the product modules, loaded once the temp database exists ───────────────

interface Consumers {
  capital: typeof import("@/lib/queries/capital");
  taxItr: typeof import("@/lib/queries/tax-itr");
  tax: typeof import("@/lib/analytics/tax");
  ipos: typeof import("@/lib/queries/ipos");
  trades: typeof import("@/lib/queries/trades");
  settings: typeof import("@/lib/queries/settings");
  ais: typeof import("@/app/api/ais/route");
  actions: typeof import("@/app/trades/actions");
  del: typeof import("@/lib/queries/delete");
  importer: typeof import("@/lib/import/commit");
}

let C: Consumers | null = null;

/**
 * Import every consumer DYNAMICALLY — `tests/helpers/temp-db.ts` must have set
 * `VYUHA_DB_PATH` before the first `import("@/lib/db")` anywhere in the graph
 * (AGENTS.md Testing), which a static import here would defeat.
 */
export async function loadOracleConsumers(): Promise<Consumers> {
  C = {
    capital: await import("@/lib/queries/capital"),
    taxItr: await import("@/lib/queries/tax-itr"),
    tax: await import("@/lib/analytics/tax"),
    ipos: await import("@/lib/queries/ipos"),
    trades: await import("@/lib/queries/trades"),
    settings: await import("@/lib/queries/settings"),
    ais: await import("@/app/api/ais/route"),
    actions: await import("@/app/trades/actions"),
    del: await import("@/lib/queries/delete"),
    importer: await import("@/lib/import/commit"),
  };
  return C;
}

const consumers = (): Consumers => {
  if (!C) throw new Error("oracle-book: call loadOracleConsumers() inside the test's beforeAll first");
  return C;
};

export const selectOracleAccount = (t: TempDb, id: number) =>
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

// ── reading the six consumers, in one view ─────────────────────────────────

/**
 * POST /api/ais with nothing to parse: every journal FY total surfaces as its
 * own figure — for the TAX PERSON the route resolved, whose scope line it now
 * states back (v4.5.0 wave TP).
 */
async function aisRead(): Promise<{ totals: Record<string, number | null>; header: string }> {
  const res = await consumers().ais.POST(
    new Request("http://local/api/ais", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "nothing to parse" }),
    }),
  );
  expect(res.status, "the AIS route answered").toBe(200);
  const { recon, scope } = (await res.json()) as {
    recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] };
    scope: string;
  };
  return { totals: Object.fromEntries(recon.fyTotals.map((f) => [`${f.fy} ${f.kind}`, f.journal])), header: scope };
}

/** Every consumer, read in the account currently selected. */
export async function readOracleView(t: TempDb, accountId: number): Promise<OracleView> {
  selectOracleAccount(t, accountId);
  const { capital, taxItr, tax, ipos, trades, settings } = consumers();

  const c = capital.getCapitalSummary();
  const base = taxItr.getTaxBase();
  const itr = taxItr.getItrExportRows();
  // Exactly the call /reports/tax makes (app/reports/tax/page.tsx:112) — on
  // `taxRows`, which carries the resolved assetClass, not the raw page rows.
  const fyRows = tax.taxByFy([...base.taxRows, ...base.ipoTaxRows], settings.getSettings()?.fyStartMonth ?? 4);
  const kpi = trades.tradeStatsOf(trades.getJournalTrades());
  const ais = await aisRead();

  return {
    capital: {
      equityRealised: c.equityRealised,
      activeRealised: c.activeRealised,
      ipoRealised: c.ipoRealised,
      totalRealised: c.totalRealised,
    },
    kpi: { count: kpi.count, open: kpi.open, net: kpi.net },
    ipoBookNet: r2(ipos.getIpoRealisedNet()),
    person: {
      label: base.scope.label,
      header: ais.header,
      taxNets: base.cgTrades.map((r) => r.netPnl).sort((a, b) => a - b),
      ipoNames: base.exitedIpos.map((r) => r.name).sort(),
      itrScrips: itr.map((r) => r.scrip).sort(),
      itrCount: taxItr.countItrRows(),
      deliveryConsideration: r2(itr.filter((r) => r.term !== "").reduce((s, r) => s + r.consideration, 0)),
      deliveryCost: r2(itr.filter((r) => r.term !== "").reduce((s, r) => s + r.cost, 0)),
      fyRealised: Object.fromEntries(fyRows.map((r) => [r.fy, r.totalRealised])),
      ais: ais.totals,
    },
  };
}

/**
 * One IPO row's own gross and net, as /ipos prices it — the engine's answer to
 * "what is this record worth", never to "does it count". Read in the aggregate
 * view so any account's record is visible. Use it the way `ipoNet` is used: to
 * price a row whose exit an operation changed, beside a GROSS the test states
 * as arithmetic.
 */
export function oracleIpoPrice(t: TempDb, ipoId: number): { grossPnl: number; netPnl: number } {
  selectOracleAccount(t, 0);
  const row = consumers().ipos.getIposComputed().rows.find((r) => r.id === ipoId);
  if (!row) throw new Error(`oracle-book: /ipos prices no row with id ${ipoId}`);
  return { grossPnl: r2(row.grossPnl), netPnl: r2(row.netPnl) };
}

/** The four views the account switcher offers: each book, and the aggregate. */
export async function readOracle(t: TempDb): Promise<OracleSnapshot> {
  return {
    a1: await readOracleView(t, ORACLE_A1),
    a2: await readOracleView(t, ORACLE_A2),
    a3: await readOracleView(t, ORACLE_A3),
    all: await readOracleView(t, 0),
  };
}

// ── building the book ───────────────────────────────────────────────────────

function insertTrade(t: TempDb, over: Record<string, unknown>): number {
  return t.db.insert(t.schema.trades).values(tradeRow(over)).returning({ id: t.schema.trades.id }).get()!.id;
}

/** A closed eq_delivery round trip with every money figure STATED. */
function closedRow(t: TempDb, accountId: number, symbol: string, o: {
  qty: number; buy: number; sell: number; charges: number; over?: Record<string, unknown>;
}): number {
  const buyValue = o.qty * o.buy;
  const sellValue = o.qty * o.sell;
  const grossPnl = sellValue - buyValue;
  return insertTrade(t, {
    accountId, broker: "zerodha", segment: "eq_delivery", symbol, tradingsymbol: symbol,
    buyQty: o.qty, avgBuyPrice: o.buy, buyValue, buyDate: ORACLE_BUY_DATE,
    sellQty: o.qty, avgSellPrice: o.sell, sellValue, sellDate: ORACLE_SELL_DATE,
    grossPnl, chargesTotal: o.charges, netPnl: r2(grossPnl - o.charges), isOpen: false,
    ...o.over,
  });
}

/** An exited allotment, optionally linked to a holding. */
function exitedIpoRow(t: TempDb, accountId: number, name: string, o: {
  qty: number; price: number; exit: number; tradeId: number | null;
}): number {
  return t.db
    .insert(t.schema.ipos)
    .values({
      accountId, name, broker: "zerodha", exchange: "NSE",
      appliedPrice: o.price, lotSize: o.qty, lotsApplied: 1, allotted: true, allottedQty: o.qty,
      listingPrice: o.price * 1.2, exitPrice: o.exit,
      appliedDate: "2025-06-01", allotmentDate: ORACLE_BUY_DATE, listingDate: "2025-06-14",
      exitDate: ORACLE_SELL_DATE, tradeId: o.tradeId,
    })
    .returning({ id: t.schema.ipos.id })
    .get()!.id;
}

/**
 * A2IPOH's closed round trip AS A BROKER FILE STATES IT — the row the
 * "re-import the same sale" operations feed back in. The stored holding is
 * given exactly this row's `dedupHash`, so a re-import of it IS a duplicate
 * and a re-import of any variant of it is not.
 */
export function oracleReimportTrade(over: Partial<NormalizedTrade> = {}): NormalizedTrade {
  return {
    broker: "dhan", tradingsymbol: "A2IPOH", isin: null,
    buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: ORACLE_BUY_DATE,
    sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: ORACLE_SELL_DATE,
    closingPrice: null, grossPnl: 500, unrealisedPnl: 0,
    productHint: "delivery", exchangeHint: "NSE", sourceFile: null,
    ...over,
  } as NormalizedTrade;
}

export const oracleParsedFile = (trades: NormalizedTrade[]): ParsedFile => ({
  sourceId: "dhan-api", broker: "dhan", format: "api", trades, warnings: [],
});

/**
 * Wipe every row the fixture writes, so the NEXT `seedOracleBook` builds a book
 * the All-accounts view sees whole.
 *
 * The product caches its connection on `globalThis` and the temp-db helper opens
 * ONE file per test FILE (AGENTS.md Testing), so an in-memory `new Database(buf)`
 * copy per scenario cannot be handed to `lib/queries/*` — a scenario is isolated
 * by emptying the book instead, which is equivalent for every read here and
 * costs ~1 ms. Children first: `foreign_keys = ON` on this connection.
 */
export function resetOracleBook(t: TempDb): void {
  const tables = [
    "trade_legs", "trade_attachments", "trades", "ipos", "ledger_entries",
    "capital_snapshots", "import_batches", "audit_log",
  ];
  const exists = (name: string) =>
    !!t.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  for (const name of tables) if (exists(name)) t.sqlite.prepare(`DELETE FROM ${name}`).run();
  t.sqlite.prepare("DELETE FROM accounts WHERE id <> ?").run(ORACLE_A1);
  // The identity is re-stated by `seedOracleBook`; clearing it here means a
  // scenario that edited it cannot leak into the next one's person grouping.
  t.sqlite.prepare("UPDATE accounts SET pnl_rolled_in = 0, archived = 0, tax_identity = NULL WHERE id = ?").run(ORACLE_A1);
  t.sqlite.prepare("UPDATE settings SET selected_account_id = ?").run(ORACLE_A1);
}

/**
 * Seed the book described in this file's header and state what every consumer
 * must read from it, per view.
 *
 * Call `resetOracleBook(t)` first when a previous scenario has run — the
 * All-accounts view reads EVERY account, so a leftover book from an earlier
 * scenario would be counted into it (correctly, and fatally for the literals).
 */
export async function seedOracleBook(t: TempDb): Promise<OracleBook> {
  const { actions, del, ipos } = consumers();
  const { dedupHash } = await import("@/lib/import/dedup");

  // v4.5.0 wave TP — WHO FILES THESE GAINS. Accounts 1 and 2 are one trader's
  // two broking accounts (one tax person, one return); account 3 is a second
  // person in the same journal, whose sale must be counted ONCE in its own pack
  // and ZERO times in the first person's.
  t.sqlite.prepare("UPDATE accounts SET tax_identity = ? WHERE id = ?").run(ORACLE_PERSON_1, ORACLE_A1);
  t.db.insert(t.schema.accounts).values({ id: ORACLE_A2, name: "oracle 2", isDefault: false, taxIdentity: ORACLE_PERSON_1 }).run();
  t.db.insert(t.schema.accounts).values({ id: ORACLE_A3, name: "oracle 3", isDefault: false, taxIdentity: ORACLE_PERSON_2 }).run();

  // ── account 1 ────────────────────────────────────────────────────────────
  const a1Sold1 = closedRow(t, ORACLE_A1, "A1SOLD1", { qty: 10, buy: 100, sell: 150, charges: 9.75 });
  const a1Sold2 = closedRow(t, ORACLE_A1, "A1SOLD2", { qty: 20, buy: 50, sell: 60, charges: 8 });
  const a1Open = insertTrade(t, {
    accountId: ORACLE_A1, broker: "zerodha", segment: "eq_delivery", symbol: "A1OPEN", tradingsymbol: "A1OPEN",
    buyQty: 30, avgBuyPrice: 100, buyValue: 3000, buyDate: ORACLE_BUY_DATE, isOpen: true,
  });
  // Partly closed: 100 bought, 60 sold, 40 still open. Every realised consumer
  // filters on `isOpen`, so this row states 115.00 of realised P&L that NOTHING
  // below counts — until `closePosition` closes the remaining 40.
  const a1Part = insertTrade(t, {
    accountId: ORACLE_A1, broker: "zerodha", segment: "eq_delivery", symbol: "A1PART", tradingsymbol: "A1PART",
    buyQty: 100, avgBuyPrice: 10, buyValue: 1000, buyDate: ORACLE_BUY_DATE,
    sellQty: 60, avgSellPrice: 12, sellValue: 720, sellDate: ORACLE_SELL_DATE,
    grossPnl: 120, chargesTotal: 5, netPnl: 115, isOpen: true,
  });
  const mtfRow = (symbol: string, funded: number | null) =>
    insertTrade(t, {
      accountId: ORACLE_A1, broker: "zerodha", segment: "eq_mtf", symbol, tradingsymbol: symbol,
      buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: ORACLE_BUY_DATE,
      isOpen: true, mtfFundedAmount: funded,
    });
  const a1MtfZero = mtfRow("A1MTFZ", 0); //  a STATED 0 — 100% own capital (wave 2H/2I F1)
  const a1MtfNull = mtfRow("A1MTFN", null); // states nothing
  // A staged parent: the parent row holds the aggregate (invariant 5), the legs
  // are additive detail, and one of them is an exit.
  //
  // v4.5.0 wave 3b-ii (P1) — THE PARTLY-SOLD STAGED LADDER, and why its
  // realised figure is 196.67 and NOT the parent's stored 194.00.
  //
  // The exit fill sells 40 of the 100 held, and FIFO consumes them out of entry
  // leg 1 (60 available), so the split emits ONE row:
  //
  //   gross            40 × (25 − 20)                        = 200.00
  //   exit-leg charges the fill's own, whole (it is one fill) =  −2.00
  //   entry charges    leg 1's 2.00 × 40/60 — the quantity
  //                    this fill actually consumed            =  −1.3333
  //   net                                                     = 196.6667 -> 196.67
  //
  // The parent's stored 194.00 deducts ALL SIX rupees of charges — both entry
  // legs' 2.00 + 2.00 and the exit's 2.00 — against a sale of only 40 of the
  // 100 shares. The missing ₹2.67 (leg 1's remaining 0.6667 + leg 2's whole
  // 2.00) is not lost: it realises with the OTHER 60 shares when they are sold.
  // The ladder is OPEN, so the split settles each column to its own exact sum
  // rather than to the parent's aggregate (lib/analytics/realised-rows.ts) —
  // the closed-ladder reconciliation is pinned in tests/realised-rows.test.ts.
  const a1Staged = insertTrade(t, {
    accountId: ORACLE_A1, broker: "zerodha", segment: "eq_delivery", symbol: "A1STG", tradingsymbol: "A1STG",
    buyQty: 100, avgBuyPrice: 20, buyValue: 2000, buyDate: ORACLE_BUY_DATE,
    sellQty: 40, avgSellPrice: 25, sellValue: 1000, sellDate: ORACLE_SELL_DATE,
    grossPnl: 200, chargesTotal: 6, netPnl: 194, isOpen: true, staged: true,
  });
  t.db.insert(t.schema.tradeLegs).values([
    { tradeId: a1Staged, kind: "entry", seq: 1, tradeDate: ORACLE_BUY_DATE, qty: 60, price: 20, chargesTotal: 2, netPnl: 0 },
    { tradeId: a1Staged, kind: "entry", seq: 2, tradeDate: ORACLE_BUY_DATE, qty: 40, price: 20, chargesTotal: 2, netPnl: 0 },
    { tradeId: a1Staged, kind: "exit", seq: 3, tradeDate: ORACLE_SELL_DATE, qty: 40, price: 25, chargesTotal: 2, netPnl: 194, avgCostAtExit: 20 },
  ]).run();
  // The Data Quality join's shape: a closed lot that RECORDS a sale it does not
  // store, under `dedup-alias:` — and that sale, in Trash.
  const a1Join = closedRow(t, ORACLE_A1, "A1JOIN", {
    qty: 100, buy: 200, sell: 250, charges: 30, over: { importNotes: `dedup-alias:${ORACLE_ALIAS}` },
  });
  const a1JoinSale = insertTrade(t, {
    accountId: ORACLE_A1, broker: "zerodha", segment: "eq_delivery", symbol: "A1JOIN", tradingsymbol: "A1JOIN",
    sellQty: 100, avgSellPrice: 250, sellValue: 25000, sellDate: ORACLE_SELL_DATE,
    isOpen: true, dedupHash: ORACLE_ALIAS,
  });
  const joinDel = del.deleteTradesByIds([a1JoinSale], "oracle: the sale the lot's alias names", "test");
  expect([joinDel.ok, joinDel.snapshotId != null], joinDel.message).toEqual([true, true]);

  // ── account 2 ────────────────────────────────────────────────────────────
  const a2Sold = closedRow(t, ORACLE_A2, "A2SOLD", { qty: 10, buy: 100, sell: 150, charges: 9.75 });
  // ── account 3, THE SECOND TAX PERSON ─────────────────────────────────────
  // One closed round trip and nothing else. Its net (990.00) is unlike every
  // other figure in the book, so a pack that swallowed it could not hide.
  const a3Sold = closedRow(t, ORACLE_A3, "A3SOLD", { qty: 10, buy: 100, sell: 200, charges: 10 });
  const a2IpoHolding = closedRow(t, ORACLE_A2, "A2IPOH", {
    qty: 10, buy: 100, sell: 150, charges: 9.75,
    over: { broker: "dhan", acquisition: "ipo", dedupHash: dedupHash(oracleReimportTrade()) },
  });

  // THE REAL PUSH — the link under test is the product's own write, not an
  // insert that imitates it (app/trades/actions.ts:553 pushTradeToIpoAction).
  selectOracleAccount(t, ORACLE_A2);
  const fd = new FormData();
  fd.set("tradeId", String(a2IpoHolding));
  const pushed = await actions.pushTradeToIpoAction({ ok: false, message: "" }, fd);
  expect(pushed.ok, `pushTradeToIpoAction: ${pushed.message}`).toBe(true);
  const linked = t.db.select().from(t.schema.ipos).all().find((r) => r.tradeId === a2IpoHolding);
  if (!linked) throw new Error("pushTradeToIpoAction created no linked ipos row");
  const linkedIpo = linked.id;
  const linkedIpoName = linked.name;
  // The push seeds the allotment, never an exit (the holding's sale is not the
  // record's until the user says so). Set the exit directly: routing it through
  // POST /api/ipos would SYNC onto the holding and re-price its charges, which
  // would make every trade-side literal above an engine output. That sync is a
  // state-machine operation of its own.
  t.sqlite.prepare("UPDATE ipos SET exit_price = 150, exit_date = ?, listing_price = 130, listing_date = '2025-06-14' WHERE id = ?")
    .run(ORACLE_SELL_DATE, linkedIpo);

  const looseIpo = exitedIpoRow(t, ORACLE_A2, "ORACLE-LOOSE", { qty: 20, price: 50, exit: 70, tradeId: null });
  // The LEGACY cross-account link: the record in account 1, its holding in
  // account 2. Inserted directly — no build still writes this shape, and the
  // startup data fix exists to move it (lib/db/data-fixes.ts applyIpoAccountRehome).
  const legacyIpo = exitedIpoRow(t, ORACLE_A1, "ORACLE-LEGACY", { qty: 10, price: 100, exit: 150, tradeId: a2Sold });

  // ── what each IPO row is WORTH (the engine's answer, read once) ───────────
  selectOracleAccount(t, 0);
  const netByName = new Map(ipos.getIposComputed().rows.map((r) => [r.name, r.netPnl]));
  const netOf = (name: string) => {
    const v = netByName.get(name);
    if (v == null) throw new Error(`oracle-book: /ipos priced no row named ${name}`);
    return r2(v);
  };
  const ipoNet = { linked: netOf(linkedIpoName), loose: netOf("ORACLE-LOOSE"), legacy: netOf("ORACLE-LEGACY") };

  const ids: OracleIds = {
    a1Sold1, a1Sold2, a1Open, a1Part, a1MtfZero, a1MtfNull, a1Staged, a1Join,
    a1JoinSaleSnapshot: joinDel.snapshotId!,
    a2Sold, a2IpoHolding, a3Sold, linkedIpo, looseIpo, legacyIpo,
  };

  return { ids, ipoNet, linkedIpoName, expected: expectedFor(ipoNet), a12: a12Accounts(ipoNet) };
}

/**
 * The oracle, stated from the fixture's own numbers.
 *
 * account 1, trades   490.25 + 192.00 + 4970.00 + 196.67       = 5848.92 realised
 *                     (A1OPEN, A1PART, A1MTFZ, A1MTFN are OPEN and realise
 *                     nothing; A1STG's PARENT is open too, but its booked exit
 *                     fill is a realised row of its own - v4.5.0 wave 3b-ii)
 * account 1, IPOs     ORACLE-LEGACY only: its holding (A2SOLD) is in account 2,
 *                     so this view did not count it -> the record counts itself.
 *                     The linked and loose records are in account 2, invisible here.
 * account 2, trades   490.25 + 490.25                           =  980.50 realised
 * account 2, IPOs     ORACLE-LOOSE only: the linked record's holding (A2IPOH)
 *                     WAS counted just above; ORACLE-LEGACY is filed in account 1.
 * All accounts        5848.92 + 980.50 = 6829.42 of trades, and of the three
 *                     records only ORACLE-LOOSE counts — the other two name a
 *                     holding this view counted. NOTE All ≠ a1 + a2 on the IPO
 *                     line, and that is the rule working: ORACLE-LEGACY's sale
 *                     is stated once here, through A2SOLD.
 *
 * AIS purchase (every delivery/MTF row by buy-date FY, open ones included):
 *   a1  1000 + 1000 + 3000 + 1000 + 10000 + 10000 + 2000 + 20000 = 48000
 *       + ORACLE-LEGACY's allotment 10 × 100                     =  1000 -> 49000
 *   a2  1000 + 1000 = 2000, + ORACLE-LOOSE 20 × 50 = 1000        ->  3000
 *       (the linked record's allotment is A2IPOH's purchase, counted already)
 *   P1  48000 + 2000 + 1000                                      -> 51000
 *   P2  account 3's own purchase 10 × 100                        ->  1000
 * AIS sale (CLOSED delivery/MTF rows by sell-date FY):
 *   a1  1500 + 1200 + 25000 = 27700, + A1STG's fill 40 × 25 = 1000,
 *       + ORACLE-LEGACY 10 × 150                                 -> 30200
 *   a2  1500 + 1500 =  3000, + ORACLE-LOOSE 20 × 70 = 1400       ->  4400
 *   P1  27700 + 1000 + 3000 + 1400                               -> 33100
 *   P2  account 3's own sale 10 × 200                            ->  2000
 *
 * (The a1 / a2 AIS lines are what those BOOKS hold; from v4.5.0 the route reads
 * the PERSON, so both views state P1's 51000 / 32100.)
 *
 * /trades KPI (`tradeStatsOf` sums EVERY row, open included):
 *   a1  8 rows, 5 open, net 490.25+192+0+115+0+0+194+4970        = 5961.25
 *   a2  2 rows, 0 open, net 490.25 + 490.25                      =  980.50
 *   a3  1 row,  0 open, net 990.00                               =  990.00
 *   all 11 rows, 5 open                                          = 7931.75
 *
 * `ipoBookNet` is /ipos' own page total — every exited record in the view, with
 * no counted-once subtraction at all (that argument is the consumer's). It is
 * here so a change that "fixed" double counting by zeroing the IPO book would
 * be caught rather than congratulated.
 *
 * ── THE PERSON HALF (v4.5.0 wave TP) ────────────────────────────────────────
 *
 * P1 (accounts 1 + 2) reads EXACTLY what the All-accounts view read before this
 * wave — the two books together, with the counted-once rule applied across
 * them — and BOTH the account-1 and the account-2 views state it, because the
 * selector names a person, not a book. P2 (account 3) reads its one sale. The
 * All-accounts view reads NOTHING: two persons, no filable total.
 */
const PERSON_TOTALS = (ipoNet: { linked: number; loose: number; legacy: number }) => {
  // v4.5.0 wave 3b-ii (P1) — A1STG's booked fill (196.67) joins the three
  // closed round trips. It used to be in NO realised figure at all: the parent
  // is `isOpen`, so every realised consumer skipped it, and the sale would have
  // landed whole in whatever FY the ladder finally closed in. See the A1STG
  // fixture above for why 196.67 and not the parent's stored 194.00.
  const A1_TRADES = r2(490.25 + 192 + 4970 + 196.67); // 5848.92
  const A2_TRADES = r2(490.25 + 490.25); //      980.50
  return { A1_TRADES, A2_TRADES, P1_TRADES: r2(A1_TRADES + A2_TRADES), ipoNet };
};

/** The scope line every tax page and export carries, per person. */
export const ORACLE_HEADER_P1 = `Tax person: ${ORACLE_PERSON_1} — accounts: Primary, oracle 2`;
export const ORACLE_HEADER_P2 = `Tax person: ${ORACLE_PERSON_2} — accounts: oracle 3`;
/** What the All-accounts view states while the book holds two tax persons. */
export const ORACLE_HEADER_NONE = "Tax person: not chosen — no figure";

/** P1's pack: accounts 1 and 2 together, whichever of them is selected. */
function personOne(ipoNet: { linked: number; loose: number; legacy: number }): OraclePersonFigures {
  const { P1_TRADES } = PERSON_TOTALS(ipoNet);
  return {
    label: ORACLE_PERSON_1,
    header: ORACLE_HEADER_P1,
    // A1STG's fill is one more counted gain (196.67), one more exported scrip
    // and one more delivery sale: consideration 40 × 25 = 1000 on top of
    // 32100, cost 40 × 20 = 800 (the fill's basis is the moving average in
    // force at the exit, invariant 4) on top of 25000.
    taxNets: [490.25, 192, 4970, 196.67, 490.25, 490.25, ipoNet.loose].sort((a, b) => a - b),
    ipoNames: ["ORACLE-LOOSE"],
    itrScrips: ["A1JOIN", "A1SOLD1", "A1SOLD2", "A1STG", "A2IPOH", "A2SOLD", "ORACLE-LOOSE (IPO)"],
    itrCount: 7,
    deliveryConsideration: 33100,
    deliveryCost: 25800,
    fyRealised: { [ORACLE_FY]: r2(P1_TRADES + ipoNet.loose) },
    // The purchase side is unchanged BY DESIGN (app/api/ais/route.ts): it is
    // the parent's whole buyValue at the parent's buyDate, open rows included,
    // so A1STG's 2000 was already in the 51000. Only the SALE side moved.
    ais: { [`${ORACLE_FY} purchase`]: 51000, [`${ORACLE_FY} sale`]: 33100 },
  };
}

/** P2's pack: account 3's single round trip, 1000 bought and 2000 sold. */
function personTwo(): OraclePersonFigures {
  return {
    label: ORACLE_PERSON_2,
    header: ORACLE_HEADER_P2,
    taxNets: [990],
    ipoNames: [],
    itrScrips: ["A3SOLD"],
    itrCount: 1,
    deliveryConsideration: 2000,
    deliveryCost: 1000,
    fyRealised: { [ORACLE_FY]: 990 },
    ais: { [`${ORACLE_FY} purchase`]: 1000, [`${ORACLE_FY} sale`]: 2000 },
  };
}

/**
 * NO FIGURE — what a view whose person cannot be resolved reads: the
 * All-accounts view over two persons, and any view of an account that no longer
 * exists. Not a zero total dressed as an answer: the pages show a picker.
 */
export const ORACLE_NO_FIGURE: OraclePersonFigures = {
  label: "", header: ORACLE_HEADER_NONE,
  taxNets: [], ipoNames: [], itrScrips: [], itrCount: 0,
  deliveryConsideration: 0, deliveryCost: 0, fyRealised: {}, ais: {},
};

/** The account-scoped half of a view over accounts 1 and 2 together. */
function a12Accounts(ipoNet: { linked: number; loose: number; legacy: number }): Omit<OracleView, "person"> {
  const { P1_TRADES } = PERSON_TOTALS(ipoNet);
  return {
    capital: {
      equityRealised: P1_TRADES, activeRealised: 0, ipoRealised: ipoNet.loose,
      totalRealised: r2(P1_TRADES + ipoNet.loose),
    },
    kpi: { count: 10, open: 5, net: 6941.75 },
    ipoBookNet: r2(ipoNet.linked + ipoNet.loose + ipoNet.legacy),
  };
}

function expectedFor(ipoNet: { linked: number; loose: number; legacy: number }): OracleSnapshot {
  const { A1_TRADES, A2_TRADES, P1_TRADES } = PERSON_TOTALS(ipoNet);
  const A3_TRADES = 990;
  const ALL_TRADES = r2(P1_TRADES + A3_TRADES); // 7819.42

  return {
    a1: {
      capital: {
        equityRealised: A1_TRADES, activeRealised: 0, ipoRealised: ipoNet.legacy,
        totalRealised: r2(A1_TRADES + ipoNet.legacy),
      },
      kpi: { count: 8, open: 5, net: 5961.25 },
      ipoBookNet: ipoNet.legacy,
      person: personOne(ipoNet),
    },
    a2: {
      capital: {
        equityRealised: A2_TRADES, activeRealised: 0, ipoRealised: ipoNet.loose,
        totalRealised: r2(A2_TRADES + ipoNet.loose),
      },
      kpi: { count: 2, open: 0, net: 980.5 },
      ipoBookNet: r2(ipoNet.linked + ipoNet.loose),
      person: personOne(ipoNet),
    },
    a3: {
      capital: { equityRealised: A3_TRADES, activeRealised: 0, ipoRealised: 0, totalRealised: A3_TRADES },
      kpi: { count: 1, open: 0, net: 990 },
      ipoBookNet: 0,
      person: personTwo(),
    },
    all: {
      capital: {
        equityRealised: ALL_TRADES, activeRealised: 0, ipoRealised: ipoNet.loose,
        totalRealised: r2(ALL_TRADES + ipoNet.loose),
      },
      kpi: { count: 11, open: 5, net: 7931.75 },
      ipoBookNet: r2(ipoNet.linked + ipoNet.loose + ipoNet.legacy),
      person: ORACLE_NO_FIGURE,
    },
  };
}

/**
 * The fixture is LIVE — every IPO net is the engine's, distinct from every
 * trade net, and its GROSS is the fixture's own arithmetic.
 *
 * Without this, an engine that priced every exit at 0 (or at the holding's own
 * net) would make the counted-once assertions pass while stating nothing.
 */
export function assertLiveFixture(book: OracleBook): void {
  const { ipoNet } = book;
  // gross = (exit − issue) × allotted, before the engine's charges:
  //   linked / legacy  (150 − 100) × 10 = 500 ;  loose  (70 − 50) × 20 = 400
  for (const [name, net, gross] of [
    ["linked", ipoNet.linked, 500],
    ["legacy", ipoNet.legacy, 500],
    ["loose", ipoNet.loose, 400],
  ] as [string, number, number][]) {
    expect(net, `${name}: the engine billed something`).toBeLessThan(gross);
    expect(net, `${name}: the engine did not bill the whole gain away`).toBeGreaterThan(gross * 0.9);
  }
  const tradeNets = [490.25, 192, 4970, 115, 194, 990];
  for (const n of tradeNets) {
    expect(ipoNet.legacy, "the legacy IPO's net is not a trade's").not.toBe(n);
    expect(ipoNet.loose, "the loose IPO's net is not a trade's").not.toBe(n);
  }
  // All three differ, so no assertion below can pass by two figures colliding.
  // (The linked record carries NO broker — `pushTradeToIpoAction` seeds none —
  // so it prices on the STATUTORY columns, with no brokerage and no DP; the two
  // hand-filed records name zerodha. Same gross, different bill, by design.)
  expect(new Set([ipoNet.linked, ipoNet.legacy, ipoNet.loose]).size, "three distinct IPO nets").toBe(3);
}
