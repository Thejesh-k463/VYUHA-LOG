# Owner's manual — VENDOR ONLY

**Nothing in this folder ships to a client.** It is the operating manual for the
person who sells Vyuha: how to cut a release, mint a licence, and keep the two
secrets that make both possible.

If you are looking for what a *buyer* gets, that is [`docs/client/`](../client/).

---

## The three secrets, and what each one costs you if lost

All three are gitignored and have **never been committed** — verified by
`git log --all -- <file>` returning nothing.

| Secret | Location | Lose it and… |
|---|---|---|
| **Licence signing key** | `license-private.pem` | You can never issue or renew a key again. Existing keys keep working; you simply cannot make more. **Unrecoverable.** |
| **Licence ledger** | `license-ledger.jsonl` | You lose the record of who bought what. Keys still work — they are signed, not registered — but you cannot answer "did this person pay?" |
| **Updater signing key** | `.secrets/vyuha-updater.key` | Auto-update breaks for every existing install, and fixing it needs a new keypair plus one manual reinstall by every customer. This already happened once (see below). |

> **Back up all three together, offline, today.** The pem without the ledger
> leaves you unable to answer support questions; the ledger without the pem
> leaves you unable to serve them.

---

## Cutting a release

```bash
npm run verify          # typecheck + lint + full test suite + production build
npm run test:e2e        # full browser-flow suite
npm run bump-version x.y.z
# then BY HAND (bump-version does not touch them — see AGENTS.md):
#   package-lock.json — BOTH "version" fields (root and packages."")
#   src-tauri/Cargo.lock — the [[package]] vyuha version
npm run desktop:build   # builds, signs, and REFUSES to ship unsigned
node scripts/build-client-package.mjs   # rebuild the client ZIP
```

**EVERY release updates the client package — no exceptions.** Before building
the ZIP: prepend a buyer-voice "New in vX.Y.Z" table to `docs/client/README.md`,
sync `docs/client/INSTALLATION_GUIDE.md` (supported imports, API pulls,
security claims) and check `GETTING_STARTED_DECK.html` for retired SKU names or
stale prices. The ZIP packs those three files fresh at build time (WHATS_NEW.md
inside the package IS `docs/client/README.md`), so stale docs ship to a buyer
if this step is skipped. The docs and the package drifted apart across four
releases once (2026-08-12) — that is why this paragraph exists.

`desktop:build` now fails rather than producing an unsigned installer. Two
guards stand behind that, both added after real incidents:

- **Portability guard** — refuses if the bundle contains a symlink, an empty
  external package, or a missing `better-sqlite3` binding. v2.90.0 shipped a
  69-byte symlink pointing at the build machine's own `node_modules`; it ran
  perfectly here and died on every other computer.
- **Signing guard** — refuses to start without `.secrets/vyuha-updater.key`,
  and fails afterwards if no `.sig` was produced. v2.84 through v2.90 all
  shipped unsigned because Tauri only prints a notice at the very end of a
  long build.

Deliberate unsigned build: `VYUHA_ALLOW_UNSIGNED=1 npm run desktop:build`.

**Upload BOTH `Vyuha_x.y.z_x64-setup.exe` and its `.sig`** to the GitHub
release. An installer without its signature is the same silent failure again.

### After publishing — two minutes, every release

The installer is **not** code-signed (a recorded decision), and SmartScreen
reputation accrues **per file hash** — so every release starts cold no matter
how many people installed the last one. At this project's release cadence that
means essentially every buyer meets a cold warning. Two free mitigations, both
of which must happen *after* the release is public:

1. **`npm run winget:manifest`** → then
   `wingetcreate submit --token <gh-token> release-packages/winget/<version>`.
   Once the listing exists, `winget install ThejeshK.Vyuha` installs with no
   SmartScreen prompt at all, because winget fetches without the
   mark-of-the-web. Put that command in the purchase email as the recommended
   path.
2. **Submit the .exe to Microsoft** at
   <https://www.microsoft.com/en-us/wdsi/filesubmission> (Software developer →
   false positive). Seeds reputation for that hash before buyers download it.
   A web form; there is no API.

Details and the reasoning: [`CODE_SIGNING.md`](CODE_SIGNING.md).

---

## Selling to a client

```bash
node scripts/license-issue.mjs buyer@mail.com app --years 1 --machine ABCD-EF12-3456   # Annual
node scripts/license-issue.mjs buyer@mail.com app --machine ABCD-EF12-3456             # Lifetime
node scripts/license-list.mjs --expiring 30      # renewals due
node scripts/license-list.mjs buyer@mail.com     # find one buyer
node scripts/license-revoke.mjs A1B2-C3D4-E5 "refunded"
```

Four habits that matter once you are past a handful of customers:

1. **`--years 1`, not lifetime.** Renewals are the revenue, and
   `--expiring 30` becomes your reminder list.
2. **`--machine` on every paid key.** It is the only thing that stops one key
   circulating in a WhatsApp group. The buyer reads their Machine ID from
   Settings → License, so delivery becomes two-step.
3. **A `--note` per sale** (invoice number, WhatsApp handle) so a support
   thread resolves with one `grep`.
4. **Revocation has two speeds — use both.**
   `node scripts/revocation-publish.mjs --add <KEY-ID> --message "…"` publishes a
   signed list the app downloads during its launch update check: the user gets a
   14-day countdown banner, then the key stops. `node scripts/license-revoke.mjs
   <KEY-ID>` bakes it into future builds so it can never come back. The signed
   list **fails open offline** and does not survive a patched binary — know both
   limits before you write a refund policy.

Full operational detail: [`LICENSE_OPERATIONS.md`](LICENSE_OPERATIONS.md).

---

## What is in here

| File | What it is for |
|---|---|
| [`LICENSE_OPERATIONS.md`](LICENSE_OPERATIONS.md) | Issuing, binding, revoking, and the honest limits of each |
| [`MONETIZATION_PLAN.md`](MONETIZATION_PLAN.md) | Pricing, SKUs, and the reasoning behind them |
| [`GROWTH_ENGINE_PLAN.md`](GROWTH_ENGINE_PLAN.md) | Acquisition channels and funnel |
| [`INDICATORS_LAUNCH_KIT.md`](INDICATORS_LAUNCH_KIT.md) | TradingView indicator copy, publishing steps, source protection |
| [`PINE_SCRIPT_INVITE_ONLY.md`](PINE_SCRIPT_INVITE_ONLY.md) | Invite-only publication mechanics |
| [`HOW_TO_EDIT_SALES_ASSETS.md`](HOW_TO_EDIT_SALES_ASSETS.md) | Editing the landing page and brochure in `docs/sales/` |
| [`CODE_SIGNING.md`](CODE_SIGNING.md) | Updater signing, and what the guards enforce |
| `updater-public-key.txt` | The CURRENT updater public key, matching `tauri.conf.json` |

### A note on the updater key

The public key **changed at v2.91.0**. The original private key was never kept,
so it could not be recovered. Installs at **v2.82 or earlier** will reject
updates signed with the new key and need one manual reinstall. Everything from
v2.84 to v2.90 shipped unsigned anyway, so nothing that previously worked was
lost — but this is exactly the cost of losing a signing key, and it is why the
backup advice above is the first thing on this page.
