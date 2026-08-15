import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import fs from "node:fs";
import crypto from "node:crypto";
import { WALLPAPER_MAX_BYTES, wallpaperUrl } from "@/lib/domain/appearance";
import {
  getWallpaper,
  removeWallpaperFile,
  setWallpaperStoredName,
  wallpaperDir,
  wallpaperPathFor,
} from "@/lib/queries/wallpaper";

export const runtime = "nodejs";

// Appearance wallpaper — one image per install. Bytes under
// <data-dir>/wallpaper/, name in settings.wallpaper_stored_name (this route is
// the ONLY writer of that column; app/api/settings owns the opacity). Modelled
// on app/api/trades/attachments/route.ts, tightened: still images only (no GIF),
// magic bytes sniffed, and every stored name is generated here. Not part of the
// backup envelope — stated on the Backup screen.

const ALLOWED_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

/** Sniff the container; the declared type is only a hint. */
function sniffImage(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

const err = (message: string, status: number) => NextResponse.json({ error: message }, { status });

function revalidate() {
  // The wallpaper is painted by app/layout.tsx (root layout) — revalidate the
  // whole tree the same way the settings route refreshes its consumers.
  revalidatePath("/", "layout");
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const v = url.searchParams.get("v");
  let storedName: string | null;
  if (v != null && v !== "") {
    storedName = v;
  } else {
    storedName = getWallpaper()?.storedName ?? null;
    if (!storedName) return err("No wallpaper set", 404);
  }
  let filePath: string;
  try {
    filePath = wallpaperPathFor(storedName);
  } catch {
    return err("Bad wallpaper name", 400);
  }
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return err("Not found", 404);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    return err("Not found", 404);
  }
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes.length),
      // The name changes on every upload (wallpaperUrl carries it as ?v=), so
      // an immutable year-long cache is safe.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) return err("Bad form data", 400);
  const file = form.get("file");
  if (!(file instanceof File)) return err("A `file` field is required", 400);
  if (file.size > WALLPAPER_MAX_BYTES) return err(`Max ${Math.round(WALLPAPER_MAX_BYTES / (1024 * 1024))} MB`, 413);
  if (!ALLOWED_MIME[file.type]) return err("PNG, JPEG or WebP only", 415);

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) return err("Empty file", 400);
  if (bytes.length > WALLPAPER_MAX_BYTES) return err(`Max ${Math.round(WALLPAPER_MAX_BYTES / (1024 * 1024))} MB`, 413);
  const sniffed = sniffImage(bytes);
  if (!sniffed || sniffed !== file.type) return err("File content is not a PNG, JPEG or WebP image", 415);

  const ext = ALLOWED_MIME[sniffed];
  const storedName = `wp-${crypto.randomBytes(16).toString("hex")}${ext}`;
  wallpaperDir();
  fs.writeFileSync(wallpaperPathFor(storedName), bytes);

  const previous = getWallpaper()?.storedName ?? null;
  setWallpaperStoredName(storedName);
  if (previous && previous !== storedName) removeWallpaperFile(previous);

  revalidate();
  return NextResponse.json({ ok: true, storedName, url: wallpaperUrl(storedName) });
}

export async function DELETE() {
  const previous = getWallpaper()?.storedName ?? null;
  setWallpaperStoredName(null);
  removeWallpaperFile(previous);
  revalidate();
  return NextResponse.json({ ok: true });
}
