/**
 * Full-dashboard 4K capture against an ALREADY-RUNNING VYUHA server (dev or standalone).
 *
 *   node scripts/shoot-dashboard.mjs --base http://localhost:3011 --out out.png [--width 1920] [--scale 2] [--route /]
 *
 * Why not `fullPage: true`: the app shell is `h-screen overflow-hidden` with `<main>` as the scroll
 * container (app/layout.tsx), so Playwright's full-page mode sees nothing below the fold. This
 * opens the route at the base width, measures main.scrollHeight, resizes the viewport to that
 * height so nothing scrolls, waits for recharts to re-measure, and shoots the whole viewport at
 * deviceScaleFactor 2 (1920 CSS px → 3840 px wide). The sidebar's fold state lives in
 * localStorage["vyuha-nav-order"] ({v:1, groups, items, shown, expanded}); an init script expands
 * every group so the shot matches an owner's expanded view. Which ACCOUNT renders is
 * settings.selectedAccountId in the server's database — set it there before shooting.
 * First used 2026-09-17 for the options-strategy advertising capture (docs/DECISIONS.md).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { chromium } = require("@playwright/test");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg("base", "http://localhost:3011");
const OUT = path.resolve(arg("out", "dashboard-4k.png"));
const WIDTH = Number(arg("width", "1920"));
const SCALE = Number(arg("scale", "2"));
const ROUTE = arg("route", "/");

const GROUPS = ["Overview", "Positions", "Risk", "Journal", "Import", "Tax", "Analytics", "Back Office", "System"];
const navOrder = JSON.stringify({ v: 1, groups: [], items: {}, shown: {}, expanded: Object.fromEntries(GROUPS.map((g) => [g, true])) });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 1080 }, deviceScaleFactor: SCALE, colorScheme: "dark" });
await ctx.addInitScript((v) => { try { localStorage.setItem("vyuha-nav-order", v); localStorage.setItem("vyuha-sidebar-collapsed", "0"); } catch {} }, navOrder);
const page = await ctx.newPage();
await page.goto(BASE + ROUTE, { waitUntil: "networkidle", timeout: 120_000 });
await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
await page.waitForTimeout(1500); // hydration: the account switcher and stored sidebar state land client-side

const contentHeight = () => page.evaluate(() => {
  const main = document.querySelector("main");
  return Math.ceil(Math.max(main ? main.scrollHeight : 0, document.documentElement.scrollHeight));
});
let height = await contentHeight();
await page.setViewportSize({ width: WIDTH, height: height + 8 });
await page.waitForTimeout(2500); // recharts ResponsiveContainer re-measures on resize
const grown = await contentHeight();
if (grown > height + 8) {
  height = grown;
  await page.setViewportSize({ width: WIDTH, height: height + 8 });
  await page.waitForTimeout(2000);
}
await page.screenshot({ path: OUT, fullPage: false });
console.log(`shot ${OUT} — ${WIDTH}×${height + 8} CSS px at ${SCALE}× (${WIDTH * SCALE}×${(height + 8) * SCALE})`);
await browser.close();
