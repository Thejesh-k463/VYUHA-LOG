// TELEGRAM STOP/TARGET ALERT GATE (PURE — no DB, no fetch, no React).
//
// v4.7.0 C5 (ruling Q18 + owner answers TG1–TG6; design C5-DESIGN-2026-10-04
// D2/D4, review R4/R8). Decides, from plain inputs the job reads, whether THIS
// moment may check the user's open positions against their recorded stops and
// targets — and if not, WHY, as a stable reason code the Settings card renders
// and the runner schedules from. Every gate is server-side: hiding the toggle
// is never the only thing between a free licence, an unread disclosure or a
// closed market and a message on Telegram.
//
// Refusal order (each blocks alone):
//   1. not-pro               — the licence (`getEntitlement().pro`)
//   2. telegram-off          — the Telegram switch
//   3. ack-stale             — the accepted disclosure is not the current one
//   4. alerts-off            — the alerts toggle (`telegram_alerts_enabled`)
//   5. no-credentials        — bot token readable AND chat id on file
//   6. feed-reaccept         — the user picked a live feed, but its consent no
//                              longer covers its disclosure (R4: never reported
//                              as "end-of-day", which would blame the user's pick)
//   7. end-of-day-feed       — the picked feed is end-of-day / typed marks
//   8. no-checkable-position — no open position has a recorded stop / trailing
//                              stop / target in a market the calendar models
//                              (NSE/BSE cash and F&O; MCX is never verified,
//                              CDS has no session — R8)
//   9. calendar-unverified   — the day is a weekday past the bundled calendar's
//                              `coversThrough`: unverified, so nothing alerts
//  10. market-closed         — no checkable position's OWN market is taking
//                              orders now (TG4: continuous, the closing auction
//                              for a CAS stock, the F&O extension; never
//                              pre-open, never a session with no bundled hours
//                              such as Muhurat) inside the user's optional
//                              window — which narrows, and can never widen.
//
// No time literal lives here: every "is it open" answer is
// lib/domain/market-calendar.ts (tests/market-calendar.test.ts bans the rest).

import { classOf, isOpen, istClock, marketOf, tradingDayStatus, type Market, type SessionClass } from "@/lib/domain/market-calendar";
import { isTelegramAckCurrent } from "@/lib/domain/telegram-disclosure";
import { parseSendTime } from "@/lib/telegram/digest-gate";

export type AlertRefusal =
  | "not-pro"
  | "telegram-off"
  | "ack-stale"
  | "alerts-off"
  | "no-credentials"
  | "feed-reaccept"
  | "end-of-day-feed"
  | "calendar-unverified"
  | "market-closed"
  | "no-checkable-position";

/** The refusals a SETTING decides — the runner re-asks on the slow cadence. */
export const SETTINGS_REFUSALS: ReadonlySet<AlertRefusal> = new Set([
  "not-pro",
  "telegram-off",
  "ack-stale",
  "alerts-off",
  "no-credentials",
  "feed-reaccept",
  "end-of-day-feed",
]);

/** While armed and a market is open: about once a minute (TG1). */
export const ALERT_CHECK_MS = 60_000;
/** Refused for a settings reason: ask again in five minutes (D9). */
export const ALERT_SETTINGS_RETRY_MS = 300_000;
/** The runner's clamp — never wait longer than this between asks (D9). */
export const ALERT_MAX_WAIT_MS = 900_000;
/** The runner's clamp — never ask more often than this (D9). */
export const ALERT_MIN_WAIT_MS = 15_000;

/** The feed the job would read from, as the registry resolves it. */
export type AlertFeedState = "live" | "reaccept" | "end-of-day";

/** The providers that answer a snapshot with a price taken NOW. */
export const LIVE_FEED_IDS: ReadonlySet<string> = new Set(["openalgo", "upstox", "angelone"]);

/**
 * The feed step (R4). `envOverride` is `VYUHA_QUOTE_PROVIDER` — the dev/e2e
 * override set by the operator, where the mock counts as live (D2). Otherwise:
 * the effective provider is live → pass; the user PICKED a live one and its
 * consent closed it → `reaccept`; anything else (end-of-day, typed marks) →
 * `end-of-day`.
 */
export function alertFeedState(feed: { stored: string; effective: string; envOverride?: string | null }): AlertFeedState {
  const env = (feed.envOverride ?? "").trim().toLowerCase();
  if (env) return LIVE_FEED_IDS.has(env) || env === "mock" ? "live" : "end-of-day";
  if (LIVE_FEED_IDS.has(feed.effective)) return "live";
  if (LIVE_FEED_IDS.has(feed.stored)) return "reaccept";
  return "end-of-day";
}

/** One open position, as the gate needs it. */
export interface AlertGatePosition {
  exchange: string | null | undefined;
  segment: string | null | undefined;
  /** The cash symbol — decides closing-auction membership for a stock. */
  symbol: string | null | undefined;
  /** A recorded stop, trailing stop or target (> 0) exists. */
  hasLevel: boolean;
}

export interface AlertGateInput {
  pro: boolean;
  telegramEnabled: boolean;
  telegramAckVersion: number | null | undefined;
  alertsEnabled: boolean;
  hasCredentials: boolean;
  feed: AlertFeedState;
  /** The user's optional window, IST "HH:MM"; both must parse or neither applies. */
  windowFrom: string | null | undefined;
  windowTo: string | null | undefined;
  positions: readonly AlertGatePosition[];
  now: Date;
}

export type AlertGateResult =
  | {
      ok: true;
      /** Index into `positions` → may it alert NOW. */
      alertable: boolean[];
      nextInMs: number;
    }
  | { ok: false; reason: AlertRefusal; nextInMs: number };

/** The user's window in minutes past IST midnight, or null (no extra window). */
export function userWindow(from: string | null | undefined, to: string | null | undefined): { from: number; to: number } | null {
  const f = parseSendTime(from);
  const t = parseSendTime(to);
  if (f == null || t == null || f >= t) return null;
  return { from: f, to: t };
}

/** The calendar market a position trades in, or null when none is checkable (MCX, CDS, unknown). */
export function alertMarketOf(exchange: string | null | undefined, segment: string | null | undefined): Market | null {
  const m = marketOf(exchange, segment);
  // MCX: no holiday list is bundled, so an MCX day is NEVER verified
  // (market-calendar.ts tradingDayStatus) — it can never alert (R8).
  return m === "MCX" ? null : m;
}

type Verdict = "open" | "closed" | "unverified";

function verdictAt(now: Date, market: Market, cls: SessionClass, win: { from: number; to: number } | null): Verdict {
  const { date, minutes } = istClock(now);
  const status = tradingDayStatus(date, market);
  if (!status.trading) return "closed";
  if (!status.verified) return "unverified";
  if (!isOpen(now, market, cls)) return "closed";
  if (win && (minutes < win.from || minutes >= win.to)) return "closed";
  return "open";
}

/**
 * Milliseconds until the first minute (≤ `ALERT_MAX_WAIT_MS` ahead) at which
 * any of these (market, class) pairs alerts; the cap when none does. The runner
 * clamps to the same range, so a longer answer would buy nothing.
 */
export function msUntilNextOpen(
  now: Date,
  pairs: readonly { market: Market; symbol: string | null | undefined }[],
  win: { from: number; to: number } | null,
): number {
  const startOfMinute = Math.floor(now.getTime() / ALERT_CHECK_MS) * ALERT_CHECK_MS;
  for (let at = startOfMinute + ALERT_CHECK_MS; at - now.getTime() <= ALERT_MAX_WAIT_MS; at += ALERT_CHECK_MS) {
    const t = new Date(at);
    const date = istClock(t).date;
    if (pairs.some((p) => verdictAt(t, p.market, classOf(p.market, p.symbol, date), win) === "open")) {
      return at - now.getTime();
    }
  }
  return ALERT_MAX_WAIT_MS;
}

export function alertsGate(input: AlertGateInput): AlertGateResult {
  const no = (reason: AlertRefusal, nextInMs = ALERT_SETTINGS_RETRY_MS): AlertGateResult => ({ ok: false, reason, nextInMs });
  if (!input.pro) return no("not-pro");
  if (!input.telegramEnabled) return no("telegram-off");
  if (!isTelegramAckCurrent(input.telegramAckVersion)) return no("ack-stale");
  if (!input.alertsEnabled) return no("alerts-off");
  if (!input.hasCredentials) return no("no-credentials");
  if (input.feed === "reaccept") return no("feed-reaccept");
  if (input.feed !== "live") return no("end-of-day-feed");

  const { date } = istClock(input.now);
  const win = userWindow(input.windowFrom, input.windowTo);
  const alertable: boolean[] = [];
  let checkable = 0;
  let unverified = 0;
  const pairs: { market: Market; symbol: string | null | undefined }[] = [];
  const seenPair = new Set<string>();
  for (const p of input.positions) {
    const market = p.hasLevel ? alertMarketOf(p.exchange, p.segment) : null;
    if (!market) {
      alertable.push(false);
      continue;
    }
    checkable++;
    const cls = classOf(market, p.symbol, date);
    const v = verdictAt(input.now, market, cls, win);
    if (v === "unverified") unverified++;
    alertable.push(v === "open");
    const pk = `${market}|${cls}`;
    if (!seenPair.has(pk)) {
      seenPair.add(pk);
      pairs.push({ market, symbol: p.symbol });
    }
  }
  if (checkable === 0) return no("no-checkable-position");
  if (alertable.some(Boolean)) return { ok: true, alertable, nextInMs: ALERT_CHECK_MS };
  if (unverified > 0) return no("calendar-unverified", ALERT_MAX_WAIT_MS);
  return no("market-closed", msUntilNextOpen(input.now, pairs, win));
}
