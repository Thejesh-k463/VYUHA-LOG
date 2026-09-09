import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * A5 — multi-account isolation (v2.97).
 *
 * The implementation is centralised and correct: every account-scoped read goes
 * through `getSelectedAccountId()` and applies `accountId > 0 ? filter : all`,
 * where 0 is the synthetic "All accounts" aggregate. Nothing locked that in.
 *
 * The failure this guards against is quiet and severe: one query that forgets
 * the filter merges two accounts into a single tax pack, ITR turnover or
 * expectancy figure. Nothing on screen would look broken — the numbers would
 * just belong to two books at once.
 *
 * The registry test at the bottom is the important one. Per-function tests only
 * cover the functions someone remembered to write a test for; the registry
 * fails the moment a NEW table gets an `account_id` column, forcing whoever
 * added it to say where it is scoped.
 */

let t: TempDb;
let queries: {
  trades: typeof import("@/lib/queries/trades");
  ledger: typeof import("@/lib/queries/ledger");
  ipos: typeof import("@/lib/queries/ipos");
  capital: typeof import("@/lib/queries/capital");
  sessions: typeof import("@/lib/queries/sessions");
  accounts: typeof import("@/lib/queries/accounts");
};

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;

/** Point the app at an account, the way the sidebar switcher does. */
function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

beforeAll(async () => {
  t = await openTempDb("accounts", { seed: true });
  queries = {
    trades: await import("@/lib/queries/trades"),
    ledger: await import("@/lib/queries/ledger"),
    ipos: await import("@/lib/queries/ipos"),
    capital: await import("@/lib/queries/capital"),
    sessions: await import("@/lib/queries/sessions"),
    accounts: await import("@/lib/queries/accounts"),
  };

  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();

  t.db.insert(t.schema.trades).values([
    tradeRow({ accountId: PRIMARY, symbol: "TCS", setupTag: "orb", netPnl: 1000 }),
    tradeRow({ accountId: PRIMARY, symbol: "INFY", setupTag: "orb", netPnl: -400 }),
    tradeRow({ accountId: SWING, symbol: "RELIANCE", setupTag: "vcp", netPnl: 250 }),
  ]).run();

  t.db.insert(t.schema.ledgerEntries).values([
    { accountId: PRIMARY, date: "2026-07-01", type: "deposit", amountPaise: 5_000_000, bucket: "equity" },
    { accountId: SWING, date: "2026-07-02", type: "deposit", amountPaise: 1_000_000, bucket: "equity" },
  ]).run();

  t.db.insert(t.schema.importBatches).values([
    { accountId: PRIMARY, broker: "dhan", fileName: "primary.csv", rowCount: 2, status: "completed" },
    { accountId: SWING, broker: "zerodha", fileName: "swing.csv", rowCount: 1, status: "completed" },
  ]).run();

  t.db.insert(t.schema.tradingSessions).values([
    { accountId: PRIMARY, sessionDate: "2026-07-01", maxTrades: 3 },
    { accountId: SWING, sessionDate: "2026-07-01", maxTrades: 5 },
  ]).run();
});

afterAll(() => t?.cleanup());

describe("account isolation — reads", () => {
  it("getTrades returns only the selected account", () => {
    selectAccount(PRIMARY);
    expect(queries.trades.getTrades().map((x) => x.symbol).sort()).toEqual(["INFY", "TCS"]);

    selectAccount(SWING);
    expect(queries.trades.getTrades().map((x) => x.symbol)).toEqual(["RELIANCE"]);
  });

  it("getTrades aggregates every account in the All-accounts view", () => {
    selectAccount(ALL);
    expect(queries.trades.getTrades().map((x) => x.symbol).sort()).toEqual(["INFY", "RELIANCE", "TCS"]);
  });

  it("getTradeStats nets only the selected account", () => {
    selectAccount(PRIMARY);
    expect(queries.trades.getTradeStats().net).toBe(600); // 1000 - 400
    selectAccount(SWING);
    expect(queries.trades.getTradeStats().net).toBe(250);
    selectAccount(ALL);
    expect(queries.trades.getTradeStats().net).toBe(850);
  });

  it("getSetupTags does not leak another account's tags", () => {
    selectAccount(PRIMARY);
    expect(queries.trades.getSetupTags()).toEqual(["orb"]);
    selectAccount(SWING);
    expect(queries.trades.getSetupTags()).toEqual(["vcp"]);
    selectAccount(ALL);
    expect(queries.trades.getSetupTags().sort()).toEqual(["orb", "vcp"]);
  });

  it("getImportBatches is scoped", () => {
    selectAccount(PRIMARY);
    expect(queries.trades.getImportBatches().map((b) => b.fileName)).toEqual(["primary.csv"]);
    selectAccount(SWING);
    expect(queries.trades.getImportBatches().map((b) => b.fileName)).toEqual(["swing.csv"]);
    selectAccount(ALL);
    expect(queries.trades.getImportBatches()).toHaveLength(2);
  });

  it("getLedgerEntries is scoped", () => {
    selectAccount(PRIMARY);
    let rows = queries.ledger.getLedgerEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0].amountPaise).toBe(5_000_000);

    selectAccount(SWING);
    rows = queries.ledger.getLedgerEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0].amountPaise).toBe(1_000_000);

    selectAccount(ALL);
    expect(queries.ledger.getLedgerEntries()).toHaveLength(2);
  });

  it("the SQL-aggregated /cash reads (groups, running page, count) are scoped", () => {
    selectAccount(PRIMARY);
    expect(queries.ledger.countLedgerEntries()).toBe(1);
    expect(queries.ledger.getLedgerGroups()).toEqual([
      { bucket: "equity", type: "deposit", totalPaise: 5_000_000, count: 1 },
    ]);
    let rows = queries.ledger.getLedgerRunningRows({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].amountPaise).toBe(5_000_000);

    selectAccount(SWING);
    expect(queries.ledger.countLedgerEntries()).toBe(1);
    rows = queries.ledger.getLedgerRunningRows({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].amountPaise).toBe(1_000_000);

    selectAccount(ALL);
    expect(queries.ledger.countLedgerEntries()).toBe(2);
    expect(queries.ledger.getLedgerRunningRows({ limit: 10 })).toHaveLength(2);
    // The aggregate view SUMS both books' running balance inside one bucket —
    // the same thing summariseLedger did when handed both accounts' entries.
    const groups = queries.ledger.getLedgerGroups();
    expect(groups).toEqual([{ bucket: "equity", type: "deposit", totalPaise: 6_000_000, count: 2 }]);
  });

  it("getSessionsWithReview is scoped even though both accounts traded the same day", () => {
    selectAccount(PRIMARY);
    let s = queries.sessions.getSessionsWithReview();
    expect(s).toHaveLength(1);
    expect(s[0].maxTrades).toBe(3);

    selectAccount(SWING);
    s = queries.sessions.getSessionsWithReview();
    expect(s).toHaveLength(1);
    expect(s[0].maxTrades).toBe(5);
  });

  it("getTradeCount is scoped", () => {
    selectAccount(PRIMARY);
    expect(queries.capital.getTradeCount()).toBe(2);
    selectAccount(SWING);
    expect(queries.capital.getTradeCount()).toBe(1);
    selectAccount(ALL);
    expect(queries.capital.getTradeCount()).toBe(3);
  });
});

describe("account selection", () => {
  it("getWriteAccountId REFUSES the implied aggregate — no lowest-id guess, no hard-coded 1", () => {
    // Writes must land in a real account; 0 is a view, not a place. Until v3.8
    // this asserted `toBeGreaterThan(0)` — satisfied by the lowest-id fallback
    // that filed All-accounts writes on account #1 (owner ruling 2026-09-04).
    selectAccount(ALL);
    expect(queries.accounts.getSelectedAccountId()).toBe(ALL);
    expect(() => queries.accounts.getWriteAccountId()).toThrow(queries.accounts.AccountRequiredError);
    expect(() => queries.accounts.getWriteAccountId(null)).toThrow(/choose the account/i);
    // A bogus explicit id has nothing to fall back on in the aggregate view either.
    expect(() => queries.accounts.getWriteAccountId(999)).toThrow(queries.accounts.AccountRequiredError);

    selectAccount(SWING);
    expect(queries.accounts.getWriteAccountId()).toBe(SWING);
  });

  it("an explicit 0 is refused even when a real account is selected", () => {
    selectAccount(SWING);
    let caught: unknown;
    try {
      queries.accounts.getWriteAccountId(0);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(queries.accounts.AccountRequiredError);
    expect((caught as { code: string }).code).toBe("ACCOUNT_REQUIRED");
  });

  it("honours the account the user picked in the aggregate view", () => {
    selectAccount(ALL);
    expect(queries.accounts.getWriteAccountId(SWING)).toBe(SWING);
    expect(queries.accounts.getWriteAccountId(PRIMARY)).toBe(PRIMARY);
  });

  it("ignores an explicit id that is not a real account", () => {
    // A stale tab or a hand-crafted request must not create a phantom account.
    selectAccount(PRIMARY);
    expect(queries.accounts.getWriteAccountId(999)).toBe(PRIMARY);
    expect(queries.accounts.getWriteAccountId(-1)).toBe(PRIMARY);
    // 0 is not "not a real account" — it is the aggregate named out loud, and
    // it is refused rather than resolved (inverted in v3.8; it read PRIMARY).
    expect(() => queries.accounts.getWriteAccountId(0)).toThrow(queries.accounts.AccountRequiredError);
    expect(queries.accounts.getWriteAccountId(1.5)).toBe(PRIMARY);
  });

  it("an explicit id cannot override a specific (non-aggregate) selection with a bad value", () => {
    selectAccount(SWING);
    expect(queries.accounts.getWriteAccountId(null)).toBe(SWING);
    expect(queries.accounts.getWriteAccountId(undefined)).toBe(SWING);
  });

  it("isAggregateView is true only when 2+ accounts and nothing specific is chosen", () => {
    selectAccount(ALL);
    expect(queries.accounts.isAggregateView()).toBe(true);
    selectAccount(PRIMARY);
    expect(queries.accounts.isAggregateView()).toBe(false);
  });
});

describe("staged mutations respect the account boundary (D17)", () => {
  it("a leg mutation on another account's trade is refused, not applied", async () => {
    const staged = await import("@/lib/queries/staged");
    const row = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: SWING, symbol: "GUARDED", tradingsymbol: "GUARDED", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-07-01", isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get();

    // Viewing PRIMARY: the SWING trade's id is real but out of reach — the
    // exact stale-panel shape the guard exists for.
    selectAccount(PRIMARY);
    const refused = staged.convertToStaged(row.id);
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/not in the account/i);
    expect(t.db.select().from(t.schema.tradeLegs).all().filter((l) => l.tradeId === row.id)).toHaveLength(0);

    // Viewing its own account (or the aggregate), the same call works.
    selectAccount(SWING);
    expect(staged.convertToStaged(row.id).ok).toBe(true);
    expect(t.db.select().from(t.schema.tradeLegs).all().filter((l) => l.tradeId === row.id).length).toBeGreaterThan(0);
  });
});

describe("account-scoped table registry", () => {
  /**
   * table → the source files that OWN its account boundary. The old version of
   * this test asserted only the list of table NAMES, which is how a dead table
   * ("positions") sat here labelled "a known, scoped one" while nothing
   * queried it at all, and how two API routes wrote unscoped for months
   * (defects D9/D15, 2026-08-12). Now each table must name its owners, and
   * each owner must actually invoke the account resolver.
   *
   * AN OWNER IS EVERY FILE THAT TOUCHES THE TABLE, not just the query module.
   * The v3.7 audit found the registry quietly assuming the opposite for
   * capital_snapshots and ledger_entries — both had API routes writing them
   * directly while only the query module was listed, so the scan below passed
   * over defects D-1 and D-2 for a whole release. If a route inserts, updates
   * or deletes rows itself, list the route.
   */
  // lib/queries/account-delete.ts touches EVERY scoped table: deleting or
  // merging an account is the one operation whose subject IS an account, so it
  // takes the id as an explicit parameter (validated like getWriteAccountId)
  // rather than reading the request-cached selection.
  const OWNERS: Record<string, string[]> = {
    trades: ["lib/queries/trades.ts", "lib/queries/delete.ts", "lib/queries/staged.ts", "lib/queries/account-delete.ts"],
    import_batches: ["lib/queries/trades.ts", "lib/queries/delete.ts", "lib/queries/account-delete.ts"],
    ipos: ["lib/queries/ipos.ts", "app/api/ipos/route.ts", "lib/queries/account-delete.ts"],
    // Three writers, not one. The registry listed only the query module, and
    // that omission is WHY the source scan never flagged defect D-2: both API
    // routes insert into ledger_entries directly and neither was checked.
    // /api/ledger adds a single manual entry; /api/import/ledger commits a
    // whole broker statement in one transaction. Both now refuse the
    // aggregate view before resolving (v3.7 audit, fix wave D).
    ledger_entries: [
      "lib/queries/ledger.ts",
      "app/api/ledger/route.ts",
      "app/api/import/ledger/route.ts",
      "lib/queries/account-delete.ts",
    ],
    trading_sessions: ["lib/queries/sessions.ts", "app/api/sessions/route.ts", "lib/queries/account-delete.ts"],
    // app/api/capital/route.ts delegates wholly to compoundRealised() here, so
    // for THAT route the query module owns the boundary — the shape D1's fix
    // deliberately produced. app/api/settings/route.ts does NOT delegate: it
    // writes capital_snapshots itself, and the registry's claim that the query
    // module owned every boundary is exactly why the source scan never flagged
    // defect D-1 (saving Settings from the All-accounts view rewrote account
    // #1's snapshot). Declared here now, guarded there now.
    capital_snapshots: ["lib/queries/capital.ts", "app/api/settings/route.ts", "lib/queries/account-delete.ts"],
    // Goal reads scope through getSelectedAccountId (aggregate = pure SUM via
    // aggregateGoals); writes REFUSE the aggregate view like compoundRealised.
    capital_goals: ["lib/queries/goals.ts", "lib/queries/account-delete.ts"],
    // B/f loss reads scope through getSelectedAccountId (aggregate reads ALL
    // accounts' lots — the tax pages blend every account's trades there, so
    // the seed matches); writes REFUSE the aggregate view like goals.
    bf_loss_lots: ["lib/queries/bf-losses.ts", "lib/queries/account-delete.ts"],
    // v3.7 (migrations 0056/0058). Schema landed in wave 1, the query modules
    // in wave 2; both are listed below. Keep this registry current — it is the
    // description of WHERE the account boundary is enforced, and a table whose
    // real owner is missing here passes the test while enforcing nothing.
    // Weekly-review reads scope through getSelectedAccountId (the aggregate
    // view LISTS every account's rows — they carry account_id and can be
    // labelled — but resolves no single week's note there, because one book's
    // prose is not the aggregate's); writes REFUSE the aggregate view like
    // goals and bf-losses.
    weekly_reviews: ["lib/queries/review.ts", "lib/queries/account-delete.ts"],
    // Challan reads scope through getSelectedAccountId (the aggregate view
    // reads ALL accounts' payments, matching the tax pages that blend every
    // account's trades there); writes REFUSE the aggregate view BEFORE
    // getWriteAccountId resolves, so its lowest-id fallback can never file a
    // bank payment against the wrong book. app/api/challans/route.ts delegates
    // wholly to the query module and never touches the table itself — the same
    // shape as capital_snapshots above.
    advance_tax_challans: ["lib/queries/challans.ts", "lib/queries/account-delete.ts"],
    // v4.2 (fix B-9). The three original entries described the IMPORT half only,
    // and the live feed grew five more readers of the same table without one of
    // them being declared — so the "every declared owner resolves the account"
    // scan below never looked at a single live-quote credential read. Each of
    // the five resolves through getSelectedAccountId() and applies the
    // `accountId > 0 ? filter : all` rule (invariant 8): the feed route filters
    // in SQL, the four adapters filter the rows they fetched, and registry.ts
    // additionally folds the account into its memo key so one book's cached
    // connection can never answer another book's request.
    broker_connections: [
      "app/api/import/broker/route.ts",
      "lib/queries/broker-connections.ts",
      "lib/queries/account-delete.ts",
      "app/api/live/feed/route.ts",
      "lib/quotes/registry.ts",
      "lib/quotes/angelone.ts",
      "lib/quotes/upstox.ts",
      "lib/quotes/openalgo.ts",
    ],
    panel_dismissals: ["lib/queries/dismissals.ts", "lib/queries/account-delete.ts"],
    // v3.9 (migration 0062). Reads scope through getSelectedAccountId; the
    // ONLY writer is the import commit path, which resolves the WRITE
    // account (invariant 9) before it stores a single broker figure —
    // filing one book's broker statement against another book would make
    // the reconciliation screen quote figures for trades it cannot see.
    broker_reference: ["lib/queries/reference.ts", "lib/import/commit.ts"],
  };

  it("every table carrying account_id has a declared owner", () => {
    // Introspect the real schema rather than trusting a hand-kept list — this
    // catches the NEXT table: adding account_id anywhere fails here until an
    // owner is declared below AND that owner resolves the account.
    const rows = t.sqlite
      .prepare(
        `SELECT m.name AS tbl FROM sqlite_master m
         JOIN pragma_table_info(m.name) p
         WHERE m.type = 'table' AND p.name = 'account_id'
         ORDER BY m.name`,
      )
      .all() as { tbl: string }[];

    expect(rows.map((r) => r.tbl)).toEqual(Object.keys(OWNERS).sort());
  });

  /**
   * The gap that hid D-1 and D-2 for a release, pinned so it cannot reopen.
   *
   * The scan above only checks files that are ALREADY declared, so a writer
   * nobody listed is invisible to it — which is exactly what happened:
   * app/api/settings/route.ts wrote capital_snapshots and both ledger routes
   * wrote ledger_entries, none of them declared, so none of them scanned.
   *
   * This asserts the reverse direction for the writers this audit corrected: a
   * file that calls .insert/.update/.delete on the table MUST be declared for
   * it. Deliberately scoped to these four rather than swept repo-wide — the
   * v3.7 audit inventoried SIX further undeclared writers across other tables
   * (app/settings/actions.ts and lib/db/seed-core.ts on capital_snapshots;
   * lib/corporate-actions-apply.ts, lib/queries/delete.ts and lib/trash.ts on
   * ledger_entries; app/api/playbooks/route.ts on trading_sessions), and some
   * of those legitimately never resolve an account. Enumerating them is
   * recorded debt, not approval; widening this scan is its own change.
   */
  const MUST_BE_DECLARED: [string, string, string][] = [
    ["capital_snapshots", "capitalSnapshots", "app/api/settings/route.ts"],
    ["ledger_entries", "ledgerEntries", "app/api/ledger/route.ts"],
    ["ledger_entries", "ledgerEntries", "app/api/import/ledger/route.ts"],
    ["trading_sessions", "tradingSessions", "app/api/sessions/route.ts"],
  ];

  it("a route that writes an account-scoped table directly is declared as its owner", async () => {
    const fs = await import("node:fs");
    for (const [tbl, symbol, rel] of MUST_BE_DECLARED) {
      const src = fs.readFileSync(rel, "utf8");
      // Plain substring, not a regex: `db.insert(x)`, `tx.insert(x)` and a
      // line-broken `.insert(x)` all contain the same seven-plus characters.
      const writes = ["insert(", "update(", "delete("].some((op) => src.includes(op + symbol));
      expect(writes, `${rel} no longer writes ${tbl} — drop it from MUST_BE_DECLARED`).toBe(true);
      expect(
        OWNERS[tbl],
        `${rel} writes ${tbl} directly but is not declared as an owner — that omission is why defects D-1/D-2 went unscanned`,
      ).toContain(rel);
    }
  });

  /**
   * THE REVERSE DIRECTION FOR broker_connections (v4.2 fix B-9).
   *
   * `MUST_BE_DECLARED` above is the reverse scan for WRITERS, and it is
   * deliberately a hand-kept list of four. That left the READERS of
   * broker_connections unscanned in the same way, and the live feed then grew
   * five of them — `app/api/live/feed/route.ts`, and the four quote adapters —
   * without one being declared. Every one reads a stored API key and answers a
   * screen with it, so an unscoped one would price account #2's book from
   * account #1's broker session, and the registry's memo would cache the
   * answer.
   *
   * So for THIS table the scan is exhaustive rather than enumerated: every file
   * under lib/ and app/ that reads the table must be declared, or must be
   * listed below as a deliberate whole-database reader with the reason stated.
   *
   * "Reads the table" is a LIST OF SHAPES, not one literal (round-3 audit,
   * C-8). The scan used to match the single string `.from(brokerConnections)`,
   * which is blind to four ways this codebase already reaches the same rows —
   * so a reader written in any of them would be exactly as unscanned as the
   * five the B-9 fix found, and the hole B-9 closed would be reopened by the
   * matcher rather than by the registry. Every shape below either EXISTS in
   * lib/ or app/ today or is free to write tomorrow:
   *
   *   • the query builder, with or without a namespace prefix
   *     (`.from(brokerConnections)`, `.from(schema.brokerConnections)`);
   *   • the table object interpolated into a `sql` template —
   *     lib/queries/account-delete.ts does it in two joins;
   *   • a table-map entry walked by a generic dump — lib/backup.ts's
   *     `TABLE_MAP`, driven by `BACKUP_TABLES` in lib/backup-format.ts;
   *   • the relational API `db.query.brokerConnections`, enabled by
   *     `drizzle(sqlite, { schema })` in lib/db/index.ts — zero uses today,
   *     and nothing stops the next one;
   *   • raw SQL naming the table.
   *
   * The SAME list is duplicated in the S7 seam (tests/seams-v42-fix2.test.ts),
   * which recomputes this property from the filesystem independently of these
   * lists. It is duplicated on purpose: there is no shared helper under
   * tests/helpers/ that holds it, and putting one there would make the seam
   * import from the guard it exists to check. Change one, change the other.
   */
  const BROKER_CONN_READERS: readonly (readonly [string, RegExp])[] = [
    ["query builder", /\.from\(\s*(?:[A-Za-z_$][\w$]*\.)?brokerConnections\s*\)/],
    ["sql template", /\$\{\s*(?:[A-Za-z_$][\w$]*\.)?brokerConnections\s*\}/],
    ["table map", /\bbroker_connections\s*:\s*(?:[A-Za-z_$][\w$]*\.)?brokerConnections\b/],
    ["relational api", /\.query\s*\.\s*brokerConnections\b/],
    ["raw sql", /\bfrom\s+broker_connections\b/i],
  ];
  const readsBrokerConnections = (src: string): boolean => BROKER_CONN_READERS.some(([, re]) => re.test(src));

  /**
   * Source with comments stripped. A file's prose header may NAME
   * `getSelectedAccountId()` while calling nothing — lib/queries/account-delete.ts
   * says the words three times to explain why it does not use it — and a
   * mention in a comment is not a filter.
   */
  const codeOnly = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

  const BROKER_CONN_WHOLE_DB: Record<string, string> = {
    // Sweeps EVERY account's connections once per day: a commit lands in each
    // row's own account, and the aggregate view must not hide another book's
    // eligible broker. Documented at the call site.
    "lib/jobs/auto-pull.ts": "daily auto-pull sweeps every account's connections by design",
    // The rival check spans every account by definition: an account filter
    // would hide the very row that makes a second connection a duplicate.
    "lib/import/broker-identity.ts": "the rival check spans every account by definition",
    // Re-encrypts plaintext secrets in place, keyed on the row id. An account
    // filter here would leave another book's key readable on disk.
    "lib/vault.ts": "the plaintext-secret sweep re-encrypts every row by id",
    // Walks TABLE_MAP over BACKUP_TABLES and dumps every row of every table.
    // Account-scoping a backup would make restore lossy: a backup dump is
    // every row in every account, which is exactly why AGENTS.md forbids
    // comparing a page count against one.
    "lib/backup.ts": "the whole-database dump is every row in every account, by definition",
  };

  /**
   * A declared owner that scopes on an EXPLICIT, validated account id rather
   * than the selected one. It is NOT a whole-database reader — it touches one
   * account — so it belongs in OWNERS; but `accountId > 0 ? filter : all` is
   * not its rule. Its own header states why: the account being deleted or
   * merged is almost never the account being viewed, and getSelectedAccountId
   * is request-cached, so resolving it mid-delete could hand back the id the
   * transaction is removing. Target validation mirrors getWriteAccountId
   * (integer > 0, present in the accounts table) instead.
   */
  const BROKER_CONN_EXPLICIT_ID: Record<string, string> = {
    "lib/queries/account-delete.ts": "the account is an explicit validated parameter, never the selected one",
  };

  const walk = (fs: typeof import("node:fs"), dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(fs, p, out);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  };

  it("every reader of broker_connections is declared as its owner", async () => {
    const fs = await import("node:fs");
    const readers = ["lib", "app"]
      .flatMap((d) => walk(fs, d))
      .filter((rel) => readsBrokerConnections(fs.readFileSync(rel, "utf8")))
      .sort();
    // A floor: a sweep that finds nothing passes for the wrong reason. Eleven,
    // not the nine the one-literal matcher saw — the `sql` template in
    // lib/queries/account-delete.ts and lib/backup.ts's TABLE_MAP are the two
    // it was blind to.
    expect(readers.length, "no file reads broker_connections — has the table been renamed?").toBeGreaterThanOrEqual(
      11,
    );
    // …and every shape in the list is a shape this repo really contains, so a
    // regex that stops matching anything is a dead rung and says so here
    // rather than by quietly shrinking the set. The relational API is the one
    // exception: it is enabled and unused, and is here to catch the first use.
    const bySrc = readers.map((rel) => fs.readFileSync(rel, "utf8"));
    for (const [label, re] of BROKER_CONN_READERS) {
      if (label === "relational api" || label === "raw sql") continue;
      expect(
        bySrc.some((src) => re.test(src)),
        `the "${label}" rung of BROKER_CONN_READERS matches nothing under lib/ or app/ — it is a dead regex, and a dead regex is how C-8 happened`,
      ).toBe(true);
    }
    for (const rel of readers) {
      if (rel in BROKER_CONN_WHOLE_DB) {
        // A deliberate whole-database reader must STAY one. The moment it
        // resolves the selected account it is an ordinary owner and belongs in
        // the registry, under the scan below.
        expect(
          /getSelectedAccountId\(\)/.test(codeOnly(fs.readFileSync(rel, "utf8"))),
          `${rel} now resolves the selected account — declare it as a broker_connections owner`,
        ).toBe(false);
        continue;
      }
      expect(
        OWNERS.broker_connections,
        `${rel} reads broker_connections but is not declared as an owner — an undeclared reader is never scanned for invariant 8`,
      ).toContain(rel);
    }
  });

  it("every broker_connections reader resolves the account AND applies the aggregate rule", async () => {
    const fs = await import("node:fs");
    const scanned = OWNERS.broker_connections.filter((rel) => readsBrokerConnections(fs.readFileSync(rel, "utf8")));
    // Floor: the five readers fix B-9 declared, the two that were there, and
    // lib/queries/account-delete.ts — a declared owner all along, whose `sql`
    // template the one-literal matcher never saw.
    expect(scanned.length, "the declared owners no longer read the table").toBeGreaterThanOrEqual(8);
    for (const rel of scanned) {
      const src = codeOnly(fs.readFileSync(rel, "utf8"));
      if (rel in BROKER_CONN_EXPLICIT_ID) {
        // It must STAY explicit. The moment it resolves an account for itself
        // it is an ordinary owner and the aggregate rule below applies to it.
        expect(
          /getSelectedAccountId\(\)|getWriteAccountId\(/.test(src),
          `${rel} now resolves an account for itself — drop it from BROKER_CONN_EXPLICIT_ID and let the rule below apply`,
        ).toBe(false);
        continue;
      }
      // A CALL, not the word: `codeOnly` has already dropped the comments,
      // because a mention in a prose header is not a filter.
      const reads = /getSelectedAccountId\(\)/.test(src);
      const writes = /getWriteAccountId\(/.test(src);
      expect(reads || writes, `${rel} reads broker_connections without resolving an account (invariant 8)`).toBe(true);
      if (reads) {
        expect(
          /\b(?:accountId|selected|selectedAccountId)\s*>\s*0\b/.test(src),
          `${rel} resolves the account but never applies \`> 0 ? filter : all\` — id 0 is a view (invariant 9)`,
        ).toBe(true);
      }
    }
  });

  it("every declared owner actually resolves the account", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const [tbl, files] of Object.entries(OWNERS)) {
      for (const rel of files) {
        const full = path.join(process.cwd(), rel);
        expect(fs.existsSync(full), `${tbl}: owner file ${rel} is gone — re-point the registry`).toBe(true);
        const src = fs.readFileSync(full, "utf8");
        expect(
          /getSelectedAccountId|getWriteAccountId/.test(src),
          `${tbl}: ${rel} touches an account-scoped table but never resolves the account (invariant 8)`,
        ).toBe(true);
      }
    }
  });
});
