#!/usr/bin/env node
/**
 * Full off-device backup of everything a disk failure would otherwise take:
 *
 *   repo.bundle        git bundle --all (every branch + all tags, verified)
 *   secrets/           .secrets  (updater keypair, license-private.pem, ledger)
 *   key-archive/       VYUHA_KEY_ARCHIVE_DIR (per-sale key files)
 *   vkb/               T:\Thejesh\vyuha-key-backups (.vkb bundles)
 *   private-fixtures/  tests/fixtures/private (real broker exports — irreplaceable)
 *   client-packages/   release-packages ZIPs + revocations.json
 *   app-data/          %APPDATA%/in.vyuha.tradejournal (the LIVE journal)
 *   MANIFEST.txt       sizes + SHA-256 of every copied file
 *
 * Usage:  npm run backup:drive -- E:\
 *
 * The target must NOT be C:, K: or T: — those are partitions of the ONE
 * physical NVMe (VYUHA-STATE §8.1); a same-disk "backup" dies with the disk.
 * (--allow-same-disk exists only so the test suite can point at a temp dir.)
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SAME_DISK = new Set(["C", "K", "T"]);
const repoRoot = path.resolve(import.meta.dirname, "..");

const args = process.argv.slice(2);
const allowSameDisk = args.includes("--allow-same-disk");
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("Usage: npm run backup:drive -- <drive-or-folder>   e.g.  npm run backup:drive -- E:\\");
  process.exit(1);
}
const targetRoot = path.resolve(target);
const letter = path.parse(targetRoot).root.slice(0, 1).toUpperCase();
if (SAME_DISK.has(letter) && !allowSameDisk) {
  console.error(
    `${letter}: is a partition of the same physical NVMe as the originals — a backup there dies with the disk.\n` +
      "Plug in the external drive and pass its letter."
  );
  process.exit(1);
}
if (!fs.existsSync(path.parse(targetRoot).root)) {
  console.error(`${targetRoot} is not reachable — is the drive plugged in?`);
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 10);
let dest = path.join(targetRoot, `vyuha-full-backup-${stamp}`);
for (let i = 0; fs.existsSync(dest); i++) dest = path.join(targetRoot, `vyuha-full-backup-${stamp}-${String.fromCharCode(98 + i)}`);
fs.mkdirSync(dest, { recursive: true });

const appData = path.join(process.env.APPDATA ?? "", "in.vyuha.tradejournal");
const keyArchive = process.env.VYUHA_KEY_ARCHIVE_DIR ?? "";
const sources = [
  { name: "secrets", from: path.join(repoRoot, ".secrets"), required: true },
  { name: "private-fixtures", from: path.join(repoRoot, "tests", "fixtures", "private"), required: true },
  { name: "app-data", from: appData, required: true },
  { name: "key-archive", from: keyArchive, required: false },
  { name: "vkb", from: "T:\\Thejesh\\vyuha-key-backups", required: false },
];

// The live journal must not be mid-write while we copy it.
try {
  const list = execFileSync("tasklist", ["/FI", "IMAGENAME eq vyuha.exe", "/NH"], { encoding: "utf8" });
  if (/vyuha\.exe/i.test(list)) {
    console.error("Vyuha is running — close it first so the journal database is not copied mid-write.");
    process.exit(1);
  }
} catch {
  /* tasklist unavailable (non-Windows test) — proceed */
}

console.log(`Backing up to ${dest}\n`);

console.log("[1/4] repo.bundle (all branches + tags)");
const bundle = path.join(dest, "repo.bundle");
execFileSync("git", ["-C", repoRoot, "bundle", "create", bundle, "--all"], { stdio: "inherit" });
execFileSync("git", ["-C", repoRoot, "bundle", "verify", bundle], { stdio: "pipe" });
console.log("  bundle verified OK");

console.log("[2/4] directories");
for (const s of sources) {
  if (!s.from || !fs.existsSync(s.from)) {
    if (s.required) {
      console.error(`  MISSING required source: ${s.name} (${s.from})`);
      process.exit(1);
    }
    console.log(`  skip ${s.name} — not present (${s.from || "unset"})`);
    continue;
  }
  fs.cpSync(s.from, path.join(dest, s.name), { recursive: true });
  console.log(`  copied ${s.name}`);
}

console.log("[3/4] client packages");
const relDir = path.join(repoRoot, "release-packages");
const pkgDest = path.join(dest, "client-packages");
fs.mkdirSync(pkgDest, { recursive: true });
if (fs.existsSync(relDir)) {
  for (const f of fs.readdirSync(relDir)) {
    if (f.endsWith(".zip") || f === "revocations.json") fs.copyFileSync(path.join(relDir, f), path.join(pkgDest, f));
  }
}
console.log(`  ${fs.readdirSync(pkgDest).length} file(s)`);

console.log("[4/4] MANIFEST.txt (sizes + SHA-256)");
const lines = [`Vyuha full backup ${new Date().toISOString()}`, `source machine: ${process.env.COMPUTERNAME ?? "?"}`, ""];
let count = 0, bytes = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else {
      const buf = fs.readFileSync(p);
      lines.push(`${createHash("sha256").update(buf).digest("hex")}  ${buf.length}  ${path.relative(dest, p)}`);
      count++; bytes += buf.length;
    }
  }
};
walk(dest);
lines.push("", `${count} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
fs.writeFileSync(path.join(dest, "MANIFEST.txt"), lines.join("\n"));

console.log(`\nDONE — ${count} files, ${(bytes / 1024 / 1024).toFixed(1)} MB at ${dest}`);
console.log("Restore notes: git clone repo.bundle restored-repo; secrets/ goes back to .secrets/; app-data/ goes back to %APPDATA%\\in.vyuha.tradejournal.");
