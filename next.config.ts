import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
