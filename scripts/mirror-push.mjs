#!/usr/bin/env node
// Push main + all tags to a second git host so a GitHub outage (Aug 2026: 13 incidents in 17
// days, one of ~8 h) never leaves the only copy of the history on one provider.
//
// One-time setup (owner does this; a human must create the account):
//   1. Create an empty PRIVATE repo on Codeberg / GitLab / Bitbucket (no README).
//   2. git remote add mirror <ssh-or-https-url>
//   3. npm run mirror:push
// After that, run `npm run mirror:push` after every release (the release runbook lists it).
//
// Never mirrors: anything gitignored (.secrets/, license-private.pem, the ledger) — git only
// pushes tracked history, so the secrets rule holds by construction.
import { execSync } from "node:child_process";

function sh(cmd) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

let url = "";
try {
  url = sh("git remote get-url mirror");
} catch {
  console.error(
    "No `mirror` remote. Create an empty private repo on a second host, then:\n" +
      "  git remote add mirror <url>\n  npm run mirror:push",
  );
  process.exit(2);
}

console.log(`Mirroring to ${url.replace(/\/\/[^@]*@/, "//***@")} …`);
execSync("git push mirror main --follow-tags", { stdio: "inherit" });
execSync("git push mirror --tags", { stdio: "inherit" });
const head = sh("git rev-parse --short HEAD");
const tag = sh("git describe --tags --abbrev=0 2>/dev/null || echo none");
console.log(`✓ mirror has main@${head} and tags through ${tag}`);
