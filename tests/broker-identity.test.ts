import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * B4 — the same broker CLIENT must not be connected under two accounts
 * (v4.2.1, owner ruling R4a).
 *
 * `broker_connections` is unique on (account_id, broker) only, so account #1
 * and account #2 could each hold a connection to the SAME Dhan client. Both
 * then pull the same tradebook, and because the dedup hash carries no account
 * id and its unique index is per account, every trade lands twice — once in
 * each book — and the All-accounts view sums both copies.
 *
 * Two properties are pinned hard here. First, the identity is the CLIENT and
 * never the rotating token, and for Zerodha/Angel One it is not the app's API
 * key either: one Kite Connect app can log in several clients, so an api_key
 * comparison would refuse a second, genuinely different account with no way
 * around it. Second, NOTHING this module hands back may carry the plaintext
 * identifier — an answer names an ACCOUNT, and a listing carries only the same
 * masked form the Import screen already shows.
 */

let t: TempDb;
let bi: typeof import("@/lib/import/broker-identity");

const PRIMARY = 1;
const SWING = 2;

/** Long enough that `maskSecret` reveals a proportional prefix rather than
 *  bullets alone — the shape the Import screen shows beside a stored key. */
const DHAN_CLIENT = "1100112233";
const OTHER_DHAN_CLIENT = "1100999888";

beforeAll(async () => {
  t = await openTempDb("broker-identity", { seed: true });
  bi = await import("@/lib/import/broker-identity");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();
});

afterAll(() => t?.cleanup());

beforeEach(() => {
  t.db.delete(t.schema.brokerConnections).run();
});

function connect(over: {
  accountId: number;
  broker: string;
  apiKey: string;
  authJson?: string | null;
  accessToken?: string;
}) {
  t.db
    .insert(t.schema.brokerConnections)
    .values({
      accountId: over.accountId,
      broker: over.broker,
      apiKey: over.apiKey,
      accessToken: over.accessToken ?? "token-of-the-day",
      authJson: over.authJson ?? null,
    })
    .run();
}

describe("findRivalConnection — the same client under a second account", () => {
  it("names the account that already holds this Dhan client", () => {
    connect({ accountId: PRIMARY, broker: "dhan", apiKey: DHAN_CLIENT });

    const rival = bi.findRivalConnection({ broker: "dhan", apiKey: DHAN_CLIENT, authJson: null, accountId: SWING });

    expect(rival).not.toBeNull();
    expect(rival!.accountId).toBe(PRIMARY);
    expect(rival!.accountName).toBe("Primary");
  });

  it("is not a rival of itself — re-saving the same connection is allowed", () => {
    connect({ accountId: PRIMARY, broker: "dhan", apiKey: DHAN_CLIENT });

    expect(
      bi.findRivalConnection({ broker: "dhan", apiKey: DHAN_CLIENT, authJson: null, accountId: PRIMARY }),
    ).toBeNull();
  });

  it("lets a DIFFERENT client of the same broker connect", () => {
    connect({ accountId: PRIMARY, broker: "dhan", apiKey: DHAN_CLIENT });

    expect(
      bi.findRivalConnection({ broker: "dhan", apiKey: OTHER_DHAN_CLIENT, authJson: null, accountId: SWING }),
    ).toBeNull();
  });

  it("never puts the plaintext identifier in what it hands back", () => {
    connect({ accountId: PRIMARY, broker: "dhan", apiKey: DHAN_CLIENT });

    const rival = bi.findRivalConnection({ broker: "dhan", apiKey: DHAN_CLIENT, authJson: null, accountId: SWING });

    // The whole answer, serialised — an added field cannot smuggle the id past
    // a key-by-key check.
    const serialised = JSON.stringify(rival);
    expect(serialised).not.toContain(DHAN_CLIENT);
    expect(Object.keys(rival!).sort()).toEqual(["accountId", "accountName"]);
  });

  it("compares within ONE broker — the same string under another broker is another client", () => {
    connect({ accountId: PRIMARY, broker: "dhan", apiKey: DHAN_CLIENT });

    expect(
      bi.findRivalConnection({ broker: "upstox", apiKey: DHAN_CLIENT, authJson: null, accountId: SWING }),
    ).toBeNull();
  });

  it("finds the rival whichever account is looked at, and whichever is selected", () => {
    // The refusal must not be defeated by switching the account switcher: the
    // fact is "this client is already in another book", and an account filter
    // would hide exactly the row that makes it true.
    connect({ accountId: SWING, broker: "dhan", apiKey: DHAN_CLIENT });
    t.db.update(t.schema.settings).set({ selectedAccountId: PRIMARY }).run();

    const rival = bi.findRivalConnection({ broker: "dhan", apiKey: DHAN_CLIENT, authJson: null, accountId: PRIMARY });
    expect(rival?.accountId).toBe(SWING);
    expect(rival?.accountName).toBe("Swing");

    t.db.update(t.schema.settings).set({ selectedAccountId: 0 }).run();
    expect(
      bi.findRivalConnection({ broker: "dhan", apiKey: DHAN_CLIENT, authJson: null, accountId: PRIMARY })?.accountId,
    ).toBe(SWING);
  });

  it("says nothing about an empty or unreadable credential", () => {
    connect({ accountId: PRIMARY, broker: "dhan", apiKey: "" });

    expect(bi.findRivalConnection({ broker: "dhan", apiKey: "", authJson: null, accountId: SWING })).toBeNull();
    expect(
      bi.findRivalConnection({ broker: "dhan", apiKey: DHAN_CLIENT, authJson: null, accountId: SWING }),
    ).toBeNull();
  });
});

describe("findRivalConnection — the identity is the client, not the app key", () => {
  it("Angel One compares the client code, not the SmartAPI key", () => {
    const auth = (clientCode: string) => JSON.stringify({ clientCode, pin: "1234", totpSecret: "JBSWY3DP" });
    connect({ accountId: PRIMARY, broker: "angelone", apiKey: "app-key-shared", authJson: auth("A12345") });

    // Same app key, DIFFERENT client — a second real account, allowed.
    expect(
      bi.findRivalConnection({ broker: "angelone", apiKey: "app-key-shared", authJson: auth("B67890"), accountId: SWING }),
    ).toBeNull();

    // Same client through a different app key — the same person, refused.
    expect(
      bi.findRivalConnection({ broker: "angelone", apiKey: "another-app-key", authJson: auth("A12345"), accountId: SWING })
        ?.accountId,
    ).toBe(PRIMARY);
  });

  it("Zerodha compares the stored kite user id when the connection has one", () => {
    const auth = (kiteUserId: string) => JSON.stringify({ apiSecret: "s3cr3t", kiteUserId });
    connect({ accountId: PRIMARY, broker: "zerodha", apiKey: "kite-app-key", authJson: auth("AB1234") });

    expect(
      bi.findRivalConnection({ broker: "zerodha", apiKey: "kite-app-key", authJson: auth("ZZ9999"), accountId: SWING }),
    ).toBeNull();
    expect(
      bi.findRivalConnection({ broker: "zerodha", apiKey: "kite-app-key", authJson: auth("AB1234"), accountId: SWING })
        ?.accountId,
    ).toBe(PRIMARY);
  });

  it("Zerodha falls back to the API key before any id has been stamped", () => {
    connect({ accountId: PRIMARY, broker: "zerodha", apiKey: "kite-app-key", authJson: null });

    expect(
      bi.findRivalConnection({ broker: "zerodha", apiKey: "kite-app-key", authJson: null, accountId: SWING })?.accountId,
    ).toBe(PRIMARY);
  });

  it("never compares the access token — a new day's token is the same client", () => {
    connect({ accountId: PRIMARY, broker: "dhan", apiKey: DHAN_CLIENT, accessToken: "yesterdays.jwt" });

    expect(
      bi.findRivalConnection({ broker: "dhan", apiKey: DHAN_CLIENT, authJson: null, accountId: SWING })?.accountId,
    ).toBe(PRIMARY);
  });
});

describe("listDuplicateConnections — installs that made the duplicate already", () => {
  it("groups one client across the accounts holding it, masked", () => {
    connect({ accountId: PRIMARY, broker: "dhan", apiKey: DHAN_CLIENT });
    connect({ accountId: SWING, broker: "dhan", apiKey: DHAN_CLIENT });

    const groups = bi.listDuplicateConnections();
    expect(groups).toHaveLength(1);
    expect(groups[0].broker).toBe("dhan");
    expect(groups[0].brokerLabel).toBe("Dhan");
    expect(groups[0].accounts).toEqual([
      { id: PRIMARY, name: "Primary" },
      { id: SWING, name: "Swing" },
    ]);
    expect(groups[0].maskedIdentity).toBe(bi.maskSecret(DHAN_CLIENT));
    expect(groups[0].maskedIdentity).not.toContain(DHAN_CLIENT);
    expect(JSON.stringify(groups)).not.toContain(DHAN_CLIENT);
  });

  it("says nothing about two different clients, or about one account", () => {
    connect({ accountId: PRIMARY, broker: "dhan", apiKey: DHAN_CLIENT });
    connect({ accountId: SWING, broker: "dhan", apiKey: OTHER_DHAN_CLIENT });
    expect(bi.listDuplicateConnections()).toEqual([]);

    t.db.delete(t.schema.brokerConnections).run();
    connect({ accountId: PRIMARY, broker: "dhan", apiKey: DHAN_CLIENT });
    connect({ accountId: PRIMARY, broker: "upstox", apiKey: DHAN_CLIENT });
    expect(bi.listDuplicateConnections()).toEqual([]);
  });
});

describe("the masks are the Import screen's own", () => {
  it("shows a proportional prefix for a stored key and bullets for a short one", () => {
    expect(bi.maskSecret("1100112233")).toBe("110…••••");
    expect(bi.maskSecret("abcde")).toBe("••••");
    expect(bi.maskSecret("1100112233")).not.toContain("1100112233");
  });

  it("shows only the last two characters of a client code", () => {
    expect(bi.maskAccountId("A12345")).toBe("••••45");
    expect(bi.maskAccountId("ab")).toBe("••");
  });
});
