import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import {
  isVaultCiphertext, parseVaultString, formatVaultString, validateVaultKeyFile, VAULT_PREFIX,
} from "@/lib/vault-format";

/**
 * Secrets at rest (v2.99.80). The claims under test, in order of importance:
 *
 *   1. a secret round-trips through the vault and the DB column holds
 *      CIPHERTEXT, not the secret;
 *   2. pre-vault plaintext still reads, and the sweep upgrades it in place;
 *   3. a vault this machine cannot open degrades to an honest "re-enter your
 *      key" — never a crash, never a silent plaintext downgrade;
 *   4. tampered ciphertext is rejected (GCM), not decrypted into garbage.
 *
 * VYUHA_VAULT_PROVIDER=machine pins the KDF wrap so the suite behaves the
 * same on Windows, macOS and CI; one win32-only test exercises DPAPI.
 * ONE temp database per FILE (see tests/helpers/temp-db.ts).
 */

process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let vault: typeof import("@/lib/vault");
let vaultKeyFile: string;

beforeAll(async () => {
  t = await openTempDb("vault", { seed: true });
  vault = await import("@/lib/vault");
  vaultKeyFile = (await import("@/lib/db")).vaultKeyFile;
});
afterAll(() => t?.cleanup());

beforeEach(() => {
  vault.resetVaultCache();
  vault.resetSweepFlag();
});

describe("the envelope (pure)", () => {
  it("round-trips through format/parse and rejects malformed strings", () => {
    const s = formatVaultString("aGVsbG8", "d29ybGQ", "dGFn");
    expect(isVaultCiphertext(s)).toBe(true);
    expect(parseVaultString(s)).toEqual({ v: 1, iv: "aGVsbG8", ciphertext: "d29ybGQ", tag: "dGFn" });
    for (const bad of [`${VAULT_PREFIX}1:only:two`, `${VAULT_PREFIX}x:a:b:c`, `${VAULT_PREFIX}1:a:b:$!`, "plain"]) {
      expect(parseVaultString(bad)).toBeNull();
    }
  });

  it("validates the key file and refuses a newer version rather than misreading it", () => {
    expect(validateVaultKeyFile({ vyuhaVault: true, v: 1, provider: "machine", salt: "s", wrapped: "w", iv: "i", tag: "t" }).ok).toBe(true);
    expect(validateVaultKeyFile({ vyuhaVault: true, v: 99, provider: "machine", salt: "s", wrapped: "w" }).ok).toBe(false);
    expect(validateVaultKeyFile({ vyuhaVault: true, v: 1, provider: "machine", salt: "s", wrapped: "w" }).ok).toBe(false); // missing iv/tag
    expect(validateVaultKeyFile({}).ok).toBe(false);
  });
});

describe("encrypt / read", () => {
  it("round-trips a secret, and what the column holds is ciphertext", () => {
    const enc = vault.encryptSecret("VYUHA-super-secret");
    expect(isVaultCiphertext(enc)).toBe(true);
    expect(enc).not.toContain("super-secret");
    const read = vault.readSecret(enc);
    expect(read).toEqual({ ok: true, value: "VYUHA-super-secret", wasPlaintext: false });
  });

  it("two encryptions of one secret differ (fresh IV) yet both read back", () => {
    const a = vault.encryptSecret("same");
    const b = vault.encryptSecret("same");
    expect(a).not.toBe(b);
    expect(vault.readSecret(a)).toMatchObject({ ok: true, value: "same" });
    expect(vault.readSecret(b)).toMatchObject({ ok: true, value: "same" });
  });

  it("pre-vault plaintext passes through, flagged for the sweep", () => {
    expect(vault.readSecret("legacy-token")).toEqual({ ok: true, value: "legacy-token", wasPlaintext: true });
    expect(vault.readSecret(null)).toEqual({ ok: true, value: "", wasPlaintext: true });
  });

  it("tampered ciphertext is rejected, never decrypted into something else", () => {
    const enc = vault.encryptSecret("integrity");
    const parts = enc.split(":");
    // flip one character of the ciphertext body
    parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
    const read = vault.readSecret(parts.join(":"));
    expect(read.ok).toBe(false);
  });

  it("vault.key was created beside the DB with the forced provider", () => {
    vault.encryptSecret("touch"); // ensures the DEK exists
    const file = JSON.parse(fs.readFileSync(vaultKeyFile, "utf8"));
    expect(validateVaultKeyFile(file).ok).toBe(true);
    expect(file.provider).toBe("machine");
    expect(vault.vaultStatus()).toMatchObject({ ok: true, provider: "machine" });
  });
});

describe("the plaintext sweep", () => {
  it("upgrades plaintext licence + broker secrets in place, and is idempotent", () => {
    t.db.update(t.schema.settings).set({ licenseKey: "VYUHA-plain.key" }).run();
    t.db.insert(t.schema.brokerConnections).values({ accountId: 1, broker: "zerodha", apiKey: "plain-key", accessToken: "plain-token" }).run();

    vault.sweepPlaintextSecrets();

    const s = t.db.select().from(t.schema.settings).get()!;
    expect(isVaultCiphertext(s.licenseKey!)).toBe(true);
    expect(vault.readSecret(s.licenseKey)).toMatchObject({ ok: true, value: "VYUHA-plain.key" });

    const b = t.db.select().from(t.schema.brokerConnections).all()[0];
    expect(isVaultCiphertext(b.apiKey)).toBe(true);
    expect(isVaultCiphertext(b.accessToken)).toBe(true);
    expect(vault.readSecret(b.apiKey)).toMatchObject({ ok: true, value: "plain-key" });

    // Second sweep must not re-encrypt (ciphertexts would change if it did).
    vault.resetSweepFlag();
    vault.sweepPlaintextSecrets();
    const b2 = t.db.select().from(t.schema.brokerConnections).all()[0];
    expect(b2.apiKey).toBe(b.apiKey);
    expect(b2.accessToken).toBe(b.accessToken);
  });
});

describe("degradation — the vault another machine cannot open", () => {
  it("a replaced vault key leaves old ciphertexts unreadable, with a reason, not a crash", () => {
    const enc = vault.encryptSecret("old-machine-secret");

    // Simulate arriving on a new machine: the DB (with its venc values) came
    // along, the vault key did not — a fresh one is minted with a new DEK.
    fs.rmSync(vaultKeyFile);
    vault.resetVaultCache();

    const read = vault.readSecret(enc);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/does not decrypt/i);
    // New secrets still store fine under the new key.
    expect(vault.readSecret(vault.encryptSecret("new-machine-secret"))).toMatchObject({ ok: true, value: "new-machine-secret" });
  });

  it("a corrupt vault key file refuses writes loudly and reads softly", () => {
    fs.writeFileSync(vaultKeyFile, "not json at all");
    vault.resetVaultCache();

    expect(vault.vaultStatus().ok).toBe(false);
    expect(() => vault.encryptSecret("x")).toThrow(/Cannot store/i);
    const read = vault.readSecret(`${VAULT_PREFIX}1:aWl2aWl2aWl2aWl2:Y3Q:dGFn`);
    expect(read.ok).toBe(false);

    // Repair for the following tests: mint a fresh vault.
    fs.rmSync(vaultKeyFile);
    vault.resetVaultCache();
  });

  it("an encrypted licence the vault cannot open reads as unlicensed with an honest reason", async () => {
    const lic = await import("@/lib/queries/license");
    t.db.update(t.schema.settings).set({ licenseKey: vault.encryptSecret("VYUHA-not-a-real-key.sig") }).run();

    // New machine again.
    fs.rmSync(vaultKeyFile);
    vault.resetVaultCache();
    vault.resetSweepFlag();

    const status = lic.getLicenseStatus();
    expect(status.licensed).toBe(false);

    const ent = lic.getEntitlement();
    expect(ent.state === "licensed").toBe(false);
    expect(ent.reason).toMatch(/purchase email/i);
  });
});

describe.skipIf(process.platform !== "win32")("DPAPI (win32 only)", () => {
  /**
   * 60s, not vitest's default 5s. This is the ONE test in the suite that spawns
   * a real process — two cold `powershell.exe` starts (wrap, then unwrap) to
   * reach the OS DPAPI. On a warm dev machine that is well under a second; on a
   * cold GitHub windows-latest runner the two starts alone can exceed 5s, and
   * the release gate then fails with "Test timed out" on a test that is not
   * broken. That is exactly what happened on the v2.99.91 tag: macOS built and
   * published while the Windows job died here, leaving a release with no
   * Windows installer and a latest.json missing its windows-x86_64 entry.
   *
   * Do NOT "fix" a recurrence by skipping this on CI — proving the DPAPI
   * round-trip on a real Windows box is the entire point of the test, and CI is
   * the only Windows machine most contributors have.
   */
  it("wraps and unwraps the DEK through the OS", async () => {
    // A separate key path so the forced-machine vault above is untouched.
    const prev = process.env.VYUHA_VAULT_PROVIDER;
    delete process.env.VYUHA_VAULT_PROVIDER;
    fs.rmSync(vaultKeyFile, { force: true });
    vault.resetVaultCache();
    try {
      const enc = vault.encryptSecret("dpapi-bound");
      const file = JSON.parse(fs.readFileSync(vaultKeyFile, "utf8"));
      expect(file.provider).toBe("dpapi");
      vault.resetVaultCache(); // force a real unwrap round-trip via PowerShell
      expect(vault.readSecret(enc)).toMatchObject({ ok: true, value: "dpapi-bound" });
    } finally {
      process.env.VYUHA_VAULT_PROVIDER = prev;
      fs.rmSync(vaultKeyFile, { force: true });
      vault.resetVaultCache();
    }
  }, 60_000);
});
