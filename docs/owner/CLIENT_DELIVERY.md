# Client delivery package

Build a source-free client ZIP only after the installer has been built ("signed" below means the
updater signature — the `.sig` — NOT Authenticode; the installer is deliberately not code-signed,
see `CODE_SIGNING.md`):

```powershell
npm run desktop:build
npm run client:package
```

The ZIP in `release-packages/` contains only the signed installer, its updater
signature, SHA-256 checksums, and activation instructions. It excludes the
repository, source code, local databases, vendor private keys, updater signing
keys, and licence ledger.

## Recommended delivery flow

1. Send the generic ZIP after payment.
2. The buyer installs it and sends the Machine ID from **Settings → License**.
3. Issue their machine-bound app key:

   ```powershell
   VYUHA_LICENSE_NOTE="UTR …" node scripts/license-issue.mjs buyer@example.com app --years 1 --machine ABCD-EF12-3456
   ```

4. Send the key separately in the purchase email.

To make one licensed ZIP, save the already-issued key in a protected file and
run:

```powershell
npm run client:package -- --license-file C:\secure\buyer-key.txt
```

That creates a `_Licensed.zip` containing `LICENSE.txt`; treat it as a
credential and do not forward or reuse it for another buyer.

## Security boundary

The private licence key and updater signing key never leave the vendor
environment. Signed, machine-bound keys limit ordinary use, but an offline
desktop application cannot make copying or reverse engineering impossible.
Do not promise absolute DRM; use source-free distribution, per-buyer keys,
machine binding for higher-risk sales, future-release revocation, and the
buyer identity shown in-app as practical controls.
