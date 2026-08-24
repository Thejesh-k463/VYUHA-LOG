#!/usr/bin/env node
// One licence sale, from mint to "ready to send", in one command.
//
//   npm run sell -- <buyer-email> --lifetime  --utr <UTR> --name "<Full Name>"
//   npm run sell -- <buyer-email> --years 1   --utr <UTR> --name "<Full Name>"
//   npm run sell -- you@example.com --lifetime --no-payment --name "Me"   # dry run on yourself
//
// WHAT IT REPLACES. On the first two real sales (2026-08-23) one mint command
// fanned out into eight manual steps: mkdir the archive folder, mint, eyeball
// the ledger, derive the receipt number, fill the receipt, save it, back up
// (renaming a same-day bundle first), compose the WhatsApp message. Seven of
// those are deterministic. This script does them, in order, stopping at the
// first failure — and verifies each one against disk rather than trusting an
// exit code, which is how the owner did it by hand.
//
// WHAT IT DELIBERATELY DOES NOT DO.
//   - Confirm payment. UPI to a personal VPA has no webhook; the --utr you pass
//     IS the confirmation, and the mint script refuses without it.
//   - Send anything. The message is written to a file with a marker where the
//     key goes; you paste the key from the archive at send time. The key is
//     never written into the message file.
//   - Copy the backup off this machine. It cannot know whether the external
//     drive is plugged in, so it tells you to, and prints the path.
//
// HOW IT STAYS SAFE. It SPAWNS scripts/license-issue.mjs and
// scripts/license-backup.mjs as child processes rather than importing their
// internals, so every guard they carry (required term, required payment note,
// refuse-to-overwrite) is in force unchanged. The ledger and pem paths come
// from the same VYUHA_LICENSE_* overrides those scripts read, so the test
// suite runs this whole flow against a throwaway keypair.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultLedgerPath, readLedger, archiveFileName } from "./lib/license-mint.mjs";
import { PLANS, nextReceiptNo, receiptText, sendMessage, chaseFrom } from "./lib/sale-flow.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);

const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

// ── arguments ────────────────────────────────────────────────────────────────
const email = args.find((a) => a.includes("@") && !a.startsWith("--"));
const lifetime = has("--lifetime");
const years = opt("--years");
const utr = opt("--utr");
const name = opt("--name");
const freebie = has("--no-payment");
const today = opt("--today") ?? new Date().toISOString().slice(0, 10); // tests pin the date
const receiptFloor = Number(opt("--receipt-floor") ?? process.env.VYUHA_RECEIPT_FLOOR ?? 2); // 001 and 002 were written by hand

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
function usage(msg) {
  if (msg) console.error(`✗ ${msg}\n`);
  console.error(`Usage: npm run sell -- <buyer-email> (--lifetime | --years 1) --utr <UTR> --name "<Full Name>"`);
  console.error(`       npm run sell -- <buyer-email> (--lifetime | --years 1) --no-payment --name "<Name>"   # dry run`);
  process.exit(1);
}

if (!email) usage("buyer email is required");
if (!lifetime && years !== "1") usage("a term is required: --lifetime or --years 1 (only 1 is sold)");
if (lifetime && years) usage("--lifetime and --years contradict each other");
if (!name) usage("--name \"<Full Name>\" is required — it goes on the receipt");
if (!freebie && !utr) usage("--utr <UTR> is required (or --no-payment for a dry run / freebie)");
if (utr && !/^\d{12}$/.test(utr)) usage(`--utr "${utr}" does not look like a 12-digit UPI UTR`);

const plan = lifetime ? "lifetime" : "annual";
const P = PLANS[plan];

// Archive folder: the mint script creates it for the archive, but a shell
// redirect runs BEFORE node and cannot — the first real sale failed on exactly
// this. Here there is no shell redirect (the key is captured from stdout), but
// creating it up front keeps the archive path certain.
const archiveDir = opt("--save-dir") ?? process.env.VYUHA_KEY_ARCHIVE_DIR;
if (!archiveDir) die("VYUHA_KEY_ARCHIVE_DIR is not set and no --save-dir given. Set it once (setx) and open a new terminal.");
mkdirSync(archiveDir, { recursive: true });

const ledgerPath = defaultLedgerPath();
const before = existsSync(ledgerPath) ? readLedger(ledgerPath) : [];

// A second key for the same email is almost never a sale — it is a re-run after
// a partial failure, or a fat finger. Found by a sabotage test: re-running
// sell.mjs for an address that had already been minted produced a second valid
// key and then crashed at the message step, AFTER every irreversible thing had
// happened. Reissues and second seats are deliberate and go through
// license-issue.mjs directly, where --no-payment records the reason.
const dup = before.find((r) => r.email.toLowerCase() === email.toLowerCase());
if (dup && !has("--allow-duplicate-email")) {
  die(
    `${email} already holds key ${dup.keyId} (issued ${dup.issued}, ${dup.expires ? `expires ${dup.expires}` : "lifetime"}).
` +
      `  A second key for the same address is not a normal sale. If this is deliberate — a renewal,
` +
      `  a second seat, a reissue — pass --allow-duplicate-email, or use scripts/license-issue.mjs directly.`,
  );
}

console.error(`\n── Vyuha sale ──────────────────────────────────────────────`);
console.error(`  buyer   : ${name} <${email}>`);
console.error(`  plan    : ${P.item}${freebie ? "  (NO PAYMENT — dry run / freebie)" : `  ₹${P.amount.toLocaleString("en-IN")}`}`);
console.error(`  archive : ${archiveDir}`);
console.error(`  ledger  : ${ledgerPath}  (${before.length} key${before.length === 1 ? "" : "s"} before)`);

// ── 1. mint ──────────────────────────────────────────────────────────────────
console.error(`\n[1/5] minting …`);
const note = freebie ? undefined : `UTR ${utr}, Rs ${P.amount.toLocaleString("en-IN")} UPI ${today}`;
const mintArgs = [path.join(here, "license-issue.mjs"), email, "app", ...P.flag.split(" "), "--save-dir", archiveDir];
if (freebie) mintArgs.push("--no-payment");
const mint = spawnSync(process.execPath, mintArgs, {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, ...(note ? { VYUHA_LICENSE_NOTE: note } : {}) },
});
if (mint.status !== 0) die(`mint refused:\n${mint.stderr}`);
const key = mint.stdout.trim();
if (!/^VYUHA-\S+$/.test(key) || key.includes("\n")) die("mint did not return a single clean key on stdout");
process.stderr.write(mint.stderr.split("\n").filter((l) => /key id|plan|machine/.test(l)).map((l) => "   " + l.trim()).join("\n") + "\n");

// ── 2. verify the ledger and archive against disk ────────────────────────────
console.error(`\n[2/5] verifying …`);
const after = readLedger(ledgerPath);
if (after.length !== before.length + 1) die(`ledger has ${after.length} lines, expected ${before.length + 1}`);
const rec = after[after.length - 1];
if (rec.email !== email) die(`newest ledger line is for ${rec.email}, not ${email}`);
if (rec.key !== key) die("newest ledger line does not carry the key that was printed");
if (lifetime && rec.expires) die(`lifetime sale but ledger says expires ${rec.expires}`);
if (!lifetime && !rec.expires) die("annual sale but ledger has NO expiry — this would be a lifetime key");
if (!freebie && !(rec.note ?? "").includes(utr)) die("ledger note does not carry the UTR");
const keyFile = path.join(archiveDir, archiveFileName(rec.keyId, email));
if (!existsSync(keyFile)) die(`archive file missing: ${keyFile}`);
if (readFileSync(keyFile, "utf8").split("\n")[0].trim() !== key) die("archive file's first line is not the key");
console.error(`   ✓ ledger ${before.length} → ${after.length}, key id ${rec.keyId}, expires ${rec.expires ?? "never"}`);
console.error(`   ✓ archive ${path.basename(keyFile)}`);

// ── 3. receipt ───────────────────────────────────────────────────────────────
console.error(`\n[3/5] receipt …`);
const year = Number(today.slice(0, 4));
const receiptNo = nextReceiptNo(after, year, receiptFloor);
const receipt = receiptText({ receiptNo, issued: rec.issued, name, email, plan, keyId: rec.keyId, utr: utr ?? "— (no payment)", expires: rec.expires });
const receiptPath = path.join(archiveDir, `${receiptNo}.txt`);
if (existsSync(receiptPath)) die(`refusing to overwrite ${receiptPath} — receipt numbers are never reused`);
writeFileSync(receiptPath, receipt, { flag: "wx" });
// Record the receipt number on the ledger line so the next sale numbers from it.
const lines = readFileSync(ledgerPath, "utf8").split("\n");
for (let i = lines.length - 1; i >= 0; i--) {
  if (!lines[i].trim()) continue;
  const o = JSON.parse(lines[i]);
  if (o.keyId === rec.keyId) { o.receipt = receiptNo; lines[i] = JSON.stringify(o); break; }
}
writeFileSync(ledgerPath, lines.join("\n"));
console.error(`   ✓ ${receiptNo} → ${path.basename(receiptPath)} (number recorded on the ledger line)`);

// ── 4. backup ────────────────────────────────────────────────────────────────
console.error(`\n[4/5] backup …`);
// license-backup.mjs names the bundle from the REAL clock (UTC date,
// license-backup.mjs:94) — so this path must use the same expression, never
// `today`, which --today can freeze while the child keeps real time.
const bundle = path.join(archiveDir, `vyuha-keys-${new Date().toISOString().slice(0, 10)}.vkb`);
if (existsSync(bundle)) {
  // Same-day second sale: the backup script refuses to overwrite, so rename the
  // earlier bundle — VY-2026-002 hit this by hand.
  let n = 1;
  let renamed;
  do { renamed = bundle.replace(/\.vkb$/, `-${String.fromCharCode(96 + n)}.vkb`); n++; } while (existsSync(renamed));
  renameSync(bundle, renamed);
  console.error(`   · earlier bundle today renamed → ${path.basename(renamed)}`);
}
if (!process.env.VYUHA_BACKUP_PASSPHRASE) {
  console.error(`   ! VYUHA_BACKUP_PASSPHRASE is not set — the backup script will prompt for the passphrase twice.`);
}
const backup = spawnSync(process.execPath, [path.join(here, "license-backup.mjs"), archiveDir], {
  cwd: root,
  encoding: "utf8",
  stdio: ["inherit", "pipe", "pipe"],
  env: process.env,
});
if (backup.status !== 0) die(`backup failed:\n${backup.stderr}`);
if (!existsSync(bundle)) die(`backup reported success but ${bundle} is not there`);
// Prove the bundle carries the ledger we just wrote, not an older one.
const inspect = spawnSync(process.execPath, [path.join(here, "license-backup.mjs"), "--inspect", bundle], { cwd: root, encoding: "utf8", env: process.env });
const ledgerBytes = Buffer.byteLength(readFileSync(ledgerPath));
const m = /license-ledger\.jsonl\s+(\d+) bytes/.exec(inspect.stdout + inspect.stderr);
if (!m) die("could not read the bundle's ledger size from --inspect");
if (Number(m[1]) !== ledgerBytes) die(`bundle holds a ${m[1]}-byte ledger but the live ledger is ${ledgerBytes} bytes — it does not contain this sale`);
console.error(`   ✓ ${path.basename(bundle)} holds the ${ledgerBytes}-byte ledger (matches live)`);

// ── 5. the message to send ───────────────────────────────────────────────────
console.error(`\n[5/5] send message …`);
const zipName = `Vyuha_${JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version}_Client_Package.zip`;
const msgPath = path.join(archiveDir, `send-${rec.keyId}.txt`);
if (existsSync(msgPath)) die(`refusing to overwrite ${msgPath}`);
writeFileSync(msgPath, sendMessage({ receipt, email, zipName }), { flag: "wx" });
console.error(`   ✓ ${path.basename(msgPath)}  (key is NOT in this file — paste it from ${path.basename(keyFile)})`);

// ── done: what is left for a human ───────────────────────────────────────────
console.error(`\n── done — ${rec.keyId} · ${receiptNo} ────────────────────────────`);
console.error(`\n  Left for you:`);
console.error(`  1. Copy ${path.basename(bundle)} to the EXTERNAL DRIVE (the on-machine copy shares a disk with the .pem).`);
console.error(`  2. Open ${path.basename(msgPath)}, paste the key from ${path.basename(keyFile)} at the marker,`);
console.error(`     attach release-packages\\${zipName}, send on WhatsApp.`);
console.error(`  3. Ask them to confirm "Licensed to ${email}" in Settings → License.`);
if (rec.expires) {
  console.error(`  4. RENEWAL: expires ${rec.expires} — chase from ${chaseFrom(rec.expires)}. Run \`npm run renewals\` monthly.`);
}
console.error("");
