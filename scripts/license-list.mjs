// Vendor-side: show every key you have issued, from license-ledger.jsonl.
//
// Usage:
//   node scripts/license-list.mjs                 # all keys, newest last
//   node scripts/license-list.mjs buyer@mail.com  # filter by email substring
//   node scripts/license-list.mjs --expiring 30   # annual keys due in N days
//   node scripts/license-list.mjs --full          # include the full key text
//   node scripts/license-list.mjs --by-ref        # one line per referring creator
//   node scripts/license-list.mjs --by-ref RAVI   # that creator's keys (--by-ref none = unreferred)
//
// --by-ref with no code prints `CODE  keys N  active N  lifetime N  yearly N
// latest YYYY-MM-DD` per referrer (the --ref code license-issue.mjs recorded),
// unreferred keys under "(none)", sorted by keys desc. active = not expired
// today and not revoked; yearly = any key WITH an expiry (annual, monthly,
// custom). The code, when given, must follow --by-ref directly. The summary
// never prints a key; the per-code list prints one only under --full.
//
// The ledger is written by license-issue.mjs. It is the ONLY record that a key
// exists — keys are signed, not registered, so nothing else in the system can
// tell you who bought what.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { REVOKED_IDS } from "./license-revoked.mjs";
import { defaultLedgerPath, normaliseRef, withRef, summariseByRef, formatByRefLine } from "./lib/license-mint.mjs";

// Same resolution as license-issue.mjs: VYUHA_LICENSE_LEDGER when set (the
// production ledger lives OUTSIDE the repo since 2026-09-22), else repo root.
const ledgerPath = defaultLedgerPath();

if (!existsSync(ledgerPath)) {
  console.error(`No ledger at ${ledgerPath} — set VYUHA_LICENSE_LEDGER or run license-issue.mjs first.`);
  process.exit(1);
}

const args = process.argv.slice(2);
let expiringDays = null;
let full = false;
let byRef = false;
/** undefined = the per-referrer summary; string|null = list that one code (null = unreferred). */
let byRefCode = undefined;
for (let i = args.length - 1; i >= 0; i--) {
  if (args[i] === "--expiring" && args[i + 1]) { expiringDays = Number(args[i + 1]); args.splice(i, 2); }
  else if (args[i] === "--full") { full = true; args.splice(i, 1); }
  else if (args[i] === "--by-ref") {
    byRef = true;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) { byRefCode = normaliseRef(next); args.splice(i, 2); }
    else args.splice(i, 1);
  }
}
const filter = args[0]?.toLowerCase() ?? null;

const rows = readFileSync(ledgerPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  // Lines written before --ref existed carry no `ref` field: read as null.
  .map(withRef);

const today = new Date();
const daysUntil = (iso) => Math.ceil((new Date(iso + "T23:59:59").getTime() - today.getTime()) / 86400000);

let shown = rows;
if (filter) shown = shown.filter((r) => r.email.toLowerCase().includes(filter) || r.keyId.toLowerCase().includes(filter));
if (expiringDays != null) {
  shown = shown.filter((r) => r.expires && daysUntil(r.expires) <= expiringDays && daysUntil(r.expires) >= 0);
}
if (byRef && byRefCode !== undefined) shown = shown.filter((r) => normaliseRef(r.ref) === byRefCode);

if (shown.length === 0) {
  console.log("No matching keys.");
  process.exit(0);
}

if (byRef && byRefCode === undefined) {
  // The payout view: counts only, never a key (--full has nothing to add here).
  const summary = summariseByRef(shown, { today, revoked: REVOKED_IDS });
  for (const s of summary) console.log(formatByRefLine(s));
  console.log("-".repeat(96));
  console.log(`${shown.length} key(s) from ${summary.filter((s) => s.ref !== null).length} referrer(s)`);
  process.exit(0);
}

const pad = (s, n) => String(s ?? "").padEnd(n);
console.log(pad("KEY ID", 14) + pad("EMAIL", 30) + pad("SKU", 12) + pad("ISSUED", 12) + pad("EXPIRES", 14) + "STATUS");
console.log("-".repeat(96));
for (const r of shown) {
  let status = "active";
  if (REVOKED_IDS.includes(r.keyId)) status = "REVOKED";
  else if (r.expires) {
    const d = daysUntil(r.expires);
    status = d < 0 ? "expired" : d <= 30 ? `renews in ${d}d` : "active";
  } else status = "lifetime";
  console.log(pad(r.keyId, 14) + pad(r.email, 30) + pad(r.sku, 12) + pad(r.issued, 12) + pad(r.expires ?? "—", 14) + status);
  if (full) console.log(`   ${r.key}`);
  if (r.note) console.log(`   note: ${r.note}`);
  if (r.ref) console.log(`   ref: ${r.ref}`);
}

const counts = shown.reduce((m, r) => ((m[r.sku] = (m[r.sku] ?? 0) + 1), m), {});
console.log("-".repeat(96));
console.log(`${shown.length} key(s): ` + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · "));
