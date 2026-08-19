#!/usr/bin/env node
// Copy the current version's release artifacts out of the repo tree into an archive folder
// (an external drive / personal cloud folder), so a buyer can always be served even when
// GitHub Releases is down and the build machine is not at hand.
//
//   npm run release:archive -- D:\VyuhaArchive
//
// Copies, for the version in package.json: the NSIS installer + .sig, the MSI + .sig, the
// client ZIP, CHECKSUMS (recomputed here), and the winget manifest folder if present.
// Refuses to overwrite an existing version folder. Never touches keys or the ledger.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const dest = process.argv[2];
if (!dest) {
  console.error("usage: npm run release:archive -- <archive-dir>");
  process.exit(2);
}
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const out = path.join(dest, `Vyuha_${version}`);
if (existsSync(out)) {
  console.error(`refusing to overwrite ${out}`);
  process.exit(1);
}
const candidates = [
  `src-tauri/target/release/bundle/nsis/Vyuha_${version}_x64-setup.exe`,
  `src-tauri/target/release/bundle/nsis/Vyuha_${version}_x64-setup.exe.sig`,
  `src-tauri/target/release/bundle/msi/Vyuha_${version}_x64_en-US.msi`,
  `src-tauri/target/release/bundle/msi/Vyuha_${version}_x64_en-US.msi.sig`,
  `release-packages/Vyuha_${version}_Client_Package.zip`,
];
mkdirSync(out, { recursive: true });
const lines = [];
for (const f of candidates) {
  if (!existsSync(f)) {
    console.warn(`  (missing) ${f}`);
    continue;
  }
  const name = path.basename(f);
  copyFileSync(f, path.join(out, name));
  const sha = createHash("sha256").update(readFileSync(f)).digest("hex").toUpperCase();
  lines.push(`${sha}  ${name}`);
  console.log(`  ✓ ${name}  (${(statSync(f).size / 1048576).toFixed(1)} MB)`);
}
const winget = `release-packages/winget/${version}`;
if (existsSync(winget)) {
  const w = path.join(out, "winget");
  mkdirSync(w, { recursive: true });
  for (const f of readdirSync(winget)) copyFileSync(path.join(winget, f), path.join(w, f));
  console.log("  ✓ winget manifests");
}
writeFileSync(path.join(out, "CHECKSUMS.txt"), lines.join("\n") + "\n");
console.log(`✓ archived v${version} → ${out}`);
