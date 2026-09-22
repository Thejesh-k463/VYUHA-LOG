import { defineConfig } from "@playwright/test";
// The path lives with the specs, not here: one spec has to open the same file
// the server is serving from (see E2E_DB_PATH's own comment).
import { E2E_DB_PATH as E2E_DB } from "./e2e/helpers";

export default defineConfig({
  testDir: "./e2e",
  // Dev-mode Next compiles routes on first hit, and these specs walk a book of
  // several hundred trades across a dozen pages. 60s was tight enough that a
  // cold route compile alone could fail a passing test.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: { baseURL: "http://localhost:3100", trace: "off" },
  webServer: {
    // Clean+migrate+seed the isolated e2e DB, THEN serve — so the first render works.
    command: "npx tsx e2e/prepare-db.ts && npx next dev -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: false,
    timeout: 180_000,
    // The dev server serves ~110 specs across 9 minutes and compiles every route on
    // demand; its heap grows for the whole run. Under Node's default ceiling Next's
    // own watchdog ("Server is approaching the used memory threshold, restarting")
    // restarted it mid-spec on the 7 GB macOS runner from 2026-09-21 (five red
    // attempts across three shas, each ONE spec dead on ECONNREFUSED or a
    // half-rendered page, Ubuntu green on the same shas). The watchdog trips at 80 %
    // of heap_size_limit (next/dist/server/lib/start-server.js); 4096 is Node's own
    // 64-bit default and changed nothing (measured 2026-09-22: it still tripped at
    // spec 107 locally). The product does not leak — 60 auto-close previews of 200
    // trades held a flat 57 → 58 MB heap; the growth is turbopack's dev compile
    // cache, which scales with source size, and v4.5.0 added ~1,100 lines to
    // lib/import/commit.ts plus a route and components. 6144 MiB is a margin under
    // the 7 GB runner, not a fix for anything in the product.
    env: { VYUHA_DB_PATH: E2E_DB, NODE_OPTIONS: "--max-old-space-size=6144" },
  },
});
