import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
