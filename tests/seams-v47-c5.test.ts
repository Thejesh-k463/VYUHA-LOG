import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { istWallClockIso } from "@/lib/domain/trading-day";
import { createMockProvider } from "@/lib/quotes/mock";
import { fromPaise, quoteKeyId, type QuoteKey, type QuoteProvider } from "@/lib/quotes/types";
import { alertsGate, ALERT_CHECK_MS, ALERT_SETTINGS_RETRY_MS, type AlertGateInput } from "@/lib/telegram/alert-gate";
import { TELEGRAM_DISCLOSURE, telegramGate } from "@/lib/domain/telegram-disclosure";
import { OPENALGO_DISCLOSURE_VERSION } from "@/lib/domain/openalgo-disclosure";
import { withFeedAck } from "@/lib/domain/live-feed-disclosure";
import {
  TELEGRAM_ALERT_STATUS_KEY,
  TELEGRAM_FAILURE_KEY,
  parseTelegramAlertStatus,
  parseTelegramFailure,
  serializeTelegramFailure,
  telegramFailureHeadline,
} from "@/lib/domain/telegram-failure";
import { telegramAlertsCardView, telegramCardView } from "@/lib/telegram/card-state";
import { applyAlertAnswer, startAlertRunner } from "@/components/system/telegram-alert-runner";
import {
  TELEGRAM_RECONSENT_DISMISS_KEY,
  dismissReconsent,
  dismissedVersion,
  shouldShowReconsent,
} from "@/components/system/telegram-reconsent-strip";
import { positionKeys } from "@/lib/live/position-keys";

/**
 * SEAM PASS — v4.7.0 wave C5 (Telegram stop/target alerts). Both real halves of
 * every value that crosses a builder boundary, run together over ONE migrated
 * temp database (tests/helpers/temp-db.ts; one per file). Nothing on either side
 * is mocked: `fetch` is stubbed as a DISPATCHER that hands `/api/telegram/alerts`
 * to the REAL route handler and `https://api.telegram.org/…` to a recording
 * transport (so the REAL `sendTelegram` runs), and throws on anything else. The
 * feed is the real mock provider under `VYUHA_QUOTE_PROVIDER=mock` (the dev/e2e
 * override the gate treats as live), or the real OpenAlgo adapter with no
 * connection on file (its snapshot throws → `feed-error`). The licence is the
 * REAL `getEntitlement()` driven by `trial_started_at`.
 *
 * Builders: A1 = server (job, door, gate, plan, format, card-state, route
 * actions, registry peek, position-keys); A2 = disclosure versions; B = runner,
 * strip, layout mounts, card, telegram-failure copy; ORCH = app/settings/page.tsx.
 *
 * ┌──────────────────────────────┬───────────────────────────────────────────────┬──────────────────────────────────────────────┬──────────────────────┬──────────┐
 * │ crossing value               │ producer (builder) file:line                  │ consumer (builder) file:line                 │ unit / type          │ case     │
 * ├──────────────────────────────┼───────────────────────────────────────────────┼──────────────────────────────────────────────┼──────────────────────┼──────────┤
 * │ refused (code | null)        │ A1 app/api/telegram/alerts/route.ts:67-71     │ B telegram-alert-runner.tsx:98,123           │ string code, JSON    │ S1, S2   │
 * │ nextInMs                     │ A1 alert-gate.ts:177,211-213; job:244,354     │ B telegram-alert-runner.tsx:59-63,122,177    │ ms, number           │ S1a-c,e  │
 * │ sent / summarySent           │ A1 route.ts:73,75                             │ B runner.tsx:116 (clears failure)            │ count / bool         │ S1a,S1f  │
 * │ failed.reason                │ A1 job:322,349 ← send.ts apiReason            │ B runner.tsx:107-115 → failure envelope      │ user sentence        │ S1d, S7  │
 * │ checked                      │ A1 route.ts:76                                │ NO CONSUMER (runner ignores it)              │ count                │ S1g      │
 * │ status envelope {refused}    │ B runner.tsx:101-104                          │ B card.tsx:132-150 → card-state.ts:69 (A1)   │ localStorage {v:1}   │ S2       │
 * │ ALERT_STATUS_COPY keys       │ A1 alert-gate.ts:41-51 + job:54 (feed-error)  │ B telegram-card.tsx:68-88                    │ code → sentence      │ S2       │
 * │ alerts props {pro,…}         │ ORCH app/settings/page.tsx:135-140            │ B telegram-card.tsx:133-144 → card-state     │ bool / "HH:MM"|null  │ S3a      │
 * │ alerts-toggle / -window body │ B telegram-card.tsx:344,385,398               │ A1 app/api/telegram/route.ts:36-39,74-118    │ JSON bool / string   │ S3b-d    │
 * │ telegram_alert_from/to       │ A1 route.ts:113                               │ A1 job:220 → alert-gate.ts:128,151           │ IST "HH:MM" text     │ S3c      │
 * │ TELEGRAM_DISCLOSURE.version  │ A2 telegram-disclosure.ts:56                  │ gate:180, strip:67-76, card-state:81,        │ NUMBER (2)           │ S4       │
 * │                              │                                               │ route.ts:62-71,125, card.tsx:180             │                      │          │
 * │ reconsent dismissal envelope │ B strip.tsx:58-60,79-81                       │ B strip.tsx:44-56,75                         │ {v:1,version:number} │ S4d      │
 * │ feed disclosure versions     │ A2 openalgo-disclosure.ts:75; live-feed:68    │ registry resolveLiveFeed → gate.ts:86-92     │ STRING ("5","2")     │ S5       │
 * │ failure envelope             │ B runner.tsx:112-114; digest runner.tsx:43-46 │ B telegram-failure.ts:131-134 (note strip)   │ {v:1,date,reason}    │ S6       │
 * │ formatAlert text / footer    │ A1 format.ts:209-217 ← disclosure.ts:93       │ A1 send.ts:68 body.text (Telegram)           │ HTML string          │ S7       │
 * │ QuoteKey per open row        │ A1 lib/live/position-keys.ts:43-62            │ stream route.ts:73, persist-mark:64, job:234 │ {symbol,exchange,ts} │ S8       │
 * └──────────────────────────────┴───────────────────────────────────────────────┴──────────────────────────────────────────────┴──────────────────────┴──────────┘
 *
 * BOUNDARIES WITH NO CASE HERE (named, with why):
 *   - app/layout.tsx → runner mount condition (`enabled && alertsEnabled`) and the strip props: the
 *     layout cannot be imported under vitest (next/font/google + globals.css). S4 drives the strip's
 *     pure condition with the layout's own read (`getSettings()`); the mount itself is e2e-only
 *     (e2e/z-telegram-alerts.spec.ts).
 *   - layout `alertsKey` remount-on-save: same reason; no unit can observe a React key.
 *   - peekLiveFeedProvider ↔ the stream's getLiveFeedProvider (one instance, one Angel One login)
 *     and the Angel One snapshot lock: owned and pinned by A1 in tests/quotes-registry.test.ts and
 *     tests/angelone-snapshot-lock.test.ts; both halves are A1's files, so it is not a cross-builder seam.
 *   - TelegramFailureNote's DOM (dismiss, notification opt-in): the note component's render needs a
 *     DOM; S6 asserts its headline function over the envelope each runner really writes.
 *   - IST day boundary (18:30–24:00 UTC) on the failure envelope's date: an alert can only be SENT
 *     inside a market session (03:45–10:10 UTC), so the door can never produce a failure in that
 *     window — no real value crosses there.
 *
 * RECORDED SEAM DEFECTS — BOTH FIXED in the C5 fix pass and flipped from `it.fails` to `it`:
 *   D-C5-1 → the job/door carry `detail: blockedReason` on feed-reaccept, the runner keeps it in
 *            its status envelope (still v:1), the card shows it (generic line names both screens).
 *   D-C5-2 → the failure envelope gained an optional `source` (absent = "digest"); an alert send
 *            clears only an alert record; a digest send still clears any record.
 * As recorded:
 *   D-C5-1 feed-reaccept copy points at "Settings → Live feed" for OpenAlgo, whose consent lives on
 *          Settings → Integrations (resolveLiveFeed's own blockedReason says so), and calls an
 *          integration that is merely OFF "the disclosure changed". The door drops blockedReason
 *          (review R4 said carry it).
 *   D-C5-2 an alert SUCCESS erases a DIGEST failure record (the alert runner clears the shared
 *          envelope without knowing whose it is); before C5 only a digest success could clear it,
 *          and the failed digest is not retried that day, so the record was the only trace.
 */

process.env.VYUHA_VAULT_PROVIDER = "machine";

/* ─────────────────────────────── harness ─────────────────────────────── */

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
const store = new MemoryStorage();
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = store;

let t: TempDb;
let alertsRoute: typeof import("@/app/api/telegram/alerts/route");
let tgRoute: typeof import("@/app/api/telegram/route");
let digestRoute: typeof import("@/app/api/telegram/digest/route");
let streamRoute: typeof import("@/app/api/live/stream/route");
let job: typeof import("@/lib/jobs/telegram-alerts");
let vault: typeof import("@/lib/vault");
let settingsQ: typeof import("@/lib/queries/settings");
let licenseQ: typeof import("@/lib/queries/license");
let registry: typeof import("@/lib/quotes/registry");
let persistMark: typeof import("@/lib/quotes/persist-mark");
let page: typeof import("@/app/settings/page");
let card: typeof import("@/components/settings/telegram-card");
let renderToStaticMarkup: typeof import("react-dom/server").renderToStaticMarkup;
let AppRouterContext: React.Context<unknown>;

const at = (date: string, hhmm: string) => new Date(istWallClockIso(date, hhmm));
const TODAY = "2026-10-07"; // an ordinary verified Wednesday
const NOW = at(TODAY, "10:42");
const TOKEN = "123456:SEAM-SECRET-TOKEN-C5";
const CHAT = "770011223344";
const CURRENT = TELEGRAM_DISCLOSURE.version;

/** The Telegram transport: records every sendMessage, answers from a queue. */
const tg = {
  calls: [] as { url: string; text: string; chatId: string }[],
  answers: [] as { status: number; body: unknown }[],
};
let doorCount = 0;
let doorCalls: Promise<Response>[] = [];

function dispatcher() {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "/api/telegram/alerts") {
      doorCount++;
      const p = alertsRoute.POST(
        new Request("http://localhost:3000/api/telegram/alerts", {
          method: init?.method ?? "GET",
          headers: { ...((init?.headers as Record<string, string>) ?? {}), "sec-fetch-site": "same-origin" },
          body: (init?.body as string | undefined) ?? undefined,
        }),
      );
      doorCalls.push(p);
      return p;
    }
    if (url.startsWith("https://api.telegram.org/")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string; chat_id?: string };
      tg.calls.push({ url, text: String(body.text ?? ""), chatId: String(body.chat_id ?? "") });
      const a = tg.answers.shift() ?? { status: 200, body: { ok: true } };
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }
    throw new Error("TEST GUARD: the alert seam reached an unexpected host");
  };
}

/** Real macrotask turns (setImmediate is NOT faked) until the runner has scheduled its next POST. */
async function untilScheduled(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await Promise.allSettled(doorCalls);
    await new Promise((r) => setImmediate(r));
    if (vi.getTimerCount() > 0) return;
  }
  throw new Error("the runner never scheduled a next POST");
}

async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.allSettled(doorCalls);
    await new Promise((r) => setImmediate(r));
  }
  doorCalls = [];
}

function setClock(d: Date, pro = true) {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date"], now: d });
  t.db
    .update(t.schema.settings)
    .set({
      licenseKey: null,
      clockHighWaterMark: null,
      trialStartedAt: pro ? new Date(d.getTime() - 86_400_000).toISOString() : "2020-01-01T00:00:00.000Z",
    })
    .run();
}

function useRunnerTimers(d: Date) {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: d });
}

function setSettings(over: Partial<typeof import("@/lib/db/schema").settings.$inferInsert>) {
  t.db.update(t.schema.settings).set(over).run();
}

/** The real mock feed's price for a key, in RUPEES (the route builds a fresh mock per call, no walk). */
async function mockMark(key: QuoteKey): Promise<number> {
  const q = (await createMockProvider().snapshot([key])).get(quoteKeyId(key))!;
  return fromPaise(q.ltp);
}

/** An open long whose recorded stop sits 5 rupees ABOVE the mock's mark → an `sl` breach. */
async function breachingLong(symbol: string, over: Record<string, unknown> = {}): Promise<{ id: number; mark: number }> {
  const mark = await mockMark({ symbol, exchange: "NSE" });
  const row = t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        symbol,
        tradingsymbol: symbol,
        buyQty: 10,
        avgBuyPrice: mark + 50,
        isOpen: true,
        slPlanned: mark + 5,
        accountId: 1,
        ...over,
      }) as typeof t.schema.trades.$inferInsert,
    )
    .returning({ id: t.schema.trades.id })
    .get();
  return { id: row.id, mark };
}

function insertTrade(over: Record<string, unknown>): number {
  return t.db
    .insert(t.schema.trades)
    .values(tradeRow({ buyQty: 10, avgBuyPrice: 100, isOpen: true, accountId: 1, ...over }) as typeof t.schema.trades.$inferInsert)
    .returning({ id: t.schema.trades.id })
    .get().id;
}

async function door(): Promise<Record<string, unknown>> {
  const res = await alertsRoute.POST(
    new Request("http://localhost:3000/api/telegram/alerts", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: "{}",
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function tgAction(body: unknown): Promise<{ status: number; json: { ok: boolean; message?: string } }> {
  const res = await tgRoute.POST(
    new Request("http://localhost:3000/api/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as { ok: boolean; message?: string } };
}

const receipts = () => t.sqlite.prepare("SELECT trade_id AS tradeId, kind, ist_date AS d FROM telegram_alerts_sent").all() as { tradeId: number; kind: string; d: string }[];

/** The card's alerts derivation, exactly as components/settings/telegram-card.tsx:132-160 wires it
 *  (since the D-C5-1 fix: the stored refusal's `detail` rides only while that refusal IS the status). */
function cardAlertsLine(p: import("@/components/settings/telegram-card").TelegramCardProps) {
  const lastStatus = parseTelegramAlertStatus(store.getItem(TELEGRAM_ALERT_STATUS_KEY));
  const view = p.alerts
    ? telegramAlertsCardView({
        enabled: p.enabled,
        ackVersion: p.ackVersion,
        connected: p.connected,
        pro: p.alerts.pro,
        alertsEnabled: p.alerts.alertsEnabled,
        windowFrom: p.alerts.alertFrom,
        windowTo: p.alerts.alertTo,
        lastRefusal: lastStatus ? lastStatus.refused : undefined,
      })
    : null;
  const detail = lastStatus && view && lastStatus.refused === view.status ? lastStatus.detail : undefined;
  return { view, line: view ? card.alertStatusLine(view.status, detail) : null };
}

/** The TelegramCard element exactly as the real SettingsPage() builds it. */
function pageCardProps(): import("@/components/settings/telegram-card").TelegramCardProps {
  const find = (node: unknown, depth = 0): React.ReactElement | null => {
    if (!node || depth > 80) return null;
    if (Array.isArray(node)) {
      for (const n of node) {
        const r = find(n, depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (typeof node !== "object" || !("type" in (node as object))) return null;
    const el = node as React.ReactElement<{ children?: unknown }>;
    if (el.type === card.TelegramCard) return el;
    return find(el.props?.children, depth + 1);
  };
  const el = find(page.default());
  if (!el) throw new Error("SettingsPage rendered no TelegramCard");
  return el.props as import("@/components/settings/telegram-card").TelegramCardProps;
}

function renderCard(p: import("@/components/settings/telegram-card").TelegramCardProps): string {
  const router = { refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
  return renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: router }, React.createElement(card.TelegramCard, p)));
}

/* ─────────────────────────────── lifecycle ─────────────────────────────── */

beforeAll(async () => {
  t = await openTempDb("seams-v47-c5", { seed: true });
});
beforeAll(async () => {
  alertsRoute = await import("@/app/api/telegram/alerts/route");
  tgRoute = await import("@/app/api/telegram/route");
  digestRoute = await import("@/app/api/telegram/digest/route");
  job = await import("@/lib/jobs/telegram-alerts");
  vault = await import("@/lib/vault");
  settingsQ = await import("@/lib/queries/settings");
  licenseQ = await import("@/lib/queries/license");
  registry = await import("@/lib/quotes/registry");
  persistMark = await import("@/lib/quotes/persist-mark");
});
beforeAll(async () => {
  page = await import("@/app/settings/page");
});
beforeAll(async () => {
  streamRoute = await import("@/app/api/live/stream/route");
  card = await import("@/components/settings/telegram-card");
  renderToStaticMarkup = (await import("react-dom/server")).renderToStaticMarkup;
  AppRouterContext = (await import("next/dist/shared/lib/app-router-context.shared-runtime")).AppRouterContext as React.Context<unknown>;
});
beforeAll(async () => {
  // Warm every lazy path once, in a hook, so no `it` pays for a first import.
  setClock(NOW);
  vi.stubGlobal("fetch", dispatcher());
  process.env.VYUHA_QUOTE_PROVIDER = "mock";
  pageCardProps();
  await door();
  await job.runTelegramAlerts(NOW, { send: async () => ({ ok: true }) });
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.VYUHA_QUOTE_PROVIDER;
  t?.cleanup();
});

beforeEach(() => {
  setClock(NOW);
  for (const tbl of ["trades", "telegram_alerts_sent", "audit_log"]) t.sqlite.prepare(`DELETE FROM ${tbl}`).run();
  t.sqlite.prepare("DELETE FROM accounts WHERE id > 1").run();
  t.sqlite
    .prepare(
      `UPDATE settings SET telegram_enabled = 1, telegram_ack_version = ?, telegram_token_enc = ?, telegram_chat_id = ?,
       telegram_alerts_enabled = 1, telegram_alert_from = NULL, telegram_alert_to = NULL,
       last_telegram_alert_summary_date = NULL, last_telegram_sent_date = NULL, selected_account_id = 1,
       live_feed_provider = 'eod', live_feed_ack_json = NULL, openalgo_enabled = 0, openalgo_ack_version = NULL`,
    )
    .run(CURRENT, vault.encryptSecret(TOKEN), CHAT);
  process.env.VYUHA_QUOTE_PROVIDER = "mock";
  registry.resetLiveFeedProviderCache();
  store.clear();
  tg.calls = [];
  tg.answers = [];
  doorCount = 0;
  doorCalls = [];
  vi.stubGlobal("fetch", dispatcher());
});
afterEach(async () => {
  await drain();
  vi.useRealTimers();
});

/* ═══════════════ S1 — the door's answer → the runner's schedule + envelopes ═══════════════ */

describe("S1 door → runner: the real route's answer drives startAlertRunner", () => {
  it("S1a armed + sent: the Telegram send lands, a stored ALERT failure is CLEARED, status null, next POST at 60 s", async () => {
    await breachingLong("ZZSEAMA");
    // An ALERT record (D-C5-2: an alert send clears only its own sender's record; S6 pins the digest side).
    store.setItem(
      TELEGRAM_FAILURE_KEY,
      serializeTelegramFailure({ date: "2026-10-06", reason: "Telegram answered HTTP 502.", at: "x", source: "alert" }),
    );
    useRunnerTimers(NOW);
    const h = startAlertRunner({ isOnLive: () => false });
    await untilScheduled();
    expect(tg.calls).toHaveLength(1);
    expect(store.getItem(TELEGRAM_FAILURE_KEY)).toBeNull();
    expect(parseTelegramAlertStatus(store.getItem(TELEGRAM_ALERT_STATUS_KEY))?.refused).toBeNull();
    vi.advanceTimersByTime(ALERT_CHECK_MS - 1);
    expect(doorCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect(doorCount).toBe(2);
    h.stop();
  });

  it("S1a' armed on /live: the next POST comes at the 15 s floor, not the server's 60 s", async () => {
    await breachingLong("ZZSEAMA");
    useRunnerTimers(NOW);
    const h = startAlertRunner({ isOnLive: () => true });
    await untilScheduled();
    vi.advanceTimersByTime(14_999);
    expect(doorCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect(doorCount).toBe(2);
    h.stop();
  });

  it("S1b market-closed at 09:05 IST: the gate's nextInMs (to 09:15) crosses the wire and IS the wait", async () => {
    await breachingLong("ZZSEAMA");
    const preOpen = at(TODAY, "09:05");
    setClock(preOpen);
    expect(await door()).toEqual({ ok: true, refused: "market-closed", nextInMs: 600_000 });
    useRunnerTimers(preOpen);
    const h = startAlertRunner({ isOnLive: () => true }); // /live floor must NOT apply while refused
    await untilScheduled();
    expect(parseTelegramAlertStatus(store.getItem(TELEGRAM_ALERT_STATUS_KEY))?.refused).toBe("market-closed");
    vi.advanceTimersByTime(600_000 - 1);
    expect(doorCount).toBe(1); // the runner's first POST (the direct door() above bypasses fetch)
    vi.advanceTimersByTime(1);
    expect(doorCount).toBe(2);
    h.stop();
    expect(tg.calls).toHaveLength(0);
  });

  it("S1c a free licence: refused not-pro at the 5-minute settings cadence, no send, no failure envelope", async () => {
    await breachingLong("ZZSEAMA");
    setClock(NOW, false);
    expect(licenseQ.getEntitlement().pro).toBe(false);
    useRunnerTimers(NOW);
    const h = startAlertRunner({ isOnLive: () => false });
    await untilScheduled();
    expect(parseTelegramAlertStatus(store.getItem(TELEGRAM_ALERT_STATUS_KEY))?.refused).toBe("not-pro");
    expect(store.getItem(TELEGRAM_FAILURE_KEY)).toBeNull();
    vi.advanceTimersByTime(ALERT_SETTINGS_RETRY_MS - 1);
    expect(doorCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect(doorCount).toBe(2);
    h.stop();
    expect(tg.calls).toHaveLength(0);
  });

  it("S1d one sent then a 401: the runner RECORDS the failure (failed outranks sent>0); the receipt is released", async () => {
    const a = await breachingLong("ZZSEAMA");
    await breachingLong("ZZSEAMB");
    tg.answers = [
      { status: 200, body: { ok: true } },
      { status: 401, body: { ok: false, description: "Unauthorized" } },
    ];
    useRunnerTimers(NOW);
    const h = startAlertRunner({ isOnLive: () => false });
    await untilScheduled();
    h.stop();
    expect(tg.calls).toHaveLength(2);
    const rec = parseTelegramFailure(store.getItem(TELEGRAM_FAILURE_KEY));
    expect(rec).toEqual({
      date: TODAY,
      reason: "Telegram rejected the bot token (HTTP 401) — Unauthorized. Re-check it with BotFather.",
      at: NOW.toISOString(),
      source: "alert",
    });
    expect(receipts().map((r) => r.tradeId)).toHaveLength(1);
    expect(receipts().map((r) => r.tradeId)).not.toContain(undefined);
    expect(a.id).toBeGreaterThan(0);
  });

  it("S1e feed-error (OpenAlgo picked, consent current, no connection on file): 60 s retry, NO failure envelope", async () => {
    delete process.env.VYUHA_QUOTE_PROVIDER;
    setSettings({ liveFeedProvider: "openalgo", openalgoEnabled: true, openalgoAckVersion: OPENALGO_DISCLOSURE_VERSION });
    await breachingLong("ZZSEAMA");
    useRunnerTimers(NOW);
    const h = startAlertRunner({ isOnLive: () => true });
    await untilScheduled();
    expect(parseTelegramAlertStatus(store.getItem(TELEGRAM_ALERT_STATUS_KEY))?.refused).toBe("feed-error");
    expect(store.getItem(TELEGRAM_FAILURE_KEY)).toBeNull();
    vi.advanceTimersByTime(ALERT_CHECK_MS - 1);
    expect(doorCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect(doorCount).toBe(2);
    h.stop();
    expect(tg.calls).toHaveLength(0);
  });

  it("S1f the cap spent earlier today: the door answers sent 0 + summarySent, and the runner CLEARS a stored ALERT failure", async () => {
    const ins = t.sqlite.prepare("INSERT INTO telegram_alerts_sent (trade_id, symbol, kind, ist_date, level, mark, sent_at) VALUES (?, ?, 'sl', ?, 1, 1, ?)");
    for (let i = 0; i < 20; i++) ins.run(900_000 + i, `ZZCAP${i}`, TODAY, NOW.toISOString());
    await breachingLong("ZZSEAMA");
    store.setItem(
      TELEGRAM_FAILURE_KEY,
      serializeTelegramFailure({ date: TODAY, reason: "Telegram answered HTTP 502.", at: "x", source: "alert" }),
    );
    useRunnerTimers(NOW);
    const h = startAlertRunner({ isOnLive: () => false });
    await untilScheduled();
    h.stop();
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0].text).toContain("1 more breach of your recorded levels today, past the daily limit of 20 alerts");
    expect(store.getItem(TELEGRAM_FAILURE_KEY)).toBeNull();
  });

  it("S1g `checked` is the count of positions the job priced — and nothing on the client reads it", async () => {
    await breachingLong("ZZSEAMA");
    insertTrade({ symbol: "ZZSEAMC", tradingsymbol: "ZZSEAMC", slPlanned: 1 }); // priced, not breached
    const body = await door();
    expect(body).toMatchObject({ ok: true, refused: null, sent: 1, checked: 2, failed: null, summarySent: false, nextInMs: ALERT_CHECK_MS });
    // The runner's answer type keeps only nextInMs + armed (telegram-alert-runner.tsx:48-52).
    expect(applyAlertAnswer(body, NOW)).toEqual({ nextInMs: ALERT_CHECK_MS, armed: true });
  });
});

/* ═══════════════ S2 — every reason code the server can emit → the card's one status line ═══════════════ */

const PRODUCED = new Set<string>();

describe("S2 reason codes: produced by the REAL door from real settings, rendered by the card's map", () => {
  type Setup = () => Promise<void> | void;
  const cases: [string, Setup][] = [
    ["not-pro", () => setClock(NOW, false)],
    ["telegram-off", () => setSettings({ telegramEnabled: false })],
    ["ack-stale", () => setSettings({ telegramAckVersion: CURRENT - 1 })],
    ["alerts-off", () => setSettings({ telegramAlertsEnabled: false })],
    ["no-credentials", () => setSettings({ telegramChatId: null })],
    [
      "feed-reaccept",
      () => {
        delete process.env.VYUHA_QUOTE_PROVIDER;
        setSettings({ liveFeedProvider: "upstox", liveFeedAckJson: JSON.stringify({ upstox: "1" }) });
      },
    ],
    ["end-of-day-feed", () => void delete process.env.VYUHA_QUOTE_PROVIDER],
    ["no-checkable-position", () => void t.sqlite.prepare("DELETE FROM trades").run()],
    ["calendar-unverified", () => setClock(at("2027-01-06", "10:42"))],
    ["market-closed", () => setClock(at(TODAY, "16:10"))],
    [
      "feed-error",
      () => {
        delete process.env.VYUHA_QUOTE_PROVIDER;
        setSettings({ liveFeedProvider: "openalgo", openalgoEnabled: true, openalgoAckVersion: OPENALGO_DISCLOSURE_VERSION });
      },
    ],
  ];

  it.each(cases)("%s: the door emits it, the runner stores it, the card has a line for it", async (code, setup) => {
    await breachingLong("ZZSEAMA");
    await setup();
    const body = await door();
    expect(body.refused).toBe(code);
    PRODUCED.add(String(body.refused));
    applyAlertAnswer(body, new Date());
    const stored = parseTelegramAlertStatus(store.getItem(TELEGRAM_ALERT_STATUS_KEY));
    expect(stored?.refused).toBe(code);
    expect(card.alertStatusLine(stored!.refused)).toBe((card.ALERT_STATUS_COPY as Record<string, string>)[code]);
    expect(tg.calls).toHaveLength(0);
  });

  it("the produced set and the card's copy map are the SAME set — no code without a line, no line without a code", () => {
    expect(PRODUCED.size).toBe(cases.length);
    expect([...PRODUCED].sort()).toEqual(Object.keys(card.ALERT_STATUS_COPY).sort());
  });

  it("which lines the card can actually SHOW: the section needs Telegram on + ack current + connected, so three lines are shadowed", () => {
    // Observation, not a defect: ack-stale has its own banner (telegram-card.tsx:205-216),
    // telegram-off / alerts-off hide the section or the status. Pinned so a change is deliberate.
    const shown: string[] = [];
    for (const code of Object.keys(card.ALERT_STATUS_COPY)) {
      store.setItem(TELEGRAM_ALERT_STATUS_KEY, JSON.stringify({ v: 1, refused: code, at: "x" }));
      const ackVersion = code === "ack-stale" ? CURRENT - 1 : CURRENT;
      const { view, line } = cardAlertsLine({
        enabled: code !== "telegram-off",
        ackVersion,
        sendTime: "15:45",
        lastSentDate: null,
        connected: true,
        chatId: CHAT,
        alerts: { pro: code !== "not-pro", alertsEnabled: code !== "alerts-off", alertFrom: null, alertTo: null },
      });
      if (view?.showAlertsSection && (view.proLocked || line)) shown.push(code);
    }
    expect(shown.sort()).toEqual(
      ["calendar-unverified", "end-of-day-feed", "feed-error", "feed-reaccept", "market-closed", "no-checkable-position", "no-credentials", "not-pro"].sort(),
    );
  });
});

/* ═══════════════ S3 — page props → card; card's route actions → page read → job ═══════════════ */

describe("S3 app/settings/page.tsx builds the card's alerts props; the route round-trips them", () => {
  it("S3a Pro: the page's alerts props reach the card and render the alerts section with the stored window", () => {
    setSettings({ telegramAlertFrom: "10:50", telegramAlertTo: "12:00" });
    const p = pageCardProps();
    expect(p.alerts).toEqual({ pro: true, alertsEnabled: true, alertFrom: "10:50", alertTo: "12:00" });
    const html = renderCard(p);
    expect(html).toContain('data-testid="telegram-alerts"');
    expect(html).toContain('value="10:50"');
    expect(html).toContain('value="12:00"');
    expect(html).not.toContain('data-testid="telegram-alerts-pro"');
  });

  it("S3a' free: the page passes pro=false, the card shows the Pro line and the switch cannot be turned ON", () => {
    setClock(NOW, false);
    setSettings({ telegramAlertsEnabled: false });
    const p = pageCardProps();
    expect(p.alerts?.pro).toBe(false);
    const html = renderCard(p);
    expect(html).toContain(card.ALERT_STATUS_COPY["not-pro"]);
    expect(html).toMatch(/data-testid="telegram-alerts-switch"[^>]*disabled=""|disabled=""[^>]*data-testid="telegram-alerts-switch"/);
  });

  it("S3b alerts-toggle: ON for Pro is stored and read back by the page; ON for free is 403; OFF never needs consent", async () => {
    setSettings({ telegramAlertsEnabled: false });
    expect((await tgAction({ action: "alerts-toggle", enabled: true })).status).toBe(200);
    expect(pageCardProps().alerts?.alertsEnabled).toBe(true);

    setSettings({ telegramAlertsEnabled: false });
    setClock(NOW, false);
    expect((await tgAction({ action: "alerts-toggle", enabled: true })).status).toBe(403);
    expect(settingsQ.getSettings()!.telegramAlertsEnabled).toBe(false);

    setClock(NOW, true);
    setSettings({ telegramAlertsEnabled: true, telegramAckVersion: CURRENT - 1 });
    expect((await tgAction({ action: "alerts-toggle", enabled: true })).status).toBe(403);
    expect((await tgAction({ action: "alerts-toggle", enabled: false })).status).toBe(200);
    expect(settingsQ.getSettings()!.telegramAlertsEnabled).toBe(false);
    // A string "true" is refused, never coerced.
    expect((await tgAction({ action: "alerts-toggle", enabled: "true" })).status).toBe(400);
  });

  it("S3c alerts-window: the route stores the window the card sends, and the JOB's gate obeys it (narrows, never widens)", async () => {
    await breachingLong("ZZSEAMA");
    expect((await tgAction({ action: "alerts-window", from: "10:50", to: "12:00" })).status).toBe(200);
    expect(pageCardProps().alerts).toMatchObject({ alertFrom: "10:50", alertTo: "12:00" });
    // 10:42 is inside market hours but outside the user's window → wait until 10:50.
    expect(await door()).toEqual({ ok: true, refused: "market-closed", nextInMs: 8 * 60_000 });
    expect((await tgAction({ action: "alerts-window", from: null, to: null })).status).toBe(200);
    expect(pageCardProps().alerts).toMatchObject({ alertFrom: null, alertTo: null });
    expect(await door()).toMatchObject({ refused: null, sent: 1 });
  });

  it("S3d the card's window validation and the route's agree on every shape the card can send", async () => {
    const shapes: [string, string][] = [
      ["10:50", "12:00"],
      ["", ""],
      ["12:00", "10:50"],
      ["10:50", "10:50"],
      ["10:50", ""],
      ["", "12:00"],
      ["25:00", "26:00"],
      ["9:30", "11:00"],
      ["abc", "12:00"],
    ];
    for (const [from, to] of shapes) {
      const cardOk = card.alertWindowError(from, to) === null;
      // exactly what the card's Save button sends (telegram-card.tsx:383-385)
      const r = await tgAction({ action: "alerts-window", from: from.trim() || null, to: to.trim() || null });
      expect({ from, to, routeOk: r.status === 200 }).toEqual({ from, to, routeOk: cardOk });
    }
  });
});

/* ═══════════════ S4 — TELEGRAM_DISCLOSURE.version (a NUMBER) across every reader ═══════════════ */

describe("S4 the disclosure version: a stored 1 refused everywhere, 2 accepted everywhere", () => {
  /** Every reader of the stored ack, each with its own real code. */
  async function readers() {
    const s = settingsQ.getSettings()!;
    const gate = telegramGate({ enabled: s.telegramEnabled, ackVersion: s.telegramAckVersion });
    const strip = shouldShowReconsent({
      telegramEnabled: s.telegramEnabled,
      ackVersion: s.telegramAckVersion ?? null, // app/layout.tsx passes exactly this
      currentVersion: TELEGRAM_DISCLOSURE.version,
      dismissed: dismissedVersion(store.getItem(TELEGRAM_RECONSENT_DISMISS_KEY)),
    });
    const cardView = telegramCardView({ enabled: s.telegramEnabled, ackVersion: s.telegramAckVersion, connected: true });
    const body = await door();
    const toggle = await tgAction({ action: "alerts-toggle", enabled: true });
    return { stored: s.telegramAckVersion, gate: gate.allowed, strip, ackStale: cardView.ackStale, doorRefused: body.refused, toggle: toggle.status };
  }

  it("S4a a v1 acknowledgement: gate closed, strip shown, card stale, door ack-stale, alerts-toggle 403", async () => {
    await breachingLong("ZZSEAMA");
    setSettings({ telegramAckVersion: 1 });
    expect(await readers()).toEqual({ stored: 1, gate: false, strip: true, ackStale: true, doorRefused: "ack-stale", toggle: 403 });
    expect(tg.calls).toHaveLength(0);
  });

  it("S4b the card's accept() posts the constant; the route stores it; every reader then accepts", async () => {
    await breachingLong("ZZSEAMA");
    setSettings({ telegramAckVersion: 1, telegramEnabled: false });
    // telegram-card.tsx:180 — { action: "toggle", enabled: true, ackVersion: TELEGRAM_DISCLOSURE.version }
    expect((await tgAction({ action: "toggle", enabled: true, ackVersion: TELEGRAM_DISCLOSURE.version })).status).toBe(200);
    expect(await readers()).toEqual({ stored: 2, gate: true, strip: false, ackStale: false, doorRefused: null, toggle: 200 });
  });

  it("S4c the STRING '2': the route refuses it (400, nothing stored); a text '2' in the column reads back as the number", async () => {
    setSettings({ telegramAckVersion: 1, telegramEnabled: false });
    expect((await tgAction({ action: "toggle", enabled: true, ackVersion: "2" })).status).toBe(400);
    expect(settingsQ.getSettings()!.telegramAckVersion).toBe(1);
    t.sqlite.prepare("UPDATE settings SET telegram_ack_version = '2', telegram_enabled = 1").run();
    const r = await readers();
    expect(r).toMatchObject({ stored: 2, gate: true, strip: false, ackStale: false, toggle: 200 });
    expect(r.doorRefused).not.toBe("ack-stale");
  });

  it("S4d the strip's dismissal: an older version's dismissal does not hide v2; the strip's own dismiss does", () => {
    setSettings({ telegramAckVersion: 1 });
    const show = () =>
      shouldShowReconsent({
        telegramEnabled: true,
        ackVersion: settingsQ.getSettings()!.telegramAckVersion ?? null,
        currentVersion: TELEGRAM_DISCLOSURE.version,
        dismissed: dismissedVersion(store.getItem(TELEGRAM_RECONSENT_DISMISS_KEY)),
      });
    expect(show()).toBe(true);
    dismissReconsent(1);
    expect(show()).toBe(true);
    dismissReconsent(); // the button: the CURRENT version
    expect(show()).toBe(false);
  });
});

/* ═══════════════ S5 — feed disclosure versions → resolveLiveFeed → the gate's feed step ═══════════════ */

describe("S5 the feed versions (A2) → resolveLiveFeed (registry) → feed-reaccept vs end-of-day-feed (A1)", () => {
  const cases: [string, Record<string, unknown>, string, string][] = [
    ["OpenAlgo accepted at the pre-C5 '4'", { liveFeedProvider: "openalgo", openalgoEnabled: true, openalgoAckVersion: "4" }, "eod", "feed-reaccept"],
    ["OpenAlgo accepted at the current version", { liveFeedProvider: "openalgo", openalgoEnabled: true, openalgoAckVersion: OPENALGO_DISCLOSURE_VERSION }, "openalgo", "no-checkable-position"],
    ["Upstox accepted at the pre-C5 '1'", { liveFeedProvider: "upstox", liveFeedAckJson: JSON.stringify({ upstox: "1" }) }, "eod", "feed-reaccept"],
    ["Upstox accepted as the settings route writes it today", { liveFeedProvider: "upstox", liveFeedAckJson: withFeedAck(null, "upstox") }, "upstox", "no-checkable-position"],
    ["Angel One accepted at the pre-C5 '1'", { liveFeedProvider: "angelone", liveFeedAckJson: JSON.stringify({ angelone: "1", upstox: "2" }) }, "eod", "feed-reaccept"],
    ["Angel One accepted as the settings route writes it today", { liveFeedProvider: "angelone", liveFeedAckJson: withFeedAck(JSON.stringify({ upstox: "1" }), "angelone") }, "angelone", "no-checkable-position"],
    ["end-of-day picked", { liveFeedProvider: "eod" }, "eod", "end-of-day-feed"],
    ["typed marks picked", { liveFeedProvider: "manual" }, "manual", "end-of-day-feed"],
  ];
  it.each(cases)("%s", async (_label, over, effective, refused) => {
    delete process.env.VYUHA_QUOTE_PROVIDER;
    setSettings(over as never);
    t.sqlite.prepare("DELETE FROM trades").run(); // the feed step passing lands on the next gate, never the network
    expect((await registry.resolveLiveFeed()).effective).toBe(effective);
    expect((await door()).refused).toBe(refused);
  });

  it("D-C5-1: for OpenAlgo the card's feed-reaccept line names where the consent actually lives (Integrations)", async () => {
    delete process.env.VYUHA_QUOTE_PROVIDER;
    setSettings({ liveFeedProvider: "openalgo", openalgoEnabled: true, openalgoAckVersion: "4" });
    const feed = await registry.resolveLiveFeed();
    expect(feed.blockedReason).toContain("Settings → Integrations");
    const body = await door();
    // The door carries the registry's own reason (R4) — and nothing secret.
    expect(body).toMatchObject({ refused: "feed-reaccept", detail: feed.blockedReason });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    applyAlertAnswer(body, NOW);
    const { line } = cardAlertsLine(pageCardProps());
    // The registry's own reason sends the user to Integrations, and the card now shows it verbatim.
    expect(line).toContain("Integrations");
    expect(line).toContain(feed.blockedReason!);

    // The integration merely OFF is a different cause — the card says so, not "the disclosure changed".
    setSettings({ openalgoEnabled: false });
    const off = await registry.resolveLiveFeed();
    expect(off.blockedReason).toMatch(/integration is off/i);
    applyAlertAnswer(await door(), NOW);
    const offLine = cardAlertsLine(pageCardProps()).line;
    expect(offLine).toContain(off.blockedReason!);
    expect(offLine).not.toMatch(/disclosure changed/i);
  });
});

/* ═══════════════ S6 — the failure envelope each runner writes → the note's headline ═══════════════ */

describe("S6 failure envelope → TelegramFailureNote headline (alert vs digest)", () => {
  it("an ALERT failure and a DIGEST failure both render the sender's reason verbatim under one 'Telegram message' headline", async () => {
    // Alert: the real door with a 400 from Telegram, applied by the real runner function.
    await breachingLong("ZZSEAMA");
    tg.answers = [{ status: 400, body: { ok: false, description: "Bad Request: chat not found" } }];
    applyAlertAnswer(await door(), NOW);
    const alertRec = parseTelegramFailure(store.getItem(TELEGRAM_FAILURE_KEY))!;
    expect(telegramFailureHeadline(alertRec)).toBe(
      `Telegram message not sent (${TODAY}): Telegram rejected the message (HTTP 400) — Bad Request: chat not found. Re-check the chat id.`,
    );

    // Digest: the real digest route after the send time, its answer written the way
    // components/system/telegram-runner.tsx:42-46 writes it.
    store.clear();
    setClock(at(TODAY, "17:00"));
    tg.answers = [{ status: 401, body: { ok: false, description: "Unauthorized" } }];
    const d = (await (await digestRoute.POST()).json()) as { failed?: boolean; reason?: string; date?: string };
    expect(d.failed).toBe(true);
    store.setItem(TELEGRAM_FAILURE_KEY, serializeTelegramFailure({ date: d.date ?? null, reason: String(d.reason), at: new Date().toISOString() }));
    const digestRec = parseTelegramFailure(store.getItem(TELEGRAM_FAILURE_KEY))!;
    expect(telegramFailureHeadline(digestRec)).toBe(
      `Telegram message not sent (${TODAY}): Telegram rejected the bot token (HTTP 401) — Unauthorized. Re-check it with BotFather.`,
    );
    for (const rec of [alertRec, digestRec]) {
      expect(telegramFailureHeadline(rec)).not.toContain(TOKEN);
      expect(telegramFailureHeadline(rec)).not.toContain(CHAT);
    }
  });

  it("the same failure the minute after does not rewrite the record (a dismissal survives the runner's cadence)", async () => {
    await breachingLong("ZZSEAMA");
    tg.answers = [{ status: 401, body: { ok: false, description: "Unauthorized" } }];
    applyAlertAnswer(await door(), NOW);
    const first = parseTelegramFailure(store.getItem(TELEGRAM_FAILURE_KEY))!;
    store.setItem(TELEGRAM_FAILURE_KEY, serializeTelegramFailure({ ...first, dismissed: true }));
    setClock(at(TODAY, "10:43"));
    tg.answers = [{ status: 401, body: { ok: false, description: "Unauthorized" } }];
    applyAlertAnswer(await door(), new Date());
    expect(parseTelegramFailure(store.getItem(TELEGRAM_FAILURE_KEY))?.dismissed).toBe(true);
  });

  it("D-C5-2: an alert SUCCESS leaves yesterday's DIGEST failure on file (only a digest send may clear it)", async () => {
    // The digest failed yesterday after the close; it is not retried today.
    store.setItem(
      TELEGRAM_FAILURE_KEY,
      serializeTelegramFailure({ date: "2026-10-06", reason: "Telegram answered HTTP 502.", at: "2026-10-06T11:00:00.000Z" }),
    );
    await breachingLong("ZZSEAMA");
    applyAlertAnswer(await door(), NOW); // an alert lands at 10:42
    expect(tg.calls).toHaveLength(1);
    expect(parseTelegramFailure(store.getItem(TELEGRAM_FAILURE_KEY))?.date).toBe("2026-10-06");
  });

  it("D-C5-2 (the other three cells): the digest's own success clears either record; an alert success clears an alert record; each runner stamps its source", async () => {
    // The alert runner stamps "alert" on the failure it writes…
    await breachingLong("ZZSEAMA");
    tg.answers = [{ status: 401, body: { ok: false, description: "Unauthorized" } }];
    applyAlertAnswer(await door(), NOW);
    expect(parseTelegramFailure(store.getItem(TELEGRAM_FAILURE_KEY))?.source).toBe("alert");
    // …and its next confirmed send clears that record (receipt released on failure → resent).
    applyAlertAnswer(await door(), NOW);
    expect(store.getItem(TELEGRAM_FAILURE_KEY)).toBeNull();
    // The digest runner writes "digest" and clears unconditionally on its own success (source pin:
    // components/system/telegram-runner.tsx is a DOM component; its two writes are asserted by text).
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/system/telegram-runner.tsx", "utf8");
    expect(src).toMatch(/source: "digest"/);
    expect(src).toMatch(/writeStored\(TELEGRAM_FAILURE_KEY, null\)/);
  });
});

/* ═══════════════ S7 — formatAlert through the real sender: text, footer, no secrets ═══════════════ */

describe("S7 formatAlert → sendTelegram → Telegram: what leaves the machine", () => {
  it("the sent text is levels only, names the escaped account with > 1 account, and ends on the disclosure's footer", async () => {
    t.db.insert(t.schema.accounts).values({ id: 2, name: "R&D <desk>", isDefault: false }).run();
    const { mark } = await breachingLong("ZZSEAMA", { accountId: 2, buyQty: 37 });
    await door();
    expect(tg.calls).toHaveLength(1);
    const { url, text, chatId } = tg.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(chatId).toBe(CHAT);
    expect(text.endsWith(`\n${TELEGRAM_DISCLOSURE.footer}`)).toBe(true);
    expect(text).toContain("<b>ZZSEAMA</b> · R&amp;D &lt;desk&gt;: mark ");
    expect(text).toContain(`through your recorded stop ${(mark + 5).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    expect(text).toContain("checked 10:42 IST via the mock feed");
    expect(text).not.toMatch(/\b37\b|₹|Rs\.?\s/);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(CHAT);
  });

  it.each([
    [401, { ok: false, description: "Unauthorized" }],
    [400, { ok: false, description: "Bad Request: chat not found" }],
    [403, { ok: false, description: "Forbidden: bot was blocked by the user" }],
    [500, "<html>gateway</html>"],
  ])("a Telegram %s: neither the door's answer, the failure envelope nor the headline carries the token or chat id", async (status, body) => {
    await breachingLong("ZZSEAMA");
    tg.answers = [{ status, body }];
    const answer = await door();
    expect(answer).toMatchObject({ refused: null, sent: 0 });
    expect((answer.failed as { reason: string }).reason.length).toBeGreaterThan(10);
    applyAlertAnswer(answer, NOW);
    const raw = store.getItem(TELEGRAM_FAILURE_KEY)!;
    for (const s of [JSON.stringify(answer), raw, telegramFailureHeadline(parseTelegramFailure(raw)!)]) {
      expect(s).not.toContain(TOKEN);
      expect(s).not.toContain(CHAT);
      expect(s).not.toContain("SEAM-SECRET");
    }
    expect(receipts()).toEqual([]); // the claim was released for the next check
  });
});

/* ═══════════════ S8 — position-keys → the stream route, persist-mark and the job ═══════════════ */

describe("S8 one key rule: the stream's snapshot, persist-mark and the alert job agree on a mixed book", () => {
  /** What HEAD ced6e3e's private copies produced for this book (verified by running HEAD's rule; see report). */
  const HEAD_KEYS = [
    "BSE:TCS",
    "MCX:CRUDEOIL26OCTFUT",
    "NFO:NIFTY26OCT25000CE",
    "NSE:HDFCBANK",
    "NSE:RELIANCE",
    "NSE:SBIN",
    "NSE:TCS",
  ];
  function mixedBook() {
    insertTrade({ symbol: " reliance ", tradingsymbol: "RELIANCE", exchange: "nse", slPlanned: 1 });
    insertTrade({ symbol: "TCS", tradingsymbol: "TCS", exchange: "NSE", slPlanned: 1 });
    insertTrade({ symbol: "TCS", tradingsymbol: "TCS", exchange: "NSE", slPlanned: 1 }); // duplicate
    insertTrade({ symbol: "TCS", tradingsymbol: "TCS", exchange: "BSE", slPlanned: 1 });
    insertTrade({
      symbol: "NIFTY",
      tradingsymbol: "NIFTY26OCT25000CE",
      exchange: "NFO",
      segment: "index_option",
      instrumentType: "option",
      slPlanned: 1,
    });
    insertTrade({ symbol: "SBIN", tradingsymbol: "SBIN", exchange: "", slPlanned: 1 }); // blank exchange → NSE key, no market
    insertTrade({ symbol: "WIPRO", tradingsymbol: "WIPRO", exchange: "NSE", isOpen: false, sellQty: 10, slPlanned: 1 }); // closed
    insertTrade({
      symbol: "CRUDEOIL",
      tradingsymbol: "CRUDEOIL26OCTFUT",
      exchange: "MCX",
      segment: "commodity_future",
      instrumentType: "future",
      slPlanned: 1,
    });
    insertTrade({ symbol: "HDFCBANK", tradingsymbol: "HDFCBANK", exchange: "NSE" }); // no recorded level
  }

  async function streamSnapshotKeys(): Promise<QuoteKey[]> {
    const ctrl = new AbortController();
    const res = await streamRoute.GET(new Request("http://localhost:3000/api/live/stream", { signal: ctrl.signal, headers: { "sec-fetch-site": "same-origin" } }));
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (let i = 0; i < 50; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        const m = /event: snapshot\ndata: (.*)\n\n/.exec(buf);
        if (m) return (JSON.parse(m[1]) as { quotes: { key: QuoteKey }[] }).quotes.map((q) => q.key);
      }
      throw new Error("no snapshot frame");
    } finally {
      ctrl.abort();
      await reader.cancel().catch(() => {});
    }
  }

  it("stream snapshot keys == persist-mark keys == HEAD's private copies, key for key", async () => {
    mixedBook();
    const stream = await streamSnapshotKeys();
    const pm = await persistMark.openPositionKeys();
    const norm = (ks: QuoteKey[]) => ks.map((k) => JSON.stringify([quoteKeyId(k), k.symbol, k.exchange, k.tradingsymbol ?? null])).sort();
    expect(norm(stream)).toEqual(norm(pm));
    expect(stream.map(quoteKeyId).sort()).toEqual(HEAD_KEYS);
    expect(pm.find((k) => k.exchange === "NFO")).toEqual({ symbol: "NIFTY", exchange: "NFO", tradingsymbol: "NIFTY26OCT25000CE" });
    expect(pm.find((k) => quoteKeyId(k) === "NSE:RELIANCE")).toEqual({ symbol: "RELIANCE", exchange: "NSE", tradingsymbol: "RELIANCE" });
  });

  it("the job asks the feed for EXACTLY the stream's keys of the alertable rows (no MCX, no blank exchange, no level-less row)", async () => {
    mixedBook();
    const asked: QuoteKey[][] = [];
    const real = createMockProvider();
    const spy: QuoteProvider = { ...real, snapshot: (keys, signal) => (asked.push([...keys]), real.snapshot(keys, signal)) };
    const out = await job.runTelegramAlerts(NOW, { getProvider: async () => spy, send: async () => ({ ok: true }) });
    expect(out.refused).toBeNull();
    expect(asked).toHaveLength(1);
    const stream = await streamSnapshotKeys();
    const want = stream.filter((k) => ["NSE:RELIANCE", "NSE:TCS", "BSE:TCS", "NFO:NIFTY26OCT25000CE"].includes(quoteKeyId(k)));
    const norm = (ks: QuoteKey[]) => ks.map((k) => JSON.stringify(k, Object.keys(k).sort())).sort();
    expect(norm(asked[0])).toEqual(norm(want));
    // and the shared helper over the same rows is the same rule both sides call
    expect(positionKeys([{ symbol: " reliance ", exchange: "nse", tradingsymbol: "RELIANCE", isOpen: true }])).toEqual([
      { symbol: "RELIANCE", exchange: "NSE", tradingsymbol: "RELIANCE" },
    ]);
  });
});

/* A sanity pin that the gate's inputs in S2 are the gate's, not a copy. */
it("alertsGate itself orders not-pro before every other refusal (S2's not-pro case is not an artefact of setup)", () => {
  const base: AlertGateInput = {
    pro: false,
    telegramEnabled: false,
    telegramAckVersion: 1,
    alertsEnabled: false,
    hasCredentials: false,
    feed: "end-of-day",
    windowFrom: null,
    windowTo: null,
    positions: [],
    now: NOW,
  };
  expect(alertsGate(base)).toEqual({ ok: false, reason: "not-pro", nextInMs: ALERT_SETTINGS_RETRY_MS });
});
