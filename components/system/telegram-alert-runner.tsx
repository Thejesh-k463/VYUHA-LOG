"use client";

// v4.7.0 C5 — the client half of the Telegram stop/target alerts (ruling Q18,
// owner answers TG1/TG2; design C5-DESIGN-2026-10-04 D9/D10 as amended by
// review R3/R10). Renders nothing. Mounted ONCE in the root layout, and only
// when the layout's settings read says `telegramEnabled && telegramAlertsEnabled`
// — a cheap prop; every real gate (Pro, the disclosure, the feed, the calendar)
// is the server's (lib/telegram/alert-gate.ts via POST /api/telegram/alerts).
//
// What it does, and what it deliberately does not:
//   • POSTs the door, then schedules the next POST from the answer's
//     `nextInMs`, clamped to [ALERT_MIN_WAIT_MS, ALERT_MAX_WAIT_MS] — A1's
//     constants, never a second copy;
//   • on /live, while the server's last answer was ARMED (a check ran), the
//     floor is used instead — the desk already polls the feed every 1–5 s, so
//     this adds no new kind of request (design D9);
//   • it does NOT pause on `visibilitychange` (TG2: minimised is when a push
//     matters) and keeps no sessionStorage latch (every tab runs; the server's
//     receipts dedupe, design D6) — one runner per tab, because the layout
//     mounts it once;
//   • a failed SEND writes the durable failure envelope (lib/domain/telegram-
//     failure.ts, `source: "alert"`) and a confirmed send clears it — but only
//     an ALERT record, never the digest's (D-C5-2); a `feed-error` refusal
//     writes NO envelope (R3: that strip is for send failures);
//   • a network error is swallowed — no console line, because the console
//     audit visits every page this is mounted on — and retried at the next tick.
//
// The scheduling lives in `startAlertRunner()` (plain functions, no React) so
// the clamp, the /live floor and the envelope writes are unit-tested with fake
// timers (tests/telegram-alert-runner.test.ts); the component only wires it to
// the pathname and to its own lifetime.

import * as React from "react";
import { usePathname } from "next/navigation";
import { writeStored } from "@/components/layout/use-stored-value";
import {
  TELEGRAM_ALERT_STATUS_KEY,
  TELEGRAM_FAILURE_KEY,
  alertStatusDetail,
  parseTelegramAlertStatus,
  parseTelegramFailure,
  serializeTelegramAlertStatus,
  serializeTelegramFailure,
  shouldClearFailureOnSend,
  shouldRecordFailure,
} from "@/lib/domain/telegram-failure";
import { todayIstIso } from "@/lib/domain/trading-day";
import { ALERT_CHECK_MS, ALERT_MAX_WAIT_MS, ALERT_MIN_WAIT_MS } from "@/lib/telegram/alert-gate";

/** What the runner keeps from one answer. */
export interface AlertAnswer {
  nextInMs: number;
  /** The server ran a check (no refusal) — the /live floor applies. */
  armed: boolean;
}

/**
 * The wait before the next POST, in ms. The server's hint, the /live floor
 * while armed, then the clamp — so no answer (a 0, a NaN, a day) can make the
 * runner hammer the door or go quiet for longer than the cap.
 */
export function nextAlertDelay(a: { nextInMs: number; armed: boolean; onLive: boolean }): number {
  let ms = Number.isFinite(a.nextInMs) && a.nextInMs > 0 ? a.nextInMs : ALERT_CHECK_MS;
  if (a.armed && a.onLive) ms = Math.min(ms, ALERT_MIN_WAIT_MS);
  return Math.min(ALERT_MAX_WAIT_MS, Math.max(ALERT_MIN_WAIT_MS, ms));
}

/** Read localStorage without throwing (a locked-down profile can refuse it). */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    writeStored(key, value);
  } catch {
    /* storage refused — the next answer tries again */
  }
}

/**
 * Apply one answer of the door: the failure envelope, the card's status
 * envelope, and what to schedule from. Null when the body is not the door's
 * own 200 shape (treated exactly like a network error).
 */
export function applyAlertAnswer(body: unknown, now: Date = new Date()): AlertAnswer | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const d = body as {
    ok?: unknown;
    refused?: unknown;
    nextInMs?: unknown;
    sent?: unknown;
    summarySent?: unknown;
    failed?: unknown;
    detail?: unknown;
  };
  if (d.ok !== true) return null;
  const refused = typeof d.refused === "string" && d.refused ? d.refused : null;
  // The door's own sentence beside a refusal (feed-reaccept carries the
  // registry's blockedReason — D-C5-1); kept only with a refusal.
  const detail = refused ? alertStatusDetail(d.detail) : undefined;

  // The card's status line reads this; written only when the code or its
  // detail changes.
  const prev = parseTelegramAlertStatus(readStored(TELEGRAM_ALERT_STATUS_KEY));
  if (!prev || prev.refused !== refused || prev.detail !== detail) {
    store(
      TELEGRAM_ALERT_STATUS_KEY,
      serializeTelegramAlertStatus({ refused, at: now.toISOString(), ...(detail ? { detail } : {}) }),
    );
  }

  if (refused === null) {
    const f = d.failed as { reason?: unknown } | null | undefined;
    const reason = f && typeof f === "object" && typeof f.reason === "string" && f.reason.trim() ? f.reason : null;
    if (reason) {
      // `reason` is sendTelegram's own hand-built sentence — never a token,
      // never a caught message (the job guarantees it; design D10).
      const rec = { date: todayIstIso(now), reason, at: now.toISOString(), source: "alert" as const };
      if (shouldRecordFailure(parseTelegramFailure(readStored(TELEGRAM_FAILURE_KEY)), rec)) {
        store(TELEGRAM_FAILURE_KEY, serializeTelegramFailure(rec));
      }
    } else if ((typeof d.sent === "number" && d.sent > 0) || d.summarySent === true) {
      // A confirmed ALERT send clears only an ALERT record: a digest failure
      // is not retried that day, so its record is the only trace (D-C5-2).
      if (shouldClearFailureOnSend(parseTelegramFailure(readStored(TELEGRAM_FAILURE_KEY)), "alert")) {
        store(TELEGRAM_FAILURE_KEY, null);
      }
    }
  }
  // `feed-error` and every other refusal: no failure envelope (R3).
  const nextInMs = typeof d.nextInMs === "number" ? d.nextInMs : Number.NaN;
  return { nextInMs, armed: refused === null };
}

/** The default POST: same-origin, an empty JSON object (the door reads nothing). */
async function postDoor(signal: AbortSignal): Promise<unknown> {
  // A LITERAL url: tests/egress-guard.test.ts reads every fetch's first argument.
  const res = await fetch("/api/telegram/alerts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal,
  });
  if (!res.ok) return null;
  return res.json();
}

export interface AlertRunnerDeps {
  /** Is the tab on /live right now (read at every scheduling decision). */
  isOnLive: () => boolean;
  /** Test seam — production uses `fetch` on the door. */
  post?: (signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
}

export interface AlertRunnerHandle {
  /** Re-plan the pending wait (the pathname changed). Never POSTs early past the floor. */
  replan: () => void;
  /** Clear the timer and abort a POST in flight. Idempotent. */
  stop: () => void;
}

/**
 * Start the loop: one POST now, then one per scheduled wait, until `stop()`.
 * At most one POST is in flight; a POST that resolves after `stop()` schedules
 * nothing.
 */
export function startAlertRunner(deps: AlertRunnerDeps): AlertRunnerHandle {
  const post = deps.post ?? postDoor;
  const now = deps.now ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ctrl: AbortController | null = null;
  let stopped = false;
  let inFlight = false;
  let lastPostAt = now();
  let last: AlertAnswer = { nextInMs: ALERT_CHECK_MS, armed: false };

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const schedule = () => {
    clear();
    if (stopped || inFlight) return;
    const wait = nextAlertDelay({ ...last, onLive: deps.isOnLive() });
    const due = Math.max(0, wait - (now() - lastPostAt));
    timer = setTimeout(() => void tick(), due);
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    timer = null;
    inFlight = true;
    lastPostAt = now();
    ctrl = new AbortController();
    try {
      const answer = applyAlertAnswer(await post(ctrl.signal));
      // A malformed body keeps the last cadence but re-asks at the normal pace.
      last = answer ?? { nextInMs: ALERT_CHECK_MS, armed: last.armed };
    } catch {
      // Offline, aborted, or a body that is not JSON: silent, retried next tick.
      last = { nextInMs: ALERT_CHECK_MS, armed: last.armed };
    } finally {
      inFlight = false;
      ctrl = null;
    }
    schedule();
  };

  void tick();

  return {
    replan: () => {
      if (!stopped && !inFlight) schedule();
    },
    stop: () => {
      stopped = true;
      clear();
      ctrl?.abort();
      ctrl = null;
    },
  };
}

export function TelegramAlertRunner() {
  const pathname = usePathname();
  const onLive = pathname === "/live" || (pathname ?? "").startsWith("/live/");
  // Read by the loop at each scheduling decision. Written in an effect (never
  // during render) and never mirrored into state — nothing here re-renders.
  const onLiveRef = React.useRef(onLive);
  const handleRef = React.useRef<AlertRunnerHandle | null>(null);

  React.useEffect(() => {
    const handle = startAlertRunner({ isOnLive: () => onLiveRef.current });
    handleRef.current = handle;
    return () => {
      handle.stop();
      handleRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    onLiveRef.current = onLive;
    handleRef.current?.replan();
  }, [onLive]);

  return null;
}
