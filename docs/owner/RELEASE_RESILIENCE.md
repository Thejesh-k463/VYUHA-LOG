# If GitHub is down — what breaks, what does not, and the three habits that make it a non-event

Written 2026-08-19 after GitHub's August 2026 capacity incidents (an ~8-hour outage of web, API,
Actions, Pages and Copilot; 13 incidents in 17 days; GitHub's CTO publicly revising capacity
planning from 10× to 30×; Microsoft renting AWS capacity for GitHub). The "Cursor will kill
GitHub" framing in circulation is commentary, not a fact — but the outages are real.

## What Vyuha depends on GitHub for (and what happens during an outage)

| Dependency | During an outage | Why it is survivable |
|---|---|---|
| Source hosting (`origin`) | Cannot push/pull | The repo's source of truth is the local clone; nothing is lost, only delayed |
| CI (`ci.yml`) + Release workflow | Builds and release-gating stall | `npm run desktop:build` + `npm run release:verify` run locally; the release *rule* (CI green before tag) simply waits |
| Releases CDN (`releases/latest/download/latest.json`, installers) | New downloads fail; auto-updater cannot reach the manifest | The updater **fails open by design** — installed copies keep working; the check retries at next launch |
| Revocation list (`releases/download/revocations/revocations.json`) | Not fetched that day | Fails open by design (documented in LICENSE_OPERATIONS §4); a revoked key stops at the next successful launch |
| GitHub Pages (landing page) | Landing page unreachable | The standalone HTML (`docs/sales/landing-page.standalone.html`) is the fallback attachment |
| Buyer delivery | **Unaffected** | Delivery is the client ZIP by email/WhatsApp — never a GitHub link |

**Nothing in the licence system lives on GitHub.** The private key, the ledger and the updater
signing key are local, gitignored files. The real single point of failure is the build machine's
disk, not GitHub.

## The three habits (≈3 minutes per release)

1. **Mirror the history to a second host.** One-time: create an empty *private* repo on Codeberg,
   GitLab or Bitbucket (a human must create the account), then
   `git remote add mirror <url>`. Per release: `npm run mirror:push` (pushes `main` + tags; secrets
   are gitignored so they can never reach the mirror by construction).
2. **Archive the artifacts off the repo tree.** `npm run release:archive -- <drive>` copies the
   installer, MSI, both `.sig`, the client ZIP, winget manifests and a fresh `CHECKSUMS.txt` into
   `<drive>/Vyuha_<version>/`. Refuses to overwrite. Serve a buyer from there if Releases is down.
3. **Back up the keys, encrypted, off the machine.** `node scripts/license-backup.mjs <dir>`
   (AES-256-GCM; passphrase via prompt or `VYUHA_BACKUP_PASSPHRASE`) bundles
   `license-private.pem` + `license-ledger.jsonl`. Also copy `.secrets/vyuha-updater.key`
   into the same encrypted folder by hand (it is not in the bundle — it signs installers, not
   licences). Do this before the first real sale and after every batch of sales.

## What not to do

- Do not move CI off GitHub to "fix" this — the outage cost is delay, not loss; a second CI is a
  second lockfile-breaking surface.
- Do not publish installers anywhere public other than Releases/winget — SmartScreen reputation
  accrues per file hash per download origin.
- Do not mirror to a *public* repo — the mirror is a backup, not a second storefront.
