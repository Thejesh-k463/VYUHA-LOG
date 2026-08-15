import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encryptBundle, decryptBundle, readBundleHeader, KEYBUNDLE_SCRYPT } from "../scripts/lib/keybundle.mjs";

/** Temp files only — the real .pem and ledger are never opened. */
const root = process.cwd();
let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-keybundle-")); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const files = [
  { name: "license-private.pem", data: Buffer.from("-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n") },
  { name: "license-ledger.jsonl", data: Buffer.from('{"keyId":"AAAA-BBBB-CC","email":"a@b.com"}\n') },
];

describe("scripts/lib/keybundle.mjs", () => {
  it("round-trips byte-for-byte and the header lists the files without the passphrase", () => {
    const bundle = encryptBundle(files, "correct horse");
    const { header } = readBundleHeader(bundle);
    expect(header).toMatchObject({ v: 1, kdf: "scrypt", N: KEYBUNDLE_SCRYPT.N, r: 8, p: 1 });
    expect(header.files).toEqual(files.map((f) => ({ name: f.name, size: f.data.length })));
    expect(typeof header.salt).toBe("string");
    expect(typeof header.iv).toBe("string");
    expect(typeof header.tag).toBe("string");
    // ciphertext does not contain the plaintext
    expect(bundle.includes(Buffer.from("not-a-real-key"))).toBe(false);
    const back = decryptBundle(bundle, "correct horse");
    expect(back.map((f: { name: string }) => f.name)).toEqual(files.map((f) => f.name));
    for (let i = 0; i < files.length; i++) expect(Buffer.compare(back[i].data, files[i].data)).toBe(0);
  });

  it("wrong passphrase, tampered body and tampered header all fail closed", () => {
    const bundle = encryptBundle(files, "pw");
    expect(() => decryptBundle(bundle, "PW")).toThrow(/wrong passphrase|altered/);
    const body = Buffer.from(bundle);
    body[body.length - 1] ^= 0xff;
    expect(() => decryptBundle(body, "pw")).toThrow(/altered/);
    // Swap a file name in the header: it is AAD, so the tag no longer verifies.
    const nl = bundle.indexOf(0x0a);
    const hdr = JSON.parse(bundle.subarray(0, nl).toString("utf8"));
    hdr.files[0].name = "something-else.pem";
    const forged = Buffer.concat([Buffer.from(JSON.stringify(hdr) + "\n"), bundle.subarray(nl + 1)]);
    expect(() => decryptBundle(forged, "pw")).toThrow(/altered/);
    expect(() => readBundleHeader(Buffer.from("garbage"))).toThrow(/not a \.vkb/);
    expect(() => encryptBundle(files, "")).toThrow(/passphrase/);
    expect(() => encryptBundle([], "pw")).toThrow(/no files/);
  });

  it("two bundles of the same content differ (fresh salt + iv)", () => {
    const a = encryptBundle(files, "pw");
    const b = encryptBundle(files, "pw");
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});

describe("scripts/license-backup.mjs", () => {
  function run(args: string[], extra: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, [path.join(root, "scripts", "license-backup.mjs"), ...args], {
      encoding: "utf8",
      env: { ...process.env, ...extra },
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  }

  it("bundles the (temp) pem + ledger, refuses to overwrite, inspects, restores, refuses to overwrite on restore", () => {
    const pem = path.join(tmp, "p.pem");
    const ledger = path.join(tmp, "l.jsonl");
    fs.writeFileSync(pem, files[0].data);
    fs.writeFileSync(ledger, files[1].data);
    const outDir = path.join(tmp, "backups");
    const envs = { VYUHA_LICENSE_PEM: pem, VYUHA_LICENSE_LEDGER: ledger, VYUHA_BACKUP_PASSPHRASE: "smoke pw" };

    const a = run([outDir], envs);
    expect(a.status, a.err).toBe(0);
    const made = fs.readdirSync(outDir).filter((f) => /^vyuha-keys-\d{4}-\d{2}-\d{2}\.vkb$/.test(f));
    expect(made).toHaveLength(1);
    const vkb = path.join(outDir, made[0]);

    const again = run([outDir], envs);
    expect(again.status).toBe(1);
    expect(again.err).toContain("Refusing to overwrite");

    const insp = run(["--inspect", vkb]);
    expect(insp.status).toBe(0);
    expect(insp.out).toContain("license-private.pem");
    expect(insp.out).toContain("license-ledger.jsonl");

    const restoreDir = path.join(tmp, "restored");
    const r = run(["--restore", vkb, "--out", restoreDir], { VYUHA_BACKUP_PASSPHRASE: "smoke pw" });
    expect(r.status, r.err).toBe(0);
    expect(fs.readFileSync(path.join(restoreDir, "license-private.pem"))).toEqual(files[0].data);
    expect(fs.readFileSync(path.join(restoreDir, "license-ledger.jsonl"))).toEqual(files[1].data);

    const r2 = run(["--restore", vkb, "--out", restoreDir], { VYUHA_BACKUP_PASSPHRASE: "smoke pw" });
    expect(r2.status).toBe(1);
    expect(r2.err).toContain("Refusing to overwrite");

    const bad = run(["--restore", vkb, "--out", path.join(tmp, "x")], { VYUHA_BACKUP_PASSPHRASE: "nope" });
    expect(bad.status).not.toBe(0);
  });

  it("no passphrase and no TTY → refuses rather than hangs", () => {
    const r = run([path.join(tmp, "nopass")], { VYUHA_LICENSE_PEM: path.join(tmp, "p.pem"), VYUHA_LICENSE_LEDGER: path.join(tmp, "l.jsonl"), VYUHA_BACKUP_PASSPHRASE: "" });
    expect(r.status).toBe(1);
    expect(r.err).toContain("No passphrase");
  });
});
