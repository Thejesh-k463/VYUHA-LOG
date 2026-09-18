import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { PANEL_STYLES, parseCustomTheme, serializeCustomTheme } from "@/lib/domain/appearance";

export const runtime = "nodejs";

/**
 * APPEARANCE — its own save (v4.4.0 ruling).
 *
 * Appearance moved to the END of /settings, away from the settings form's
 * "Save settings" buttons, so it persists through this route: client fetch +
 * `router.refresh()`, never a server action (AGENTS.md — a server action's
 * automatic refresh remounts the page's other client cards and drops their
 * half-made edits). Zero schema change: the same columns /api/settings has
 * always written, and ONLY those — capital, workspace and every other setting
 * are untouched by a skin change.
 *
 * The field rules are /api/settings's own, verbatim: the legacy skin names are
 * still ACCEPTED (a restored backup replays them), and the four newer fields
 * are OPTIONAL — absent keeps the stored value; customTheme `null`/"" clears.
 */
const AppearanceSchema = z.object({
  theme: z.enum(["dark", "light"]),
  accentSkin: z.enum(["luxe", "mono", "tape", "sapphire", "aurora", "lime", "rose", "ember", "custom", "ice", "royal", "terminal"]),
  density: z.enum(["compact", "comfortable"]),
  tintIntensity: z.coerce.number().int().min(0).max(100).optional(),
  panelStyle: z.enum(PANEL_STYLES).optional(),
  customTheme: z
    .unknown()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      const t = parseCustomTheme(v);
      if (!t) {
        ctx.addIssue({ code: "custom", message: "Custom theme needs a #rrggbb for every colour in both themes." });
        return z.NEVER;
      }
      return serializeCustomTheme(t);
    }),
  wallpaperOpacity: z.coerce.number().int().min(0).max(100).optional(),
  // wallpaperStoredName is deliberately NOT accepted — the wallpaper upload
  // route owns that column.
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }
  const parsed = AppearanceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const v = parsed.data;
  const existing = db.select().from(settings).limit(1).all()[0];
  if (!existing) {
    // The settings page renders no Appearance card on an unseeded database, so
    // this is a stale tab or a hand-made request — refuse rather than insert a
    // settings row whose every other column is a default nobody chose.
    return NextResponse.json({ ok: false, message: "Settings are not set up yet — run setup first." }, { status: 409 });
  }

  const values = {
    theme: v.theme,
    accentSkin: v.accentSkin,
    density: v.density,
    ...(v.tintIntensity !== undefined && { tintIntensity: v.tintIntensity }),
    ...(v.panelStyle !== undefined && { panelStyle: v.panelStyle }),
    ...(v.customTheme !== undefined && { customTheme: v.customTheme }),
    ...(v.wallpaperOpacity !== undefined && { wallpaperOpacity: v.wallpaperOpacity }),
  };
  db.update(settings)
    .set({ ...values, updatedAt: sql`(datetime('now'))` })
    .where(eq(settings.id, existing.id))
    .run();

  recordAudit({
    entity: "settings",
    action: "update",
    summary: `appearance → ${v.accentSkin} / ${v.theme} / ${v.density}`,
    before: { theme: existing.theme, accentSkin: existing.accentSkin, density: existing.density },
    after: { theme: v.theme, accentSkin: v.accentSkin, density: v.density },
  });
  // The appearance vars and classes are server-rendered on <html> by the ROOT
  // layout, so every route must re-render with the stored look.
  revalidatePath("/", "layout");
  return NextResponse.json({ ok: true, message: "Appearance saved." });
}
