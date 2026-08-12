import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { accounts, chargeConfig, riskConfig, settings, capitalSnapshots } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { getWriteAccountId, getSelectedAccountId } from "@/lib/queries/accounts";
import { WORKSPACES } from "@/lib/domain/workspace";

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
  accentSkin: z.enum(["luxe", "mono", "ice", "tape", "royal", "sapphire", "aurora", "terminal"]).default("terminal"),
  density: z.enum(["compact", "comfortable"]).default("compact"),
  workspace: z.enum(WORKSPACES).default("both"),
  fyStartMonth: z.coerce.number().int().min(1).max(12),
  defaultBuyOrders: z.coerce.number().int().min(1).max(50),
  defaultSellOrders: z.coerce.number().int().min(1).max(50),
  colorblindSafe: z.coerce.boolean(),
  autoMtmEnabled: z.coerce.boolean(),
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
      workspace: v.workspace,
      fyStartMonth: v.fyStartMonth,
      defaultBuyOrders: v.defaultBuyOrders,
      defaultSellOrders: v.defaultSellOrders,
      colorblindSafe: v.colorblindSafe,
      autoMtmEnabled: v.autoMtmEnabled,
    };
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
    for (const p of ["/", "/equity", "/active", "/targets/equity", "/targets/active", "/risk", "/trades"]) revalidatePath(p);
    return NextResponse.json({ ok: true, message: "Settings saved." });
  }

  return NextResponse.json({ ok: false, message: "Unknown type" }, { status: 400 });
}
