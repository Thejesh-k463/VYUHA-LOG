/**
 * Build the Vyuha logo master art (v3 — "Trinity Chakra").
 *
 * ── Why the glyph is an OUTLINE, not text ───────────────────────────────────
 *
 * The mark carries the Devanagari letter व (U+0935). If it shipped as a <text>
 * element it would depend on a Devanagari font being installed on the machine
 * doing the rasterising — and on a machine without one, व renders as a tofu
 * box. That failure would reach a user's taskbar, dock and installer, and it
 * would only appear on the machines least likely to be ours. So the glyph is
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
 * a replacement only from an OFL/Apache-licensed face. The v3 redesign REUSES
 * the committed outline rather than re-tracing it — same path, same licence
 * position, and the mark cannot drift from the one already shipped.
 *
 * ── The v3 design ───────────────────────────────────────────────────────────
 *
 * Three arcs ring the mark — teal, gold, violet — the same three roles the
 * interface assigns those hues: teal is what you can act on, gold is money,
 * violet is what the numbers say about you. They are struck at one radius with
 * round caps so they read as one interrupted ring rather than three shapes.
 *
 * Inside, Devanagari still hangs from the shirorekha, but the bar is now a slim
 * level (44 units) sitting at the glyph's own headline height rather than a
 * full-thickness stroke fused to it — a price level crossing the frame instead
 * of a slab. The ₹ coin in the lower right is the secondary mark absorbed into
 * the primary: ₹ derives from र and hangs from the same stroke, which is what
 * makes it family rather than decoration.
 *
 * ── Fixed colours, and why the old fill/ink props are gone ──────────────────
 *
 * v1 let callers re-tint the mark so it followed the active accent skin. Those
 * skins are retired, and in v3 the three hues ARE the identity — re-tinting
 * would say something false about which hue means what. The mark now paints
 * itself and takes no colour arguments.
 *
 * Usage:  node scripts/make-logo.mjs        → SVG masters + icon-source.png + mark.tsx
 *         npm run desktop:icons             → the above, then the .ico/.icns/PNG set
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const outDir = path.join(root, "public", "brand");
fs.mkdirSync(outDir, { recursive: true });

/**
 * व, flattened from Noto Sans Devanagari (SIL OFL), 1000 upm, weight 700.
 * Font coordinates are Y-up; the transforms below flip them.
 */
const VA_PATH = fs.readFileSync(path.join(root, "scripts", "glyph-va.path"), "utf8").trim();
const RUPEE_PATH = fs.readFileSync(path.join(root, "scripts", "glyph-rupee.path"), "utf8").trim();

/**
 * Every number in the composition, in one place, on a 1000-unit viewBox.
 *
 * The glyph transforms are not free parameters — they place the outline so its
 * headline lands exactly on `bar.y` and the ₹ centres in the coin. Changing a
 * scale without recomputing the translate will slide the letter off its bar.
 */
const GEO = {
  S: 1000,
  arcWidth: 58,
  arcWidthFavicon: 72, // heavier, so the ring survives a 16px favicon
  bar: { x: 170, y: 336, w: 660, h: 44, rx: 22 },
  // 618 wide × 622 tall at 0.60 → centred at x=(1000−370.8)/2, baseline 709,
  // which puts the glyph's shirorekha at exactly bar.y.
  va: { tx: 314.6, ty: 709, s: 0.6 },
  coin: { cx: 791, cy: 791, r: 138, ring: 12 },
  // 62..521 wide at 0.31 → optical centre lands on the coin centre.
  rupee: { tx: 700, ty: 887, s: 0.31 },
  tileRadius: 290, // 29% — the squircle radius the icon family shares
};

/**
 * Gradient definitions.
 *
 * The ids are FIXED rather than generated. Two marks on one page therefore
 * declare the same ids, and the first declaration wins — which is harmless
 * precisely because the colours are fixed: every instance defines identical
 * stops, so whichever wins paints the same thing. This is what lets the React
 * component stay a plain server component with no `useId` and no "use client".
 * If a caller-tintable mark is ever reintroduced, this assumption breaks and
 * the ids must become unique again.
 */
function defs(idAttr = "id", stopColor = "stop-color") {
  const lg = (id, x1, y1, x2, y2, stops) =>
    `    <linearGradient ${idAttr}="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
    stops.map(([o, c]) => `<stop offset="${o}" ${stopColor}="${c}"/>`).join("") +
    `</linearGradient>`;
  return [
    lg("vy3-t", 0, 0, 1, 1, [["0%", "#2dd4bf"], ["100%", "#14b8a6"]]),
    lg("vy3-g", 0, 0, 1, 0, [["0%", "#f5d478"], ["100%", "#d99a1d"]]),
    lg("vy3-v", 0, 1, 1, 0, [["0%", "#a78bfa"], ["100%", "#7c3aed"]]),
    lg("vy3-teal", 0, 0, 0, 1, [["0%", "#8ff5e8"], ["100%", "#14b8a6"]]),
    lg("vy3-gold", 0, 0, 0, 1, [["0%", "#f7ecd2"], ["55%", "#e5b13d"], ["100%", "#b47f1d"]]),
    `    <radialGradient ${idAttr}="vy3-disc" cx="35%" cy="25%" r="110%"><stop offset="0%" ${stopColor}="#101a2e"/><stop offset="100%" ${stopColor}="#070b13"/></radialGradient>`,
    `    <radialGradient ${idAttr}="vy3-tile" cx="30%" cy="18%" r="110%"><stop offset="0%" ${stopColor}="#101a2e"/><stop offset="100%" ${stopColor}="#05070d"/></radialGradient>`,
  ].join("\n");
}

/** The three-arc ring, struck at one radius with round caps. */
function arcs(width, w = "stroke-width", lc = "stroke-linecap") {
  return `  <g fill="none" ${w}="${width}" ${lc}="round">
    <path d="M 500 88 A 412 412 0 0 1 857 294" stroke="url(#vy3-t)"/>
    <path d="M 912 500 A 412 412 0 0 1 500 912" stroke="url(#vy3-g)"/>
    <path d="M 143 706 A 412 412 0 0 1 88 500 A 412 412 0 0 1 143 294" stroke="url(#vy3-v)"/>
  </g>`;
}

/** Shirorekha + व, the part that is the same in every variant. */
function letter() {
  const { bar, va } = GEO;
  return `  <rect x="${bar.x}" y="${bar.y}" width="${bar.w}" height="${bar.h}" rx="${bar.rx}" fill="url(#vy3-teal)"/>
  <g transform="translate(${va.tx} ${va.ty}) scale(${va.s} -${va.s})">
    <path fill="url(#vy3-teal)" d="${VA_PATH}"/>
  </g>`;
}

/**
 * The ₹ coin.
 *
 * `withRupee: false` keeps the disc and its gold ring but drops the glyph —
 * what the favicon does, because at 16px the ₹ outline turns to mud while the
 * gilded dot still reads as part of the mark.
 */
function coin(withRupee = true) {
  const { coin: c, rupee: r } = GEO;
  const glyph = withRupee
    ? `\n  <g transform="translate(${r.tx} ${r.ty}) scale(${r.s} -${r.s})">
    <path fill="url(#vy3-gold)" d="${RUPEE_PATH}"/>
  </g>`
    : "";
  return `  <circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" fill="url(#vy3-disc)"/>
  <circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" fill="none" stroke="url(#vy3-g)" stroke-width="${c.ring}"/>${glyph}`;
}

/**
 * @param {"mark"|"appicon"|"favicon"} variant
 *   mark     transparent ground, full composition — the app + web mark
 *   appicon  opaque squircle tile behind it — what the installer rasterises
 *   favicon  heavier arcs, coin without the ₹ — survives 16px
 */
export function svgFor(variant) {
  const { S } = GEO;
  const isFavicon = variant === "favicon";
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">`,
    `  <defs>\n${defs()}\n  </defs>`,
    variant === "appicon"
      ? `  <rect width="${S}" height="${S}" rx="${GEO.tileRadius}" fill="url(#vy3-tile)"/>`
      : null,
    arcs(isFavicon ? GEO.arcWidthFavicon : GEO.arcWidth),
    letter(),
    coin(!isFavicon),
    `</svg>`,
  ];
  return parts.filter(Boolean).join("\n");
}

/**
 * Emit `components/brand/mark.tsx`.
 *
 * Generated rather than hand-written for one reason: the sidebar used to render
 * `व` as a live text node, which is a tofu box on any machine without a
 * Devanagari font — the same failure the icon avoids by shipping an outline.
 * The component must therefore carry the outline too, and generating it keeps
 * the in-app mark and the installer icon provably identical.
 */
function component() {
  const { S, coin: c, bar, va, rupee } = GEO;
  // JSX needs camelCase attribute names and self-closing tags.
  const jsxDefs = defs("id", "stopColor").replace(/<stop offset/g, "<stop offset").replace(/\/>/g, " />");
  const jsxArcs = arcs(GEO.arcWidth, "strokeWidth", "strokeLinecap").replace(/\/>/g, " />");
  const jsxLetter = letter().replace(/\/>/g, " />");
  const jsxCoin = coin(true).replace(/stroke-width=/g, "strokeWidth=").replace(/\/>/g, " />");

  return `/**
 * GENERATED by scripts/make-logo.mjs — do not edit by hand.
 * Re-run \`node scripts/make-logo.mjs\` (or \`npm run desktop:icons\`) to regenerate.
 *
 * The Vyuha mark, v3 "Trinity Chakra": three arcs in the interface's own three
 * roles — teal you can act on, gold for money, violet for what the numbers say
 * — ringing व hung from a shirorekha drawn as a price level, with the ₹ coin
 * in the lower right.
 *
 * The colours are FIXED. v1 let callers re-tint the mark to follow the accent
 * skin; those skins are retired, and here the hues carry meaning, so a tinted
 * mark would state something false. There are no fill/ink props any more.
 *
 * The gradient ids are fixed too. Two marks on one page declare the same ids
 * and the first wins — harmless, because every instance declares identical
 * stops. That is what keeps this a plain server component with no \`useId\`.
 */

type MarkProps = {
  size?: number;
  className?: string;
  title?: string;
  /**
   * Force the ₹ coin on or off. Left alone, the coin is dropped below 24px,
   * where its outline turns to mud and costs more legibility than it adds.
   */
  coin?: boolean;
};

export function VyuhaMark({ size = 28, className, title, coin }: MarkProps) {
  const showCoin = coin ?? size >= 24;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 ${S} ${S}"
      className={className}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <defs>
${jsxDefs}
      </defs>
${jsxArcs}
${jsxLetter}
      {showCoin ? (
        <>
${jsxCoin}
        </>
      ) : null}
    </svg>
  );
}

/**
 * Paint the mark into a 2D canvas — for the share card, which exports a PNG,
 * and the printable trade report.
 *
 * The share card once drew the letter as canvas TEXT in Inter, which has no
 * Devanagari coverage at all; the glyph came from whatever the system fell back
 * to, or from nothing, baking a tofu box into an image users post publicly.
 * Path2D takes the same outline the icon uses, so the exported PNG no longer
 * depends on the exporting machine's fonts — and the gradients below are the
 * same values the SVG declares, so the two cannot drift apart.
 */
export function drawVyuhaMark(
  ctx: CanvasRenderingContext2D,
  opts: { x: number; y: number; size: number; coin?: boolean },
) {
  const { x, y, size } = opts;
  const showCoin = opts.coin ?? size >= 24;
  const k = size / ${S};
  const g = (x0: number, y0: number, x1: number, y1: number, stops: [number, string][]) => {
    const grd = ctx.createLinearGradient(x0 * k, y0 * k, x1 * k, y1 * k);
    for (const [o, c] of stops) grd.addColorStop(o, c);
    return grd;
  };

  ctx.save();
  ctx.translate(x, y);

  // Three arcs, struck at one radius with round caps.
  ctx.lineWidth = ${GEO.arcWidth} * k;
  ctx.lineCap = "round";
  const ring: [number, number, CanvasGradient][] = [
    [-90, -30, g(88, 88, 912, 912, [[0, "#2dd4bf"], [1, "#14b8a6"]])],
    [0, 90, g(88, 500, 912, 500, [[0, "#f5d478"], [1, "#d99a1d"]])],
    [120, 270, g(88, 912, 912, 88, [[0, "#a78bfa"], [1, "#7c3aed"]])],
  ];
  for (const [from, to, grad] of ring) {
    ctx.beginPath();
    ctx.strokeStyle = grad;
    ctx.arc(500 * k, 500 * k, 412 * k, (from * Math.PI) / 180, (to * Math.PI) / 180);
    ctx.stroke();
  }

  // Shirorekha + व, in the vertical teal.
  const teal = g(0, 0, 0, ${S}, [[0, "#8ff5e8"], [1, "#14b8a6"]]);
  ctx.fillStyle = teal;
  ctx.beginPath();
  ctx.roundRect(${bar.x} * k, ${bar.y} * k, ${bar.w} * k, ${bar.h} * k, ${bar.rx} * k);
  ctx.fill();
  ctx.save();
  ctx.translate(${va.tx} * k, ${va.ty} * k);
  ctx.scale(${va.s} * k, -${va.s} * k);
  ctx.fill(new Path2D(${JSON.stringify(VA_PATH)}));
  ctx.restore();

  if (showCoin) {
    const disc = ctx.createRadialGradient(
      ${(c.cx - c.r * 0.3).toFixed(0)} * k, ${(c.cy - c.r * 0.5).toFixed(0)} * k, 0,
      ${c.cx} * k, ${c.cy} * k, ${c.r * 1.1} * k,
    );
    disc.addColorStop(0, "#101a2e");
    disc.addColorStop(1, "#070b13");
    ctx.beginPath();
    ctx.arc(${c.cx} * k, ${c.cy} * k, ${c.r} * k, 0, Math.PI * 2);
    ctx.fillStyle = disc;
    ctx.fill();
    ctx.lineWidth = ${c.ring} * k;
    ctx.strokeStyle = g(${c.cx - c.r}, ${c.cy}, ${c.cx + c.r}, ${c.cy}, [[0, "#f5d478"], [1, "#d99a1d"]]);
    ctx.stroke();

    ctx.save();
    ctx.fillStyle = g(0, ${c.cy - c.r}, 0, ${c.cy + c.r}, [[0, "#f7ecd2"], [0.55, "#e5b13d"], [1, "#b47f1d"]]);
    ctx.translate(${rupee.tx} * k, ${rupee.ty} * k);
    ctx.scale(${rupee.s} * k, -${rupee.s} * k);
    ctx.fill(new Path2D(${JSON.stringify(RUPEE_PATH)}));
    ctx.restore();
  }

  ctx.restore();
}
`;
}

/**
 * NSIS wizard art (v2.99.40).
 *
 * Two bitmaps dress the installer beyond the icon: the page-header banner
 * (150 × 57, top-left of every wizard page) and the Welcome/Finish sidebar
 * (164 × 314). MUI2 defaults the UNinstaller's bitmaps to these same two, so
 * one pair covers install, reinstall/update and uninstall.
 *
 * They are emitted as 24-bit UNCOMPRESSED BMPs because that is all NSIS
 * accepts — no alpha, no PNG-in-BMP. sharp cannot write BMP, so the encoder
 * below is hand-rolled: BGR byte order, bottom-up rows, rows padded to 4
 * bytes. The SVG composes from the SAME arcs/letter/coin helpers as every
 * other variant, so the wizard cannot drift from the mark.
 *
 * Text renders with the build machine's sans font — acceptable here alone,
 * because these bitmaps are rasterised on the OWNER's machine at build time,
 * never on a user's (the rule against live text is about USER machines).
 */
function wizardSvg(kind) {
  const markGroup = (x, y, size) =>
    `<g transform="translate(${x} ${y}) scale(${size / GEO.S})">
${arcs(GEO.arcWidth)}
${letter()}
${coin(true)}
</g>`;
  if (kind === "header") {
    // Banner strip: tile-dark ground, compact mark, wordmark beside it.
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 57" width="150" height="57">
  <defs>
${defs()}
  </defs>
  <rect width="150" height="57" fill="#0a1120"/>
  <rect x="0" y="55" width="150" height="2" fill="#14b8a6" opacity="0.85"/>
  ${markGroup(8, 6, 45)}
  <text x="62" y="36" font-family="Segoe UI, Arial, sans-serif" font-size="17" font-weight="700" letter-spacing="3.5" fill="#e9eef5">VYUHA</text>
</svg>`;
  }
  // Sidebar: tall gradient panel — mark, wordmark, the three-word promise.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 164 314" width="164" height="314">
  <defs>
${defs()}
    <linearGradient id="wiz-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#101a2e"/><stop offset="100%" stop-color="#05070d"/></linearGradient>
  </defs>
  <rect width="164" height="314" fill="url(#wiz-bg)"/>
  ${markGroup(27, 40, 110)}
  <text x="82" y="196" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="24" font-weight="700" letter-spacing="5" fill="#e9eef5">VYUHA</text>
  <text x="82" y="216" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="7" letter-spacing="1.4" fill="#8a98a7">JOURNAL · MEASURE · MASTER</text>
  <rect x="52" y="232" width="60" height="2" rx="1" fill="#14b8a6" opacity="0.7"/>
  <text x="82" y="292" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="7" letter-spacing="1" fill="#5b6675">DESKTOP · WEB · YOURS</text>
</svg>`;
}

/** Encode raw RGB(A) pixels as a 24-bit uncompressed BMP (what NSIS requires). */
function bmp24(raw, width, height, channels) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const buf = Buffer.alloc(54 + pixelBytes);
  buf.write("BM", 0);
  buf.writeUInt32LE(54 + pixelBytes, 2);
  buf.writeUInt32LE(54, 10); // pixel data offset
  buf.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positive = bottom-up
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bpp
  buf.writeUInt32LE(0, 30); // BI_RGB, uncompressed
  buf.writeUInt32LE(pixelBytes, 34);
  buf.writeInt32LE(2835, 38); // 72 dpi
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * channels;
    let dst = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const src = srcRow + x * channels;
      buf[dst++] = raw[src + 2]; // B
      buf[dst++] = raw[src + 1]; // G
      buf[dst++] = raw[src]; // R
    }
  }
  return buf;
}

async function emitWizardBmp(kind, width, height, outPath) {
  // Flatten onto the banner ground: BMP has no alpha channel to keep.
  const { data, info } = await sharp(Buffer.from(wizardSvg(kind)))
    .resize(width, height)
    .flatten({ background: "#0a1120" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  fs.writeFileSync(outPath, bmp24(data, info.width, info.height, info.channels));
}

async function main() {
  const written = [];

  for (const variant of ["mark", "appicon", "favicon"]) {
    const p = path.join(outDir, `vyuha-${variant}.svg`);
    fs.writeFileSync(p, svgFor(variant));
    written.push(p);
  }

  // The icon source Tauri rasterises the whole set from.
  //
  // The APPICON variant, not the bare mark: `tauri icon` only resizes — it adds
  // no mask and no background — so the source must already be opaque and
  // already carry the squircle. A transparent source would leave the macOS dock
  // showing three floating arcs with no tile behind them.
  const iconSource = path.join(root, "src-tauri", "icon-source.png");
  await sharp(Buffer.from(svgFor("appicon"))).resize(1024, 1024).png().toFile(iconSource);
  written.push(iconSource);

  // NSIS wizard bitmaps (exact MUI2 sizes; 24-bit BMP is mandatory).
  const headerBmp = path.join(root, "src-tauri", "installer-header.bmp");
  const sidebarBmp = path.join(root, "src-tauri", "installer-sidebar.bmp");
  await emitWizardBmp("header", 150, 57, headerBmp);
  await emitWizardBmp("sidebar", 164, 314, sidebarBmp);
  written.push(headerBmp, sidebarBmp);

  // Web assets. The favicon variant for the small sizes, the app icon for the
  // large ones — the ₹ is legible at 512 and mud at 32.
  await sharp(Buffer.from(svgFor("appicon"))).resize(512, 512).png()
    .toFile(path.join(outDir, "vyuha-512.png"));
  await sharp(Buffer.from(svgFor("appicon"))).resize(180, 180).png()
    .toFile(path.join(outDir, "apple-touch-icon.png"));
  await sharp(Buffer.from(svgFor("favicon"))).resize(32, 32).png()
    .toFile(path.join(outDir, "favicon-32.png"));
  written.push(
    path.join(outDir, "vyuha-512.png"),
    path.join(outDir, "apple-touch-icon.png"),
    path.join(outDir, "favicon-32.png"),
  );

  // Masters for the accent skins retired in v3, and the standalone ₹ mark the
  // coin absorbed. Removed rather than left behind: a stale master is the file
  // someone reaches for when they need "the logo".
  for (const dead of ["vyuha-terminal.svg", "vyuha-tape.svg", "vyuha-ice.svg", "vyuha-rupee.svg"]) {
    const p = path.join(outDir, dead);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log("✗ removed", path.relative(root, p));
    }
  }

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
