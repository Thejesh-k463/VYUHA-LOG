import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * Four route-level hardenings on app/api/import/broker/route.ts (owner
 * rulings 2026-09-04), asserted the broker-auth-gate.test.ts way — through
 * the handlers, checking status, payload AND database:
 *
 *  3. An auth_json blob that is stored but cannot be read is REPORTED
 *     (GET: hasAuth false + authUnreadable true + a typed warning) and a pull
 *     REFUSES with the same flag — never a silent fallback to the pasted
 *     token. Dhan and Zerodha both.
 *  4. An empty `apiKey` on a re-save keeps the stored Client ID / API key
 *     ciphertext byte-for-byte; a non-empty one still replaces it; an empty
 *     key with no saved row is still refused. An enrolment save stamps
 *     totpAckVersion.
 *  5. GET carries `authMode` and `tokenExpiresAt` — and no secret material.
 *  7. Two accounts: B's pasted-token save leaves A's enrolment untouched, and
 *     a save naming B from the All-accounts view (selected 0) writes B only.
 *
 * NO NETWORK: fetch is stubbed to throw file-wide. ONE temp database per
 * file; the route is imported dynamically after openTempDb.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let route: typeof import("@/app/api/import/broker/route");
let vault: typeof import("@/lib/vault");

const PRIMARY = 1; // seeded
const SWING = 2;
const ALL = 0;
const SECRET = "JBSWY3DPEHPK3PXP";
const CLIENT = "1000000009";

/** A structurally valid JWT with a chosen exp claim (seconds OR milliseconds). */
const fakeJwt = (exp: number) => ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".");

beforeAll(async () => {
  t = await openTempDb("broker-route-hardening", { seed: true });
  route = await import("@/app/api/import/broker/route");
  vault = await import("@/lib/vault");
  t.db.insert(t.schema.accounts).values([{ id: SWING, name: "Swing", isDefault: false }]).run();
});
afterAll(() => {
  vi.unstubAllGlobals();
  t?.cleanup();
});
beforeEach(() => {
  t.sqlite.prepare("DELETE FROM broker_connections").run();
  selectAccount(PRIMARY);
  vi.stubGlobal("fetch", () => {
    throw new Error("TEST GUARD: the route reached the network");
  });
});
afterEach(() => vi.unstubAllGlobals());

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function post(body: unknown): Promise<Response> {
  return route.POST(
    new Request("http://localhost/api/import/broker", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

interface Conn {
  broker: string;
  accountId: number;
  hasAuth: boolean;
  authUnreadable: boolean;
  authWarning: string | null;
  authMode: "totp" | "token" | "none";
  tokenExpiresAt: string | null;
  [k: string]: unknown;
}

async function getConnections(): Promise<{ raw: string; connections: Conn[] }> {
  const res = await route.GET();
  const raw = await res.text();
  return { raw, connections: (JSON.parse(raw) as { connections: Conn[] }).connections };
}

type Row = { account_id: number; broker: string; api_key: string; access_token: string; auth_json: string | null };
const rows = () =>
  t.sqlite.prepare("SELECT account_id, broker, api_key, access_token, auth_json FROM broker_connections ORDER BY account_id, broker").all() as Row[];

function decrypt(stored: string | null): string {
  const read = vault.readSecret(stored);
  if (!read.ok) throw new Error(`expected readable ciphertext, got: ${read.reason}`);
  return read.value;
}

/** Plaintext rows read fine through the vault — how a LEGACY row is seeded. */
function seedPlaintext(accountId: number, broker: string, accessToken: string, authJson: string | null) {
  t.sqlite
    .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json) VALUES (?, ?, ?, ?, ?)")
    .run(accountId, broker, CLIENT, accessToken, authJson);
}

const ENROL = { action: "save", broker: "dhan", apiKey: CLIENT, pin: "123456", totpSecret: SECRET, dhanTotpConsent: true };

// ---------------------------------------------------------------------------
// 3. Unreadable enrolment is surfaced, never silently downgraded
// ---------------------------------------------------------------------------

describe("item 3 — an unreadable auth_json blob", () => {
  it("GET reports hasAuth false + authUnreadable true with the typed warning (red-on-revert: hasAuth was true for any stored bytes)", async () => {
    seedPlaintext(PRIMARY, "dhan", fakeJwt(Math.floor(Date.now() / 1000) + 3600), "not-json{{");
    const { connections } = await getConnections();
    expect(connections).toHaveLength(1);
    const c = connections[0]!;
    expect(c.hasAuth).toBe(false);
    expect(c.authUnreadable).toBe(true);
    expect(c.authWarning).toBe("enrolment stored but unreadable — remove the enrolment and re-enrol");
  });

  it("a readable enrolment reports the opposite — the warning is not a constant", async () => {
    await post(ENROL);
    const { connections } = await getConnections();
    expect(connections[0]!.hasAuth).toBe(true);
    expect(connections[0]!.authUnreadable).toBe(false);
    expect(connections[0]!.authWarning).toBeNull();
  });

  it("a Dhan pull with a garbage blob AND a live pasted token is REFUSED (400, authUnreadable) — no pasted-token fallback, no network", async () => {
    seedPlaintext(PRIMARY, "dhan", fakeJwt(Math.floor(Date.now() / 1000) + 3600), "not-json{{");
    const res = await post({ action: "pull", broker: "dhan", accountId: PRIMARY, mode: "preview" });
    const json = (await res.json()) as { ok: boolean; authUnreadable?: boolean; message: string };
    // Red-on-revert: the old bare catch fell through to the pasted token and
    // hit the network guard → 502 "TEST GUARD".
    expect(res.status).toBe(400);
    expect(json.authUnreadable).toBe(true);
    expect(json.message).toMatch(/PIN \+ TOTP enrolment stored but unreadable/);
    expect(json.message).not.toMatch(/TEST GUARD/);
  });

  it("the Zerodha sibling: a garbage api_secret blob with a pasted token is refused the same way", async () => {
    seedPlaintext(PRIMARY, "zerodha", "kite-token", "[not an object]");
    const res = await post({ action: "pull", broker: "zerodha", accountId: PRIMARY, mode: "preview" });
    const json = (await res.json()) as { ok: boolean; authUnreadable?: boolean; message: string };
    expect(res.status).toBe(400);
    expect(json.authUnreadable).toBe(true);
    expect(json.message).toMatch(/Zerodha API secret enrolment stored but unreadable/);
  });
});

// ---------------------------------------------------------------------------
// 4. Client-ID carry-over
// ---------------------------------------------------------------------------

describe("item 4 — empty apiKey on a re-save keeps the stored key", () => {
  it("the stored api_key ciphertext is byte-identical after a token-only re-save (red-on-revert: 400 'Client ID … required')", async () => {
    expect((await post({ action: "save", broker: "dhan", apiKey: CLIENT, accessToken: "tok-1" })).status).toBe(200);
    const before = rows()[0]!;
    const res = await post({ action: "save", broker: "dhan", apiKey: "", accessToken: "tok-2" });
    expect(res.status).toBe(200);
    const after = rows();
    expect(after).toHaveLength(1);
    expect(after[0]!.api_key).toBe(before.api_key); // the ciphertext itself, not just the plaintext
    expect(decrypt(after[0]!.access_token)).toBe("tok-2"); // and the token really moved
  });

  it("an absent apiKey field (not just empty) carries over too", async () => {
    await post({ action: "save", broker: "dhan", apiKey: CLIENT, accessToken: "tok-1" });
    const before = rows()[0]!.api_key;
    expect((await post({ action: "save", broker: "dhan", accessToken: "tok-3" })).status).toBe(200);
    expect(rows()[0]!.api_key).toBe(before);
  });

  it("a non-empty apiKey still REPLACES the stored one", async () => {
    await post({ action: "save", broker: "dhan", apiKey: CLIENT, accessToken: "tok-1" });
    const before = rows()[0]!.api_key;
    expect((await post({ action: "save", broker: "dhan", apiKey: "2000000001", accessToken: "tok-2" })).status).toBe(200);
    expect(rows()[0]!.api_key).not.toBe(before);
    expect(decrypt(rows()[0]!.api_key)).toBe("2000000001");
  });

  it("an empty apiKey with NO saved row is still refused, storing nothing", async () => {
    const res = await post({ action: "save", broker: "dhan", apiKey: "", accessToken: "tok-1" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/Client ID/);
    expect(rows()).toHaveLength(0);
  });

  it("carry-over also works for an enrolment re-save, and the enrolment save stamps totpAckVersion", async () => {
    await post({ action: "save", broker: "dhan", apiKey: CLIENT, accessToken: "tok-1" });
    const before = rows()[0]!.api_key;
    expect((await post({ ...ENROL, apiKey: "" })).status).toBe(200);
    const r = rows()[0]!;
    expect(r.api_key).toBe(before);
    const auth = JSON.parse(decrypt(r.auth_json)) as { totpAckVersion?: number };
    expect(auth.totpAckVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. authMode + tokenExpiresAt, and no secret material in the payload
// ---------------------------------------------------------------------------

describe("item 5 — the GET projection's mode fields", () => {
  it("a pasted JWT → authMode 'token' with its exp as ISO (seconds AND milliseconds normalise to the same instant)", async () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    await post({ action: "save", broker: "dhan", apiKey: CLIENT, accessToken: fakeJwt(expSec), accountId: PRIMARY });
    await post({ action: "save", broker: "dhan", apiKey: CLIENT, accessToken: fakeJwt(expSec * 1000), accountId: SWING });
    selectAccount(ALL);
    const { connections } = await getConnections();
    const iso = new Date(expSec * 1000).toISOString();
    expect(connections.map((c) => [c.accountId, c.authMode, c.tokenExpiresAt])).toEqual([
      [PRIMARY, "token", iso],
      [SWING, "token", iso], // red-on-revert on the ms fix: exp*1000 lands ~50,000 years out
    ]);
  });

  it("a non-JWT pasted token → 'token' with tokenExpiresAt null; enrolment → 'totp'; nothing → 'none'", async () => {
    await post({ action: "save", broker: "dhan", apiKey: CLIENT, accessToken: "opaque-token", accountId: PRIMARY });
    await post({ ...ENROL, accountId: SWING });
    seedPlaintext(PRIMARY, "zerodha", "", null);
    selectAccount(ALL);
    const { connections } = await getConnections();
    const by = (a: number, b: string) => connections.find((c) => c.accountId === a && c.broker === b)!;
    expect([by(PRIMARY, "dhan").authMode, by(PRIMARY, "dhan").tokenExpiresAt]).toEqual(["token", null]);
    expect(by(SWING, "dhan").authMode).toBe("totp");
    expect(by(PRIMARY, "zerodha").authMode).toBe("none");
  });

  it("the payload carries NO secret material — no access_token/api_key/auth_json keys, no plaintext values", async () => {
    const token = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    await post({ ...ENROL, accessToken: token });
    const { raw, connections } = await getConnections();
    for (const c of connections) {
      for (const k of ["access_token", "api_key", "auth_json", "accessToken", "apiKey", "authJson", "pin", "totpSecret"]) {
        expect(Object.keys(c), `key ${k} leaked`).not.toContain(k);
      }
    }
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(CLIENT); // only the mask
    expect(raw).not.toContain("123456");
  });
});

// ---------------------------------------------------------------------------
// 7. Two accounts
// ---------------------------------------------------------------------------

describe("item 7 — two-account enrolment preservation", () => {
  it("B's pasted-token save leaves A's auth_json and totpAckVersion untouched", async () => {
    expect((await post({ ...ENROL, accountId: PRIMARY })).status).toBe(200);
    const a0 = rows().find((r) => r.account_id === PRIMARY)!;
    expect((await post({ action: "save", broker: "dhan", apiKey: "2000000001", accessToken: "tok-b", accountId: SWING })).status).toBe(200);
    const all = rows();
    expect(all.map((r) => r.account_id)).toEqual([PRIMARY, SWING]);
    const a1 = all.find((r) => r.account_id === PRIMARY)!;
    expect(a1.auth_json).toBe(a0.auth_json); // ciphertext untouched
    expect(a1.api_key).toBe(a0.api_key);
    expect((JSON.parse(decrypt(a1.auth_json)) as { totpAckVersion: number }).totpAckVersion).toBe(1);
    expect(all.find((r) => r.account_id === SWING)!.auth_json).toBeNull();
  });

  it("from the All-accounts view (selected 0), a save naming B writes B and creates no row for any other account", async () => {
    await post({ ...ENROL, accountId: PRIMARY });
    selectAccount(ALL);
    expect((await post({ action: "save", broker: "dhan", apiKey: "2000000001", accessToken: "tok-b", accountId: SWING })).status).toBe(200);
    // And a re-save naming B again UPDATES B — no second row anywhere.
    expect((await post({ action: "save", broker: "dhan", apiKey: "", accessToken: "tok-b2", accountId: SWING })).status).toBe(200);
    const all = rows();
    expect(all.map((r) => r.account_id)).toEqual([PRIMARY, SWING]);
    expect(decrypt(all.find((r) => r.account_id === SWING)!.access_token)).toBe("tok-b2");
    expect(all.find((r) => r.account_id === PRIMARY)!.auth_json).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. A KEPT api_key must still be READABLE (v3.8.0 fix wave, finder 3 item 2)
// ---------------------------------------------------------------------------

/** Real vault ciphertext with a segment lopped off: prefixed, so readSecret
 *  reports it UNREADABLE rather than treating it as a plaintext legacy key. */
function brokenCiphertext(): string {
  return vault.encryptSecret(CLIENT).split(":").slice(0, 4).join(":");
}

function seedBrokenKey(accountId: number, broker: string) {
  t.sqlite
    .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json) VALUES (?, ?, ?, ?, NULL)")
    .run(accountId, broker, brokenCiphertext(), "tok-1");
}

describe("item 8 — carrying over an UNDECRYPTABLE stored key", () => {
  it("is refused 400 STORED_KEY_UNREADABLE naming the Client ID, and nothing is written", async () => {
    seedBrokenKey(PRIMARY, "dhan");
    const before = rows()[0]!;

    const res = await post({ action: "save", broker: "dhan", apiKey: "", accessToken: "tok-2" });

    // Red-on-revert: `encKey = apiKey ? … : existing!.apiKey` carried the
    // undecryptable ciphertext forward and answered 200 "Connection saved" —
    // and the next pull then 400s "saved credentials cannot be read".
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code?: string; message: string };
    expect(json.code).toBe("STORED_KEY_UNREADABLE");
    expect(json.message).toMatch(/re-enter the Client ID/i);
    // The save really did nothing — the token was not moved either.
    expect(rows()[0]!.access_token).toBe(before.access_token);
  });

  it("re-entering the key is the way out: the same save with a real Client ID succeeds", async () => {
    seedBrokenKey(PRIMARY, "dhan");
    expect((await post({ action: "save", broker: "dhan", apiKey: CLIENT, accessToken: "tok-2" })).status).toBe(200);
    expect(decrypt(rows()[0]!.api_key)).toBe(CLIENT);
  });

  it("a READABLE stored key still carries over — the guard is not a blanket refusal", async () => {
    await post({ action: "save", broker: "dhan", apiKey: CLIENT, accessToken: "tok-1" });
    const before = rows()[0]!.api_key;
    expect((await post({ action: "save", broker: "dhan", apiKey: "", accessToken: "tok-2" })).status).toBe(200);
    expect(rows()[0]!.api_key).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 9. The audit mask reveals a PROPORTION (v3.8.0 fix wave, finder 3 item 5)
// ---------------------------------------------------------------------------

const lastAuditSummary = () =>
  (t.sqlite.prepare("SELECT summary AS s FROM audit_log ORDER BY id DESC LIMIT 1").get() as { s: string } | undefined)?.s ?? "";

describe("item 9 — masking a credential for the audit log", () => {
  it("an 8-character key reveals 2 characters, not half of it", async () => {
    expect((await post({ action: "save", broker: "dhan", apiKey: "ABCD1234", accessToken: "tok-1" })).status).toBe(200);
    const s = lastAuditSummary();
    // Red-on-revert: the fixed 4-character prefix wrote "ABCD…" — 50% of an
    // 8-character credential (the length of a real Angel One API key).
    expect(s).toContain("AB…");
    expect(s).not.toContain("ABCD");
  });

  it("a 10-character key reveals 3, and nothing ever reveals more than 4", async () => {
    expect((await post({ action: "save", broker: "dhan", apiKey: CLIENT, accessToken: "tok-1" })).status).toBe(200);
    expect(lastAuditSummary()).toContain(`${CLIENT.slice(0, 3)}…`);
    expect(lastAuditSummary()).not.toContain(CLIENT.slice(0, 4));

    const long = "ABCDEFGHIJKLMNOPQRST";
    expect((await post({ action: "save", broker: "dhan", apiKey: long, accessToken: "tok-1" })).status).toBe(200);
    expect(lastAuditSummary()).toContain("ABCD…");
    expect(lastAuditSummary()).not.toContain("ABCDE");
  });

  it("a credential too short to mask proportionally reveals NOTHING", async () => {
    // The last-two tail is 40% of a 5-character secret and 67% of a
    // 3-character one — a leak dressed as a hint. Below 6 characters the mask
    // is bullets alone. Red-on-revert: the `••••` + slice(-2) rule wrote
    // "••••cd" for "abcd" and "••••de" for "abcde".
    for (const key of ["abc", "abcd", "abcde"]) {
      expect((await post({ action: "save", broker: "dhan", apiKey: key, accessToken: "tok-1" })).status).toBe(200);
      const s = lastAuditSummary();
      expect(s, key).toContain("••••");
      expect(s, key).not.toContain(key.slice(-2));
      expect(s, key).not.toContain("…");
    }
  });

  it("a kept key is still audited as 'kept', never as a mask of something", async () => {
    await post({ action: "save", broker: "dhan", apiKey: CLIENT, accessToken: "tok-1" });
    await post({ action: "save", broker: "dhan", apiKey: "", accessToken: "tok-2" });
    expect(lastAuditSummary()).toMatch(/key kept/);
  });
});
