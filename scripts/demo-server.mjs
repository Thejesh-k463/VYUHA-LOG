/**
 * Run Vyuha on DEMO data and leave it running, so the app can be recorded or
 * shown to someone without a single real trade on screen.
 *
 *   npm run demo            # seed once, then keep serving (re-runs are instant)
 *   npm run demo -- --fresh # wipe the demo book and re-import from fixtures
 *
 * WHY THIS EXISTS. The owner's live journal is his actual trading book. The
 * only safe way to demo or record is a SEPARATE database, and the only honest
 * way to fill it is the real import pipeline — hand-written rows would show a
 * screen the product does not actually produce. `scripts/retake-screenshots.mjs`
 * already solved both for stills; this is the same approach without the camera.
 *
 * THE ISOLATION IS THE WHOLE POINT. `VYUHA_DB_PATH` is set to a demo file under
 * the OS temp directory before the server starts, so `lib/db` opens THAT and
 * never the real book. Nothing here reads, writes, migrates or backs up the
 * owner's data — there is deliberately no code path in this file that could.
 *
 * WHAT NOT TO PUT ON CAMERA. Import → Connect broker asks for API keys. Never
 * record that screen with real credentials in it; the demo book has no
 * connections, so it renders empty, which is what you want. Same reason
 * `broker-connect.png` is hand-taken and excluded from the screenshot script.
 */
import { spawn, spawnSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(root, "tests", "fixtures");
const PORT = 3214; // 3213 belongs to retake-screenshots; keep them separable.
const BASE = `http://localhost:${PORT}`;
const FRESH = process.argv.includes("--fresh");

// Stable path, not mkdtemp: re-running should be instant, and a demo book you
// can return to is more useful than a pristine one you must re-seed each time.
const demoDir = path.join(os.tmpdir(), "vyuha-demo");
const DB = path.join(demoDir, "demo.sqlite");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const stale = pidsOnPort(PORT);
if (stale.length) {
  console.error(`✗ port ${PORT} is already in use (pid ${stale.join(", ")}) — stop it first.`);
  process.exit(1);
}

if (FRESH && fs.existsSync(demoDir)) {
  fs.rmSync(demoDir, { recursive: true, force: true });
  console.log("→ --fresh: demo book wiped");
}
fs.mkdirSync(demoDir, { recursive: true });
const alreadySeeded = fs.existsSync(DB);

console.log(`→ demo database: ${DB}`);
console.log("  (your real journal is NOT opened by this script)");

/**
 * A fresh file is an EMPTY file — the dev server 500s on "no such table:
 * settings" without this. Both entrypoints resolve their connection through
 * lib/db, which honours VYUHA_DB_PATH, so they act on the demo file only.
 *
 * `cwd` must stay the repo root because migrate.ts resolves its migrations
 * folder as "./drizzle" — which is also why its pre-migration backup lands in
 * the REAL data/backups. An empty demo database sitting there could be mistaken
 * for a genuine backup, so any file that appears during this call is removed
 * again below. Only files created inside the call are touched; a real backup
 * present beforehand is never in the candidate set.
 */
// Run EVERY start, not just the first: migrations and the core seed are both
// idempotent, and a demo book made before a schema change would otherwise fail
// with the same confusing "no such table" the first version of this script hit.
{
  const backupsDir = path.join(root, "data", "backups");
  const before = new Set(fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : []);

  for (const [label, entry] of [["migrations", "lib/db/migrate.ts"], ["seed", "lib/db/seed.ts"]]) {
    console.log(`→ applying ${label} to the demo database …`);
    const r = spawnSync("npx", ["tsx", entry], {
      cwd: root,
      env: { ...process.env, VYUHA_DB_PATH: DB },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (r.status !== 0) {
      console.error(`✗ ${label} failed:\n${(r.stderr || r.stdout || "").slice(-1500)}`);
      process.exit(1);
    }
  }

  if (fs.existsSync(backupsDir)) {
    for (const f of fs.readdirSync(backupsDir)) {
      if (before.has(f) || !/^vyuha-premigrate-/.test(f)) continue;
      fs.rmSync(path.join(backupsDir, f), { force: true });
      console.log(`  · removed the demo pre-migration backup (${f}) from data/backups`);
    }
  }
}

console.log(`→ starting next dev on ${PORT} …`);

const server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  cwd: root,
  env: { ...process.env, VYUHA_DB_PATH: DB, PORT: String(PORT) },
  shell: process.platform === "win32",
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

function shutdown(code = 0) {
  try {
    server.kill();
  } catch {
    /* already gone */
  }
  process.exit(code);
}
process.on("SIGINT", () => {
  console.log("\n→ stopping demo server (the demo book is kept for next time)");
  shutdown(0);
});

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(BASE + "/", { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (server.exitCode !== null) throw new Error("dev server exited:\n" + serverLog.slice(-2000));
    await sleep(1000);
  }
  throw new Error("dev server never became ready:\n" + serverLog.slice(-2000));
}

/** The seeded settings row plus appearance defaults — POST /api/settings validates the WHOLE row. */
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

async function main() {
  await waitForServer();

  if (alreadySeeded && !FRESH) {
    console.log("→ demo book already seeded — skipping import (use --fresh to rebuild)");
  } else {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(30_000);

    // Wait for the root layout's client islands to be LIVE, not merely loaded:
    // the sidebar clock renders null until its mount effect fires, so its
    // HH:MM text cannot paint before hydration. `networkidle` says nothing
    // about hydration (DECISIONS 2026-08-10).
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
          console.warn(`    · hydration probe missed on ${route} (attempt ${i + 1}/${attempts})`);
          await sleep(1500);
        }
      }
      throw lastErr;
    }

    async function importFixture(file) {
      console.log("→ importing", file, "through /import");
      await gotoHydrated("/import");
      await page.getByText(/Drop a broker file/i).waitFor();
      await page.locator('input[type="file"]').setInputFiles(path.join(FIXTURES, file));
      const commit = page.getByRole("button", { name: /Commit\s+\d+\s+new trade/i });
      await commit.waitFor({ state: "visible", timeout: 30_000 });
      if (!(await commit.isEnabled())) {
        console.log("  · nothing new in", file);
        return;
      }
      await commit.click();
      await page.getByText(/Imported\s+\d+\s+trade/i).waitFor({ timeout: 30_000 });
    }

    /** Create (or find) an account and make it the SELECTED one, so the next
     *  importFixture lands in it. Multi-account is a headline demo scene: the
     *  transition only reads on camera when each account holds a visibly
     *  DIFFERENT book, which is why each gets its own broker fixture. */
    async function useAccount(name) {
      const list = await (await fetch(BASE + "/api/settings")).json().catch(() => null);
      void list; // accounts are read via their own listing on /settings; create idempotently:
      const res = await fetch(BASE + "/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "upsert", name }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(`account upsert failed for ${name}`);
      const sel = await fetch(BASE + "/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "select", id: j.id }),
      });
      if (!(await sel.json()).ok) throw new Error(`account select failed for ${name}`);
      console.log(`→ account "${name}" (id ${j.id}) selected`);
      return j.id;
    }

    // The charge-carrying Global Transaction Report: dated rows, real charge
    // figures, and enough spread to make the dashboard and reports look alive.
    // Account 1 is the seeded default ("Primary").
    await importFixture("dhan-gtr.csv");

    // Aggregated P&L with ~110 option contracts but NO dates. Imported LAST and
    // only for the Options Seller Journal — on the dashboard it adds a "carry no
    // exit date" notice and on the trades table it swamps the dated rows. If you
    // are recording the dashboard or the trades table, run with --fresh and
    // comment this line out.
    try {
      await importFixture("dhan-pnl.csv");
    } catch (e) {
      console.error("  ✗ dhan-pnl import —", e.message.split("\n")[0]);
    }

    // SECOND account with a DIFFERENT broker's book, so switching accounts on
    // camera visibly changes every number. Groww P&L is deliberately NOT used:
    // a P&L import stops at the product-confirmation step, which needs a hand.
    try {
      await useAccount("Swing — Zerodha");
      await importFixture("zerodha-tradebook.csv");
    } catch (e) {
      console.error("  ✗ second-account seed —", e.message.split("\n")[0]);
    }

    // THIRD account left EMPTY on purpose: the video's import scene commits the
    // Zerodha tradebook here live, so the preview shows real "new trades".
    try {
      await useAccount("Options — Demo");
    } catch (e) {
      console.error("  ✗ third-account seed —", e.message.split("\n")[0]);
    }

    // Land back on the primary book for the opening scenes.
    await fetch(BASE + "/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "select", id: 1 }),
    });

    const res = await fetch(BASE + "/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(BASE_SETTINGS),
    });
    if (!res.ok) console.error("  ✗ settings POST failed:", res.status);

    await browser.close();
  }

  console.log("");
  console.log("  ┌────────────────────────────────────────────────────────────┐");
  console.log(`  │  DEMO READY  →  ${BASE.padEnd(42)}│`);
  console.log("  │                                                            │");
  console.log("  │  Demo data only. Your real journal is untouched.           │");
  console.log("  │  Do NOT record Import → Connect broker with real keys.      │");
  console.log("  │                                                            │");
  console.log("  │  Ctrl+C to stop. The demo book is kept for next time.      │");
  console.log("  └────────────────────────────────────────────────────────────┘");
  console.log("");
}

main().catch((e) => {
  console.error(e);
  shutdown(1);
});
