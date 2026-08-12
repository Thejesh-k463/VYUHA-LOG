import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * LOAD AND STRESS SUITE — deliberately separate from `npm test`.
 *
 * The default `vitest.config.ts` includes `tests/**\/*.test.ts`, which does NOT
 * match `*.load.ts`. That is the whole isolation mechanism: `npm test`,
 * `npm run verify` and CI cannot pick these up by construction, so there is no
 * skip flag to rot and no way for a five-minute seed to creep into the suite
 * that has to stay measured in seconds.
 *
 * Run with: npm run test:load            (everything)
 *           npm run test:load -- a1      (one file, by substring)
 *
 * `pool: "forks"` because these tests measure memory and open real SQLite
 * files; a fresh process per file keeps `globalThis.__vyuhaSqlite` (lib/db
 * caches its connection there) from leaking across files, which is the same
 * hazard the one-temp-db-per-file rule exists for in the unit suite.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/load/**/*.load.ts"],
    // Seeding a HEAVY book and measuring it is minutes, not milliseconds.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: "forks",
    // Load numbers are meaningless interleaved with another file's work.
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
