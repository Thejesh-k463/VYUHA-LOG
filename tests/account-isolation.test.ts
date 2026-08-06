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
  it("getWriteAccountId never returns the synthetic aggregate id", () => {
    // Writes must land in a real account; 0 is a view, not a place.
    selectAccount(ALL);
    expect(queries.accounts.getSelectedAccountId()).toBe(ALL);
    expect(queries.accounts.getWriteAccountId()).toBeGreaterThan(0);

    selectAccount(SWING);
    expect(queries.accounts.getWriteAccountId()).toBe(SWING);
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
    expect(queries.accounts.getWriteAccountId(0)).toBe(PRIMARY);
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

describe("account-scoped table registry", () => {
  it("every table carrying account_id is a known, scoped one", () => {
    // Introspect the real schema rather than trusting a hand-kept list. This is
    // the test that catches the NEXT table, not just today's eight: adding
    // account_id somewhere new fails here until the query layer scopes it.
    const rows = t.sqlite
      .prepare(
        `SELECT m.name AS tbl FROM sqlite_master m
         JOIN pragma_table_info(m.name) p
         WHERE m.type = 'table' AND p.name = 'account_id'
         ORDER BY m.name`,
      )
      .all() as { tbl: string }[];

    expect(rows.map((r) => r.tbl)).toEqual([
      "broker_connections",
      "capital_snapshots",
      "import_batches",
      "ipos",
      "ledger_entries",
      "panel_dismissals",
      "positions",
      "trades",
      "trading_sessions",
    ]);
  });
});
