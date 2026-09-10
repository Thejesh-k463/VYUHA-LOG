// DEFAULT SETTINGS BASELINE (PURE, no DB/React).
//
// "My Default Settings": the first configuration a user runs with is kept as
// their baseline; they may change anything freely afterwards, and one click
// returns the whole configuration to that baseline. Explicitly saving a new
// baseline replaces it.
//
// ── What is a preference, and what is deliberately NOT ─────────────────────
//
// A baseline restore must return CHOICES, never rewrite FACTS or STATE. The
// split below is the heart of this module and each exclusion has a reason:
//
//   pnlRolledIn        — accounting state; restoring it double-counts capital
//   licenseKey         — an entitlement, not a preference
//   trialStartedAt     — restoring it would reset the trial (security state)
//   clockHighWaterMark — the tamper ratchet; restoring it would lower it
//   lastAutoMtmDate    — job bookkeeping; restoring re-runs a day's MTM
//   selectedAccountId  — where the user IS, not how they like things
//   goLiveDate         — a historical fact about the account, not a choice
//   openalgoEnabled    — an integration the user switched on after reading a
//   openalgoAckVersion   risk disclosure; "back to my defaults" must not
//                        silently re-enable it or re-assert a consent
//   telegram* / autoPull* / lastAutoPullDate (v3.6, migration 0053) — the same
//                        consent rule, plus credentials (bot token / chat id)
//                        and once-per-day job stamps; all machine state, see
//                        SETTINGS_MACHINE_COLUMNS in lib/backup-format.ts
//   onboardingCompletedAt (v3.7, migration 0057) — whether this INSTALL has
//                        been through its first run. "Back to my defaults"
//                        returns choices; it must not re-run a setup wizard the
//                        user already finished, nor mark one finished that they
//                        never saw. Machine state, in SETTINGS_MACHINE_COLUMNS
//                        for the restore half of the same rule.
//
// Rate tables (charge/margin/risk) ARE part of the baseline: the user chose
// those numbers, and "back to my defaults" should mean the rates they trust.

import { shelfJsonEquivalent } from "./strategy-shelf";

export const BASELINE_SETTINGS_FIELDS = [
  "equityCapital",
  "activeCapital",
  "theme",
  "accentSkin",
  "density",
  "workspace",
  "baseCurrency",
  "fyStartMonth",
  "colorblindSafe",
  "defaultBuyOrders",
  "defaultSellOrders",
  "autoMtmEnabled",
  // Option strategy shelf (v4.3, migration 0071) — which structures out of the
  // catalogue this person keeps in front of them, as a versioned envelope. A
  // CHOICE about the workspace, like theme and density: "back to my defaults"
  // should hand back the shelf they saved. Null in the baseline means the
  // DEFAULT_SHELF eight, which is also what the column means, so an install
  // whose baseline predates this field is untouched (diffAgainstBaseline skips
  // a field the baseline never recorded).
  "strategyShelfJson",
] as const;

export type BaselineSettingsField = (typeof BASELINE_SETTINGS_FIELDS)[number];

export interface SettingsBaseline {
  version: 1;
  capturedAt: string;
  settings: Record<BaselineSettingsField, unknown>;
  /** Full rows of the three rate tables, minus their auto-increment ids. */
  chargeConfig: Record<string, unknown>[];
  marginConfig: Record<string, unknown>[];
  riskConfig: Record<string, unknown>[];
}

/** Pick only baseline fields from a settings row — never state or facts. */
export function pickBaselineSettings(row: Record<string, unknown>): Record<BaselineSettingsField, unknown> {
  const out = {} as Record<BaselineSettingsField, unknown>;
  for (const f of BASELINE_SETTINGS_FIELDS) out[f] = row[f];
  return out;
}

/** Strip DB identity from a rate row so restore can re-insert cleanly. */
export function stripRowIdentity(row: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = row;
  return rest;
}

export function buildBaseline(
  settingsRow: Record<string, unknown>,
  chargeRows: Record<string, unknown>[],
  marginRows: Record<string, unknown>[],
  riskRows: Record<string, unknown>[],
  now: Date = new Date(),
): SettingsBaseline {
  return {
    version: 1,
    capturedAt: now.toISOString(),
    settings: pickBaselineSettings(settingsRow),
    chargeConfig: chargeRows.map(stripRowIdentity),
    marginConfig: marginRows.map(stripRowIdentity),
    riskConfig: riskRows.map(stripRowIdentity),
  };
}

export function isBaseline(v: unknown): v is SettingsBaseline {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.version === 1 && typeof o.capturedAt === "string" && !!o.settings &&
    Array.isArray(o.chargeConfig) && Array.isArray(o.marginConfig) && Array.isArray(o.riskConfig);
}

/**
 * What a restore would change, for the confirmation line. Compares only the
 * baseline fields — state fields cannot differ because they are never stored.
 */
/** A settings column read back as `unknown`: a string, or "no value stored". */
const asShelfJson = (v: unknown): string | null => (typeof v === "string" ? v : v == null ? null : JSON.stringify(v));

export function diffAgainstBaseline(
  current: Record<string, unknown>,
  baseline: SettingsBaseline,
): BaselineSettingsField[] {
  return BASELINE_SETTINGS_FIELDS.filter((f) => {
    const a = current[f];
    const b = baseline.settings[f];
    // A field the baseline predates (e.g. density, added v2.99.5) was never a
    // choice the user recorded — it cannot "differ", and restore skips it too
    // (drizzle drops undefined from .set()). Without this, every upgraded
    // install shows a permanent phantom "differs from default".
    if (!(f in baseline.settings)) return false;
    // One field has two encodings of the same value: `strategy_shelf_json` is
    // null on an untouched install and the explicit eight after a shelf
    // "Restore defaults". By string they differ; to the user they do not, and
    // this line is what the user is shown as "would change". Every other field
    // is compared by value, as before.
    if (f === "strategyShelfJson") return !shelfJsonEquivalent(asShelfJson(a), asShelfJson(b));
    return JSON.stringify(a) !== JSON.stringify(b);
  });
}
