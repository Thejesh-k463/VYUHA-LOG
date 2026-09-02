import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { DHAN_TOTP_CONSENT_VERSION } from "@/components/import/broker-connect";

/**
 * Three server-side guards on the broker route, asserted at the ROUTE — the
 * openalgo-gate.test.ts discipline: the client's checkbox/affordance is a
 * courtesy, anyone can POST, so every claim here goes through
 * `app/api/import/broker/route.ts` and checks status code AND database.
 *
 *  1. Dhan PIN+TOTP consent gate: storing the pair without an explicit
 *     `dhanTotpConsent: true` in the request is refused (400, nothing stored);
 *     with it, the ack VERSION is stamped into auth_json — and a legacy blob
 *     without the stamp is treated as NOT enrolled (mint skipped, pasted-token
 *     fallback, auto-pull ineligible — the latter pinned in auto-pull.test.ts).
 *  2. A re-save with no extras PRESERVES the stored auth_json instead of
 *     silently wiping the enrollment; removal is only the explicit
 *     `clearAuth: true`.
 *  3. The Kite session exchange verifies WHOSE session it minted: the first
 *     exchange stamps user_id into auth_json, a later mismatch refuses (409)
 *     with both ids masked, and nothing is pulled or cached for the wrong user.
 *
 * NO NETWORK: fetch is stubbed to throw file-wide; tests that need a broker
 * response re-stub with fixtures. ONE temp database per file; the route is
 * imported dynamically after openTempDb.
 */

// The commit path calls revalidatePath, which throws outside a Next request.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// Pins the vault wrap so the save path behaves the same on Windows and CI.
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let route: typeof import("@/app/api/import/broker/route");
let vault: typeof import("@/lib/vault");

beforeAll(async () => {
  t = await openTempDb("broker-auth-gate", { seed: true });
  route = await import("@/app/api/import/broker/route");
  vault = await import("@/lib/vault");
});
afterAll(() => {
  vi.unstubAllGlobals();
  t?.cleanup();
});

beforeEach(() => {
  t.sqlite.prepare("DELETE FROM broker_connections").run();
  vi.stubGlobal("fetch", () => {
    throw new Error("TEST GUARD: the route reached the network");
  });
});
afterEach(() => vi.unstubAllGlobals());

const SECRET = "JBSWY3DPEHPK3PXP"; // valid base32 (the docs' example secret)

function post(body: unknown): Promise<Response> {
  return route.POST(
    new Request("http://localhost/api/import/broker", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const connections = () =>
  t.sqlite.prepare("SELECT broker, api_key, access_token, auth_json FROM broker_connections").all() as {
    broker: string;
    api_key: string;
    access_token: string;
    auth_json: string | null;
  }[];

/** Decrypt a stored column, failing the test loudly if the vault cannot. */
function decrypt(stored: string | null): string {
  const read = vault.readSecret(stored);
  if (!read.ok) throw new Error(`expected readable ciphertext, got: ${read.reason}`);
  return read.value;
}

/** Pre-vault plaintext rows read fine through readSecret — the documented
 *  compatibility path, and what lets a LEGACY-shaped row be seeded directly. */
function seedPlaintextConn(broker: string, accessToken: string, authJson: Record<string, unknown> | null) {
  t.sqlite
    .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json) VALUES (1, ?, 'client-id', ?, ?)")
    .run(broker, accessToken, authJson ? JSON.stringify(authJson) : null);
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ---------------------------------------------------------------------------
// 1. The Dhan PIN+TOTP consent gate
// ---------------------------------------------------------------------------

describe("Dhan PIN+TOTP save is refused by the SERVER without the consent flag", () => {
  const DHAN_SAVE = { action: "save", broker: "dhan", apiKey: "1000000009", pin: "123456", totpSecret: SECRET };

  it("400s and stores NOTHING when dhanTotpConsent is absent — red-on-revert for the route gate", async () => {
    const res = await post(DHAN_SAVE);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; message: string };
    expect(json.ok).toBe(false);
    expect(json.message).toMatch(/consent/i);
    expect(connections()).toHaveLength(0);
  });

  it("refuses a truthy-but-not-true flag — only the literal `true` is an acknowledgement", async () => {
    for (const bad of ["true", 1, "yes"]) {
      const res = await post({ ...DHAN_SAVE, dhanTotpConsent: bad });
      expect(res.status, `dhanTotpConsent=${JSON.stringify(bad)}`).toBe(400);
    }
    expect(connections()).toHaveLength(0);
  });

  // POSITIVE CONTROL + the version stamp: without this, the refusals above
  // would also pass on a route that rejected every Dhan save outright.
  it("with dhanTotpConsent: true, stores the blob WITH totpAckVersion — equal to the component's consent version", async () => {
    const res = await post({ ...DHAN_SAVE, dhanTotpConsent: true });
    expect(res.status).toBe(200);
    const rows = connections();
    expect(rows).toHaveLength(1);
    const auth = JSON.parse(decrypt(rows[0].auth_json)) as { pin: string; totpSecret: string; totpAckVersion: number };
    expect(auth.pin).toBe("123456");
    expect(auth.totpSecret).toBe(SECRET);
    // The route cannot import the "use client" component, so it keeps its own
    // DHAN_TOTP_ACK_VERSION — this is the pin that stops the two drifting.
    expect(auth.totpAckVersion).toBe(DHAN_TOTP_CONSENT_VERSION);
  });

  it("a token-only Dhan save (no PIN/TOTP) still needs no consent flag", async () => {
    const res = await post({ action: "save", broker: "dhan", apiKey: "1000000009", accessToken: "pasted-24h-token" });
    expect(res.status).toBe(200);
    expect(connections()[0].auth_json).toBeNull();
  });
});

describe("a LEGACY dhan blob (pin+totp, no recorded consent) is not enrolled at pull time", () => {
  it("skips the mint and pulls with the pasted token instead", async () => {
    seedPlaintextConn("dhan", "pasted-token", { pin: "123456", totpSecret: SECRET }); // no totpAckVersion
    const hosts: string[] = [];
    let sentToken: string | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      hosts.push(u.host);
      sentToken = (init?.headers as Record<string, string>)?.["access-token"];
      return jsonResponse(200, []);
    });
    const res = await post({ action: "pull", broker: "dhan", mode: "preview" });
    expect(res.status).toBe(200);
    // Red-on-revert: before the enrollment check, this pull minted from the
    // un-consented pin+totp — auth.dhan.co would appear first in this list.
    expect(hosts).toEqual(["api.dhan.co"]);
    expect(sentToken).toBe("pasted-token");
  });

  it("with no pasted token either, 400s naming the re-consent way out — never a silent mint", async () => {
    seedPlaintextConn("dhan", "", { pin: "123456", totpSecret: SECRET });
    const res = await post({ action: "pull", broker: "dhan", mode: "preview" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { message: string };
    expect(json.message).toMatch(/without the recorded consent.*re-save|consent checkbox/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Re-save preserves the stored enrollment; clearAuth removes it
// ---------------------------------------------------------------------------

describe("'Update connection' preserves stored auth extras instead of wiping them", () => {
  it("a token-only dhan re-save keeps the PIN+TOTP enrollment intact", async () => {
    expect(
      (await post({ action: "save", broker: "dhan", apiKey: "1000000009", pin: "123456", totpSecret: SECRET, dhanTotpConsent: true })).status,
    ).toBe(200);
    // The daily gesture this bug punished: paste a fresh 24h token, save.
    const res = await post({ action: "save", broker: "dhan", apiKey: "1000000009", accessToken: "fresh-24h-token" });
    expect(res.status).toBe(200);
    const rows = connections();
    expect(rows).toHaveLength(1);
    // Red-on-revert: the unconditional `authJson: encAuth` upsert nulls this.
    expect(rows[0].auth_json).not.toBeNull();
    const auth = JSON.parse(decrypt(rows[0].auth_json)) as { pin: string; totpAckVersion: number };
    expect(auth.pin).toBe("123456");
    expect(auth.totpAckVersion).toBe(DHAN_TOTP_CONSENT_VERSION);
    expect(decrypt(rows[0].access_token)).toBe("fresh-24h-token");
  });

  it("a token-only zerodha re-save keeps the api_secret", async () => {
    expect(
      (await post({ action: "save", broker: "zerodha", apiKey: "kitekey123", apiSecret: "apisecret789" })).status,
    ).toBe(200);
    const res = await post({ action: "save", broker: "zerodha", apiKey: "kitekey123", accessToken: "days-token" });
    expect(res.status).toBe(200);
    const auth = JSON.parse(decrypt(connections()[0].auth_json)) as { apiSecret: string };
    expect(auth.apiSecret).toBe("apisecret789");
  });

  it("clearAuth: true removes the enrollment deliberately — credentials untouched", async () => {
    expect(
      (await post({ action: "save", broker: "dhan", apiKey: "1000000009", pin: "123456", totpSecret: SECRET, dhanTotpConsent: true })).status,
    ).toBe(200);
    const res = await post({ action: "save", broker: "dhan", clearAuth: true });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toMatch(/enrollment removed/i);
    const rows = connections();
    expect(rows).toHaveLength(1);
    expect(rows[0].auth_json).toBeNull();
    expect(decrypt(rows[0].api_key)).toBe("1000000009"); // the row survived; only the extras went
  });

  it("credential-less clearAuth is refused for brokers whose blob IS the connection, and when nothing is saved", async () => {
    expect((await post({ action: "save", broker: "angelone", clearAuth: true })).status).toBe(400);
    expect((await post({ action: "save", broker: "dhan", clearAuth: true })).status).toBe(400); // no row yet
  });

  it("angelone is unaffected — its full-trio save overwrites the blob as before", async () => {
    const save = (pin: string) =>
      post({ action: "save", broker: "angelone", apiKey: "smartapi-key", clientCode: "A123456", pin, totpSecret: SECRET });
    expect((await save("1111")).status).toBe(200);
    expect((await save("2222")).status).toBe(200);
    const auth = JSON.parse(decrypt(connections()[0].auth_json)) as { pin: string };
    expect(auth.pin).toBe("2222"); // overwritten, never "preserved" over new extras
  });
});

// ---------------------------------------------------------------------------
// 3. The Kite session exchange is bound to ONE Zerodha ID
// ---------------------------------------------------------------------------

describe("Kite exchange stamps and verifies WHOSE session it minted", () => {
  /** Stub the two Kite endpoints; records which were called this interaction. */
  function stubKite(userId: string, accessToken = "days-token") {
    const paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(String(url));
      paths.push(u.pathname);
      if (u.pathname === "/session/token") {
        return jsonResponse(200, { status: "success", data: { access_token: accessToken, user_id: userId } });
      }
      if (u.pathname === "/trades") return jsonResponse(200, { status: "success", data: [] });
      throw new Error(`unexpected fetch: ${url}`);
    });
    return paths;
  }

  const saveZerodha = () => post({ action: "save", broker: "zerodha", apiKey: "kitekey123", apiSecret: "apisecret789" });
  const pullWith = (requestToken: string) => post({ action: "pull", broker: "zerodha", mode: "preview", requestToken });
  const storedAuth = () => JSON.parse(decrypt(connections()[0].auth_json)) as { apiSecret: string; kiteUserId?: string };

  it("the FIRST successful exchange stamps kiteUserId into auth_json (apiSecret kept)", async () => {
    expect((await saveZerodha()).status).toBe(200);
    expect(storedAuth().kiteUserId).toBeUndefined(); // nothing stamped at save
    stubKite("AB1234", "tok1");
    const res = await pullWith("rt1");
    expect(res.status).toBe(200);
    expect(storedAuth()).toEqual({ apiSecret: "apisecret789", kiteUserId: "AB1234" });
    expect(decrypt(connections()[0].access_token)).toBe("tok1"); // day's token cached as before
  });

  it("a mismatched login refuses with both ids masked to their last 2 chars, pulls nothing, caches nothing", async () => {
    expect((await saveZerodha()).status).toBe(200);
    stubKite("AB1234", "tok1");
    expect((await pullWith("rt1")).status).toBe(200); // bound to AB1234

    const paths = stubKite("ZX9999", "tok2");
    const res = await pullWith("rt2");
    expect(res.status).toBe(409);
    const json = (await res.json()) as { ok: boolean; kiteUserMismatch?: boolean; message: string };
    expect(json.ok).toBe(false);
    expect(json.kiteUserMismatch).toBe(true);
    // Both ids named, masked — recognisable to their owner, not leaked whole.
    expect(json.message).toContain("••••34");
    expect(json.message).toContain("••••99");
    expect(json.message).not.toContain("AB1234");
    expect(json.message).not.toContain("ZX9999");
    // Red-on-revert: never proceed with the pull — /trades untouched, and the
    // wrong account's session token must not be cached over the right one.
    expect(paths).toEqual(["/session/token"]);
    expect(storedAuth().kiteUserId).toBe("AB1234");
    expect(decrypt(connections()[0].access_token)).toBe("tok1");
  });

  it("a matching login proceeds normally", async () => {
    expect((await saveZerodha()).status).toBe(200);
    stubKite("AB1234", "tok1");
    expect((await pullWith("rt1")).status).toBe(200);
    const paths = stubKite("AB1234", "tok3");
    expect((await pullWith("rt3")).status).toBe(200);
    expect(paths).toEqual(["/session/token", "/trades"]);
    expect(decrypt(connections()[0].access_token)).toBe("tok3");
  });

  it("a legacy connection with no stored id gets stamped on its next exchange", async () => {
    // A row saved before the check existed: apiSecret only, plaintext (pre-vault).
    seedPlaintextConn("zerodha", "", { apiSecret: "apisecret789" });
    stubKite("CD5678", "tok1");
    expect((await pullWith("rt1")).status).toBe(200);
    expect(storedAuth().kiteUserId).toBe("CD5678");
  });
});
