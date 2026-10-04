import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { istWallClockIso } from "@/lib/domain/trading-day";
import { quoteKeyId, toPaise, type Quote, type QuoteKey, type QuoteProvider } from "@/lib/quotes/types";

/**
 * The Telegram stop/target alert JOB and its two doors against a real migrated
 * database (v4.7.0 C5; design D1–D10 as amended by review R1–R10).
 *
 * NO NETWORK: the sender and the feed are injected (`TelegramAlertDeps`), and
 * `fetch` is stubbed to throw for the whole file. The licence is the one module
 * mocked (`getEntitlement`), so the job's DEFAULT Pro check and the route's
 * Pro check are both the code under test. ONE temp database per FILE; every
 * import of the job / routes / vault is dynamic, after `openTempDb`.
 */

process.env.VYUHA_VAULT_PROVIDER = "machine";
delete process.env.VYUHA_QUOTE_PROVIDER;

const ent = vi.hoisted(() => ({ pro: true }));
vi.mock("@/lib/queries/license", () => ({ getEntitlement: () => ({ pro: ent.pro }) }));

let t: TempDb;
let job: typeof import("@/lib/jobs/telegram-alerts");
let alertsRoute: typeof import("@/app/api/telegram/alerts/route");
let tgRoute: typeof import("@/app/api/telegram/route");
let vault: typeof import("@/lib/vault");
let CURRENT: number;

const at = (date: string, hhmm: string) => new Date(istWallClockIso(date, hhmm));
const TODAY = "2026-10-07"; // an ordinary verified Wednesday
const NOW = at(TODAY, "10:42");
const TOKEN = "123:ALERT-SECRET-TOKEN";
const CHAT = "990011223344";

beforeAll(async () => {
  t = await openTempDb("telegram-alerts", { seed: true });
  job = await import("@/lib/jobs/telegram-alerts");
  alertsRoute = await import("@/app/api/telegram/alerts/route");
  tgRoute = await import("@/app/api/telegram/route");
  vault = await import("@/lib/vault");
  CURRENT = (await import("@/lib/domain/telegram-disclosure")).TELEGRAM_DISCLOSURE.version;
  // Warm the lazily imported registry (the job's default feed resolver) and the
  // first query paths here, in the hook, so no single `it` pays for them
  // (AGENTS.md: ≤ 300 ms per it locally).
  await import("@/lib/quotes/registry");
  t.sqlite
    .prepare("UPDATE settings SET telegram_enabled = 1, telegram_ack_version = ?, telegram_token_enc = ?, telegram_chat_id = ?, telegram_alerts_enabled = 1")
    .run(CURRENT, vault.encryptSecret(TOKEN), CHAT);
  openLong("ZZWARM");
  await job.runTelegramAlerts(NOW, deps(fakeFeed({ [NSE("ZZWARM")]: 1228.4 }), recorder().send));
  // beforeEach wipes the trade, the receipt and the settings this left behind.
});
afterAll(() => {
  vi.unstubAllGlobals();
  t?.cleanup();
});

beforeEach(() => {
  ent.pro = true;
  for (const tbl of ["trades", "telegram_alerts_sent", "audit_log"]) t.sqlite.prepare(`DELETE FROM ${tbl}`).run();
  t.sqlite.prepare("DELETE FROM accounts WHERE id > 1").run();
  t.sqlite
    .prepare(
      `UPDATE settings SET telegram_enabled = 1, telegram_ack_version = ?, telegram_token_enc = ?, telegram_chat_id = ?,
       telegram_alerts_enabled = 1, telegram_alert_from = NULL, telegram_alert_to = NULL,
       last_telegram_alert_summary_date = NULL, selected_account_id = 1,
       live_feed_provider = 'eod', live_feed_ack_json = NULL`,
    )
    .run(CURRENT, vault.encryptSecret(TOKEN), CHAT);
  vi.stubGlobal("fetch", () => {
    throw new Error("TEST GUARD: the alert path reached the network");
  });
});
afterEach(() => vi.unstubAllGlobals());

/* ─────────────────────────────── fixtures ─────────────────────────────── */

interface FeedOpts {
  volume?: number | null;
  staleness?: Quote["staleness"];
  asOf?: string;
  throws?: boolean;
}

/** A provider that prices exactly the quote ids it is given, in rupees, and records what it was asked. */
function fakeFeed(prices: Record<string, number>, opts: FeedOpts = {}) {
  const asked: QuoteKey[][] = [];
  const healthCalls = { n: 0 };
  const provider = {
    id: "openalgo",
    capabilities: {} as QuoteProvider["capabilities"],
    async snapshot(keys: readonly QuoteKey[]) {
      asked.push([...keys]);
      if (opts.throws) throw new Error("OpenAlgo bridge unreachable");
      const out = new Map<string, Quote>();
      for (const key of keys) {
        const id = quoteKeyId(key);
        if (!(id in prices)) continue;
        out.set(id, {
          key,
          ltp: toPaise(prices[id]),
          prevClose: null,
          dayOpen: null,
          dayHigh: null,
          dayLow: null,
          volume: opts.volume === undefined ? 12_345 : opts.volume,
          asOf: opts.asOf ?? NOW.toISOString(),
          staleness: opts.staleness ?? "delayed",
          source: "openalgo",
        });
      }
      return out;
    },
    subscribe: () => () => {},
    // The OpenAlgo disclosure promises its /funds probe (health) only when the
    // desk opens or its stream reconnects — the alert job must never call it.
    health: async () => {
      healthCalls.n += 1;
      return { ok: true };
    },
  } as QuoteProvider;
  return { provider, asked, healthCalls };
}

type Sent = { token: string; chat: string; html: string };

function recorder(fail?: (html: string) => string | null) {
  const sent: Sent[] = [];
  const send = async (token: string, chat: string, html: string) => {
    sent.push({ token, chat, html });
    const reason = fail?.(html) ?? null;
    return reason ? { ok: false, reason } : { ok: true };
  };
  return { sent, send };
}

function deps(feed: ReturnType<typeof fakeFeed>, send: ReturnType<typeof recorder>["send"], over: Record<string, unknown> = {}) {
  return {
    send,
    getProvider: async () => feed.provider,
    resolveFeed: async () => ({ stored: "openalgo", effective: "openalgo" }),
    envOverride: null,
    ...over,
  };
}

/** An open long cash position with a recorded stop, in account 1 unless told. */
function openLong(symbol: string, over: Record<string, unknown> = {}): number {
  const row = t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        symbol,
        tradingsymbol: symbol,
        buyQty: 10,
        avgBuyPrice: 1300,
        isOpen: true,
        slPlanned: 1230,
        accountId: 1,
        ...over,
      }) as typeof t.schema.trades.$inferInsert,
    )
    .returning({ id: t.schema.trades.id })
    .get();
  return row.id;
}

const receipts = () =>
  t.sqlite.prepare("SELECT trade_id AS tradeId, symbol, kind, ist_date AS istDate, level, mark FROM telegram_alerts_sent ORDER BY id").all() as {
    tradeId: number;
    symbol: string;
    kind: string;
    istDate: string;
    level: number;
    mark: number;
  }[];
const summaryDate = () =>
  (t.sqlite.prepare("SELECT last_telegram_alert_summary_date AS d FROM settings").get() as { d: string | null }).d;

const NSE = (s: string) => `NSE:${s}`;

/* ─────────────────────────────── the claim ─────────────────────────────── */

describe("the receipt IS the claim — claim before dial, release on failure", () => {
  it("sends one alert, stores the receipt (prices REAL), and never re-arms the same IST day", async () => {
    const id = openLong("ZZALPHA");
    const feed = fakeFeed({ [NSE("ZZALPHA")]: 1228.4 });
    const tg = recorder();
    const out = await job.runTelegramAlerts(NOW, deps(feed, tg.send));
    expect(out).toMatchObject({ refused: null, sent: 1, failed: null, checked: 1 });
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]).toMatchObject({ token: TOKEN, chat: CHAT });
    expect(tg.sent[0].html).toContain("<b>ZZALPHA</b>: mark 1,228.40 is through your recorded stop 1,230.00");
    expect(tg.sent[0].html).toContain("checked 10:42 IST via OpenAlgo");
    expect(receipts()).toEqual([{ tradeId: id, symbol: "ZZALPHA", kind: "sl", istDate: TODAY, level: 1230, mark: 1228.4 }]);
    // ONE snapshot, and never health() — no /funds probe from the alert path.
    expect(feed.asked).toHaveLength(1);
    expect(feed.healthCalls.n).toBe(0);

    const again = await job.runTelegramAlerts(at(TODAY, "10:43"), deps(feed, tg.send));
    expect(again).toMatchObject({ refused: null, sent: 0 });
    expect(tg.sent).toHaveLength(1);
  });

  it("a receipt another process already holds stops the dial; claimAlert is 1 then 0", async () => {
    const id = openLong("ZZALPHA");
    const r = { tradeId: id, symbol: "ZZALPHA", kind: "sl" as const, istDate: TODAY, level: 1230, mark: 1228.4, sentAt: NOW.toISOString() };
    expect(job.claimAlert(r)).toBe(1);
    expect(job.claimAlert(r)).toBe(0);
    const tg = recorder();
    const out = await job.runTelegramAlerts(NOW, deps(fakeFeed({ [NSE("ZZALPHA")]: 1228.4 }), tg.send));
    expect(out).toMatchObject({ sent: 0 });
    expect(tg.sent).toHaveLength(0);
  });

  it("two concurrent calls in this process share ONE run — one dial", async () => {
    openLong("ZZALPHA");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sent: string[] = [];
    const send = async (_t: string, _c: string, html: string) => {
      sent.push(html);
      await gate;
      return { ok: true };
    };
    const d = deps(fakeFeed({ [NSE("ZZALPHA")]: 1228.4 }), send);
    const a = job.runTelegramAlerts(NOW, d);
    const b = job.runTelegramAlerts(NOW, d);
    expect(b).toBe(a);
    await new Promise((r) => setTimeout(r, 0));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(sent).toHaveLength(1);
    expect(receipts()).toHaveLength(1);
  });

  it("a failed send DELETES its claim, returns the sender's own reason, and the next run retries", async () => {
    openLong("ZZALPHA");
    const feed = fakeFeed({ [NSE("ZZALPHA")]: 1228.4 });
    const down = recorder(() => "Telegram was unreachable (offline, blocked, or timed out).");
    const out = await job.runTelegramAlerts(NOW, deps(feed, down.send));
    expect(out).toMatchObject({ refused: null, sent: 0, failed: { reason: "Telegram was unreachable (offline, blocked, or timed out)." } });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(receipts()).toEqual([]);

    const up = recorder();
    expect(await job.runTelegramAlerts(at(TODAY, "10:43"), deps(feed, up.send))).toMatchObject({ sent: 1, failed: null });
    expect(receipts()).toHaveLength(1);
  });
});

/* ──────────────────────────── cap and summary ──────────────────────────── */

describe("20 a day, then ONE summary (Q18-i)", () => {
  const book = (n: number) => {
    const prices: Record<string, number> = {};
    for (let i = 1; i <= n; i++) {
      openLong(`ZZS${String(i).padStart(2, "0")}`);
      prices[NSE(`ZZS${String(i).padStart(2, "0")}`)] = 1228.4;
    }
    return fakeFeed(prices);
  };

  it("the 21st breach is the summary line, never a 21st message — and the day then stays quiet", async () => {
    const feed = book(21);
    const tg = recorder();
    const out = await job.runTelegramAlerts(NOW, deps(feed, tg.send));
    expect(out).toMatchObject({ refused: null, sent: 20, summarySent: true, failed: null });
    expect(tg.sent).toHaveLength(21);
    expect(tg.sent[20].html).toContain("1 more breach of your recorded levels today, past the daily limit of 20 alerts");
    expect(receipts()).toHaveLength(20);
    expect(summaryDate()).toBe(TODAY);

    const again = await job.runTelegramAlerts(at(TODAY, "10:43"), deps(feed, tg.send));
    expect(again).toMatchObject({ sent: 0, summarySent: false });
    expect(tg.sent).toHaveLength(21);
  });

  it("a failed summary gives the day back — the PREVIOUS stamp restored — and the next run sends only the summary", async () => {
    t.sqlite.prepare("UPDATE settings SET last_telegram_alert_summary_date = '2026-10-06'").run();
    const feed = book(21);
    const tg = recorder((html) => (html.includes("more breach") ? "Telegram is rate-limiting (HTTP 429)." : null));
    const out = await job.runTelegramAlerts(NOW, deps(feed, tg.send));
    expect(out).toMatchObject({ sent: 20, summarySent: false, failed: { reason: "Telegram is rate-limiting (HTTP 429)." } });
    expect(summaryDate()).toBe("2026-10-06");

    const ok = recorder();
    const retry = await job.runTelegramAlerts(at(TODAY, "10:43"), deps(feed, ok.send));
    expect(retry).toMatchObject({ sent: 0, summarySent: true });
    expect(ok.sent).toHaveLength(1);
    expect(summaryDate()).toBe(TODAY);
  });

  it("the cap holds inside the claim itself — a 21st claim for today is refused by SQL", () => {
    for (let i = 1; i <= 20; i++) {
      expect(job.claimAlert({ tradeId: 1000 + i, symbol: `X${i}`, kind: "sl", istDate: TODAY, level: 1, mark: 1, sentAt: "x" })).toBe(1);
    }
    expect(job.claimAlert({ tradeId: 2000, symbol: "X21", kind: "sl", istDate: TODAY, level: 1, mark: 1, sentAt: "x" })).toBe(0);
    // …and tomorrow is a new day.
    expect(job.claimAlert({ tradeId: 2000, symbol: "X21", kind: "sl", istDate: "2026-10-08", level: 1, mark: 1, sentAt: "x" })).toBe(1);
  });
});

/* ─────────────────────────────── prune ─────────────────────────────── */

describe("receipts are pruned past seven IST days", () => {
  it("keeps the last seven days and today, drops the eighth", async () => {
    const ins = t.sqlite.prepare(
      "INSERT INTO telegram_alerts_sent (trade_id, symbol, kind, ist_date, level, mark, sent_at) VALUES (?, ?, 'sl', ?, 1, 1, 'x')",
    );
    ins.run(1, "OLD", "2026-09-29");
    ins.run(2, "KEEP", "2026-09-30");
    openLong("ZZALPHA");
    await job.runTelegramAlerts(NOW, deps(fakeFeed({ [NSE("ZZALPHA")]: 1228.4 }), recorder().send));
    expect(receipts().map((r) => r.symbol)).toEqual(["KEEP", "ZZALPHA"]);
  });
});

/* ─────────────────────────── accounts (TG3, D7, R6, R7) ─────────────────────────── */

describe("every account is checked, and each message names its own account", () => {
  it("two accounts both alert while account 1 is the selected view", async () => {
    t.db.insert(t.schema.accounts).values({ id: 2, name: "Swing", isDefault: false }).run();
    const mainName = (t.sqlite.prepare("SELECT name FROM accounts WHERE id = 1").get() as { name: string }).name;
    openLong("ZZALPHA", { accountId: 1 });
    openLong("ZZBETA", { accountId: 2 });
    const tg = recorder();
    const out = await job.runTelegramAlerts(NOW, deps(fakeFeed({ [NSE("ZZALPHA")]: 1228.4, [NSE("ZZBETA")]: 1200 }), tg.send));
    expect(out).toMatchObject({ sent: 2 });
    const bySymbol = Object.fromEntries(tg.sent.map((s) => [/<b>(\w+)<\/b>/.exec(s.html)![1], s.html]));
    expect(bySymbol.ZZALPHA).toContain(`<b>ZZALPHA</b> · ${mainName}:`);
    expect(bySymbol.ZZBETA).toContain("<b>ZZBETA</b> · Swing:");
  });

  it("an account literally named 'Long hold' is escaped into the message and the alert still sends", async () => {
    t.db.insert(t.schema.accounts).values({ id: 2, name: "Long hold <&>", isDefault: false }).run();
    openLong("ZZBETA", { accountId: 2 });
    const tg = recorder();
    expect(await job.runTelegramAlerts(NOW, deps(fakeFeed({ [NSE("ZZBETA")]: 1200 }), tg.send))).toMatchObject({ sent: 1 });
    expect(tg.sent[0].html).toContain("· Long hold &lt;&amp;&gt;:");
  });

  it("delete + re-import the same day is a NEW id and a second alert — accepted (R7)", async () => {
    const first = openLong("ZZALPHA");
    const feed = fakeFeed({ [NSE("ZZALPHA")]: 1228.4 });
    const tg = recorder();
    await job.runTelegramAlerts(NOW, deps(feed, tg.send));
    t.sqlite.prepare("DELETE FROM trades WHERE id = ?").run(first);
    const second = openLong("ZZALPHA");
    expect(second).not.toBe(first);
    expect(await job.runTelegramAlerts(at(TODAY, "10:45"), deps(feed, tg.send))).toMatchObject({ sent: 1 });
    expect(tg.sent).toHaveLength(2);
  });

  it("a restored DIFFERENT trade under a reused id still alerts — the symbol is in the receipt (R6)", async () => {
    t.sqlite
      .prepare("INSERT INTO telegram_alerts_sent (trade_id, symbol, kind, ist_date, level, mark, sent_at) VALUES (77, 'ZZOLD', 'sl', ?, 1, 1, 'x')")
      .run(TODAY);
    openLong("ZZNEW", { id: 77 });
    const tg = recorder();
    expect(await job.runTelegramAlerts(NOW, deps(fakeFeed({ [NSE("ZZNEW")]: 1228.4 }), tg.send))).toMatchObject({ sent: 1 });
    expect(receipts().map((r) => `${r.tradeId}:${r.symbol}`)).toEqual(["77:ZZOLD", "77:ZZNEW"]);
  });
});

/* ───────────────────────────── freshness (R2) ───────────────────────────── */

describe("a stale or missing price is never pushed", () => {
  it.each([
    ["a zero-volume print (yesterday's price for a scrip untraded today)", { volume: 0 }],
    ["an end-of-day quote", { staleness: "eod" as const }],
    ["a quote dated yesterday", { asOf: at("2026-10-06", "15:29").toISOString() }],
  ])("refuses %s", async (_label, opts) => {
    openLong("ZZALPHA");
    const tg = recorder();
    const out = await job.runTelegramAlerts(NOW, deps(fakeFeed({ [NSE("ZZALPHA")]: 1228.4 }, opts), tg.send));
    expect(out).toMatchObject({ refused: null, checked: 0, sent: 0 });
    expect(tg.sent).toHaveLength(0);
  });

  it("a quote with no volume field at all still counts (volume is refused only when present and 0)", async () => {
    openLong("ZZALPHA");
    const tg = recorder();
    expect(await job.runTelegramAlerts(NOW, deps(fakeFeed({ [NSE("ZZALPHA")]: 1228.4 }, { volume: null }), tg.send))).toMatchObject({ sent: 1 });
  });

  it("a snapshot that throws is 'feed-error' — no send, no receipt, no failure envelope", async () => {
    openLong("ZZALPHA");
    const tg = recorder();
    const out = await job.runTelegramAlerts(NOW, deps(fakeFeed({}, { throws: true }), tg.send));
    expect(out).toEqual({ refused: "feed-error", nextInMs: 60_000 });
    expect(tg.sent).toHaveLength(0);
    expect(receipts()).toEqual([]);
  });
});

/* ──────────────────────────── the calendar (TG4, R8) ──────────────────────────── */

describe("each position alerts only while its OWN market trades", () => {
  it.each([
    ["after the close", at(TODAY, "16:00"), "market-closed"],
    ["in pre-open (indicative prices)", at(TODAY, "09:05"), "market-closed"],
    ["on Muhurat (no bundled hours)", at("2026-11-08", "18:30"), "market-closed"],
    ["past coversThrough", at("2027-01-06", "11:00"), "calendar-unverified"],
  ])("refuses %s — the feed is never asked", async (_label, now, reason) => {
    openLong("ZZALPHA");
    const feed = fakeFeed({ [NSE("ZZALPHA")]: 1228.4 });
    const tg = recorder();
    const out = await job.runTelegramAlerts(now, deps(feed, tg.send));
    expect(out).toMatchObject({ refused: reason });
    expect(feed.asked).toHaveLength(0);
    expect(tg.sent).toHaveLength(0);
  });

  it("at 15:33 a cash stop has stopped while F&O continues — and only the F&O key is asked for (R8)", async () => {
    openLong("ZZCASH");
    openLong("NIFTY", {
      tradingsymbol: "NIFTY26OCT25000CE",
      exchange: "NFO",
      segment: "index_option",
      bucket: "fno",
      instrumentType: "option",
      avgBuyPrice: 150,
      slPlanned: 120,
    });
    const feed = fakeFeed({ [NSE("ZZCASH")]: 1200, "NFO:NIFTY26OCT25000CE": 110 });
    const tg = recorder();
    const out = await job.runTelegramAlerts(at(TODAY, "15:33"), deps(feed, tg.send));
    expect(out).toMatchObject({ refused: null, sent: 1 });
    expect(feed.asked).toEqual([[{ symbol: "NIFTY", exchange: "NFO", tradingsymbol: "NIFTY26OCT25000CE" }]]);
    expect(tg.sent[0].html).toContain("<b>NIFTY26OCT25000CE</b>");
  });
});

/* ──────────────────────────── settings gates ──────────────────────────── */

describe("the settings gates refuse BEFORE the feed is asked", () => {
  it("a free licence is refused (the job's own default Pro check)", async () => {
    ent.pro = false;
    openLong("ZZALPHA");
    const feed = fakeFeed({ [NSE("ZZALPHA")]: 1228.4 });
    const tg = recorder();
    expect(await job.runTelegramAlerts(NOW, deps(feed, tg.send))).toEqual({ refused: "not-pro", nextInMs: 300_000 });
    expect(feed.asked).toHaveLength(0);
  });

  it("the end-of-day feed is refused as 'end-of-day-feed' (the real resolveLiveFeed)", async () => {
    openLong("ZZALPHA");
    const feed = fakeFeed({ [NSE("ZZALPHA")]: 1228.4 });
    const d = deps(feed, recorder().send);
    delete (d as Record<string, unknown>).resolveFeed;
    expect(await job.runTelegramAlerts(NOW, d)).toMatchObject({ refused: "end-of-day-feed" });
  });

  it("a picked live feed whose consent went stale is 'feed-reaccept', never 'end-of-day' (R4)", async () => {
    t.sqlite.prepare(`UPDATE settings SET live_feed_provider = 'upstox', live_feed_ack_json = '{"upstox":"0"}'`).run();
    openLong("ZZALPHA");
    const feed = fakeFeed({ [NSE("ZZALPHA")]: 1228.4 });
    const d = deps(feed, recorder().send);
    delete (d as Record<string, unknown>).resolveFeed;
    expect(await job.runTelegramAlerts(NOW, d)).toMatchObject({ refused: "feed-reaccept" });
    expect(feed.asked).toHaveLength(0);
  });

  it("a stale Telegram ack, alerts off, and missing credentials each refuse", async () => {
    openLong("ZZALPHA");
    const run = () => job.runTelegramAlerts(NOW, deps(fakeFeed({ [NSE("ZZALPHA")]: 1228.4 }), recorder().send));
    t.sqlite.prepare("UPDATE settings SET telegram_ack_version = ?").run(CURRENT - 1);
    expect(await run()).toMatchObject({ refused: "ack-stale" });
    t.sqlite.prepare("UPDATE settings SET telegram_ack_version = ?, telegram_alerts_enabled = 0").run(CURRENT);
    expect(await run()).toMatchObject({ refused: "alerts-off" });
    t.sqlite.prepare("UPDATE settings SET telegram_alerts_enabled = 1, telegram_chat_id = NULL").run();
    expect(await run()).toMatchObject({ refused: "no-credentials" });
  });
});

/* ─────────────────────────────── the doors ─────────────────────────────── */

function postAlerts(init: { body?: string; headers?: Record<string, string> } = {}) {
  return alertsRoute.POST(
    new Request("http://localhost/api/telegram/alerts", { method: "POST", body: init.body, headers: init.headers }),
  );
}

function postTg(body: unknown) {
  return tgRoute.POST(
    new Request("http://localhost/api/telegram", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  );
}

describe("POST /api/telegram/alerts — refusals are 200, only a foreign or malformed request is 4xx (R10)", () => {
  it("a refusal answers 200 {ok:true, refused, nextInMs}", async () => {
    t.sqlite.prepare("UPDATE settings SET telegram_alerts_enabled = 0").run();
    const res = await postAlerts();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, refused: "alerts-off", nextInMs: 300_000 });
  });

  it("a cross-site request is 403 and runs nothing", async () => {
    const res = await postAlerts({ headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("a body that is not a JSON object is 400", async () => {
    expect((await postAlerts({ body: "[1,2]" })).status).toBe(400);
    expect((await postAlerts({ body: "{not json" })).status).toBe(400);
  });
});

describe("POST /api/telegram — alerts-toggle (Pro + ack to switch ON) and alerts-window", () => {
  const alertsOn = () => (t.sqlite.prepare("SELECT telegram_alerts_enabled AS v FROM settings").get() as { v: number }).v;
  const win = () => t.sqlite.prepare("SELECT telegram_alert_from AS f, telegram_alert_to AS t FROM settings").get() as { f: string | null; t: string | null };

  beforeEach(() => t.sqlite.prepare("UPDATE settings SET telegram_alerts_enabled = 0").run());

  it("enables with Pro and a current ack, and the audit row carries neither token nor chat id", async () => {
    const res = await postTg({ action: "alerts-toggle", enabled: true });
    expect(res.status).toBe(200);
    expect(alertsOn()).toBe(1);
    const audits = JSON.stringify(t.sqlite.prepare("SELECT summary, before_json, after_json FROM audit_log").all());
    expect(audits).toContain("Telegram stop/target alerts enabled");
    expect(audits).not.toContain(CHAT);
    expect(audits).not.toContain("ALERT-SECRET-TOKEN");
  });

  it("403 to switch ON without Pro, or with a stale ack — nothing flips", async () => {
    ent.pro = false;
    expect((await postTg({ action: "alerts-toggle", enabled: true })).status).toBe(403);
    expect(alertsOn()).toBe(0);
    ent.pro = true;
    t.sqlite.prepare("UPDATE settings SET telegram_ack_version = ?").run(CURRENT - 1);
    expect((await postTg({ action: "alerts-toggle", enabled: true })).status).toBe(403);
    expect(alertsOn()).toBe(0);
  });

  it("switching OFF needs neither Pro nor a current ack", async () => {
    t.sqlite.prepare("UPDATE settings SET telegram_alerts_enabled = 1, telegram_ack_version = ?").run(CURRENT - 1);
    ent.pro = false;
    expect((await postTg({ action: "alerts-toggle", enabled: false })).status).toBe(200);
    expect(alertsOn()).toBe(0);
  });

  it("a string 'true' is rejected, not coerced", async () => {
    expect((await postTg({ action: "alerts-toggle", enabled: "true" })).status).toBe(400);
    expect(alertsOn()).toBe(0);
  });

  it("the window: set, clear, and refuse a bad or inverted one", async () => {
    expect((await postTg({ action: "alerts-window", from: "10:00", to: "14:30" })).status).toBe(200);
    expect(win()).toEqual({ f: "10:00", t: "14:30" });
    expect((await postTg({ action: "alerts-window", from: "14:30", to: "10:00" })).status).toBe(400);
    expect((await postTg({ action: "alerts-window", from: "10:00", to: "10:00" })).status).toBe(400);
    expect((await postTg({ action: "alerts-window", from: "25:00", to: "10:00" })).status).toBe(400);
    expect((await postTg({ action: "alerts-window", from: "10:00", to: null })).status).toBe(400);
    expect(win()).toEqual({ f: "10:00", t: "14:30" });
    expect((await postTg({ action: "alerts-window", from: null, to: null })).status).toBe(200);
    expect(win()).toEqual({ f: null, t: null });
  });
});
