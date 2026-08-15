# Refund policy + Terms of use — owner sign-off checklist

`docs/client/REFUND_POLICY.md` and `docs/client/TERMS.md` ship inside the client
ZIP and are what a buyer holds you to. Both were written as *conservative
drafts* and both still carry an "OWNER: confirm before sending" banner. This
file walks every clause that is a commercial or legal decision — not a
technical one — so you can answer each question once, edit the exact line, and
delete the banners.

**Pricing is settled and is NOT reopened here:** Pro — Annual ₹9,999/yr launch
(₹13,000 list), Journal — Lifetime ₹29,999 launch (₹35,999 list). See
`MONETIZATION_PLAN.md` §2 and DECISIONS.md 2026-08-15.

Work through the steps in order. Each step is: what the file says today → the
question you must answer → the options and what each one costs → the exact line
to edit.

---

## Step 1 — The refund window (REFUND_POLICY.md)

**Says today** (under "After you buy", exception 1):
> If Vyuha will not install, will not activate, or is broken in a way we cannot fix within **7 days** of your purchase, you get a full refund.

**Question:** Is 7 days from purchase the window you want to be held to?

| Option | Consequence |
|---|---|
| Keep 7 days | Matches the 7-day trial and the landing page FAQ. Buyers already had 7 free days to find the machine problem; this is a second 7 for the "it broke after paying" case. |
| 14 or 30 days | Friendlier; also longer exposure to "it broke" claims that are actually "I changed my mind". Must be changed in the landing page too (Step 8). |
| Shorter than 7 | Reads as hostile against a 7-day trial and would contradict the FAQ. Not recommended. |

**Edit:** `docs/client/REFUND_POLICY.md`, the exception-1 bullet — the bold `**7 days**`. If changed, mirror it in `docs/sales/landing-page.html` (Step 8).

## Step 2 — "Final once your licence key has been issued" (REFUND_POLICY.md)

**Says today:**
> Because the trial gives you the entire product before payment, **purchases are final once your licence key has been issued.**

and under "What is not refundable": change of mind after the trial; an annual licence part-way through the year; anything to do with trading results.

**Question:** Do you stand behind "final" — no goodwill refunds beyond the two exceptions — as the written rule?

| Option | Consequence |
|---|---|
| Keep "final" + the two exceptions | Clear and defensible because the trial precedes payment. You can still refund voluntarily case by case; the footnote (Step 3) says so. |
| Add a no-questions-asked window (e.g. 7 days) | Simpler support conversations; some buyers will trial 7 days free, buy, use 7 more, refund. Would need the "not refundable" list rewritten. |

**Edit:** the bold sentence under "## After you buy", and the three bullets under "## What is not refundable".

## Step 3 — The owner-discretion / tampering footnote (REFUND_POLICY.md)

**Says today** (closing `<small>` block):
> Beyond the two exceptions above, refunds are granted at the owner's discretion. If tampering with the software, changes that replicate Vyuha, or any other malpractice is verified, no refund will be provided and the licence may be revoked.

**Question:** Do you want (a) the discretion sentence, and (b) the tampering/replication forfeiture, in the customer-facing policy?

| Option | Consequence |
|---|---|
| Keep both | Preserves your freedom to refund a hard case and puts anyone reverse-engineering the app on notice. "Replicate Vyuha" and "malpractice" are broad words a lawyer may want tightened. |
| Keep discretion, drop tampering | Softer tone; you lose the written basis for refusing a refund to someone who cracked it (Terms §8 still lets you withdraw a shared key). |
| Drop both | Policy is purely the two exceptions. Cleaner, less flexible. |

**Edit:** the final `<small>…</small>` block, after the `---` rule. v2.99.95's client README already announces this footnote exists — if you drop it, edit that "New in v2.99.95" row too.

## Step 4 — Contact channel (both files)

**Says today:** REFUND_POLICY — "message the WhatsApp number on your invoice with your **Key ID**"; TERMS "## Contact" — "The WhatsApp number and email on your invoice."

**Question:** Is WhatsApp-on-the-invoice the channel you commit to for refund requests, and is the invoice always going to carry it?

| Option | Consequence |
|---|---|
| Keep as is | Zero-cost; depends on `RECEIPT_TEMPLATE.md` always including the number (it does today: +91 73936 73714, with the email still a placeholder). |
| Add an email | Gives a written trail per request; the landing page currently uses your git address — swap for a sales inbox first (see the comment at the top of `landing-page.html`). |

**Edit:** REFUND_POLICY.md paragraph beginning "To ask for either"; TERMS.md "## Contact".

## Step 5 — Licence grant terms (TERMS.md §1)

**Says today:**
> **One licence, one trader.** A key is issued to your email address and displays it inside the app. You may install Vyuha on your own machines; you may not share, resell or publish the key. Keys found posted publicly are withdrawn.

and the two plan definitions: Annual "for one year from the date your key is issued. It does not auto-renew"; Lifetime "permanently for the versions released during the life of the product".

**Question:** Per-buyer, non-transferable, any number of the buyer's OWN machines — is that the grant you sell? And is "life of the product" the promise you make for Lifetime?

| Option | Consequence |
|---|---|
| Keep: per-buyer, own machines, non-transferable | Matches how keys are issued (email-bound; machine-locking only on request — `LICENSE_OPERATIONS.md`). Nothing to enforce technically for machine count. |
| Cap machines (e.g. 2) | Needs a stated re-issue procedure; the app only locks to a machine when you bind it, so a cap is a paper rule. |
| Allow transfer/resale | You then need a transfer procedure (revoke + reissue) and a policy on the annual clock. Not recommended at launch. |
| Lifetime = "future upgrades at no extra cost" (v2.99.95 wording) vs "versions released during the life of the product" | Say the same thing in both places; the client README v2.99.95 row says "every future upgrade at no extra cost". Pick one phrasing and align. |

**Edit:** TERMS.md "## 1. What you are buying" — the two bullets and the "One licence, one trader" paragraph.

## Step 6 — Not-advice disclaimer and accuracy (TERMS.md §3–§4)

**Says today:** §3 "Vyuha is a record-keeping and analytics tool. It does not provide investment, trading or tax advice… Tax figures are informational… Verify with a qualified professional before filing." §4 charges depend on the rate card you configure; Greeks are an approximation.

**Question:** Do you accept these as the disclaimers, and is there anything the app now claims that these do not cover (e.g. the broker-API pulls, the MTF margin snapshot, the launch pricing)?

| Option | Consequence |
|---|---|
| Keep as written | Matches what the screens say. This is the SEBI-posture line — no outcome claims anywhere. |
| Add an explicit "not SEBI-registered" sentence | Removes any doubt for a reader who does not know what "record-keeping tool" implies. One sentence in §3. |

**Edit:** TERMS.md §3 and §4.

## Step 7 — Liability cap (TERMS.md §7)

**Says today:**
> …our total liability for any claim connected with Vyuha is limited to **the amount you paid for your licence**. We are not liable for trading losses, tax outcomes, missed opportunities, or data you did not back up.

**Question:** Cap at price paid — is that the number?

| Option | Consequence |
|---|---|
| Keep "amount you paid" | Standard for software of this price; enforceability of the cap and of "as is" varies — this is precisely the paragraph to have read by someone qualified. |
| Fixed rupee cap | Rarely better; makes the number look arbitrary. |

**Edit:** TERMS.md "## 7. Liability".

## Step 7a — Governing law and jurisdiction (TERMS.md §9)

**Says today:** "These terms are governed by the laws of India." — no city/court named.

**Question:** Do you want a jurisdiction clause (courts of your city) added, or is "laws of India" enough?

| Option | Consequence |
|---|---|
| Leave as is | Shortest; a dispute could be raised anywhere in India. |
| Name a city's courts | Conventional; needs your actual place of business — do not invent one. |

**Edit:** TERMS.md "## 9. Governing law".

## Step 8 — Consistency with the landing page FAQ

`docs/sales/landing-page.html`, the "Is there a refund policy?" `<details>` block (~lines 439–446 at v2.99.96) says: 7 days of the full Pro set free before paying; after purchase a full refund if it will not install / activate / is broken in a way we cannot fix **within 7 days**, or if charged twice / wrong amount; beyond that purchases are final; the journal keeps working after a refund.

That is exactly REFUND_POLICY.md's substance. **If Steps 1–3 changed anything, change the FAQ paragraph the same way** — the two are read side by side by every buyer who Googles before paying. Then run `npm run landing:build` so `landing-page.standalone.html` (the file you actually send/host) is regenerated. The brochure does not restate the refund terms; nothing to do there.

## Step 9 — Delete the two OWNER banners

Once every step above is answered, delete these two blocks — they are the only owner-facing text in files a buyer receives.

`docs/client/REFUND_POLICY.md`, lines 3–7:
```
> ⚠️ **OWNER: confirm these terms before sending this to a buyer.** This is a
> conservative draft written to match how Vyuha is actually sold (a full 7-day
> trial before any money changes hands). The numbers — the 7-day window, the
> "final after that" line — are commercial decisions, not technical ones.
> Change them here and nowhere else; this file ships inside the client ZIP.
```

`docs/client/TERMS.md`, lines 3–7:
```
> ⚠️ **OWNER: confirm before sending to a buyer.** This is a short, plain-language
> draft covering the licence grant, the disclaimers Vyuha's own screens already
> make, and a liability cap. It is written to be honest rather than to be
> maximally protective, and it is **not legal advice** — have it read by someone
> qualified before you sell at volume. This file ships inside the client ZIP.
```

Update `**Last updated:**` in both files to the day you sign off.

## Step 10 — Rebuild the ZIP

```
npm run client:package
```

Open the resulting ZIP and confirm `REFUND_POLICY.md` and `TERMS.md` are the edited copies with no banner. Then tick rows 5–7 of `DOC_AUDIT.md`.

---

**This file is not legal advice**, and neither are the two drafts it walks
through. They were written to be honest and to match what the software does.
Before selling at volume, have the Terms (particularly §7 liability and §9
governing law) and the refund policy read by someone qualified in Indian
consumer and contract law.
