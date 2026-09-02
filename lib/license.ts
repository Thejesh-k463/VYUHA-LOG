// Offline license verification (monetization §4). NO server call — an Ed25519
// signature over the payload is checked against the vendor PUBLIC key baked in
// below. The PRIVATE key never ships: it lives with the vendor (license-private.pem,
// gitignored) and is only used by scripts/license-issue.mjs to mint keys after a sale.
//
// Key format:  VYUHA-<base64url(payload JSON)>.<base64url(signature)>
// Payload:     { "email": "buyer@x.com", "sku": "toolkit"|"app"|"indicators", "issued": "YYYY-MM-DD" }
//
// Threat model: stop honest sharing, not determined crackers — the key embeds the
// buyer's email and the UI shows "Licensed to <email>" (social friction). An offline
// app can always be patched; that is accepted (see docs/owner/MONETIZATION_PLAN.md).
//
// ENFORCEMENT MODES — flip ONE constant when you start selling:
//   "banner" (current): everything works; Pro screens show an "unlicensed" banner.
//   "block":            Pro screens render the upsell panel instead of content.

import { verify as edVerify, createHash } from "node:crypto";
import { machineMatches } from "@/lib/machine-id";
import { buyMessageFor, skuById, type PricingSkuId } from "@/lib/domain/pricing";

export type LicenseSku = "toolkit" | "app" | "indicators";
export type LicenseEnforcement = "banner" | "block";

export const LICENSE_ENFORCEMENT: LicenseEnforcement = "block";

/** Vendor Ed25519 PUBLIC key (safe to ship). Regenerate via scripts/license-keygen.mjs. */
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEADGdKaFSdvVk9XZ+tusGpEFDhpMF0OWwa5PldZT5aTCI=
-----END PUBLIC KEY-----`;

export interface LicensePayload {
  email: string;
  sku: LicenseSku | string;
  issued: string; // ISO date
  /** Optional ISO expiry date (annual SKUs). Absent = lifetime. Signed like
   *  every other field, so it can't be edited without breaking the signature. */
  expires?: string;
  /** Optional machine binding. Present = this key only activates on the machine
   *  whose ID this is; absent = runs anywhere (the default, and what every key
   *  issued before binding existed will always be). Signed, so it cannot be
   *  stripped out without breaking the key. */
  machine?: string;
}

export interface LicenseCheck {
  valid: boolean;
  reason?: string; // set when invalid
  payload?: LicensePayload; // set when valid
}

const KEY_PREFIX = "VYUHA-";

/**
 * Short, stable, human-quotable ID for a key — `sha256(key)` truncated and
 * grouped, e.g. `A1B2-C3D4-E5`.
 *
 * Exists so the vendor can refer to a sold key in a ledger, a support thread or
 * the revocation list WITHOUT storing or pasting the whole key anywhere. It is
 * derived, not random: the same key always yields the same ID, on your machine
 * and on the buyer's, so a customer can read theirs out of Settings and you can
 * match it against what you issued.
 */
export function licenseKeyId(key: string): string {
  const hex = createHash("sha256").update(key.trim()).digest("hex").slice(0, 10).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 10)}`;
}

/**
 * Keys that must stop working — refunds, chargebacks, or a key found posted
 * publicly. Add the ID (not the key) via `node scripts/license-revoke.mjs`.
 *
 * This is the BUILD-TIME half: baked into the binary, so it only reaches a
 * user who installs this build or later. Since v2.99.91 it is backed by a
 * SIGNED REVOCATION LIST (lib/revocation-format.ts) that the desktop shell
 * caches during the version check it already performs at launch — that half
 * reaches an install without requiring an update, which is the gap this list
 * alone could never close.
 *
 * Both halves are consulted. Keep adding IDs here via
 * `node scripts/license-revoke.mjs` — the build-time copy is the durable
 * record and the one that protects future installs even if a machine never
 * fetches a list.
 *
 * HONEST LIMITS of the pair, unchanged in spirit: the signed list fails OPEN
 * (an offline app cannot tell "unreachable" from "blocked"), it never travels
 * upward — no key, machine id or usage is ever transmitted — and neither half
 * survives a patched binary. This reaches the lapsed and the casual. It is
 * not DRM and must not be sold as such.
 */
export const REVOKED_KEY_IDS: readonly string[] = [];

/** Split a key into payload+signature bytes. Pure string handling — no crypto. */
export function parseLicenseKey(key: string): { payloadRaw: Buffer; signature: Buffer; payload: LicensePayload } | null {
  const trimmed = key.trim();
  if (!trimmed.startsWith(KEY_PREFIX)) return null;
  const body = trimmed.slice(KEY_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot === body.length - 1) return null;
  try {
    const payloadRaw = Buffer.from(body.slice(0, dot), "base64url");
    const signature = Buffer.from(body.slice(dot + 1), "base64url");
    const payload = JSON.parse(payloadRaw.toString("utf8")) as LicensePayload;
    if (typeof payload?.email !== "string" || typeof payload?.sku !== "string" || typeof payload?.issued !== "string") return null;
    return { payloadRaw, signature, payload };
  } catch {
    return null;
  }
}

/** Verify a license key against a public key (defaults to the baked-in vendor key). */
export function verifyLicenseKey(
  key: string,
  publicKeyPem: string = LICENSE_PUBLIC_KEY_PEM,
  revokedIds: readonly string[] = REVOKED_KEY_IDS,
  currentMachineId?: string,
): LicenseCheck {
  const parsed = parseLicenseKey(key);
  if (!parsed) return { valid: false, reason: "Malformed key — paste the full VYUHA-… key from your purchase email." };
  // Revocation is checked BEFORE the signature: a revoked key is still
  // cryptographically perfect, so signature validity is not the question.
  if (revokedIds.includes(licenseKeyId(key))) {
    return { valid: false, reason: "This key has been revoked. Contact support if you believe this is a mistake." };
  }
  try {
    const ok = edVerify(null, parsed.payloadRaw, publicKeyPem, parsed.signature);
    if (!ok) return { valid: false, reason: "Signature check failed — the key was altered or issued for a different build." };
    // Machine binding is checked AFTER the signature: the bound id is part of
    // the signed payload, so it is only trustworthy once the signature holds.
    if (currentMachineId && !machineMatches(parsed.payload.machine, currentMachineId)) {
      return {
        valid: false,
        reason: `This key is locked to a different computer. Send your Machine ID (${currentMachineId}) to support to have it re-issued.`,
      };
    }
    return { valid: true, payload: parsed.payload };
  } catch {
    return { valid: false, reason: "Signature check failed — the key was altered or issued for a different build." };
  }
}

export const SKU_LABELS: Record<string, string> = {
  toolkit: "Vyuha app (legacy bundle key)",
  app: "Vyuha app",
  indicators: "Legacy indicators key",
};

// ---------------------------------------------------------------------------
// Entitlement layer (monetization v2) — signature validity vs. entitlement are
// two different questions: an annual key stays cryptographically valid after
// its expiry date, but no longer entitles Pro.
// ---------------------------------------------------------------------------

/**
 * Full Pro trial for every fresh install — one expiry week, offline by design.
 *
 * SHORTENED 14 → 7 at v2.99.10. One trading week is still enough to import a
 * real book, hit an expiry, and see a charge-leak number; two weeks mostly
 * added drift before the decision. Every user-visible mention derives from
 * this constant, so it is the only place to change it.
 *
 * Note for anyone changing it again: the countdown is
 * `TRIAL_DAYS − elapsed-since-first-run`, so SHORTENING it moves existing
 * installs down immediately (someone on day 9 of the old 14 lands at 0).
 * The core journal is never gated (invariant 7) — only Pro analytics lock —
 * but testers mid-trial should be issued keys before such a change ships.
 */
export const TRIAL_DAYS = 7;

/**
 * Your WhatsApp number in international format, DIGITS ONLY — e.g. "919876543210".
 *
 * This is the single place to set it. Empty string = not configured yet, and
 * BUY_URL falls back to the public releases page so no button is ever dead.
 *
 * Delivery model (2026-07): the installer ZIP and licence key are sent
 * personally by email after a WhatsApp conversation — see
 * docs/owner/LICENSE_OPERATIONS.md.
 */
// Typed as `string`, not inferred as a literal: the guard tests compare it
// against "" and TypeScript would otherwise narrow it to a single literal type
// and reject the comparison as impossible.
export const WHATSAPP_NUMBER: string = "917393673714";

/** Pre-filled first message, so a buyer never has to work out what to type. */
const BUY_MESSAGE = "Hi, I'd like to buy Vyuha Pro";

/**
 * Where every "Get Vyuha Pro" / "Renew" button points.
 *
 * Derived, never hand-edited: set WHATSAPP_NUMBER above and this follows. The
 * fallback matters — in "block" enforcement this link is the ONLY route a
 * trial-expired user has, so it must never be a placeholder. A test in
 * tests/license.test.ts fails the build if enforcement is "block" while the
 * number is still unset.
 */
export const BUY_URL = WHATSAPP_NUMBER
  ? `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(BUY_MESSAGE)}`
  : "https://github.com/Thejesh-k463/VYUHA-LOG/releases";

/**
 * A per-SKU buy link: same WhatsApp channel, but the pre-filled message names
 * the SKU and EMBEDS the price this build displayed (lib/domain/pricing.ts) —
 * the honest answer to prices going stale in an offline build: the seller
 * sees at first contact exactly what the buyer was quoted.
 */
export function buyUrlFor(skuId?: PricingSkuId): string {
  if (!WHATSAPP_NUMBER) return "https://github.com/Thejesh-k463/VYUHA-LOG/releases";
  const text = buyMessageText(skuId);
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

/**
 * The plain (un-encoded) pre-filled message behind buyUrlFor(skuId) — what
 * the buy dialog shows and copies. Same string the link carries, so the buyer
 * who types the number by hand sends the same quote as the one who taps.
 */
export function buyMessageText(skuId?: PricingSkuId): string {
  return skuId ? buyMessageFor(skuById(skuId)) : BUY_MESSAGE;
}

/**
 * WHATSAPP_NUMBER as a human reads it: "917393673714" → "+91 73936 73714".
 * Indian numbers (91 + ten digits) split 5/5; anything else is just "+digits".
 * Pure string work — the desktop webview cannot open wa.me, so the number
 * has to be readable and copyable on screen.
 */
export function formatWhatsAppNumber(digits: string = WHATSAPP_NUMBER): string {
  const d = digits.replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 12 && d.startsWith("91")) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  return `+${d}`;
}

/**
 * The Pro surface — the list shown on the upsell card.
 *
 * THIS REGISTRY IS DISPLAY-ONLY. `ProGate` takes no feature argument: it
 * checks entitlement and renders children or the upsell. Adding an entry here
 * does NOT gate a page — you must also wrap that page's content in
 * `<ProGate>`. (An earlier comment claimed otherwise, and the two drifted:
 * six pages were listed while several substantive analytics screens sat
 * outside the paywall.) `tests/pro-gating.test.ts` now asserts the two stay
 * in step.
 *
 * Deliberate: the CORE JOURNAL — recording trades, every importer, the
 * dashboard, playbooks, staged positions and backups — is never gated. Your
 * own record of your trading is never held hostage (invariant 7). The one
 * journal-side exception is ADDING AN OPEN TRADE: tracking a live position
 * with SL/target/risk is forward-looking tooling, not record-keeping.
 */
export const PRO_FEATURES: { href: string; label: string; partial?: true }[] = [
  // Positions & risk
  { href: "/risk", label: "Portfolio Risk cockpit (VaR, Greeks, margin, settlement radar, breach alerts)" },
  // `partial: true` — a Pro CAPABILITY inside an otherwise-free page. The page
  // itself must NOT be wrapped in <ProGate> (that would gate the core journal);
  // it must check `getEntitlement()` and gate just the capability. The tests
  // enforce both directions.
  { href: "/trades?add=open", label: "Open-trade tracking — live positions with SL/TSL/target and risk", partial: true },
  { href: "/lenses", label: "Lenses — per-group win rate, profit factor, expectancy and avg R (grouping, counts and cleanup stay free)", partial: true },
  // Deep analytics
  { href: "/arjuns-eye", label: "Arjun's Eye — the trader's cockpit" },
  { href: "/reports/edge", label: "Edge / Setups — expectancy by setup, segment and NSE theme" },
  { href: "/reports/discipline", label: "Discipline — which broken rule costs you the most" },
  { href: "/review", label: "Trade Review Desk" },
  { href: "/reports/scaling", label: "Scaling Quality & Trade Replay" },
  // Options seller
  { href: "/options-journal", label: "Options Seller Journal — IV, DTE, hedge and expiry outcomes" },
  { href: "/reports/expiry", label: "Expiry Analytics — expiry-day vs other-day edge" },
  { href: "/reports/rom", label: "Return on Margin — what your capital actually earned" },
  // Tax
  { href: "/reports/tax", label: "Tax Summary (grandfathering, dividend TDS, set-off)" },
  { href: "/reports/itr", label: "ITR Pack — 44AB/44AD audit read + CA export" },
  { href: "/reports/advance-tax", label: "Advance Tax planner — 15 Jun/Sep/Dec/Mar instalments" },
  { href: "/reports/harvest", label: "Tax Harvest — LTCG exemption and loss harvesting" },
  { href: "/reports/ais", label: "AIS Reconcile — the portal's JSON against your journal" },
  // Costs, data & exports
  { href: "/reports/broker-compare", label: "Broker cost comparison + cross-broker MTF margins" },
  { href: "/reports/charges", label: "Charges & MTF Leak — where the money actually goes" },
  { href: "/reports/monthly", label: "PDF reports — monthly, per broker and financial year" },
  // Gated since the print rework but never advertised here — a user was
  // blocked by something the upsell card never told them they would get.
  // CSV/JSON export of the same trades stays free (the label says so out
  // loud): what is sold is the typeset artefact, not the data.
  { href: "/trades/report", label: "Selected-trades PDF — print any hand-picked set (CSV/JSON export stays free)" },
];

/**
 * Every route whose RENDER depends on entitlement — the set to revalidate the
 * moment a key is activated or removed.
 *
 * DERIVED from PRO_FEATURES so it cannot drift: the previous hand-written list
 * in app/api/license/route.ts covered 4 of 17 Pro screens and nobody noticed,
 * because activation still *looked* fine (every gated page is force-dynamic
 * and the licence card refreshes its own route). Derivation plus the test in
 * tests/pro-gating.test.ts makes the next Pro screen self-registering.
 */
export const ENTITLEMENT_PATHS: readonly string[] = [
  ...new Set<string>([
    "/", // dashboard reflects trial state
    "/settings", // the licence card itself
    "/trades", // open-trade + export-PDF buttons read `pro`
    "/lenses", // per-group edge columns are Pro (hybrid)
    ...PRO_FEATURES.map((f) => f.href.split("?")[0]),
  ]),
];

export type EntitlementState = "licensed" | "trial" | "expired-key" | "unlicensed";

export interface Entitlement {
  state: EntitlementState;
  pro: boolean; // licensed OR in trial
  payload: LicensePayload | null; // set for licensed AND expired-key
  trialDaysLeft: number; // 0 when over / not applicable
  reason?: string; // invalid-key reason, when a key exists but fails
  /**
   * Set while a licence is on the signed revocation list but still inside its
   * GRACE window (v2.99.91). Pro stays unlocked — this is a warning the UI
   * shows on every Pro screen, so a mistaken revocation is recoverable and the
   * buyer has time to reach the vendor before anything is taken away.
   */
  revocationWarning?: { daysLeft: number; effectiveFrom: string; message: string };
  /**
   * Set while an ANNUAL licence is inside its final stretch — the renewal
   * countdown (v2.99.94).
   *
   * There was no warning of any kind before this. `isKeyExpired` is a binary
   * check, so 17 Pro screens locked overnight and the buyer's first signal was
   * a locked screen; the owner-side reminder (`license-list.mjs --expiring 30`)
   * only ever told the SELLER. On a plan whose entire economics are renewals,
   * the customer was the one person not told.
   *
   * Deliberately shaped like `revocationWarning`: Pro stays fully unlocked and
   * the UI shows a countdown, because a renewal is a decision the buyer should
   * make with notice, not a wall they walk into.
   */
  expiryWarning?: { daysLeft: number; expires: string };
}

/**
 * How long before an annual key expires the countdown starts.
 *
 * 30 days matches `license-list.mjs --expiring 30`, which the runbook already
 * calls the renewal campaign — so the seller's reminder and the buyer's
 * reminder now fire on the same day rather than only one of them existing.
 */
export const RENEWAL_NOTICE_DAYS = 30;

/**
 * Whole days until an annual key expires, or null when there is nothing to warn
 * about: a lifetime key (no `expires`), an already-expired one (that is the
 * expired-key state, not a warning), or one further out than the notice window.
 *
 * Pure, so it takes the clock-ratcheted date like every other entitlement
 * decision — winding the system clock back must not extend the notice.
 */
export function renewalDaysLeft(
  payload: LicensePayload,
  today: Date = new Date(),
  noticeDays: number = RENEWAL_NOTICE_DAYS,
): number | null {
  if (!payload.expires) return null;
  const end = new Date(payload.expires + "T23:59:59").getTime();
  if (Number.isNaN(end)) return null;
  const left = Math.ceil((end - today.getTime()) / dayMs);
  if (left <= 0 || left > noticeDays) return null;
  return left;
}

const dayMs = 86_400_000;

/**
 * How far the clock may legitimately move backwards before we stop believing it.
 *
 * Timezone changes, DST, a laptop waking in another country and an NTP
 * correction are all real and all small. Two days absorbs every one of them
 * without absorbing a deliberate rollback, which is measured in months.
 */
export const CLOCK_TOLERANCE_DAYS = 2;

/**
 * The date the app will reason about, given the system clock and the latest date
 * it has ever seen.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The trial and any annual key are both evaluated against the system clock, and
 * an offline app cannot ask anyone what day it is. Setting the clock back a year
 * therefore renewed the full trial and un-expired a lapsed key, indefinitely and
 * silently. This makes time effectively monotonic: the app remembers the latest
 * date it has observed, and a clock that jumps meaningfully backwards is simply
 * not believed for entitlement purposes.
 *
 * It is a RATCHET, not a lock. It never expires anything early, never punishes
 * ordinary drift, and a user who genuinely had a wrong clock loses nothing —
 * their high-water mark simply stops moving until real time catches up. And like
 * everything else here it can be patched out of an offline binary; the goal is
 * to make casual extension not work, not to defeat a determined cracker.
 */
export function effectiveToday(
  now: Date,
  highWaterMark: string | null,
  toleranceDays: number = CLOCK_TOLERANCE_DAYS,
): Date {
  if (!highWaterMark) return now;
  const seen = new Date(highWaterMark).getTime();
  if (Number.isNaN(seen)) return now;
  // Only a move backwards past the tolerance is disbelieved. Forward jumps are
  // always honoured — time passing is exactly what we expect.
  return now.getTime() < seen - toleranceDays * dayMs ? new Date(seen) : now;
}

/** True when the system clock sits meaningfully behind the latest date seen. */
export function clockMovedBackwards(
  now: Date,
  highWaterMark: string | null,
  toleranceDays: number = CLOCK_TOLERANCE_DAYS,
): boolean {
  if (!highWaterMark) return false;
  const seen = new Date(highWaterMark).getTime();
  if (Number.isNaN(seen)) return false;
  return now.getTime() < seen - toleranceDays * dayMs;
}

/** Days of trial remaining (ceil, so the final day still counts). Pure. */
export function trialDaysLeft(trialStartedAt: string | null, today: Date = new Date()): number {
  if (!trialStartedAt) return 0;
  const start = new Date(trialStartedAt).getTime();
  if (Number.isNaN(start)) return 0;
  const left = TRIAL_DAYS - (today.getTime() - start) / dayMs;
  return Math.max(0, Math.ceil(left));
}

/** Signed expiry check — absent `expires` means lifetime. Pure. */
export function isKeyExpired(payload: LicensePayload, today: Date = new Date()): boolean {
  if (!payload.expires) return false;
  return today.getTime() > new Date(payload.expires + "T23:59:59").getTime();
}

/**
 * The one entitlement answer the app uses everywhere. Pure — callers supply
 * the stored key + trial start; DB access stays in lib/queries/license.ts.
 */
export function evaluateEntitlement(
  storedKey: string | null,
  trialStartedAt: string | null,
  todayIn: Date = new Date(),
  publicKeyPem: string = LICENSE_PUBLIC_KEY_PEM,
  revokedIds: readonly string[] = REVOKED_KEY_IDS,
  currentMachineId?: string,
  /** Latest date this install has ever observed — see effectiveToday. */
  clockHighWaterMark: string | null = null,
): Entitlement {
  // Every date comparison below uses the ratcheted date, so winding the system
  // clock back cannot renew a trial or revive an expired key.
  const today = effectiveToday(todayIn, clockHighWaterMark);
  if (storedKey) {
    const check = verifyLicenseKey(storedKey, publicKeyPem, revokedIds, currentMachineId);
    if (check.valid && check.payload) {
      if (isKeyExpired(check.payload, today)) {
        // Expired annual key: fall back to trial if any remains, else free.
        const days = trialDaysLeft(trialStartedAt, today);
        return { state: "expired-key", pro: days > 0, payload: check.payload, trialDaysLeft: days };
      }
      return { state: "licensed", pro: true, payload: check.payload, trialDaysLeft: 0 };
    }
    // Invalid key on record → treated as unlicensed (reason surfaced in Settings).
    const days = trialDaysLeft(trialStartedAt, today);
    return { state: days > 0 ? "trial" : "unlicensed", pro: days > 0, payload: null, trialDaysLeft: days, reason: check.reason };
  }
  const days = trialDaysLeft(trialStartedAt, today);
  return days > 0
    ? { state: "trial", pro: true, payload: null, trialDaysLeft: days }
    : { state: "unlicensed", pro: false, payload: null, trialDaysLeft: 0 };
}
