import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * Broker connections across accounts (invariants 8 and 9).
 *
 * The bug this pins down: GET /api/import/broker resolved the account as
 * `getSelectedAccountId() || 1`, so the All-accounts view (0) collapsed to
 * account 1 — every other account's saved connections simply vanished from the
 * Import page, and a POST from that view WROTE to a hard-coded account 1.
 * The listing now lives in lib/queries/broker-connections.ts with the
 * sanctioned `accountId > 0 ? filter : all` shape, and writes resolve through
 * getWriteAccountId.
 */

let t: TempDb;
let listBrokerConnections: typeof import("@/lib/queries/broker-connections")["listBrokerConnections"];
let accountsQ: typeof import("@/lib/queries/accounts");

const PRIMARY = 1; // seeded
const SWING = 2; // no connections — proves absence is preserved, not invented
const OPTIONS = 3;
const ALL = 0;

/** Point the app at an account, the way the sidebar switcher does. */
function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

beforeAll(async () => {
  t = await openTempDb("broker-conn", { seed: true });
  ({ listBrokerConnections } = await import("@/lib/queries/broker-connections"));
  accountsQ = await import("@/lib/queries/accounts");

  t.db.insert(t.schema.accounts).values([
    { id: SWING, name: "Swing", isDefault: false },
    { id: OPTIONS, name: "Options", isDefault: false },
  ]).run();

  // Plaintext credentials read fine through the vault (pre-v2.99.80 rows do
  // exactly this), so the test needs no machine-bound key.
  t.db.insert(t.schema.brokerConnections).values([
    { accountId: PRIMARY, broker: "zerodha", apiKey: "key-primary", accessToken: "tok-primary" },
    { accountId: OPTIONS, broker: "zerodha", apiKey: "key-options", accessToken: "tok-options" },
    // A LEGACY bare-"openalgo" row on account 3: the GET-time rename must
    // re-key on this row's id, never on the resolved account.
    {
      accountId: OPTIONS,
      broker: "openalgo",
      apiKey: "key-oa",
      accessToken: "",
      authJson: JSON.stringify({ host: "http://127.0.0.1:5000", underlyingBroker: "groww" }),
    },
  ]).run();
});

afterAll(() => t?.cleanup());

describe("listing scope — accountId > 0 ? filter : all", () => {
  it("the All-accounts view lists every account's connections, not account 1's", () => {
    selectAccount(ALL);
    const { aggregate, rows } = listBrokerConnections();
    expect(aggregate).toBe(true);
    const zerodha = rows.filter((r) => r.broker === "zerodha");
    expect(zerodha.map((r) => r.accountId).sort()).toEqual([OPTIONS, PRIMARY].sort());
    // Account names ride along so the client can label each connection.
    expect(zerodha.map((r) => r.accountName).sort()).toEqual(["Options", "Primary"]);
  });

  it("the legacy openalgo rename is keyed on the row, and lands in ITS account", () => {
    // The aggregate listing above already ran the migration; assert on the DB.
    const oa = t.db.select().from(t.schema.brokerConnections).all().filter((r) => r.broker.startsWith("openalgo"));
    expect(oa).toHaveLength(1);
    expect(oa[0].broker).toBe("openalgo:groww");
    expect(oa[0].accountId).toBe(OPTIONS); // never migrated onto another account
    // And nothing legacy is left behind for a later GET to re-migrate.
    selectAccount(ALL);
    expect(listBrokerConnections().rows.filter((r) => r.broker === "openalgo")).toHaveLength(0);
  });

  it("a specific selection returns only its own connections", () => {
    selectAccount(PRIMARY);
    let res = listBrokerConnections();
    expect(res.aggregate).toBe(false);
    expect(res.rows.map((r) => [r.accountId, r.broker])).toEqual([[PRIMARY, "zerodha"]]);

    selectAccount(OPTIONS);
    res = listBrokerConnections();
    expect(res.rows.every((r) => r.accountId === OPTIONS)).toBe(true);
    expect(res.rows.map((r) => r.broker).sort()).toEqual(["openalgo:groww", "zerodha"]);

    selectAccount(SWING);
    expect(listBrokerConnections().rows).toEqual([]);
  });
});

describe("write resolution — the POST path's account (invariant 9)", () => {
  it("All-accounts never writes to a synthetic or hard-coded account", () => {
    selectAccount(ALL);
    // The route resolves `getWriteAccountId(body.accountId)`; with no explicit
    // id in the aggregate view there is NO fallback (v3.8) — the helper throws
    // and the route answers 400 `code: "ACCOUNT_REQUIRED"`.
    expect(() => accountsQ.getWriteAccountId()).toThrow(accountsQ.AccountRequiredError);
    expect(() => accountsQ.getWriteAccountId(0)).toThrow(accountsQ.AccountRequiredError);
  });

  it("an explicit account (the connection row's own, or the picker's) wins", () => {
    selectAccount(ALL);
    expect(accountsQ.getWriteAccountId(OPTIONS)).toBe(OPTIONS);
    expect(accountsQ.getWriteAccountId(SWING)).toBe(SWING);
  });

  it("a bogus explicit account falls back to a real one instead of being trusted", () => {
    selectAccount(PRIMARY);
    expect(accountsQ.getWriteAccountId(999)).toBe(PRIMARY);
  });
});
