---
name: release
description: Release procedure for Vyuha desktop builds — version bump, lockfile safety, signing-key verification, installer freshness, CI gating, the revocation-list prerelease trap, and the claims audit. Use before cutting a release, bumping a version, building an installer or client package, publishing a revocation list, tagging, or whenever about to say a release is ready. Every step exists because skipping it shipped a broken release.
---

# Releasing Vyuha

This is not a formality. Every item below is here because its absence shipped
something broken to real machines:

- v1.12–v1.20 shipped installers **frozen at v1.11**.
- v2.90.0's installer **ran on no machine but the build machine**.
- v2.99.5 broke **all four CI jobs** via a lockfile re-resolve.
- v2.99.91's revocation list **stole `releases/latest`** and killed auto-update.
- v2.99.94 retired **four marketing claims that were not true**.

Work top to bottom. Do not batch, do not skip because "nothing changed there".

---

## 1. Gate — `npm run verify`, never `npm test`

```
npm run verify
```

This is `typecheck && lint && test && build`. The build step is not optional
padding: `typecheck + lint + test` all pass on code that **cannot be bundled**,
because client components import `lib/license.ts`, so anything in its import
graph must stay browser-safe. A `node:child_process` import there fails only at
`next build`.

Record the test count. If it went *down* versus the last release, a test was
deleted — find out why before continuing.

---

## 2. Version bump — and the two files it does NOT touch

```
npm run bump-version x.y.z
```

Syncs `package.json`, `tauri.conf.json`, `Cargo.toml`, and the sidebar footer.

It does **not** sync:
- `src-tauri/Cargo.lock` — needs a `cargo` invocation
- `package-lock.json` root version fields — **edit BY HAND**

**Never run npm to fix the lock version.** A stale root version in the lock is
harmless. A re-resolved lock is not — see §3.

---

## 3. The lockfile rule — the most expensive mistake available

**Never let npm rewrite `package-lock.json`. Not even a plain `npm install`.**

On this dependency graph, a plain `npm install <pkg>` — no flags, fully
installed tree — deterministically prunes vitest's nested `esbuild@0.28.x` and
its 26 `@esbuild/*` platform entries. vitest's `vite` requires
`esbuild ^0.27||^0.28`, so the prune leaves it resolving to the top-level
0.25.x: `npm ls esbuild` reports ELSPROBLEMS and **`npm ci` fails on every
platform, Windows included.**

`--package-lock-only` is not a safe alternative — it drops the darwin/linux
optional-dep variants and broke all four CI jobs at v2.99.5.

To add a dependency, use the hand-merge procedure in `AGENTS.md` § Adding a
dependency, then prove it: `npm ci` clean, `npm ls esbuild` resolves, and
`git diff --numstat package-lock.json` shows **additions only**.

---

## 4. Build — and prove the installer is not last week's

```
npm run desktop:build
```

Needs Rust + MSVC. In Git Bash:
`export PATH="$(cygpath "$USERPROFILE")/.cargo/bin:$PATH"`

It always rebuilds the web bundle — **do not shortcut it.**

Then prove freshness two ways, because "Build succeeded" is a claim the process
makes about itself:

1. `desktop-dist/.next/BUILD_ID` modification time is from **this** build.
2. **Grep the bundle for a string only the newest feature introduces.**

Skipping step 2 is exactly how v1.12 through v1.20 shipped a v1.11 binary.

---

## 5. Signing — compare identifiers, never adjectives

**The updater signing key is `.secrets/vyuha-updater.key`, and nothing else.**
Its public half must equal `plugins.updater.pubkey` in `tauri.conf.json`.

| | |
|---|---|
| Live key id | `4FF85F3BBE1DA21D` |
| Stale key id (v2.91.0 rotation) | `8FFAF1B491EAD2F0` |

The stale root `updater-private.key` was **deleted on 2026-08-14** — verified
first that nothing read it, that all 31 `.sig` files on disk carry
`4FF85F3BBE1DA21D`, and that `scripts/tauri-build.mjs:35` resolves only the
`.secrets` key. If a copy ever reappears from a backup, **delete it again**:
signing with it produces a `.sig` the build reports as valid **while every
installed copy rejects the update**, which is exactly what it did to v2.98.0.

- `scripts/tauri-build.mjs` resolves the correct key automatically. **Do not set
  `TAURI_SIGNING_PRIVATE_KEY` by hand to route around it.**
- The CI secret `TAURI_SIGNING_PRIVATE_KEY` must hold the `.secrets` key.
- **Verify by decoding the signature's key id.** `✓ signed` tells you a
  signature exists, not that it is the right one.

```
npm run release:verify v3.3.0 -- --deep
```

**Use `--deep`.** Without it the script decodes key ids, which proves a signature
was *made* by the right key. `--deep` downloads each artefact and proves the
signature actually *verifies* over the published bytes — the claim users'
machines test, and the one v2.98.0 failed while every key id looked fine. It
costs ~220 MB of downloads and a couple of minutes; a broken update costs a
release.

If `--deep` fails while the key ids pass, the signing key is fine and the
**artefact and its signature disagree** — something re-wrote or re-uploaded an
asset after signing. Delete the draft and re-run the workflow; never re-upload
by hand.

Two traps recorded in `scripts/minisign-verify.mjs`, both pinned by
`tests/minisign-verify.test.ts`: minisign's `ED` is prehashed BLAKE2b-512 and
`Ed` is pure (inverting them reports a good release as broken), and key ids are
stored little-endian.

---

## 6. CI gates — Windows before the tag

- Node is pinned to **22.17.0**. Do not float it.
- Windows is tested **BEFORE** tagging, not after.
- CI refuses to bless an incomplete release. If it refuses, it is right — do not
  hand-publish around it.

---

## 7. Install on a machine that is not the build machine

v2.90.0 passed every check and ran **only** on the machine that built it. A
build machine has toolchains, runtimes and certificates a customer's does not.

Install the actual artifact somewhere clean before calling the release good.

---

## 8. Revocation list — it MUST be a prerelease

```
npm run release:revocations
```

**The revocation list's own release must be published as a PRERELEASE.** If it
is a normal release it takes `releases/latest`, and every installed copy stops
auto-updating.

The direction is fixed and non-negotiable: **the list travels down, nothing
travels up.**

---

## 9. Release-day SmartScreen (2 minutes, free)

Both live in `docs/owner/CODE_SIGNING.md`:

1. `npm run winget:manifest`
2. Submit the installer to Microsoft.

---

## 10. Claims audit — the product must not lie about itself

v2.99.94 existed almost entirely to retire four claims that were not true: PDF
described as an importer when it only extracts text, prices claiming to include
tax that was never charged, a download promise that did not match delivery, and
a macOS build implied but not packaged.

Before publishing, check that the landing page, README, brochure, install guide
and in-app copy each describe **what actually ships this version** — including
what is *not* signed, *not* notarised, and *not* automatic.

Honesty is this product's stated differentiator. A false claim costs more here
than a missing feature.

---

## 11. Report evidence, not adjectives

> "1,626 tests / 116 files pass (was 1,626), `npm run verify` clean.
> `BUILD_ID` 2026-08-14T…, bundle contains the v2.99.95 marker string.
> Signature key id `4FF85F3BBE1DA21D` matches `tauri.conf.json`.
> Installed and launched on a non-build machine. Revocation list published as
> prerelease; `releases/latest` still points at v2.99.95."

Anything you could not verify, say so plainly. See the `prove-it` skill.

Record anything you measured or deviated from in `docs/DECISIONS.md` — use the
`decision-log` skill.
