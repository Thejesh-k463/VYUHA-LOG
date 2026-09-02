// PURE (invariant 2): the DURABLE record of a failed Telegram EOD digest, and
// the strictly-opt-in decision for raising a device notification about one.
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
  return { date, reason: e.reason, at: e.at, ...(e.dismissed === true ? { dismissed: true as const } : {}) };
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

export const TELEGRAM_FAILURE_REASSURANCE =
  "Your journal is unaffected — everything in the digest is already on your dashboard.";

export const TELEGRAM_FAILURE_DISMISS_LABEL = "Dismiss";

/** The strip's headline. The job's reason is quoted, not reworded. */
export function telegramFailureHeadline(rec: TelegramFailureRecord): string {
  const when = rec.date ? ` (${rec.date})` : "";
  return `Telegram digest not sent${when}: ${rec.reason}`;
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
  title: "Vyuha — Telegram digest not sent",
} as const;
