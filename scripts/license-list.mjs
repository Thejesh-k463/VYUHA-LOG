// Vendor-side: show every key you have issued, from license-ledger.jsonl.
//
// Usage:
//   node scripts/license-list.mjs                 # all keys, newest last
//   node scripts/license-list.mjs buyer@mail.com  # filter by email substring
//   node scripts/license-list.mjs --expiring 30   # annual keys due in N days
//   node scripts/license-list.mjs --full          # include the full key text
//
// The ledger is written by license-issue.mjs. It is the ONLY record that a key
// exists — keys are signed, not registered, so nothing else in the system can
// tell you who bought what.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { REVOKED_IDS } from "./license-revoked.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledgerPath = path.join(root, "license-ledger.jsonl");

if (!existsSync(ledgerPath)) {
  console.error("No license-ledger.jsonl yet — it is created the first time you run license-issue.mjs.");
  process.exit(1);
}

const args = process.argv.slice(2);
let expiringDays = null;
let full = false;
for (let i = args.length - 1; i >= 0; i--) {
  if (args[i] === "--expiring" && args[i + 1]) { expiringDays = Number(args[i + 1]); args.splice(i, 2); }
  else if (args[i] === "--full") { full = true; args.splice(i, 1); }
}
const filter = args[0]?.toLowerCase() ?? null;

const rows = readFileSync(ledgerPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const today = new Date();
const daysUntil = (iso) => Math.ceil((new Date(iso + "T23:59:59").getTime() - today.getTime()) / 86400000);

let shown = rows;
if (filter) shown = shown.filter((r) => r.email.toLowerCase().includes(filter) || r.keyId.toLowerCase().includes(filter));
if (expiringDays != null) {
  shown = shown.filter((r) => r.expires && daysUntil(r.expires) <= expiringDays && daysUntil(r.expires) >= 0);
}

if (shown.length === 0) {
  console.log("No matching keys.");
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
}

const counts = shown.reduce((m, r) => ((m[r.sku] = (m[r.sku] ?? 0) + 1), m), {});
console.log("-".repeat(96));
console.log(`${shown.length} key(s): ` + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · "));
