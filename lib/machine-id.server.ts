import "server-only";

/**
 * Reads THIS computer's fingerprint. Server-only: it shells out to the Windows
 * registry, so `node:child_process` must never reach a client chunk.
 *
 * Split out of `machine-id.ts` after a production build failed with
 * "the chunking context does not support external modules (request:
 * node:child_process)" — lib/license.ts is imported by the Settings client
 * component, so its whole import graph has to stay browser-safe.
 */

import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { deriveMachineId } from "@/lib/machine-id";

/** Windows `MachineGuid`, or null anywhere it cannot be read. */
function windowsMachineGuid(): string | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "reg",
      // Backslashes MUST be escaped — "HKLM\SOFTWARE\..." collapses to
      // "HKLMSOFTWARE..." in a JS string literal and the query silently fails,
      // dropping every machine onto the weaker hostname fallback.
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"],
      { encoding: "utf8", timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * macOS `IOPlatformUUID` — the hardware UUID, burned into the logic board.
 *
 * The Windows counterpart of MachineGuid in every way that matters here: stable
 * across OS reinstalls and app reinstalls, unaffected by renaming the Mac or
 * changing network hardware. Read via `ioreg`, which needs no privileges.
 */
function macPlatformUuid(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Linux `/etc/machine-id` (systemd), falling back to the D-Bus copy.
 *
 * Written once at OS install. Read directly rather than shelled out — it is a
 * plain file, and spawning a process to `cat` it would be silly.
 */
function linuxMachineId(): string | null {
  if (process.platform !== "linux") return null;
  for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const v = fs.readFileSync(p, "utf8").trim();
      if (/^[0-9a-f]{32}$/i.test(v)) return v.toLowerCase();
    } catch {
      /* try the next one */
    }
  }
  return null;
}

let cached: string | null = null;

/**
 * This machine's ID. Computed once per process — the registry read is cheap but
 * there is no reason to repeat it on every entitlement check.
 */
export function getMachineId(): string {
  if (cached) return cached;

  // Each platform's strong identifier is namespaced with its own tag, so the
  // same 36-char string read on two platforms could never collide into one id.
  const guid = windowsMachineGuid();
  if (guid) {
    cached = deriveMachineId(["winguid", guid]);
    return cached;
  }

  const macUuid = macPlatformUuid();
  if (macUuid) {
    cached = deriveMachineId(["macuuid", macUuid]);
    return cached;
  }

  const linuxId = linuxMachineId();
  if (linuxId) {
    cached = deriveMachineId(["linuxid", linuxId]);
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
