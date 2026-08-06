/**
 * Build the Vyuha logo master art.
 *
 * ── Why the glyph is an OUTLINE, not text ───────────────────────────────────
 *
 * The mark is the Devanagari letter व (U+0935) on a squircle. If it shipped as
 * a <text> element it would depend on a Devanagari font being installed on the
 * machine doing the rasterising — and on a machine without one, व renders as a
 * tofu box. That failure would reach a user's taskbar, dock and installer, and
 * it would only appear on the machines least likely to be ours. So the glyph is
 * committed here as a flattened path, extracted once from a font whose licence
 * permits exactly that.
 *
 * ── The licence matters and is not incidental ───────────────────────────────
 *
 * The outline comes from **Noto Sans Devanagari**, under the SIL Open Font
 * License, which explicitly permits glyph outlines to be used in derivative
 * works including logos. It is deliberately NOT taken from a system font such
 * as Windows' Nirmala UI: bundled proprietary fonts generally licence you to
 * *set type*, not to embed their outlines in a mark you intend to own. Extract
 * a replacement only from an OFL/Apache-licensed face.
 *
 * ── The design ──────────────────────────────────────────────────────────────
 *
 * Devanagari hangs from the shirorekha, the headline stroke. Here that stroke
 * is extended edge to edge across the squircle, so it doubles as a price level
 * cutting the frame — one form doing both jobs. It is also what makes the
 * secondary ₹ mark a family member rather than a second icon: ₹ was derived
 * from र and hangs from the same stroke, so swapping the glyph under the same
 * bar keeps the system intact.
 *
 * Usage:  node scripts/make-logo.mjs        → writes SVG masters + icon-source.png
 *         npx tauri icon src-tauri/icon-source.png   → the .ico/.icns/PNG set
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const outDir = path.join(root, "public", "brand");
fs.mkdirSync(outDir, { recursive: true });

// ── Brand palette ───────────────────────────────────────────────────────────
// Matches the accent skins the app already ships (app/globals.css).
export const SKINS = {
  terminal: { name: "Terminal teal", bg: "#0d9488", deep: "#0f766e" },
  tape: { name: "Tape amber", bg: "#d97706", deep: "#b45309" },
  ice: { name: "Ice blue", bg: "#0284c7", deep: "#0369a1" },
};

/**
 * व, flattened from Noto Sans Devanagari (SIL OFL), 1000 upm, weight 700.
 * Font coordinates are Y-up; the transform in `mark()` flips them.
 */
const VA_PATH =
  fs.readFileSync(path.join(root, "scripts", "glyph-va.path"), "utf8").trim();

/** Glyph bounding box in font units, read from the extracted metrics. */
const VA_BBOX = JSON.parse(fs.readFileSync(path.join(root, "scripts", "glyph-va.json"), "utf8"));
/**
 * Where the shirorekha sits and how thick it is, in font units, measured by
 * rasterising the glyph and finding the widest ink band at its top. The
 * full-width bar is drawn at exactly this y and thickness so it fuses with the
 * glyph's own stroke instead of sitting near it.
 */
const VA_BAR = { y: 622, thickness: 112 };

const RUPEE_PATH =
  fs.readFileSync(path.join(root, "scripts", "glyph-rupee.path"), "utf8").trim();
const RUPEE_BBOX = JSON.parse(
  fs.readFileSync(path.join(root, "scripts", "glyph-rupee.json"), "utf8"),
);

/**
 * Lay out one mark. Both glyphs go through here so the family cannot drift:
 * same squircle radius, same cap height, same baseline, same bar thickness.
 *
 * @returns {{S:number,r:number,barY:number,barH:number,gx:number,gy:number,scale:number,d:string}}
 */
function geometry(size, glyph, rounded) {
  const S = size;
  const { path: d, bbox } = glyph;
  const glyphH = bbox.yMax - bbox.yMin;
  const scale = (S * 0.46) / glyphH;
  const gw = (bbox.xMax - bbox.xMin) * scale;
  return {
    S,
    d,
    scale,
    r: rounded ? S * 0.29 : 0, // 29% — the squircle radius the family shares
    gx: (S - gw) / 2 - bbox.xMin * scale,
    // Baseline placed so the optical centre of glyph+bar sits at the centre.
    gy: S * 0.72,
    // The bar is drawn at the glyph's OWN shirorekha height so the two fuse
    // into one stroke. Both glyphs top out at 622, which is why ₹ is family.
    barY: S * 0.72 - VA_BAR.y * scale,
    barH: VA_BAR.thickness * scale,
  };
}

const VA = { path: VA_PATH, bbox: VA_BBOX };
const RUPEE = { path: RUPEE_PATH, bbox: RUPEE_BBOX };

/**
 * Body of the mark, shared by the SVG files and the React component.
 *
 * The bar is CLIPPED to the squircle. It is drawn full width so it reads as a
 * price level cutting the whole frame, but at its height the corner radius has
 * not yet straightened out, so an unclipped bar overhangs the silhouette by a
 * pixel or two at icon resolutions — a stray ink-coloured nub floating off the
 * rounded corner, most obvious in the macOS dock against a busy wallpaper.
 */
function body(g, { fill, ink, clipId }) {
  const { S, r, barY, barH, gx, gy, scale, d } = g;
  return `  <defs>
    <clipPath id="${clipId}">
      <rect width="${S}" height="${S}" rx="${r.toFixed(2)}" ry="${r.toFixed(2)}"/>
    </clipPath>
  </defs>
  <g clip-path="url(#${clipId})">
    <rect width="${S}" height="${S}" fill="${fill}"/>
    <rect x="0" y="${barY.toFixed(2)}" width="${S}" height="${barH.toFixed(2)}" fill="${ink}"/>
    <g transform="translate(${gx.toFixed(2)} ${gy.toFixed(2)}) scale(${scale.toFixed(5)} -${scale.toFixed(5)})">
      <path d="${d}" fill="${ink}"/>
    </g>
  </g>`;
}

/**
 * The square mark.
 *
 * @param {object} o
 * @param {string} o.fill      squircle colour
 * @param {string} o.ink       glyph + bar colour
 * @param {number} o.size      viewBox size
 * @param {boolean} o.rounded  false gives a full-bleed square
 */
export function mark({ fill, ink = "#ffffff", size = 512, rounded = true, id = "vy" } = {}) {
  const g = geometry(size, VA, rounded);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
${body(g, { fill, ink, clipId: id })}
</svg>`;
}

/** The secondary ₹ mark — same geometry, different glyph and hue. */
export function rupeeMark({ fill = SKINS.tape.bg, ink = "#ffffff", size = 512, rounded = true, id = "vyr" } = {}) {
  const g = geometry(size, RUPEE, rounded);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
${body(g, { fill, ink, clipId: id })}
</svg>`;
}

/**
 * Emit `components/brand/mark.tsx`.
 *
 * Generated rather than hand-written for one reason: the sidebar used to render
 * `व` as a live text node, which is a tofu box on any machine without a
 * Devanagari font — the same failure the icon avoids by shipping an outline.
 * The component must therefore carry the outline too, and generating it keeps
 * the in-app mark and the installer icon provably identical.
 *
 * It clips with CSS `inset(0 round …)` instead of the `<clipPath>` element the
 * standalone SVGs use. A `<clipPath>` needs an `id`, and two marks on one page
 * would then share it; CSS needs no id, so the component stays a plain server
 * component with no `useId` and no "use client".
 */
function component() {
  const S = 1000; // unit viewBox — callers scale via width/height
  const g = geometry(S, VA, true);
  const gr = geometry(S, RUPEE, true);
  const round = ((g.r / S) * 100).toFixed(0);

  const shape = (x) => `      <rect width="${S}" height="${S}" fill="var(--mark-fill)" />
      <rect y={${x.barY.toFixed(1)}} width="${S}" height={${x.barH.toFixed(1)}} fill="var(--mark-ink)" />
      <g transform="translate(${x.gx.toFixed(1)} ${x.gy.toFixed(1)}) scale(${x.scale.toFixed(5)} -${x.scale.toFixed(5)})">
        <path d="${x.d}" fill="var(--mark-ink)" />
      </g>`;

  return `/**
 * GENERATED by scripts/make-logo.mjs — do not edit by hand.
 * Re-run \`node scripts/make-logo.mjs\` to regenerate.
 *
 * The Vyuha mark: व hanging from a shirorekha extended edge to edge, so the
 * headline stroke of the letter doubles as a price level cutting the frame.
 *
 * Colours default to the theme's primary tokens, so the mark re-tints itself
 * with the active accent skin (terminal / tape / ice) and with light mode.
 */
import type { CSSProperties } from "react";

type MarkProps = {
  size?: number;
  className?: string;
  /** Squircle colour. Defaults to the active accent. */
  fill?: string;
  /** Glyph + bar colour. Defaults to the accent's foreground. */
  ink?: string;
  /** Square off the corners (for tight chrome that does its own masking). */
  square?: boolean;
  title?: string;
};

function styleFor(fill: string, ink: string, square: boolean): CSSProperties {
  return {
    ["--mark-fill" as string]: fill,
    ["--mark-ink" as string]: ink,
    // See the generator: clipping via CSS avoids a colliding <clipPath> id.
    clipPath: square ? undefined : "inset(0 round ${round}%)",
  };
}

export function VyuhaMark({
  size = 28,
  className,
  fill = "var(--color-primary)",
  ink = "var(--color-primary-foreground)",
  square = false,
  title,
}: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 ${S} ${S}"
      className={className}
      style={styleFor(fill, ink, square)}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
${shape(g)}
    </svg>
  );
}

/**
 * Paint the mark into a 2D canvas — for the share card, which exports a PNG.
 *
 * The share card previously drew the letter as canvas TEXT in Inter, which has
 * no Devanagari coverage at all; the glyph came from whatever the system fell
 * back to, or from nothing. That baked a tofu box into an image users post
 * publicly. Path2D takes the same outline the icon uses, so the exported PNG no
 * longer depends on the exporting machine's fonts.
 */
export function drawVyuhaMark(
  ctx: CanvasRenderingContext2D,
  opts: { x: number; y: number; size: number; fill: string; ink: string },
) {
  const { x, y, size, fill, ink } = opts;
  const k = size / ${S};
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * ${(g.r / S).toFixed(2)});
  ctx.clip();
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = ink;
  ctx.fillRect(0, ${g.barY.toFixed(1)} * k, size, ${g.barH.toFixed(1)} * k);
  ctx.translate(${g.gx.toFixed(1)} * k, ${g.gy.toFixed(1)} * k);
  ctx.scale(${g.scale.toFixed(5)} * k, -${g.scale.toFixed(5)} * k);
  ctx.fill(new Path2D(${JSON.stringify(g.d)}));
  ctx.restore();
}

/** The secondary ₹ mark — same bar, same baseline, different glyph. */
export function RupeeMark({
  size = 28,
  className,
  fill = "var(--color-primary)",
  ink = "var(--color-primary-foreground)",
  square = false,
  title,
}: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 ${S} ${S}"
      className={className}
      style={styleFor(fill, ink, square)}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
${shape(gr)}
    </svg>
  );
}
`;
}

async function main() {
  const written = [];

  // Skin variants of the primary mark.
  for (const [key, skin] of Object.entries(SKINS)) {
    const svg = mark({ fill: skin.bg });
    const p = path.join(outDir, `vyuha-${key}.svg`);
    fs.writeFileSync(p, svg);
    written.push(p);
  }

  // Secondary ₹ mark.
  fs.writeFileSync(path.join(outDir, "vyuha-rupee.svg"), rupeeMark());
  written.push(path.join(outDir, "vyuha-rupee.svg"));

  // The icon source Tauri rasterises the whole set from.
  //
  // The squircle is baked IN rather than left full-bleed. `tauri icon` only
  // resizes — it adds no mask and no padding — so a single source has to serve
  // Windows, macOS and Linux. A rounded source is the safe compromise: correct
  // on macOS, which expects the shape in the artwork, and merely inset on
  // Windows, which would have accepted full-bleed. Shipping full-bleed instead
  // would leave a hard-cornered square in the macOS dock next to every other
  // rounded icon, which is the more visible error.
  const iconSvg = mark({ fill: SKINS.terminal.bg, size: 1024, rounded: true });
  const iconSource = path.join(root, "src-tauri", "icon-source.png");
  await sharp(Buffer.from(iconSvg)).png().toFile(iconSource);
  written.push(iconSource);

  // Favicon + web assets.
  await sharp(Buffer.from(mark({ fill: SKINS.terminal.bg, size: 512 })))
    .resize(512, 512).png().toFile(path.join(outDir, "vyuha-512.png"));
  await sharp(Buffer.from(mark({ fill: SKINS.terminal.bg, size: 512 })))
    .resize(180, 180).png().toFile(path.join(outDir, "apple-touch-icon.png"));
  written.push(path.join(outDir, "vyuha-512.png"), path.join(outDir, "apple-touch-icon.png"));

  // The in-app mark, generated so it cannot drift from the icon.
  const cp = path.join(root, "components", "brand", "mark.tsx");
  fs.mkdirSync(path.dirname(cp), { recursive: true });
  fs.writeFileSync(cp, component());
  written.push(cp);

  for (const w of written) console.log("✓", path.relative(root, w));
  console.log("\nNext:  npx tauri icon src-tauri/icon-source.png");
}

main().catch((e) => {
  console.error("✗ logo build failed:", e.message);
  process.exit(1);
});
