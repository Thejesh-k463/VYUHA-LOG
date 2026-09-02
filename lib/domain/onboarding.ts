// PURE (invariant 2): the first-run wizard's step machine, its stored-progress
// envelope, and every user-visible string it renders. No DB, no React — so the
// step logic and the copy are both exhaustively unit-testable in the node
// environment vitest runs (`tests/onboarding-wizard.test.ts`,
// `tests/onboarding-copy-guard.test.ts`).
//
// Copy lives HERE rather than inline in the JSX for the reason
// components/import/broker-connect.ts holds its consent strings as exported
// consts: a guard can pin a string it can import, and copy that is only a text
// node in a .tsx can be reworded without any test noticing.

/** localStorage key for wizard progress (kebab-case, `vyuha-` prefixed). */
export const ONBOARDING_STEP_KEY = "vyuha-onboarding-step";

/** Envelope version. A stored envelope with any other `v` is DISCARDED. */
export const ONBOARDING_STEP_VERSION = 1;

export const FIRST_STEP = 1;
export const LAST_STEP = 4;

export type OnboardingStep = 1 | 2 | 3 | 4;

export interface StoredStepEnvelope {
  v: number;
  step: number;
}

function isStep(n: unknown): n is OnboardingStep {
  return typeof n === "number" && Number.isInteger(n) && n >= FIRST_STEP && n <= LAST_STEP;
}

/**
 * Read stored progress.
 *
 * Anything unreadable — absent, not JSON, not an object, an array, a version
 * this build does not know, or a step outside 1..4 — resumes at step 1 rather
 * than throwing or rendering a step that does not exist. The FUTURE-version
 * case is the one that matters: a newer build that adds a fifth step writes
 * `{v:2,…}`, and an older build downgraded onto the same profile must not read
 * `step: 5` out of it and render nothing (AGENTS.md, versioned envelopes).
 */
export function parseStoredStep(raw: string | null | undefined): OnboardingStep {
  if (!raw) return FIRST_STEP;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return FIRST_STEP;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return FIRST_STEP;
  const env = parsed as Partial<StoredStepEnvelope>;
  if (env.v !== ONBOARDING_STEP_VERSION) return FIRST_STEP;
  return isStep(env.step) ? env.step : FIRST_STEP;
}

/** The envelope to store for `step`. Out-of-range input is clamped, never stored raw. */
export function serializeStep(step: number): string {
  return JSON.stringify({ v: ONBOARDING_STEP_VERSION, step: clampStep(step) } satisfies StoredStepEnvelope);
}

export function clampStep(step: number): OnboardingStep {
  if (!Number.isFinite(step)) return FIRST_STEP;
  const n = Math.round(step);
  return (n < FIRST_STEP ? FIRST_STEP : n > LAST_STEP ? LAST_STEP : n) as OnboardingStep;
}

export function nextStep(step: number): OnboardingStep {
  return clampStep(clampStep(step) + 1);
}

export function prevStep(step: number): OnboardingStep {
  return clampStep(clampStep(step) - 1);
}

/** True once the wizard is on its last step — the only place "Finish" appears. */
export function isLastStep(step: number): boolean {
  return clampStep(step) === LAST_STEP;
}

/**
 * Does step 1 have anything to write?
 *
 * The account upsert is skipped when nothing changed, which is what keeps
 * "Run setup again" (and the e2e walk-through) from rewriting an account that
 * already carries capital — and from stamping a fresh `updated_at` plus an
 * audit row for a form the user only clicked through.
 */
export function accountStepIsDirty(
  before: { name: string; equityCapital: number | null; activeCapital: number | null },
  after: { name: string; equityCapital: number | null; activeCapital: number | null },
): boolean {
  return (
    before.name.trim() !== after.name.trim() ||
    before.equityCapital !== after.equityCapital ||
    before.activeCapital !== after.activeCapital
  );
}

/**
 * What one capital box actually says.
 *
 * THREE answers, not two — and collapsing the last two is what made this a
 * defect. Capital is OPTIONAL (owner decision Q4), so an empty box is a real
 * statement: it stays NULL and the reports that divide by capital go on
 * showing "—" (invariant 6). But "₹500000", "5 lakh" and "-5" are not that
 * statement. They are entries this build cannot read, and reading them as
 * "cleared" wrote a NULL over a configured capital base with no message
 * anywhere — the exact thing app/layout.tsx promises a wizard never does.
 *
 * So an unreadable entry is its own kind, and the caller says so out loud
 * rather than saving it. Same refusal as lib/import/generic-map.ts, which
 * declines a cell it cannot read rather than coercing it to 0.
 */
export type CapitalEntry =
  | { kind: "blank"; value: null }
  | { kind: "amount"; value: number }
  | { kind: "unreadable"; value: null; raw: string };

export function readCapitalEntry(raw: string): CapitalEntry {
  const t = raw.trim();
  if (t === "") return { kind: "blank", value: null };
  const n = Number(t.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return { kind: "unreadable", value: null, raw: t };
  return { kind: "amount", value: n };
}

/**
 * The amount, or NULL for anything that is not one.
 *
 * Kept for callers that genuinely do not care WHY there is no number. Nothing
 * that writes to an account may use it: it cannot tell a box the user emptied
 * from one holding a currency symbol, and those two want opposite handling.
 */
export function parseOptionalCapital(raw: string): number | null {
  return readCapitalEntry(raw).value;
}

/**
 * ── Step 1's boxes belong to the account the SERVER last sent ───────────────
 *
 * They used to be `useState(prop)`, seeded ONCE at mount. The wizard is mounted
 * in the root layout, which survives client navigation, and the dismissal fix
 * made it re-openable through Settings' "Run setup again" — so on that second
 * run the boxes still held what the FIRST render was handed. On a configured
 * install that first render is the steady state (`show:false`, every field
 * null), so the capital boxes came back EMPTY over an account holding real
 * capital. Continue then read empty as "cleared on purpose" — a legitimate
 * signal, because capital is optional — and wrote NULL over the capital base,
 * reporting success. app/layout.tsx promises the opposite in as many words:
 * a wizard must never overwrite a real capital base with a NULL.
 *
 * The distinction that was collapsed, and the whole of the defect: "the user
 * cleared this box" and "this box was never populated" are not the same signal.
 *
 * Fixed the way components/review/note-draft.ts fixed the same staleness in the
 * weekly note (typing that survived an account switch and was filed against the
 * wrong book): the typing carries its OWNER — the exact server snapshot it was
 * typed against — and the caller derives what to show at render time. Typing
 * that does not belong to the snapshot on screen is not this form, so the boxes
 * fall back to the server's own values. There is no second copy of the server
 * state to fall behind, and no re-seed to run: a `useEffect` that re-seeds on a
 * prop change is the shape AGENTS.md bans outright.
 */

/** The account as the server last described it — the whole of step 1's input. */
export interface AccountSnapshot {
  accountId: number | null;
  name: string;
  equityCapital: number | null;
  activeCapital: number | null;
}

/** The three boxes, as text. Strings, because "" is a statement and 0 is not it. */
export interface AccountFormFields {
  name: string;
  equity: string;
  active: string;
}

/** Typing, plus the snapshot it was typed against. */
export interface AccountDraft extends AccountFormFields {
  owner: string;
}

/**
 * The identity step 1's boxes belong to.
 *
 * The WHOLE snapshot, not just the account id. A capital figure changed in
 * Settings mid-session is the same hazard as a different account: the typing
 * from before it changed is no longer typing about what is on screen. Keying on
 * the id alone would leave that variant of the defect alive.
 */
export function accountFormOwner(a: AccountSnapshot): string {
  return JSON.stringify([a.accountId, a.name, a.equityCapital, a.activeCapital]);
}

/** A capital figure as its box shows it. NULL is an empty box, never a "0". */
export function capitalText(n: number | null): string {
  return n == null ? "" : String(n);
}

/** What the boxes read when nobody has typed into them: the server's own values. */
export function seededAccountFields(a: AccountSnapshot): AccountFormFields {
  return { name: a.name, equity: capitalText(a.equityCapital), active: capitalText(a.activeCapital) };
}

/**
 * What the boxes show.
 *
 * The draft wins ONLY for its own owner; anything else falls back to the
 * snapshot actually on screen. Same rule as noteDraftText.
 */
export function accountFormFields(draft: AccountDraft | null, owner: string, a: AccountSnapshot): AccountFormFields {
  return draft && draft.owner === owner ? { name: draft.name, equity: draft.equity, active: draft.active } : seededAccountFields(a);
}

/** Which box a refusal is about, so the message can name it. */
export type AccountStepBox = "name" | "equity" | "active";

export type AccountStepPlan =
  /** Nothing to write: no account to write to, or nothing changed. */
  | { kind: "skip" }
  /** Say which box, save nothing, and do NOT advance. */
  | { kind: "refuse"; box: AccountStepBox }
  /** Exactly what to send. A null here is a box the user emptied themselves. */
  | { kind: "write"; name: string; equityCapital: number | null; activeCapital: number | null };

/**
 * What pressing Continue on step 1 should do.
 *
 * Every branch of the step lives here so it can be exercised without a DOM.
 * Three of them exist because of a defect:
 *
 *  • UNREADABLE capital ("₹500000", "5 lakh", "-5") is refused rather than sent
 *    as a NULL. It is not an emptied box, and treating it as one blanked a
 *    configured capital base with nothing on screen to say so.
 *  • An EMPTY NAME is refused rather than reported as a saved step. It used to
 *    return true, so Continue advanced with nothing sent at all — and that same
 *    exit hid the staleness above, because a stale-empty name took it too. The
 *    server refuses an empty name (`z.string().trim().min(1)`); this is the same
 *    answer, given before the round trip and with the box named.
 *  • A BLANK capital box is still a write of NULL. Capital is OPTIONAL (owner
 *    decision Q4) and invariant 6's "—" paths stay live; the fix refuses what it
 *    cannot read, never what the user deliberately left empty.
 */
export function planAccountStep(server: AccountSnapshot, fields: AccountFormFields): AccountStepPlan {
  const eq = readCapitalEntry(fields.equity);
  const ac = readCapitalEntry(fields.active);
  if (eq.kind === "unreadable") return { kind: "refuse", box: "equity" };
  if (ac.kind === "unreadable") return { kind: "refuse", box: "active" };
  if (server.accountId == null) return { kind: "skip" };
  const name = fields.name.trim();
  if (name === "") return { kind: "refuse", box: "name" };
  const after = { name, equityCapital: eq.value, activeCapital: ac.value };
  const before = { name: server.name, equityCapital: server.equityCapital, activeCapital: server.activeCapital };
  return accountStepIsDirty(before, after) ? { kind: "write", ...after } : { kind: "skip" };
}

/**
 * Does a dismissal of the wizard still belong to the run on screen?
 *
 * "Skip for now" and "Finish" close the dialog immediately and let the server
 * flag catch up on the refresh behind it, so the component keeps a latch. That
 * latch was one-way: Settings' "Run setup again" clears
 * `settings.onboarding_completed_at`, `show` goes false and then true again,
 * and the second run stayed invisible until a full page reload rebuilt the
 * component — the root layout survives client navigation, which is the same
 * property that makes wizard progress resumable.
 *
 * A run that becomes due again therefore drops the latch; every other
 * transition keeps it. Pure, so the rule is testable without a browser, and
 * the component applies it during RENDER rather than in the state-sync effect
 * AGENTS.md bans.
 */
export function dismissalSurvives(seenShow: boolean, show: boolean, dismissed: boolean): boolean {
  if (!seenShow && show) return false;
  return dismissed;
}

// ── Copy ────────────────────────────────────────────────────────────────────
// Descriptive, never prescriptive: `tests/onboarding-copy-guard.test.ts` runs
// every string below through PRESCRIPTIVE_LANGUAGE (lib/intelligence/insight.ts)
// and a superlatives list. Nothing here may claim a result, rank the product,
// or tell the user what to do with their money.

export const ONBOARDING_COPY = {
  dialogTitle: "Set up Vyuha",
  dialogDescription: "Four short steps. Everything here is editable later in Settings.",
  stepLabel: (step: number, total: number) => `Step ${step} of ${total}`,

  skip: "Skip for now",
  skipNote: "Skipping marks setup as done — Settings has “Run setup again” for later.",
  back: "Back",
  next: "Continue",
  finish: "Finish",

  step1: {
    title: "Welcome to Vyuha",
    lead: "Vyuha keeps your book in a file on this machine. Nothing is uploaded, and nothing on this screen is permanent.",
    nameLabel: "Name this account",
    nameHint: "Whatever you call this book — a broker name, “Equity”, your own initials.",
    capitalLegend: "Capital (optional)",
    equityLabel: "Equity capital",
    activeLabel: "F&O capital",
    capitalNote:
      "Leave either blank and the reports that divide by capital show “—” instead of a number. Vyuha does not invent a capital base, and you can fill these in at any time.",
    // An entry that could not be read is NOT an empty box, and the difference
    // is the whole point of the message: one is a decision, the other is a
    // typo that would otherwise have silently blanked a real capital base.
    capitalUnreadable: (label: string) =>
      `“${label}” holds something Vyuha could not read as an amount, so nothing on this step was saved. Digits with or without commas are read — “500000” and “5,00,000” both land as five lakh. An empty box stays blank, which is a real answer.`,
    // An emptied name box used to advance the step in silence, with nothing
    // sent — the account keeps the name it already has, and the user is told
    // rather than shown a step that only looked saved.
    nameMissing: (label: string) =>
      `“${label}” is empty, so nothing on this step was saved. Any name works — a broker name, “Equity”, your own initials.`,
    saveError: "That account could not be saved.",
  },

  step2: {
    title: "Get your trades in",
    lead: "Three ways in, and none of them has to happen now.",
    importTitle: "Import a file",
    importHint: (brokerCount: number) =>
      `A tradebook or P&L file from your broker. ${brokerCount} brokers are detected on sight; anything else goes through the column mapper, which asks whose file it is.`,
    connectTitle: "Connect a broker",
    connectHint: "What each direct API connection needs, and which brokers offer one.",
    manualTitle: "Add one by hand",
    manualHint: "The Trades page carries an “Add trade” button that opens the manual form.",
  },

  step3: {
    title: "Telegram end-of-day digest (optional)",
    // ONE sentence, and it deliberately does not restate the disclosure: the
    // consent text and its ack version are enforced server-side
    // (lib/domain/telegram-disclosure.ts, lib/telegram/digest-gate.ts), and a
    // second copy here would drift out of sync with the version on file.
    sentence:
      "Vyuha can send one end-of-day summary of this book to a Telegram bot you own — it is off until you turn it on in Settings, where the full disclosure and the setup live.",
    settingsLink: "Open Settings",
  },

  step4: {
    title: "That is everything",
    body: "Your book stays on this machine, and the journal itself is never gated.",
    reviewDesk: (trialDays: number) =>
      `Once trades are closed, the Review Desk is where you score them against your own plan — your ${trialDays}-day Pro trial includes it.`,
  },
} as const;

/** Every string the wizard can render, flattened for the copy guard. */
export function onboardingCopyStrings(): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "function") {
      // The parameterised lines are rendered too — sample them with plausible
      // arguments so the guard reads the same sentence the user does.
      const f = v as (...a: number[]) => string;
      out.push(f(7, 4));
    } else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(ONBOARDING_COPY);
  return out;
}
