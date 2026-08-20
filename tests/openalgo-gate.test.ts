import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * The OpenAlgo gate, asserted at the ROUTE — not at the pure function.
 *
 * tests/openalgo-disclosure.test.ts already proves `openAlgoGate` returns the
 * right answer. That is a different claim from the one that matters here: that
 * the SERVER acts on it. The Import UI hides the OpenAlgo tab when the gate is
 * closed, and hiding a button is not a control — anyone can POST. So every
 * assertion below goes through `app/api/import/broker/route.ts` and checks the
 * status code AND the database, because a 403 that still wrote a row would be
 * worse than no gate at all.
 *
 * The bad-host / unsupported-broker cases carry a positive control ("a valid
 * save stores…"): without it, every refusal assertion would also pass if the
 * route simply rejected every OpenAlgo save for some unrelated reason.
 *
 * NO NETWORK. `fetch` is stubbed to throw for the whole file, so a route path
 * that reached OpenAlgo would fail loudly rather than hang or hit 127.0.0.1;
 * the one test that legitimately needs a response re-stubs it with a fixture.
 *
 * ONE temp database per FILE (tests/helpers/temp-db.ts), and every import of
 * the route is dynamic and after openTempDb.
 */

// The commit path calls revalidatePath, which throws outside a Next request.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// Pins the vault wrap so the save path behaves the same on Windows and CI.
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let route: typeof import("@/app/api/import/broker/route");
let settingsRoute: typeof import("@/app/api/settings/route");
let vault: typeof import("@/lib/vault");
let CURRENT: string;

beforeAll(async () => {
  t = await openTempDb("openalgo-gate", { seed: true });
  route = await import("@/app/api/import/broker/route");
  settingsRoute = await import("@/app/api/settings/route");
  vault = await import("@/lib/vault");
  CURRENT = (await import("@/lib/domain/openalgo-disclosure")).OPENALGO_DISCLOSURE_VERSION;
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

/** Put the stored consent into a known state. */
function setGate(enabled: boolean, ackVersion: string | null) {
  t.sqlite.prepare("UPDATE settings SET openalgo_enabled = ?, openalgo_ack_version = ?").run(enabled ? 1 : 0, ackVersion);
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

function post(body: unknown): Promise<Response> {
  return route.POST(
    new Request("http://localhost/api/import/broker", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const GOOD_SAVE = {
  action: "save",
  broker: "openalgo",
  apiKey: "oa-secret-key-abcdef",
  host: "127.0.0.1:5000",
  underlyingBroker: "groww",
};

/** Every closed-gate state the pure rule recognises, each with its own reason. */
const CLOSED_STATES: [label: string, enabled: boolean, ack: string | null][] = [
  ["never turned on, never acknowledged", false, null],
  ["off, even though an acknowledgement is on file", false, "CURRENT"],
  ["on, but never acknowledged", true, null],
  ["on, but the acknowledgement is stale", true, "0"],
];

describe("OpenAlgo save is refused by the SERVER while the gate is closed", () => {
  for (const [label, enabled, ack] of CLOSED_STATES) {
    it(`403s and stores nothing — ${label}`, async () => {
      setGate(enabled, ack === "CURRENT" ? CURRENT : ack);
      const res = await post(GOOD_SAVE);
      expect(res.status).toBe(403);
      const json = (await res.json()) as { ok: boolean; message: string };
      expect(json.ok).toBe(false);
      // The user gets the pure function's sentence, not a bare "Forbidden".
      expect(json.message).toMatch(enabled ? /disclosure has changed/i : /is off/i);
      expect(connections()).toHaveLength(0);
    });
  }
});

describe("OpenAlgo pull is refused by the SERVER while the gate is closed", () => {
  for (const [label, enabled, ack] of CLOSED_STATES) {
    it(`403s in preview and in commit — ${label}`, async () => {
      setGate(enabled, ack === "CURRENT" ? CURRENT : ack);
      const tradesBefore = (t.sqlite.prepare("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n;
      for (const mode of ["preview", "commit"]) {
        const res = await post({ action: "pull", broker: "openalgo", mode });
        expect(res.status, `mode=${mode}`).toBe(403);
        const json = (await res.json()) as { ok: boolean; message: string };
        expect(json.ok).toBe(false);
        expect(json.message).toMatch(enabled ? /disclosure has changed/i : /is off/i);
      }
      expect((t.sqlite.prepare("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n).toBe(tradesBefore);
    });
  }

  it("refuses BEFORE it looks for a saved connection — a closed gate is not a missing-credential error", async () => {
    // No connection row exists (beforeEach clears them). An ungated route would
    // answer 400 "No saved connection"; the gated one never gets that far.
    setGate(false, CURRENT);
    const res = await post({ action: "pull", broker: "openalgo", mode: "preview" });
    expect(res.status).toBe(403);
    expect((await res.json()).message).not.toMatch(/no saved/i);
  });
});

describe("with the gate OPEN, the save still validates before it stores", () => {
  beforeEach(() => setGate(true, CURRENT));

  it("stores nothing and 400s with the adapter's own reason for an unusable host", async () => {
    const res = await post({ ...GOOD_SAVE, host: "http://" });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/not a valid openalgo host/i);
    expect(connections()).toHaveLength(0);
  });

  it("stores nothing and 400s for a broker OpenAlgo has no plugin for (sahi)", async () => {
    const res = await post({ ...GOOD_SAVE, underlyingBroker: "sahi" });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/cannot connect to sahi/i);
    expect(connections()).toHaveLength(0);
  });

  it("stores nothing and 400s for a broker Vyuha does not know at all", async () => {
    const res = await post({ ...GOOD_SAVE, underlyingBroker: "definitely-not-a-broker" });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/not a broker vyuha knows/i);
    expect(connections()).toHaveLength(0);
  });

  it("stores nothing and 400s when the host or the broker is missing", async () => {
    for (const missing of [{ host: "" }, { underlyingBroker: "" }]) {
      const res = await post({ ...GOOD_SAVE, ...missing });
      expect(res.status).toBe(400);
      expect((await res.json()).message).toMatch(/required/i);
    }
    expect(connections()).toHaveLength(0);
  });

  // POSITIVE CONTROL — without this, every refusal above would also pass on a
  // route that simply never saved an OpenAlgo connection.
  it("stores the connection with the key encrypted and the host normalised", async () => {
    const res = await post(GOOD_SAVE);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const rows = connections();
    expect(rows).toHaveLength(1);
    expect(rows[0].broker).toBe("openalgo");
    // The column holds ciphertext, never the key the user typed.
    expect(rows[0].api_key).not.toContain("oa-secret-key");
    expect(decrypt(rows[0].api_key)).toBe(GOOD_SAVE.apiKey);
    // No broker token is held for an OpenAlgo pull. The column stores an
    // encrypted empty string, which does NOT read back (AES-GCM over "" is
    // zero bytes, and the venc: envelope has no empty-ciphertext form) — so
    // the pull must not require it. The pull test below is what proves it
    // does not; this only pins the shape that made the trap.
    expect(rows[0].access_token.startsWith("venc:")).toBe(true);
    expect(vault.readSecret(rows[0].access_token).ok).toBe(false);
    const auth = JSON.parse(decrypt(rows[0].auth_json)) as { host: string; underlyingBroker: string };
    expect(auth).toEqual({ host: "http://127.0.0.1:5000", underlyingBroker: "groww" });
  });
});

describe("GET publishes the gate as the Import UI's contract", () => {
  it("reports available:false with the reason while the gate is closed", async () => {
    setGate(false, null);
    const json = (await (await route.GET()).json()) as { openalgo: { available: boolean; reason?: string } };
    expect(json.openalgo.available).toBe(false);
    expect(json.openalgo.reason).toMatch(/is off/i);
  });

  it("reports available:false with the STALE-ack reason when only the ack is out of date", async () => {
    setGate(true, "0");
    const json = (await (await route.GET()).json()) as { openalgo: { available: boolean; reason?: string } };
    expect(json.openalgo.available).toBe(false);
    expect(json.openalgo.reason).toMatch(/disclosure has changed/i);
  });

  it("reports available:true with no reason once both halves hold", async () => {
    setGate(true, CURRENT);
    const json = (await (await route.GET()).json()) as { openalgo: { available: boolean; reason?: string } };
    expect(json.openalgo).toEqual({ available: true });
  });
});

describe("with the gate open, a pull reaches the adapter and its warnings reach the user", () => {
  it("surfaces the quantity-repair warning from a stubbed tradebook", async () => {
    setGate(true, CURRENT);
    expect((await post(GOOD_SAVE)).status).toBe(200);

    // OpenAlgo's OWN documented sample shape: a filled trade with quantity 0,
    // recoverable only as trade_value ÷ average_price. This is the row the
    // repair warning exists for.
    let calledWith = "";
    vi.stubGlobal("fetch", async (url: string) => {
      calledWith = String(url);
      return new Response(
        JSON.stringify({
          status: "success",
          data: [
            { action: "BUY", symbol: "RELIANCE", exchange: "NSE", product: "MIS", quantity: 0, average_price: 1180.1, trade_value: 1180.1, timestamp: "13:58:03" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const res = await post({ action: "pull", broker: "openalgo", mode: "preview" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; warnings: string[] };
    expect(json.ok).toBe(true);
    // The stored host is what was dialled — proof the save's normalisation is
    // what the pull uses, not something re-derived at pull time.
    expect(calledWith).toBe("http://127.0.0.1:5000/api/v1/tradebook");
    expect(json.warnings.some((w) => /quantity 0/i.test(w))).toBe(true);
  });

  it("returns a clean message, not a 500, when the OpenAlgo instance is not running", async () => {
    setGate(true, CURRENT);
    expect((await post(GOOD_SAVE)).status).toBe(200);
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    const res = await post({ action: "pull", broker: "openalgo", mode: "preview" });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { ok: boolean; message: string };
    expect(json.ok).toBe(false);
    expect(json.message).toMatch(/cannot reach openalgo/i);
  });
});

/**
 * Consent is recorded, not just displayed. The dialog is what the user sees;
 * the Audit Log entry is what survives — and it is the only dated evidence
 * that a specific disclosure VERSION was accepted on a specific day.
 */
describe("the settings route records the consent decision in the Audit Log", () => {
  const BASE = {
    type: "settings",
    goLiveDate: "2026-04-01",
    equityCapital: 100000,
    activeCapital: 50000,
    theme: "dark",
    fyStartMonth: 4,
    defaultBuyOrders: 3,
    defaultSellOrders: 3,
    colorblindSafe: false,
    autoMtmEnabled: false,
  };

  const saveSettings = (over: Record<string, unknown> = {}) =>
    settingsRoute.POST(
      new Request("http://localhost/api/settings", {
        method: "POST",
        body: JSON.stringify({ ...BASE, ...over }),
        headers: { "Content-Type": "application/json" },
      }),
    );

  const openalgoAudits = () =>
    t.sqlite.prepare("SELECT summary, before_json, after_json FROM audit_log WHERE summary LIKE 'OpenAlgo%' ORDER BY id").all() as {
      summary: string;
      before_json: string;
      after_json: string;
    }[];

  const storedGate = () =>
    t.sqlite.prepare("SELECT openalgo_enabled AS enabled, openalgo_ack_version AS ack FROM settings LIMIT 1").get() as {
      enabled: number;
      ack: string | null;
    };

  beforeEach(() => {
    t.sqlite.prepare("DELETE FROM audit_log").run();
    setGate(false, null);
  });

  it("audits the acceptance with the version, carrying only the two fields", async () => {
    expect((await saveSettings({ openalgoEnabled: true, openalgoAckVersion: CURRENT })).status).toBe(200);
    expect(storedGate()).toEqual({ enabled: 1, ack: CURRENT });

    const audits = openalgoAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].summary).toBe(`OpenAlgo integration enabled (disclosure v${CURRENT} accepted)`);
    // Never the whole settings row — just what changed.
    expect(JSON.parse(audits[0].before_json)).toEqual({ openalgoEnabled: false, openalgoAckVersion: null });
    expect(JSON.parse(audits[0].after_json)).toEqual({ openalgoEnabled: true, openalgoAckVersion: CURRENT });
  });

  it("audits the withdrawal, and a real `false` is stored as false", async () => {
    await saveSettings({ openalgoEnabled: true, openalgoAckVersion: CURRENT });
    t.sqlite.prepare("DELETE FROM audit_log").run();

    expect((await saveSettings({ openalgoEnabled: false, openalgoAckVersion: CURRENT })).status).toBe(200);
    // z.coerce.boolean() would have turned this into `true` had the client sent
    // the STRING "false"; the field is z.boolean() precisely so it cannot.
    expect(storedGate().enabled).toBe(0);
    const audits = openalgoAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].summary).toBe("OpenAlgo integration disabled");
    // And the gate the import route reads agrees.
    const json = (await (await route.GET()).json()) as { openalgo: { available: boolean } };
    expect(json.openalgo.available).toBe(false);
  });

  it("does not audit a save that leaves the decision unchanged", async () => {
    await saveSettings({ openalgoEnabled: true, openalgoAckVersion: CURRENT });
    t.sqlite.prepare("DELETE FROM audit_log").run();
    await saveSettings({ openalgoEnabled: true, openalgoAckVersion: CURRENT });
    expect(openalgoAudits()).toHaveLength(0);
  });

  it("a body that omits both fields keeps the stored decision and audits nothing", async () => {
    await saveSettings({ openalgoEnabled: true, openalgoAckVersion: CURRENT });
    t.sqlite.prepare("DELETE FROM audit_log").run();

    // The pre-v2.99.99 settings form sends neither field. It must not revoke a
    // consent the user gave — nor grant one they did not.
    expect((await saveSettings()).status).toBe(200);
    expect(storedGate()).toEqual({ enabled: 1, ack: CURRENT });
    expect(openalgoAudits()).toHaveLength(0);
  });

  it("a string 'false' is rejected outright rather than coerced to true", async () => {
    await saveSettings({ openalgoEnabled: true, openalgoAckVersion: CURRENT });
    t.sqlite.prepare("DELETE FROM audit_log").run();

    // The failure mode this field's type exists to rule out: with
    // z.coerce.boolean(), "false" is a non-empty string and coerces to TRUE —
    // silently re-opening a gate. A 400 is the honest answer.
    const res = await saveSettings({ openalgoEnabled: "false", openalgoAckVersion: CURRENT });
    expect(res.status).toBe(400);
    expect(storedGate().enabled).toBe(1); // unchanged, not flipped either way
    expect(openalgoAudits()).toHaveLength(0);
  });
});
