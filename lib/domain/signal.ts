// THE SIGNAL A TRADE WAS TAKEN ON (PURE, no DB/React — invariant 2).
//
// v4.3.0 gives the journal ONE strategy of its own: an option signal, recorded
// beside the trade it produced. Everything the signal states — the model, the
// underlying's spot and S/R zone, the strike's OI figures, the score and the
// T1/T2/SL ladder, and how the position actually ended — lives in ONE nullable
// text column, `trades.signal_json` (migration 0072), as a versioned envelope.
//
// ── WHY ONE COLUMN AND NOT NINETEEN ─────────────────────────────────────────
//
// The same call `settings.strategy_shelf_json` made (0071): the field list is a
// STRATEGY's description, and a strategy is a thing that gets revised. A column
// per field would make the schema grow with the owner's note-taking, and every
// one of them would be null on the ~100% of books that never record a signal.
// The envelope's `v` is what protects a future shape — `parseSignal` DISCARDS an
// alien version rather than half-reading it, the rule `parseShelf` and
// `readBackfillProgress` already follow.
//
// The column is plain `text`, NOT drizzle's `{mode:"json"}`: a v:2 envelope must
// reach `parseSignal` as a raw string so it can be discarded, not auto-parsed
// into a shape the readers would then half-trust.
//
// ── MONEY (invariant 1) ─────────────────────────────────────────────────────
//
// There is none. Every number here is a LEVEL (spot, a zone edge, a day's high,
// a target, a stop) or a piece of exchange data (open interest, a volume, a
// percentage). Levels stay REAL, exactly as `slPlanned` / `targetPlanned` /
// `strike` do — rounding them to paise would corrupt the qty × price arithmetic
// every reader of this journal does. `oiValueCr` is the chain's notional in ₹
// crore, which is market data and not the user's money, so it takes the same
// rule. NOTHING in this file converts to or from paise.
//
// ── DIRECTION IS NEVER IN HERE ──────────────────────────────────────────────
//
// CE or PE is `trade.optionType`, and long or short is the trade's own legs.
// A second copy of either would be a second answer to a question the row already
// answers, and the two would drift on the first edit.
//
// ── THE TOMBSTONE ───────────────────────────────────────────────────────────
//
// Clearing a signal cannot store SQL NULL, because the data fix that reads the
// seeded notes (`lib/db/data-fixes.ts`) writes exactly WHERE signal_json IS
// NULL, and `rerunDataFixesAfterRestore` forgets every marker: a restore — which
// is also how you move to a new machine — would resurrect from the notes the
// signal you deliberately deleted. So an explicit clear of a previously
// non-null value stores `{"v":1}`. `parseSignal` answers null for it (it is
// all-null, which is already the rule), the reader drops it, and the fix's
// IS NULL guard skips it. `classifyStoredSignal` is what tells the edit form
// the difference between that (offer the section, blank) and an envelope from a
// NEWER release (show it read-only and keep it byte-for-byte).

export const SIGNAL_ENVELOPE_VERSION = 1 as const;

/** What an explicit clear stores. Reads as "no signal", survives a restore. */
export const SIGNAL_TOMBSTONE = `{"v":${SIGNAL_ENVELOPE_VERSION}}`;

/** The owner's two models. NO tier field — the tier text stays in the notes. */
export const SIGNAL_MODELS = ["S1", "S2"] as const;
export type SignalModel = (typeof SIGNAL_MODELS)[number];

export const SIGNAL_EXIT_STATUSES = ["T1_HIT", "T2_HIT", "SL_HIT", "EOD_PROFIT", "EOD_LOSS"] as const;
export type SignalExitStatus = (typeof SIGNAL_EXIT_STATUSES)[number];

/**
 * Every numeric field of the envelope, IN THE ORDER IT IS SERIALISED.
 *
 * The order is fixed so a byte comparison of two envelopes is a comparison of
 * two signals — the backup round-trip pin reads the stored string, not a
 * re-parse of it.
 */
export const SIGNAL_NUMBER_FIELDS = [
  "spot",
  "zoneLow",
  "zoneHigh",
  "distPct",
  "moneynessPct",
  "strikeOi",
  "oiChgPct",
  "oiValueCr",
  "score",
  "cprPct",
  "volume",
  "rank",
  "dayHigh",
  "dayLow",
  "t1",
  "t2",
  "sl",
] as const;
export type SignalNumberField = (typeof SIGNAL_NUMBER_FIELDS)[number];

export type TradeSignal = { model: SignalModel | null; exitStatus: SignalExitStatus | null } & {
  [K in SignalNumberField]: number | null;
};

/** What a STORED value is, before anyone tries to read it as a signal. */
export type StoredSignalKind =
  /** NULL / blank — this trade never had one. */
  | "absent"
  /** A v1 envelope with nothing in it: the tombstone, or a cleared signal. */
  | "cleared"
  /** Broken JSON, a non-object, or a version this release does not know. */
  | "unreadable"
  /** A v1 envelope that states at least one thing. */
  | "signal";

/** All-null: the shape every builder starts from. */
export function emptySignal(): TradeSignal {
  const s = { model: null, exitStatus: null } as TradeSignal;
  for (const k of SIGNAL_NUMBER_FIELDS) s[k] = null;
  return s;
}

export function isEmptySignal(s: TradeSignal): boolean {
  return s.model === null && s.exitStatus === null && SIGNAL_NUMBER_FIELDS.every((k) => s[k] === null);
}

function envelopeOf(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw == null || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const env = parsed as Record<string, unknown>;
  if (env.v !== SIGNAL_ENVELOPE_VERSION) return null;
  return env;
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Read `trades.signal_json`. THE ONLY reader of that column
 * (`tests/signal-book-page.test.ts` scans the tree for a second one).
 *
 * The WHOLE envelope is discarded — null — for: a null or blank value, broken
 * JSON, a non-object, an array, a `v` this release does not know, and an
 * all-null envelope (the tombstone). A single field of the wrong type, a
 * non-finite number or an unknown enum value becomes null for THAT FIELD only,
 * because one unreadable percentage is not a reason to forget the ladder.
 * Never throws.
 */
export function parseSignal(raw: string | null | undefined): TradeSignal | null {
  const env = envelopeOf(raw);
  if (!env) return null;
  const s = emptySignal();
  s.model = SIGNAL_MODELS.includes(env.model as SignalModel) ? (env.model as SignalModel) : null;
  s.exitStatus = SIGNAL_EXIT_STATUSES.includes(env.exitStatus as SignalExitStatus) ? (env.exitStatus as SignalExitStatus) : null;
  for (const k of SIGNAL_NUMBER_FIELDS) s[k] = numOrNull(env[k]);
  return isEmptySignal(s) ? null : s;
}

/** Which of the four kinds a stored value is — see the tombstone note above. */
export function classifyStoredSignal(raw: string | null | undefined): StoredSignalKind {
  if (raw == null || raw.trim() === "") return "absent";
  if (!envelopeOf(raw)) return "unreadable";
  return parseSignal(raw) === null ? "cleared" : "signal";
}

/**
 * Write the column. `null` when the signal states nothing, so a trade with no
 * signal stores SQL NULL and is not a signal trade.
 *
 * `model` is always written, even as null, so the envelope always declares
 * which of the owner's two models it claims — including "neither, yet".
 * Every other null field is OMITTED: the stored value is a statement of what
 * was recorded, not a form with blanks.
 */
export function serializeSignal(s: TradeSignal): string | null {
  if (isEmptySignal(s)) return null;
  const env: Record<string, unknown> = { v: SIGNAL_ENVELOPE_VERSION, model: s.model };
  for (const k of SIGNAL_NUMBER_FIELDS) if (s[k] !== null) env[k] = s[k];
  if (s.exitStatus !== null) env.exitStatus = s.exitStatus;
  return JSON.stringify(env);
}

/* ─────────────────────────── the form's own door ─────────────────────────── */

const FIELD_LABELS: Record<SignalNumberField, string> = {
  spot: "Spot",
  zoneLow: "Zone low",
  zoneHigh: "Zone high",
  distPct: "Distance %",
  moneynessPct: "Moneyness %",
  strikeOi: "Strike OI",
  oiChgPct: "ΔOI %",
  oiValueCr: "OI value (₹ Cr)",
  score: "Score",
  cprPct: "CPR %",
  volume: "Volume",
  rank: "Rank",
  dayHigh: "Day high",
  dayLow: "Day low",
  t1: "T1",
  t2: "T2",
  sl: "SL",
};

/** Levels: a price, so strictly positive. */
const POSITIVE_FIELDS: readonly SignalNumberField[] = ["spot", "zoneLow", "zoneHigh", "dayHigh", "dayLow", "t1", "t2", "sl"];
/** Counts and notionals: zero is a real answer, negative is not. */
const NON_NEGATIVE_FIELDS: readonly SignalNumberField[] = ["strikeOi", "volume", "oiValueCr"];

export type SignalFormResult = { ok: true; json: string | null } | { ok: false; message: string };

/**
 * Build the envelope from the RAW strings the form posts, SERVER-SIDE.
 *
 * The section emits `signal.<field>` inputs verbatim and never serialises
 * anything itself — so this is the one place a typed "14,48" or "abc" is seen
 * at all. It is REFUSED, never coerced: the repo rule for a cell it cannot read
 * (AGENTS.md, `lib/import/generic-map.ts`) is that a wrong number is worse than
 * no number, and a ladder silently stored as 0 would be judged against by
 * block A for the life of the trade.
 *
 * @param get reads one field by its BARE name ("t1"), blank → null.
 */
export function signalFromForm(get: (k: string) => string | null): SignalFormResult {
  const s = emptySignal();

  const rawModel = get("model");
  if (rawModel !== null) {
    if (!SIGNAL_MODELS.includes(rawModel as SignalModel)) return { ok: false, message: `“${rawModel}” is not one of the signal models (S1, S2). Nothing was saved.` };
    s.model = rawModel as SignalModel;
  }
  const rawStatus = get("exitStatus");
  if (rawStatus !== null) {
    if (!SIGNAL_EXIT_STATUSES.includes(rawStatus as SignalExitStatus)) return { ok: false, message: `“${rawStatus}” is not one of the recorded exit statuses. Nothing was saved.` };
    s.exitStatus = rawStatus as SignalExitStatus;
  }

  for (const k of SIGNAL_NUMBER_FIELDS) {
    const raw = get(k);
    if (raw === null) continue;
    // SIG-1 (the 4.3.0 seam pass): stripping EVERY comma read a decimal-comma "14,48" as 1448 and
    // judged the trade against that level for life. A comma is accepted only as a thousands
    // separator - Western (1,448) or Indian lakh grouping (3,00,000) - whose LAST group has three
    // digits; anything else is refused, as the header of this function promises.
    const typed = raw.trim();
    const n = FORM_NUMBER_RE.test(typed) ? Number(typed.replace(/,/g, "")) : NaN;
    if (!Number.isFinite(n)) return { ok: false, message: `${FIELD_LABELS[k]} “${raw}” is not a number. Nothing was saved.` };
    if (POSITIVE_FIELDS.includes(k) && !(n > 0)) return { ok: false, message: `${FIELD_LABELS[k]} must be greater than 0. Nothing was saved.` };
    if (NON_NEGATIVE_FIELDS.includes(k) && n < 0) return { ok: false, message: `${FIELD_LABELS[k]} cannot be negative. Nothing was saved.` };
    if (k === "rank" && (!Number.isInteger(n) || n < 1)) return { ok: false, message: "Rank must be a whole number, 1 or more. Nothing was saved." };
    s[k] = n;
  }

  if (s.zoneLow !== null && s.zoneHigh !== null && s.zoneLow > s.zoneHigh) {
    return { ok: false, message: "The S/R zone low is above its high. Nothing was saved." };
  }
  if (s.dayLow !== null && s.dayHigh !== null && s.dayLow > s.dayHigh) {
    return { ok: false, message: "The day's low is above its high. Nothing was saved." };
  }

  return { ok: true, json: serializeSignal(s) };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The ladder the Add form offers: +30% / +60% / −25% of the entry premium
 * (owner ruling; every level stays editable, and adherence is judged on what
 * the trade actually RECORDS, never on this prefill).
 */
export function prefillLadder(entry: number): { t1: number; t2: number; sl: number } | null {
  if (!Number.isFinite(entry) || entry <= 0) return null;
  return { t1: r2(entry * 1.3), t2: r2(entry * 1.6), sl: r2(entry * 0.75) };
}

/* ────────────────── the seeded options-strategy log's notes ────────────────── */

/**
 * The 42 rows `scripts/seed-options-account.ts` wrote carry their signal in
 * four lines of `notes`. This reads it back, for the one-shot data fix.
 *
 * It REFUSES rather than guesses. Anything but an exact four-line match — a
 * fifth line, an unknown status, a setup tag that is not one of the two the
 * script writes, a tag whose direction contradicts `optionType`, a zone or a
 * day range the wrong way round, a level of 0, a "NaN" where a percentage
 * should be — returns null and the row is left EXACTLY as stored. The notes are
 * never rewritten either way.
 *
 * `distPct` is deliberately NOT derived: the rulings do not say which edge of
 * the zone the distance is measured from, and inventing a denominator is
 * invariant 6's own prohibition.
 */
/** What the FORM may type for a number: optional sign, plain digits or comma groups ending in a
 *  three-digit group (1,448 / 3,00,000), optional decimals. "14,48", "1e5" and "abc" are refused. */
const FORM_NUMBER_RE = /^[-+]?(?:\d+|\d{1,3}(?:,\d{2,3})*,\d{3})(?:\.\d+)?$/;
const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const SIGNED = String.raw`-?\d+(?:\.\d+)?`;
// (.*) not (.+): a row whose tier cell is empty prints "#5 · " and is still a
// perfectly readable log line (review item 3a).
const L1_RE = new RegExp(String.raw`^Options strategy log #(\d+) · (.*)$`);
// The zone separator: a hyphen or an en dash, with or without spaces around it —
// both spellings occur in the sheet (3b).
const L2_RE = new RegExp(String.raw`^Spot (${NUM}) · S/R zone (${NUM})\s*[-–]\s*(${NUM}) · Day H/L (${NUM})/(${NUM})$`);
// The status is captured loosely and normalised below, because the script's own
// emoji strip leaves a trailing U+FE0F behind (3c).
const L3_RE = new RegExp(String.raw`^T1 (${NUM}) · T2 (${NUM}) · SL (${NUM}) · Exit: (.+) \((${SIGNED})%\)$`);
const L4_RE = new RegExp(String.raw`^ΔOI (${SIGNED})% \(unwind\) · Volume (\d+)$`);

const SEEDED_STATUS: Record<string, SignalExitStatus> = {
  "EOD PROFIT CLOSE": "EOD_PROFIT",
  "EOD LOSS CLOSE": "EOD_LOSS",
  "TARGET 1 HIT": "T1_HIT",
  "TARGET 2 HIT": "T2_HIT",
  "SL HIT": "SL_HIT",
};

const SEEDED_TAG_DIRECTION: Record<string, "CE" | "PE"> = {
  "CE BREAKOUT (RES)": "CE",
  "PE BREAKDOWN (SUP)": "PE",
};

const n = (s: string) => Number(s.replace(/,/g, ""));

export function parseSeededSignalNotes(notes: string, setupTag: string | null, optionType: string | null): TradeSignal | null {
  if (!setupTag) return null;
  const tagDirection = SEEDED_TAG_DIRECTION[setupTag.trim()];
  if (!tagDirection) return null;
  if (!optionType || optionType.trim().toUpperCase() !== tagDirection) return null;

  const lines = (notes ?? "").split(/\r?\n/);
  if (lines.length !== 4) return null;

  const m1 = L1_RE.exec(lines[0]);
  const m2 = L2_RE.exec(lines[1]);
  const m3 = L3_RE.exec(lines[2]);
  const m4 = L4_RE.exec(lines[3]);
  if (!m1 || !m2 || !m3 || !m4) return null;

  // Trailing U+FE0F, whitespace and any other non-ASCII the emoji strip left.
  const status = SEEDED_STATUS[m3[4].replace(/[^\x20-\x7E]+\s*$/u, "").trim()];
  if (!status) return null;

  const s = emptySignal();
  s.spot = n(m2[1]);
  s.zoneLow = n(m2[2]);
  s.zoneHigh = n(m2[3]);
  s.dayHigh = n(m2[4]);
  s.dayLow = n(m2[5]);
  s.t1 = n(m3[1]);
  s.t2 = n(m3[2]);
  s.sl = n(m3[3]);
  s.exitStatus = status;
  s.oiChgPct = n(m4[1]);
  s.volume = n(m4[2]);

  const levels = [s.spot, s.zoneLow, s.zoneHigh, s.dayHigh, s.dayLow, s.t1, s.t2, s.sl];
  if (levels.some((x) => !Number.isFinite(x!) || x! <= 0)) return null;
  if (!Number.isFinite(s.oiChgPct!) || !Number.isFinite(s.volume!)) return null;
  if (s.zoneLow > s.zoneHigh) return null;
  if (s.dayLow > s.dayHigh) return null;

  return s;
}
