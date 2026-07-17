// Mint a license key after a sale (vendor-side; needs license-private.pem from keygen).
// Usage: node scripts/license-issue.mjs <buyer-email> [sku] [--expires YYYY-MM-DD | --years N]
//   sku: toolkit | app | indicators (default toolkit)
//   No expiry flag = lifetime key. --years N = annual SKU expiring N years from today.
import { sign, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
let expires = null;
for (let i = args.length - 1; i >= 0; i--) {
  if (args[i] === "--expires" && args[i + 1]) { expires = args[i + 1]; args.splice(i, 2); }
  else if (args[i] === "--years" && args[i + 1]) {
    const d = new Date();
    d.setFullYear(d.getFullYear() + Number(args[i + 1]));
    expires = d.toISOString().slice(0, 10);
    args.splice(i, 2);
  }
}
const [email, sku = "toolkit"] = args;
if (!email || !email.includes("@")) {
  console.error("Usage: node scripts/license-issue.mjs <buyer-email> [toolkit|app|indicators] [--expires YYYY-MM-DD | --years N]");
  process.exit(1);
}
if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
  console.error(`Bad --expires date "${expires}" — use YYYY-MM-DD`);
  process.exit(1);
}
if (!["toolkit", "app", "indicators"].includes(sku)) {
  console.error(`Unknown sku "${sku}" — use toolkit | app | indicators`);
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privPem = readFileSync(path.join(root, "license-private.pem"), "utf8");

const body = { email, sku, issued: new Date().toISOString().slice(0, 10) };
if (expires) body.expires = expires;
const payload = Buffer.from(JSON.stringify(body), "utf8");
const signature = sign(null, payload, createPrivateKey(privPem));
const key = `VYUHA-${payload.toString("base64url")}.${signature.toString("base64url")}`;

console.log(key);
