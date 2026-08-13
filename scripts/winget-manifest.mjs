#!/usr/bin/env node
/**
 * Generate the winget manifest set for a published release.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The Windows installer is not code-signed — a deliberate, recorded owner
 * decision (docs/owner/CODE_SIGNING.md, 2026-08-11). The cost of that decision
 * is documented in the same file and is worse than it first looks:
 *
 *   SmartScreen reputation accrues PER FILE HASH.
 *
 * So every release starts cold no matter how many people installed the last
 * one — and this project has shipped 53 tags in six days. The release cadence
 * actively defeats the only free mitigation available.
 *
 * `winget install` fetches without the browser's mark-of-the-web, so a user who
 * installs that way never meets the SmartScreen interstitial at all. A listing
 * in Microsoft's own repository (manifests are validated and binaries scanned
 * on submission) also reads as legitimacy in itself. It is the highest-value
 * thing a ₹0 signing budget can buy.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────
 *
 * It does not publish. Publishing means a pull request to
 * github.com/microsoft/winget-pkgs, which is a human-reviewed external repo.
 * This writes correct manifests and prints the exact command; you press send.
 *
 * Usage:
 *   node scripts/winget-manifest.mjs                 # uses the local built installer
 *   node scripts/winget-manifest.mjs --sha <SHA256>  # if you only have the hash
 *   node scripts/winget-manifest.mjs --out <dir>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

/** Publisher.Package — this is the id users type. It must never change. */
const PACKAGE_ID = "ThejeshK.Vyuha";
const REPO = "Thejesh-k463/VYUHA-LOG";
const installerName = `Vyuha_${version}_x64-setup.exe`;
const installerUrl = `https://github.com/${REPO}/releases/download/v${version}/${installerName}`;

// The hash must be of the EXACT bytes published to the release. Prefer the
// local artefact (identical, since the same build produced both) but allow a
// hash to be passed for a release built elsewhere.
let sha = opt("--sha")?.toUpperCase();
if (!sha) {
  const local = path.join(root, "src-tauri", "target", "release", "bundle", "nsis", installerName);
  if (!existsSync(local)) {
    console.error(`No installer at ${local}, and no --sha given.`);
    console.error(`Run: npm run desktop:build   (or pass --sha <SHA256> from the release page)`);
    process.exit(1);
  }
  sha = createHash("sha256").update(readFileSync(local)).digest("hex").toUpperCase();
}
if (!/^[0-9A-F]{64}$/.test(sha)) {
  console.error(`--sha must be 64 hex characters (got ${sha.length}).`);
  process.exit(1);
}

const outDir = path.resolve(opt("--out") ?? path.join(root, "release-packages", "winget", version));
mkdirSync(outDir, { recursive: true });

const MANIFEST_VERSION = "1.6.0";
const files = {
  [`${PACKAGE_ID}.yaml`]: `# Created for Vyuha ${version}. Do not hand-edit — regenerate with
# node scripts/winget-manifest.mjs
PackageIdentifier: ${PACKAGE_ID}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${MANIFEST_VERSION}
`,

  [`${PACKAGE_ID}.installer.yaml`]: `PackageIdentifier: ${PACKAGE_ID}
PackageVersion: ${version}
InstallerLocale: en-US
InstallerType: nullsoft
Scope: user
UpgradeBehavior: install
ReleaseDate: ${new Date().toISOString().slice(0, 10)}
Installers:
  - Architecture: x64
    InstallerUrl: ${installerUrl}
    InstallerSha256: ${sha}
ManifestType: installer
ManifestVersion: ${MANIFEST_VERSION}
`,

  [`${PACKAGE_ID}.locale.en-US.yaml`]: `PackageIdentifier: ${PACKAGE_ID}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: Thejesh K
PublisherUrl: https://github.com/${REPO}
PublisherSupportUrl: https://github.com/${REPO}/issues
PackageName: Vyuha
PackageUrl: https://github.com/${REPO}
License: Proprietary
Copyright: Copyright (c) ${new Date().getFullYear()} Thejesh K
ShortDescription: A fully offline trade journal and analytics cockpit for Indian retail traders.
Description: |-
  Vyuha is a local-first trading journal and analytics cockpit built for the
  Indian market. It recomputes every charge — brokerage, STT/CTT, exchange,
  SEBI, stamp duty and GST — from your broker's own rate card rather than
  estimating them, and turns that into honest P&L, tax packs and risk analytics.

  Imports from six brokers auto-detect (Zerodha, Dhan, Groww, Angel One, Upstox,
  Paytm Money); any other broker's CSV or XLSX goes through a column mapper.
  Everything is stored in a single SQLite file on your own machine — no account,
  no cloud, no telemetry.

  The core journal is free forever. A licence unlocks the analytics layer.
Moniker: vyuha
Tags:
  - trading
  - journal
  - india
  - nse
  - finance
  - analytics
ManifestType: defaultLocale
ManifestVersion: ${MANIFEST_VERSION}
`,
};

for (const [name, body] of Object.entries(files)) {
  writeFileSync(path.join(outDir, name), body);
}

console.log(`✓ winget manifests for ${version} → ${outDir}`);
console.log(`  installer : ${installerUrl}`);
console.log(`  sha256    : ${sha}`);
console.log(`\n  Publish (needs the release to be PUBLIC and the URL live):`);
console.log(`    wingetcreate submit --token <gh-token> "${outDir}"`);
console.log(`  or open a PR adding these three files to`);
console.log(`    microsoft/winget-pkgs → manifests/t/ThejeshK/Vyuha/${version}/`);
console.log(`\n  First submission is reviewed by hand and can take a few days.`);
console.log(`  After it lands, the install command in your purchase email becomes:`);
console.log(`    winget install ${PACKAGE_ID}`);
console.log(`  — which fetches without the mark-of-the-web, so no SmartScreen prompt.`);
