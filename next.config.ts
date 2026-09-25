import type { NextConfig } from "next";
// Relative on purpose: the config is loaded before any `@/` alias exists, and
// lib/domain/hubs.ts imports nothing, so it is safe to pull in here.
import { HUBS, hubTabHref } from "./lib/domain/hubs";

const nextConfig: NextConfig = {
  // v4.6.0 W3 (owner ruling T1): the seven analytics screens that became hub
  // tabs answer a REAL 307 here, before any rendering. The old page.tsx files
  // also call redirect() — but under the root loading.tsx boundary the shell
  // streams first, so that redirect arrives as an RSC `NEXT_REDIRECT` payload
  // over a 200 (measured 2026-09-25 on the dev server) and only client JS
  // follows it; a bookmark opened by curl, the screenshot script or a
  // crawler would sit on the stub. Both layers derive from lib/domain/hubs.ts.
  // `permanent: false` → 307, never 308: 4.7.0 re-maps the Edge Clinic's
  // default tab and a browser-cached 308 would outlive that.
  async redirects() {
    return HUBS.flatMap((hub) =>
      hub.tabs.map((tab) => ({ source: tab.legacyHref, destination: hubTabHref(hub, tab.id), permanent: false })),
    );
  },
  // DELIBERATELY OFF (attempted 2026-08-11, rolled back the same day).
  // Enabling it made SSR and client collapse JSX whitespace differently at
  // `</b>` + newline-text boundaries — hydration mismatches on at least two
  // screens (dashboard equity-curve note, calendar-heatmap note), each
  // regenerating the whole client tree per visit. Bisect-proven: 0 hydration
  // errors with the flag off, 3 with it on, same route, same DB. Whack-a-mole
  // string fixes were rejected: the site count is unknown and the bug is
  // upstream (babel-plugin-react-compiler 1.0.0 under Turbopack). Full
  // narrative + retry conditions: docs/DECISIONS.md 2026-08-11. DataTable's
  // "use no memo" and e2e/z-compiler-protocol.spec.ts stay — they are the
  // preconditions for the next attempt.
  reactCompiler: false,
  // Back/forward navigations reuse the client router cache for 120s instead of
  // refetching the full RSC payload (force-dynamic still re-renders on real
  // navigations — this touches only the browser-side cache). 120s is safe
  // because every write surface (settings, editors, imports, backup, cash,
  // risk, behavior tools — 30+ components audited 2026-08-29) goes through
  // route handlers + client fetch + router.refresh(), which invalidates this
  // cache; a stale entry can only be one the user never wrote through.
  // (optimizePackageImports: lucide-react barrel-import rewriting lives here
  // too in this Next version.)
  experimental: { staleTimes: { dynamic: 120 }, optimizePackageImports: ["lucide-react"] },
  // Loopback-only server (desktop sidecar / localhost): gzip is pure CPU on a
  // link with no bandwidth cost — spend nothing compressing for 127.0.0.1.
  compress: false,
  // Native / heavy server-only modules — never bundle; load from node_modules at runtime.
  serverExternalPackages: ["better-sqlite3", "pdf-parse"],
  // Self-contained server build for the Tauri desktop sidecar (`.next/standalone`).
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  // desktop-dist/ is a BUILD ARTIFACT that itself contains copies of app/api/**
  // route files at matching relative paths. Without this exclude, Next's file
  // tracer sweeps a pre-existing desktop-dist/ into .next/standalone, and
  // scripts/build-desktop.mjs then copies that into the NEW desktop-dist —
  // nesting one level deeper every build until makensis fails on a path over
  // Windows' length limit. src-tauri/target is excluded for the same reason.
  outputFileTracingExcludes: {
    "/*": ["./desktop-dist/**/*", "./src-tauri/target/**/*"],
  },
};

export default nextConfig;
