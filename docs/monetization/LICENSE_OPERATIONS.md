# Licence operations — the owner's runbook

Everything you actually do with keys: issue one, find one, revoke one, survive losing your
laptop. Strategy lives in `MONETIZATION_PLAN.md`; this is the button-pressing.

---

## 0. The one thing that matters

```
license-private.pem   ← mints every key you will ever sell
license-ledger.jsonl  ← the only record of what you have sold
```

Both sit at the repo root. Both are **gitignored**. Neither is in any installer.

- **Lose the .pem** → you can never issue another key. Existing keys keep working.
- **Leak the .pem** → anyone can mint unlimited valid keys, indistinguishable from yours.
  There is no recovery short of rotating (which kills every key you have already sold).
- **Lose the ledger** → existing keys keep working, but you no longer know who bought what,
  can't reissue after a lost email, and can't run renewals.

**Back both up now**, encrypted, somewhere that is not this machine — a password manager's
secure-file slot or an encrypted archive in personal cloud storage. Do it again after each
batch of sales. This is a five-minute task that has no substitute.

---

## 1. A sale comes in

```bash
node scripts/license-issue.mjs buyer@email.com toolkit
```

| SKU | Command |
|---|---|
| Trader's Toolkit (hero, lifetime) | `node scripts/license-issue.mjs buyer@email.com toolkit` |
| App only (lifetime) | `node scripts/license-issue.mjs buyer@email.com app` |
| App annual | `node scripts/license-issue.mjs buyer@email.com app --years 1` |
| Custom expiry | `node scripts/license-issue.mjs buyer@email.com app --expires 2027-03-31` |

The **key** goes to stdout (so `… > key.txt` or a pipe works); the **key ID, buyer and ledger
reminder** go to stderr so they never contaminate the key itself.

Optional note recorded in the ledger:

```bash
VYUHA_LICENSE_NOTE="razorpay pay_ABC123" node scripts/license-issue.mjs buyer@email.com toolkit
```

Then email the buyer the key + the download link. The key is bound to their email and shows as
"Licensed to <email>" in the app — that is the anti-sharing mechanism.

---

## 2. Find what you have sold

```bash
node scripts/license-list.mjs                    # everything
node scripts/license-list.mjs buyer@email.com    # one buyer (substring match)
node scripts/license-list.mjs A1B2               # by key id
node scripts/license-list.mjs --expiring 30      # annual keys due in 30 days
node scripts/license-list.mjs --full             # include the full key text
```

`--expiring 30`, run monthly, **is your renewal campaign**. Nothing else will remind you.

---

## 3. Support: "my key doesn't work"

Ask for the **Key ID**, not the key. They read it from **Settings → License** — it looks like
`A1B2-C3D4-E5`. Never ask a customer to paste their key into a chat or a ticket; it is a
credential and it will end up in a screenshot.

```bash
node scripts/license-list.mjs A1B2-C3D4-E5
```

| What they see | What it means | What to do |
|---|---|---|
| "Malformed key" | Truncated paste — usually a line break from the email | Resend the key on one line |
| "Signature check failed" | Key edited, or minted with a rotated vendor key | Reissue |
| "This key has been revoked" | You revoked it | Check the ledger note before reversing |
| "Key expired" badge | Annual key past `expires` | Sell the renewal; issue a fresh `--years 1` key |
| Nothing in the ledger | You have no record of this sale | Verify payment before issuing anything |

---

## 4. Refund, chargeback, or a key posted publicly

```bash
node scripts/license-revoke.mjs A1B2-C3D4-E5 "refunded 2026-07-22, razorpay pay_ABC123"
node scripts/license-revoke.mjs --list
node scripts/license-revoke.mjs --undo A1B2-C3D4-E5
```

This writes the ID into `lib/license.ts`, which ships. **Then bump, build and publish** — the
revocation only reaches users who install that build or later.

### Be honest with yourself about what revocation is

Vyuha is offline by design: the app never asks a server whether a key is still good. So:

- ✅ It stops a leaked key activating on **new** installs.
- ✅ It stops someone reselling a refunded key.
- ❌ It does **not** reach a machine already running an older build.
- ❌ It is **not** instant, and there is no kill switch.

A real kill switch requires a launch-time server call, which would break the privacy promise the
whole product is sold on. That trade is deliberate. Price and market the product as if
determined copying is possible, because it is — the deterrent is social (the buyer's email is
displayed in-app), not cryptographic.

---

## 5. Open decisions before you flip enforcement

1. **`LICENSE_ENFORCEMENT` is still `"banner"`.** Nothing is actually gated today. Flip it to
   `"block"` in `lib/license.ts` **only after the payment page is live** — otherwise
   trial-expired users hit a dead buy link.
2. **`BUY_URL` still points at the GitHub releases page.** Point it at Razorpay/your landing page
   in the same change.
3. **Staged positions (v2.85) are currently free.** They are arguably the strongest paid hook in
   the product, but `PRO_FEATURES` deliberately never gates the core journal, and a staged
   position *is* journalling. Recommendation: **leave it free** and keep gating analytics
   (Risk cockpit, Tax, ITR, Broker compare) — a trader who can't record what they actually did
   won't stay long enough to buy anything.
4. **Device binding is not implemented.** One key activates on unlimited machines. See below.

---

## 6. Device binding — the option you don't have yet

If you want one key = one machine, it needs a machine fingerprint (hostname + OS install ID,
hashed) stored on activation and compared on later launches.

**What it buys you:** genuine per-seat control; casual key-sharing stops working.

**What it costs you:** every legitimate hardware change becomes a support ticket. New laptop,
reinstalled Windows, replaced motherboard — all look identical to piracy. For a one-person
operation selling at ₹1,499–7,999, the support load plausibly exceeds the revenue it protects.
It also cannot be enforced offline any more strongly than revocation can: the check runs on the
user's machine, so it is bypassable by the same people who would bypass anything else.

**Recommendation: don't build it yet.** Ship, watch whether sharing actually happens (the buyer's
email in-app is a real deterrent), and revisit if you see one key ID appear in support from
several different people. If you do want it, the honest middle ground is a *soft* limit: record
the fingerprint, allow N activations, and show "activated on 3 machines" in Settings rather than
blocking — visible accountability without a support queue.

---

## 7. Rotating the vendor key (almost never)

`scripts/license-keygen.mjs` refuses to overwrite an existing `.pem` on purpose. Rotating
invalidates **every key you have ever sold** unless you keep verifying against the old public key
too. If you genuinely must rotate — the private key leaked — plan on reissuing keys to every
buyer in the ledger. That is the moment the ledger stops being paperwork and becomes the business.
