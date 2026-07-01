"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { settings, capitalSnapshots, riskConfig, chargeConfig } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

const numOrNull = (v: unknown): number | null => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const intOrNull = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n == null ? null : Math.round(n);
};

export type EditorState = { ok: boolean; message: string };

/** Update editable risk_config fields from a JSON payload of rows. */
export async function updateRiskConfig(_prev: EditorState, formData: FormData): Promise<EditorState> {
  try {
    const payload = JSON.parse(String(formData.get("payload") ?? "[]")) as Record<string, unknown>[];
    let updated = 0;
    for (const row of payload) {
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
          updatedAt: sql`(datetime('now'))`,
        })
        .where(eq(riskConfig.id, id))
        .run();
      updated++;
    }
    // Refresh consumers, not /settings (avoids remounting the editor).
    revalidatePath("/");
    revalidatePath("/targets/equity");
    revalidatePath("/targets/active");
    revalidatePath("/reports/discipline");
    return { ok: true, message: `Saved ${updated} risk rule${updated === 1 ? "" : "s"}.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Update one charge_config rate row from a JSON payload. */
export async function updateChargeRate(_prev: EditorState, formData: FormData): Promise<EditorState> {
  try {
    const row = JSON.parse(String(formData.get("payload") ?? "{}")) as Record<string, unknown>;
    const id = Number(row.id);
    if (!Number.isFinite(id)) return { ok: false, message: "No row selected." };
    db.update(chargeConfig)
      .set({
        brokerageFlat: numOrNull(row.brokerageFlat),
        brokeragePct: numOrNull(row.brokeragePct) ?? 0,
        brokerageCap: numOrNull(row.brokerageCap),
        brokerageFloor: numOrNull(row.brokerageFloor) ?? 0,
        sttPct: numOrNull(row.sttPct) ?? 0,
        exchangeTxnPct: numOrNull(row.exchangeTxnPct) ?? 0,
        sebiPct: numOrNull(row.sebiPct) ?? 0,
        stampPct: numOrNull(row.stampPct) ?? 0,
        ipftPct: numOrNull(row.ipftPct) ?? 0,
        gstPct: numOrNull(row.gstPct) ?? 0.18,
        dpCharge: numOrNull(row.dpCharge) ?? 0,
        mtfInterestAnnual: numOrNull(row.mtfInterestAnnual) ?? 0,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(chargeConfig.id, id))
      .run();
    // Note: do NOT revalidate /settings — it would remount the editor and reset the
    // selected row. Rates affect newly imported / re-tagged trades only.
    return { ok: true, message: "Charge rate saved. Re-import or re-tag to recompute existing trades." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

const SettingsSchema = z.object({
  goLiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  equityCapital: z.coerce.number().min(0),
  activeCapital: z.coerce.number().min(0),
  theme: z.enum(["dark", "light"]),
  fyStartMonth: z.coerce.number().int().min(1).max(12),
  defaultBuyOrders: z.coerce.number().int().min(1).max(50),
  defaultSellOrders: z.coerce.number().int().min(1).max(50),
  colorblindSafe: z.coerce.boolean(),
});

export type SettingsActionState = {
  ok: boolean;
  message: string;
};

export async function updateSettings(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const parsed = SettingsSchema.safeParse({
    goLiveDate: formData.get("goLiveDate"),
    equityCapital: formData.get("equityCapital"),
    activeCapital: formData.get("activeCapital"),
    theme: formData.get("theme"),
    fyStartMonth: formData.get("fyStartMonth"),
    defaultBuyOrders: formData.get("defaultBuyOrders"),
    defaultSellOrders: formData.get("defaultSellOrders"),
    colorblindSafe: formData.get("colorblindSafe") === "on",
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const v = parsed.data;

  const existing = db.select().from(settings).limit(1).all()[0];
  const now = sql`(datetime('now'))`;

  if (existing) {
    db.update(settings)
      .set({
        goLiveDate: v.goLiveDate,
        equityCapital: v.equityCapital,
        activeCapital: v.activeCapital,
        theme: v.theme,
        fyStartMonth: v.fyStartMonth,
        defaultBuyOrders: v.defaultBuyOrders,
        defaultSellOrders: v.defaultSellOrders,
        colorblindSafe: v.colorblindSafe,
        updatedAt: now,
      })
      .where(eq(settings.id, existing.id))
      .run();
  } else {
    db.insert(settings)
      .values({
        goLiveDate: v.goLiveDate,
        equityCapital: v.equityCapital,
        activeCapital: v.activeCapital,
        theme: v.theme,
        fyStartMonth: v.fyStartMonth,
        defaultBuyOrders: v.defaultBuyOrders,
        defaultSellOrders: v.defaultSellOrders,
        colorblindSafe: v.colorblindSafe,
      })
      .run();
  }

  // Keep the opening capital snapshots in sync with edited bucket capitals.
  syncOpeningSnapshot("equity", v.goLiveDate, v.equityCapital);
  syncOpeningSnapshot("active", v.goLiveDate, v.activeCapital);

  // Refresh consumers (capital, colorblind, theme), not /settings itself — the form
  // holds its own state and the theme is applied live on the client. The root layout
  // is force-dynamic, so theme/colorblind re-read on the next navigation.
  revalidatePath("/");
  revalidatePath("/equity");
  revalidatePath("/active");
  revalidatePath("/targets/equity");
  revalidatePath("/targets/active");
  return { ok: true, message: "Settings saved." };
}

function syncOpeningSnapshot(
  bucket: "equity" | "active",
  asOfDate: string,
  opening: number,
) {
  const existing = db
    .select()
    .from(capitalSnapshots)
    .where(eq(capitalSnapshots.bucket, bucket))
    .orderBy(capitalSnapshots.asOfDate)
    .all()[0];

  if (existing) {
    // Only adjust the available figure by the change in opening capital,
    // preserving any deployed amount already recorded.
    const available = opening - existing.deployed;
    db.update(capitalSnapshots)
      .set({ asOfDate, openingCapital: opening, available })
      .where(eq(capitalSnapshots.id, existing.id))
      .run();
  } else {
    db.insert(capitalSnapshots)
      .values({
        bucket,
        asOfDate,
        openingCapital: opening,
        deployed: 0,
        available: opening,
        realisedPnlToDate: 0,
      })
      .run();
  }
}
