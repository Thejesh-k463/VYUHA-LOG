import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ALERT_CHECK_MS, ALERT_MAX_WAIT_MS, ALERT_MIN_WAIT_MS } from "@/lib/telegram/alert-gate";
import {
  DIGEST_NOTIFY_COPY,
  TELEGRAM_ALERT_STATUS_KEY,
  TELEGRAM_FAILURE_KEY,
  TELEGRAM_FAILURE_REASSURANCE,
  telegramFailureHeadline,
  parseTelegramAlertStatus,
  parseTelegramFailure,
  serializeTelegramFailure,
} from "@/lib/domain/telegram-failure";
import { applyAlertAnswer, nextAlertDelay, startAlertRunner } from "@/components/system/telegram-alert-runner";

/**
 * v4.7.0 C5 — the Telegram stop/target alert RUNNER (design D9/D10, review
 * R3/R10), driven without a DOM: the scheduling is plain functions
 * (`startAlertRunner`), so fake timers can walk it minute by minute. The
 * component is a thin wrapper, pinned by the source guards at the foot.
 *
 * What is under guard, each proven red by reverting its line:
 *   • the clamp to A1's [ALERT_MIN_WAIT_MS, ALERT_MAX_WAIT_MS];
 *   • the /live floor, only while the server says ARMED;
 *   • a failed send writes the durable failure envelope; a confirmed send
 *     clears it; `feed-error` writes none (R3);
 *   • a network error is swallowed and retried at the next tick;
 *   • stop() (the unmount) clears the timer — no POST after it.
 */

/** A Map-backed localStorage — the suite runs in node. */
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

const g = globalThis as unknown as { localStorage?: MemoryStorage };
let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  g.localStorage = store;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T05:00:00.000Z")); // a Monday, 10:30 IST
});

afterEach(() => {
  vi.useRealTimers();
  delete g.localStorage;
});

const armed = (over: Record<string, unknown> = {}) => ({
  ok: true,
  refused: null,
  sent: 0,
  failed: null,
  summarySent: false,
  checked: 3,
  nextInMs: ALERT_CHECK_MS,
  ...over,
});
const refused = (reason: string, nextInMs: number) => ({ ok: true, refused: reason, nextInMs });

/** Let the POST promise and its `.then` chain settle under fake timers. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("nextAlertDelay — the clamp and the /live floor", () => {
  it("clamps to A1's range in both directions", () => {
    expect(nextAlertDelay({ nextInMs: 1, armed: false, onLive: false })).toBe(ALERT_MIN_WAIT_MS);
    expect(nextAlertDelay({ nextInMs: 86_400_000, armed: false, onLive: false })).toBe(ALERT_MAX_WAIT_MS);
    expect(nextAlertDelay({ nextInMs: ALERT_CHECK_MS, armed: true, onLive: false })).toBe(ALERT_CHECK_MS);
  });

  it("a nonsense hint (0, negative, NaN) is the normal minute, never a hammer", () => {
    for (const n of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(nextAlertDelay({ nextInMs: n, armed: false, onLive: false }), String(n)).toBe(ALERT_CHECK_MS);
    }
  });

  it("on /live, ARMED → the floor; refused → the server's own cadence", () => {
    expect(nextAlertDelay({ nextInMs: ALERT_CHECK_MS, armed: true, onLive: true })).toBe(ALERT_MIN_WAIT_MS);
    expect(nextAlertDelay({ nextInMs: 300_000, armed: false, onLive: true })).toBe(300_000);
  });
});

describe("startAlertRunner — the loop under fake timers", () => {
  it("POSTs at once, then on the server's clamped cadence", async () => {
    const post = vi.fn().mockResolvedValue(refused("market-closed", 4 * 3_600_000));
    const h = startAlertRunner({ isOnLive: () => false, post });
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
    // A four-hour hint is clamped to the cap.
    await vi.advanceTimersByTimeAsync(ALERT_MAX_WAIT_MS - 1);
    expect(post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(post).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("a tiny hint is held to the floor", async () => {
    const post = vi.fn().mockResolvedValue(refused("feed-error", 10));
    const h = startAlertRunner({ isOnLive: () => false, post });
    await flush();
    await vi.advanceTimersByTimeAsync(ALERT_MIN_WAIT_MS - 1);
    expect(post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(post).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("on /live while armed, the next POST comes at the floor, not the minute", async () => {
    const post = vi.fn().mockResolvedValue(armed());
    const h = startAlertRunner({ isOnLive: () => true, post });
    await flush();
    await vi.advanceTimersByTimeAsync(ALERT_MIN_WAIT_MS);
    expect(post).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("off /live, armed, the minute holds", async () => {
    const post = vi.fn().mockResolvedValue(armed());
    const h = startAlertRunner({ isOnLive: () => false, post });
    await flush();
    await vi.advanceTimersByTimeAsync(ALERT_MIN_WAIT_MS);
    expect(post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ALERT_CHECK_MS - ALERT_MIN_WAIT_MS);
    expect(post).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("navigating ONTO /live re-plans the pending wait down to the floor", async () => {
    let onLive = false;
    const post = vi.fn().mockResolvedValue(armed());
    const h = startAlertRunner({ isOnLive: () => onLive, post });
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    onLive = true;
    h.replan();
    await vi.advanceTimersByTimeAsync(ALERT_MIN_WAIT_MS - 5_000);
    expect(post).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("does NOT pause while the document is hidden (TG2) — there is no visibility input at all", async () => {
    const post = vi.fn().mockResolvedValue(armed());
    const h = startAlertRunner({ isOnLive: () => false, post });
    await flush();
    await vi.advanceTimersByTimeAsync(ALERT_CHECK_MS * 3);
    expect(post).toHaveBeenCalledTimes(4);
    h.stop();
  });

  it("a network error is swallowed and retried at the next tick", async () => {
    const post = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(armed());
    const h = startAlertRunner({ isOnLive: () => false, post });
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ALERT_CHECK_MS);
    expect(post).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("stop() — the unmount — clears the timer: no POST after it, ever", async () => {
    const post = vi.fn().mockResolvedValue(armed());
    const h = startAlertRunner({ isOnLive: () => false, post });
    await flush();
    h.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(ALERT_MAX_WAIT_MS * 2);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a POST that resolves after stop() schedules nothing", async () => {
    let resolve!: (v: unknown) => void;
    const post = vi.fn().mockImplementation(() => new Promise((r) => (resolve = r)));
    const h = startAlertRunner({ isOnLive: () => false, post });
    h.stop();
    resolve(armed());
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("applyAlertAnswer — the envelopes (design D10, review R3)", () => {
  it("a failed SEND writes the durable failure envelope, the reason verbatim", () => {
    applyAlertAnswer(armed({ failed: { reason: "Telegram returned 403 (forbidden)." } }));
    const rec = parseTelegramFailure(store.getItem(TELEGRAM_FAILURE_KEY));
    expect(rec?.reason).toBe("Telegram returned 403 (forbidden).");
    expect(rec?.date).toBe("2026-10-05");
    expect(rec?.dismissed).toBeUndefined();
  });

  it("the SAME failure every minute does not re-raise a dismissed strip", () => {
    const reason = "Telegram returned 403 (forbidden).";
    store.setItem(
      TELEGRAM_FAILURE_KEY,
      serializeTelegramFailure({ date: "2026-10-05", reason, at: "2026-10-05T04:00:00.000Z", dismissed: true }),
    );
    applyAlertAnswer(armed({ failed: { reason } }));
    expect(parseTelegramFailure(store.getItem(TELEGRAM_FAILURE_KEY))?.dismissed).toBe(true);
    // …but a DIFFERENT failure wins.
    applyAlertAnswer(armed({ failed: { reason: "Telegram could not be reached." } }));
    const rec = parseTelegramFailure(store.getItem(TELEGRAM_FAILURE_KEY));
    expect(rec?.reason).toBe("Telegram could not be reached.");
    expect(rec?.dismissed).toBeUndefined();
  });

  it("a confirmed send (sent > 0, no failure) clears an ALERT record", () => {
    store.setItem(
      TELEGRAM_FAILURE_KEY,
      serializeTelegramFailure({ date: "2026-10-04", reason: "x", at: "2026-10-04T10:00:00Z", source: "alert" }),
    );
    applyAlertAnswer(armed({ sent: 1 }));
    expect(store.getItem(TELEGRAM_FAILURE_KEY)).toBeNull();
  });

  it("a confirmed send leaves a DIGEST record — stamped or the pre-C5 shape without `source` (D-C5-2)", () => {
    for (const rec of [
      { date: "2026-10-04", reason: "x", at: "2026-10-04T10:00:00Z", source: "digest" as const },
      { date: "2026-10-04", reason: "x", at: "2026-10-04T10:00:00Z" },
    ]) {
      const raw = serializeTelegramFailure(rec);
      store.setItem(TELEGRAM_FAILURE_KEY, raw);
      applyAlertAnswer(armed({ sent: 1 }));
      applyAlertAnswer(armed({ sent: 0, summarySent: true }));
      expect(store.getItem(TELEGRAM_FAILURE_KEY)).toBe(raw);
    }
  });

  it("the failure it writes is stamped source 'alert'", () => {
    applyAlertAnswer(armed({ failed: { reason: "Telegram could not be reached." } }));
    expect(parseTelegramFailure(store.getItem(TELEGRAM_FAILURE_KEY))?.source).toBe("alert");
  });

  it("keeps the door's detail beside a refusal, rewrites the envelope when only the detail changes, and drops it when armed (D-C5-1)", () => {
    const a = "The OpenAlgo integration is off. Turn it on in Settings → Integrations after reading what it does.";
    const b = "The OpenAlgo disclosure has changed since you accepted it. Open Settings → Integrations and read it again to continue.";
    applyAlertAnswer({ ...refused("feed-reaccept", 300_000), detail: a });
    expect(parseTelegramAlertStatus(store.getItem(TELEGRAM_ALERT_STATUS_KEY))).toMatchObject({ refused: "feed-reaccept", detail: a });
    applyAlertAnswer({ ...refused("feed-reaccept", 300_000), detail: b });
    expect(parseTelegramAlertStatus(store.getItem(TELEGRAM_ALERT_STATUS_KEY))?.detail).toBe(b);
    applyAlertAnswer({ ...armed(), detail: a });
    expect(parseTelegramAlertStatus(store.getItem(TELEGRAM_ALERT_STATUS_KEY))?.detail).toBeUndefined();
  });

  it("a check that sent nothing leaves a recorded failure alone", () => {
    store.setItem(TELEGRAM_FAILURE_KEY, serializeTelegramFailure({ date: "2026-10-04", reason: "x", at: "2026-10-04T10:00:00Z" }));
    applyAlertAnswer(armed({ sent: 0 }));
    expect(store.getItem(TELEGRAM_FAILURE_KEY)).not.toBeNull();
  });

  it("feed-error writes NO failure envelope — that strip is for send failures (R3)", () => {
    const a = applyAlertAnswer(refused("feed-error", ALERT_CHECK_MS));
    expect(store.getItem(TELEGRAM_FAILURE_KEY)).toBeNull();
    expect(a).toEqual({ nextInMs: ALERT_CHECK_MS, armed: false });
  });

  it("records the reason CODE for the card, only when it changes", () => {
    applyAlertAnswer(refused("end-of-day-feed", 300_000));
    const first = store.getItem(TELEGRAM_ALERT_STATUS_KEY);
    expect(parseTelegramAlertStatus(first)?.refused).toBe("end-of-day-feed");
    vi.setSystemTime(new Date("2026-10-05T05:05:00.000Z"));
    applyAlertAnswer(refused("end-of-day-feed", 300_000));
    expect(store.getItem(TELEGRAM_ALERT_STATUS_KEY)).toBe(first);
    applyAlertAnswer(armed());
    expect(parseTelegramAlertStatus(store.getItem(TELEGRAM_ALERT_STATUS_KEY))?.refused).toBeNull();
  });

  it("the strip's copy names the Telegram PATH, not the digest alone — keys unchanged (D10)", () => {
    const rec = { date: "2026-10-05", reason: "Telegram returned 403 (forbidden).", at: "2026-10-05T05:00:00.000Z" };
    expect(telegramFailureHeadline(rec)).toBe("Telegram message not sent (2026-10-05): Telegram returned 403 (forbidden).");
    expect(DIGEST_NOTIFY_COPY.title).toBe("Vyuha — Telegram message not sent");
    expect(TELEGRAM_FAILURE_REASSURANCE).not.toMatch(/digest/i);
    expect(TELEGRAM_FAILURE_KEY).toBe("vyuha-telegram-last-failure");
  });

  it("anything that is not the door's own 200 shape is treated as a network error", () => {
    expect(applyAlertAnswer(null)).toBeNull();
    expect(applyAlertAnswer({ ok: false, message: "Bad request." })).toBeNull();
    expect(applyAlertAnswer([])).toBeNull();
    expect(store.getItem(TELEGRAM_ALERT_STATUS_KEY)).toBeNull();
  });
});

describe("telegram-alert-runner.tsx — the component wiring", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "components/system/telegram-alert-runner.tsx"), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");

  it("returns the loop's stop() from its mount effect — the unmount clears the timer", () => {
    expect(code).toMatch(/const handle = startAlertRunner\(/);
    expect(code).toMatch(/return \(\) => \{\s*handle\.stop\(\);/);
  });

  it("never pauses on visibility, keeps no sessionStorage latch, logs nothing", () => {
    expect(code).not.toMatch(/visibilitychange|document\.hidden|visibilityState/);
    expect(code).not.toMatch(/sessionStorage/);
    expect(code).not.toMatch(/console\./);
  });

  it("POSTs only the one door, with a literal URL (the egress guard reads it)", () => {
    expect(code.match(/fetch\(/g)?.length).toBe(1);
    expect(code).toContain('fetch("/api/telegram/alerts"');
  });

  it("renders nothing", () => {
    expect(code).toMatch(/export function TelegramAlertRunner\(\)[\s\S]*return null;\s*\}\s*$/);
  });
});
