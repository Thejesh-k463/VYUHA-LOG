# Code Signing — Killing the SmartScreen Warning

**Status: prepared, dormant.** The release pipeline is already wired for Azure Trusted Signing —
it activates automatically the moment you add the Azure secrets to GitHub. Until then, releases
ship unsigned exactly as before (SmartScreen "More info → Run anyway").

Why bother: an unsigned installer is the single biggest credibility/conversion leak for a paid
product. Signing removes the scary warning, and reputation accrues to your certificate over time.

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
