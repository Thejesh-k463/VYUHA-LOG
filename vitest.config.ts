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
    // The same class, per TEST (DECISIONS 2026-09-18): the Windows CI runner is > 15× slower than a
    // dev machine on SQLite-file work (AGENTS.md, measured 2026-09-11), so a case INSIDE the 300 ms
    // local budget sits at vitest's 5 s default there. Two of five runs on 2026-09-18 lost the
    // Windows job to it — six different seam cases, no assertion ever failed, every one green on
    // Linux in the same run — and the release workflow runs `npm test` on Windows too. 20 s on the
    // Windows CI runner ONLY: locally and on Linux the 5 s default still enforces the budget, so a
    // genuinely slow test is still caught where it is written.
    testTimeout: process.env.CI && process.platform === "win32" ? 20_000 : 5_000,
    include: ["tests/**/*.test.ts", "lib/**/*.test.ts"],
  },
});
