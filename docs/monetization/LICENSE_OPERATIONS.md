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
| Locked to one computer | `… toolkit --machine EB42-FA73-9AD5` (see §6 — needs the buyer's Machine ID first) |

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
| "This key is locked to a different computer" | Machine-bound key on a new/reinstalled machine | Ask for the new Machine ID, re-issue with `--machine` |
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
4. **Machine binding is available but off by default.** See §6 for when it is worth the friction.

---

## 6. Machine-bound keys — ✅ BUILT, opt-in per sale

A key can be locked to ONE computer. It is **off by default**: omit the flag and the key runs
anywhere, which is what every key issued before this existed will always do.

### The two-step flow (there is no way around it)

Binding needs the buyer's Machine ID *before* you can mint the key, so you cannot pre-issue at
checkout. With email delivery that is barely extra work:

1. Buyer pays → you email the ZIP.
2. Buyer installs, opens **Settings → License**, and copies their **Machine ID**
   (looks like `EB42-FA73-9AD5`, with a Copy button next to it).
3. Buyer sends you that ID.
4. You mint the bound key:

```bash
node scripts/license-issue.mjs buyer@email.com toolkit --machine EB42-FA73-9AD5
```

The key then refuses to activate on any other computer, with a message telling the buyer to send
you their new Machine ID. The binding is inside the signed payload, so it cannot be stripped out —
editing it breaks the signature.

### What the fingerprint is made of

Windows' own `MachineGuid`, which is written once at Windows install and untouched by app
reinstalls, driver updates, RAM upgrades or renames. Where that cannot be read, it falls back to
hostname + platform + arch + CPU model.

Deliberately **not** used: total memory (changes on a RAM upgrade), MAC address (changes with
docks, VPNs, USB adapters), disk serial (changes on a clone). Every one of those would kill a
paying customer's key for a reason that is not their fault.

**Reinstalling Windows produces a new ID.** That is expected — re-issue the key with the new one.

### When to actually use it

| Situation | Bind? |
|---|---|
| Normal sale | **No.** Keep it frictionless; the buyer's email in-app is already a deterrent |
| A buyer asks for it (corporate/team policy) | Yes |
| You have caught a key being shared | Yes — revoke the old one, issue bound replacements |
| High-value bundle to someone you don't know | Your call |

The honest limit is the same as revocation's: the check runs on the user's machine, so it stops
casual sharing, not a determined attacker. Price accordingly. Binding every sale by default would
buy you very little and cost you a support ticket every time someone buys a new laptop.

---

## 7. Rotating the vendor key (almost never)

`scripts/license-keygen.mjs` refuses to overwrite an existing `.pem` on purpose. Rotating
invalidates **every key you have ever sold** unless you keep verifying against the old public key
too. If you genuinely must rotate — the private key leaked — plan on reissuing keys to every
buyer in the ledger. That is the moment the ledger stops being paperwork and becomes the business.
