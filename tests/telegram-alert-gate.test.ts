import { describe, expect, it } from "vitest";
import {
  ALERT_CHECK_MS,
  ALERT_MAX_WAIT_MS,
  ALERT_SETTINGS_RETRY_MS,
  alertFeedState,
  alertsGate,
  msUntilNextOpen,
  SETTINGS_REFUSALS,
  userWindow,
  type AlertGateInput,
  type AlertGatePosition,
} from "@/lib/telegram/alert-gate";
import { telegramAlertsCardView } from "@/lib/telegram/card-state";
import { TELEGRAM_DISCLOSURE } from "@/lib/domain/telegram-disclosure";
import { istWallClockIso } from "@/lib/domain/trading-day";

/**
 * The PURE alert gate (v4.7.0 C5, design D2/D4, review R4/R8). Every refusal
 * in order, the feed reason codes, and the per-position calendar window against
 * the REAL bundled calendar (lib/data/market-calendar.json) — never a typed
 * time inside lib/. Dates are from 2026-09-24 on, when the bundled closing-
 * auction member list is in force (ABB is a member; ZZNEUTRAL is not).
 */

const at = (date: string, hhmm: string) => new Date(istWallClockIso(date, hhmm));
const WED = "2026-10-07"; // an ordinary verified Wednesday

const CASH: AlertGatePosition = { exchange: "NSE", segment: "eq_delivery", symbol: "ZZNEUTRAL", hasLevel: true };
const CAS_STOCK: AlertGatePosition = { exchange: "NSE", segment: "eq_delivery", symbol: "ABB", hasLevel: true };
const FNO: AlertGatePosition = { exchange: "NFO", segment: "index_option", symbol: "NIFTY", hasLevel: true };
const MCX: AlertGatePosition = { exchange: "MCX", segment: "commodity_future", symbol: "GOLD", hasLevel: true };
const CDS: AlertGatePosition = { exchange: "CDS", segment: "future", symbol: "USDINR", hasLevel: true };

function input(over: Partial<AlertGateInput> = {}): AlertGateInput {
  return {
    pro: true,
    telegramEnabled: true,
    telegramAckVersion: TELEGRAM_DISCLOSURE.version,
    alertsEnabled: true,
    hasCredentials: true,
    feed: "live",
    windowFrom: null,
    windowTo: null,
    positions: [CASH],
    now: at(WED, "10:42"),
    ...over,
  };
}

const reasonOf = (i: AlertGateInput) => {
  const r = alertsGate(i);
  return r.ok ? "ok" : r.reason;
};

describe("the refusal order — each gate blocks alone, in the documented order", () => {
  it("passes when every precondition holds, and asks again in a minute", () => {
    const r = alertsGate(input());
    expect(r.ok).toBe(true);
    expect(r.nextInMs).toBe(ALERT_CHECK_MS);
  });

  it("refuses in order: not-pro → telegram-off → ack-stale → alerts-off → no-credentials → feed", () => {
    const all = input({
      pro: false,
      telegramEnabled: false,
      telegramAckVersion: TELEGRAM_DISCLOSURE.version - 1,
      alertsEnabled: false,
      hasCredentials: false,
      feed: "end-of-day",
    });
    expect(reasonOf(all)).toBe("not-pro");
    expect(reasonOf({ ...all, pro: true })).toBe("telegram-off");
    expect(reasonOf({ ...all, pro: true, telegramEnabled: true })).toBe("ack-stale");
    expect(
      reasonOf({ ...all, pro: true, telegramEnabled: true, telegramAckVersion: TELEGRAM_DISCLOSURE.version }),
    ).toBe("alerts-off");
    expect(
      reasonOf({ ...all, pro: true, telegramEnabled: true, telegramAckVersion: TELEGRAM_DISCLOSURE.version, alertsEnabled: true }),
    ).toBe("no-credentials");
    expect(
      reasonOf({
        ...all,
        pro: true,
        telegramEnabled: true,
        telegramAckVersion: TELEGRAM_DISCLOSURE.version,
        alertsEnabled: true,
        hasCredentials: true,
      }),
    ).toBe("end-of-day-feed");
  });

  it("an ack for the PREVIOUS disclosure, or none, is stale (strict equality, read from the constant)", () => {
    expect(reasonOf(input({ telegramAckVersion: TELEGRAM_DISCLOSURE.version - 1 }))).toBe("ack-stale");
    expect(reasonOf(input({ telegramAckVersion: null }))).toBe("ack-stale");
  });

  it("every settings refusal re-asks on the slow cadence", () => {
    expect(alertsGate(input({ pro: false })).nextInMs).toBe(ALERT_SETTINGS_RETRY_MS);
    expect(SETTINGS_REFUSALS.has("feed-reaccept")).toBe(true);
    expect(SETTINGS_REFUSALS.has("market-closed")).toBe(false);
  });
});

describe("the feed step (R4) — a closed consent is never called 'end-of-day'", () => {
  it("effective live → live; picked live but consent closed → reaccept; eod / manual → end-of-day", () => {
    expect(alertFeedState({ stored: "angelone", effective: "angelone" })).toBe("live");
    expect(alertFeedState({ stored: "openalgo", effective: "openalgo" })).toBe("live");
    expect(alertFeedState({ stored: "upstox", effective: "eod" })).toBe("reaccept");
    expect(alertFeedState({ stored: "eod", effective: "eod" })).toBe("end-of-day");
    expect(alertFeedState({ stored: "manual", effective: "manual" })).toBe("end-of-day");
  });

  it("the operator's VYUHA_QUOTE_PROVIDER mock counts as live; a stored mock pick does not", () => {
    expect(alertFeedState({ stored: "eod", effective: "eod", envOverride: "mock" })).toBe("live");
    expect(alertFeedState({ stored: "mock", effective: "mock" })).toBe("end-of-day");
    expect(alertFeedState({ stored: "openalgo", effective: "openalgo", envOverride: "eod" })).toBe("end-of-day");
  });

  it("the gate maps them to their own reason codes", () => {
    expect(reasonOf(input({ feed: "reaccept" }))).toBe("feed-reaccept");
    expect(reasonOf(input({ feed: "end-of-day" }))).toBe("end-of-day-feed");
  });
});

describe("the per-position calendar window (TG4, D4, R8)", () => {
  it("pre-open is NOT open: indicative prices never alert", () => {
    expect(reasonOf(input({ now: at(WED, "09:05") }))).toBe("market-closed");
    expect(reasonOf(input({ now: at(WED, "09:15") }))).toBe("ok");
  });

  it("a market-closed answer points at the next open minute", () => {
    const r = alertsGate(input({ now: at(WED, "09:05") }));
    expect(r.ok).toBe(false);
    expect(r.nextInMs).toBe(10 * 60_000);
    // Overnight: capped — the runner clamps to the same ceiling anyway.
    expect(alertsGate(input({ now: at(WED, "20:00") })).nextInMs).toBe(ALERT_MAX_WAIT_MS);
  });

  it("after the cash close a plain stock stops while F&O continues through its extension", () => {
    const r = alertsGate(input({ positions: [CASH, FNO], now: at(WED, "15:33") }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.alertable).toEqual([false, true]);
    expect(reasonOf(input({ positions: [CASH], now: at(WED, "15:33") }))).toBe("market-closed");
    expect(reasonOf(input({ positions: [FNO], now: at(WED, "15:41") }))).toBe("market-closed");
  });

  it("a closing-auction stock stays checkable through its auction", () => {
    const r = alertsGate(input({ positions: [CASH, CAS_STOCK], now: at(WED, "15:32") }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.alertable).toEqual([false, true]);
  });

  it("a weekend and a listed holiday are closed", () => {
    expect(reasonOf(input({ now: at("2026-10-10", "11:00") }))).toBe("market-closed");
    expect(reasonOf(input({ now: at("2026-10-02", "11:00") }))).toBe("market-closed");
  });

  it("Budget Sunday (a special session with normal timings) alerts; Muhurat (no bundled hours) never does", () => {
    expect(reasonOf(input({ now: at("2026-02-01", "11:00") }))).toBe("ok");
    expect(reasonOf(input({ positions: [CASH, FNO], now: at("2026-11-08", "18:30") }))).toBe("market-closed");
  });

  it("past coversThrough every weekday is unverified — nothing alerts, and the reason says why", () => {
    const r = alertsGate(input({ positions: [CASH, FNO], now: at("2027-01-06", "11:00") }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("calendar-unverified");
  });

  it("MCX and CDS are never checkable, nor is a position with no recorded level", () => {
    expect(reasonOf(input({ positions: [MCX] }))).toBe("no-checkable-position");
    expect(reasonOf(input({ positions: [CDS] }))).toBe("no-checkable-position");
    expect(reasonOf(input({ positions: [{ ...CASH, hasLevel: false }] }))).toBe("no-checkable-position");
    expect(reasonOf(input({ positions: [] }))).toBe("no-checkable-position");
    const r = alertsGate(input({ positions: [MCX, CASH] }));
    expect(r.ok && r.alertable).toEqual([false, true]);
  });

  it("the user's window NARROWS the market's hours and can never widen them", () => {
    const win = { windowFrom: "10:00", windowTo: "11:00" };
    expect(reasonOf(input({ ...win, now: at(WED, "10:30") }))).toBe("ok");
    expect(reasonOf(input({ ...win, now: at(WED, "11:30") }))).toBe("market-closed");
    expect(reasonOf(input({ ...win, now: at(WED, "09:30") }))).toBe("market-closed");
    // A window reaching past the close does not keep the stock alerting.
    expect(reasonOf(input({ windowFrom: "09:00", windowTo: "18:00", now: at(WED, "16:00") }))).toBe("market-closed");
    expect(reasonOf(input({ windowFrom: "08:00", windowTo: "18:00", now: at(WED, "09:05") }))).toBe("market-closed");
  });

  it("a half-set or inverted window is no window at all", () => {
    expect(userWindow("10:00", null)).toBeNull();
    expect(userWindow("11:00", "10:00")).toBeNull();
    expect(userWindow("10:00", "11:00")).toEqual({ from: 600, to: 660 });
  });

  it("msUntilNextOpen walks minutes and stops at the cap", () => {
    expect(msUntilNextOpen(at(WED, "09:14"), [{ market: "NSE_CM", symbol: "ZZNEUTRAL" }], null)).toBe(60_000);
    expect(msUntilNextOpen(at(WED, "16:00"), [{ market: "NSE_CM", symbol: "ZZNEUTRAL" }], null)).toBe(ALERT_MAX_WAIT_MS);
  });
});

describe("the Settings card's alerts-section inputs (view only)", () => {
  const base = {
    enabled: true,
    ackVersion: TELEGRAM_DISCLOSURE.version,
    connected: true,
    pro: true,
    alertsEnabled: true,
    windowFrom: null,
    windowTo: null,
  };

  it("shows the section exactly where the digest's status block shows", () => {
    expect(telegramAlertsCardView(base).showAlertsSection).toBe(true);
    expect(telegramAlertsCardView({ ...base, connected: false }).showAlertsSection).toBe(false);
    expect(telegramAlertsCardView({ ...base, ackVersion: TELEGRAM_DISCLOSURE.version - 1 }).showAlertsSection).toBe(false);
  });

  it("not Pro locks the toggle and is the status, whatever the last refusal said", () => {
    const v = telegramAlertsCardView({ ...base, pro: false, lastRefusal: "market-closed" });
    expect(v).toMatchObject({ proLocked: true, canEnable: false, status: "not-pro" });
  });

  it("the status is the job's reason code while armed, and nothing while off", () => {
    expect(telegramAlertsCardView({ ...base, lastRefusal: "end-of-day-feed" }).status).toBe("end-of-day-feed");
    expect(telegramAlertsCardView({ ...base, alertsEnabled: false, lastRefusal: "end-of-day-feed" }).status).toBeNull();
    expect(telegramAlertsCardView({ ...base, windowFrom: "10:00", windowTo: "11:00" }).window).toEqual({ from: "10:00", to: "11:00" });
  });
});
