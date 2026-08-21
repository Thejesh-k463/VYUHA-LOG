# Payment receipt — template and rules

**This is a PAYMENT RECEIPT, not a tax invoice.** The owner has no GSTIN, so
nothing issued from here may carry a GSTIN, an HSN/SAC code, a tax split, or the
words "tax invoice". The landing page's "inclusive of applicable taxes" line was
removed on 2026-08-13 for the same reason.

**If you register for GST later**, this file is where it changes: add GSTIN,
place of supply, HSN/SAC and the CGST/SGST or IGST split, retitle it "Tax
invoice", and put the "inclusive of taxes" line back on the landing page.

---

## Why bother, at n=2 sales

A ₹29,999 payment to a personal UPI handle with nothing to point at afterwards is
the transaction most buyers hesitate over. A receipt costs you two minutes and
removes the hesitation. It is also the only record that ties a payment reference
to a Key ID — which is what you will need if someone asks for a refund, disputes
a charge, or loses their key.

---

## Fill and send (copy the block below)

```
VYUHA — PAYMENT RECEIPT

Receipt no.    VY-2026-001
Date           13 August 2026

Received from  <buyer full name>
Email          <buyer@email.com>

Item           Vyuha — Pro (Annual)        [or: Vyuha — Journal (Lifetime)]
Licence term   1 year from 13 August 2026  [or: perpetual]
Licence Key ID A1B2-C3D4-E5

Amount paid    ₹9,999                      [or: ₹29,999]
Paid via       UPI                          [or: bank transfer / card]
Payment ref    <UTR / txn id — the buyer's own reference>

Not a tax invoice. No GST has been charged or collected on this sale.

Vyuha is a record-keeping and analytics tool, not investment advice.
Refund policy and terms of use are included in your download.

Thejesh K · ktr.thejesh463@gmail.com · WhatsApp +91 73936 73714
```

### Upgrade receipt (Annual → Lifetime)

Same block, with the item, term and amount lines replaced by these. The credit is what the
buyer actually paid for the year (§1.5 of `LICENSE_OPERATIONS.md`); the amount due is what
`license-upgrade.mjs` quoted. Quote both key IDs.

```
Item           Vyuha — Journal (Lifetime), upgraded from Pro (Annual)
Licence term   perpetual
Licence Key ID F6A7-B8C9-D0            (new lifetime key)
Replaces       A1B2-C3D4-E5            (annual key, retired on upgrade)

Lifetime price ₹29,999
Credit         − ₹9,999                 (paid for the year on <date of annual receipt>, receipt VY-2026-00X)
Amount paid    ₹20,000
Paid via       UPI
Payment ref    <UTR / txn id — the buyer's own reference>
```

---

## Rules

1. **Receipt numbers are sequential and never reused** — `VY-<year>-<3 digits>`.
   The next number is one more than the highest in `license-ledger.jsonl`.
2. **The payment reference is not optional.** It is the buyer's UTR or
   transaction id, and it must also go into the ledger — `scripts/license-issue.mjs`
   now refuses a paid mint without `VYUHA_LICENSE_NOTE`, so the receipt and the
   ledger cannot disagree.
3. **Quote the Key ID, never the key.** The receipt is a document the buyer may
   forward to an accountant; the key is a credential.
4. **Send it in the same message as the download link**, before or with the key.
   A buyer who has paid and is waiting is the moment trust is thinnest.
5. **Keep a copy.** Paste the sent text under the ledger entry, or keep a folder
   of receipts beside `license-ledger.jsonl`. Both live on one machine — back
   them up with the private key.
