// Vendor-side: stop a key from activating in FUTURE builds.
//
// Usage:
//   node scripts/license-revoke.mjs A1B2-C3D4-E5 "refunded 2026-07-22"
//   node scripts/license-revoke.mjs --list
//   node scripts/license-revoke.mjs --undo A1B2-C3D4-E5
//
// Writes the ID into scripts/license-revoked.mjs AND into the REVOKED_KEY_IDS
// array in lib/license.ts, which is what actually ships.
//
// READ THIS BEFORE RELYING ON IT
// ------------------------------
// Vyuha is offline by design: there is no server for the app to ask "is this
// key still good?". Revocation is therefore a BUILD-TIME list. A revoked key
// keeps working on machines already running an older build, and only stops
// working once the user installs a build issued after the revocation.
//
// That makes this useful for what it is — stopping a leaked or refunded key
// from activating new installs — and useless as an instant kill switch. Adding
// a real kill switch would mean phoning home on launch, which is the one thing
// this product promises never to do.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const revokedPath = path.join(root, "scripts", "license-revoked.mjs");
const libPath = path.join(root, "lib", "license.ts");

const ID_RE = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{2}$/;

function readIds() {
  const src = readFileSync(revokedPath, "utf8");
  const m = src.match(/export const REVOKED_IDS = \[([\s\S]*?)\];/);
  if (!m) throw new Error("Could not parse scripts/license-revoked.mjs");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function writeIds(ids, notes) {
  const body = ids.length
    ? "\n" + ids.map((id) => `  ${JSON.stringify(id)},${notes[id] ? ` // ${notes[id]}` : ""}`).join("\n") + "\n"
    : "";
  const src = readFileSync(revokedPath, "utf8");
  writeFileSync(revokedPath, src.replace(/export const REVOKED_IDS = \[[\s\S]*?\];/, `export const REVOKED_IDS = [${body}];`));

  // Patch the shipped list too — lib/license.ts is what the app actually reads.
  const lib = readFileSync(libPath, "utf8");
  const libBody = ids.length ? "\n" + ids.map((id) => `  ${JSON.stringify(id)},`).join("\n") + "\n" : "";
  const patched = lib.replace(
    /export const REVOKED_KEY_IDS: readonly string\[\] = \[[\s\S]*?\];/,
    `export const REVOKED_KEY_IDS: readonly string[] = [${libBody}];`,
  );
  if (patched === lib) throw new Error("Could not find REVOKED_KEY_IDS in lib/license.ts to patch.");
  writeFileSync(libPath, patched);
}

// Notes live as trailing comments in license-revoked.mjs.
function readNotes() {
  const src = readFileSync(revokedPath, "utf8");
  const out = {};
  for (const m of src.matchAll(/"([^"]+)",\s*\/\/ (.+)/g)) out[m[1]] = m[2].trim();
  return out;
}

const args = process.argv.slice(2);
const ids = readIds();
const notes = readNotes();

if (args[0] === "--list" || args.length === 0) {
  if (ids.length === 0) console.log("No revoked keys.");
  else for (const id of ids) console.log(`${id}${notes[id] ? `  — ${notes[id]}` : ""}`);
  process.exit(0);
}

if (args[0] === "--undo") {
  const id = (args[1] ?? "").toUpperCase();
  if (!ids.includes(id)) { console.error(`${id} is not in the revocation list.`); process.exit(1); }
  const next = ids.filter((x) => x !== id);
  delete notes[id];
  writeIds(next, notes);
  console.log(`✓ ${id} un-revoked. It will activate again in builds issued from now on.`);
  process.exit(0);
}

const id = (args[0] ?? "").toUpperCase();
const reason = args[1] ?? "";
if (!ID_RE.test(id)) {
  console.error(`Bad key id "${args[0]}" — expected the form A1B2-C3D4-E5 (see Settings → License, or license-list.mjs).`);
  process.exit(1);
}
if (ids.includes(id)) { console.error(`${id} is already revoked.`); process.exit(1); }

ids.push(id);
if (reason) notes[id] = reason;
writeIds(ids, notes);

console.log(`✓ ${id} revoked${reason ? ` (${reason})` : ""}.`);
console.log("  Takes effect only in builds released AFTER this change — bump, build and publish to enforce it.");
