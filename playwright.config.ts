import { defineConfig } from "@playwright/test";
import path from "node:path";

const E2E_DB = path.join(process.cwd(), "data", "e2e.sqlite");

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
    env: { VYUHA_DB_PATH: E2E_DB },
  },
});
