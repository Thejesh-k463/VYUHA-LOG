// PURE (invariant 2): the DURABLE record of a failed Telegram send — the EOD
// digest or, since v4.7.0 C5, a Pro stop/target alert — and the strictly-opt-in
// decision for raising a device notification about one.
//
// v4.7.0 C5 (design D10): the alert runner (components/system/telegram-alert-
// runner.tsx) writes the SAME envelope on a failed alert send — newest failure
// wins — stamped `source: "alert"`, and a confirmed alert send clears ONLY an
// alert record (`shouldClearFailureOnSend`, seam defect D-C5-2). The copy below names "Telegram" rather
// than "digest" where it names the path; the storage keys are UNCHANGED, so an
// envelope written by v4.6 still reads.
//
// ── Why this record exists at all ───────────────────────────────────────────
//
// lib/jobs/telegram-digest.ts deliberately REVERTS its `last_telegram_sent_date`
// claim when a send fails, so the next launch today retries. That is correct —
// and it means the database holds NO trace that a send ever failed. Until v3.7
// the only trace was React state inside <TelegramRunner>, which is mounted on
// the dashboard alone: a refresh cleared it while the per-tab sessionStorage
// latch suppressed the re-fire, and a user who opened the app anywhere else
// never learned at all.
//
// The plan's first choice was a `settings.last_telegram_failure` machine
// column. Migrations are serialised through one agent and that wave is closed,
// so this ships in the storage this wave already owns: a versioned localStorage
// envelope, read through components/layout/use-stored-value.ts. The trade-off
// is honest and worth writing down — the record is per-DEVICE and per-browser
// profile rather than per-database, and clearing site data clears it. Every
// other property the plan asked for holds: it survives a refresh, it is visible
// from any route (the strip is mounted in the root layout, not on a page), and
// the next successful send clears it. A later migration can promote this to the
// settings column without changing the strip.

/** Versioned envelope key (AGENTS.md: `vyuha-` kebab-case, `{v:1,…}`). */
export const TELEGRAM_FAILURE_KEY = "vyuha-telegram-last-failure";

/** Per-DEVICE opt-in for a notification about a failed digest, and the latch
 *  that stops one failure from re-notifying on every launch. Named after the
 *  existing pair in components/risk/breach-banner.tsx, which is the pattern
 *  this follows: nothing is ever requested until the user presses the button. */
export const DIGEST_NOTIFY_OPTIN_KEY = "vyuha-digest-notify";
export const DIGEST_NOTIFY_LAST_KEY = "vyuha-digest-last-notified";

export const TELEGRAM_FAILURE_VERSION = 1;

export interface TelegramFailureRecord {
  /** The trading day the digest was for; null when the job never got that far. */
  date: string | null;
  /** The job's own reason string, verbatim — never a rewritten paraphrase. */
  reason: string;
  /** When this device recorded it (ISO). */
  at: string;
  /** The user closed the strip. The record survives; the strip stays down
   *  until a NEW failure replaces it or a success clears it. */
  dismissed?: boolean;
  /** Which sender recorded it (v4.7.0 C5, seam defect D-C5-2). OPTIONAL and
   *  still v:1: a record WITHOUT it is the pre-C5 shape, which only the digest
   *  ever wrote — read it through `failureSource()`, never `rec.source`. */
  source?: TelegramFailureSource;
}

/** The two senders that share the one failure record. */
export type TelegramFailureSource = "digest" | "alert";

/** A record's sender; an absent `source` is the pre-C5 shape = the digest. */
export function failureSource(rec: TelegramFailureRecord): TelegramFailureSource {
  return rec.source === "alert" ? "alert" : "digest";
}

/**
 * May a CONFIRMED send by `sender` clear the stored record? (D-C5-2.)
 *
 *   • a digest send clears ANY record — as before C5 — because a confirmed
 *     send proves the bot path works, whichever sender failed;
 *   • an alert send clears only an ALERT record. A failed digest is not
 *     retried that day (lib/jobs/telegram-digest.ts reverts its claim for the
 *     next LAUNCH, and the runner fires once per session), so its record is
 *     the only trace — an alert landing at 10:42 must not erase it.
 *
 * A newer failure from either sender still REPLACES the record (newest wins,
 * design D10); this rule is about clearing only.
 */
export function shouldClearFailureOnSend(existing: TelegramFailureRecord | null, sender: TelegramFailureSource): boolean {
  if (!existing) return false;
  return sender === "digest" || failureSource(existing) === "alert";
}

interface Envelope extends TelegramFailureRecord {
  v: number;
}

/** Read the stored record. Garbage, an array, or a version this build does not
 *  know all read as "no record" rather than a half-parsed one. */
export function parseTelegramFailure(raw: string | null | undefined): TelegramFailureRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const e = parsed as Partial<Envelope>;
  if (e.v !== TELEGRAM_FAILURE_VERSION) return null;
  if (typeof e.reason !== "string" || e.reason.trim() === "") return null;
  if (typeof e.at !== "string") return null;
  const date = typeof e.date === "string" ? e.date : null;
  return {
    date,
    reason: e.reason,
    at: e.at,
    ...(e.dismissed === true ? { dismissed: true as const } : {}),
    ...(e.source === "alert" || e.source === "digest" ? { source: e.source } : {}),
  };
}

export function serializeTelegramFailure(rec: TelegramFailureRecord): string {
  return JSON.stringify({ v: TELEGRAM_FAILURE_VERSION, ...rec } satisfies Envelope);
}

/** Identity of a failure, for the "do not notify twice about the same thing"
 *  latch. Date + reason, exactly as breach-banner hashes its breach set. */
export function digestFailureSignature(rec: TelegramFailureRecord | null): string {
  return rec ? `${rec.date ?? "-"}|${rec.reason}` : "";
}

export interface NotifyDecision {
  /** `"Notification" in window` — false in a WebView that does not expose it. */
  supported: boolean;
  /** The per-device opt-in flag is set. */
  optIn: boolean;
  /** `Notification.permission` as the browser reports it. */
  permission: string | null;
  signature: string;
  lastSignature: string | null;
}

/**
 * Should a device notification be raised for this failure right now?
 *
 * Every clause is a refusal the browser will not make for us: no capability, no
 * opt-in, no granted permission, no failure, or the same failure we already
 * announced. Pure so the whole matrix can be tested without a DOM — which is
 * the only review this surface gets, since tests/egress-guard.test.ts scans
 * network constructs and a local notification is not one.
 */
export function shouldRaiseDigestNotification(d: NotifyDecision): boolean {
  if (!d.supported || !d.optIn) return false;
  if (d.permission !== "granted") return false;
  if (!d.signature) return false;
  return d.signature !== d.lastSignature;
}

// ── Copy ────────────────────────────────────────────────────────────────────
// Guarded by tests/telegram-failure-note.test.ts. The reassurance is the
// sentence the v3.6 runner already carried, kept word for word except that it
// no longer says "this screen": the strip now renders on every route, and the
// digest's numbers live on the dashboard.

// v4.7.0 C5: "the digest" → "a Telegram message" — the strip now also records a
// failed stop/target alert, whose levels are on the dashboard's open positions
// and the Live Desk, not in a digest.
export const TELEGRAM_FAILURE_REASSURANCE =
  "Your journal is unaffected — every number and level a Telegram message carries is already on your dashboard.";

export const TELEGRAM_FAILURE_DISMISS_LABEL = "Dismiss";

/** The strip's headline. The job's reason is quoted, not reworded. */
export function telegramFailureHeadline(rec: TelegramFailureRecord): string {
  const when = rec.date ? ` (${rec.date})` : "";
  return `Telegram message not sent${when}: ${rec.reason}`;
}

/**
 * Should a NEW failure overwrite the stored record? Not when it is the SAME
 * failure (date + reason) already on file: the alert runner asks about once a
 * minute, so a blocked Telegram would otherwise rewrite an undismissed record
 * every minute and re-raise a strip the user just dismissed. A different
 * failure always wins (newest failure wins, design D10).
 */
export function shouldRecordFailure(existing: TelegramFailureRecord | null, next: TelegramFailureRecord): boolean {
  return digestFailureSignature(existing) !== digestFailureSignature(next);
}

// ── The alert runner's last answer (v4.7.0 C5, design D11) ──────────────────
//
// The Settings card's ONE alerts status line is keyed on the reason code of the
// last answer of POST /api/telegram/alerts (lib/telegram/alert-gate.ts, plus the
// job's own `feed-error`). The runner — not the card — makes that call, so the
// answer reaches the card through this per-device envelope (AGENTS.md: a
// `vyuha-` key, a `{v:1,…}` envelope, read through use-stored-value.ts). It
// carries a reason CODE only — never a sentence, a symbol or a price.

export const TELEGRAM_ALERT_STATUS_KEY = "vyuha-telegram-alert-status";
export const TELEGRAM_ALERT_STATUS_VERSION = 1;

export interface TelegramAlertStatus {
  /** The refusal code, or null when the last check ran (armed). */
  refused: string | null;
  /** When this device recorded it (ISO). */
  at: string;
  /** OPTIONAL, still v:1 (seam defect D-C5-1, review R4): the door's own
   *  `detail` beside a refusal — today only `feed-reaccept`, carrying
   *  `resolveLiveFeed().blockedReason` (a fixed sentence built from literals:
   *  it names the screen and the cause, never a token, key or host). */
  detail?: string;
}

/** A detail longer than this is not the door's sentence; it is dropped. */
const ALERT_STATUS_DETAIL_MAX = 400;

export function parseTelegramAlertStatus(raw: string | null | undefined): TelegramAlertStatus | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const e = parsed as { v?: unknown; refused?: unknown; at?: unknown; detail?: unknown };
  if (e.v !== TELEGRAM_ALERT_STATUS_VERSION) return null;
  if (typeof e.at !== "string") return null;
  if (e.refused !== null && (typeof e.refused !== "string" || e.refused.trim() === "")) return null;
  const detail = alertStatusDetail(e.detail);
  return { refused: e.refused as string | null, at: e.at, ...(detail ? { detail } : {}) };
}

/** A usable detail sentence, or undefined (absent, blank, not a string, too long). */
export function alertStatusDetail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  return s && s.length <= ALERT_STATUS_DETAIL_MAX ? s : undefined;
}

export function serializeTelegramAlertStatus(s: TelegramAlertStatus): string {
  return JSON.stringify({
    v: TELEGRAM_ALERT_STATUS_VERSION,
    refused: s.refused,
    at: s.at,
    ...(s.detail ? { detail: s.detail } : {}),
  });
}

/**
 * The notification opt-in's label and note.
 *
 * INFERRED, NOT VERIFIED (v3.7, plan §5.3b): the browser `Notification` API is
 * present in the WebView2 runtime the desktop shell embeds, but this has NOT
 * been proven on a built installer from here — that needs a signed build. The
 * copy therefore promises nothing: it says what Vyuha will ASK for, and says
 * plainly that this strip is the record either way. No shipped string may claim
 * an OS notification works until a real build proves it.
 */
export const DIGEST_NOTIFY_COPY = {
  enable: "Also notify this device",
  enabled: "Device notifications: on",
  disable: "Turn device notifications off",
  note: "Vyuha will ask your system for permission. If your system does not show it, this strip stays the record.",
  title: "Vyuha — Telegram message not sent",
} as const;
