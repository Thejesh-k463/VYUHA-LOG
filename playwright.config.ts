import { defineConfig } from "@playwright/test";
import path from "node:path";

const E2E_DB = path.join(process.cwd(), "data", "e2e.sqlite");

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
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
