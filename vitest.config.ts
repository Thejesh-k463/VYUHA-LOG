import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    // Seeded openTempDb() hooks (87 of 102 sites) ran under the 10 s default and lost the
    // Windows release job on a cold runner at v4.1.0 (DECISIONS 2026-09-07). 30 s is the ceiling
    // for a migrated + seeded SQLite file on a slow runner; a genuinely hung hook still fails.
    hookTimeout: 30_000,
    include: ["tests/**/*.test.ts", "lib/**/*.test.ts"],
  },
});
