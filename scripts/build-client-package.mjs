#!/usr/bin/env node
/**
 * Build a source-free client ZIP from one platform's installer.
 *
 *   node scripts/build-client-package.mjs                                   # Windows (the local NSIS build)
 *   node scripts/build-client-package.mjs --platform macos-apple-silicon --installer Vyuha_<ver>_aarch64.dmg
 *   node scripts/build-client-package.mjs --platform macos-intel         --installer Vyuha_<ver>_x64.dmg
 *
 * The DMGs come from the release draft (`gh release download v<ver> --pattern "*_aarch64.dmg"`,
 * `--pattern "*_x64.dmg"`); a Mac is never needed to package them. Names and the
 * START_HERE copy live in scripts/lib/client-package.mjs (owner ruling 2026-11-19:
 * one package per kind of computer, named so the buyer can tell which is theirs).
 */
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PLATFORM_IDS, checksumsText, installerMismatch, packageNames, platformOf, startHere } from "./lib/client-package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${name} needs a value.`);
  return args[i + 1];
};
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/build-client-package.mjs [--platform ${PLATFORM_IDS.join("|")}] [--installer PATH] [--license-file PATH] [--out DIRECTORY]`);
  console.log("  --platform   default windows. --installer is REQUIRED for the two macOS platforms (the DMG from the release draft);");
  console.log("               for windows it defaults to the local NSIS build, which must have its .sig beside it.");
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const platform = option("--platform") ?? "windows";
const platformInfo = platformOf(platform);
const installerOption = option("--installer");
if (platform !== "windows" && !installerOption) throw new Error(`--platform ${platform} needs --installer PATH (the DMG from the release draft, e.g. gh release download v${version} --pattern "${platformInfo.releaseAsset(version).replace(/^Vyuha_[^_]+/, "*")}").`);
const installerPath = installerOption
  ? path.resolve(installerOption)
  : path.join(root, "src-tauri", "target", "release", "bundle", "nsis", platformInfo.releaseAsset(version));
const signaturePath = platformInfo.hasSignature ? `${installerPath}.sig` : null;
const outputDir = path.resolve(option("--out") ?? path.join(root, "release-packages"));
const licensePath = option("--license-file");
const mismatch = installerMismatch(platform, path.basename(installerPath));
if (mismatch) throw new Error(mismatch);
if (!existsSync(installerPath) || (signaturePath && !existsSync(signaturePath))) {
  throw new Error(`${signaturePath ? "Signed installer" : "Installer"} not found.${platform === "windows" && !installerOption ? " Run npm run desktop:build first." : ""}\nExpected: ${installerPath}${signaturePath ? ` (and ${path.basename(signaturePath)} beside it)` : ""}`);
}

let license = null;
if (licensePath) {
  license = readFileSync(path.resolve(licensePath), "utf8").trim();
  if (!/^VYUHA-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(license)) throw new Error("--license-file does not contain one valid VYUHA-… key.");
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const local = [];
  const central = [];
  const now = new Date();
  const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const deflated = deflateRawSync(raw, { level: 9 });
    const method = deflated.length < raw.length ? 8 : 0;
    const body = method === 8 ? deflated : raw;
    const crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(method, 8);
    header.writeUInt16LE(dosTime, 10); header.writeUInt16LE(dosDate, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, body);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(method, 10); directory.writeUInt16LE(dosTime, 12); directory.writeUInt16LE(dosDate, 14); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(raw.length, 24); directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralData, end]);
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex").toUpperCase();
// The installer travels under a name that says which machine it is for; the
// source file keeps Tauri's name (the release asset the updater reads).
const { archiveName, installerName, signatureName } = packageNames({ version, platform, licensed: Boolean(license) });
const installer = readFileSync(installerPath);
const signature = signaturePath ? readFileSync(signaturePath) : null;
// START_HERE.md (generated by startHere in scripts/lib/client-package.mjs) carries
// the platform's install steps, the "Which package is mine?" block and the line
// "Connecting a broker's API? Open BROKER_API_SETUP_GUIDE.html".
const readme = startHere({ version, platform, licensed: Boolean(license) });
const checksums = checksumsText([
  { sha: sha256(installer), name: installerName },
  ...(signature ? [{ sha: sha256(signature), name: signatureName }] : []),
]);
const files = [
  { name: installerName, data: installer },
  ...(signature ? [{ name: signatureName, data: signature }] : []),
  { name: "START_HERE.md", data: readme },
  { name: "CHECKSUMS.txt", data: checksums },
];
// The buyer-facing docs travel INSIDE the package, read fresh from
// docs/client/ at build time — so the zip can never ship without the current
// "New in" notes, install guide and deck. (Added 2026-08-12 after the docs
// and the package drifted apart across four releases.)
const clientDocs = [
  ["docs/client/README.md", "WHATS_NEW.md"],
  ["docs/client/INSTALLATION_GUIDE.md", "INSTALLATION_GUIDE.md"],
  ["docs/client/GETTING_STARTED_DECK.html", "GETTING_STARTED_DECK.html"],
  // The OpenAlgo broker-connection guide, in both forms: the styled HTML for
  // reading on screen, and the Word twin (generated by npm run client:docx)
  // for buyers who print or annotate. Added 2026-08-29 with the OpenAlgo pull.
  ["docs/client/OPENALGO_SETUP_GUIDE.html", "OPENALGO_SETUP_GUIDE.html"],
  ["docs/client/OPENALGO_SETUP_GUIDE.docx", "OPENALGO_SETUP_GUIDE.docx"],
  // The DIRECT broker-API guide (Angel One SmartAPI, Dhan, Upstox, Kite), in
  // both forms, generated by the same npm run client:docx. Added 2026-09-21:
  // the direct-API steps existed only inside the app's Import Help cards, so a
  // buyer stuck on Angel One's "Add App" form had nothing in the package to
  // open.
  ["docs/client/BROKER_API_SETUP_GUIDE.html", "BROKER_API_SETUP_GUIDE.html"],
  ["docs/client/BROKER_API_SETUP_GUIDE.docx", "BROKER_API_SETUP_GUIDE.docx"],
  // The commercial paperwork. Added 2026-08-13: a ₹29,999 purchase shipped with
  // no refund policy, no terms and no privacy statement — the three documents a
  // buyer looks for before paying, and the three a disputed charge is settled
  // with. They travel IN the package so the copy a buyer holds always matches
  // the version they bought, exactly like the notes above.
  ["docs/client/REFUND_POLICY.md", "REFUND_POLICY.md"],
  ["docs/client/TERMS.md", "TERMS.md"],
  ["docs/client/PRIVACY.md", "PRIVACY.md"],
  // The open-source attribution file (v4.0). lightweight-charts is Apache-2.0 and
  // requires TradingView to be named on a surface the buyer can reach; the app
  // turns the on-canvas attribution logo OFF, so the obligation is met by this
  // file. It is bundled as a Tauri resource AND carried here, so a buyer who
  // only ever opens the ZIP still holds the notices.
  ["docs/client/THIRD-PARTY-NOTICES.txt", "THIRD-PARTY-NOTICES.txt"],
];
for (const [src, name] of clientDocs) {
  const p = path.join(root, src);
  if (!existsSync(p)) {
    console.error(`Missing ${src} — the client package must carry the current docs.`);
    process.exit(1);
  }
  files.push({ name, data: readFileSync(p) });
}
if (license) files.push({ name: "LICENSE.txt", data: `${license}\n` });
mkdirSync(outputDir, { recursive: true });
const archivePath = path.join(outputDir, archiveName);
if (existsSync(archivePath)) throw new Error(`Refusing to overwrite ${archivePath}. Move it, rename it, or choose --out.`);
writeFileSync(archivePath, createZip(files));
console.log(`✓ Client ZIP created: ${archivePath}`);
console.log(`  Contents: ${files.map((f) => f.name).join(", ")}`);
console.log(`  Installer SHA-256: ${sha256(installer)}`);
console.log(license ? "  Licence: included (do not forward this ZIP)." : "  Licence: not included — send a buyer-specific key separately.");
