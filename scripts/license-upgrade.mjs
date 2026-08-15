// Annual → Lifetime upgrade (vendor-side).
//
// Usage:
//   node scripts/license-upgrade.mjs <keyId|email> --paid <rupees>            # DRY RUN: prints the quote
//   node scripts/license-upgrade.mjs <keyId|email> --paid <rupees> \
//        --confirm "UTR 123456789012, ₹20,000 UPI 2026-08-15" [--machine ABCD-EF12-3456] [--save-dir <folder>]
//
// THE RULE (owner decision 2026-08-15): FULL CREDIT WITHIN THE YEAR.
//   due = lifetime launch price (lib/domain/pricing.ts) − what the buyer
//         actually paid for the annual key (--paid, from the ledger note / receipt)
//   … only while the annual key is UNEXPIRED. An expired annual key gets no
//   credit — sell lifetime at the current price with license-issue.mjs.
//
// What --confirm does, in order:
//   1. mints a LIFETIME key for the same email (and the same machine if the
//      old key was bound, unless --machine overrides), ledger note
//      "upgrade from <oldKeyId>; annual paid ₹X credited; <UTR>"
//   2. archives it if --save-dir / VYUHA_KEY_ARCHIVE_DIR is set
//   3. revokes the OLD key via scripts/license-revoke.mjs (build-time half)
//   4. prints the revocation-publish + gh upload commands for the signed-list
//      half — those are NOT run for you, because they publish.
// Without --confirm nothing is written anywhere. --confirm MUST carry the
// payment reference; there is no way to mint an upgrade without one.
//
// Paths: license-private.pem / license-ledger.jsonl at the repo root, or
// VYUHA_LICENSE_PEM / VYUHA_LICENSE_LEDGER when set (tests and smoke runs).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  mintKey, ledgerLine, appendLedger, readLedger, archiveKey, defaultPemPath, defaultLedgerPath,
} from "./lib/license-mint.mjs";
import { readLifetimeLaunchPrice, upgradeDue } from "./lib/upgrade-credit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{2}$/;
const MACHINE_RE = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;

function usage(msg) {
  if (msg) console.error(`${msg}\n`);
  console.error(`Usage: node scripts/license-upgrade.mjs <keyId|email> --paid <rupees> [--confirm "UTR …"] [--machine ABCD-EF12-3456] [--save-dir <folder>]`);
  console.error(`  Without --confirm: dry run, prints plan / credit / amount due, writes nothing.`);
  console.error(`  With    --confirm: mints the lifetime key, revokes the annual one, prints the publish commands.`);
  process.exit(1);
}

const args = process.argv.slice(2);
let paid = null;
let confirm = null;
let machine = null;
let saveDir = process.env.VYUHA_KEY_ARCHIVE_DIR || null;
for (let i = args.length - 1; i >= 0; i--) {
  if (args[i] === "--paid" && args[i + 1] != null) { paid = args[i + 1]; args.splice(i, 2); }
  else if (args[i] === "--confirm" && args[i + 1] != null) { confirm = args[i + 1].trim(); args.splice(i, 2); }
  else if (args[i] === "--machine" && args[i + 1]) { machine = args[i + 1].trim().toUpperCase(); args.splice(i, 2); }
  else if (args[i] === "--save-dir" && args[i + 1]) { saveDir = args[i + 1]; args.splice(i, 2); }
  else if (args[i] === "--confirm") usage(`--confirm needs the payment reference: --confirm "UTR 123456789012, ₹20,000 UPI 2026-08-15"`);
}
const [who] = args;
if (!who) usage();
if (paid == null) usage(`--paid <rupees> is required: what the buyer ACTUALLY paid for the annual key (see the ledger note / receipt).`);
const paidNum = Number(String(paid).replace(/[₹,\s]/g, ""));
if (!Number.isFinite(paidNum) || paidNum < 0) usage(`Bad --paid "${paid}" — a rupee amount, e.g. 9999`);
if (confirm != null && !confirm) usage(`--confirm must carry the payment reference (UTR / txn id), not an empty string.`);
if (machine && !MACHINE_RE.test(machine)) usage(`Bad --machine id "${machine}" — expected ABCD-EF12-3456 as shown in Settings → License.`);

const pemPath = defaultPemPath();
const ledgerPath = defaultLedgerPath();
const ledger = readLedger(ledgerPath);

// ── Find the annual key ────────────────────────────────────────────────────
const isId = ID_RE.test(who.toUpperCase());
let candidates;
if (isId) {
  candidates = ledger.filter((r) => r.keyId === who.toUpperCase());
  if (candidates.length === 0) { console.error(`No ledger entry with key id ${who.toUpperCase()} in ${ledgerPath}.`); process.exit(1); }
} else {
  const email = who.toLowerCase();
  candidates = ledger.filter((r) => (r.email ?? "").toLowerCase() === email);
  if (candidates.length === 0) { console.error(`No ledger entry for ${who} in ${ledgerPath}.`); process.exit(1); }
  const annuals = candidates.filter((r) => r.expires);
  if (annuals.length > 1) {
    console.error(`${who} has ${annuals.length} annual keys in the ledger — name the key id instead:`);
    for (const r of annuals) console.error(`  ${r.keyId}  issued ${r.issued}  expires ${r.expires}  ${r.note ?? ""}`);
    process.exit(1);
  }
  candidates = annuals.length ? annuals : candidates;
}
const old = candidates[candidates.length - 1];
if (!old.expires) {
  console.error(`${old.keyId} (${old.email}) is already a LIFETIME key — nothing to upgrade.`);
  process.exit(1);
}
const today = new Date().toISOString().slice(0, 10);
if (old.expires < today) {
  console.error(`${old.keyId} (${old.email}) expired ${old.expires} — no upgrade credit. Sell lifetime at list price:`);
  console.error(`  VYUHA_LICENSE_NOTE="UTR …" node scripts/license-issue.mjs ${old.email} app --lifetime`);
  process.exit(1);
}

// ── The quote ──────────────────────────────────────────────────────────────
const lifetime = readLifetimeLaunchPrice();
const { credit, due } = upgradeDue(lifetime, paidNum);
const inr = (n) => `₹${n.toLocaleString("en-IN")}`;
const boundTo = machine ?? old.machine ?? null;

console.error(`\n  Annual → Lifetime upgrade${confirm ? "" : "  (DRY RUN — nothing written)"}`);
console.error(`  buyer          : ${old.email}`);
console.error(`  annual key     : ${old.keyId}  issued ${old.issued}, expires ${old.expires}  (${old.note ?? "no note"})`);
console.error(`  lifetime price : ${inr(lifetime)}  (launch price, lib/domain/pricing.ts)`);
console.error(`  credit         : ${inr(credit)}  (paid for the year)`);
console.error(`  AMOUNT DUE     : ${inr(due)}`);
console.error(`  machine        : ${boundTo ?? "unbound"}`);
if (paidNum > lifetime) console.error(`  ! --paid exceeds the lifetime price; credit is capped at ${inr(lifetime)}. Check the number.`);

if (!confirm) {
  console.error(`\n  Collect ${inr(due)}, then re-run with:`);
  console.error(`    node scripts/license-upgrade.mjs ${old.keyId} --paid ${paidNum} --confirm "UTR <txn id>, ${inr(due)} UPI ${today}"`);
  process.exit(0);
}

// ── Mint the lifetime key ──────────────────────────────────────────────────
const note = `upgrade from ${old.keyId}; annual paid ${inr(credit)} credited; ${confirm}`;
const { key, keyId, payload } = mintKey({ email: old.email, sku: "app", expires: null, machine: boundTo, pemPath });
const record = ledgerLine({ keyId, email: old.email, sku: "app", issued: payload.issued, expires: null, machine: boundTo, key, note });
appendLedger(ledgerPath, record);

let archived = null;
if (saveDir) {
  try { archived = archiveKey({ dir: saveDir, record, ledgerPath }); }
  catch (e) { console.error(`\n  ! archive failed: ${e.message}\n    The key WAS minted and IS in the ledger.`); }
}

// ── Revoke the old key (build-time half), via the one script that owns it ──
const revoke = spawnSync(
  process.execPath,
  [path.join(here, "license-revoke.mjs"), old.keyId, `upgraded to lifetime ${keyId} on ${today}`],
  { encoding: "utf8", env: process.env },
);
const revokeOk = revoke.status === 0;

// Key to stdout alone; everything else to stderr (same contract as license-issue).
console.log(key);
console.error(`\n  NEW lifetime key id : ${keyId}`);
console.error(`  ledger              : ${ledgerPath}`);
if (archived) { console.error(`  archive             : ${archived.keyFile}`); console.error(`  ledger snapshot     : ${archived.snapshot}`); }
console.error(`  old key ${old.keyId}: ${revokeOk ? "revoked in scripts/license-revoked.mjs + lib/license.ts (ships with the next build)" : "REVOKE FAILED — run manually: node scripts/license-revoke.mjs " + old.keyId}`);
if (!revokeOk) console.error((revoke.stderr || revoke.stdout || "").trim().split("\n").map((l) => "    " + l).join("\n"));

console.error(`\n  Now publish the signed list so the OLD key stops working on their current install:`);
console.error(`    node scripts/revocation-publish.mjs --add ${old.keyId} --message "Upgraded to lifetime — use your new key" --grace-days 14`);
console.error(`    gh release upload revocations release-packages/revocations.json --clobber`);
console.error(`  Then send the buyer the new key (stdout above) and the upgrade receipt (docs/owner/RECEIPT_TEMPLATE.md).`);
