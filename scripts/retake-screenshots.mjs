/**
 * Retake the marketing screenshots from the CURRENT build, against demo data.
 *
 *   node scripts/retake-screenshots.mjs
 *
 * Why this exists as a script: the screenshots in docs/screenshots/ feed the
 * README, the landing page and the client deck, and they go stale every time
 * the UI moves (they shipped the pre-brand placeholder logo for a while).
 * Retaking them by hand from a live journal also risks leaking real trades —
 * this script builds a throwaway database, imports the committed test fixture
 * through the real import UI, and shoots from that. Nothing personal on screen.
 *
 * Requires the dev deps already in the repo (@playwright/test, next, tsx).
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3213;
const BASE = `http://localhost:${PORT}`;
const OUT = path.join(root, "docs", "screenshots");
const VIEWPORT = { width: 1440, height: 900 };

// Throwaway DB — never the user's journal.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-shots-"));
const DB = path.join(dbDir, "shots.sqlite");
const env = { ...process.env, VYUHA_DB_PATH: DB, PORT: String(PORT) };

console.log("→ preparing demo DB:", DB);
execSync("npx tsx e2e/prepare-db.ts", { cwd: root, env, stdio: "inherit" });

console.log("→ starting next dev on", PORT);
const server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  cwd: root, env, shell: true, stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE + "/help");
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error("dev server never became ready:\n" + serverLog.slice(-2000));
}

async function main() {
  await waitForServer();
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30_000);

  const failures = [];
  const shoot = async (name, fn) => {
    try {
      await fn();
      await page.waitForLoadState("networkidle").catch(() => {});
      await sleep(700); // let charts finish animating
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      console.log("  ✓", name + ".png");
    } catch (e) {
      failures.push(name);
      console.error("  ✗", name, "—", e.message.split("\n")[0]);
    }
  };

  // ── Seed trades through the real import UI (dated Dhan transaction report) ──
  console.log("→ importing the dated fixture through /import");
  await page.goto(BASE + "/import");
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').setInputFiles(path.join(root, "tests", "fixtures", "dhan-gtr.csv"));
  const commit = page.getByRole("button", { name: /Commit\s+\d+\s+new trade/i });
  await commit.waitFor({ state: "visible", timeout: 30_000 });
  await commit.click();
  await page.getByText(/Imported\s+\d+\s+trade/i).waitFor({ timeout: 30_000 });

  console.log("→ shooting");
  await shoot("dashboard", async () => {
    await page.goto(BASE + "/");
  });

  await shoot("kpi-drilldown", async () => {
    await page.goto(BASE + "/");
    await page.waitForLoadState("networkidle");
    // The Net P&L card opens its drill-down dialog on click.
    await page.getByText(/^NET P&L$/i).first().click();
    await page.getByRole("dialog").waitFor();
  });

  await shoot("calculator", async () => {
    await page.goto(BASE + "/calculator");
    await page.waitForLoadState("networkidle");
    // Fill a realistic delivery trade so the charges table has numbers.
    const num = (label, v) =>
      page.locator(`label:has-text("${label}")`).first()
        .locator("xpath=following-sibling::input | ..//input").first().fill(v);
    await page.getByPlaceholder("RELIANCE / NIFTY").fill("RELIANCE").catch(() => {});
    await num("Entry", "2840").catch(() => {});
    await num("Stop-loss", "2795").catch(() => {});
    await num("Target", "2930").catch(() => {});
  });

  await shoot("staged-position", async () => {
    await page.goto(BASE + "/trades");
    await page.locator("tbody tr").first().waitFor();
    // The table is virtualized: open rows (null sellDate) sort BELOW the
    // rendered window in the default order — narrow to the Open view first.
    await page.locator("select").filter({ hasText: "All trades" }).selectOption("open");
    const openRow = page.locator("tbody tr")
      .filter({ has: page.locator('button[title="Close position"]') }).first();
    await openRow.locator('button[title*="tranches"], button[title*="Staged position"]').click();
    const dialog = page.getByRole("dialog").filter({ hasText: "Staged position" });
    await dialog.waitFor();
    // Wait out the ladder fetch (see e2e/staged-position.spec.ts — deciding
    // anything during the loading window silently skips the click).
    await page.waitForFunction(() => !document.body.innerText.includes("Loading the ladder"), null, { timeout: 20_000 });
    const enable = dialog.getByRole("button", { name: /Enable staged mode/i });
    if (await enable.count()) {
      await enable.click();
      await page.waitForFunction(() => !document.body.innerText.match(/Enable staged mode/i), null, { timeout: 20_000 });
    }
    // Add a second tranche so the ladder actually reads as a ladder.
    await dialog.getByRole("button", { name: /Add entry/i }).first().click();
    await page.locator("#se-qty").fill("10");
    await page.locator("#se-price").fill("100");
    await page.locator("#se-sl").fill("95");
    await page.getByRole("button", { name: /^Add entry$/ }).last().click();
    await sleep(800); // ladder rebuild round-trip
  });

  await shoot("arjuns-eye", async () => {
    await page.goto(BASE + "/arjuns-eye");
  });

  await shoot("playbooks", async () => {
    await page.goto(BASE + "/playbooks");
  });

  await shoot("rom-report", async () => {
    await page.goto(BASE + "/reports/rom");
  });

  // v2.99.60 surfaces — the report screens with the new shared table chrome
  // are the listing's biggest visual upgrade since the Dark Luxe foundation.
  await shoot("tax-pack", async () => {
    await page.goto(BASE + "/reports/tax");
  });

  await shoot("edge-report", async () => {
    await page.goto(BASE + "/reports/edge");
  });

  await shoot("surveillance", async () => {
    await page.goto(BASE + "/surveillance");
  });

  await browser.close();
  if (failures.length) {
    console.error("\n✗ failed:", failures.join(", "));
    process.exitCode = 1;
  } else {
    console.log("\n✓ all screenshots retaken into docs/screenshots/");
    console.log("Next: re-inline the deck images and rebuild the standalone landing page.");
  }
}

main().finally(() => {
  server.kill("SIGTERM");
  try { execSync(`taskkill /F /T /PID ${server.pid}`, { stdio: "ignore" }); } catch { /* already gone */ }
  try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* temp cleanup best-effort */ }
});
