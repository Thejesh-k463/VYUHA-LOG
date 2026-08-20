import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { accounts, chargeConfig, riskConfig, settings, capitalSnapshots } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { getWriteAccountId, getSelectedAccountId } from "@/lib/queries/accounts";
import { WORKSPACES } from "@/lib/domain/workspace";
import { PANEL_STYLES, parseCustomTheme, serializeCustomTheme } from "@/lib/domain/appearance";

export const runtime = "nodejs";

const numOrNull = (v: unknown): number | null => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const intOrNull = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n == null ? null : Math.round(n);
};

function syncOpeningSnapshot(bucket: "equity" | "active", asOfDate: string, opening: number) {
  const accountId = getWriteAccountId();
  const existing = db
    .select()
    .from(capitalSnapshots)
    .where(and(eq(capitalSnapshots.accountId, accountId), eq(capitalSnapshots.bucket, bucket)))
    .orderBy(capitalSnapshots.asOfDate)
    .all()[0];
  if (existing) {
    db.update(capitalSnapshots)
      .set({ asOfDate, openingCapital: opening, available: opening - existing.deployed })
      .where(eq(capitalSnapshots.id, existing.id))
      .run();
  } else {
    db.insert(capitalSnapshots)
      .values({ accountId, bucket, asOfDate, openingCapital: opening, deployed: 0, available: opening, realisedPnlToDate: 0 })
      .run();
  }
}

const SettingsSchema = z.object({
  goLiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  equityCapital: z.coerce.number().min(0),
  activeCapital: z.coerce.number().min(0),
  theme: z.enum(["dark", "light"]),
  // The Tape/Ice accent skins were retired in v3 (see app/globals.css). The
  // enum still ACCEPTS them on purpose: settings rows written before v3 hold
  // "tape"/"ice", and a restored backup replays them through this route — a
  // narrowed enum would turn those into a 400 on an otherwise valid save.
  // Nothing renders them any more, and the default quietly normalises the row
  // to "terminal" now that the form no longer sends the field.
  // v4 restored skins as coordinated triples. "terminal" is still ACCEPTED
  // — it is the pre-v4 column default on every install and arrives in any
  // restored backup — and asSkin() maps it to Luxe, which is what it has
  // rendered as since v3. The new flat skin is "mono" precisely so that
  // old string never has to change meaning.
  // "ice" and "royal" were retired in v2.99.96 (near-duplicates of Sapphire /
  // Luxe+Aurora) but stay ACCEPTED for the same restored-backup reason;
  // asSkin() maps both to Sapphire. Lime / Rose / Ember replaced them.
  // "custom" (v2.99.97) renders the user's own hexes from `customTheme`.
  accentSkin: z
    .enum(["luxe", "mono", "tape", "sapphire", "aurora", "lime", "rose", "ember", "custom", "ice", "royal", "terminal"])
    .default("terminal"),
  density: z.enum(["compact", "comfortable"]).default("compact"),
  // ── Appearance (lib/domain/appearance.ts) ──
  // Each is OPTIONAL: a body that omits a field keeps the stored value (a form
  // that only knows the older fields must not reset someone's tint or wipe
  // their custom theme). A fresh row takes the column defaults (50 / luxe /
  // NULL / 35).
  tintIntensity: z.coerce.number().int().min(0).max(100).optional(),
  panelStyle: z.enum(PANEL_STYLES).optional(),
  // Stored as JSON text; the object or its string are both accepted, and each
  // of the 14 hexes must be a strict #rrggbb — anything else is a 400, never a
  // half-parsed theme in the column. Explicit null / "" clears it; absent keeps.
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
  // wallpaperStoredName is deliberately NOT accepted here — the wallpaper
  // upload route owns that column.
  workspace: z.enum(WORKSPACES).default("both"),
  fyStartMonth: z.coerce.number().int().min(1).max(12),
  defaultBuyOrders: z.coerce.number().int().min(1).max(50),
  defaultSellOrders: z.coerce.number().int().min(1).max(50),
  colorblindSafe: z.coerce.boolean(),
  autoMtmEnabled: z.coerce.boolean(),
  // ── OpenAlgo integration (v2.99.99) ──
  // Both are OPTIONAL, like the appearance fields above: a body that omits them
  // keeps the stored value. Every settings form that predates this feature
  // sends neither, and an absent field must not silently revoke a consent the
  // user gave (nor grant one they did not).
  //
  // z.boolean(), NOT z.coerce.boolean(), deliberately: coercion is truthiness,
  // so the STRING "false" would arrive as `true` — and this is the one boolean
  // where that re-opens a gate the user closed. The consent dialog sends a real
  // JSON boolean, so nothing legitimate is rejected by the stricter type.
  openalgoEnabled: z.boolean().optional(),
  // Which disclosure version was accepted. Explicit null clears the acceptance
  // (which closes the gate — see openAlgoGate); absent keeps what is stored.
  openalgoAckVersion: z.string().nullable().optional(),
});

/**
 * Settings editors save via fetch() (not server actions) so the Settings route is
 * NOT auto-refreshed — keeping each editor's in-progress selection/edits intact.
 * Consumer routes are revalidated here so dashboards reflect the change on navigation.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }
  const now = sql`(datetime('now'))`;

  if (body.type === "charge") {
    const id = Number(body.id);
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, message: "No row selected" }, { status: 400 });
    db.update(chargeConfig)
      .set({
        brokerageFlat: numOrNull(body.brokerageFlat),
        brokeragePct: numOrNull(body.brokeragePct) ?? 0,
        brokerageCap: numOrNull(body.brokerageCap),
        brokerageFloor: numOrNull(body.brokerageFloor) ?? 0,
        sttPct: numOrNull(body.sttPct) ?? 0,
        exchangeTxnPct: numOrNull(body.exchangeTxnPct) ?? 0,
        sebiPct: numOrNull(body.sebiPct) ?? 0,
        stampPct: numOrNull(body.stampPct) ?? 0,
        ipftPct: numOrNull(body.ipftPct) ?? 0,
        gstPct: numOrNull(body.gstPct) ?? 0.18,
        dpCharge: numOrNull(body.dpCharge) ?? 0,
        mtfInterestAnnual: numOrNull(body.mtfInterestAnnual) ?? 0,
        // Pins the row against the seed refresh — see chargeConfig.userEdited.
        userEdited: true,
        updatedAt: now,
      })
      .where(eq(chargeConfig.id, id))
      .run();
    recordAudit({ entity: "charge_config", entityId: id, action: "update", summary: `charge rate #${id} edited`, after: { sttPct: numOrNull(body.sttPct), brokeragePct: numOrNull(body.brokeragePct), gstPct: numOrNull(body.gstPct) } });
    return NextResponse.json({ ok: true, message: "Charge rate saved." });
  }

  if (body.type === "risk") {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    let updated = 0;
    for (const row of rows) {
      const id = Number(row.id);
      if (!Number.isFinite(id)) continue;
      db.update(riskConfig)
        .set({
          perTradeMaxLoss: numOrNull(row.perTradeMaxLoss),
          maxOpen: intOrNull(row.maxOpen),
          maxTradesDay: intOrNull(row.maxTradesDay),
          dailyLossStop: numOrNull(row.dailyLossStop),
          concentrationPct: numOrNull(row.concentrationPct),
          monthlyTargetBase: numOrNull(row.monthlyTargetBase),
          monthlyTargetStretch: numOrNull(row.monthlyTargetStretch),
          updatedAt: now,
        })
        .where(eq(riskConfig.id, id))
        .run();
      updated++;
    }
    for (const p of ["/", "/targets/equity", "/targets/active", "/reports/discipline", "/risk"]) revalidatePath(p);
    recordAudit({ entity: "risk_config", action: "update", summary: `${updated} risk rule${updated === 1 ? "" : "s"} edited` });
    return NextResponse.json({ ok: true, message: `Saved ${updated} risk rule${updated === 1 ? "" : "s"}.` });
  }

  if (body.type === "settings") {
    const parsed = SettingsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    }
    const v = parsed.data;
    const existing = db.select().from(settings).limit(1).all()[0];

    // Capital is read account-first (lib/queries/capital.ts:35), so it must be
    // WRITTEN account-first too: with an account selected, saving here used to
    // update the global settings row that nothing was reading — "Settings
    // saved." while the number on screen never moved. The remaining fields
    // stay global; only capital is per-account.
    const selectedForCapital = getSelectedAccountId();
    if (selectedForCapital > 0) {
      db.update(accounts)
        .set({ equityCapital: v.equityCapital, activeCapital: v.activeCapital, updatedAt: now })
        .where(eq(accounts.id, selectedForCapital))
        .run();
    }

    const values = {
      goLiveDate: v.goLiveDate,
      equityCapital: v.equityCapital,
      activeCapital: v.activeCapital,
      theme: v.theme,
      accentSkin: v.accentSkin,
      density: v.density,
      ...(v.tintIntensity !== undefined && { tintIntensity: v.tintIntensity }),
      ...(v.panelStyle !== undefined && { panelStyle: v.panelStyle }),
      ...(v.customTheme !== undefined && { customTheme: v.customTheme }),
      ...(v.wallpaperOpacity !== undefined && { wallpaperOpacity: v.wallpaperOpacity }),
      workspace: v.workspace,
      fyStartMonth: v.fyStartMonth,
      defaultBuyOrders: v.defaultBuyOrders,
      defaultSellOrders: v.defaultSellOrders,
      colorblindSafe: v.colorblindSafe,
      autoMtmEnabled: v.autoMtmEnabled,
      ...(v.openalgoEnabled !== undefined && { openalgoEnabled: v.openalgoEnabled }),
      ...(v.openalgoAckVersion !== undefined && { openalgoAckVersion: v.openalgoAckVersion }),
    };

    // OpenAlgo consent is a DATED RECORD, not just a dialog. The dialog is what
    // the user sees; this is what survives — so the Audit Log gets its own
    // entry whenever the stored value actually changes, carrying the
    // before/after of these two fields ONLY (never the whole settings row).
    const openalgoBefore = {
      openalgoEnabled: existing?.openalgoEnabled ?? false,
      openalgoAckVersion: existing?.openalgoAckVersion ?? null,
    };
    const openalgoAfter = {
      openalgoEnabled: v.openalgoEnabled ?? openalgoBefore.openalgoEnabled,
      openalgoAckVersion: v.openalgoAckVersion !== undefined ? v.openalgoAckVersion : openalgoBefore.openalgoAckVersion,
    };
    const openalgoChanged =
      openalgoBefore.openalgoEnabled !== openalgoAfter.openalgoEnabled ||
      openalgoBefore.openalgoAckVersion !== openalgoAfter.openalgoAckVersion;

    if (existing) {
      db.update(settings).set({ ...values, updatedAt: now }).where(eq(settings.id, existing.id)).run();
    } else {
      db.insert(settings).values(values).run();
    }
    syncOpeningSnapshot("equity", v.goLiveDate, v.equityCapital);
    syncOpeningSnapshot("active", v.goLiveDate, v.activeCapital);
    const capitalChanged = !existing || existing.equityCapital !== v.equityCapital || existing.activeCapital !== v.activeCapital;
    recordAudit({
      entity: capitalChanged ? "capital" : "settings",
      action: "update",
      summary: capitalChanged ? `capital → equity ${v.equityCapital} / active ${v.activeCapital}` : "settings updated",
      before: existing ? { equityCapital: existing.equityCapital, activeCapital: existing.activeCapital, goLiveDate: existing.goLiveDate, theme: existing.theme } : null,
      after: { equityCapital: v.equityCapital, activeCapital: v.activeCapital, goLiveDate: v.goLiveDate, theme: v.theme },
    });
    if (openalgoChanged) {
      recordAudit({
        entity: "settings",
        action: "update",
        summary: openalgoAfter.openalgoEnabled
          ? openalgoAfter.openalgoAckVersion
            ? `OpenAlgo integration enabled (disclosure v${openalgoAfter.openalgoAckVersion} accepted)`
            : // Never fabricate the version that was accepted — say plainly
              // that none was recorded. The gate stays closed in this state.
              "OpenAlgo integration enabled, but no disclosure acceptance was recorded"
          : "OpenAlgo integration disabled",
        before: openalgoBefore,
        after: openalgoAfter,
      });
    }
    for (const p of ["/", "/equity", "/active", "/targets/equity", "/targets/active", "/risk", "/trades"]) revalidatePath(p);
    return NextResponse.json({ ok: true, message: "Settings saved." });
  }

  return NextResponse.json({ ok: false, message: "Unknown type" }, { status: 400 });
}
