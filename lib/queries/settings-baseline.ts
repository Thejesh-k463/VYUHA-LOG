import "server-only";
import { eq } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import { settings, settingsBaseline, chargeConfig, marginConfig, riskConfig } from "@/lib/db/schema";
import {
  buildBaseline, isBaseline, diffAgainstBaseline, pickBaselineSettings,
  type SettingsBaseline, type BaselineSettingsField,
} from "@/lib/domain/settings-baseline";
import { recordAudit } from "@/lib/audit";
import { refreshChargeConfig, refreshMarginConfig, seedRiskConfig } from "@/lib/db/seed-core";
import { repriceCapTrades } from "@/lib/queries/risk-cap";

/**
 * Server half of "My Default Settings". The preference/state split lives in
 * lib/domain/settings-baseline.ts; this file reads, captures and restores.
 */

function captureNow(): SettingsBaseline | null {
  const row = db.select().from(settings).get();
  if (!row) return null;
  return buildBaseline(
    row as unknown as Record<string, unknown>,
    db.select().from(chargeConfig).all() as unknown as Record<string, unknown>[],
    db.select().from(marginConfig).all() as unknown as Record<string, unknown>[],
    db.select().from(riskConfig).all() as unknown as Record<string, unknown>[],
  );
}

/**
 * The user's baseline, capturing it lazily on the first read — every install
 * gains a baseline from whatever it is running with the first time this is
 * asked for, without being prompted.
 */
export function getBaseline(): SettingsBaseline | null {
  const existing = db.select().from(settingsBaseline).get();
  if (existing && isBaseline(existing.payload)) return existing.payload;

  const fresh = captureNow();
  if (!fresh) return null;
  // Guarded: a concurrent first-read keeps whichever landed first.
  if (!db.select().from(settingsBaseline).get()) {
    db.insert(settingsBaseline).values({ payload: fresh as unknown as Record<string, unknown> }).run();
    recordAudit({ entity: "settings", action: "create", summary: "default-settings baseline captured (first run)", source: "system" });
  }
  const row = db.select().from(settingsBaseline).get();
  return row && isBaseline(row.payload) ? row.payload : fresh;
}

/** Replace the baseline with the CURRENT configuration, explicitly. */
export function saveCurrentAsBaseline(): { ok: boolean; message: string } {
  const fresh = captureNow();
  if (!fresh) return { ok: false, message: "No settings to capture yet." };
  db.delete(settingsBaseline).run();
  db.insert(settingsBaseline).values({ payload: fresh as unknown as Record<string, unknown> }).run();
  recordAudit({ entity: "settings", action: "update", summary: "default-settings baseline replaced with current configuration", source: "ui" });
  return { ok: true, message: "Current configuration saved as your default." };
}

/** Fields that would change if restored right now — for the confirmation. */
export function baselineDiff(): { fields: BaselineSettingsField[]; capturedAt: string | null; rateRows: number } {
  const b = getBaseline();
  const row = db.select().from(settings).get();
  if (!b || !row) return { fields: [], capturedAt: null, rateRows: 0 };
  return {
    fields: diffAgainstBaseline(row as unknown as Record<string, unknown>, b),
    capturedAt: b.capturedAt,
    rateRows: b.chargeConfig.length + b.marginConfig.length + b.riskConfig.length,
  };
}

/**
 * Restore the baseline: preference fields onto the settings row, and the three
 * rate tables replaced wholesale with the snapshot — then the charge rows the
 * user never edited are brought onto this build's rate card (v4.3.0 R7). All in
 * one transaction — a partial restore would leave rates from one era and
 * preferences from another.
 *
 * State fields (licence, trial, clock ratchet, pnlRolledIn, selected account,
 * go-live) are untouched by construction: they are not in the payload at all.
 */
export function restoreBaseline(): { ok: boolean; message: string } {
  const b = getBaseline();
  const row = db.select().from(settings).get();
  if (!b || !row) return { ok: false, message: "No default settings have been captured yet." };

  try {
    db.transaction((tx) => {
      tx.update(settings)
        .set({ ...(pickBaselineSettings(b.settings) as object), updatedAt: new Date().toISOString() })
        .where(eq(settings.id, row.id))
        .run();

      tx.delete(chargeConfig).run();
      for (const r of b.chargeConfig) tx.insert(chargeConfig).values(r as never).run();
      // The snapshot's rate card is the one captured then, which may predate
      // this build's corrections (v4.3.0 R7). The rows the user never edited
      // follow this version's card, inside this transaction; user-edited rows
      // and their windows stay exactly as the snapshot holds them.
      refreshChargeConfig(tx);
      tx.delete(marginConfig).run();
      for (const r of b.marginConfig) tx.insert(marginConfig).values(r as never).run();
      // SM-1 (v4.6.0 fix wave): a snapshot saved on 4.5.0 holds no Fyers /
      // Nuvama rows, and the DELETE above just wiped the ones 0078 added. Re-add
      // every shipped row the snapshot lacks (INSERT OR IGNORE — the snapshot's
      // own rows are untouched), in this transaction.
      refreshMarginConfig(tx);
      tx.delete(riskConfig).run();
      for (const r of b.riskConfig) tx.insert(riskConfig).values(r as never).run();
      // D1 (v4.4.0): a snapshot captured before migration 0073 lacks the three
      // segment rows it added (eq_delivery, eq_mtf, future) — re-seed every
      // bucket/segment row the snapshot does not hold (INSERT OR IGNORE, so the
      // restored rows are untouched), then put every cap-derived R on the caps
      // just restored. Same transaction: a restore never leaves a 'cap' row
      // priced in a cap that is no longer configured.
      seedRiskConfig(tx);
      repriceCapTrades(sqlite);
    });
  } catch (e) {
    return { ok: false, message: `Nothing was restored — ${e instanceof Error ? e.message : "unknown error"}. Your settings are unchanged.` };
  }

  recordAudit({ entity: "settings", action: "update", summary: `restored default-settings baseline from ${b.capturedAt}`, source: "ui" });
  // Seam D2 (v4.3.0): the toast after the click states the SAME charge-row rule
  // the card states before it (CHARGE_ROWS_RULE in
  // components/settings/default-settings-card.tsx, a client file this
  // server-only module cannot import). Each snapshot row keeps the user_edited
  // flag it had WHEN THE DEFAULTS WERE SAVED, so a row edited only since comes
  // back unedited and follows the card — "never edited" and "all three rate
  // tables back" both promised otherwise. tests/settings-baseline.test.ts pins
  // this message against the card's constant.
  return {
    ok: true,
    message:
      "Your default settings are back — preferences and the margin and risk tables. Charge rows you had edited when these defaults were saved return to those values; rows unedited then follow this version's rate card.",
  };
}
