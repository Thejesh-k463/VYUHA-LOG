/**
 * Run `tauri build` with the updater signing key in the environment.
 *
 * THIS SCRIPT DOES NOT BUILD THE WEB BUNDLE, AND MUST NOT. Tauri's own
 * `beforeBuildCommand` in tauri.conf.json is `npm run build && npm run
 * desktop:bundle`, so the bundle is rebuilt on every `tauri build` — including
 * in CI, where tauri-action reads that field and silently ignores a
 * `beforeBuildCommand` passed as a workflow input.
 *
 * `npm run desktop:build` used to run those two steps ITSELF and then call this
 * script, so every desktop build compiled Next twice, type-checked twice
 * (19.3s + 13.2s in the v2.99.30 log), re-seeded the template database twice
 * and re-copied an 81 MB node.exe into a 168 MB tree twice. The freshness rule
 * in AGENTS.md still holds — the bundle IS always rebuilt — it just happens
 * once now, where Tauri asks for it.
 *
 * ── Why this is a script and not just an npm flag ─────────────────────────
 *
 * `desktop:build` is three separate processes chained with `&&`. Environment
 * variables set inside build-desktop.mjs die with that process and never reach
 * the `tauri build` that follows, so the signing key has to be resolved in the
 * SAME process that launches Tauri. Doing it here also keeps the key out of
 * package.json, out of the shell history, and out of any CI log.
 *
 * Without the key Tauri does not fail — it prints a notice at the very end of a
 * multi-minute build and emits no `.sig`. The release then looks complete while
 * auto-update is silently dead. That is how v2.84 through v2.90 shipped
 * unsigned, so this refuses to build rather than repeat it.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const keyPath = path.join(root, ".secrets", "vyuha-updater.key");
const env = { ...process.env };

if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  if (fs.existsSync(keyPath)) {
    // The key CONTENTS, not the path. Tauri's bundler reads only
    // TAURI_SIGNING_PRIVATE_KEY; the `_PATH` variant the generator mentions is
    // honoured by the signer CLI but not by the bundler, which fails with the
    // maddeningly generic "a public key has been found, but no private key".
    env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(keyPath, "utf8").trim();
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
    console.log("• signing updates with .secrets/vyuha-updater.key");
  } else if (env.VYUHA_ALLOW_UNSIGNED === "1") {
    console.warn("! building UNSIGNED — auto-update will not work for this build.");
  } else {
    console.error("\n✗ No updater signing key — refusing to build an installer that cannot auto-update.\n");
    console.error(`   Expected: ${path.relative(root, keyPath)}`);
    console.error('   Generate:  npx tauri signer generate --ci -p "" -w .secrets/vyuha-updater.key');
    console.error("   Then copy its .pub contents into tauri.conf.json → plugins.updater.pubkey.");
    console.error("   Deliberately unsigned:  VYUHA_ALLOW_UNSIGNED=1 npm run desktop:build\n");
    process.exit(1);
  }
}

const args = ["tauri", "build", ...process.argv.slice(2)];
const res = spawnSync("npx", args, { stdio: "inherit", shell: true, env });
if (res.status !== 0) process.exit(res.status ?? 1);

// A signed build MUST leave a .sig beside the installer. Verifying it here is
// what turns "we set an env var" into "the artifact is actually signed".
if (env.TAURI_SIGNING_PRIVATE_KEY) {
  const nsis = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
  if (fs.existsSync(nsis)) {
    const exes = fs.readdirSync(nsis).filter((f) => f.endsWith("-setup.exe"));
    const newest = exes
      .map((f) => ({ f, t: fs.statSync(path.join(nsis, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (newest && !fs.existsSync(path.join(nsis, `${newest.f}.sig`))) {
      console.error(`\n✗ ${newest.f} was built but has NO .sig — auto-update would be silently broken.\n`);
      process.exit(1);
    }
    if (newest) console.log(`✓ ${newest.f} is signed (.sig present)`);
  }
}
