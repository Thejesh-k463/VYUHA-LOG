import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getMachineId } from "@/lib/machine-id.server";
import { readSecret, sweepPlaintextSecrets } from "@/lib/vault";
import { loadRevocationList } from "@/lib/revocation";
import { revocationStateFor } from "@/lib/revocation-format";
import {
  effectiveToday,
  trialDaysLeft,
  verifyLicenseKey,
  licenseKeyId,
  renewalDaysLeft,
  evaluateEntitlement,
  REVOKED_KEY_IDS,
  LICENSE_PUBLIC_KEY_PEM,
  LICENSE_ENFORCEMENT,
  type Entitlement,
  type LicensePayload,
} from "@/lib/license";

/** How far the clock high-water mark may lag `now` before it is rewritten. */
const MARK_WRITE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface LicenseStatus {
  licensed: boolean;
  payload: LicensePayload | null;
  enforcement: typeof LICENSE_ENFORCEMENT;
  /** Short quotable ID of the installed key — what the buyer reads out to you
   *  for support, and what you match against the vendor ledger. Never the key
   *  itself, which would be a credential in a support thread. */
  keyId: string | null;
  /** This computer's ID — always shown, so a buyer can send it to you before
   *  you mint a machine-bound key. */
  machineId: string;
  /** The machine this key is locked to, when it is locked at all. */
  boundTo: string | null;
}

/** Re-verifies the stored key on every read — a DB-tampered key simply reads unlicensed. */
export function getLicenseStatus(): LicenseStatus {
  sweepPlaintextSecrets();
  const row = db.select({ licenseKey: settings.licenseKey }).from(settings).get();
  // The stored key is vault ciphertext (v2.99.80); a pre-vault plaintext key
  // still reads (and the sweep above upgrades it). An UNREADABLE vault — new
  // machine, moved profile — degrades to "no key": the buyer re-pastes the
  // key from the purchase email, which is the same recovery the redacted
  // backup already implies. Never a crash, never a lost journal.
  const read = readSecret(row?.licenseKey);
  const key = read.ok ? read.value || null : null;
  const machineId = getMachineId();
  if (!key) {
    return { licensed: false, payload: null, enforcement: LICENSE_ENFORCEMENT, keyId: null, machineId, boundTo: null };
  }
  const check = verifyLicenseKey(key, LICENSE_PUBLIC_KEY_PEM, REVOKED_KEY_IDS, machineId);
  return {
    licensed: check.valid,
    payload: check.valid ? (check.payload ?? null) : null,
    enforcement: LICENSE_ENFORCEMENT,
    keyId: check.valid ? licenseKeyId(key) : null,
    machineId,
    boundTo: check.valid ? (check.payload?.machine ?? null) : null,
  };
}

/**
 * Monetization v2 — the app's one entitlement answer (licensed / trial /
 * expired-key / unlicensed). Lazily stamps the trial (TRIAL_DAYS) on the true first
 * read of a fresh install: the bundled template DB deliberately ships with
 * trial_started_at = NULL (seed runs after migrations, so migration 0024's
 * backfill only touches EXISTING installs), which means the clock starts when
 * the USER first opens the app, not when the installer was built.
 * cache(): one evaluation per request no matter how many gates render.
 */
export const getEntitlement = cache((): Entitlement & { enforcement: typeof LICENSE_ENFORCEMENT } => {
  // First entitlement read of the process upgrades any pre-vault plaintext
  // secret to ciphertext (v2.99.80). Idempotent and best-effort.
  sweepPlaintextSecrets();
  const row = db
    .select({ id: settings.id, licenseKey: settings.licenseKey, trialStartedAt: settings.trialStartedAt, clockHighWaterMark: settings.clockHighWaterMark })
    .from(settings)
    .get();

  let trialStartedAt = row?.trialStartedAt ?? null;
  if (row && trialStartedAt == null) {
    trialStartedAt = new Date().toISOString();
    // Guarded write — a concurrent request racing the stamp keeps the first value.
    db.update(settings).set({ trialStartedAt }).where(eq(settings.id, row.id)).run();
    trialStartedAt = db.select({ t: settings.trialStartedAt }).from(settings).where(eq(settings.id, row.id)).get()?.t ?? trialStartedAt;
  }

  // Advance the clock high-water mark. Only ever forwards: a system clock behind
  // the mark is disbelieved for entitlement purposes rather than written down,
  // so a rollback cannot lower the ratchet and then renew anything.
  //
  // Written at DAY granularity. The guard used to be `now > mark`, which is
  // true one millisecond after the previous write — so every Pro render was a
  // SQLite UPDATE, the app's most frequent writer (tests/load/
  // b2-entitlement-cost.load.ts: 200 reads → 200 UPDATEs). The ratchet exists
  // to catch a clock wound back by days (CLOCK_TOLERANCE_DAYS), so a mark up
  // to a day stale defends exactly as well; a null or unparseable mark is
  // still stamped at once.
  const now = new Date();
  const mark = row?.clockHighWaterMark ?? null;
  const markMs = mark == null ? NaN : new Date(mark).getTime();
  if (row && (Number.isNaN(markMs) || now.getTime() - markMs >= MARK_WRITE_INTERVAL_MS)) {
    db.update(settings).set({ clockHighWaterMark: now.toISOString() }).where(eq(settings.id, row.id)).run();
  }

  // Decrypt-at-read (v2.99.80). An unreadable vault means the key is not
  // usable HERE — the entitlement honestly evaluates keyless, and the reason
  // tells the user what to do instead of leaving a silent downgrade.
  const keyRead = readSecret(row?.licenseKey);
  const usableKey = keyRead.ok ? keyRead.value || null : null;

  const base = evaluateEntitlement(
    usableKey,
    trialStartedAt,
    now,
    LICENSE_PUBLIC_KEY_PEM,
    REVOKED_KEY_IDS,
    getMachineId(),
    mark,
  );

  // ── Signed revocation list (v2.99.91) ────────────────────────────────────
  //
  // Applied HERE rather than inside the pure evaluator because it needs the
  // cached file, and lib/license.ts must stay DB-free and fs-free (invariant
  // 2). It runs against the CLOCK-RATCHETED date, so winding the clock back
  // buys no extra grace — the same defence the trial and expiry already have.
  //
  // Grace is deliberately generous in shape: while it lasts, `pro` is
  // untouched and the user only sees a warning. Nothing is taken away until
  // the effective date, which is what makes a mistaken revocation survivable.
  // Renewal countdown for an annual key (v2.99.94). Computed against the same
  // clock-ratcheted date as everything else, and only while the licence is
  // actually valid — an expired one is already the expired-key state.
  let expiry: Partial<Entitlement> = {};
  if (base.state === "licensed" && base.payload) {
    const daysLeft = renewalDaysLeft(base.payload, effectiveToday(now, mark));
    if (daysLeft !== null && base.payload.expires) {
      expiry = { expiryWarning: { daysLeft, expires: base.payload.expires } };
    }
  }

  let revocation: Partial<Entitlement> = {};
  if (base.payload && usableKey) {
    const state = revocationStateFor(licenseKeyId(usableKey), loadRevocationList(), effectiveToday(now, mark));
    if (state.status === "revoked") {
      // Pro locks; the journal does not. Invariant 7 holds under revocation
      // too — a withdrawn licence must never lock someone out of their own
      // record, only out of the analytics they stopped paying for.
      const days = trialDaysLeft(trialStartedAt, effectiveToday(now, mark));
      revocation = { state: "expired-key", pro: false, trialDaysLeft: days, reason: state.message };
    } else if (state.status === "warning") {
      revocation = { revocationWarning: { daysLeft: state.daysLeft, effectiveFrom: state.effectiveFrom, message: state.message } };
    }
  }

  return {
    ...base,
    ...expiry,
    ...revocation,
    ...(row?.licenseKey && !keyRead.ok
      ? { reason: `Your licence is stored encrypted and ${keyRead.reason} — paste the key from your purchase email to re-activate.` }
      : {}),
    enforcement: LICENSE_ENFORCEMENT,
  };
});
