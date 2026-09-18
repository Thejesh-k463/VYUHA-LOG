#!/usr/bin/env node
// What expires soon. Read-only; run it on the first of every month.
//
//   npm run renewals              # next 60 days
//   npm run renewals -- --days 90
//
// WHY. Nothing in the system reminds the owner that an annual key is ending.
// The BUYER sees a 30-day countdown in the app; the owner sees nothing, and a
// lapsed renewal locks Pro silently — the journal keeps working by design, but
// to the buyer it reads as something breaking. The renewal diary in
// VYUHA-STATE is a row you have to find; this is a command you run.

import { existsSync } from "node:fs";
import { defaultLedgerPath, readLedger } from "./lib/license-mint.mjs";
import { upcomingRenewals, chaseFrom } from "./lib/sale-flow.mjs";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const days = Number(opt("--days") ?? 60);
const today = opt("--today") ?? new Date().toISOString().slice(0, 10);

const ledgerPath = defaultLedgerPath();
if (!existsSync(ledgerPath)) {
  console.log("No ledger yet — nothing to renew.");
  process.exit(0);
}
const records = readLedger(ledgerPath);
const due = upcomingRenewals(records, today, days);
const dated = records.filter((r) => r.expires).length;

/**
 * Which plan a dated key came from, read off its own span (the ledger records
 * `issued` and `expires`, not the flag that was used). A MONTHLY key — owner
 * ruling 2026-09-18 — lasts about a month, so it is ALWAYS inside this window;
 * it is labelled rather than hidden, because a monthly buyer is exactly who
 * needs the next key issued on time.
 */
const termOf = (r) => {
  if (!r.issued || !r.expires) return "dated";
  const span = Math.round((Date.parse(r.expires) - Date.parse(r.issued)) / 86_400_000);
  return span <= 45 ? "monthly" : span >= 300 ? "annual" : "dated";
};

console.log(`\nRenewals — ${dated} key${dated === 1 ? "" : "s"} with an expiry in the ledger, window ${days} days from ${today}\n`);
if (due.length === 0) {
  console.log(`  Nothing expires in the next ${days} days.\n`);
  process.exit(0);
}

const rows = due.map((r) => ({
  keyId: r.keyId,
  email: r.email,
  term: termOf(r),
  expires: r.expires,
  // 30 days before a MONTHLY expiry is the day it was issued, which is not a
  // chase date — a monthly key is chased on the day it ends.
  chase: termOf(r) === "monthly" ? r.expires : chaseFrom(r.expires),
  state: r.daysLeft < 0 ? `LAPSED ${-r.daysLeft}d ago` : r.daysLeft === 0 ? "EXPIRES TODAY" : `${r.daysLeft}d left`,
}));
const w = (k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length));
const cols = ["keyId", "email", "term", "expires", "chase", "state"];
const head = cols.map((c) => c.toUpperCase().padEnd(w(c))).join("  ");
console.log("  " + head);
console.log("  " + "-".repeat(head.length));
for (const r of rows) console.log("  " + cols.map((c) => String(r[c]).padEnd(w(c))).join("  "));
console.log(`\n  "chase" = 30 days before expiry, when the app starts the buyer's own countdown.`);
console.log(`  A monthly key is always inside this window by nature — chase it on its expiry date.`);
console.log(`  To renew: mint a fresh key — npm run sell -- <email> --years 1 --utr <UTR> --name "<Name>"`);
console.log(`  (monthly, given on request: node scripts/license-issue.mjs <email> app --months 1)\n`);
// Non-zero exit when something has LAPSED, so a scheduled run can alert on it.
process.exit(rows.some((r) => r.state.startsWith("LAPSED")) ? 2 : 0);
