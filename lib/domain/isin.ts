/**
 * ONE canonical form for an ISIN — pure (invariant 2), so both halves of every
 * ISIN compare can use the SAME rule.
 *
 * WHY IT EXISTS (L1, v4.3.0 fix wave 2L; the wave-2I re-check's "strategies"
 * finding). /strategies matches a holding to its option legs through the ISIN,
 * and the two halves canonicalised it differently:
 *
 *   - the page's admitting map: `isin.trim().toUpperCase()` — JS `.trim()`
 *     strips \t \n \r \f \v, U+00A0 (NBSP) and U+FEFF (BOM) as well as a space;
 *   - the query's ISIN branch: `upper(trim(trades.isin))` — SQLite's `trim()`
 *     strips U+0020 and NOTHING else (`trim(char(9)||'X')` is still "\tX").
 *
 * So a stored ISIN carrying any NON-SPACE whitespace was invisible to its OWN
 * account's query while another account's ticker could still carry it in on the
 * "All accounts" view, where the page's map then admitted it — bounding a call
 * that reads "Unlimited" in the account that actually holds the shares. I6 (fix
 * wave 2I) closed that door for SPACE padding only; this closes it for the rest,
 * by making the rule a single function instead of two spellings of one intent.
 *
 * It is REACHABLE, not theoretical: `lib/import/parsers/groww-xlsx.ts` and
 * `lib/import/parsers/angelone-upstox.ts` store the ISIN cell RAW, and
 * `lib/import/commit.ts` writes it unchanged — an .xlsx cell carrying a
 * non-breaking space or an Alt+Enter line break reaches the column as-is.
 *
 * THE RULE: remove every whitespace character — leading, trailing AND internal,
 * since an Alt+Enter lands mid-cell — then upper-case. A character outside that
 * set (a zero-width space, say) is treated as part of the code; that is a
 * deliberate limit and it is harmless here precisely BECAUSE both sides ask
 * this one function, so neither can be stricter than the other.
 *
 * NO VALIDATION and no stored value is rewritten: this is a read-time fold for
 * comparing, never a repair of the column (stored data stays the broker's).
 */
const WHITESPACE = /[\s ﻿]+/g;

export function canonicalIsin(value: string | null | undefined): string {
  return value == null ? "" : String(value).replace(WHITESPACE, "").toUpperCase();
}
