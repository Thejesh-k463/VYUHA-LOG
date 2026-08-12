// Build and SIGN the revocation list that reaches installed copies.
//
// Usage:
//   node scripts/revocation-publish.mjs [--out PATH] [--grace-days N]
//   node scripts/revocation-publish.mjs --add A1B2-C3D4-E5 --grace-days 14 \
//        --message "Refunded 2026-08-12. Contact +91… if this is wrong."
//
// ── How this reaches a user ─────────────────────────────────────────────────
//
// The output file is published as the single asset of a PERMANENT GitHub
// release tagged `revocations` — not on the app release, and not via
// `releases/latest/…`, which re-points at every new version and would silently
// 404 the list (un-revoking everyone) the first time a release shipped without
// someone remembering to re-upload it. One-time setup:
//
//   gh release create revocations --prerelease \
//     --title "Licence revocations" \
//     --notes "Signed revocation list fetched by installed copies at launch."
//
// ⚠ `--prerelease` IS NOT OPTIONAL. GitHub picks "latest release" as the most
// recent non-draft, NON-PRERELEASE release by creation date — across every tag,
// not just version-shaped ones. Created without the flag, this release becomes
// `releases/latest`, and the updater endpoint baked into tauri.conf.json
// (`releases/latest/download/latest.json`) 404s on it: auto-update dies for
// every installed copy, silently, because the updater fails open. That
// happened for real on 2026-08-12 and was caught only by checking
// /releases/latest afterwards. The flag does NOT affect the direct
// `releases/download/revocations/revocations.json` URL this feature uses.
//
// The desktop shell downloads it during the version check it already performs
// at launch, caches it in the app-data directory, and lib/revocation.ts
// verifies the signature locally.
//
// Nothing is uploaded by the app: it is a public list going DOWN, never a key
// or a machine id going UP. That distinction is what lets every "your data
// never leaves this machine" claim stay true.
//
// ── What it cannot do ───────────────────────────────────────────────────────
//
// Fails open. Someone offline, or who blocks github.com before their first
// launch after you publish, never receives it. Once received it persists and
// cannot be rolled back (the app ratchets on `issuedAt`). It does not survive
// a patched binary. Use it for refunds, chargebacks and leaked keys — not as
// a substitute for pricing the product as if copying is possible.
//
// Entries come from scripts/license-revoked.mjs (the same source of truth the
// build-time list uses), so `license-revoke.mjs` remains the one command that
// records a revocation; this one only publishes what is already recorded.

import { sign, createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { REVOKED_IDS } from "./license-revoked.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const outPath = path.resolve(opt("--out") ?? path.join(root, "release-packages", "revocations.json"));
const graceDays = Number(opt("--grace-days") ?? 14);
const addId = opt("--add");
const message = opt("--message");

if (!Number.isInteger(graceDays) || graceDays < 0) {
  console.error(`--grace-days must be a whole number of days (got "${opt("--grace-days")}")`);
  process.exit(1);
}

// ── Assemble the entries ────────────────────────────────────────────────────
//
// Every id already recorded by license-revoke.mjs, plus an optional one-off
// passed on the command line (which you should still record properly).
const ids = [...new Set([...REVOKED_IDS, ...(addId ? [addId.trim().toUpperCase()] : [])])];
if (addId && !REVOKED_IDS.includes(addId.trim().toUpperCase())) {
  console.error(`  ! ${addId} is not in scripts/license-revoked.mjs.`);
  console.error(`    Record it first: node scripts/license-revoke.mjs ${addId} "reason"`);
  console.error(`    Publishing it here alone leaves no durable record and no build-time backstop.\n`);
}

const effectiveFrom = new Date(Date.now() + graceDays * 86_400_000).toISOString().slice(0, 10);
const list = {
  vyuhaRevocations: true,
  v: 1,
  issuedAt: new Date().toISOString(),
  entries: ids.map((keyId) => ({
    keyId,
    ...(graceDays > 0 ? { effectiveFrom } : {}),
    ...(message ? { message } : {}),
  })),
};

// The canonical bytes MUST match lib/revocation-format.ts#canonicalListBytes
// exactly — a key-order difference here is a signature that verifies nowhere.
const canonical = JSON.stringify({
  vyuhaRevocations: true,
  v: list.v,
  issuedAt: list.issuedAt,
  entries: list.entries.map((e) => ({
    keyId: e.keyId,
    ...(e.effectiveFrom ? { effectiveFrom: e.effectiveFrom } : {}),
    ...(e.message ? { message: e.message } : {}),
  })),
});

const privPem = readFileSync(path.join(root, "license-private.pem"), "utf8");
const signature = sign(null, Buffer.from(canonical, "utf8"), createPrivateKey(privPem)).toString("base64url");

writeFileSync(outPath, JSON.stringify({ list, signature }, null, 2) + "\n");

console.log(outPath);
console.error(`\n  entries    : ${ids.length}${ids.length ? ` (${ids.join(", ")})` : " — an EMPTY list is valid and clears nothing; it simply revokes no one"}`);
console.error(`  issued     : ${list.issuedAt}`);
console.error(`  locks on   : ${graceDays > 0 ? `${effectiveFrom} (${graceDays}-day grace — users see a warning until then)` : "immediately on receipt (no grace)"}`);
console.error(`  signed with: license-private.pem — verified in-app by the same key that verifies licences`);
console.error(`\n  Publish it to the permanent "revocations" release, asset name exactly "revocations.json":`);
console.error(`    gh release upload revocations "${outPath}" --clobber`);
console.error(`  (First time only, and --prerelease is REQUIRED or this becomes releases/latest and breaks the updater:`);
console.error(`     gh release create revocations --prerelease --title "Licence revocations" --notes "Signed revocation list.")`);
console.error(`  Installed copies pick it up at their next launch. Offline copies do not — this fails open.\n`);
