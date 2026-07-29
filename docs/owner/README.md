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
npm run verify          # typecheck + lint + 794 tests + production build
npm run test:e2e        # 13 browser flows
npm run bump-version 2.94.0
npm run desktop:build   # builds, signs, and REFUSES to ship unsigned
```

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

Details: [`CODE_SIGNING.md`](CODE_SIGNING.md).

---

## Selling to a client

```bash
node scripts/license-issue.mjs buyer@mail.com toolkit --years 1 --machine ABCD-EF12-3456
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
4. **Revocation is build-time.** A revoked key keeps working until the client
   installs a build containing the revocation. There is no kill switch, and
   adding one would mean a server call on launch — which is the opposite of
   what this product is sold on. Know this before promising a refund policy.

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
