# winget listing + Microsoft file submission — the two release-day actions

The installer is unsigned (owner decision, `CODE_SIGNING.md`). These two free
actions are the whole mitigation, and each one is **per release** — SmartScreen
reputation accrues per file hash, and every build is a new hash.

## Which file? — the two actions target DIFFERENT binaries

**There are two installers per release and they are not the same file.**
`.github/workflows/release.yml` rebuilds the installer on GitHub's runners via
`tauri-action`; `npm run desktop:build` builds a separate one locally, and that
local one is what `npm run client:package` zips and what you mail a buyer.
Measured 2026-08-20 on v2.99.99: the release asset is **34,861,983 B / SHA-256
`46A3842A…4343`**, the local/ZIP build is **34,860,149 B / SHA-256
`27D8695E…3004`**. Different bytes, different hash, and SmartScreen reputation
is keyed to the hash — so **the two binaries earn reputation separately.**

| Action | Which binary | Why |
|---|---|---|
| **winget** (Part 1) | the **GitHub release asset** | The manifest's `InstallerUrl` points at the release, and the validation bot downloads that URL and hashes it. The manifest must carry the PUBLISHED hash. |
| **WDSI** (Part 2) | the installer **inside the client ZIP** | Delivery is a mailed/WhatsApped ZIP, so this is the binary a paying buyer actually double-clicks. Submitting the GitHub one spends the submission on a file no buyer runs. |

If you ever also send buyers the GitHub link, submit both — one WDSI submission
per hash a customer might execute.

## Do this on release day

1. Confirm the GitHub release `v<version>` is **public** with `Vyuha_<version>_x64-setup.exe` attached, and `npm run release:verify` has passed.
2. Get the PUBLISHED asset's hash, then `npm run winget:manifest -- --sha <SHA256>` → `release-packages/winget/<version>/`. `--sha` is **required** — the script no longer hashes your local build, because that is a different binary (see *Which file?* above).
3. First release ever: `wingetcreate submit --token <gh-token> release-packages/winget/<version>`. Every later release: `wingetcreate update ThejeshK.Vyuha --version <version> --urls <installer-url> --submit --token <gh-token>`.
4. Watch the PR on `microsoft/winget-pkgs` until the validation bot goes green (minutes) and a reviewer merges (first time: days; updates: usually same day).
5. <https://www.microsoft.com/en-us/wdsi/filesubmission> → Software developer → upload **the `.exe` extracted from `release-packages/Vyuha_<version>_Client_Package.zip`** (the binary buyers run — NOT the release asset) → "incorrectly detected" → submit. Keep the submission ID.
6. On another PC or a clean VM, download the `.exe` in a browser and note what SmartScreen shows; re-check in a week.

---

## Part 1 — winget

### Prerequisites

| Need | Detail |
|---|---|
| A **public** GitHub release with the `.exe` asset | The manifest embeds `https://github.com/Thejesh-k463/VYUHA-LOG/releases/download/v<version>/Vyuha_<version>_x64-setup.exe` and its SHA-256. The validation bot downloads that URL and hashes it; a draft/private release fails validation. Nothing has ever been submitted; v2.99.98 (published 2026-08-20) is public and is `releases/latest`, so it is the version to submit — the manifest is per version, so submit the version buyers will actually receive. |
| The package identifier | `ThejeshK.Vyuha` — hard-coded in `scripts/winget-manifest.mjs` (`PACKAGE_ID`). It is `Publisher.Package`, it is what buyers type, and **it must never change** — a new id is a new package with zero history. |
| A GitHub token for `wingetcreate` | A classic PAT with the `public_repo` scope (fine-grained: read/write on your fork of `winget-pkgs` — the tool forks the repo under your account and opens the PR from there). Nothing else. Create it at github.com → Settings → Developer settings; do not put it in the repo or in a script — pass it on the command line or let `wingetcreate` cache it (`wingetcreate token --store`). |
| `wingetcreate` itself | `winget install Microsoft.WingetCreate` (Windows 10 1809+ with App Installer). |

### Step 1 — generate the manifests

```
gh release download v<version> --repo Thejesh-k463/VYUHA-LOG --pattern Vyuha_<version>_x64-setup.exe --dir .
sha256sum Vyuha_<version>_x64-setup.exe
npm run winget:manifest -- --sha <SHA256>
```

Running it without `--sha` now exits with that same recipe. It used to hash the
local build and claim the two were "identical, since the same build produced
both" — they are not, and the resulting manifest would have failed validation
because its hash could not match its own URL.

Output: `release-packages/winget/<version>/` containing three YAML files —
`ThejeshK.Vyuha.yaml` (version manifest), `ThejeshK.Vyuha.installer.yaml`
(InstallerType `nullsoft`, Scope `user`, x64 URL + SHA-256, ReleaseDate = today)
and `ThejeshK.Vyuha.locale.en-US.yaml` (publisher, description, tags, License
`Proprietary`). Manifest schema version 1.6.0. Do not hand-edit — regenerate.

To get the SHA-256 for `--sha`: download the asset and hash it (`sha256sum`, or
`certutil -hashfile Vyuha_<version>_x64-setup.exe SHA256` on Windows), or read
the digest GitHub shows per asset on the release page. **It must be the bytes on
the RELEASE, never your local build** — those differ every time, and validation
downloads the URL and checks.

### Step 2 — validate locally (optional but cheap)

```
winget validate --manifest release-packages/winget/<version>
winget install --manifest release-packages/winget/<version>     # needs "Local manifest files" enabled: winget settings --enable LocalManifestFiles
```

### Step 3 — submit

```
wingetcreate submit --token <gh-token> release-packages/winget/<version>
```

`wingetcreate` forks `microsoft/winget-pkgs` under your account (once), commits
the three files at `manifests/t/ThejeshK/Vyuha/<version>/`, and opens a PR. It
prints the PR URL — keep it.

### What the automated checks do

Within minutes a bot labels the PR and runs validation: manifest schema, that
`InstallerUrl` is reachable, that the download's SHA-256 matches, an install and
uninstall in a Windows sandbox, and a Defender scan of the binary. Labels you
will see: `Validation-Completed` (good), `Validation-Installation-Error`,
`Validation-Hash-Verification-Failed` (you rebuilt after hashing), `Binary-Validation-Error`
(Defender flagged it — do Part 2 first, then comment on the PR),
`Needs-Author-Feedback` (answer in the PR).

Because the installer is NSIS with `Scope: user`, silent install is expected to
work with `/S`; the sandbox test uses that. If it ever fails, the fix is in the
Tauri NSIS config, not the manifest.

### What the human reviewer looks for (first submission)

That the publisher and package names are real and consistent (GitHub org,
release page, product name), the identifier follows `Publisher.Package`, the
description is not marketing copy, the licence field is honest
(`Proprietary`), and the release is stable rather than a pre-release. Expect
questions to arrive as PR comments; a first package typically takes a few days.
Updates to an existing package are mostly bot-merged once validation passes.

### Next release — update, do not resubmit

```
wingetcreate update ThejeshK.Vyuha --version <new-version> \
  --urls https://github.com/Thejesh-k463/VYUHA-LOG/releases/download/v<new-version>/Vyuha_<new-version>_x64-setup.exe \
  --submit --token <gh-token>
```

`update` copies the last merged manifest, rewrites version, URL, hash and
release date, and opens the PR. You can still run `npm run winget:manifest` to
diff against what `update` produced if the description or tags changed.

### How a buyer installs, and why it skips SmartScreen

```
winget install ThejeshK.Vyuha
```

(Also `winget upgrade ThejeshK.Vyuha` later.) `winget` downloads the same `.exe`
from the same GitHub URL, but not through a browser — so the file never gets
the **mark-of-the-web** (the `Zone.Identifier` alternate data stream a browser
writes on downloads). SmartScreen's "Windows protected your PC" interstitial is
triggered by that mark; no mark, no prompt. The Defender scan that winget's own
validation ran is the other half of why a listing reads as legitimacy.

Once the first PR is merged, put the `winget install` line in
`RECEIPT_TEMPLATE.md` / the purchase message as the recommended path, with the
`.exe` link as the fallback, and add one line to
`docs/client/INSTALLATION_GUIDE.md`.

---

## Part 2 — Microsoft file submission (WDSI)

<https://www.microsoft.com/en-us/wdsi/filesubmission>

**Which account:** any Microsoft account works, but use one you will keep and
sign in with the same one every release — the "software developer" path
associates submissions with the account, and a history of clean submissions
from the same developer helps. Prefer the account that owns the Partner
Center / Store identity if you ever create one; otherwise the owner's personal
Microsoft account is fine.

**Steps:**

1. Sign in → **"Software developer"** (not "Home customer" or "Enterprise") — this is the path whose reviewers handle publisher-side false positives.
2. Upload the `Vyuha_<version>_x64-setup.exe` **extracted from the client ZIP** (up to 500 MB; ours is ~35 MB). This is the binary buyers run; the release asset is a different file with a different hash, and reputation does not transfer between them — see *Which file?* at the top.
3. **What do you believe this file is?** → **"Incorrectly detected as malware/malicious"** (false positive). If the form asks for the detection name and Defender has not actually flagged it, write "no detection — pre-emptive reputation submission for a new unsigned release" — the reviewers accept that.
4. Company / product: Publisher **Thejesh K**, product **Vyuha**, version `<version>`, and paste the GitHub release URL so a reviewer can see the project. Say it is a NSIS installer built from a public repository, unsigned, and delivered to customers as a ZIP — note that the uploaded file is the locally built copy, which differs byte-for-byte from the release asset because the release is rebuilt in CI.
5. Submit. You get a submission ID and an email; keep both with the release notes.

**What to expect back:** an automated result in minutes to hours ("no threats
detected" / "not malware"), sometimes an analyst note within a day or two. If
Defender *had* flagged it, the definition update that clears it ships within a
day. There is no "SmartScreen approved" message — reputation is not something
they confirm; it accrues.

**Why every release:** SmartScreen keys reputation to the **file hash** and to a
signing certificate. There is no certificate here, so each `.exe` starts at zero,
and this submission is what puts the first known-good signal against that hash
before a buyer's browser asks about it. Skipping it on one release means that
release shows the interstitial to every buyer until enough people click through.

**Checking that it worked:** on a machine that has never seen the file — a
clean Windows VM (Hyper-V quick-create, or Windows Sandbox: `optionalfeatures`
→ Windows Sandbox) or another PC — download the `.exe` in Edge/Chrome from the
release page and double-click it. Note which of the three states appears:
"Windows protected your PC" with an *Unknown publisher* and only *Don't run*
(cold), the same dialog but with *More info → Run anyway* (warming), or no dialog
(reputation reached). Edge's own download warning ("isn't commonly downloaded")
is a separate SmartScreen signal and clears on the same timeline. Do not test on
the build machine — it already trusts the file. Re-check a week later; the state
usually moves one notch per release as buyers install.
