// Mint a license key after a sale (vendor-side; needs license-private.pem from keygen).
//
// Usage:
//   node scripts/license-issue.mjs <buyer-email> [sku] [--expires YYYY-MM-DD | --years N]
//                                                      [--machine ABCD-EF12-3456]
//                                                      [--save-dir <folder>]
//
//   --save-dir (or env VYUHA_KEY_ARCHIVE_DIR) ARCHIVES the key after minting:
//   writes <keyId>_<email>.txt (key on line 1, then plan/issued/expires/machine/
//   note) and copies the ledger beside it as license-ledger.<date>.jsonl. It
//   refuses to overwrite an existing key file. Set the env once and every key
//   you ever mint lands in that folder — the ledger is the record of a sale,
//   the archive is the copy you can hand back after a lost email.
//
//   Paths: license-private.pem and license-ledger.jsonl at the repo root, or
//   VYUHA_LICENSE_PEM / VYUHA_LICENSE_LEDGER when set (tests and smoke runs).
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
//   the buyer's Settings screen "Vyuha app (legacy bundle key)". Prefer `app`.
//
//   TERM IS REQUIRED — there is no default. --lifetime for the Lifetime plan,
//   --years N for an annual one, --expires YYYY-MM-DD for a custom date. It used
//   to be that no flag meant lifetime, and one forgotten flag on a Rs 9,999
//   annual sale minted a Rs 29,999 lifetime key: signed, valid, and undoable only
//   by revoking someone who had just paid. Lifetime is opt-IN for that reason.
//
//   --machine LOCKS the key to one computer. The buyer reads their Machine ID
//   from Settings → License and sends it to you; the key then refuses to
//   activate anywhere else. Omit it and the key runs on any machine, which is
//   the default and what every key issued before this flag existed does.
//   Trade-off: binding means you cannot pre-issue at checkout — you need the
//   buyer's Machine ID first, so it is a two-step delivery.
import {
  mintKey, ledgerLine, appendLedger, archiveKey, defaultPemPath, defaultLedgerPath,
} from "./lib/license-mint.mjs";

const args = process.argv.slice(2);
let expires = null;
let machine = null;
let saveDir = process.env.VYUHA_KEY_ARCHIVE_DIR || null;
for (let i = args.length - 1; i >= 0; i--) {
  if (args[i] === "--machine" && args[i + 1]) { machine = args[i + 1].trim().toUpperCase(); args.splice(i, 2); }
  else if (args[i] === "--save-dir" && args[i + 1]) { saveDir = args[i + 1]; args.splice(i, 2); }
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
  console.error("Usage: node scripts/license-issue.mjs <buyer-email> [app|toolkit|indicators] (--lifetime | --years N | --expires YYYY-MM-DD) [--machine ABCD-EF12-3456] [--save-dir <folder>] [--no-payment]");
  console.error("");
  console.error("  A TERM is required — there is no default:");
  console.error("    Journal — Lifetime ₹29,999 : license-issue.mjs buyer@x.com app --lifetime");
  console.error("    Pro — Annual ₹9,999/yr     : license-issue.mjs buyer@x.com app --years 1");
  console.error("");
  console.error("  A PAYMENT REFERENCE is required — set VYUHA_LICENSE_NOTE to the UTR:");
  console.error('    VYUHA_LICENSE_NOTE="UTR 123456789012, ₹9,999 UPI 2026-08-22" node scripts/license-issue.mjs …');
  console.error("    (or --no-payment for a genuine freebie: review copy, reissue, your own machine)");
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
  console.error(`    Settings screen will read "Vyuha app (legacy bundle key)". Use "app"`);
  console.error(`    unless you are deliberately reissuing an old bundle key.\n`);
}

/**
 * TERM MUST BE STATED, not defaulted.
 *
 * `--years` is parsed positionally and its absence silently meant "lifetime".
 * So a ₹9,999 annual sale where the flag was forgotten minted a ₹29,999
 * LIFETIME key — signed, valid, and unrecoverable except by revoking a customer
 * who paid you. Nothing printed a warning, because nothing was wrong as far as
 * the script was concerned.
 *
 * Lifetime is now opt-IN via `--lifetime`. Both plans on sale name their term
 * explicitly, and neither can be reached by omission.
 */
const wantsLifetime = args.includes("--lifetime");
if (wantsLifetime) args.splice(args.indexOf("--lifetime"), 1);
if (!expires && !wantsLifetime) {
  console.error(`Refusing to mint: no term given.\n`);
  console.error(`  Pro — Annual (₹9,999/yr) :  --years 1`);
  console.error(`  Journal — Lifetime (₹29,999) :  --lifetime\n`);
  console.error(`  Omitting the term used to mint a LIFETIME key silently, so a forgotten`);
  console.error(`  --years 1 gave away a ₹29,999 licence for a ₹9,999 payment.`);
  process.exit(1);
}
if (expires && wantsLifetime) {
  console.error(`--lifetime and --years/--expires contradict each other. Pick one.`);
  process.exit(1);
}

/**
 * EVERY PAID KEY CARRIES ITS PAYMENT REFERENCE.
 *
 * `VYUHA_LICENSE_NOTE` already existed and was optional — and `note` is null on
 * both keys ever issued, so the habit docs/owner/README.md calls essential was
 * not being kept at n=2. The ledger is the only record that a sale happened;
 * without a payment reference it cannot answer "did this person actually pay?",
 * which is the question a refund or a chargeback asks.
 *
 * Set VYUHA_LICENSE_NOTE to the UTR / transaction id (and anything else useful),
 * or pass --no-payment for a genuine freebie: a review copy, a replacement for a
 * lost key, or your own machine.
 */
const freebie = args.includes("--no-payment");
if (freebie) args.splice(args.indexOf("--no-payment"), 1);
const note = process.env.VYUHA_LICENSE_NOTE ?? null;
if (!note && !freebie) {
  console.error(`Refusing to mint: no payment reference.\n`);
  console.error(`  VYUHA_LICENSE_NOTE="UTR 123456789012, ₹9,999 UPI 2026-08-13" \\`);
  console.error(`    node scripts/license-issue.mjs buyer@email.com app --years 1\n`);
  console.error(`  Not a sale? Pass --no-payment (review copy, reissue, your own machine).`);
  console.error(`  See docs/owner/RECEIPT_TEMPLATE.md — the receipt and the ledger must agree.`);
  process.exit(1);
}

const pemPath = defaultPemPath();
const ledgerPath = defaultLedgerPath();

const { key, keyId, payload: body } = mintKey({ email, sku, expires, machine, pemPath });

// Append to the vendor ledger. WITHOUT this you have no record of what you
// sold: keys are signed, not registered, so nothing else in the system knows a
// key exists. Needed to reissue after a lost email, to answer "did this person
// actually buy?", and to revoke by ID after a refund or leak.
// GITIGNORED (contains buyer emails) — back it up privately with the .pem.
const record = ledgerLine({
  keyId,
  email,
  sku,
  issued: body.issued,
  expires,
  machine,
  key,
  note: note ?? (freebie ? "no payment (--no-payment)" : null),
});
appendLedger(ledgerPath, record);

// Archive AFTER the ledger append: the ledger is the record; the archive is a
// convenience copy, and a refused overwrite must not lose the ledger line.
let archived = null;
if (saveDir) {
  try {
    archived = archiveKey({ dir: saveDir, record, ledgerPath });
  } catch (e) {
    console.error(`
  ! archive failed: ${e.message}`);
    console.error(`    The key WAS minted and IS in the ledger — copy it from there.`);
  }
}

// The KEY goes to stdout alone, so `license-issue.mjs … > key.txt` still works
// and you can pipe it straight into an email. Everything else is stderr.
console.log(key);
console.error(`
  key id : ${keyId}`);
console.error(`  plan   : ${expires ? `Pro — Annual, expires ${expires}` : "Journal — Lifetime"}  (sku ${sku})`);
console.error(`  buyer  : ${email}`);
console.error(`  machine: ${machine ?? "unbound — activates on any computer"}`);
console.error(`  ledger : ${ledgerPath} — back this up with ${pemPath}`);
if (archived) {
  console.error(`  archive: ${archived.keyFile}`);
  console.error(`  ledger snapshot: ${archived.snapshot}`);
} else if (!saveDir) {
  console.error(`  archive: none — pass --save-dir <folder> or set VYUHA_KEY_ARCHIVE_DIR to keep a copy of every key`);
}
