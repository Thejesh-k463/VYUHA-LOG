import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * Auto-pull on launch (v3.6, WS3): opt-in, once per day, UNATTENDED
 * connections only, and 409-shaped outcomes (nothing new / risky collision)
 * are SKIPPED — never forced. The eligibility rule and the 409 classification
 * are pure and pinned first; the sweep's stamping and dispatch run against a
 * real migrated database with the per-connection pull injected (the network
 * adapters have their own tests; what is under test here is WHO gets pulled
 * and WHAT gets stamped).
 */

process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let job: typeof import("@/lib/jobs/auto-pull");
let vault: typeof import("@/lib/vault");

// Wednesday 2026-09-02, 07:20 IST (01:50 UTC) — launch time.
const WED_0720_IST = new Date("2026-09-02T01:50:00Z");

beforeAll(async () => {
  t = await openTempDb("auto-pull", { seed: true });
  job = await import("@/lib/jobs/auto-pull");
  vault = await import("@/lib/vault");
});
afterAll(() => t?.cleanup());

beforeEach(() => {
  t.sqlite.prepare("DELETE FROM broker_connections").run();
  t.sqlite.prepare("UPDATE settings SET auto_pull_enabled = 1, last_auto_pull_date = NULL").run();
});

const lastPullDate = () =>
  (t.sqlite.prepare("SELECT last_auto_pull_date AS d FROM settings LIMIT 1").get() as { d: string | null }).d;

/** Pre-vault plaintext auth_json reads fine through readSecret — the sweep's
 *  documented compatibility path, and what keeps this test network-free. */
function addConn(broker: string, authJson: Record<string, unknown> | null = null) {
  t.sqlite
    .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json) VALUES (1, ?, 'key', 'token', ?)")
    .run(broker, authJson ? JSON.stringify(authJson) : null);
}

describe("autoPullEligibility — the per-broker unattended rule (pure)", () => {
  it("angelone and upstox are always eligible", () => {
    expect(job.autoPullEligibility("angelone", null).eligible).toBe(true);
    expect(job.autoPullEligibility("upstox", null).eligible).toBe(true);
  });
  it("dhan is eligible ONLY with pin + totpSecret + the recorded consent (totpAckVersion)", () => {
    expect(job.autoPullEligibility("dhan", { pin: "1234", totpSecret: "JBSWY3DP", totpAckVersion: 1 }).eligible).toBe(true);
    expect(job.autoPullEligibility("dhan", { pin: "1234" }).eligible).toBe(false);
    expect(job.autoPullEligibility("dhan", { totpSecret: "JBSWY3DP" }).eligible).toBe(false);
    expect(job.autoPullEligibility("dhan", null).eligible).toBe(false);
  });

  it("a legacy dhan blob (pin + totpSecret, NO recorded consent) is INELIGIBLE, with the reason naming re-enrollment", () => {
    // Red-on-revert for the consent half of the rule: before the server-side
    // gate, this exact shape was eligible — a credential stored without its
    // recorded consent must not keep minting tokens unattended.
    const legacy = job.autoPullEligibility("dhan", { pin: "1234", totpSecret: "JBSWY3DP" });
    expect(legacy.eligible).toBe(false);
    expect(legacy.reason).toMatch(/without the recorded consent.*re-save/i);
  });
  it("zerodha and openalgo are NEVER eligible, whatever is saved", () => {
    expect(job.autoPullEligibility("zerodha", { apiSecret: "s" }).eligible).toBe(false);
    expect(job.autoPullEligibility("zerodha", null).reason).toMatch(/daily browser login/i);
    expect(job.autoPullEligibility("openalgo", null).eligible).toBe(false);
    expect(job.autoPullEligibility("openalgo:groww", { pin: "x", totpSecret: "y" }).eligible).toBe(false);
  });
});

describe("classifyPreview — the manual flow's 409 shapes become skips (pure)", () => {
  it("all-duplicates (the nothingNew 409) → skip, no commit", () => {
    expect(job.classifyPreview({ summary: { total: 5, newCount: 0 } })).toBe("nothingNew");
  });
  it("an empty day → skip (no empty import batch)", () => {
    expect(job.classifyPreview({ summary: { total: 0, newCount: 0 } })).toBe("nothingNew");
  });
  it("a risky cross-source collision (the needsForce 409) → skip, NEVER force", () => {
    expect(job.classifyPreview({ summary: { total: 5, newCount: 3 }, crossSource: { risky: true } })).toBe("collision");
  });
  it("new, un-conflicted rows → commit", () => {
    expect(job.classifyPreview({ summary: { total: 5, newCount: 5 }, crossSource: { risky: false } })).toBe("commit");
    expect(job.classifyPreview({ summary: { total: 5, newCount: 2 } })).toBe("commit");
  });
});

describe("runAutoPull — dispatch, skips recorded, one stamp per day", () => {
  it("no-ops while disabled: nothing pulled, nothing stamped", async () => {
    t.sqlite.prepare("UPDATE settings SET auto_pull_enabled = 0").run();
    addConn("angelone", { clientCode: "C", pin: "1234", totpSecret: "JBSWY3DP" });
    const pullOne = vi.fn();
    const out = await job.runAutoPull(WED_0720_IST, pullOne as never);
    expect(out.ran).toBe(false);
    expect(pullOne).not.toHaveBeenCalled();
    expect(lastPullDate()).toBeNull();
  });

  it("pulls ONLY eligible connections; collisions are recorded as skipped, not forced", async () => {
    addConn("angelone", { clientCode: "C", pin: "1234", totpSecret: "JBSWY3DP" });
    addConn("dhan"); // pasted-token mode — not unattended
    addConn("zerodha", { apiSecret: "s" }); // never
    addConn("upstox");

    const pullOne = vi.fn(async (conn: { broker: string; accountId: number }) =>
      conn.broker === "upstox"
        ? { broker: conn.broker, accountId: conn.accountId, status: "collision" as const, detail: "collision — review in Import", newCount: 0 }
        : { broker: conn.broker, accountId: conn.accountId, status: "imported" as const, detail: "+3 trades", newCount: 3 },
    );
    const out = await job.runAutoPull(WED_0720_IST, pullOne as never);

    expect(out.ran).toBe(true);
    expect(pullOne).toHaveBeenCalledTimes(2); // angelone + upstox only
    expect(pullOne.mock.calls.map((c) => (c[0] as { broker: string }).broker).sort()).toEqual(["angelone", "upstox"]);
    // pullOne's signature carries NO force parameter — auto-pull cannot even
    // express a force; the classify test above pins the skip decision itself.

    const byBroker = Object.fromEntries(out.summary.map((e) => [e.broker, e.status]));
    expect(byBroker).toEqual({ angelone: "imported", dhan: "notEligible", zerodha: "notEligible", upstox: "collision" });
    expect(out.line).toContain("Angel One +3 trades");
    expect(out.line).toContain("Upstox skipped (collision — review in Import)");
    // The skipped connection's own summary entry names where to resolve it.
    expect(out.summary.find((e) => e.broker === "upstox")!.detail).toMatch(/review in Import/i);
    // The sweep is recorded where a settings surface can show it (Audit Log).
    const audits = t.sqlite.prepare("SELECT summary FROM audit_log WHERE source = 'auto-pull'").all() as { summary: string }[];
    expect(audits.some((a) => a.summary.startsWith("Auto-pull"))).toBe(true);
  });

  it("stamps ONCE per day, after the sweep, regardless of per-broker outcomes", async () => {
    addConn("upstox");
    const failing = vi.fn(async (conn: { broker: string; accountId: number }) => ({
      broker: conn.broker,
      accountId: conn.accountId,
      status: "error" as const,
      detail: "broker refused",
      newCount: 0,
    }));
    const first = await job.runAutoPull(WED_0720_IST, failing as never);
    expect(first.date).toBe("2026-09-02");
    expect(lastPullDate()).toBe("2026-09-02"); // stamped even though every pull failed

    const second = await job.runAutoPull(WED_0720_IST, failing as never);
    expect(second.ran).toBe(false);
    expect(second.reason).toMatch(/already swept/i);
    expect(failing).toHaveBeenCalledTimes(1); // one attempt per day, not a retry loop
  });

  it("with no eligible connections, the day is still stamped and the note stays silent", async () => {
    addConn("zerodha");
    const pullOne = vi.fn();
    const out = await job.runAutoPull(WED_0720_IST, pullOne as never);
    expect(out.ran).toBe(false);
    expect(out.line).toBeNull(); // silence is the default — nothing was attempted
    expect(pullOne).not.toHaveBeenCalled();
    expect(lastPullDate()).toBe("2026-09-02");
  });
});

describe("the real Dhan pull — reuse the stored token, PERSIST a mint (finder 3 item 1)", () => {
  /**
   * Dhan mints at most ONE token per 2 minutes (live-verified 2026-09-02), so
   * the manual route resolves reuse-first and writes every mint back to the
   * vault. Auto-pull built its credentials with no `accessToken` and no
   * `onMinted` at all: every sweep minted a token and threw it away, and a
   * manual Preview inside the next two minutes (or the reverse order) then
   * failed on the rate limit. These run the DEFAULT pullOne — the real
   * adapter — with fetch stubbed; no network, no commit (an empty book is
   * "nothing new").
   */
  const ENROLLED = { pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP", totpAckVersion: 1 };
  const jwt = (expSec: number) => ["e30", Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url"), "sig"].join(".");
  const alive = () => jwt(Math.floor(Date.now() / 1000) + 3600);
  const dead = () => jwt(Math.floor(Date.now() / 1000) - 3600);

  /** Pre-vault plaintext columns read fine through readSecret (see addConn). */
  function addDhan(accessToken: string) {
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json) VALUES (1, 'dhan', '1000000009', ?, ?)")
      .run(accessToken, JSON.stringify(ENROLLED));
  }

  const storedToken = () => {
    const row = t.sqlite.prepare("SELECT access_token AS a FROM broker_connections WHERE broker = 'dhan'").get() as { a: string };
    const read = vault.readSecret(row.a);
    return read.ok ? read.value : `UNREADABLE: ${read.reason}`;
  };

  /** Records every call; mints "minted-jwt" at auth.dhan.co, empty book at api.dhan.co. */
  function stubFetch() {
    const calls: Array<{ host: string; token?: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push({ host: u.host, token: (init?.headers as Record<string, string> | undefined)?.["access-token"] });
      const body = u.host === "auth.dhan.co" ? { accessToken: "minted-jwt" } : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    return calls;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("a stored token that is still alive is REUSED — no mint call at all", async () => {
    const token = alive();
    addDhan(token);
    const calls = stubFetch();

    const out = await job.runAutoPull(WED_0720_IST); // the REAL pullOne

    // THE assertion, red on revert: with no accessToken passed through, the
    // resolver has nothing to reuse and the hosts are
    // ["auth.dhan.co", "api.dhan.co"] — a mint on every single sweep.
    expect(calls.map((c) => c.host)).toEqual(["api.dhan.co"]);
    expect(calls[0]!.token).toBe(token);
    expect(storedToken()).toBe(token); // untouched
    expect(out.summary[0]!.status).toBe("nothingNew");
  });

  it("when the stored token is dead, the ONE mint is persisted into the vault", async () => {
    addDhan(dead());
    const calls = stubFetch();

    await job.runAutoPull(WED_0720_IST);

    expect(calls.map((c) => c.host)).toEqual(["auth.dhan.co", "api.dhan.co"]);
    expect(calls[1]!.token).toBe("minted-jwt");
    // THE assertion, red on revert: without onMinted the mint was thrown away
    // and this still held the dead token — so the next call (a manual Preview,
    // or tomorrow's sweep inside the 2-minute window) minted again and failed.
    expect(storedToken()).toBe("minted-jwt");
    // ...and it is stored ENCRYPTED, the same vault path the route uses.
    const raw = (t.sqlite.prepare("SELECT access_token AS a FROM broker_connections WHERE broker = 'dhan'").get() as { a: string }).a;
    expect(raw).not.toBe("minted-jwt");
  });
});
