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
fs.cpSync(standalone, dist, { recursive: true });
// the standalone bundle ships an empty data dir we don't use (DB lives in app-data)
fs.rmSync(path.join(dist, "data"), { recursive: true, force: true });

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

console.log("✓ desktop bundle ready at", dist);
