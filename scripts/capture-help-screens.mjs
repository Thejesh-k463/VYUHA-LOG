/**
 * Capture the Help Desk's per-screen screenshots (v4.6.0 W4, ruling H4).
 *
 *   npm run help:shots                 # every topic that names a screenshot
 *   node scripts/capture-help-screens.mjs --list    # print the routes and exit 0 (no server, no browser)
 *   node scripts/capture-help-screens.mjs trades atlas   # only the named shots
 *
 * Output: public/help/<name>.webp (quality 80), then per-file bytes and the
 * total as "installer growth: N KB" — the folder ships inside the desktop
 * installer, so its size is a release cost worth printing.
 *
 * Modelled on scripts/retake-screenshots.mjs, and deliberately the same in the
 * three places a screenshot can lie:
 *   - DEMO DATA ONLY: a throwaway database (`npx tsx e2e/prepare-db.ts` into a
 *     temp dir) seeded through the real import UI from the committed fixture —
 *     never the user's journal;
 *   - DARK THEME, FORCED AND ASSERTED: set through POST /api/settings (the JSON
 *     the settings form posts), then checked on the document before the first
 *     shot. This app's dark theme is the ABSENCE of `theme-light` on <html>
 *     (app/layout.tsx adds `theme-light` for light and no class for dark), so
 *     that absence is what is asserted — the script refuses to shoot otherwise;
 *   - PRO the way the retake script gets it: a fresh database starts the Pro
 *     trial on its first entitlement read (lib/queries/license.ts), so every
 *     Pro screen renders its content. Asserted: a Pro screen must not show the
 *     "trial has ended" upsell.
 * Same stale-port refusal, same `gotoHydrated` probe, viewport 1440×900.
 *
 * The route list is read from HELP_TOPICS itself (`screenshot` field), by
 * spawning tsx's CLI with --eval — no second list of screens lives here.
 *
 * sharp: dynamically imported (it is in the lock as next's optional
 * dependency). If it will not load, the script exits 2 BEFORE shooting anything.
 */
import { spawn, spawnSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3214;
const BASE = `http://localhost:${PORT}`;
const OUT = path.join(root, "public", "help");
const VIEWPORT = { width: 1440, height: 900 };
const FIXTURES = path.join(root, "tests", "fixtures");
const args = process.argv.slice(2);
const LIST_ONLY = args.includes("--list");
const ONLY = new Set(args.filter((a) => !a.startsWith("--")));

/** { href, name }[] from HELP_TOPICS — the one registry. */
function helpShotRoutes() {
  const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const code =
    "import('./lib/domain/help-content.ts').then((m) => {" +
    " const topics = m.HELP_TOPICS ?? m.default.HELP_TOPICS;" +
    " process.stdout.write(JSON.stringify(topics.filter((t) => t.screenshot).map((t) => ({ href: t.href, name: t.screenshot }))));" +
    "})";
  const r = spawnSync(process.execPath, [tsxCli, "--eval", code], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) {
    console.error("x could not read HELP_TOPICS:\n" + (r.stderr || r.stdout));
    process.exit(1);
  }
  const routes = JSON.parse(r.stdout);
  for (const { href, name } of routes) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`screenshot name "${name}" (${href}) is not kebab-case`);
    if (href.includes("[") || href.includes("?")) throw new Error(`${href} is not a top-level screen`);
  }
  return routes;
}

const ROUTES = helpShotRoutes();

if (LIST_ONLY) {
  for (const { href, name } of ROUTES) console.log(`${name.padEnd(24)} ${href}`);
  console.log(`${ROUTES.length} route(s)`);
  process.exit(0);
}

// sharp first: refusing before a server is started costs nothing.
let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.error("x sharp not installed; run on the owner's machine");
  process.exit(2);
}

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
  } catch {
    return [];
  }
}

// A dev server left over from an earlier run would answer on this port with a
// database that has since been deleted. Refuse rather than guess whose it is.
{
  const stale = pidsOnPort(PORT);
  if (stale.length) {
    console.error(`x port ${PORT} is already in use (pid ${stale.join(", ")}) - stop it first:\n    taskkill /F /T /PID ${stale[0]}`);
    process.exit(2);
  }
}

// Throwaway DB — never the user's journal.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-help-shots-"));
const DB = path.join(dbDir, "help-shots.sqlite");
const env = { ...process.env, VYUHA_DB_PATH: DB, PORT: String(PORT) };

console.log("-> preparing demo DB:", DB);
execSync("npx tsx e2e/prepare-db.ts", { cwd: root, env, stdio: "inherit" });

console.log("-> starting next dev on", PORT);
const server = spawn("npx", ["next", "dev", "-p", String(PORT)], { cwd: root, env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE + "/help");
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error("dev server never became ready:\n" + serverLog.slice(-2000));
}

// The seeded settings row plus the appearance defaults — the same body the
// retake script posts. POST /api/settings validates the WHOLE row.
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

async function forceDark() {
  const res = await fetch(BASE + "/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(BASE_SETTINGS),
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

  /** The e2e/helpers.ts gotoHydrated probe: the sidebar clock paints only after hydration. */
  async function gotoHydrated(route, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        await page.goto(BASE + route, { waitUntil: "load", timeout: 90_000 });
        await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
        await page.locator("aside").getByText(/\d{2}:\d{2} IST/).first().waitFor({ state: "visible", timeout: 25_000 });
        return;
      } catch (e) {
        lastErr = e;
        console.warn(`    . hydration probe missed on ${route} (attempt ${i + 1}/${attempts})`);
        await sleep(1500);
      }
    }
    throw lastErr;
  }

  // Demo trades through the real import UI (the retake script's first fixture).
  console.log("-> importing dhan-gtr.csv through /import");
  await gotoHydrated("/import");
  await page.getByText(/Drop a broker file/i).waitFor();
  await page.locator('input[type="file"]').setInputFiles(path.join(FIXTURES, "dhan-gtr.csv"));
  const commit = page.getByRole("button", { name: /Commit\s+\d+\s+new trade/i });
  await commit.waitFor({ state: "visible", timeout: 30_000 });
  if (await commit.isEnabled()) {
    await commit.click();
    await page.getByText(/Imported\s+\d+\s+trade/i).waitFor({ timeout: 30_000 });
  }

  // Dark, forced, then ASSERTED on a rendered document before any shot.
  await forceDark();
  await gotoHydrated("/");
  const light = await page.evaluate(() => document.documentElement.classList.contains("theme-light"));
  if (light) throw new Error("refusing to shoot: <html> carries theme-light after forcing the dark theme");
  // Pro, asserted: the trial of a fresh database renders Pro screens in full.
  await gotoHydrated("/reports/performance");
  if (await page.getByText(/Pro trial has ended/i).count()) throw new Error("refusing to shoot: Pro screens are locked");

  fs.mkdirSync(OUT, { recursive: true });
  const written = [];
  const failures = [];
  for (const { href, name } of ROUTES) {
    if (ONLY.size && !ONLY.has(name)) continue;
    try {
      await gotoHydrated(href);
      await page.waitForLoadState("networkidle").catch(() => {});
      // next dev's floating indicator is not part of the product.
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
      await sleep(700); // let charts finish animating
      const png = await page.screenshot();
      const file = path.join(OUT, `${name}.webp`);
      await sharp(png).webp({ quality: 80 }).toFile(file);
      const bytes = fs.statSync(file).size;
      written.push({ name, bytes });
      console.log(`  ok ${name}.webp  ${bytes} bytes  (${href})`);
    } catch (e) {
      failures.push(name);
      console.error(`  x ${name} - ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }

  await browser.close();
  const total = written.reduce((s, w) => s + w.bytes, 0);
  console.log(`\n${written.length} file(s) written to public/help/`);
  console.log(`installer growth: ${Math.round(total / 1024)} KB`);
  if (failures.length) {
    console.error("x failed:", failures.join(", "));
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill("SIGTERM");
    try {
      execSync(`taskkill /F /T /PID ${server.pid}`, { stdio: "ignore", timeout: 15_000 });
    } catch {
      /* already gone */
    }
    for (const pid of pidsOnPort(PORT)) {
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", timeout: 15_000 });
      } catch {
        /* best effort */
      }
    }
    try {
      fs.rmSync(dbDir, { recursive: true, force: true });
    } catch {
      /* temp cleanup best-effort */
    }
    process.exit(process.exitCode ?? 0);
  });
