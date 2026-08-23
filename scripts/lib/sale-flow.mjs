// Pure helpers behind `sell.mjs` and `renewals.mjs` — no I/O, no spawning, so
// every rule here can be unit-tested against fixtures without a keypair.
//
// The numbers and wording come from the same places the owner used by hand on
// the first two real sales (VY-2026-001 and VY-2026-002, 2026-08-23):
// docs/owner/RECEIPT_TEMPLATE.md for the receipt, LICENSE_OPERATIONS.md for
// the rules, and the sale runbook for the send message.

/** Plan display names and amounts, keyed by how the mint script is told the term. */
export const PLANS = {
  lifetime: { item: "Vyuha — Journal (Lifetime)", amount: 29999, flag: "--lifetime" },
  annual: { item: "Vyuha — Pro (Annual)", amount: 9999, flag: "--years 1" },
};

/**
 * Next receipt number: `VY-<year>-<NNN>`, one more than the highest already in
 * the ledger. Numbers are sequential and never reused (RECEIPT_TEMPLATE rule 1).
 * Keys minted before receipts existed have no `receipt` field and are skipped;
 * the two hand-written receipts carried 001 and 002, so a ledger with none
 * recorded starts at 003 via `floor` — pass the highest number already issued by
 * hand so the sequence is never restarted.
 */
export function nextReceiptNo(records, year, floor = 0) {
  let max = floor;
  for (const r of records) {
    const m = /^VY-(\d{4})-(\d{3})$/.exec(r.receipt ?? "");
    if (m && Number(m[1]) === year) max = Math.max(max, Number(m[2]));
  }
  return `VY-${year}-${String(max + 1).padStart(3, "0")}`;
}

/** "23 August 2026" from an ISO date — the form the receipt template uses. */
export function longDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${d} ${months[m - 1]} ${y}`;
}

/** Indian grouping: 29999 → "29,999"; 1234567 → "12,34,567". */
export function inr(n) {
  const s = String(Math.round(n));
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last3}`;
}

/**
 * The receipt, filled exactly as RECEIPT_TEMPLATE.md lays it out. It is a
 * payment receipt, NOT a tax invoice — no GSTIN, no tax split, ever (the
 * owner has no GST registration). Quotes the Key ID, never the key.
 */
export function receiptText({ receiptNo, issued, name, email, plan, keyId, utr, expires }) {
  const p = PLANS[plan];
  const term = expires ? `1 year from ${longDate(issued)} (expires ${longDate(expires)})` : "perpetual";
  return [
    "VYUHA — PAYMENT RECEIPT",
    "",
    `Receipt no.    ${receiptNo}`,
    `Date           ${longDate(issued)}`,
    "",
    `Received from  ${name}`,
    `Email          ${email}`,
    "",
    `Item           ${p.item}`,
    `Licence term   ${term}`,
    `Licence Key ID ${keyId}`,
    "",
    `Amount paid    ₹${inr(p.amount)}`,
    "Paid via       UPI",
    `Payment ref    ${utr}`,
    "",
    "Not a tax invoice. No GST has been charged or collected on this sale.",
    "",
    "Vyuha is a record-keeping and analytics tool, not investment advice.",
    "Refund policy and terms of use are included in your download.",
    "",
    "Thejesh K · ktr.thejesh463@gmail.com · WhatsApp +91 73936 73714",
    "",
  ].join("\n");
}

/**
 * The single WhatsApp message: receipt, then a marker where the key goes, then
 * the two install lines. The KEY IS NEVER WRITTEN INTO THIS FILE — the owner
 * pastes it from the archived key file at send time, so a stray screenshot or
 * a synced folder cannot leak a credential that also lives in the ledger.
 */
export function sendMessage({ receipt, email, zipName }) {
  return [
    receipt.trimEnd(),
    "",
    "Your licence key:",
    "<<< PASTE THE KEY HERE, on its own line >>>",
    "",
    `Install from the attached ${zipName} — Windows will show "Unknown publisher", click More info → Run anyway.`,
    `Then open Vyuha → Settings → License → paste the key. It should show "Licensed to ${email}".`,
    "",
  ].join("\n");
}

/**
 * Keys whose `expires` falls within `days` of `today` (or already passed).
 * Lifetime keys have no `expires` and are never renewals. Revoked keys are
 * left in because a revoked annual still has a date — the caller decides.
 */
export function upcomingRenewals(records, today, days = 60) {
  const t0 = Date.parse(today);
  const horizon = t0 + days * 86_400_000;
  return records
    .filter((r) => r.expires)
    .map((r) => ({ ...r, daysLeft: Math.round((Date.parse(r.expires) - t0) / 86_400_000) }))
    .filter((r) => Date.parse(r.expires) <= horizon)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

/** Chase-from date: 30 days before expiry, which is when the app starts its countdown for the buyer. */
export function chaseFrom(expiresIso) {
  const d = new Date(expiresIso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}
