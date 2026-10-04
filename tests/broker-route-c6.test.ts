import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v4.7.0 wave C6 — the WIRING of the three native read-only pulls (Fyers,
 * Kotak Neo, Nuvama) in app/api/import/broker/route.ts, asserted through the
 * handlers the broker-route-hardening.test.ts way: status, payload AND the
 * database, with fetch stubbed per URL so A's real modules run underneath.
 *
 *  - consent (review R6): stamped ONLY when the client sends the sheet's
 *    CURRENT version; a save without a current stored ack, and a pull with a
 *    stale one, are 409 `needsConsent` — the pull before any network call;
 *  - mergeAuth (R5): a re-save keeps the stamped identity and a current ack,
 *    a pull stamp keeps the ack;
 *  - identity (R7): Fyers fy_id / Nuvama userID stamped at the first login, a
 *    different id refused (409 *UserMismatch), and the rival check runs BEFORE
 *    the stamp, the token cache and the trade fetch;
 *  - typed expiry (R8): BrokerAuthExpired → 409 needsAuthCode / needsLogin and
 *    the cached token/session cleared — never the 502 path.
 *
 * ONE temp database per file; the route is imported dynamically.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const seam = vi.hoisted(() => ({
  rival: null as { accountId: number; accountName: string } | null,
  spy: null as ((input: Record<string, unknown>) => void) | null,
}));
vi.mock("@/lib/import/broker-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/import/broker-identity")>();
  return {
    ...actual,
    findRivalConnection: (input: Record<string, unknown>) => {
      seam.spy?.(input);
      return seam.rival;
    },
  };
});
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let route: typeof import("@/app/api/import/broker/route");
let vault: typeof import("@/lib/vault");

const PRIMARY = 1;
const SECRET = "JBSWY3DPEHPK3PXP";
const APP_ID = "ABCD1234-100";

beforeAll(async () => {
  t = await openTempDb("broker-route-c6", { seed: true });
  route = await import("@/app/api/import/broker/route");
  vault = await import("@/lib/vault");
});
afterAll(() => {
  vi.unstubAllGlobals();
  t?.cleanup();
});

/** Every URL the route asked for, in order. */
let hits: string[] = [];
/** Per-test answers, by path suffix → [status, body, headers?]. Unknown → throw. */
let answers: Array<[RegExp, () => { status: number; body: unknown; headers?: Record<string, string> }]> = [];

beforeEach(() => {
  t.sqlite.prepare("DELETE FROM broker_connections").run();
  t.sqlite.prepare("DELETE FROM trades").run();
  t.db.update(t.schema.settings).set({ selectedAccountId: PRIMARY }).run();
  seam.rival = null;
  seam.spy = null;
  hits = [];
  answers = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    const key = `${u.host}${u.pathname}`;
    hits.push(key);
    const hit = answers.find(([re]) => re.test(key));
    if (!hit) throw new Error(`TEST GUARD: unexpected network call ${key}`);
    const a = hit[1]();
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json", ...(a.headers ?? {}) } });
  });
});
afterEach(() => vi.unstubAllGlobals());

function post(body: unknown): Promise<Response> {
  return route.POST(
    new Request("http://localhost/api/import/broker", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

type Row = { id: number; broker: string; api_key: string; access_token: string; auth_json: string | null };
const row = (broker: string) =>
  t.sqlite.prepare("SELECT id, broker, api_key, access_token, auth_json FROM broker_connections WHERE broker = ?").get(broker) as Row | undefined;

const plain = (stored: string | null | undefined): string => {
  const r = vault.readSecret(stored);
  return r.ok ? r.value : "";
};
const authOf = (broker: string): Record<string, unknown> => JSON.parse(plain(row(broker)?.auth_json) || "null") ?? {};

/** Seed a connection through the vault, as a save would have left it. */
function seed(broker: string, apiKey: string, auth: Record<string, unknown>, accessToken = "") {
  t.sqlite
    .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json) VALUES (?, ?, ?, ?, ?)")
    .run(PRIMARY, broker, vault.encryptSecret(apiKey), vault.encryptSecret(accessToken), vault.encryptSecret(JSON.stringify(auth)));
}

const FYERS_SAVE = { action: "save", broker: "fyers", apiKey: APP_ID, apiSecret: "fyers-secret" };
const KOTAK_SAVE = {
  action: "save",
  broker: "kotakneo",
  apiKey: "kotak-trade-api-token",
  mobileNumber: "9999999999",
  ucc: "xab12",
  mpin: "123456",
  totpSecret: SECRET,
};
const NUVAMA_SAVE = { action: "save", broker: "nuvama", apiKey: "nv-api-key", apiSecret: "nv-secret" };
const CONSENT = { pullConsent: { version: 1 } };

const future = () => new Date(Date.now() + 3 * 3600_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

const fyersOk = (extra: Record<string, unknown>) => () => ({ status: 200, body: { s: "ok", code: 200, message: "", ...extra } });

// ---------------------------------------------------------------------------
// Consent (R6)
// ---------------------------------------------------------------------------

describe("consent — stamped only for the CURRENT version, refused otherwise (R6)", () => {
  it("a first save with no consent is a 409 needsConsent carrying the version, and NOTHING is stored", async () => {
    const res = await post(FYERS_SAVE);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, needsConsent: true, version: 1 });
    expect(row("fyers")).toBeUndefined();
  });

  it("consent theatre is refused: version 0, 2 or the STRING '1' does not stamp (and does not save)", async () => {
    for (const version of [0, 2, "1", null]) {
      const res = await post({ ...FYERS_SAVE, pullConsent: { version } });
      expect(res.status, `version ${String(version)}`).toBe(409);
      expect(row("fyers"), `version ${String(version)}`).toBeUndefined();
    }
  });

  it("the shown CURRENT version is stamped into auth_json as pullAckVersion", async () => {
    const res = await post({ ...FYERS_SAVE, ...CONSENT });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(authOf("fyers")).toEqual({ apiSecret: "fyers-secret", pullAckVersion: 1 });
  });

  it("a re-save with a stale stored ack and no new consent is refused, and the row is untouched", async () => {
    seed("fyers", APP_ID, { apiSecret: "old", pullAckVersion: 0 });
    const before = row("fyers");
    const res = await post({ ...FYERS_SAVE, apiKey: "" });
    expect(res.status).toBe(409);
    expect((await res.json()).needsConsent).toBe(true);
    expect(row("fyers")).toEqual(before);
  });

  it("a pull with a stale ack is a 409 needsConsent BEFORE any network call — every C6 broker", async () => {
    seed("fyers", APP_ID, { apiSecret: "s", pullAckVersion: 0 });
    seed("kotakneo", "tok", { ucc: "XAB12", mobileNumber: "9999999999", mpin: "123456", totpSecret: SECRET });
    seed("nuvama", "nv", { apiSecret: "s", pullAckVersion: 2 });
    for (const broker of ["fyers", "kotakneo", "nuvama"]) {
      const res = await post({ action: "pull", broker, mode: "preview", authCode: "abcdefgh12", requestId: "req-12345" });
      expect(res.status, broker).toBe(409);
      expect(await res.json(), broker).toMatchObject({ ok: false, needsConsent: true, version: 1 });
    }
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeAuth on the writers (R5)
// ---------------------------------------------------------------------------

describe("mergeAuth — a re-save keeps the stamped identity and a current ack (R5)", () => {
  it("Fyers: fyId + ack survive a re-save that types only a new secret; the cached token and its expiry are cleared", async () => {
    seed("fyers", APP_ID, { apiSecret: "old", fyId: "XA12345", pullAckVersion: 1, tokenExpiresAt: future() }, "cached-token");
    const res = await post({ ...FYERS_SAVE, apiKey: "", apiSecret: "new-secret" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(authOf("fyers")).toEqual({ apiSecret: "new-secret", fyId: "XA12345", pullAckVersion: 1 });
    expect(plain(row("fyers")!.access_token)).toBe("");
  });

  it("Nuvama: nuvamaUserId survives a consent-only re-save", async () => {
    seed("nuvama", "nv", { apiSecret: "s", nuvamaUserId: "55501234" });
    const res = await post({ action: "save", broker: "nuvama", apiKey: "", ...CONSENT });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(authOf("nuvama")).toEqual({ apiSecret: "s", nuvamaUserId: "55501234", pullAckVersion: 1 });
  });

  it("the save's rival check sees the KEPT identity (the merged blob), not only what was typed", async () => {
    seed("fyers", APP_ID, { apiSecret: "old", fyId: "XA12345", pullAckVersion: 1 });
    let seen: Record<string, unknown> | null = null;
    seam.spy = (input) => (seen = input);
    await post({ ...FYERS_SAVE, apiKey: "", apiSecret: "new" });
    expect(JSON.parse(String(seen!.authJson))).toMatchObject({ fyId: "XA12345" });
  });
});

// ---------------------------------------------------------------------------
// Save validation (packAuth)
// ---------------------------------------------------------------------------

describe("packAuth — validated at save, with a message naming the field", () => {
  it("Fyers and Nuvama need the secret on a first save", async () => {
    for (const body of [{ ...FYERS_SAVE, apiSecret: "" }, { ...NUVAMA_SAVE, apiSecret: "" }]) {
      const res = await post({ ...body, ...CONSENT });
      expect(res.status).toBe(400);
      expect((await res.json()).message).toMatch(/secret/i);
    }
  });

  it("Kotak: a 6-digit MPIN and a base32 TOTP SECRET (not the 6-digit code), else 400", async () => {
    const bad = [
      [{ mpin: "1234" }, /MPIN/],
      [{ totpSecret: "123456" }, /TOTP secret/],
      [{ mobileNumber: "12" }, /mobile/i],
      [{ ucc: "" }, /UCC/],
    ] as const;
    for (const [over, re] of bad) {
      const res = await post({ ...KOTAK_SAVE, ...over, ...CONSENT });
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect((await res.json()).message).toMatch(re);
    }
    const ok = await post({ ...KOTAK_SAVE, ...CONSENT });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(authOf("kotakneo")).toEqual({ mobileNumber: "9999999999", ucc: "XAB12", mpin: "123456", totpSecret: SECRET, pullAckVersion: 1 });
  });
});

// ---------------------------------------------------------------------------
// Fyers pull
// ---------------------------------------------------------------------------

describe("Fyers pull — the daily paste, identity, cache, typed expiry", () => {
  const ACKED = { apiSecret: "fyers-secret", pullAckVersion: 1 };

  it("no cached token and no paste → 409 needsAuthCode + a login URL, before any network call", async () => {
    seed("fyers", APP_ID, ACKED);
    const res = await post({ action: "pull", broker: "fyers", mode: "preview" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, needsAuthCode: true });
    const login = new URL(body.loginUrl);
    expect(`${login.host}${login.pathname}`).toBe("api-t1.fyers.in/api/v3/generate-authcode");
    expect(login.searchParams.get("client_id")).toBe(APP_ID);
    expect(login.searchParams.get("redirect_uri")).toBe("https://127.0.0.1/");
    expect(login.searchParams.get("state")).toMatch(/^[0-9a-f-]{16,}$/);
    expect(hits).toEqual([]);
  });

  it("a paste that carries no auth_code is a 400 naming what to paste, before any network call", async () => {
    seed("fyers", APP_ID, ACKED);
    const res = await post({ action: "pull", broker: "fyers", mode: "preview", authCode: "https://127.0.0.1/?s=ok&state=x" });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/auth_code/);
    expect(hits).toEqual([]);
  });

  it("a paste → exchange → profile → trade book; fyId + token cached until the IST day ends, the ack KEPT across the stamp", async () => {
    seed("fyers", APP_ID, ACKED);
    answers = [
      [/validate-authcode$/, fyersOk({ access_token: "day-token" })],
      [/\/profile$/, fyersOk({ data: { fy_id: "XA12345" } })],
      [/\/tradebook$/, fyersOk({ tradeBook: [] })],
    ];
    const res = await post({ action: "pull", broker: "fyers", mode: "preview", authCode: "https://127.0.0.1/?s=ok&code=200&auth_code=eyJ.abc.def&state=x" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(hits).toEqual(["api-t1.fyers.in/api/v3/validate-authcode", "api-t1.fyers.in/api/v3/profile", "api-t1.fyers.in/api/v3/tradebook"]);
    const a = authOf("fyers");
    expect(a).toMatchObject({ apiSecret: "fyers-secret", fyId: "XA12345", pullAckVersion: 1 });
    expect(plain(row("fyers")!.access_token)).toBe("day-token");
    const exp = Date.parse(String(a.tokenExpiresAt));
    expect(exp).toBeGreaterThan(Date.now());
    expect(exp - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    // The instant the IST day ends: one millisecond earlier is still today in India.
    const { todayIstIso } = await import("@/lib/domain/trading-day");
    expect(todayIstIso(new Date(exp - 1))).toBe(todayIstIso());
    expect(todayIstIso(new Date(exp))).not.toBe(todayIstIso());
  });

  it("a cached token still inside its day is used with no paste and no login call", async () => {
    seed("fyers", APP_ID, { ...ACKED, fyId: "XA12345", tokenExpiresAt: future() }, "cached-token");
    answers = [[/\/tradebook$/, fyersOk({ tradeBook: [] })]];
    const res = await post({ action: "pull", broker: "fyers", mode: "preview" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(hits).toEqual(["api-t1.fyers.in/api/v3/tradebook"]);
  });

  it("a cached token past its expiry is not used — the pull asks for today's login", async () => {
    seed("fyers", APP_ID, { ...ACKED, tokenExpiresAt: past() }, "stale-token");
    const res = await post({ action: "pull", broker: "fyers", mode: "preview" });
    expect(res.status).toBe(409);
    expect((await res.json()).needsAuthCode).toBe(true);
    expect(hits).toEqual([]);
  });

  it("a login for a DIFFERENT Fyers client is refused (fyersUserMismatch) — no token cached, no trade fetched", async () => {
    seed("fyers", APP_ID, { ...ACKED, fyId: "XA12345" });
    answers = [
      [/validate-authcode$/, fyersOk({ access_token: "day-token" })],
      [/\/profile$/, fyersOk({ data: { fy_id: "XB99999" } })],
    ];
    const res = await post({ action: "pull", broker: "fyers", mode: "preview", authCode: "eyJ.abc.def" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.fyersUserMismatch).toBe(true);
    expect(body.message).not.toContain("XB99999");
    expect(hits).not.toContain("api-t1.fyers.in/api/v3/tradebook");
    expect(plain(row("fyers")!.access_token)).toBe("");
    expect(authOf("fyers").fyId).toBe("XA12345");
  });

  it("R7: the rival check runs BEFORE the stamp, the token cache and the trade fetch, with the pull-time onlyOlderThan", async () => {
    seed("fyers", APP_ID, ACKED);
    const id = row("fyers")!.id;
    answers = [
      [/validate-authcode$/, fyersOk({ access_token: "day-token" })],
      [/\/profile$/, fyersOk({ data: { fy_id: "XA12345" } })],
    ];
    let atCall: { token: string; auth: Record<string, unknown>; input: Record<string, unknown> } | null = null;
    seam.spy = (input) => (atCall = { token: plain(row("fyers")!.access_token), auth: authOf("fyers"), input });
    seam.rival = { accountId: 2, accountName: "Swing" };
    const res = await post({ action: "pull", broker: "fyers", mode: "preview", authCode: "eyJ.abc.def" });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toMatch(/already connected in account "Swing"/);
    expect(atCall!.token).toBe(""); // nothing cached yet
    expect(atCall!.auth.fyId).toBeUndefined(); // nothing stamped yet
    expect(atCall!.input.onlyOlderThan).toBe(id);
    expect(JSON.parse(String(atCall!.input.authJson)).fyId).toBe("XA12345");
    // …and after the refusal: still nothing cached, nothing stamped, no trade book read.
    expect(hits).not.toContain("api-t1.fyers.in/api/v3/tradebook");
    expect(plain(row("fyers")!.access_token)).toBe("");
    expect(authOf("fyers").fyId).toBeUndefined();
  });

  it("R8: a dead cached token (Fyers code -16) is a 409 needsAuthCode, never a 502 — and the cache is CLEARED, identity and ack kept", async () => {
    seed("fyers", APP_ID, { ...ACKED, fyId: "XA12345", tokenExpiresAt: future() }, "cached-token");
    answers = [[/\/tradebook$/, () => ({ status: 200, body: { s: "error", code: -16, message: "Could not authenticate the user" } })]];
    const res = await post({ action: "pull", broker: "fyers", mode: "preview" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, needsAuthCode: true });
    expect(body.loginUrl).toContain("generate-authcode");
    expect(plain(row("fyers")!.access_token)).toBe("");
    expect(authOf("fyers")).toEqual({ ...ACKED, fyId: "XA12345" });
  });

  it("a plain broker refusal (not a session end) stays the 502 path", async () => {
    seed("fyers", APP_ID, { ...ACKED, tokenExpiresAt: future() }, "cached-token");
    answers = [[/\/tradebook$/, () => ({ status: 500, body: { s: "error", code: -99, message: "boom" } })]];
    const res = await post({ action: "pull", broker: "fyers", mode: "preview" });
    expect(res.status).toBe(502);
    expect(plain(row("fyers")!.access_token)).toBe("cached-token");
  });
});

// ---------------------------------------------------------------------------
// Kotak Neo pull
// ---------------------------------------------------------------------------

describe("Kotak Neo pull — TOTP + MPIN at every pull, nothing cached", () => {
  const KOTAK_AUTH = { ucc: "XAB12", mobileNumber: "9999999999", mpin: "123456", totpSecret: SECRET, pullAckVersion: 1 };
  const kotakLoginAnswers = (): typeof answers => [
    [/\/tradeApiLogin$/, () => ({ status: 200, body: { data: { token: "view-token", sid: "view-sid" } } })],
    [/\/tradeApiValidate$/, () => ({ status: 200, body: { data: { token: "trade-token", sid: "trade-sid", baseUrl: "https://cis.kotaksecurities.com" } } })],
  ];

  it("logs in, validates the MPIN, reads the trade book — and stores no session", async () => {
    seed("kotakneo", "kotak-trade-api-token", KOTAK_AUTH);
    answers = [...kotakLoginAnswers(), [/\/quick\/user\/trades$/, () => ({ status: 200, body: { stat: "Ok", stCode: 200, data: [] } })]];
    const res = await post({ action: "pull", broker: "kotakneo", mode: "preview" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(hits).toEqual([
      "mis.kotaksecurities.com/login/1.0/tradeApiLogin",
      "mis.kotaksecurities.com/login/1.0/tradeApiValidate",
      "cis.kotaksecurities.com/quick/user/trades",
    ]);
    expect(plain(row("kotakneo")!.access_token)).toBe("");
    const body = await res.json();
    expect(body.warnings.join(" ")).toMatch(/documented, not yet verified with a real account/);
  });

  it("R8: an ended session (HTTP 401) is a 409 needsLogin with no login URL, never a 502", async () => {
    seed("kotakneo", "kotak-trade-api-token", KOTAK_AUTH);
    answers = [...kotakLoginAnswers(), [/\/quick\/user\/trades$/, () => ({ status: 401, body: { stat: "Not_Ok", emsg: "Invalid session" } })]];
    const res = await post({ action: "pull", broker: "kotakneo", mode: "preview" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, needsLogin: true });
    expect(body.loginUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Nuvama pull
// ---------------------------------------------------------------------------

describe("Nuvama pull — the pasted requestId, the cached session, typed expiry", () => {
  const ACKED = { apiSecret: "nv-secret", pullAckVersion: 1 };
  const nuvamaLoginAnswers = (userId: string): typeof answers => [
    [/loginvendor\/nv-api-key\/$/, () => ({ status: 200, body: { msg: "vendor-session" } })],
    [/logindata\/$/, () => ({ status: 200, body: { data: { auth: "auth-token", lgnData: { accTyp: "EQ", accs: { eqAccID: userId } } } }, headers: { AppIdKey: "key-from-login" } })],
  ];

  it("no session and no paste → 409 needsLogin + Nuvama's login URL, before any network call", async () => {
    seed("nuvama", "nv-api-key", ACKED);
    const res = await post({ action: "pull", broker: "nuvama", mode: "preview" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, needsLogin: true });
    expect(body.loginUrl).toBe("https://www.nuvamawealth.com/api-connect/login?api_key=nv-api-key");
    expect(hits).toEqual([]);
  });

  it("a paste → login → trade book (222 = empty); the WHOLE session cached as one vault entry, userId stamped, expiry ≤ 8 h", async () => {
    seed("nuvama", "nv-api-key", ACKED);
    answers = [...nuvamaLoginAnswers("55501234"), [/tradebook\/v1\/55501234\/$/, () => ({ status: 222, body: { msg: "ETRD0002" }, headers: { AppIdKey: "key-from-book" } })]];
    const res = await post({ action: "pull", broker: "nuvama", mode: "preview", requestId: "https://127.0.0.1/?requestId=req-12345" });
    expect(res.status, await res.clone().text()).toBe(200);
    const session = JSON.parse(plain(row("nuvama")!.access_token));
    expect(session).toMatchObject({ auth: "auth-token", sourceToken: "vendor-session", userId: "55501234" });
    // A Nuvama answer's AppIdKey replaces the session's, and the session is RE-SAVED after the pull (R11').
    expect(session.appIdKey).toBe("key-from-book");
    const a = authOf("nuvama");
    expect(a).toMatchObject({ ...ACKED, nuvamaUserId: "55501234" });
    const exp = Date.parse(String(a.tokenExpiresAt));
    expect(exp).toBeGreaterThan(Date.now());
    expect(exp - Date.now()).toBeLessThanOrEqual(8 * 3600_000 + 5_000);
  });

  it("a cached session is used with no login call", async () => {
    const session = { auth: "auth-token", sourceToken: "vendor-session", userId: "55501234", appIdKey: null, accTyp: "EQ" };
    seed("nuvama", "nv-api-key", { ...ACKED, nuvamaUserId: "55501234", tokenExpiresAt: future() }, JSON.stringify(session));
    answers = [[/tradebook\/v1\/55501234\/$/, () => ({ status: 200, body: { data: { trade: [] } } })]];
    const res = await post({ action: "pull", broker: "nuvama", mode: "preview" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(hits).toEqual(["nc.nuvamawealth.com/edelmw-eq/eq/tradebook/v1/55501234/"]);
  });

  it("a login for a DIFFERENT Nuvama user is refused (nuvamaUserMismatch) before the session is cached", async () => {
    seed("nuvama", "nv-api-key", { ...ACKED, nuvamaUserId: "55501234" });
    answers = nuvamaLoginAnswers("55509999");
    const res = await post({ action: "pull", broker: "nuvama", mode: "preview", requestId: "req-12345" });
    expect(res.status).toBe(409);
    expect((await res.json()).nuvamaUserMismatch).toBe(true);
    expect(plain(row("nuvama")!.access_token)).toBe("");
    expect(hits.some((h) => h.includes("tradebook"))).toBe(false);
  });

  it("R7: the rival check runs before the session is cached or the trade book read", async () => {
    seed("nuvama", "nv-api-key", ACKED);
    answers = nuvamaLoginAnswers("55501234");
    let tokenAtCall: string | null = null;
    seam.spy = () => (tokenAtCall = plain(row("nuvama")!.access_token));
    seam.rival = { accountId: 2, accountName: "Swing" };
    const res = await post({ action: "pull", broker: "nuvama", mode: "preview", requestId: "req-12345" });
    expect(res.status).toBe(409);
    expect(tokenAtCall).toBe("");
    expect(plain(row("nuvama")!.access_token)).toBe("");
    expect(authOf("nuvama").nuvamaUserId).toBeUndefined();
    expect(hits.some((h) => h.includes("tradebook"))).toBe(false);
  });

  it("R8: 'Session Expired' (EGN0011) clears the cached session and answers 409 needsLogin + loginUrl", async () => {
    const session = { auth: "auth-token", sourceToken: "vendor-session", userId: "55501234", appIdKey: null, accTyp: "EQ" };
    seed("nuvama", "nv-api-key", { ...ACKED, nuvamaUserId: "55501234", tokenExpiresAt: future() }, JSON.stringify(session));
    answers = [[/tradebook/, () => ({ status: 401, body: { error: { errCd: "EGN0011", errMsg: "Session Expired" } } })]];
    const res = await post({ action: "pull", broker: "nuvama", mode: "preview" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, needsLogin: true });
    expect(body.loginUrl).toContain("api-connect/login");
    expect(plain(row("nuvama")!.access_token)).toBe("");
    expect(authOf("nuvama")).toEqual({ ...ACKED, nuvamaUserId: "55501234" });
  });
});

// ---------------------------------------------------------------------------
// Snapshot pulls + GET
// ---------------------------------------------------------------------------

describe("each C6 pull restates today's book — a later pull REPLACES the earlier snapshot", () => {
  it("Fyers: two commits the same day leave ONE row for the position, at the later quantity", async () => {
    seed("fyers", APP_ID, { apiSecret: "s", pullAckVersion: 1, fyId: "XA12345", tokenExpiresAt: future() }, "cached-token");
    const fill = (qty: number) => ({ symbol: "NSE:SBIN-EQ", side: 1, tradedQty: qty, tradePrice: 800, productType: "CNC", exchange: 10, segment: 10 });
    let book = [fill(5)];
    answers = [[/\/tradebook$/, () => fyersOk({ tradeBook: book })()]];
    const first = await post({ action: "pull", broker: "fyers", mode: "commit" });
    expect(first.status, await first.clone().text()).toBe(200);
    book = [fill(5), fill(3)];
    const second = await post({ action: "pull", broker: "fyers", mode: "commit" });
    expect(second.status, await second.clone().text()).toBe(200);
    const rows = t.sqlite.prepare("SELECT buy_qty AS q, source_file AS f FROM trades WHERE symbol = 'SBIN'").all() as { q: number; f: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.q).toBe(8);
    expect(rows[0]!.f).toMatch(/^fyers-api-\d{4}-\d{2}-\d{2}$/);
  });
});

describe("GET — per C6 connection: pullAckCurrent, tokenExpiresAt, unverified; never a secret", () => {
  it("projects the three fields and no secret material", async () => {
    const exp = future();
    seed("fyers", APP_ID, { apiSecret: "fyers-secret", pullAckVersion: 1, fyId: "XA12345", tokenExpiresAt: exp }, "cached-token");
    seed("kotakneo", "kotak-trade-api-token", { ucc: "XAB12", mobileNumber: "9999999999", mpin: "123456", totpSecret: SECRET, pullAckVersion: 0 });
    const res = await route.GET();
    const raw = await res.text();
    const conns = (JSON.parse(raw) as { connections: Record<string, unknown>[] }).connections;
    const fy = conns.find((c) => c.broker === "fyers")!;
    const ko = conns.find((c) => c.broker === "kotakneo")!;
    expect(fy).toMatchObject({ pullAckCurrent: true, unverified: true, tokenExpiresAt: exp });
    expect(ko).toMatchObject({ pullAckCurrent: false, unverified: true });
    for (const s of ["fyers-secret", "cached-token", "XA12345", "123456", SECRET, "kotak-trade-api-token", "9999999999"]) {
      expect(raw, s).not.toContain(s);
    }
  });
});
