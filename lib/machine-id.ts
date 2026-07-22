/**
 * Machine fingerprint for optionally binding a licence key to one computer.
 *
 * ── Why this is deliberately conservative ─────────────────────────────────
 * If this value ever changes on a machine that did not change, a paying
 * customer's key stops working and you get a support ticket you cannot easily
 * disprove. So the inputs are chosen for STABILITY first and uniqueness
 * second:
 *
 *   • Windows: the OS `MachineGuid` — written once at Windows install and
 *     untouched by app reinstalls, driver changes, RAM upgrades or renames.
 *   • Fallback: hostname + platform + arch + CPU model. Deliberately NOT
 *     total memory (changes on a RAM upgrade), NOT the MAC address (changes
 *     with docks, VPNs and USB adapters), NOT disk serial (changes on clone).
 *
 * A machine ID is a *coarse* identifier. Reinstalling Windows produces a new
 * one — that is expected, and is exactly the case your re-issue procedure in
 * LICENSE_OPERATIONS.md covers.
 *
 * PRIVACY: the raw values never leave the machine and are never stored. Only
 * the hash is shown, and the user chooses to send it to you. It contains no
 * personal data and cannot be reversed into a hostname.
 */

import { createHash } from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";

/** Turn raw identity parts into the short quotable ID. Pure — the whole
 *  point is that this is testable without touching the real machine. */
export function deriveMachineId(parts: readonly (string | null | undefined)[]): string {
  const material = parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("|");
  if (!material) return "UNKNOWN-MACHINE";
  const hex = createHash("sha256").update(material).digest("hex").slice(0, 12).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

/** Windows `MachineGuid`, or null anywhere it cannot be read. */
function windowsMachineGuid(): string | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"],
      { encoding: "utf8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

let cached: string | null = null;

/**
 * This machine's ID. Computed once per process — the registry read is cheap
 * but there is no reason to repeat it on every entitlement check.
 */
export function getMachineId(): string {
  if (cached) return cached;

  const guid = windowsMachineGuid();
  if (guid) {
    cached = deriveMachineId(["winguid", guid]);
    return cached;
  }

  let cpu: string | null = null;
  try {
    cpu = os.cpus()?.[0]?.model?.trim() ?? null;
  } catch {
    cpu = null;
  }
  cached = deriveMachineId(["fallback", os.hostname(), os.platform(), os.arch(), cpu]);
  return cached;
}

/** Test seam — drop the memoised value. */
export function resetMachineIdCache(): void {
  cached = null;
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
