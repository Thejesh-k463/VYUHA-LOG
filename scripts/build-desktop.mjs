// Assemble a self-contained desktop runtime from the Next standalone build, plus a
// migrated + seeded template DB. Run AFTER `next build`. Output: ./desktop-dist
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const dist = path.join(root, "desktop-dist");
const standalone = path.join(root, ".next", "standalone");

if (!fs.existsSync(path.join(standalone, "server.js"))) {
  console.error("✗ .next/standalone/server.js not found. Run `next build` first (output: 'standalone').");
  process.exit(1);
}

console.log("• assembling desktop-dist …");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// 1. standalone server + traced node_modules
//
// `dereference: true` is LOAD-BEARING, not a tidy-up.
//
// Next 16 stages every `serverExternalPackages` entry as a SYMLINK under
// .next/node_modules/<pkg>-<hash>, pointing at an ABSOLUTE path inside the
// developer's checkout — e.g.
//   better-sqlite3-90e2652d1716b047 -> /home/dev/vyuha/node_modules/better-sqlite3
// and the compiled server requires it by that hashed name. Copying the link
// verbatim produces an installer that works perfectly on the build machine and
// dies on every other one with:
//   Cannot find module 'better-sqlite3-90e2652d1716b047'
// It also silently shrinks the installer, because two real packages become two
// 69-byte links — which is what makes the failure so easy to miss.
fs.cpSync(standalone, dist, { recursive: true, dereference: true });
// the standalone bundle ships an empty data dir we don't use (DB lives in app-data)
fs.rmSync(path.join(dist, "data"), { recursive: true, force: true });

// 1b. Materialise any symlink the copy left behind.
//
// `dereference: true` above is not sufficient on Windows, where these externals
// are DIRECTORY symlinks/junctions that fs.cpSync copies as links regardless.
// So they are replaced explicitly with real content: read the link, copy the
// target's files in, delete the link. Done depth-first and repeatedly until the
// tree is clean, because a dereferenced target can itself contain links.
function materialiseSymlinks(root) {
  let replaced = 0;
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        const target = fs.realpathSync(p);
        if (!fs.existsSync(target)) {
          throw new Error(`dangling symlink in bundle: ${p} -> ${target}`);
        }
        fs.rmSync(p, { recursive: true, force: true });
        fs.cpSync(target, p, { recursive: true, dereference: true });
        replaced++;
        continue;
      }
      if (e.isDirectory()) visit(p);
    }
  };
  visit(root);
  return replaced;
}
const linksFixed = materialiseSymlinks(dist);
if (linksFixed > 0) console.log(`• materialised ${linksFixed} symlink(s) into real directories`);

// 2. static assets + public (standalone does not copy these)
fs.cpSync(path.join(root, ".next", "static"), path.join(dist, ".next", "static"), { recursive: true });
if (fs.existsSync(path.join(root, "public"))) {
  fs.cpSync(path.join(root, "public"), path.join(dist, "public"), { recursive: true });
}

// 3. launcher + migrations (so the launcher can upgrade existing user DBs)
fs.copyFileSync(path.join(root, "scripts", "desktop-server.mjs"), path.join(dist, "desktop-server.mjs"));
fs.cpSync(path.join(root, "drizzle"), path.join(dist, "drizzle"), { recursive: true });
// Ensure the full drizzle-orm package (incl. the migrator submodule) is bundled —
// Next's file tracing may omit files the app never imports directly.
fs.cpSync(path.join(root, "node_modules", "drizzle-orm"), path.join(dist, "node_modules", "drizzle-orm"), { recursive: true });

// 4. migrated + seeded template DB (empty journal)
console.log("• building seed template DB …");
const seedPath = path.join(dist, "vyuha.seed.sqlite");
for (const s of ["", "-wal", "-shm"]) fs.rmSync(seedPath + s, { force: true });
const env = { ...process.env, VYUHA_DB_PATH: seedPath };
execFileSync("npx", ["tsx", "lib/db/migrate.ts"], { stdio: "inherit", shell: true, env });
execFileSync("npx", ["tsx", "lib/db/seed.ts"], { stdio: "inherit", shell: true, env });
// drop wal sidecars so the template is a single file
for (const s of ["-wal", "-shm"]) fs.rmSync(seedPath + s, { force: true });

// 5. bundled Node runtime — zero-dependency installer (the shell prefers this
// over system `node`). We ship the exact Node binary that built the bundle
// (same platform/arch as the installer target). Node is MIT-licensed; ship its
// LICENSE alongside. Skip gracefully if the running Node isn't a plain file
// (e.g. a shim), falling back to the system-node requirement.
try {
  const nodeDir = path.join(dist, "node");
  fs.mkdirSync(nodeDir, { recursive: true });
  const exeName = process.platform === "win32" ? "node.exe" : "node";
  const nodeOut = path.join(nodeDir, exeName);
  fs.copyFileSync(process.execPath, nodeOut);
  // macOS and Linux need the execute bit explicitly. copyFileSync does NOT
  // carry the source mode across on every platform/filesystem, and a bundled
  // node without +x fails at spawn with a bare EACCES — after the installer has
  // already been built, signed and published.
  if (process.platform !== "win32") fs.chmodSync(nodeOut, 0o755);
  const nodeLicense = path.join(path.dirname(process.execPath), "LICENSE");
  if (fs.existsSync(nodeLicense)) fs.copyFileSync(nodeLicense, path.join(nodeDir, "LICENSE"));
  console.log(`• bundled Node ${process.version} (${process.platform}/${process.arch}) → node/${exeName}`);
} catch (e) {
  console.warn("! could not bundle the Node runtime — installer will need system Node:", e.message);
}

// 6. PORTABILITY GUARD — the bundle must contain nothing that only resolves on
// this machine. A symlink here is not a style problem: it is an installer that
// works for the developer and fails for every customer, which is the single
// most expensive class of bug this project can ship.
//
// Every external package the server requires is also checked to actually be
// present and non-empty, because a dangling link that got dereferenced into an
// empty directory would pass a naive "no symlinks" test.
console.log("• verifying the bundle is machine-independent …");
const problems = [];

function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) { fn(p, "symlink"); continue; }
    if (e.isDirectory()) walk(p, fn);
  }
}
walk(dist, (p, kind) => {
  if (kind === "symlink") problems.push(`symlink survives into the bundle: ${path.relative(dist, p)} -> ${fs.readlinkSync(p)}`);
});

// The hashed external-package directories the compiled server requires by name.
const extDir = path.join(dist, ".next", "node_modules");
if (fs.existsSync(extDir)) {
  for (const name of fs.readdirSync(extDir)) {
    const p = path.join(extDir, name);
    const hasFiles = fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0;
    if (!hasFiles) problems.push(`external package is empty: .next/node_modules/${name}`);
  }
}

// Native bindings must be real files, or the app dies the moment it opens the DB.
const nativeGlob = path.join(dist, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
if (!fs.existsSync(nativeGlob)) problems.push("better-sqlite3 native binding is missing from the bundle");

if (problems.length > 0) {
  console.error("\n✗ BUNDLE IS NOT PORTABLE — refusing to produce an installer:\n");
  for (const p of problems) console.error("   •", p);
  console.error("\nThis build would run on this machine and fail on a customer's.\n");
  process.exit(1);
}
console.log("✓ no symlinks, all externals materialised");

console.log("✓ desktop bundle ready at", dist);
