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
 * ── The hash is NOT the local build's ───────────────────────────────────────
 *
 * This script used to hash the locally built installer, on the stated grounds
 * that it was "identical, since the same build produced both". IT IS NOT.
 * .github/workflows/release.yml REBUILDS the installer on its own runners via
 * tauri-action; `npm run desktop:build` produces a different binary that goes
 * into the client ZIP. Measured 2026-08-20: the v2.99.98 release asset is
 * 34,857,616 B against a local 34,857,374 B, and v2.99.99 is 34,861,983 B
 * against a local 34,860,149 B. Different bytes, therefore different SHA-256.
 *
 * Since InstallerUrl points at the GITHUB asset, hashing the local file emits a
 * manifest whose hash cannot match its own URL. winget-pkgs validation
 * downloads that URL and verifies the hash, so the PR is rejected — and if one
 * ever slipped through, `winget install` would fail for every user. `--sha` is
 * therefore REQUIRED, and must be the hash of the PUBLISHED asset.
 *
 * Usage:
 *   node scripts/winget-manifest.mjs --sha <SHA256>  # REQUIRED — see below
 *   node scripts/winget-manifest.mjs --sha <SHA256> --out <dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// The hash must be of the EXACT bytes PUBLISHED to the release, which are NOT
// the bytes of the local build — see the header. There is deliberately no
// local-file fallback: hashing whatever happens to be on this disk is how you
// get a manifest that fails validation, and a wrong hash is worse than a
// missing one because it looks finished.
const sha = opt("--sha")?.toUpperCase();
if (!sha) {
  console.error(`--sha is required: the SHA-256 of the PUBLISHED ${installerName}.`);
  console.error(``);
  console.error(`  It is NOT the hash of your local build — the release workflow rebuilds`);
  console.error(`  the installer on its own runners, so the two binaries differ.`);
  console.error(``);
  console.error(`  Get it with:`);
  console.error(`    gh release download v${version} --repo ${REPO} --pattern ${installerName} --dir .`);
  console.error(`    sha256sum ${installerName}`);
  console.error(``);
  console.error(`  Then: npm run winget:manifest -- --sha <SHA256>`);
  process.exit(1);
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
