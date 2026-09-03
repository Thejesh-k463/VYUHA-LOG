import { todayIstIso } from "@/lib/domain/trading-day";
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { db, attachmentsDir } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { DEFAULT_WALLPAPER_OPACITY } from "@/lib/domain/appearance";

// Wallpaper storage: ONE image, bytes on disk under <data-dir>/wallpaper/, the
// file name in settings.wallpaper_stored_name. Settings is global (not
// account-scoped), so no getSelectedAccountId() here. The wallpaper directory
// is deliberately NOT part of the backup envelope — a wallpaper is decoration,
// not journal — and the Backup screen says so.

/** `<data-dir>/wallpaper`, sibling of attachments/. Created on demand. */
export function wallpaperDir(): string {
  const dir = path.join(path.dirname(attachmentsDir), "wallpaper");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Absolute path for a stored name, confined to wallpaperDir(). Rejects path
 * separators, `..`, and anything not matching the server-generated shape —
 * the name arrives from `?v=` on the GET route, so it is untrusted input.
 */
export function wallpaperPathFor(storedName: string): string {
  if (!SAFE_NAME.test(storedName) || storedName.includes("..")) throw new Error("bad wallpaper name");
  const dir = wallpaperDir();
  const p = path.resolve(dir, storedName);
  if (path.dirname(p) !== path.resolve(dir)) throw new Error("bad wallpaper name");
  return p;
}

export function getWallpaper(): { storedName: string; opacity: number } | null {
  const row = db
    .select({ storedName: settings.wallpaperStoredName, opacity: settings.wallpaperOpacity })
    .from(settings)
    .limit(1)
    .all()[0];
  if (!row?.storedName) return null;
  return { storedName: row.storedName, opacity: row.opacity ?? DEFAULT_WALLPAPER_OPACITY };
}

/** Write the stored name (or clear it). Creates a settings row if none exists yet. */
export function setWallpaperStoredName(storedName: string | null): void {
  const existing = db.select({ id: settings.id }).from(settings).limit(1).all()[0];
  const now = sql`(datetime('now'))`;
  if (existing) {
    db.update(settings).set({ wallpaperStoredName: storedName, updatedAt: now }).where(eq(settings.id, existing.id)).run();
  } else {
    db.insert(settings)
      .values({ goLiveDate: todayIstIso(), equityCapital: 0, activeCapital: 0, wallpaperStoredName: storedName })
      .run();
  }
}

/** Best-effort unlink; a missing file is not an error. Never touches a path outside the dir. */
export function removeWallpaperFile(storedName: string | null | undefined): void {
  if (!storedName) return;
  try {
    fs.unlinkSync(wallpaperPathFor(storedName));
  } catch {
    /* already gone, or a name that never pointed inside the dir */
  }
}
