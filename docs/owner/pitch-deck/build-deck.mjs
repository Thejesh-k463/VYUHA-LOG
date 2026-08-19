// Renders docs/owner/pitch-deck/deck.html to docs/owner/RAINMATTER_DECK.pdf with Playwright's
// bundled Chromium. Screenshots are referenced by relative path (../../screenshots/*.png) and are
// loaded from file://, so no server is needed.  Run:  node docs/owner/pitch-deck/build-deck.mjs
import { chromium } from "playwright";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const html = resolve(here, "deck.html");
const out = resolve(here, "..", "RAINMATTER_DECK.pdf");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(pathToFileURL(html).href, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ media: "print" });
  await page.pdf({
    path: out,
    width: "13.333in",
    height: "7.5in",
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });
} finally {
  await browser.close();
}
const mb = statSync(out).size / 1024 / 1024;
console.log(`wrote ${out} (${mb.toFixed(2)} MB)`);
