#!/usr/bin/env node
// Sync the app version across the 4 places it lives:
//   package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml (the [package]
//   version only), and the sidebar footer (major.minor only, e.g. "v1.6").
//
// Usage:
//   node scripts/bump-version.mjs           # use package.json's version as the source of truth
//   node scripts/bump-version.mjs 1.6.0     # set this version everywhere (incl. package.json)
//
// Idempotent: re-running with the same version is a no-op and reports "in sync".

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const pkgPath = join(root, "package.json");
const tauriPath = join(root, "src-tauri", "tauri.conf.json");
const cargoPath = join(root, "src-tauri", "Cargo.toml");
const sidebarPath = join(root, "components", "layout", "sidebar.tsx");

const SEMVER = /^\d+\.\d+\.\d+$/;

function read(p) {
  return readFileSync(p, "utf8");
}

// Resolve the target version: CLI arg wins, else package.json's current value.
const pkg = JSON.parse(read(pkgPath));
const target = process.argv[2] ?? pkg.version;
if (!SEMVER.test(target)) {
  console.error(`Invalid version "${target}" — expected MAJOR.MINOR.PATCH (e.g. 1.6.0)`);
  process.exit(1);
}
const minor = target.split(".").slice(0, 2).join("."); // "1.6.0" -> "1.6"

let changed = 0;

// 1) package.json — replace only the top-level "version" field.
{
  const src = read(pkgPath);
  const next = src.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${target}$2`);
  if (next !== src) {
    writeFileSync(pkgPath, next);
    console.log(`package.json            -> ${target}`);
    changed++;
  }
}

// 2) tauri.conf.json — top-level "version" field.
{
  const src = read(tauriPath);
  const next = src.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${target}$2`);
  if (next !== src) {
    writeFileSync(tauriPath, next);
    console.log(`tauri.conf.json         -> ${target}`);
    changed++;
  }
}

// 3) Cargo.toml — the [package] version ONLY (never dependency versions).
{
  const src = read(cargoPath);
  const next = src.replace(
    /(\[package\][\s\S]*?\nversion\s*=\s*")\d+\.\d+\.\d+(")/,
    `$1${target}$2`
  );
  if (next !== src) {
    writeFileSync(cargoPath, next);
    console.log(`Cargo.toml ([package])  -> ${target}`);
    changed++;
  }
}

// 4) sidebar.tsx footer — "v1.6" (major.minor only).
{
  const src = read(sidebarPath);
  const next = src.replace(/(Offline · v)\d+\.\d+(?:\.\d+)?/, `$1${minor}`);
  if (next !== src) {
    writeFileSync(sidebarPath, next);
    console.log(`sidebar.tsx footer      -> v${minor}`);
    changed++;
  }
}

console.log(changed === 0 ? `All 4 files already in sync at ${target}` : `Synced ${changed} file(s) to ${target}`);
