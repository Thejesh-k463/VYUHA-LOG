import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, verify, createPublicKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { licenseKeyId } from "@/lib/license";
import { skuById, upgradeCredit } from "@/lib/domain/pricing";
import {
  mintKey, ledgerLine, appendLedger, readLedger, archiveKey, archiveFileName, keyIdOf,
} from "../scripts/lib/license-mint.mjs";
import { readLifetimeLaunchPrice, upgradeDue } from "../scripts/lib/upgrade-credit.mjs";

/**
 * Everything here runs against a THROWAWAY keypair, ledger and revocation
 * files in a temp dir — the env overrides VYUHA_LICENSE_PEM /
 * VYUHA_LICENSE_LEDGER / VYUHA_REVOKED_MJS / VYUHA_LICENSE_TS exist for exactly
 * this. The real license-private.pem and ledger are never opened.
 */

const root = process.cwd();
let tmp: string;
let pemPath: string;
let ledgerPath: string;
let pubPem: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-upgrade-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  pemPath = path.join(tmp, "test-private.pem");
  fs.writeFileSync(pemPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  ledgerPath = path.join(tmp, "ledger.jsonl");
  // Throwaway copies of the two files license-revoke.mjs rewrites.
  const revokedCopy = path.join(tmp, "license-revoked.mjs");
  const libCopy = path.join(tmp, "license.ts");
  fs.copyFileSync(path.join(root, "scripts", "license-revoked.mjs"), revokedCopy);
  fs.copyFileSync(path.join(root, "lib", "license.ts"), libCopy);
  env = {
    ...process.env,
    VYUHA_LICENSE_PEM: pemPath,
    VYUHA_LICENSE_LEDGER: ledgerPath,
    VYUHA_REVOKED_MJS: revokedCopy,
    VYUHA_LICENSE_TS: libCopy,
    VYUHA_KEY_ARCHIVE_DIR: "",
  };
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(script: string, args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    encoding: "utf8",
    env: { ...env, ...extraEnv },
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

function keyVerifies(key: string) {
  const m = /^VYUHA-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(key.trim());
  if (!m) return null;
  const payload = Buffer.from(m[1], "base64url");
  const ok = verify(null, payload, createPublicKey(pubPem), Buffer.from(m[2], "base64url"));
  return ok ? JSON.parse(payload.toString("utf8")) : null;
}

describe("scripts/lib/license-mint.mjs", () => {
  it("mints a key that verifies and whose id equals lib/license.ts#licenseKeyId", () => {
    const { key, keyId, payload } = mintKey({ email: "a@b.com", sku: "app", expires: "2027-01-01", machine: "ABCD-EF12-3456", pemPath });
    expect(keyVerifies(key)).toEqual(payload);
    expect(payload).toEqual({ email: "a@b.com", sku: "app", issued: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), expires: "2027-01-01", machine: "ABCD-EF12-3456" });
    expect(keyId).toBe(licenseKeyId(key));
    expect(keyIdOf(key)).toBe(keyId);
  });

  it("a lifetime key carries no expires field at all", () => {
    const { payload } = mintKey({ email: "a@b.com", sku: "app", pemPath });
    expect("expires" in payload).toBe(false);
    expect("machine" in payload).toBe(false);
  });

  it("ledger shape is frozen and round-trips through append/read", () => {
    const p = path.join(tmp, "shape.jsonl");
    const line = ledgerLine({ keyId: "AAAA-BBBB-CC", email: "a@b.com", sku: "app", issued: "2026-08-15", key: "VYUHA-x.y" });
    expect(Object.keys(line)).toEqual(["keyId", "email", "sku", "issued", "expires", "machine", "key", "note"]);
    expect(line.expires).toBeNull();
    appendLedger(p, line);
    appendLedger(p, { ...line, keyId: "AAAA-BBBB-CD" });
    expect(readLedger(p).map((r: { keyId: string }) => r.keyId)).toEqual(["AAAA-BBBB-CC", "AAAA-BBBB-CD"]);
    expect(readLedger(path.join(tmp, "missing.jsonl"))).toEqual([]);
  });

  it("archives the key with the key alone on line 1 and refuses to overwrite", () => {
    const dir = path.join(tmp, "archive-unit");
    const rec = ledgerLine({ keyId: "AAAA-BBBB-CC", email: "buyer@x.co.in", sku: "app", issued: "2026-08-15", key: "VYUHA-x.y", note: "UTR 1" });
    const { keyFile, snapshot } = archiveKey({ dir, record: rec, ledgerPath: path.join(tmp, "shape.jsonl"), today: new Date("2026-08-15T10:00:00Z") });
    expect(path.basename(keyFile)).toBe("AAAA-BBBB-CC_buyer_x_co_in.txt");
    expect(archiveFileName("AAAA-BBBB-CC", "buyer@x.co.in")).toBe("AAAA-BBBB-CC_buyer_x_co_in.txt");
    const lines = fs.readFileSync(keyFile, "utf8").split("\n");
    expect(lines[0]).toBe("VYUHA-x.y");
    expect(lines.join("\n")).toContain("note   : UTR 1");
    expect(path.basename(snapshot)).toBe("license-ledger.2026-08-15.jsonl");
    expect(fs.existsSync(snapshot)).toBe(true);
    expect(() => archiveKey({ dir, record: rec, ledgerPath: path.join(tmp, "shape.jsonl") })).toThrow(/Refusing to overwrite/);
  });
});

describe("upgrade arithmetic — one rule, pinned in two languages", () => {
  it("full credit within the year: due = lifetime launch − paid", () => {
    expect(upgradeCredit({ lifetime: 29999, paidForYear: 9999 })).toEqual({ credit: 9999, due: 20000 });
    expect(upgradeDue(29999, 9999)).toEqual({ credit: 9999, due: 20000 });
    // capped: never a negative amount due
    expect(upgradeCredit({ lifetime: 100, paidForYear: 150 })).toEqual({ credit: 100, due: 0 });
    expect(upgradeDue(100, 150)).toEqual({ credit: 100, due: 0 });
    expect(() => upgradeCredit({ lifetime: 0, paidForYear: 1 })).toThrow();
    expect(() => upgradeDue(29999, -1)).toThrow();
  });

  it("the .mjs reads the same lifetime launch price the TS module exports", () => {
    expect(readLifetimeLaunchPrice()).toBe(skuById("lifetime").amountInr);
    expect(() => readLifetimeLaunchPrice(path.join(root, "package.json"))).toThrow(/Could not find/);
  });
});

describe("scripts/license-issue.mjs --save-dir", () => {
  it("archives the minted key and refuses to overwrite on a second identical mint", () => {
    const dir = path.join(tmp, "archive-issue");
    const a = run("license-issue.mjs", ["issue@x.com", "app", "--years", "1", "--save-dir", dir], { VYUHA_LICENSE_NOTE: "UTR 42" });
    expect(a.status, a.err).toBe(0);
    const payload = keyVerifies(a.out);
    expect(payload?.email).toBe("issue@x.com");
    expect(a.err).toContain("archive: ");
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.endsWith("_issue_x_com.txt"))).toBe(true);
    expect(files.some((f) => /^license-ledger\.\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))).toBe(true);
    // Same email, same day → same key → same id → the archive refuses, the ledger still gets its line.
    const before = readLedger(ledgerPath).length;
    const b = run("license-issue.mjs", ["issue@x.com", "app", "--years", "1", "--save-dir", dir], { VYUHA_LICENSE_NOTE: "UTR 42" });
    expect(b.status).toBe(0);
    expect(b.err).toContain("Refusing to overwrite");
    expect(readLedger(ledgerPath).length).toBe(before + 1);
  });

  it("still refuses without a term or a payment reference", () => {
    expect(run("license-issue.mjs", ["x@y.com", "app"], { VYUHA_LICENSE_NOTE: "UTR" }).status).toBe(1);
    expect(run("license-issue.mjs", ["x@y.com", "app", "--years", "1"]).status).toBe(1);
  });
});

describe("scripts/license-upgrade.mjs", () => {
  let annualId: string;
  beforeAll(() => {
    const r = run("license-issue.mjs", ["up@x.com", "app", "--years", "1", "--machine", "ABCD-EF12-3456"], { VYUHA_LICENSE_NOTE: "UTR 100, ₹9,999" });
    expect(r.status, r.err).toBe(0);
    annualId = licenseKeyId(r.out);
    // A lifetime buyer and an expired annual buyer for the refusal cases.
    run("license-issue.mjs", ["life@x.com", "app", "--lifetime"], { VYUHA_LICENSE_NOTE: "UTR 200" });
    run("license-issue.mjs", ["old@x.com", "app", "--expires", "2020-01-01"], { VYUHA_LICENSE_NOTE: "UTR 300" });
  });

  it("dry run quotes lifetime − paid and writes nothing", () => {
    const before = readLedger(ledgerPath).length;
    const r = run("license-upgrade.mjs", ["up@x.com", "--paid", "9999"]);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toContain("DRY RUN");
    expect(r.err).toContain(`annual key     : ${annualId}`);
    const lifetime = skuById("lifetime").amountInr;
    const due = lifetime - 9999;
    expect(r.err).toContain(`₹${lifetime.toLocaleString("en-IN")}`);
    expect(r.err).toContain(`AMOUNT DUE     : ₹${due.toLocaleString("en-IN")}`);
    expect(readLedger(ledgerPath).length).toBe(before);
  });

  it("refuses: expired, already lifetime, no --paid, --confirm without a reference", () => {
    const expired = run("license-upgrade.mjs", ["old@x.com", "--paid", "9999"]);
    expect(expired.status).toBe(1);
    expect(expired.err).toMatch(/expired .* list price/);
    const life = run("license-upgrade.mjs", ["life@x.com", "--paid", "9999"]);
    expect(life.status).toBe(1);
    expect(life.err).toContain("already a LIFETIME");
    expect(run("license-upgrade.mjs", ["up@x.com"]).status).toBe(1);
    const noRef = run("license-upgrade.mjs", ["up@x.com", "--paid", "9999", "--confirm", ""]);
    expect(noRef.status).toBe(1);
    expect(noRef.err).toContain("payment reference");
    expect(run("license-upgrade.mjs", ["nobody@x.com", "--paid", "1"]).status).toBe(1);
  });

  it("--confirm mints a lifetime key for the same email + machine, notes the credit, revokes the old id", () => {
    const dir = path.join(tmp, "archive-upgrade");
    const r = run("license-upgrade.mjs", [annualId, "--paid", "9999", "--confirm", "UTR 999, ₹20,000 UPI", "--save-dir", dir]);
    expect(r.status, r.err).toBe(0);
    const payload = keyVerifies(r.out);
    expect(payload).toMatchObject({ email: "up@x.com", sku: "app", machine: "ABCD-EF12-3456" });
    expect("expires" in payload).toBe(false);
    const newId = licenseKeyId(r.out);
    const last = readLedger(ledgerPath).at(-1) as { keyId: string; expires: null; note: string; machine: string };
    expect(last.keyId).toBe(newId);
    expect(last.expires).toBeNull();
    expect(last.machine).toBe("ABCD-EF12-3456");
    expect(last.note).toBe(`upgrade from ${annualId}; annual paid ₹9,999 credited; UTR 999, ₹20,000 UPI`);
    // Archived
    expect(fs.readdirSync(dir).some((f) => f.startsWith(newId))).toBe(true);
    // Old key revoked in BOTH throwaway files, via license-revoke.mjs
    expect(fs.readFileSync(env.VYUHA_REVOKED_MJS!, "utf8")).toContain(`"${annualId}"`);
    expect(fs.readFileSync(env.VYUHA_LICENSE_TS!, "utf8")).toMatch(new RegExp(`REVOKED_KEY_IDS: readonly string\\[\\] = \\[\\s*"${annualId}",\\s*\\]`));
    // The real files were not touched
    expect(fs.readFileSync(path.join(root, "lib", "license.ts"), "utf8")).not.toContain(annualId);
    // Publish commands printed
    expect(r.err).toContain(`revocation-publish.mjs --add ${annualId} --message "Upgraded to lifetime — use your new key"`);
    expect(r.err).toContain("gh release upload revocations");
  });

  it("an email with two annual keys must be named by id", () => {
    run("license-issue.mjs", ["two@x.com", "app", "--years", "1"], { VYUHA_LICENSE_NOTE: "UTR a" });
    run("license-issue.mjs", ["two@x.com", "app", "--years", "2"], { VYUHA_LICENSE_NOTE: "UTR b" });
    const r = run("license-upgrade.mjs", ["two@x.com", "--paid", "9999"]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("name the key id");
  });
});
