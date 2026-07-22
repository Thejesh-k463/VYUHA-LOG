// Single source of truth for revoked key IDs, shared by the vendor scripts and
// patched into lib/license.ts by license-revoke.mjs.
//
// Add IDs with:  node scripts/license-revoke.mjs <KEY-ID> "reason"
export const REVOKED_IDS = [];
