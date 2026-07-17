import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  verifyLicenseKey,
  evaluateEntitlement,
  LICENSE_ENFORCEMENT,
  type Entitlement,
  type LicensePayload,
} from "@/lib/license";

export interface LicenseStatus {
  licensed: boolean;
  payload: LicensePayload | null;
  enforcement: typeof LICENSE_ENFORCEMENT;
}

/** Re-verifies the stored key on every read — a DB-tampered key simply reads unlicensed. */
export function getLicenseStatus(): LicenseStatus {
  const row = db.select({ licenseKey: settings.licenseKey }).from(settings).get();
  const key = row?.licenseKey;
  if (!key) return { licensed: false, payload: null, enforcement: LICENSE_ENFORCEMENT };
  const check = verifyLicenseKey(key);
  return {
    licensed: check.valid,
    payload: check.valid ? (check.payload ?? null) : null,
    enforcement: LICENSE_ENFORCEMENT,
  };
}

/**
 * Monetization v2 — the app's one entitlement answer (licensed / trial /
 * expired-key / unlicensed). Lazily stamps the 14-day trial on the true first
 * read of a fresh install: the bundled template DB deliberately ships with
 * trial_started_at = NULL (seed runs after migrations, so migration 0024's
 * backfill only touches EXISTING installs), which means the clock starts when
 * the USER first opens the app, not when the installer was built.
 * cache(): one evaluation per request no matter how many gates render.
 */
export const getEntitlement = cache((): Entitlement & { enforcement: typeof LICENSE_ENFORCEMENT } => {
  const row = db
    .select({ id: settings.id, licenseKey: settings.licenseKey, trialStartedAt: settings.trialStartedAt })
    .from(settings)
    .get();

  let trialStartedAt = row?.trialStartedAt ?? null;
  if (row && trialStartedAt == null) {
    trialStartedAt = new Date().toISOString();
    // Guarded write — a concurrent request racing the stamp keeps the first value.
    db.update(settings).set({ trialStartedAt }).where(eq(settings.id, row.id)).run();
    trialStartedAt = db.select({ t: settings.trialStartedAt }).from(settings).where(eq(settings.id, row.id)).get()?.t ?? trialStartedAt;
  }

  return { ...evaluateEntitlement(row?.licenseKey ?? null, trialStartedAt), enforcement: LICENSE_ENFORCEMENT };
});
