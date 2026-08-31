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

### Archive every key: `--save-dir` / `VYUHA_KEY_ARCHIVE_DIR`

Set the env once (a synced, private folder) and every key `license-issue.mjs` or
`license-upgrade.mjs` mints is written there as `<keyId>_<email>.txt` — the key on
line 1, then plan / issued / expires / machine / note — with a ledger snapshot
`license-ledger.<date>.jsonl` beside it. It **refuses to overwrite** an existing key file.
The ledger stays the record; the archive is the copy you hand back after "I lost the email".

```bash
export VYUHA_KEY_ARCHIVE_DIR="D:/Vyuha-keys"          # or per run: … --save-dir D:/Vyuha-keys
VYUHA_LICENSE_NOTE="UTR …" node scripts/license-issue.mjs buyer@email.com app --years 1
```

### Encrypted backup: `license-backup.mjs`

Bundles the `.pem` and the ledger into ONE file, AES-256-GCM under a passphrase you choose
(scrypt N=2^15 — see the comment in `scripts/lib/keybundle.mjs` for why it is cheaper than
the trade-database backup). Refuses to overwrite. Same day, same name — rename the old one
if you want two.

```bash
node scripts/license-backup.mjs D:/Vyuha-keys                       # prompts for a passphrase twice
VYUHA_BACKUP_PASSPHRASE="…" node scripts/license-backup.mjs D:/Vyuha-keys   # scripted
node scripts/license-backup.mjs --inspect D:/Vyuha-keys/vyuha-keys-2026-08-15.vkb   # what is inside, no passphrase
node scripts/license-backup.mjs --restore D:/Vyuha-keys/vyuha-keys-2026-08-15.vkb --out D:/restore-check
```

Copy the `.vkb` somewhere that is not this machine. **The passphrase has no recovery** — put it
in the password manager, not in the same folder as the bundle.

> Path overrides for tests and smoke runs only: `VYUHA_LICENSE_PEM`, `VYUHA_LICENSE_LEDGER`
> (read by every licence script via `scripts/lib/license-mint.mjs`), `VYUHA_REVOKED_MJS`,
> `VYUHA_LICENSE_TS` (`license-revoke.mjs`). Leave them unset for real sales.

---

## 1. A sale comes in

> ### The one-command version: `npm run sell` (2026-08-23)
>
> Everything in §1 from the mint onward, in order, stopping at the first failure:
>
> ```bash
> npm run sell -- buyer@email.com --lifetime --utr 627604880174 --name "Siddhi Gunwant"
> npm run sell -- buyer@email.com --years 1  --utr 072712985315 --name "Shivangi Kulkarni"
> npm run sell -- you@example.com --lifetime --no-payment --name "Me"     # dry run on yourself
> ```
>
> It **spawns** `license-issue.mjs` and `license-backup.mjs` rather than re-implementing
> them, so every guard below stays in force. Then it verifies the ledger and archive against
> disk, numbers and saves the receipt (`VY-<year>-NNN`, recorded on the ledger line), backs
> up — renaming a same-day bundle first — and proves the bundle holds the live ledger, and
> writes `send-<keyid>.txt` with a `<<< PASTE THE KEY HERE >>>` marker. **The key is never
> written into the message file.** It refuses a second key for an email that already holds
> one (a re-run after a partial failure is the common cause; pass
> `--allow-duplicate-email` only for a deliberate renewal or reissue).
>
> What it leaves to you, and prints: copy the `.vkb` to the **external drive**, paste the
> key from the archive into the message, attach the ZIP, send, and ask for "Licensed to …"
> confirmation. Set `VYUHA_BACKUP_PASSPHRASE` in the shell first or it will prompt twice.
>
> **Monthly:** `npm run renewals` lists every annual key expiring in the next 60 days with
> its chase-from date, and exits 2 if any has already lapsed. Nothing else reminds you.
>
> Both were built against a throwaway keypair and ledger (`tests/sell-flow.test.ts`, 11 cases,
> incl. a sabotage run that found the duplicate-email hole) — the real `.pem` and ledger are
> never opened by the tests.

> **The plan is the EXPIRY, not the SKU.** `sku` is display-only — it feeds
> `SKU_LABELS` on the buyer's Settings screen and gates nothing. What the
> entitlement engine actually reads is `expires`: absent means lifetime
> (`isKeyExpired` in `lib/license.ts`). Both plans on sale are sku **`app`**.

### Step 0 — take the payment, and write down what you took

**Do this before minting anything.** Nothing in the system knows a sale happened
except the ledger line you are about to write, and `license-issue.mjs` now
**refuses to mint without a payment reference** for exactly that reason.

1. Send the amount and your UPI handle. Quote the plan by name — "Pro — Annual,
   ₹7,999 for one year" — so the term is agreed in writing before it is signed
   into a key.
2. Wait for the transfer, and ask for the **UTR / transaction id**. That string
   is the payment reference; it is what settles a dispute months later.
3. Send the **payment receipt** — `docs/owner/RECEIPT_TEMPLATE.md`. Two minutes,
   and it is the difference between a ₹29,999 UPI transfer that feels like a
   purchase and one that feels like a gamble. It is a receipt, **not a tax
   invoice**: there is no GSTIN, so it must never carry one.

```bash
VYUHA_LICENSE_NOTE="UTR 123456789012, ₹7,999 UPI 2026-08-13" \
  node scripts/license-issue.mjs buyer@email.com app --years 1
```

| Plan (v2.99.76 pricing) | Command |
|---|---|
| **Journal — Lifetime ₹29,999** | `… buyer@email.com app --lifetime` |
| **Pro — Annual ₹7,999/yr** | `… buyer@email.com app --years 1` |
| Custom expiry | `… buyer@email.com app --expires 2027-03-31` |
| Locked to one computer | `… app --machine EB42-FA73-9AD5` (see §6 — needs the buyer's Machine ID first) |
| *Legacy bundle (do not issue)* | `… toolkit` — the app+indicators SKU retired at v2.99.76. Old keys still verify; issuing one today labels the buyer's Settings screen "Vyuha app (legacy bundle key)". The script warns if you do. |

The **key** goes to stdout (so `… > key.txt` or a pipe works); the **plan, key ID, buyer and
ledger reminder** go to stderr so they never contaminate the key itself.

> ⚠ **Two things the script now refuses, and why.**
>
> **No term → refused.** `--years` was positional and its absence meant lifetime,
> so one forgotten flag on a ₹9,999 annual sale minted a ₹29,999 **lifetime** key
> — signed, valid, and undoable only by revoking someone who had just paid you.
> Lifetime is now opt-in: `--lifetime`.
>
> **No payment reference → refused.** `VYUHA_LICENSE_NOTE` was optional, and
> `note` is `null` on both keys ever issued — the habit was already not being
> kept at n=2. For a genuine freebie (review copy, reissue after a lost key,
> your own machine) pass `--no-payment`, which records that reason in the ledger
> rather than leaving a blank.

Then email the buyer the key + the download link. The key is bound to their email and shows as
"Licensed to <email>" in the app — that is the anti-sharing mechanism.

---

## 1.5 Annual → Lifetime upgrade

**The rule (owner decision 2026-08-15): full credit within the year.** While the annual key is
unexpired, the buyer owes the **lifetime launch price minus what they actually paid for the
year** — ₹29,999 − ₹7,999 = **₹22,000** at today's prices; the arithmetic is
`upgradeCredit()` in `lib/domain/pricing.ts` and the script reads the price from there, so a
reprice changes the quote without touching the script. An **expired** annual key gets no
credit — sell lifetime at the current price with `license-issue.mjs … --lifetime`.

**1. Quote (dry run — writes nothing).** Name the key id, or the email if the buyer has only one
annual key. `--paid` is what they actually paid, from the ledger note / their receipt.

```bash
node scripts/license-upgrade.mjs A1B2-C3D4-E5 --paid 7999
#   lifetime price : ₹29,999    credit : ₹7,999    AMOUNT DUE : ₹22,000
```

**2. Collect the amount due**, get the UTR, send the upgrade receipt (`RECEIPT_TEMPLATE.md`,
upgrade variant — it shows the credit and the amount due).

**3. Confirm.** `--confirm` MUST carry the payment reference; nothing mints without it.

```bash
node scripts/license-upgrade.mjs A1B2-C3D4-E5 --paid 7999   --confirm "UTR 123456789012, ₹22,000 UPI 2026-08-15"        # add --machine … if their old key was bound and they moved
```

This mints a **lifetime** key for the same email (same machine binding as the old key unless
`--machine` says otherwise), ledger note `upgrade from A1B2-C3D4-E5; annual paid ₹7,999
credited; UTR …`, archives it if `VYUHA_KEY_ARCHIVE_DIR` is set, and **revokes the old key**
through `license-revoke.mjs` (the build-time half — same code path, same files). The new key is
on stdout; email it with the receipt.

**4. The other half — publish the signed list**, so the old key stops working on the install
they already have. The script prints these exact commands; they are not run for you because they
publish:

```bash
node scripts/revocation-publish.mjs --add A1B2-C3D4-E5 --message "Upgraded to lifetime — use your new key" --grace-days 14
gh release upload revocations release-packages/revocations.json --clobber
```

Then release as normal so the build-time list ships (§4). Refusals: expired key, already
lifetime, an email with two annual keys (name the id), `--confirm` without a reference.

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

This writes the ID into `lib/license.ts`, which ships. **Then bump, build and publish** — this half
of revocation only reaches users who install that build or later.

### The other half: the signed list (v2.99.91+)

For a key that needs to stop working *now* rather than at the next release, publish the signed
revocation list. The desktop shell already contacts GitHub at launch for the update check; since
v2.99.91 it fetches the list in the same breath.

**One-time setup**, before the first revocation ever needs publishing:

```bash
gh release create revocations --prerelease --title "Licence revocations" --notes "Signed revocation list fetched by installed copies at launch. Do not delete."
```

That tag is permanent and holds exactly one asset. It is deliberately **not** the app release and
deliberately **not** `releases/latest/…`: `latest` re-points at every new version, so a list
uploaded to v2.99.91 would 404 the moment v2.99.92 shipped without someone re-uploading it — a
revocation quietly un-revoking itself, with nothing on screen to show for it.

> ⚠ **`--prerelease` is not optional, and it is not cosmetic.** GitHub picks "latest release" as
> the most recent non-draft, **non-prerelease** release by creation date — across *every* tag, not
> just version-shaped ones. Without the flag this release becomes `releases/latest`, and the
> updater endpoint baked into `tauri.conf.json`
> (`releases/latest/download/latest.json`) 404s on it. Auto-update then dies for every installed
> copy, **silently**, because the updater fails open by design. This happened on 2026-08-12 and was
> caught only by querying `/releases/latest` afterwards. The flag does not affect the direct
> `releases/download/revocations/revocations.json` URL the feature actually uses.
>
> After creating or editing it, always confirm:
> ```bash
> gh api repos/Thejesh-k463/VYUHA-LOG/releases/latest --jq .tag_name
> ```
> That must print a `v…` app version. If it prints `revocations`, run
> `gh release edit revocations --prerelease` and check again.

Then, per revocation:

```bash
node scripts/revocation-publish.mjs --add A1B2-C3D4-E5 --message "Refunded 2026-07-22 — contact support to re-purchase."
gh release upload revocations <the path it printed> --clobber
```

- `--grace-days N` sets the warning window (default **14**). The user sees a countdown banner on
  every Pro screen for those days; the key keeps working throughout.
- Re-run with the ID removed to **un-revoke** — a newer list supersedes an older one, so a mistake
  is recoverable without shipping a build.
- The list is Ed25519-signed with the same vendor key as the licences themselves. An unsigned or
  tampered list is ignored, and an **older** list can never displace a newer one.

**Do both** for a refund or a leak: publish the signed list so the key stops soon, and run
`license-revoke.mjs` so it never returns in a later build.

### The procedure for a paid period someone kept using past its end

The tooling supports a warn-first process; it does not replace one. Contacting the customer is
still your job, and doing it in this order means nobody is ever surprised:

| Step | You do | They see |
|---|---|---|
| 1 — expiry notice | Email/WhatsApp when the paid period ends. `node scripts/license-list.mjs --expiring 30` is the reminder list | The app already shows their key's expiry in Settings → License |
| 2 — reminder | A second note ~a week later, with the renewal price and link | Nothing new — Pro is still fully working |
| 3 — final notice | A third note stating the date the licence stops, matching the `--grace-days` you are about to publish | Nothing new yet |
| 4 — publish | `revocation-publish.mjs --add <ID> --grace-days 14 --message "…"` then `gh release upload revocations … --clobber` | A dated countdown on every Pro screen — "14 days left" plus your message. **Nothing is withheld yet** |
| 5 — it takes effect | Nothing | Pro screens show your message and lock. Their **journal is untouched**: trades, imports, backups and exports keep working, exactly as on a free copy |

Two things to hold onto. **Grace is not a formality** — the `--message` is the only sentence the
person gets in-app, so write it as if it is the whole conversation: why, and how to fix it.
And **step 4 is reversible**: re-publish without the ID and they are un-revoked at their next
launch, no build required. Revoking in error costs a launch, not a customer.

Only the licence key is ever named. Nothing about the customer, their trades, their machine or
their usage is transmitted at any point — you are publishing a public list of key ids, and the app
is downloading it. Whatever customer details you keep are yours, kept by you, outside this app.

### Be honest with yourself about what revocation is

- ✅ Stops a leaked key activating on **new** installs (build-time half).
- ✅ Reaches an **existing** install within a launch or two, after a stated grace period
  (signed-list half).
- ✅ Reversible — publishing a newer list un-revokes.
- ❌ **Fails open.** A machine kept permanently offline never receives the list, and revocation
  never takes effect there. This is deliberate: the alternative is locking out a paying user whose
  internet is down.
- ❌ Does **not** survive a patched binary. Someone willing to edit the executable can delete the
  check; the licence system raises the cost of copying, it does not make it impossible.

Nothing about the user travels upward on any of these paths — no account, no identifier, no
telemetry. The request is a plain download of a public file. Price and market the product as if
determined copying is possible, because it is; the deterrent is social (the buyer's email is
displayed in-app) plus a revocation that now actually arrives, not DRM.

---

## 5. Enforcement — ✅ LIVE (set 2026-07-22)

1. **`LICENSE_ENFORCEMENT` is now `"block"`.** When a 7-day trial ends without a key, the Pro
   screens (17 of them since v2.99.20 — the risk cockpit, deep analytics, the options-seller pack,
   the tax pack, broker/MTF comparison, PDF reports and open-trade tracking) render the upsell panel instead of
   their content. The core journal — trades, imports, dashboard, playbooks, backups — is still never
   gated: a trader who can't record what they actually did won't stay long enough to buy anything.
2. **`BUY_URL` points at WhatsApp** — `917393673714`, with a pre-filled message, derived from
   `WHATSAPP_NUMBER` in `lib/license.ts`. A test fails the build if enforcement is `"block"` while
   that number is empty, so the two cannot drift apart and strand a trial-expired user.
3. **Staged positions stay free.** They are journalling, and `PRO_FEATURES` deliberately never gates
   the record of what you actually did.
4. **Machine binding is available but off by default.** See §6 for when it is worth the friction.

**To reverse it** — if you decide to go back to soft-selling — set `LICENSE_ENFORCEMENT` to
`"banner"` in `lib/license.ts`, rebuild and ship. Keys already issued are unaffected either way.

**What a trial-expired, unlicensed user now sees:** every Pro page shows the upsell panel with a
"Get Vyuha Pro" button that opens WhatsApp to your business number with the message
pre-filled. Test this path yourself before you send the first ZIP — it is now the entire top of
your funnel.

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
VYUHA_LICENSE_NOTE="UTR …" node scripts/license-issue.mjs buyer@email.com app --lifetime --machine EB42-FA73-9AD5  # Lifetime, bound
VYUHA_LICENSE_NOTE="UTR …" node scripts/license-issue.mjs buyer@email.com app --years 1 --machine EB42-FA73-9AD5  # Annual, bound
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
