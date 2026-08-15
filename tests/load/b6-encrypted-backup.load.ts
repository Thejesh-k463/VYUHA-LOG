import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "../helpers/temp-db";
import { report, time } from "./helpers/measure";

/**
 * B6 — the encrypted-backup restore path.
 *
 * An encrypted backup is sealed with scrypt at N=2^17 (~134 MB, synchronous,
 * hundreds of ms). The restore flow in `components/system/backup-panel.tsx`
 * is two requests to `app/api/backup/route.ts` — `preview` then `restore` —
 * and each one calls `previewBackup()`, which derives the key again. So one
 * user restore is TWO full derivations, back to back, with the same password
 * against the same salt. The event loop is blocked for both.
 *
 * Instrument: calls to `scryptSync` for the exact request pair the UI sends,
 * counted through a spy on the module the code imports. Wall time is
 * reported alongside so the decision log has the cost in milliseconds too.
 */

const scryptCalls = { n: 0 };
vi.mock("node:crypto", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:crypto")>();
  return {
    ...mod,
    scryptSync: (...args: Parameters<typeof mod.scryptSync>) => {
      scryptCalls.n++;
      return mod.scryptSync(...args);
    },
  };
});

// The route revalidates paths after a restore; outside a Next request that
// throws ("static generation store missing"), and it is not what is measured.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let t: TempDb;
let backup: typeof import("@/lib/backup");
let route: typeof import("@/app/api/backup/route");

beforeAll(async () => {
  process.env.VYUHA_VAULT_PROVIDER = "machine";
  t = await openTempDb("b6-encrypted", { seed: true });
  backup = await import("@/lib/backup");
  route = await import("@/app/api/backup/route");
});
afterAll(() => t?.cleanup());

const PASSWORD = "correct horse battery staple";

function post(body: unknown): Promise<Response> {
  return route.POST(new Request("http://localhost/api/backup", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
}

describe("B6 · encrypted backup: key derivations per restore", () => {
  it("derives the scrypt key once for the UI's preview + restore pair, not once per request", async () => {
    // Seal a small dump (the cost under test is the KDF, not the payload).
    const dump = backup.dumpDatabase(false);
    scryptCalls.n = 0;
    const sealed = time("encryptBackup (one derivation)", 1, () => backup.encryptBackup(dump, PASSWORD));
    report(sealed, { test: "b6-seal", scryptCalls: scryptCalls.n });
    expect(scryptCalls.n).toBe(1);
    const encrypted = backup.encryptBackup(dump, PASSWORD);

    // Exactly what backup-panel.tsx sends: preview, then restore.
    scryptCalls.n = 0;
    let previewRes: Response | null = null;
    let restoreRes: Response | null = null;
    const t0 = performance.now();
    previewRes = await post({ action: "preview", dump: encrypted, password: PASSWORD });
    const tPreview = performance.now() - t0;
    const t1 = performance.now();
    restoreRes = await post({ action: "restore", dump: encrypted, password: PASSWORD });
    const tRestore = performance.now() - t1;
    const derivations = scryptCalls.n;

    report(time("preview request", 1, () => {}), { test: "b6-preview", ms: tPreview });
    report(time("restore request", 1, () => {}), { test: "b6-restore", ms: tRestore, scryptCallsForPair: derivations });
    console.log(`    preview ${tPreview.toFixed(0)} ms · restore ${tRestore.toFixed(0)} ms · scryptSync calls for the pair: ${derivations}`);

    expect(previewRes.status, await previewRes.text()).toBe(200);
    expect(restoreRes.status).toBe(200);
    expect(((await restoreRes.json()) as { ok: boolean }).ok).toBe(true);
    expect(
      derivations,
      `${derivations} scrypt derivations for one restore — preview and restore each re-derive the same key from the same password and salt (N=2^17, ~134 MB, synchronous).`,
    ).toBeLessThanOrEqual(1);
  });

  it("a wrong password still derives (no oracle shortcut) and is refused", async () => {
    const dump = backup.dumpDatabase(false);
    const encrypted = backup.encryptBackup(dump, PASSWORD);
    scryptCalls.n = 0;
    const res = await post({ action: "preview", dump: encrypted, password: "not the password" });
    expect(res.status).toBe(400);
    expect(scryptCalls.n).toBe(1);
    // And the right password afterwards is not confused by the wrong attempt.
    const ok = await post({ action: "preview", dump: encrypted, password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it("two envelopes sealed with the same password still derive twice (different salts)", () => {
    const encrypted = backup.encryptBackup(backup.dumpDatabase(false), PASSWORD);
    // Any reuse must be per (salt, params, password), never per password alone.
    const other = backup.encryptBackup(backup.dumpDatabase(false), PASSWORD);
    scryptCalls.n = 0;
    backup.decryptBackup(encrypted, PASSWORD);
    backup.decryptBackup(other, PASSWORD);
    expect(scryptCalls.n).toBe(2);
  });
});
