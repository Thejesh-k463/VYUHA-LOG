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
// app can always be patched; that is accepted (see docs/monetization/MONETIZATION_PLAN.md).
//
// ENFORCEMENT MODES — flip ONE constant when you start selling:
//   "banner" (current): everything works; Pro screens show an "unlicensed" banner.
//   "block":            Pro screens render the upsell panel instead of content.

import { verify as edVerify, createHash } from "node:crypto";

export type LicenseSku = "toolkit" | "app" | "indicators";
export type LicenseEnforcement = "banner" | "block";

export const LICENSE_ENFORCEMENT: LicenseEnforcement = "banner";

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
 * HONEST LIMIT: this is a build-time list in an offline app. A revoked key
 * keeps working until the user installs a build that contains the revocation.
 * There is no remote kill switch and adding one would mean a server call on
 * launch, which is exactly the promise this product is sold on. Revocation is
 * therefore a slow, honest tool: it stops resale of a leaked key to future
 * installs, it does not reach back into a machine already running.
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
    return { valid: true, payload: parsed.payload };
  } catch {
    return { valid: false, reason: "Signature check failed — the key was altered or issued for a different build." };
  }
}

export const SKU_LABELS: Record<string, string> = {
  toolkit: "Trader's Toolkit (app + indicators)",
  app: "Vyuha app",
  indicators: "Indicators bundle",
};

// ---------------------------------------------------------------------------
// Entitlement layer (monetization v2) — signature validity vs. entitlement are
// two different questions: an annual key stays cryptographically valid after
// its expiry date, but no longer entitles Pro.
// ---------------------------------------------------------------------------

/** Full Pro trial for every fresh install — long enough to hit one expiry week
 *  and one MTF interest cycle, short enough to matter. Offline by design. */
export const TRIAL_DAYS = 14;

/** Where "Get the Toolkit" buttons point. Swap for the live Razorpay payment
 *  page / landing page URL at launch (docs/monetization/MONETIZATION_PLAN.md §3). */
export const BUY_URL = "https://github.com/Thejesh-k463/VYUHA-LOG/releases";

/** The Pro surface. One registry drives the gates, the upsell card's feature
 *  list, and the docs — add a page here and it's gated everywhere at once.
 *  Deliberate: the CORE JOURNAL (trades, imports, dashboard, playbooks) is
 *  never gated — your data and record-keeping are never held hostage. */
export const PRO_FEATURES: { href: string; label: string }[] = [
  { href: "/risk", label: "Portfolio Risk cockpit (VaR, Greeks, margin, settlement radar, breach alerts)" },
  { href: "/reports/tax", label: "Tax Summary (grandfathering, dividend TDS, set-off)" },
  { href: "/reports/itr", label: "ITR Pack — 44AB/44AD audit read + CA export" },
  { href: "/reports/broker-compare", label: "Broker cost comparison (whole history re-priced)" },
];

export type EntitlementState = "licensed" | "trial" | "expired-key" | "unlicensed";

export interface Entitlement {
  state: EntitlementState;
  pro: boolean; // licensed OR in trial
  payload: LicensePayload | null; // set for licensed AND expired-key
  trialDaysLeft: number; // 0 when over / not applicable
  reason?: string; // invalid-key reason, when a key exists but fails
}

const dayMs = 86_400_000;

/** Days of trial remaining (ceil — day 14 still counts). Pure. */
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
  today: Date = new Date(),
  publicKeyPem: string = LICENSE_PUBLIC_KEY_PEM,
  revokedIds: readonly string[] = REVOKED_KEY_IDS,
): Entitlement {
  if (storedKey) {
    const check = verifyLicenseKey(storedKey, publicKeyPem, revokedIds);
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
