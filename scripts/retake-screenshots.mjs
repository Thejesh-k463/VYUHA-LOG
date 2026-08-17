/**
 * Retake the marketing screenshots from the CURRENT build, against demo data.
 *
 *   node scripts/retake-screenshots.mjs            # everything
 *   node scripts/retake-screenshots.mjs trades skin-rose   # only the named shots
 *
 * Why this exists as a script: the screenshots in docs/screenshots/ feed the
 * README, the landing page and the client deck, and they go stale every time
 * the UI moves (they shipped the pre-brand placeholder logo for a while).
 * Retaking them by hand from a live journal also risks leaking real trades —
 * this script builds a throwaway database, imports the committed test fixtures
 * through the real import UI, and shoots from that. Nothing personal on screen.
 *
 * Every shot is 1440×900, dark theme, Luxe skin at tint 50 unless the shot
 * itself is about a skin (the skin-*.png set is shot at tint 60). Appearance
 * is set through POST /api/settings — the same JSON the settings form posts
 * (components/settings/settings-form.tsx save()) — never by clicking pills.
 *
 * Hand-taken and deliberately NOT scripted: broker-connect.png (the screen
 * wants API credentials — never screenshot anything with keys).
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
const FIXTURES = path.join(root, "tests", "fixtures");
const ONLY = new Set(process.argv.slice(2));

// Retired skins whose files must not linger in the folder (the README would
// keep advertising a look the app no longer ships).
const RETIRED = ["skin-royal.png", "skin-mono.png", "skin-light.png"];

// Throwaway DB — never the user's journal.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-shots-"));
const DB = path.join(dbDir, "shots.sqlite");
const env = { ...process.env, VYUHA_DB_PATH: DB, PORT: String(PORT) };

console.log("→ preparing demo DB:", DB);
execSync("npx tsx e2e/prepare-db.ts", { cwd: root, env, stdio: "inherit" });

/** PIDs listening on a TCP port (Windows netstat; empty elsewhere / on error). */
function pidsOnPort(port) {
  if (process.platform !== "win32") return [];
  try {
    const out = execSync("netstat -ano -p tcp", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && Number(m[1]) === port) pids.add(Number(m[2]));
    }
    return [...pids];
  } catch { return []; }
}

// A dev server left over from an earlier run would answer on this port with a
// database that has since been deleted — every navigation then hangs, and the
// failure reads as "hydration never happened". Refuse rather than guess whose it is.
{
  const stale = pidsOnPort(PORT);
  if (stale.length) {
    console.error(`✗ port ${PORT} is already in use (pid ${stale.join(", ")}) — stop it first:\n    taskkill /F /T /PID ${stale[0]}`);
    process.exit(2);
  }
}

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

// The seeded settings row (lib/db/seed-core.ts, non-CLEAN) plus the appearance
// defaults. POST /api/settings validates the WHOLE row, so every required field
// travels with each appearance change — exactly what the form does.
const BASE_SETTINGS = {
  type: "settings",
  goLiveDate: "2026-06-19",
  equityCapital: 1_300_000,
  activeCapital: 400_000,
  theme: "dark",
  accentSkin: "luxe",
  density: "compact",
  workspace: "both",
  fyStartMonth: 4,
  defaultBuyOrders: 1,
  defaultSellOrders: 1,
  colorblindSafe: false,
  autoMtmEnabled: false,
  tintIntensity: 50,
  panelStyle: "luxe",
  wallpaperOpacity: 35,
};

async function setAppearance(overrides = {}) {
  const res = await fetch(BASE + "/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...BASE_SETTINGS, ...overrides }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(`settings POST failed: ${res.status} ${JSON.stringify(json)}`);
}

async function main() {
  await waitForServer();
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30_000);

  /**
   * Navigate and wait until the root layout's client islands are LIVE — the
   * same probe as e2e/helpers.ts gotoHydrated: the sidebar MarketClock renders
   * null until its mount effect fires, so its HH:MM text cannot paint before
   * hydration. `networkidle` says nothing about hydration; a shot taken on it
   * alone can capture server HTML with no client state (empty tables, closed
   * dialogs, unstyled sliders). Retries with a reload — next dev's first
   * compile of a route occasionally stalls the first navigation.
   */
  async function gotoHydrated(route, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        await page.goto(BASE + route, { waitUntil: "load", timeout: 90_000 });
        await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
        await page.locator("aside").getByText(/\d{2}:\d{2} IST/).first()
          .waitFor({ state: "visible", timeout: 25_000 });
        return;
      } catch (e) {
        lastErr = e;
        console.warn(`    · hydration probe missed on ${route} (attempt ${i + 1}/${attempts})`);
        await sleep(1500);
      }
    }
    throw lastErr;
  }

  const failures = [];
  const done = [];
  const shoot = async (name, fn) => {
    if (ONLY.size && !ONLY.has(name)) return;
    try {
      await fn();
      await page.waitForLoadState("networkidle").catch(() => {});
      // next dev's floating "N" indicator is not part of the product.
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
      await sleep(700); // let charts finish animating
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      done.push(name);
      console.log("  ✓", name + ".png");
    } catch (e) {
      failures.push(name);
      console.error("  ✗", name, "—", e.message.split("\n")[0]);
    }
  };

  // Open the drill-down dialog of a KpiCard by clicking its label.
  const openKpi = async (label) => {
    await page.getByText(label).first().click();
    await page.getByRole("dialog").waitFor();
  };

  // ── Seed trades through the real import UI ─────────────────────────────
  // dhan-gtr: dated transaction report (daily P&L, calendars, drill-downs) —
  // every dated surface shoots against this alone.
  // dhan-pnl: aggregated P&L with ~110 option contracts but NO dates — it is
  // imported LAST, only for the Options Seller Journal, because on the
  // dashboard it adds a "116 closed trades carry no exit date" notice under
  // the equity curve and on the trades table it swamps the dated rows.
  // Imports are de-duplicated, so a re-run against a warm DB simply finds
  // "0 new trades" and the Commit button stays disabled.
  async function importFixture(file) {
    console.log("→ importing", file, "through /import");
    await gotoHydrated("/import");
    await page.getByText(/Drop a broker file/i).waitFor();
    await page.locator('input[type="file"]').setInputFiles(path.join(FIXTURES, file));
    const commit = page.getByRole("button", { name: /Commit\s+\d+\s+new trade/i });
    await commit.waitFor({ state: "visible", timeout: 30_000 });
    if (!(await commit.isEnabled())) { console.log("  · nothing new in", file); return; }
    await commit.click();
    await page.getByText(/Imported\s+\d+\s+trade/i).waitFor({ timeout: 30_000 });
  }
  await importFixture("dhan-gtr.csv");

  // ── Baseline look: dark, Luxe, tint 50 ─────────────────────────────────
  await setAppearance();

  console.log("→ shooting");
  await shoot("dashboard", async () => {
    await gotoHydrated("/");
  });

  await shoot("kpi-drilldown", async () => {
    await gotoHydrated("/");
    // The Net P&L card opens its drill-down dialog on click.
    await openKpi(/^NET P&L$/i);
  });

  await shoot("calculator", async () => {
    await gotoHydrated("/calculator");
    // Fill a realistic delivery trade so the charges table has numbers.
    await page.getByTestId("calc-ticker").fill("RELIANCE").catch(() => {});
    await page.getByTestId("calc-entry").fill("2840").catch(() => {});
    await page.getByTestId("calc-sl").fill("2795").catch(() => {});
    await page.getByTestId("calc-target").fill("2930").catch(() => {});
  });

  await shoot("staged-position", async () => {
    await gotoHydrated("/trades");
    await page.locator("tbody tr").first().waitFor();
    // The table is virtualized: open rows (null sellDate) sort BELOW the
    // rendered window in the default order — narrow to the Open view first.
    await page.locator("select").filter({ hasText: "All trades" }).selectOption("open");
    // Test Scrip 66 is a plain long holding (125 held) — the first open row in
    // the default order is the IPO-allotment sale, whose ladder reads as a
    // SELL tranche with no stop and two warnings; not the picture to sell with.
    await page.getByPlaceholder(/Search symbol/i).fill("Test Scrip 66");
    await sleep(400);
    // Row action buttons carry aria-labels (trades-client.tsx), not titles.
    const openRow = page.locator("tbody tr")
      .filter({ has: page.locator('button[aria-label="Close position"]') }).first();
    await openRow.locator('button[aria-label*="tranches"], button[aria-label*="Staged position"]').click();
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
    // Priced near the holding's own average (₹5,55,520 / 125 ≈ ₹4,444).
    await page.locator("#se-qty").fill("25");
    await page.locator("#se-price").fill("4400");
    await page.locator("#se-sl").fill("4250");
    await page.getByRole("button", { name: /^Add entry$/ }).last().click();
    await sleep(800); // ladder rebuild round-trip
    // "Entry added." toast auto-clears at 3.8s (components/ui/toaster.tsx).
    await page.locator('[role="status"]').first().waitFor({ state: "detached", timeout: 6_000 }).catch(() => {});
  });

  await shoot("arjuns-eye", async () => { await gotoHydrated("/arjuns-eye"); });
  await shoot("playbooks", async () => { await gotoHydrated("/playbooks"); });
  await shoot("rom-report", async () => { await gotoHydrated("/reports/rom"); });

  // v2.99.60 surfaces — the report screens with the new shared table chrome
  // are the listing's biggest visual upgrade since the Dark Luxe foundation.
  await shoot("tax-pack", async () => { await gotoHydrated("/reports/tax"); });
  await shoot("edge-report", async () => { await gotoHydrated("/reports/edge"); });
  await shoot("surveillance", async () => { await gotoHydrated("/surveillance"); });

  await shoot("lenses", async () => { await gotoHydrated("/lenses"); });
  await shoot("pricing", async () => { await gotoHydrated("/pricing"); });

  await shoot("trades", async () => {
    await gotoHydrated("/trades");
    await page.locator("tbody tr").first().waitFor();
    // The gtr fixture trips two data-quality prompts above the table (a sale
    // with no purchase on record — the IPO-allotment case — and open holdings
    // with no mark). They are the product working as designed, but together
    // they push the table itself below the fold; answer them the way a user
    // would (accept the pre-filled basis, dismiss the mark notice) so the
    // table is what the shot shows.
    const setBasis = page.getByRole("button", { name: /^Set basis$/ });
    if (await setBasis.count()) {
      await setBasis.first().click();
      await setBasis.first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
      // Setting a basis changes the unmarked-holdings SET, and the dismissal is
      // keyed on that set's fingerprint — let the refresh land before dismissing,
      // or the dismissal is filed against the old fingerprint and the panel
      // comes straight back.
      await page.waitForLoadState("networkidle").catch(() => {});
      await sleep(1000);
    }
    for (let i = 0; i < 3; i++) {
      const dismiss = page.getByRole("button", { name: /^Dismiss$/ });
      if (!(await dismiss.count())) break;
      await dismiss.first().click();
      await dismiss.first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await sleep(800);
    }
    await page.locator("tbody tr").first().waitFor();
    // Qty / Invested / Entry / Exit sit right of the fold at 1440px — scroll
    // the table's own overflow container so the four new columns are on screen.
    await page.locator("th", { hasText: /^Invested$/ }).first().scrollIntoViewIfNeeded();
    await page.locator("th", { hasText: /^Exit$/ }).first().scrollIntoViewIfNeeded();
    // scrollIntoView on the header may also scroll the main pane vertically —
    // put the page top back so the header and filters stay in frame.
    await page.evaluate(() => { document.querySelector("main")?.scrollTo({ top: 0 }); window.scrollTo(0, 0); });
    await sleep(300);
  });

  await shoot("risk", async () => { await gotoHydrated("/risk"); });

  // ── Appearance surfaces ────────────────────────────────────────────────
  const gotoAppearance = async () => {
    await gotoHydrated("/settings");
    await page.getByTestId("appearance-section").waitFor();
    await page.getByLabel(/Tint intensity/i).waitFor();
  };
  // Bring the whole card (title + pills + slider + panel styles) to the top
  // of the scrolling <main> pane so nothing above it steals the frame. The
  // Card is the parent of the CardHeader/CardContent pair; a hair of room above.
  const alignAppearance = async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="appearance-section"]');
      const card = el?.parentElement ?? el;
      card?.scrollIntoView({ block: "start" });
      // The page header is sticky inside <main> and covers the first ~70px of
      // whatever scrollIntoView lines up; back off far enough that the card's
      // "Appearance" title clears it.
      const main = document.querySelector("main");
      const header = main?.querySelector(".sticky.top-0") ?? main?.firstElementChild;
      const cover = header ? header.getBoundingClientRect().height : 0;
      if (main) main.scrollTop = Math.max(0, main.scrollTop - cover - 16);
    });
    await sleep(300);
  };

  await shoot("settings-appearance", async () => {
    await gotoAppearance();
    await alignAppearance();
  });

  await shoot("custom-theme", async () => {
    await setAppearance({ accentSkin: "custom" });
    await gotoAppearance();
    // The builder mounts only while Custom is the selected skin.
    await page.getByRole("button", { name: /Custom/i, pressed: true }).waitFor().catch(() => {});
    await page.getByText(/^Custom theme$/).first().waitFor({ timeout: 10_000 }).catch(() => {});
    await alignAppearance();
  });

  // ── Skin set: dashboard at each shipped skin, tint 60 ──────────────────
  for (const skin of ["lime", "rose", "ember", "sapphire", "aurora"]) {
    await shoot(`skin-${skin}`, async () => {
      await setAppearance({ accentSkin: skin, tintIntensity: 60 });
      await gotoHydrated("/");
      // The skin class is server-rendered on <html>; make sure THIS document has it.
      await page.waitForFunction((s) => document.documentElement.className.includes(s), skin, { timeout: 10_000 }).catch(() => {});
    });
  }

  // Back to the baseline look for the last shot.
  await setAppearance();

  // ── Options Seller Journal — needs the option-heavy fixture (see above) ──
  if (!ONLY.size || ONLY.has("options-journal")) {
    try { await importFixture("dhan-pnl.csv"); } catch (e) { console.error("  ✗ dhan-pnl import —", e.message.split("\n")[0]); }
  }
  await shoot("options-journal", async () => {
    await gotoHydrated("/options-journal");
    // The "Seller trades" KpiCard opens its per-underlying breakdown on click.
    await openKpi(/^SELLER TRADES$/i).catch((e) => console.warn("    · seller drill-down not opened:", e.message.split("\n")[0]));
  });

  for (const f of RETIRED) {
    const p = path.join(OUT, f);
    if (fs.existsSync(p)) { fs.rmSync(p); console.log("  − removed retired", f); }
  }

  await browser.close();
  console.log(`\n${done.length} shot(s) written to docs/screenshots/`);
  if (failures.length) {
    console.error("✗ failed:", failures.join(", "));
    process.exitCode = 1;
  } else {
    console.log("✓ all screenshots retaken");
    console.log("Next: re-inline the deck images and rebuild the standalone landing page.");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  // `next dev` is spawned through a shell; kill the whole tree, with a bounded
  // wait — a stuck taskkill once left this script hanging for ten minutes
  // after every screenshot had already been written.
  server.kill("SIGTERM");
  try { execSync(`taskkill /F /T /PID ${server.pid}`, { stdio: "ignore", timeout: 15_000 }); } catch { /* already gone */ }
  // `npx` → shell → next → worker: the tree kill above has been seen to miss
  // the actual listener, which then answers the NEXT run from a deleted DB.
  for (const pid of pidsOnPort(PORT)) {
    try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", timeout: 15_000 }); } catch { /* best effort */ }
  }
  try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* temp cleanup best-effort */ }
  process.exit(process.exitCode ?? 0);
});
