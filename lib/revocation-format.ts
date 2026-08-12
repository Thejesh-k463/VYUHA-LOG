// THE SIGNED REVOCATION LIST (PURE — no DB, no fs, no network).
//
// ── What this is, and what it deliberately is not ───────────────────────────
//
// Until v2.99.91 revocation was a BUILD-TIME list: `REVOKED_KEY_IDS` shipped
// inside the binary, so a revoked key kept working until its owner installed a
// newer build — which the person you just revoked has no reason to do. This
// closes that gap for the narrow case it was always meant for: a refunded key,
// a chargeback, a key posted in a WhatsApp group.
//
// The design constraint was the product's own promise. Vyuha is sold on "your
// data never leaves this machine", and that claim had to survive intact. So:
//
//   THE LIST TRAVELS DOWN. NOTHING TRAVELS UP.
//
// The app downloads a small public file and reads it locally. It sends no key,
// no machine id, no email, no usage — there is no request body and no
// identifier in the URL. Every "no telemetry" claim stays literally true,
// because none of this is telemetry: it is the same shape as a certificate
// revocation list. The vendor learns nothing about who checked.
//
// It rides the version check the desktop shell ALREADY performs at launch
// (src-tauri/src/lib.rs), so it adds no new host, no new call and no new
// timing signal to the app's network behaviour.
//
// ── The honest limits, stated in code because they belong here ──────────────
//
// 1. FAIL-OPEN, unavoidably. An offline app cannot distinguish "unreachable"
//    from "blocked", and refusing to run offline would break the product for
//    every honest user. Someone who blocks the domain before the first check
//    after publication never receives the list.
// 2. Once received it survives going OFFLINE — the cached file is read
//    locally on every launch, so pulling the plug afterwards changes nothing.
//    It does not survive someone DELETING that file, which un-revokes until
//    the next launch re-downloads the same list. The ratchet exists to stop an
//    older list displacing a newer one, not to defend against a user with
//    write access to their own disk.
// 3. It does not survive a patched binary. Nothing client-side does.
//
// This reaches the lapsed and the casual. It is not, and is not sold as, DRM.

/** Verified against the SAME Ed25519 key that signs licences — one vendor key,
 *  one trust root. A forged list fails for exactly the reason a forged key
 *  does. */
export const REVOCATION_VERSION = 1;

export interface RevocationEntry {
  /** The quotable key id (`A1B2-C3D4-E5`) — never the key itself. */
  keyId: string;
  /**
   * When Pro actually locks. Before this date the app WARNS and stays
   * unlocked, which is what makes a mistaken revocation recoverable and gives
   * the buyer time to reach you. Omit for an immediate lock.
   */
  effectiveFrom?: string;
  /** Shown to the user verbatim. Say why, and how to reach you. */
  message?: string;
}

export interface RevocationList {
  vyuhaRevocations: true;
  v: number;
  /** Monotonic. A list older than the one already seen is refused (rollback). */
  issuedAt: string;
  entries: RevocationEntry[];
}

/** What the envelope looks like on disk / on the wire: payload + signature. */
export interface SignedRevocationList {
  list: RevocationList;
  /** base64url Ed25519 signature over the EXACT `list` JSON bytes. */
  signature: string;
}

export type RevocationState =
  /** Not on the list. */
  | { status: "active" }
  /** On the list, inside its grace window — warn, do not lock. */
  | { status: "warning"; daysLeft: number; effectiveFrom: string; message: string }
  /** On the list, grace elapsed (or none given) — Pro locks. */
  | { status: "revoked"; message: string };

const dayMs = 86_400_000;

export const DEFAULT_REVOCATION_MESSAGE =
  "This licence has been withdrawn. Contact the vendor if you believe this is a mistake — your journal, imports, backups and exports keep working either way.";

export function validateRevocationList(x: unknown): { ok: boolean; error?: string } {
  if (!x || typeof x !== "object") return { ok: false, error: "Not a revocation list." };
  const e = x as Partial<SignedRevocationList>;
  if (!e.list || typeof e.list !== "object") return { ok: false, error: "The envelope carries no list." };
  if (typeof e.signature !== "string" || !e.signature) return { ok: false, error: "The list is unsigned." };
  const l = e.list as Partial<RevocationList>;
  if (l.vyuhaRevocations !== true) return { ok: false, error: "Not a Vyuha revocation list." };
  if (typeof l.v !== "number") return { ok: false, error: "The list has no version." };
  if (l.v > REVOCATION_VERSION) return { ok: false, error: `Written by a newer Vyuha (list v${l.v}).` };
  if (typeof l.issuedAt !== "string" || Number.isNaN(Date.parse(l.issuedAt))) {
    return { ok: false, error: "The list has no usable issue date." };
  }
  if (!Array.isArray(l.entries)) return { ok: false, error: "The list has no entries array." };
  for (const entry of l.entries) {
    if (!entry || typeof entry !== "object" || typeof (entry as RevocationEntry).keyId !== "string") {
      return { ok: false, error: "An entry is malformed." };
    }
  }
  return { ok: true };
}

/**
 * The exact bytes that get signed.
 *
 * Signing a re-serialised object is how signature checks quietly break: two
 * JSON encoders order keys differently and the bytes stop matching.
 *
 * `scripts/revocation-publish.mjs` cannot import this (it is plain .mjs, run
 * by the vendor outside the app), so it re-implements the same shape — the one
 * real drift risk in the feature, and a silent one: every published signature
 * would verify nowhere while the tooling reported success. So the agreement is
 * pinned by running the actual script and feeding its actual output to the
 * actual reader — `tests/revocation-roundtrip.test.ts`, "the PUBLISHER and the
 * VERIFIER agree". Change either side and that test fails.
 */
export function canonicalListBytes(list: RevocationList): string {
  return JSON.stringify({
    vyuhaRevocations: true,
    v: list.v,
    issuedAt: list.issuedAt,
    entries: list.entries.map((e) => ({
      keyId: e.keyId,
      ...(e.effectiveFrom ? { effectiveFrom: e.effectiveFrom } : {}),
      ...(e.message ? { message: e.message } : {}),
    })),
  });
}

/**
 * Is `candidate` newer than what this machine has already accepted?
 *
 * The anti-rollback guard. Without it, someone who kept a copy of yesterday's
 * list could drop it back in and undo their own revocation — the same replay
 * the licence clock ratchet already defends against for expiry.
 */
export function isNewerList(candidateIssuedAt: string, acceptedIssuedAt: string | null): boolean {
  if (!acceptedIssuedAt) return true;
  const c = Date.parse(candidateIssuedAt);
  const a = Date.parse(acceptedIssuedAt);
  if (Number.isNaN(c)) return false;
  if (Number.isNaN(a)) return true;
  return c > a;
}

/**
 * Where one key stands against a list.
 *
 * `today` is injected so callers can pass the CLOCK-RATCHETED date
 * (lib/license.ts#effectiveToday) rather than the raw system clock — winding
 * the clock back must not buy extra grace, exactly as it cannot buy extra
 * trial.
 */
export function revocationStateFor(
  keyId: string | null,
  list: RevocationList | null,
  today: Date = new Date(),
): RevocationState {
  if (!keyId || !list) return { status: "active" };
  const entry = list.entries.find((e) => e.keyId.toUpperCase() === keyId.toUpperCase());
  if (!entry) return { status: "active" };

  const message = entry.message?.trim() || DEFAULT_REVOCATION_MESSAGE;
  if (!entry.effectiveFrom) return { status: "revoked", message };

  const effective = Date.parse(`${entry.effectiveFrom}T23:59:59`);
  if (Number.isNaN(effective)) return { status: "revoked", message };
  if (today.getTime() > effective) return { status: "revoked", message };

  return {
    status: "warning",
    daysLeft: Math.max(0, Math.ceil((effective - today.getTime()) / dayMs)),
    effectiveFrom: entry.effectiveFrom,
    message,
  };
}
