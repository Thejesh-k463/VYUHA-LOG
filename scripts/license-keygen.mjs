// One-time vendor key generation. Writes license-private.pem (GITIGNORED — keep it
// safe, off the repo; losing it means you can't issue keys, leaking it means anyone can)
// and patches the PUBLIC key into lib/license.ts.
// Usage: node scripts/license-keygen.mjs
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privPath = path.join(root, "license-private.pem");
const libPath = path.join(root, "lib", "license.ts");

if (existsSync(privPath)) {
  console.error(`Refusing to overwrite existing ${privPath} — delete it first if you REALLY mean to rotate keys
(rotating invalidates every key already sold unless you keep the old public key too).`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString().trim();

writeFileSync(privPath, privPem);

const lib = readFileSync(libPath, "utf8");
const patched = lib.replace(
  /export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`;/,
  `export const LICENSE_PUBLIC_KEY_PEM = \`${pubPem}\`;`,
);
if (patched === lib) {
  console.error("Could not find LICENSE_PUBLIC_KEY_PEM in lib/license.ts to patch.");
  process.exit(1);
}
writeFileSync(libPath, patched);

console.log(`✓ Private key → ${privPath} (gitignored via *.pem — KEEP THIS SAFE, back it up privately)`);
console.log("✓ Public key patched into lib/license.ts");
console.log("Next: issue keys with  node scripts/license-issue.mjs buyer@email.com toolkit");
