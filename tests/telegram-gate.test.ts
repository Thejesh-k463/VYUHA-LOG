import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * The Telegram consent gate asserted at the ROUTE, and the digest job's
 * stamping asserted against a real migrated database — the openalgo-gate
 * pattern. tests/telegram-disclosure.test.ts proves the pure functions; this
 * file proves the SERVER acts on them: a 403 that still stored a token, or a
 * failed send that still stamped the date, would be worse than no gate.
 *
 * NO NETWORK: fetch is stubbed to throw for the whole file; tests that need a
 * Telegram response re-stub it with a fixture. One temp database per FILE and
 * every import of route/job/vault is dynamic, after openTempDb.
 */

process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let route: typeof import("@/app/api/telegram/route");
let job: typeof import("@/lib/jobs/telegram-digest");
let vault: typeof import("@/lib/vault");
let CURRENT: number;

// Wednesday 2026-09-02, 16:00 IST (10:30 UTC) — past the default send time.
const WED_1600_IST = new Date("2026-09-02T10:30:00Z");

beforeAll(async () => {
  t = await openTempDb("telegram-gate", { seed: true });
  route = await import("@/app/api/telegram/route");
  job = await import("@/lib/jobs/telegram-digest");
  vault = await import("@/lib/vault");
  CURRENT = (await import("@/lib/domain/telegram-disclosure")).TELEGRAM_DISCLOSURE.version;
});
afterAll(() => {
  vi.unstubAllGlobals();
  t?.cleanup();
});

beforeEach(() => {
  t.sqlite.prepare("DELETE FROM audit_log").run();
  t.sqlite.prepare("DELETE FROM trades").run();
  t.sqlite
    .prepare(
      "UPDATE settings SET telegram_enabled = 0, telegram_ack_version = NULL, telegram_token_enc = NULL, telegram_chat_id = NULL, telegram_send_time = '15:35', last_telegram_sent_date = NULL",
    )
    .run();
  vi.stubGlobal("fetch", () => {
    throw new Error("TEST GUARD: the route reached the network");
  });
});
afterEach(() => vi.unstubAllGlobals());

const stored = () =>
  t.sqlite
    .prepare(
      "SELECT telegram_enabled AS enabled, telegram_ack_version AS ack, telegram_token_enc AS token, telegram_chat_id AS chat, last_telegram_sent_date AS lastSent FROM settings LIMIT 1",
    )
    .get() as { enabled: number; ack: number | null; token: string | null; chat: string | null; lastSent: string | null };

function setAck(ack: number | null, enabled = false) {
  t.sqlite.prepare("UPDATE settings SET telegram_ack_version = ?, telegram_enabled = ?").run(ack, enabled ? 1 : 0);
}

function post(body: unknown): Promise<Response> {
  return route.POST(
    new Request("http://localhost/api/telegram", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("the toggle route refuses enable without a current ack — 403, and nothing flips", () => {
  it("403s with no ack stored and none carried", async () => {
    const res = await post({ action: "toggle", enabled: true });
    expect(res.status).toBe(403);
    expect(stored().enabled).toBe(0);
  });

  it("403s with a future/mismatched ack carried (strict equality refuses both directions)", async () => {
    const res = await post({ action: "toggle", enabled: true, ackVersion: CURRENT + 1 });
    expect(res.status).toBe(403);
    expect(stored().enabled).toBe(0);
  });

  it("enables with the current ack carried, and audits the dated acceptance", async () => {
    const res = await post({ action: "toggle", enabled: true, ackVersion: CURRENT });
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ enabled: 1, ack: CURRENT });
    const audits = t.sqlite.prepare("SELECT summary FROM audit_log").all() as { summary: string }[];
    expect(audits.some((a) => a.summary === `Telegram alerts enabled (disclosure v${CURRENT} accepted)`)).toBe(true);
  });

  it("a string 'false' is rejected outright rather than coerced to true", async () => {
    setAck(CURRENT, true);
    const res = await post({ action: "toggle", enabled: "false" });
    expect(res.status).toBe(400);
    expect(stored().enabled).toBe(1); // unchanged, not flipped either way
  });

  it("disable is immediate, keeps the ack on file, and audits", async () => {
    setAck(CURRENT, true);
    expect((await post({ action: "toggle", enabled: false })).status).toBe(200);
    expect(stored()).toMatchObject({ enabled: 0, ack: CURRENT });
  });
});

describe("save / discover / send-test are refused by the SERVER while unacknowledged", () => {
  for (const body of [
    { action: "save", token: "123:AAA", chatId: "42" },
    { action: "discover-chat-id", token: "123:AAA" },
    { action: "send-test" },
  ]) {
    it(`403s and stores nothing — ${body.action}`, async () => {
      setAck(null);
      const res = await post(body);
      expect(res.status).toBe(403);
      expect((await res.json()).message).toMatch(/disclosure/i);
      expect(stored().token).toBeNull();
    });
  }
});

describe("save validates by actually sending the test alert", () => {
  beforeEach(() => setAck(CURRENT, true));

  it("stores the token ENCRYPTED only after Telegram confirms the send", async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const res = await post({ action: "save", token: "123:SECRET-BOT-TOKEN", chatId: "42" });
    expect(res.status).toBe(200);
    expect(sent!.url).toContain("api.telegram.org");
    expect(sent!.body.text).toBe("✅ Vyuha connected — test alert");
    const s = stored();
    expect(s.chat).toBe("42");
    expect(s.token!.startsWith("venc:")).toBe(true); // ciphertext, never the paste
    expect(s.token).not.toContain("SECRET-BOT-TOKEN");
    const read = vault.readSecret(s.token);
    expect(read.ok && read.value).toBe("123:SECRET-BOT-TOKEN");
    // The audit trail never carries the token.
    const audits = t.sqlite.prepare("SELECT summary, after_json FROM audit_log").all() as { summary: string; after_json: string | null }[];
    expect(JSON.stringify(audits)).not.toContain("SECRET-BOT-TOKEN");
  });

  it("audits THAT a chat was set, never the chat id itself — audit_log travels in backups unredacted", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await post({ action: "save", token: "123:T", chatId: "990011223344" });
    expect(res.status).toBe(200);
    const audits = t.sqlite.prepare("SELECT summary, before_json, after_json FROM audit_log").all();
    expect(audits.length).toBeGreaterThan(0);
    const all = JSON.stringify(audits);
    // Red-on-revert: `after: { telegramChatId: chatId }` puts the literal id
    // into after_json, which dumpDatabase copies into every backup — the very
    // thing migration 0053 redacts from the settings table.
    expect(all).not.toContain("990011223344");
    expect(all).toContain("(set)");
  });

  it("stores NOTHING when the test alert fails", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }));
    const res = await post({ action: "save", token: "123:BAD", chatId: "42" });
    expect(res.status).toBe(502);
    expect(stored().token).toBeNull();
    expect(stored().chat).toBeNull();
  });

  it("disconnect deletes the token and closes the gate, keeping the ack", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await post({ action: "save", token: "123:T", chatId: "42" });
    const res = await post({ action: "disconnect" });
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ enabled: 0, ack: CURRENT, token: null, chat: null });
  });
});

describe("the digest job stamps last_telegram_sent_date ONLY on a confirmed send", () => {
  function connect(over: Record<string, unknown> = {}) {
    setAck(CURRENT, true);
    t.sqlite
      .prepare("UPDATE settings SET telegram_token_enc = ?, telegram_chat_id = '42', telegram_send_time = '15:35', last_telegram_sent_date = NULL")
      .run(vault.encryptSecret("123:JOB-TOKEN"));
    for (const [k, v] of Object.entries(over)) t.sqlite.prepare(`UPDATE settings SET ${k} = ?`).run(v as never);
  }

  it("sends the assembled digest (own numbers + pinned footer) and stamps the IST date", async () => {
    connect();
    t.db.insert(t.schema.trades).values([
      tradeRow({ symbol: "TCS", buyQty: 10, avgBuyPrice: 2000, isOpen: true, riskAmount: 5000 }),
      tradeRow({ symbol: "INFY", buyQty: 5, avgBuyPrice: 1500, isOpen: false, netPnl: 1200, sellDate: "2026-09-02" }),
    ]).run();
    const sent: string[] = [];
    const outcome = await job.runTelegramDigest(WED_1600_IST, async (_t, _c, html) => {
      sent.push(html);
      return { ok: true };
    });
    expect(outcome.ran).toBe(true);
    expect(stored().lastSent).toBe("2026-09-02");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Open positions: 1");
    expect(sent[0]).toContain("TCS");
    expect(sent[0].endsWith("Your own recorded data. Not investment advice.")).toBe(true);

    // Once per day: the very next run refuses on the stamp.
    const again = await job.runTelegramDigest(WED_1600_IST, async () => ({ ok: true }));
    expect(again.ran).toBe(false);
    expect(again.reason).toMatch(/already sent/i);
  });

  it("does NOT stamp on a failed send — the next launch today retries, and the failure is a note", async () => {
    connect();
    const outcome = await job.runTelegramDigest(WED_1600_IST, async () => ({ ok: false, reason: "Telegram was unreachable." }));
    expect(outcome.ran).toBe(false);
    expect(outcome.failed).toBe(true);
    expect(stored().lastSent).toBeNull(); // red-on-revert: a stamp here would silence today's digest
    const retry = await job.runTelegramDigest(WED_1600_IST, async () => ({ ok: true }));
    expect(retry.ran).toBe(true);
    expect(stored().lastSent).toBe("2026-09-02");
  });

  it("a second caller DURING the first send is refused — the day is claimed BEFORE dialling (two-tab race)", async () => {
    // TelegramRunner's sessionStorage latch is per-tab: two restored tabs both
    // POST /api/telegram/digest. Stamping only after the awaited send let both
    // pass the lastSentDate gate — the digest arrived twice. The fix claims
    // the day with a synchronous conditional UPDATE before sending.
    connect();
    const sends: string[] = [];
    const outcome = await job.runTelegramDigest(WED_1600_IST, async (_t, _c, _html) => {
      // While the first send is in flight, the second tab's job runs.
      const inner = await job.runTelegramDigest(WED_1600_IST, async () => {
        sends.push("inner");
        return { ok: true };
      });
      expect(inner.ran).toBe(false);
      sends.push("outer");
      return { ok: true };
    });
    expect(outcome.ran).toBe(true);
    // Red-on-revert: stamp-after-send lets the inner caller send too.
    expect(sends).toEqual(["outer"]);
    expect(stored().lastSent).toBe("2026-09-02");
  });

  it("a failed send restores the PREVIOUS stamp — yesterday's date, not a wiped one", async () => {
    // The claim overwrites last_telegram_sent_date before the send; on failure
    // it must give back exactly what was there, or retry-at-next-launch would
    // survive only for the never-sent case.
    connect({ last_telegram_sent_date: "2026-09-01" });
    const outcome = await job.runTelegramDigest(WED_1600_IST, async () => ({ ok: false, reason: "Telegram was unreachable." }));
    expect(outcome.ran).toBe(false);
    expect(outcome.failed).toBe(true);
    expect(stored().lastSent).toBe("2026-09-01");
    // And the next launch today still retries.
    const retry = await job.runTelegramDigest(WED_1600_IST, async () => ({ ok: true }));
    expect(retry.ran).toBe(true);
    expect(stored().lastSent).toBe("2026-09-02");
  });

  it("every gate precondition blocks the JOB, sender untouched", async () => {
    const sender = vi.fn(async () => ({ ok: true }));
    // disabled
    connect({ telegram_enabled: 0 });
    expect((await job.runTelegramDigest(WED_1600_IST, sender)).ran).toBe(false);
    // stale ack
    connect({ telegram_ack_version: CURRENT + 1 });
    expect((await job.runTelegramDigest(WED_1600_IST, sender)).ran).toBe(false);
    // no credentials
    connect({ telegram_token_enc: null });
    expect((await job.runTelegramDigest(WED_1600_IST, sender)).ran).toBe(false);
    // weekend (Saturday 2026-09-05 IST)
    connect();
    expect((await job.runTelegramDigest(new Date("2026-09-05T10:30:00Z"), sender)).ran).toBe(false);
    // before send time (15:00 IST)
    connect();
    expect((await job.runTelegramDigest(new Date("2026-09-02T09:30:00Z"), sender)).ran).toBe(false);
    expect(sender).not.toHaveBeenCalled();
    expect(stored().lastSent).toBeNull();
  });
});
