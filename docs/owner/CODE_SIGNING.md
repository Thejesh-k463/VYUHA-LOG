# Code Signing — Killing the SmartScreen Warning

**Status: prepared, dormant — and deliberately so.** Owner decision (2026-08-11, v2.99.70):
users are satisfied with the branded installer wizard, so paid signing is **deferred
indefinitely**. The Azure Trusted Signing wiring below stays in place untouched — it activates
automatically if the Azure secrets are ever added to GitHub. Until then, use the free
mitigations in the next section.

Why the paid path exists at all: an unsigned installer is a credibility/conversion leak, and
signing makes reputation accrue to your *certificate* across releases instead of resetting.

---

## ✅ Do these two on every release day (2026-08-13)

Both are built and cost nothing. They are the whole of what a ₹0 signing budget
can buy, and they matter *more* the faster you ship — see item 4 below.

### 1. winget manifest — `npm run winget:manifest`

Field-by-field walkthrough of both actions (token scope, `wingetcreate submit`/`update`, what the PR bot and reviewer check, the WDSI form, how to verify on a clean PC): [`WINGET_AND_SMARTSCREEN.md`](WINGET_AND_SMARTSCREEN.md).

```bash
npm run winget:manifest          # after desktop:build, reads the local installer
npm run winget:manifest -- --sha <SHA256>   # or from the release page's hash
```

Writes the three-file manifest set to `release-packages/winget/<version>/` and
prints the submission command. It does **not** publish — that is a pull request
to `microsoft/winget-pkgs`, reviewed by a human:

```bash
wingetcreate submit --token <gh-token> release-packages/winget/<version>
```

The **first** submission is the slow one (a few days, hand-reviewed). After it
lands, put this in the purchase email as the *recommended* install path, with
the `.exe` as fallback:

```
winget install ThejeshK.Vyuha
```

`winget` fetches without the browser's mark-of-the-web, so a buyer who installs
that way **never sees the SmartScreen interstitial at all**.

⚠ The release must be **published and public** before you submit — the manifest
carries a live `InstallerUrl` and a SHA-256 that must match those exact bytes.
Submit after `npm run release:verify`, not before.

### 2. Submit the installer to Microsoft — 2 minutes, release day

<https://www.microsoft.com/en-us/wdsi/filesubmission> → **Software developer**.
Upload `Vyuha_<version>_x64-setup.exe`, say it is a false positive, and give the
GitHub release URL as the source.

This clears Defender false positives and seeds SmartScreen/Defender reputation
**for that file hash** before your buyers download it. Do it on release day —
the point is to get there first, ahead of the customer.

There is no API and no automation for this; it is a web form. It stays a manual
checklist item, which is why it is written here rather than in a script.

---

## Free mitigations (no certificate) — what actually helps

There is **no free Authenticode certificate** for a commercial product. (SignPath Foundation
signs open-source projects for free, but Vyuha is commercial — not eligible. A self-signed
certificate does nothing: SmartScreen ignores certs that don't chain to a trusted CA.) What a
₹0 budget *can* buy:

1. **Publish to winget (Windows Package Manager community repo).** Free, and the highest-value
   item here. `winget install` fetches without the browser's mark-of-the-web, so users who
   install that way never meet the SmartScreen interstitial at all — and a listing in
   Microsoft's own repo (manifests are validated and binaries scanned on submission) reads as
   legitimacy in itself. Submit a manifest per release to
   github.com/microsoft/winget-pkgs (the `wingetcreate` CLI automates the PR; it can run as a
   release.yml step later). Then put `winget install <YourId.Vyuha>` in the purchase email as
   the *recommended* install path, with the .exe as fallback.
2. **Submit each release's installer to Microsoft.** As a developer, at
   https://www.microsoft.com/en-us/wdsi/filesubmission — clears Defender false positives and
   seeds SmartScreen/Defender reputation for that file hash. Do it on release day, before
   users download.
3. **Keep the wizard guidance where it is.** docs/client/INSTALLATION_GUIDE.md already explains
   "More info → Run anyway" as step 3 and in troubleshooting — that copy is what made users
   comfortable, so it stays.
4. **Know the ceiling.** Unsigned reputation accrues **per file hash**, so every new release
   starts cold with SmartScreen no matter how many people installed the last one. That is the
   one thing only a certificate fixes — which is why the wiring below is kept, not deleted.

---

## Option comparison (pick one)

| Option | Cost | Pros / cons |
|---|---|---|
| **Azure Trusted Signing** (wired here) | ~US$9.99/mo | Cheapest; no hardware token; short-lived certs managed by Azure. **Identity validation for individuals is only offered in certain countries** — check availability for India at sign-up; organisations validate via business registration. |
| OV certificate (SSL.com, Certum, Sectigo) | ~US$70–200/yr | Works anywhere; cloud-signing variants (eSigner, SimplySign) avoid the USB token; SmartScreen reputation builds over downloads. |
| EV certificate | ~US$250–400/yr | Instant SmartScreen reputation; strictest validation; usually hardware/cloud token. |

If Azure individual validation isn't available to you in India, an **OV cert from Certum or
SSL.com with cloud signing** is the pragmatic fallback — see "Using a classic certificate
instead" at the bottom.

## Path A — Azure Trusted Signing (already wired)

### 1. One-time Azure setup (you)
1. Create an Azure account → subscription (portal.azure.com).
2. Create a **Trusted Signing account** (search "Trusted Signing" in the portal; pick a region,
   e.g. East US — note the region's endpoint URL).
3. Complete **identity validation** (individual or organisation). This is the step that can take
   days and where country eligibility matters.
4. Create a **certificate profile** (type: Public Trust) under the account.
5. Create an **App registration** (Entra ID) for CI: note its **tenant ID**, **client ID**, create
   a **client secret**. Grant the app the **"Trusted Signing Certificate Profile Signer"** role on
   the signing account (IAM → Add role assignment).

### 2. Add six GitHub repo secrets
Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `AZURE_TENANT_ID` | from the app registration |
| `AZURE_CLIENT_ID` | from the app registration |
| `AZURE_CLIENT_SECRET` | the client secret you created |
| `AZURE_ENDPOINT` | e.g. `https://eus.codesigning.azure.net` (your region) |
| `AZURE_CODE_SIGNING_NAME` | your Trusted Signing account name |
| `AZURE_CERT_PROFILE_NAME` | your certificate profile name |

### 3. Done — next tag signs automatically
The workflow detects `AZURE_CLIENT_ID`, installs `trusted-signing-cli`, and builds with
`src-tauri/tauri.signed.conf.json` overlaid, which sets Tauri's Windows `signCommand`. Both the
exe and the NSIS installer get signed; the auto-updater signature (`.sig`) is unrelated and
continues as-is.

### 4. Verify the first signed release
- Download the installer from the draft release → right-click → Properties → **Digital
  Signatures** tab shows your identity.
- `signtool verify /pa Vyuha_x.y.z_x64-setup.exe` (from any Windows SDK) reports success.
- Install on a clean machine: no SmartScreen interstitial (reputation may still show a milder
  prompt for brand-new certs; it disappears as downloads accumulate).

## Using a classic certificate instead (OV/EV fallback)

If you buy an OV/EV cert with **cloud signing** (e.g. SSL.com eSigner or Certum SimplySign),
replace the `signCommand` in `src-tauri/tauri.signed.conf.json` with the vendor's CLI invocation
(each vendor documents a one-line signtool-compatible command), and swap the `AZURE_*` secrets for
the vendor's credentials in `release.yml`. The activation mechanism (config overlay + conditional
step) stays identical.

## Notes
- **Never sign locally with production credentials** — keep signing in CI where the secret lives.
- `cargo install trusted-signing-cli` adds a few minutes per release; a cache step can be added
  later if it annoys you.
- Local/dev builds remain unsigned — only tagged releases go through the signed path.
