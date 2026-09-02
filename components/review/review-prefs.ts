// The Trade Review Desk's PER-DEVICE chrome (PURE — no DB, no React).
//
// Which slice of the queue is listed, how it is ordered, whether the
// already-reviewed rows are on screen: none of that is a fact about the book,
// so none of it belongs in the database. It is localStorage chrome, and it
// follows the recorded convention — a `vyuha-…` key, a VERSIONED envelope, and
// a pure parser twin so the shape can be tested without a browser
// (`components/layout/nav-config.ts`'s `parseNavOrder` is the model).
//
// ── Why a future version is DISCARDED, not migrated ────────────────────────
//
// `parseNavOrder` migrates the legacy un-versioned `{groups, items}` shape
// because a real release wrote it and a user's saved order had to survive the
// update that added folding. NOTHING has ever written a review-prefs value, so
// there is no legacy shape to rescue: an object with no `v`, or a `v` this
// build does not know, is data written by a DIFFERENT build of the app. Reading
// it field-by-field would mean guessing what a future author meant, so it is
// dropped and the defaults render instead.
//
// Field-level tolerance is the opposite call, and deliberate: inside a v1
// envelope an unreadable FIELD falls back to its own default rather than
// discarding the whole envelope, because a stale filter value is not a reason
// to throw away a sort the user did choose.

/** localStorage key — kebab-case `vyuha-…`, per the recorded convention. */
export const REVIEW_PREFS_KEY = "vyuha-review-prefs";

/** Which unreviewed trades the queue lists. */
export const REVIEW_SCOPES = ["all", "week"] as const;
export type ReviewScope = (typeof REVIEW_SCOPES)[number];

/** Row order inside the queue. */
export const REVIEW_SORTS = ["recent", "oldest", "worst"] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

export const REVIEW_SCOPE_LABELS: Record<ReviewScope, string> = {
  all: "Every unreviewed trade",
  week: "Closed this week",
};

export const REVIEW_SORT_LABELS: Record<ReviewSort, string> = {
  recent: "Newest close first",
  oldest: "Oldest close first",
  worst: "Largest loss first",
};

/** The stored envelope (localStorage `vyuha-review-prefs`). */
export interface ReviewPrefs {
  v: 1;
  scope: ReviewScope;
  sort: ReviewSort;
  /** Mistake tag to filter on; "" means every tag. */
  tag: string;
  /** Fold away the already-reviewed rows (the ones carrying "Reopen"). */
  hideReviewed: boolean;
}

export const DEFAULT_REVIEW_PREFS: ReviewPrefs = {
  v: 1,
  scope: "all",
  sort: "recent",
  tag: "",
  hideReviewed: false,
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/**
 * Parse the stored review-prefs value into a v1 envelope (PURE).
 *
 * Returns null for anything this build cannot read — corrupt JSON, a
 * non-object, an un-versioned object, a version other than 1 — so the caller
 * renders the defaults rather than a mis-read of somebody else's shape.
 */
export function parseReviewPrefs(raw: string | null | undefined): ReviewPrefs | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (o.v !== 1) return null; // no `v` at all, or a future shape → discarded
    return {
      v: 1,
      scope: oneOf(o.scope, REVIEW_SCOPES, DEFAULT_REVIEW_PREFS.scope),
      sort: oneOf(o.sort, REVIEW_SORTS, DEFAULT_REVIEW_PREFS.sort),
      tag: typeof o.tag === "string" ? o.tag : DEFAULT_REVIEW_PREFS.tag,
      hideReviewed: typeof o.hideReviewed === "boolean" ? o.hideReviewed : DEFAULT_REVIEW_PREFS.hideReviewed,
    };
  } catch {
    return null;
  }
}

/** The parsed prefs, or the defaults. What every render actually wants. */
export function reviewPrefsOrDefault(raw: string | null | undefined): ReviewPrefs {
  return parseReviewPrefs(raw) ?? DEFAULT_REVIEW_PREFS;
}

/** Serialise for `writeStored` — one place that decides what lands in storage. */
export function serialiseReviewPrefs(prefs: ReviewPrefs): string {
  return JSON.stringify({ ...prefs, v: 1 });
}
