// Mint a license key after a sale (vendor-side; needs license-private.pem from keygen).
//
// Usage:
//   node scripts/license-issue.mjs <buyer-email> [sku] [--expires YYYY-MM-DD | --years N]
//                                                      [--machine ABCD-EF12-3456]
//
// THE TWO PLANS SOLD TODAY (v2.99.76 reprice) — both are sku `app`; what
// separates them is the EXPIRY, because that is the only thing the entitlement
// engine reads. `sku` is display-only: it feeds SKU_LABELS in Settings and
// gates nothing.
//
//   Journal — Lifetime (₹29,999):  license-issue.mjs buyer@x.com app
//   Pro — Annual      (₹9,999/yr): license-issue.mjs buyer@x.com app --years 1
//
//   sku: app | toolkit | indicators (default app)
//   `toolkit` is LEGACY — the app-plus-indicators bundle retired at v2.99.76.
//   It still verifies so old keys keep working, but issuing one today labels
//   the buyer's Settings screen "Trader's Toolkit (app + indicators)" for a
//   product that no longer includes indicators.
//
//   No expiry flag = lifetime key. --years N = annual, expiring N years out.
//
//   --machine LOCKS the key to one computer. The buyer reads their Machine ID
//   from Settings → License and sends it to you; the key then refuses to
//   activate anywhere else. Omit it and the key runs on any machine, which is
//   the default and what every key issued before this flag existed does.
//   Trade-off: binding means you cannot pre-issue at checkout — you need the
//   buyer's Machine ID first, so it is a two-step delivery.
import { sign, createPrivateKey, createHash } from "node:crypto";
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
let expires = null;
let machine = null;
for (let i = args.length - 1; i >= 0; i--) {
  if (args[i] === "--machine" && args[i + 1]) { machine = args[i + 1].trim().toUpperCase(); args.splice(i, 2); }
  else if (args[i] === "--expires" && args[i + 1]) { expires = args[i + 1]; args.splice(i, 2); }
  else if (args[i] === "--years" && args[i + 1]) {
    const d = new Date();
    d.setFullYear(d.getFullYear() + Number(args[i + 1]));
    expires = d.toISOString().slice(0, 10);
    args.splice(i, 2);
  }
}
// Defaults to `app` — the SKU both plans on sale use. It defaulted to
// `toolkit` until 2026-08-12, which silently mislabelled every key issued
// after the v2.99.76 reprice retired that bundle.
const [email, sku = "app"] = args;
if (!email || !email.includes("@")) {
  console.error("Usage: node scripts/license-issue.mjs <buyer-email> [app|toolkit|indicators] [--expires YYYY-MM-DD | --years N] [--machine ABCD-EF12-3456]");
  console.error("  Lifetime ₹29,999 : license-issue.mjs buyer@x.com app");
  console.error("  Annual   ₹9,999  : license-issue.mjs buyer@x.com app --years 1");
  process.exit(1);
}
if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
  console.error(`Bad --expires date "${expires}" — use YYYY-MM-DD`);
  process.exit(1);
}
if (machine && !/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(machine)) {
  console.error(`Bad --machine id "${machine}" — expected the form ABCD-EF12-3456 exactly as shown in the buyer's Settings → License.`);
  process.exit(1);
}
if (!["toolkit", "app", "indicators"].includes(sku)) {
  console.error(`Unknown sku "${sku}" — use app (both plans on sale) | toolkit (legacy) | indicators`);
  process.exit(1);
}
if (sku === "toolkit") {
  console.error(`  ! "toolkit" is the retired app+indicators bundle (v2.99.76). The buyer's`);
  console.error(`    Settings screen will read "Trader's Toolkit (app + indicators)". Use "app"`);
  console.error(`    unless you are deliberately reissuing an old bundle key.\n`);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privPem = readFileSync(path.join(root, "license-private.pem"), "utf8");

const body = { email, sku, issued: new Date().toISOString().slice(0, 10) };
if (expires) body.expires = expires;
if (machine) body.machine = machine;
const payload = Buffer.from(JSON.stringify(body), "utf8");
const signature = sign(null, payload, createPrivateKey(privPem));
const key = `VYUHA-${payload.toString("base64url")}.${signature.toString("base64url")}`;

// Short, stable ID — must match lib/license.ts#licenseKeyId exactly.
const hex = createHash("sha256").update(key).digest("hex").slice(0, 10).toUpperCase();
const keyId = `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 10)}`;

// Append to the vendor ledger. WITHOUT this you have no record of what you
// sold: keys are signed, not registered, so nothing else in the system knows a
// key exists. Needed to reissue after a lost email, to answer "did this person
// actually buy?", and to revoke by ID after a refund or leak.
// GITIGNORED (contains buyer emails) — back it up privately with the .pem.
const ledgerLine = JSON.stringify({
  keyId,
  email,
  sku,
  issued: body.issued,
  expires: expires ?? null,
  machine: machine ?? null,
  key,
  note: process.env.VYUHA_LICENSE_NOTE ?? null,
}) + "\n";
appendFileSync(path.join(root, "license-ledger.jsonl"), ledgerLine);

// The KEY goes to stdout alone, so `license-issue.mjs … > key.txt` still works
// and you can pipe it straight into an email. Everything else is stderr.
console.log(key);
console.error(`\n  key id : ${keyId}`);
console.error(`  plan   : ${expires ? `Pro — Annual, expires ${expires}` : "Journal — Lifetime"}  (sku ${sku})`);
console.error(`  buyer  : ${email}`);
console.error(`  machine: ${machine ?? "unbound — activates on any computer"}`);
console.error(`  ledger : license-ledger.jsonl — back this up with license-private.pem`);
