/**
 * Extract NSE Indices' Industry Classification STRUCTURE (12 macro-economic
 * sectors / 22 sectors / 59 industries / 197 basic industries, July 2023) from
 * the published PDF into scripts/ics-structure-2023-07.json — ONCE, committed.
 *
 *   node scripts/extract-ics-structure.mjs --pdf <nse-indices_industry-classification-structure-2023-07.pdf>
 *     [--url <where it was downloaded from>] [--out scripts/ics-structure-2023-07.json]
 *
 * v4.6.0 W2 (research R3 §4 step 4). The structure is the yardstick every crawled
 * label is validated against, so it must come from a DIFFERENT source than the
 * labels themselves (a check must not agree with itself): the labels come from
 * the exchanges' per-symbol APIs, the list from this document.
 *
 * Why x-positions and not the text: labels wrap over two or three lines and the
 * Basic Industry column runs straight into the Definition column, so plain text
 * cannot say where a label ends. The table's columns sit at fixed x offsets
 * (codes at ≈69 / 197 / 326 / 466, labels at ≈126 / 254 / 380 / 546, definitions
 * at ≈637), so each text item is assigned to its column and a label is the run of
 * items in its column from its code's row down to the next code row.
 *
 * The extraction REFUSES unless it finds exactly 12 / 22 / 59 / 197 codes, every
 * code nests under its parent's code, and every code has a label — a revised PDF
 * with a different layout fails loudly instead of emitting a short list.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const pdfPath = opt("pdf");
const out = opt("out") ?? path.join(ROOT, "scripts/ics-structure-2023-07.json");
const url =
  opt("url") ??
  "https://nsearchives.nseindia.com/web/sites/default/files/inline-files/nse-indices_industry-classification-structure-2023-07.pdf";
if (!pdfPath || !fs.existsSync(pdfPath)) {
  console.error("Usage: node scripts/extract-ics-structure.mjs --pdf <structure pdf> [--url <source url>] [--out <json>]");
  process.exit(1);
}

const pdfjs = await import(pathToFileURL(path.join(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);
const buf = fs.readFileSync(pdfPath);
const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;

// Column centres, measured on the 2023-07 PDF. An item belongs to the nearest column start to its left.
const COLS = [
  { at: 60, kind: "code", level: 0 },
  { at: 120, kind: "label", level: 0 },
  { at: 190, kind: "code", level: 1 },
  { at: 248, kind: "label", level: 1 },
  { at: 320, kind: "code", level: 2 },
  { at: 374, kind: "label", level: 2 },
  { at: 460, kind: "code", level: 3 },
  { at: 540, kind: "label", level: 3 },
  { at: 630, kind: "definition", level: 3 },
];
const CODE_RE = [/^IN\d{2}$/, /^IN\d{4}$/, /^IN\d{6}$/, /^IN\d{9}$/];
const colOf = (x) => {
  let c = null;
  for (const col of COLS) if (x >= col.at - 2) c = col;
  return c;
};

const levels = [[], [], [], []]; // { code, label, parent }
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const raw = (await page.getTextContent()).items.map((it) => ({ s: it.str.trim(), x: it.transform[4], y: it.transform[5], w: it.width }));
  // Only TABLE pages: the cover and the closing disclaimer page carry no "MES_Code" header, and the
  // page-break rule below would otherwise append the disclaimer's prose to the last label.
  if (!raw.some((it) => it.s === "MES_Code")) continue;
  const items = raw.filter((it) => it.s && it.y > 45 && it.y < 485); // below the header row, above the footer
  const codes = [];
  const labels = [[], [], [], []];
  for (const it of items) {
    const col = colOf(it.x);
    if (!col) continue;
    if (col.kind === "code" && CODE_RE[col.level].test(it.s)) codes.push({ ...it, level: col.level });
    else if (col.kind === "label") labels[col.level].push(it);
  }
  // Every code row on the page, top to bottom — a label ends where the next code row at its level OR ANY
  // HIGHER level begins (a new sector row also starts a new industry and basic row).
  // A label that runs over a page break continues at the top of the next page with NO code row
  // ("Dealers – Commercial Vehicles, Tractors," / "Construction Vehicles"): label lines above the
  // page's first code row at that level or higher belong to the previous page's last label.
  for (let lv = 0; lv < 4; lv++) {
    const firstRow = codes.filter((o) => o.level <= lv).reduce((m, o) => Math.max(m, o.y), -Infinity);
    const orphans = labels[lv].filter((l) => l.y > firstRow + 1);
    const prev = levels[lv][levels[lv].length - 1];
    if (orphans.length && prev) prev.label = tidy(`${prev.label} ${joinLines(orphans)}`);
  }
  for (const c of codes) {
    const stop = codes
      .filter((o) => o.y < c.y - 1 && o.level <= c.level)
      .reduce((m, o) => Math.max(m, o.y), -Infinity);
    const words = labels[c.level].filter((l) => l.y <= c.y + 1 && l.y > stop + 1);
    levels[c.level].push({ code: c.s, label: tidy(joinLines(words)) });
  }
}

/**
 * Items top to bottom, left to right. Two items on ONE line that touch are one word split by the PDF
 * ("Telecommunic" + "ation"), so they join with no space; everything else joins with one space.
 */
function joinLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  let text = "";
  let prev = null;
  for (const it of sorted) {
    const sameLine = prev && Math.abs(prev.y - it.y) < 1;
    const touching = sameLine && it.x - (prev.x + (prev.w ?? 0)) < 0.8;
    text += prev ? (touching ? "" : " ") + it.s : it.s;
    prev = it;
  }
  return text;
}
function tidy(s) {
  return s.replace(/\s+/g, " ").replace(/\s+,/g, ",").replace(/\s*–\s*/g, " – ").trim();
}

/**
 * Words the PDF itself breaks across two lines with no hyphen, so no layout rule can tell them from
 * two words. Each repair must match EXACTLY the number of times stated, or the extraction refuses —
 * a revised PDF that no longer wraps the word fails here instead of silently keeping a stale fix.
 */
const REPAIRS = [{ from: "Telecommunic ation", to: "Telecommunication", times: 2 }];
for (const r of REPAIRS) {
  let hits = 0;
  for (const rows of levels) for (const row of rows) if (row.label === r.from) { row.label = r.to; hits++; }
  if (hits !== r.times) {
    console.error(`✗ refused — repair "${r.from}" matched ${hits} label(s), expected ${r.times}`);
    process.exit(2);
  }
}

const EXPECT = [12, 22, 59, 197];
const NAMES = ["macro", "sector", "industry", "basic"];
const problems = [];
levels.forEach((rows, i) => {
  const uniq = new Set(rows.map((r) => r.code));
  if (uniq.size !== rows.length) problems.push(`${NAMES[i]}: duplicate codes`);
  if (rows.length !== EXPECT[i]) problems.push(`${NAMES[i]}: ${rows.length} codes, expected ${EXPECT[i]}`);
  for (const r of rows) {
    if (!r.label) problems.push(`${r.code}: no label`);
    if (i > 0) {
      const parent = r.code.slice(0, [4, 6, 8][i - 1]);
      if (!levels[i - 1].some((q) => q.code === parent)) problems.push(`${r.code}: parent ${parent} missing`);
      r.parent = parent;
    }
  }
});
if (problems.length) {
  console.error(`✗ refused — ${problems.length} problem(s):\n  ` + problems.slice(0, 30).join("\n  "));
  process.exit(2);
}

const json = {
  name: "NSE Indices Industry Classification Structure",
  version: "2023-07",
  provenance: {
    url,
    file: path.basename(pdfPath),
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    bytes: buf.length,
    extractedAt: new Date().toISOString().slice(0, 10),
    extractedBy: "scripts/extract-ics-structure.mjs",
  },
  counts: Object.fromEntries(NAMES.map((n, i) => [n, levels[i].length])),
  macro: levels[0],
  sector: levels[1],
  industry: levels[2],
  basic: levels[3],
};
fs.writeFileSync(out, JSON.stringify(json, null, 1) + "\n");
console.log(`✓ ${out}\n  ${EXPECT.map((n, i) => `${n} ${NAMES[i]}`).join(" / ")}, sha256 ${json.provenance.sha256.slice(0, 16)}…`);
