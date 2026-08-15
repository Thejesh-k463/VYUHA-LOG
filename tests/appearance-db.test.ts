import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { DEFAULT_CUSTOM_THEME, parseCustomTheme, serializeCustomTheme } from "@/lib/domain/appearance";

// Migration 0048 (appearance): the settings columns exist, their defaults
// reproduce the shipped look, and a stored custom theme round-trips through
// parseCustomTheme. One temp DB per FILE (see tests/helpers/temp-db.ts).

let t: TempDb;
beforeAll(async () => {
  t = await openTempDb("appearance", { seed: true });
});
afterAll(() => t?.cleanup());

describe("migration 0048_appearance", () => {
  it("adds the five columns with the documented defaults", () => {
    const cols = t.sqlite.prepare("PRAGMA table_info(settings)").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const by = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(by.tint_intensity).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "50" });
    expect(by.panel_style).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "'luxe'" });
    expect(by.custom_theme).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(by.wallpaper_stored_name).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(by.wallpaper_opacity).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "35" });
  });

  it("the seeded settings row carries the defaults — no existing install changes look on upgrade", () => {
    const row = t.db.select().from(t.schema.settings).get()!;
    expect(row.tintIntensity).toBe(50);
    expect(row.panelStyle).toBe("luxe");
    expect(row.customTheme).toBeNull();
    expect(row.wallpaperStoredName).toBeNull();
    expect(row.wallpaperOpacity).toBe(35);
  });

  it("a custom theme round-trips through the column and parseCustomTheme", () => {
    t.db
      .update(t.schema.settings)
      .set({ accentSkin: "custom", customTheme: serializeCustomTheme(DEFAULT_CUSTOM_THEME), tintIntensity: 80, panelStyle: "glow", wallpaperOpacity: 20 })
      .run();
    const row = t.db.select().from(t.schema.settings).get()!;
    expect(parseCustomTheme(row.customTheme)).toEqual(DEFAULT_CUSTOM_THEME);
    expect(row.tintIntensity).toBe(80);
    expect(row.panelStyle).toBe("glow");
    expect(row.wallpaperOpacity).toBe(20);
  });
});
