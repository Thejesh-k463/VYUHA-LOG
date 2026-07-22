/**
 * Machine fingerprint helpers that are safe to bundle for the browser.
 *
 * The actual probing of this computer lives in `machine-id.server.ts`, because
 * it needs `node:child_process` to read the Windows registry — and pulling that
 * into a client chunk breaks the production build. `lib/license.ts` is imported
 * by the Settings client component, so anything it touches must stay clean.
 *
 * ── Why the fingerprint is deliberately conservative ──────────────────────
 * If this value ever changes on a machine that did not change, a paying
 * customer's key stops working and you get a support ticket you cannot easily
 * disprove. So the inputs are chosen for STABILITY first, uniqueness second:
 *
 *   • Windows: the OS `MachineGuid` — written once at Windows install and
 *     untouched by app reinstalls, driver changes, RAM upgrades or renames.
 *   • Fallback: hostname + platform + arch + CPU model. Deliberately NOT
 *     total memory (changes on a RAM upgrade), NOT the MAC address (changes
 *     with docks, VPNs and USB adapters), NOT disk serial (changes on clone).
 *
 * A machine ID is a *coarse* identifier. Reinstalling Windows produces a new
 * one — expected, and covered by the re-issue procedure in
 * docs/monetization/LICENSE_OPERATIONS.md.
 *
 * PRIVACY: the raw values never leave the machine and are never stored. Only
 * the hash is shown, and the user chooses to send it. It contains no personal
 * data and cannot be reversed into a hostname.
 */

import { createHash } from "node:crypto";

/** Turn raw identity parts into the short quotable ID. Pure — the whole point
 *  is that this is testable without touching the real machine. */
export function deriveMachineId(parts: readonly (string | null | undefined)[]): string {
  const material = parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("|");
  if (!material) return "UNKNOWN-MACHINE";
  const hex = createHash("sha256").update(material).digest("hex").slice(0, 12).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

/**
 * Does a key's binding permit this machine?
 *
 * An UNBOUND key (no `machine` in the payload) runs anywhere — that is the
 * default and keeps every key sold before binding existed working forever.
 */
export function machineMatches(bound: string | undefined | null, current: string): boolean {
  if (!bound) return true;
  return bound.trim().toUpperCase() === current.trim().toUpperCase();
}
