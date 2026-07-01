import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / heavy server-only modules — never bundle; load from node_modules at runtime.
  serverExternalPackages: ["better-sqlite3", "pdf-parse"],
  // Self-contained server build for the Tauri desktop sidecar (`.next/standalone`).
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
