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
//
// Rate tables (charge/margin/risk) ARE part of the baseline: the user chose
// those numbers, and "back to my defaults" should mean the rates they trust.

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
    return JSON.stringify(a) !== JSON.stringify(b);
  });
}
