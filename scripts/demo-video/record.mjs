/**
 * Cinematic recorder — films the 10-minute product tour automatically.
 *
 *   1. Terminal A:  npm run demo -- --fresh     (wait for DEMO READY)
 *   2. Terminal B:  node scripts/demo-video/record.mjs [--only=3]
 *
 * Eleven scenes, one 1920×1080 .webm per scene, written to demo-takes/ at the
 * repo root (gitignored). Assemble in Clipchamp with the narration in
 * docs/owner/demo-video/tour/NARRATION.md per the tour EDIT-SHEET.
 *
 * WHY AUTOMATED. A scripted camera never fumbles a take, moves at the same
 * deliberate pace in every scene, and re-films the whole tour in ~12 minutes
 * after any release — the footage can stay current forever. Playwright shows
 * no OS cursor, so a smooth animated cursor is injected instead; it glides
 * and pulses on click, which reads better on video than a hand-held mouse.
 *
 * WHAT IT WILL NEVER FILM (standing rules): the Connect-broker card with
 * fields filled, OpenAlgo or the Integrations switch, a real journal, an
 * active licence key. It runs ONLY against the demo server on :3214.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = "http://localhost:3214";
const OUT = path.join(root, "demo-takes");
const ONLY = (() => {
  const a = process.argv.find((x) => x.startsWith("--only="));
  return a ? Number(a.split("=")[1]) : null;
})();

const W = 1920, H = 1080;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The animated cursor + click ripple, injected before any page script runs. */
const CURSOR_SCRIPT = `
  (() => {
    if (window.__vyCursor) return; window.__vyCursor = true;
    const mk = () => {
      const c = document.createElement("div");
      c.id = "vy-cursor";
      c.style.cssText = "position:fixed;z-index:2147483647;width:22px;height:22px;border-radius:50%;" +
        "background:rgba(255,255,255,.92);box-shadow:0 0 0 2px rgba(0,0,0,.45),0 2px 10px rgba(0,0,0,.5);" +
        "pointer-events:none;transform:translate(-50%,-50%);left:-40px;top:-40px;" +
        "transition:width .12s,height .12s,background .12s;";
      document.documentElement.appendChild(c);
      addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
      addEventListener("mousedown", () => { c.style.width = "16px"; c.style.height = "16px"; c.style.background = "rgba(120,220,255,.95)"; }, true);
      addEventListener("mouseup", () => { c.style.width = "22px"; c.style.height = "22px"; c.style.background = "rgba(255,255,255,.92)"; }, true);
    };
    document.readyState === "loading" ? addEventListener("DOMContentLoaded", mk) : mk();
  })();
`;

let page; // current scene's page
let cursorX = W / 2, cursorY = H / 2;

/** Timed glide — constant-ish speed, so every scene moves at the same pace. */
async function glideTo(x, y) {
  const dx = x - cursorX, dy = y - cursorY;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(8, Math.min(60, Math.round(dist / 22)));
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cursorX + (dx * i) / steps, cursorY + (dy * i) / steps);
    await sleep(14);
  }
  cursorX = x; cursorY = y;
}

async function glideToLoc(locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(250);
  const box = await locator.boundingBox();
  if (!box) throw new Error("no bounding box for locator");
  await glideTo(box.x + box.width / 2, box.y + Math.min(box.height / 2, 40));
}

async function click(locator, { settle = 900 } = {}) {
  await glideToLoc(locator);
  await sleep(350);
  await page.mouse.down(); await sleep(90); await page.mouse.up();
  await sleep(settle);
}

async function hover(locator, holdMs = 1600) {
  await glideToLoc(locator);
  await sleep(holdMs);
}

/** Sidebar navigation by the EXACT label in nav-config.ts. */
async function navTo(label) {
  const link = page.locator("aside").getByRole("link", { name: label, exact: true });
  await click(link, { settle: 400 });
  await hydrated();
  await sleep(900);
}

/** Hydration probe — the sidebar clock paints only after client mount. */
async function hydrated() {
  await page.locator("aside").getByText(/\d{2}:\d{2} IST/).first()
    .waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
}

async function slowScroll(px, { step = 120, pause = 260 } = {}) {
  const n = Math.max(1, Math.round(Math.abs(px) / step));
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, Math.sign(px) * step);
    await sleep(pause);
  }
}

async function openBreakdownTile(nth = 0) {
  // Risk/Dashboard KPI tiles advertise themselves with "click for breakdown".
  const hint = page.getByText(/click for breakdown/i).nth(nth);
  if (!(await hint.count())) return false;
  await click(hint);
  await sleep(2600);
  await page.keyboard.press("Escape");
  await sleep(700);
  return true;
}

async function switchAccount(optionLabel) {
  const sel = page.locator("aside select").first();
  await glideToLoc(sel);
  await sleep(400);
  await sel.selectOption({ label: optionLabel });
  await hydrated();
  await sleep(1400);
}

async function escapeDialog() {
  await page.keyboard.press("Escape");
  await sleep(700);
}

// ─── Scenes ─────────────────────────────────────────────────────────────────

const SCENES = [
  { n: 1, name: "dashboard", run: async () => {
    await navTo("Dashboard");
    await sleep(2500);
    await slowScroll(700);
    await openBreakdownTile(0);
    await slowScroll(900);
    await slowScroll(-1600, { step: 220, pause: 140 });
    await sleep(1200);
  }},

  { n: 2, name: "portfolio-risk", run: async () => {
    await navTo("Portfolio Risk");
    await sleep(2500);
    await openBreakdownTile(1); // Open P&L — now with the ₹ figure in the headline
    await slowScroll(500);
    // Expand the first open position and set a trailing stop, live.
    const row = page.locator("main button").filter({ hasText: /Long|Short/ }).first();
    if (await row.count()) {
      await click(row);
      await sleep(1500);
      const dlgBtn = page.getByRole("button", { name: /Set SL \/ TSL \/ target \/ price/ }).first();
      if (await dlgBtn.count()) {
        await click(dlgBtn);
        await sleep(1200);
        const tsl = page.getByLabel(/Trailing SL/i).first();
        if (await tsl.count()) { await click(tsl, { settle: 200 }); await page.keyboard.type("1", { delay: 140 }); }
        await sleep(800);
        await escapeDialog(); // nothing saved on camera — the dialog is the story
      }
    }
    await sleep(1000);
  }},

  { n: 3, name: "accounts", run: async () => {
    await navTo("Dashboard");
    await sleep(1500);
    await switchAccount("Swing — Zerodha");   // every number on screen changes
    await slowScroll(500);
    await slowScroll(-500, { step: 220, pause: 120 });
    await switchAccount("Primary");
    await sleep(1200);
    await switchAccount("All accounts");      // the aggregate view (never writable)
    await sleep(1800);
    await switchAccount("Primary");
    await sleep(1000);
  }},

  { n: 4, name: "calculator-session", run: async () => {
    await navTo("Trade Calculator");
    await sleep(2200);
    await slowScroll(600);
    await navTo("Session Plan");
    await sleep(2200);
    await slowScroll(600);
  }},

  { n: 5, name: "trades", run: async () => {
    await navTo("Trades");
    await sleep(2500);
    await slowScroll(400);
    // Open a trade's detail — legs / ladder / attachments live here.
    const firstRow = page.locator("main table tbody tr").first();
    if (await firstRow.count()) {
      await click(firstRow);
      await sleep(2000);
      await slowScroll(500);
      // Attach a chart screenshot to show the record carries evidence.
      const fileInput = page.locator('input[type="file"]').last();
      const chart = path.join(root, "docs", "screenshots", "trades.png");
      if ((await fileInput.count()) && fs.existsSync(chart)) {
        await fileInput.setInputFiles(chart).catch(() => {});
        await sleep(2200);
      }
      await escapeDialog();
    }
    // Add trade / Open trade — show the dialogs, commit nothing invented.
    for (const name of [/Add trade/i, /Open trade/i]) {
      const btn = page.getByRole("button", { name }).first();
      if (await btn.count()) {
        await click(btn);
        await sleep(2200);
        await slowScroll(300, { step: 100, pause: 200 });
        await escapeDialog();
      }
    }
  }},

  { n: 6, name: "arjuns-eye", run: async () => {
    await navTo("Arjun's Eye");
    await sleep(3000); // charts draw
    await slowScroll(1200, { step: 110, pause: 300 });
    await sleep(1200);
  }},

  { n: 7, name: "lenses-delete", run: async () => {
    await navTo("Lenses");
    await sleep(2500);
    await slowScroll(800);
    await navTo("Trades");
    const del = page.getByRole("button", { name: /Delete by/i }).first();
    if (await del.count()) {
      await click(del);
      await sleep(2600); // the scopes speak for themselves
      await escapeDialog(); // nothing is deleted on camera
    }
  }},

  { n: 8, name: "import", run: async () => {
    await switchAccount("Options — Demo");    // the deliberately empty book
    await navTo("Import");
    await sleep(1500);
    const drop = page.locator('input[type="file"]').first();
    await drop.setInputFiles(path.join(root, "tests", "fixtures", "zerodha-tradebook.csv"));
    await page.getByRole("button", { name: /Commit\s+\d+\s+new trade/i }).waitFor({ timeout: 45_000 });
    await sleep(1500);
    await slowScroll(700); // through the preview to the charge reconciliation
    await sleep(1500);
    const commit = page.getByRole("button", { name: /Commit\s+\d+\s+new trade/i });
    await click(commit);
    await page.getByText(/Imported\s+\d+\s+trade/i).waitFor({ timeout: 45_000 });
    await sleep(1800);
    // The connect card — EMPTY, per the standing rule. Pan the four tabs.
    await slowScroll(500);
    for (const tab of ["Dhan (DhanHQ v2)", "Angel One (SmartAPI)", "Upstox (Analytics token)", "Zerodha (Kite Connect)"]) {
      const t = page.getByRole("button", { name: tab }).first();
      if (await t.count()) { await click(t, { settle: 1400 }); }
    }
  }},

  { n: 9, name: "charges-broker-costs", run: async () => {
    await switchAccount("Primary");
    await navTo("Charges & MTF Leak");
    await sleep(2800);
    await slowScroll(800);
    await navTo("Broker Costs");
    await sleep(2500);
    await slowScroll(700);
  }},

  { n: 10, name: "tax", run: async () => {
    await navTo("Tax Summary");
    await sleep(2800);
    await slowScroll(700);
    await navTo("ITR Pack (India)");
    await sleep(2500);
    await slowScroll(800);
  }},

  { n: 11, name: "settings-backup", run: async () => {
    await navTo("Settings");
    await sleep(1800);
    // Three skins, one second each, back to Luxe (the landing-page look).
    for (const skin of ["Sapphire", "Aurora", "Luxe"]) {
      const b = page.getByText(skin, { exact: true }).first();
      if (await b.count()) { await click(b, { settle: 1300 }); }
    }
    await navTo("Backup & Restore");
    await sleep(2000);
    const backup = page.getByRole("button", { name: /back ?up now/i }).first();
    if (await backup.count()) { await click(backup, { settle: 2500 }); }
    await slowScroll(400);
  }},
];

// ─── Runner ─────────────────────────────────────────────────────────────────

async function main() {
  // Refuse to film anything but the demo server.
  const ping = await fetch(BASE + "/").catch(() => null);
  if (!ping) {
    console.error(`✗ demo server not running on ${BASE} — start it first: npm run demo -- --fresh`);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const results = [];

  for (const scene of SCENES) {
    if (ONLY && scene.n !== ONLY) continue;
    const label = `${String(scene.n).padStart(2, "0")}-${scene.name}`;
    process.stdout.write(`→ scene ${label} … `);
    const context = await browser.newContext({
      viewport: { width: W, height: H },
      recordVideo: { dir: OUT, size: { width: W, height: H } },
      colorScheme: "dark",
    });
    await context.addInitScript(CURSOR_SCRIPT);
    page = await context.newPage();
    cursorX = W / 2; cursorY = H / 2;
    let ok = true, err = "";
    try {
      await page.goto(BASE + "/", { waitUntil: "load", timeout: 90_000 });
      await hydrated();
      await sleep(800);
      await scene.run();
      await sleep(1200); // stillness at the end — the edit cuts on it
    } catch (e) {
      ok = false; err = e.message.split("\n")[0];
    }
    const video = page.video();
    await context.close(); // finalises the file
    if (video) {
      const p = await video.path();
      const dest = path.join(OUT, `${label}${ok ? "" : ".FAILED"}.webm`);
      fs.renameSync(p, dest);
    }
    console.log(ok ? "done" : `FAILED — ${err}`);
    results.push({ label, ok, err });
  }

  await browser.close();
  console.log("\nTakes in", OUT);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.label}${r.err ? " — " + r.err : ""}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`\nRe-run a single scene with --only=N (e.g. --only=${failed[0].label.slice(0, 2)})`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
