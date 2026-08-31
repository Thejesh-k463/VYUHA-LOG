#!/usr/bin/env node
/**
 * Decode the minisign key id out of a release's .sig assets and compare it with
 * the pubkey baked into tauri.conf.json.
 *
 * WHY THIS EXISTS. The installers attached to a GitHub release are signed in CI
 * with the repo secret TAURI_SIGNING_PRIVATE_KEY — NOT with the local
 * `.secrets/vyuha-updater.key`. If that secret holds a different key, every step
 * still reports success: tauri logs a signature, the release looks complete, and
 * the failure only appears on users' machines, where the updater rejects the
 * update it cannot verify. That is not hypothetical — the key was rotated at
 * v2.91.0, the secret kept the pre-rotation key, and v2.98.0 shipped an update
 * no existing install would take.
 *
 * A local build proves nothing about the published artefacts. Run this against
 * the DRAFT release before pressing Publish.
 *
 * Usage:  gh auth login            (once)
 *         node scripts/verify-release-signatures.mjs v2.99.20
 */

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyMinisign, sigBlobOf, pubBlobOf } from "./minisign-verify.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const deep = argv.includes("--deep");
const tag = argv.find((a) => !a.startsWith("--"));
if (!tag) {
  console.error("usage: node scripts/verify-release-signatures.mjs <tag> [--deep]   e.g. v2.99.20 --deep");
  process.exit(2);
}

/** minisign blob = [algo(2) | key id(8, little-endian) | signature(64)] */
function keyIdOf(base64Line) {
  const blob = Buffer.from(base64Line, "base64");
  return Buffer.from(blob.subarray(2, 10)).reverse().toString("hex").toUpperCase();
}

function keyIdFromSigFile(text) {
  // A .sig asset is base64 of a two-line minisign file; line 1 is the blob.
  const inner = Buffer.from(text.trim(), "base64").toString("utf8");
  return keyIdOf(inner.split("\n")[1]);
}

const conf = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
const pubText = Buffer.from(conf.plugins.updater.pubkey, "base64").toString("utf8");
const expected = keyIdOf(pubText.split("\n")[1]);

console.log(`tauri.conf.json pubkey key id : ${expected}`);
console.log(`checking release ${tag} …\n`);

let assetsJson;
try {
  assetsJson = execFileSync("gh", ["release", "view", tag, "--json", "assets", "-R", "Thejesh-k463/VYUHA-LOG"], {
    encoding: "utf8",
  });
} catch {
  console.error("Could not read the release. Run `gh auth login` first — draft releases need auth.");
  process.exit(1);
}

const allAssets = JSON.parse(assetsJson).assets;
const assets = allAssets.filter((a) => a.name.endsWith(".sig"));
if (assets.length === 0) {
  console.error("No .sig assets on that release. Nothing to verify — do NOT publish.");
  process.exit(1);
}

/**
 * COMPLETENESS, checked before signatures.
 *
 * This script used to answer only "are the signatures present correct?", and
 * on v2.99.92 it printed "✓ Safe to publish" for a release whose Windows job
 * had failed — two macOS signatures verified, and no Windows installer existed
 * at all. Every signature it looked at was genuinely fine; the release was
 * still unshippable. A verifier that cannot see an ABSENT platform is worse
 * than none, because its ✓ reads as "complete".
 *
 * One entry per platform the release workflow's matrix builds.
 */
const REQUIRED = [
  { label: "Windows installer", match: (n) => /_x64-setup\.exe$/.test(n) },
  { label: "Windows signature", match: (n) => /_x64-setup\.exe\.sig$/.test(n) },
  { label: "macOS Apple silicon", match: (n) => /aarch64\.app\.tar\.gz$/.test(n) },
  { label: "macOS Intel", match: (n) => /_x64\.app\.tar\.gz$/.test(n) || /^Vyuha_x64\.app\.tar\.gz$/.test(n) },
  { label: "updater manifest", match: (n) => n === "latest.json" },
];
const names = allAssets.map((a) => a.name);
const missing = REQUIRED.filter((r) => !names.some((n) => r.match(n)));
if (missing.length > 0) {
  console.error(`✗ INCOMPLETE RELEASE — ${missing.length} expected artefact(s) absent. DO NOT PUBLISH.\n`);
  for (const m of missing) console.error(`  missing: ${m.label}`);
  console.error(`\n  present: ${names.join(", ") || "(nothing)"}`);
  console.error(`\n  A platform job failed. Check: gh run view <run-id> --log-failed`);
  console.error(`  Publishing now ships latest.json without that platform, and its users`);
  console.error(`  silently stop receiving updates — the updater fails open by design.`);
  process.exit(1);
}

// Scratch file for each downloaded .sig. It lives in the repo root because gh
// needs a concrete -O path, and it is removed in the `finally` below — an
// earlier version left it behind, and a later `git add -A` committed a
// signature blob into the repo as `.sigcheck.tmp`.
const tmp = path.join(root, ".sigcheck.tmp");
const tmpBin = path.join(root, ".sigcheck.bin.tmp");
let bad = 0;
let deepFailed = 0;
let deepChecked = 0;
try {
  for (const a of assets) {
    execFileSync("gh", ["release", "download", tag, "-p", a.name, "-O", tmp, "--clobber", "-R", "Thejesh-k463/VYUHA-LOG"]);
    const sigText = readFileSync(tmp, "utf8");
    const id = keyIdFromSigFile(sigText);
    const ok = id === expected;
    if (!ok) bad++;
    console.log(`${ok ? "✓" : "✗"} ${a.name.padEnd(46)} ${id}`);

    if (!deep || !ok) continue;

    // --deep: the key id was right, but does the signature actually verify over
    // the published bytes? That is the claim users' machines will test, and the
    // one v2.98.0 failed while every check above passed.
    const payloadName = a.name.replace(/\.sig$/, "");
    if (!names.includes(payloadName)) {
      console.error(`  ✗ ${payloadName} is not on the release — a .sig with no artefact.`);
      deepFailed++;
      continue;
    }
    execFileSync("gh", ["release", "download", tag, "-p", payloadName, "-O", tmpBin, "--clobber", "-R", "Thejesh-k463/VYUHA-LOG"]);
    const bytes = readFileSync(tmpBin);
    const res = verifyMinisign(pubBlobOf(conf.plugins.updater.pubkey), sigBlobOf(sigText), bytes);
    deepChecked++;
    const mb = (statSync(tmpBin).size / 1048576).toFixed(1);
    if (res.ok) {
      console.log(`  ✓ verifies over ${payloadName} (${mb} MB, ${res.prehashed ? "prehashed" : "pure"})`);
    } else {
      console.error(`  ✗ ${payloadName} (${mb} MB) — ${res.reason}`);
      deepFailed++;
    }
  }
} finally {
  rmSync(tmp, { force: true });
  rmSync(tmpBin, { force: true });
}

console.log("");
if (bad > 0) {
  console.error(`✗ ${bad} asset(s) signed with the WRONG key. DO NOT PUBLISH.`);
  console.error("  Fix the repo secret TAURI_SIGNING_PRIVATE_KEY (it must hold .secrets/vyuha-updater.key),");
  console.error("  delete the draft, and re-run the release workflow.");
  process.exit(1);
}
if (deepFailed > 0) {
  console.error(`✗ ${deepFailed} signature(s) did NOT verify over the published bytes. DO NOT PUBLISH.`);
  console.error("  The key id is right, so the signing key is fine — the ARTEFACT and its signature");
  console.error("  disagree. Something re-wrote or re-uploaded the asset after it was signed.");
  console.error("  Delete the draft and re-run the release workflow; do not re-upload by hand.");
  process.exit(1);
}
console.log("✓ every signature matches the pubkey shipped in the app.");
if (deep) {
  console.log(`✓ ${deepChecked} signature(s) cryptographically verified over the published bytes.`);
} else {
  console.log("  (key ids only — re-run with --deep to verify signatures over the actual binaries)");
}
console.log("Safe to publish.");
