// Encrypted backup of the two files that ARE the licence business:
// license-private.pem (mints every key) and license-ledger.jsonl (the only
// record of what was sold). Losing either is covered in
// docs/owner/LICENSE_OPERATIONS.md §0; this is the five-minute habit it asks for.
//
// Usage:
//   node scripts/license-backup.mjs <dir> [--passphrase-env VYUHA_BACKUP_PASSPHRASE]
//       → <dir>/vyuha-keys-<YYYY-MM-DD>.vkb   (refuses to overwrite)
//   node scripts/license-backup.mjs --restore <file.vkb> --out <dir> [--passphrase-env NAME]
//       → writes the bundled files into <dir>   (refuses to overwrite)
//   node scripts/license-backup.mjs --inspect <file.vkb>
//       → lists what the bundle holds, without the passphrase
//
// The passphrase comes from the env var named by --passphrase-env (default
// VYUHA_BACKUP_PASSPHRASE) or, if unset, from a readline prompt. It is never
// written anywhere. Format and cost parameters: scripts/lib/keybundle.mjs.
//
// Paths: license-private.pem / license-ledger.jsonl at the repo root, or
// VYUHA_LICENSE_PEM / VYUHA_LICENSE_LEDGER when set (tests and smoke runs).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { encryptBundle, decryptBundle, readBundleHeader } from "./lib/keybundle.mjs";
import { defaultPemPath, defaultLedgerPath } from "./lib/license-mint.mjs";

const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v ?? "";
}
function usage(msg) {
  if (msg) console.error(`${msg}\n`);
  console.error(`Usage: node scripts/license-backup.mjs <dir> [--passphrase-env NAME]`);
  console.error(`       node scripts/license-backup.mjs --restore <file.vkb> --out <dir> [--passphrase-env NAME]`);
  console.error(`       node scripts/license-backup.mjs --inspect <file.vkb>`);
  process.exit(1);
}

const passEnv = opt("--passphrase-env") ?? "VYUHA_BACKUP_PASSPHRASE";
const restoreFile = opt("--restore");
const outDir = opt("--out");
const inspectFile = opt("--inspect");

async function passphrase(promptText) {
  const fromEnv = process.env[passEnv];
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) usage(`No passphrase: set ${passEnv} (no TTY to prompt on).`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((res) => rl.question(promptText, res));
  rl.close();
  if (!answer) usage("Empty passphrase refused.");
  return answer;
}

if (inspectFile != null) {
  const { header } = readBundleHeader(readFileSync(inspectFile));
  console.log(`vyuha key bundle v${header.v}  scrypt N=${header.N} r=${header.r} p=${header.p}`);
  for (const f of header.files) console.log(`  ${f.name}  ${f.size} bytes`);
  process.exit(0);
}

if (restoreFile != null) {
  if (!outDir) usage("--restore needs --out <dir>");
  if (!existsSync(restoreFile)) usage(`No such bundle: ${restoreFile}`);
  const pass = await passphrase(`Passphrase for ${path.basename(restoreFile)}: `);
  const files = decryptBundle(readFileSync(restoreFile), pass);
  mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const dest = path.join(outDir, path.basename(f.name));
    if (existsSync(dest)) { console.error(`Refusing to overwrite ${dest} — restore into an empty folder and compare by hand.`); process.exit(1); }
  }
  for (const f of files) {
    const dest = path.join(outDir, path.basename(f.name));
    writeFileSync(dest, f.data, { flag: "wx" });
    console.error(`  restored ${dest}  (${f.data.length} bytes)`);
  }
  console.error(`✓ ${files.length} file(s) restored to ${outDir}. Move them to the repo root only after checking they are what you expect.`);
  process.exit(0);
}

const [dir] = args;
if (!dir) usage();
const pemPath = defaultPemPath();
const ledgerPath = defaultLedgerPath();
if (!existsSync(pemPath)) usage(`Private key not found at ${pemPath} — nothing to back up.`);
const files = [{ name: "license-private.pem", data: readFileSync(pemPath) }];
if (existsSync(ledgerPath)) files.push({ name: "license-ledger.jsonl", data: readFileSync(ledgerPath) });
else console.error(`  (no ledger at ${ledgerPath} yet — bundling the key alone)`);

mkdirSync(dir, { recursive: true });
const dest = path.join(dir, `vyuha-keys-${new Date().toISOString().slice(0, 10)}.vkb`);
if (existsSync(dest)) { console.error(`Refusing to overwrite ${dest} — delete or rename it if you really want a second one today.`); process.exit(1); }

const pass = await passphrase("Backup passphrase (remember it — there is no recovery): ");
if (!process.env[passEnv]) {
  const again = await passphrase("Type it again: ");
  if (again !== pass) { console.error("Passphrases differ — nothing written."); process.exit(1); }
}
writeFileSync(dest, encryptBundle(files, pass), { flag: "wx" });
console.error(`✓ ${dest}`);
for (const f of files) console.error(`    ${f.name}  ${f.data.length} bytes`);
console.error(`  Copy it somewhere that is not this machine. Verify: node scripts/license-backup.mjs --inspect "${dest}"`);
