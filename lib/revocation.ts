import "server-only";
import fs from "node:fs";
import path from "node:path";
import { verify, createPublicKey } from "node:crypto";
import { db, revocationFile } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { LICENSE_PUBLIC_KEY_PEM } from "@/lib/license";
import {
  validateRevocationList,
  canonicalListBytes,
  isNewerList,
  type RevocationList,
  type SignedRevocationList,
} from "./revocation-format";

/**
 * Reading the signed revocation list the desktop shell cached at launch.
 *
 * The shell (src-tauri/src/lib.rs) downloads `revocations.json` during the
 * version check it already performs and drops it in the app-data directory.
 * Nothing here fetches: this module only opens a local file, checks the
 * vendor's signature, and enforces the rollback ratchet. If the file never
 * arrives — offline, blocked, a browser-only `npm run dev` — every read
 * returns null and the app behaves exactly as it did before this feature
 * existed. That is the intended failure mode, not an oversight.
 */

// One verification per request; the file does not change under a running process.
const globalForRevocation = globalThis as unknown as { __vyuhaRevocationList?: RevocationList | null };

function verifySignature(env: SignedRevocationList): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalListBytes(env.list), "utf8"),
      createPublicKey(LICENSE_PUBLIC_KEY_PEM),
      Buffer.from(env.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/**
 * The accepted list, or null.
 *
 * Refuses, in order: missing file, malformed envelope, bad signature, and a
 * list strictly OLDER than the one this machine already accepted. Only then
 * does it advance the stored high-water mark, so a stale copy dropped in by
 * hand is inert. Re-reading the SAME list on a later launch is the steady
 * state and is accepted without advancing anything.
 *
 * Deleting the cached file un-revokes until the next launch, when the shell
 * downloads the same list again and this returns it (its issuedAt equals the
 * stored mark, which line 70 treats as steady state, not as a rollback). That
 * is a stated limit, in the same class as "does not survive a patched binary":
 * the ratchet exists to stop an OLDER list undoing a newer one, not to defend
 * against someone with write access to their own disk.
 */
export function loadRevocationList(): RevocationList | null {
  if (globalForRevocation.__vyuhaRevocationList !== undefined) return globalForRevocation.__vyuhaRevocationList;

  let result: RevocationList | null = null;
  try {
    if (fs.existsSync(revocationFile)) {
      const parsed = JSON.parse(fs.readFileSync(revocationFile, "utf8")) as SignedRevocationList;
      if (validateRevocationList(parsed).ok && verifySignature(parsed)) {
        const row = db.select({ id: settings.id, seen: settings.revocationListIssuedAt }).from(settings).get();
        if (isNewerList(parsed.list.issuedAt, row?.seen ?? null)) {
          if (row) {
            db.update(settings).set({ revocationListIssuedAt: parsed.list.issuedAt }).where(eq(settings.id, row.id)).run();
          }
          result = parsed.list;
        } else if (row?.seen && parsed.list.issuedAt === row.seen) {
          // Same list this machine already accepted — normal steady state.
          result = parsed.list;
        }
        // Strictly older → ignored. A replayed file cannot undo a revocation.
      }
    }
  } catch {
    // A corrupt or unreadable file must never break the app. Same posture as
    // the vault: an entitlement question degrades, it does not throw.
    result = null;
  }

  globalForRevocation.__vyuhaRevocationList = result;
  return result;
}

/** Test seam — forces the next call to re-read and re-verify. */
export function resetRevocationCache(): void {
  globalForRevocation.__vyuhaRevocationList = undefined;
}

/** Where the shell writes the cache; exported for the owner runbook and tests. */
export function revocationCachePath(): string {
  return path.resolve(revocationFile);
}
