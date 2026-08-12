#!/usr/bin/env node
/** Build a source-free client ZIP from the signed installer. */
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${name} needs a value.`);
  return args[i + 1];
};
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node scripts/build-client-package.mjs [--license-file PATH] [--out DIRECTORY]");
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const installerName = `Vyuha_${version}_x64-setup.exe`;
const installerPath = path.join(root, "src-tauri", "target", "release", "bundle", "nsis", installerName);
const signaturePath = `${installerPath}.sig`;
const outputDir = path.resolve(option("--out") ?? path.join(root, "release-packages"));
const licensePath = option("--license-file");
if (!existsSync(installerPath) || !existsSync(signaturePath)) throw new Error(`Signed installer not found. Run npm run desktop:build first.\nExpected: ${installerPath}`);

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
const installer = readFileSync(installerPath);
const signature = readFileSync(signaturePath);
const activation = license ? "Your individual activation key is included in LICENSE.txt. Keep it private and do not forward it." : "Your individual activation key is delivered separately by the vendor. Do not share it once received.";
const readme = [
  `# Vyuha ${version} — Client package`,
  "",
  "This package contains the official Windows installer only. It does not contain source code, your data, vendor signing keys, or any other customer's licence.",
  "",
  "## Install",
  `1. Run ${installerName} on Windows 10 or 11 (64-bit).`,
  "2. If Windows SmartScreen appears, choose More info → Run anyway only after verifying the installer checksum below.",
  "3. Open Vyuha, then go to Settings → License.",
  `4. ${activation}`,
  "",
  "## Licence and support",
  "The licence is signed by the vendor and verified locally; activation does not transmit trades or personal data. For support, quote the Key ID in Settings → License—never send the full key in a chat or screenshot.",
  "For a machine-bound licence, install first and send the Machine ID shown in Settings → License to the vendor. They will issue a key that activates on that computer only.",
  "",
  "## Integrity",
  "Compare the installer SHA-256 below before running it. The .sig file is the update signature for this installer and should stay alongside it when stored or published.",
  "",
  "## Honest security boundary",
  "This package contains no build source or vendor private keys. Signed licences deter sharing, and machine-bound keys restrict normal use to one computer — Windows, macOS and Linux fingerprints are all supported. Like any offline desktop software, copying or reverse engineering cannot be made mathematically impossible.",
  "",
  "Vyuha is a record-keeping and analytics product, not investment advice.",
  "",
].join("\n");
const checksums = ["# SHA-256 checksums", `${sha256(installer)}  ${installerName}`, `${sha256(signature)}  ${installerName}.sig`, ""].join("\n");
const files = [{ name: installerName, data: installer }, { name: `${installerName}.sig`, data: signature }, { name: "START_HERE.md", data: readme }, { name: "CHECKSUMS.txt", data: checksums }];
// The buyer-facing docs travel INSIDE the package, read fresh from
// docs/client/ at build time — so the zip can never ship without the current
// "New in" notes, install guide and deck. (Added 2026-08-12 after the docs
// and the package drifted apart across four releases.)
const clientDocs = [
  ["docs/client/README.md", "WHATS_NEW.md"],
  ["docs/client/INSTALLATION_GUIDE.md", "INSTALLATION_GUIDE.md"],
  ["docs/client/GETTING_STARTED_DECK.html", "GETTING_STARTED_DECK.html"],
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
const archiveName = `Vyuha_${version}_Client_Package${license ? "_Licensed" : ""}.zip`;
const archivePath = path.join(outputDir, archiveName);
if (existsSync(archivePath)) throw new Error(`Refusing to overwrite ${archivePath}. Move it, rename it, or choose --out.`);
writeFileSync(archivePath, createZip(files));
console.log(`✓ Client ZIP created: ${archivePath}`);
console.log(`  Contents: ${files.map((f) => f.name).join(", ")}`);
console.log(`  Installer SHA-256: ${sha256(installer)}`);
console.log(license ? "  Licence: included (do not forward this ZIP)." : "  Licence: not included — send a buyer-specific key separately.");
