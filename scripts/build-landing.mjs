// Turn the landing page into ONE self-contained .html file.
//
//   node scripts/build-landing.mjs
//   → docs/monetization/landing-page.standalone.html
//
// Every <img src="../screenshots/x.png"> becomes an inline data: URI, so the
// output is a single file you can email, drop on any static host, or open from
// a USB stick with no broken images.
//
// It also REFUSES to build while the [[PLACEHOLDERS]] are unfilled — shipping a
// page whose buy button goes to wa.me/[[WA_NUMBER]] would lose every sale that
// clicked it.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "docs", "monetization", "landing-page.html");
const out = path.join(root, "docs", "monetization", "landing-page.standalone.html");

let html = readFileSync(src, "utf8");

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };

let inlined = 0;
let missing = [];
html = html.replace(/src="((?:\.\.?\/)[^"]+\.(?:png|jpe?g|gif|webp|svg))"/gi, (m, rel) => {
  const abs = path.resolve(path.dirname(src), rel);
  if (!existsSync(abs)) { missing.push(rel); return m; }
  const mime = MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
  inlined++;
  return `src="data:${mime};base64,${readFileSync(abs).toString("base64")}"`;
});

const placeholders = [...new Set([...html.matchAll(/\[\[([A-Z_]+)\]\]/g)].map((m) => m[1]))];
if (placeholders.length) {
  console.error("✗ Refusing to build — these placeholders are still unfilled in landing-page.html:\n");
  for (const p of placeholders) console.error(`    [[${p}]]`);
  console.error("\nFill them in the source file first (see the comment at the top of it), then re-run.");
  process.exit(1);
}

if (missing.length) {
  console.warn(`⚠ ${missing.length} image(s) not found and left as-is: ${missing.join(", ")}`);
}

writeFileSync(out, html);
const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(`✓ ${path.relative(root, out)}  —  ${inlined} image(s) inlined, ${kb} KB`);
console.log("  Single file: email it, host it anywhere, or open it offline.");
