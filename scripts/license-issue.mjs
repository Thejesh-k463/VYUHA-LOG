// Mint a license key after a sale (vendor-side; needs license-private.pem from keygen).
// Usage: node scripts/license-issue.mjs <buyer-email> [sku]   (sku: toolkit | app | indicators)
import { sign, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const [email, sku = "toolkit"] = process.argv.slice(2);
if (!email || !email.includes("@")) {
  console.error("Usage: node scripts/license-issue.mjs <buyer-email> [toolkit|app|indicators]");
  process.exit(1);
}
if (!["toolkit", "app", "indicators"].includes(sku)) {
  console.error(`Unknown sku "${sku}" — use toolkit | app | indicators`);
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privPem = readFileSync(path.join(root, "license-private.pem"), "utf8");

const payload = Buffer.from(JSON.stringify({ email, sku, issued: new Date().toISOString().slice(0, 10) }), "utf8");
const signature = sign(null, payload, createPrivateKey(privPem));
const key = `VYUHA-${payload.toString("base64url")}.${signature.toString("base64url")}`;

console.log(key);
