import "server-only";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { verifyLicenseKey, LICENSE_ENFORCEMENT, type LicensePayload } from "@/lib/license";

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
