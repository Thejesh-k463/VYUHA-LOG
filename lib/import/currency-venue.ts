/**
 * WHAT COUNTS AS A CURRENCY DERIVATIVE — the one rule, for every door.
 *
 * PURE and CLIENT-IMPORTABLE (v4.8.0 wave CU, residual R8): its whole import
 * graph is `lib/engine/classify.ts` → `lib/domain/constants.ts` (+ types) and
 * `lib/domain/currency-pairs.ts`. No papaparse, no xlsx, no `node:` module, no
 * DB, no React — the manual Add-trade form (a client component) and
 * `lib/import/generic-map.ts` (imported by the column mapper, also a client
 * component) both import it, and `next build` fails on a server-only module in
 * that graph. Keep it that way: a parser imports THIS file, never the reverse.
 *
 * Until v4.8.0 the venue rule lived in `generic-map.ts` and the contract rule
 * in `parsers/zerodha.ts` (which reads papaparse and xlsx), so the form could
 * not ask the question the importers ask. Both modules re-export from here, so
 * every existing import keeps working.
 *
 * Vyuha does not price currency derivatives: no `charge_config` row covers
 * them (AGENTS.md invariant 3), so a USDINR future that reaches the engine is
 * priced as an equity future — equity-F&O STT and stamp on a contract that
 * pays neither. Every door therefore REFUSES one and says so.
 */

import { classify } from "@/lib/engine/classify";
import { isCurrencyPair } from "@/lib/domain/currency-pairs";

/** The refusal reason, verbatim in every currency note the importers write. */
export const CURRENCY_NOT_PRICED = "currency derivatives are not priced by Vyuha";

/**
 * The sentence a HAND-TYPED currency trade gets — from the Add-trade form
 * (inline, before submit), from `createManualTrade` (the save) and from
 * `/api/charges/preview` (no priced preview). One literal, so the three cannot
 * drift (`tests/preview-equals-save-matrix.test.ts` pins preview === save).
 * "Nothing is saved" — present tense, because the form shows it BEFORE the
 * user submits as well as after a refused save.
 */
export const MANUAL_CURRENCY_REFUSAL =
  "Currency derivatives are not priced by Vyuha (no charge profile covers them), so a currency trade cannot be added by hand. Nothing is saved.";

/**
 * PURE. A venue / segment CELL that states the currency segment, in any broker's
 * vocabulary: `CDS`, `BCD`, `CD`, `Currency`, `Currency Derivatives`, and the
 * compound forms `NSE-CDS`, `NSE_CURRENCY`, `BSE_CURRENCY`, `NSE CD`.
 *
 * The ONE rule for a stated venue across the importers and the manual form.
 *
 * Two halves: the prefix rule the Zerodha parser has always applied to its own
 * cells (`CDS…`, `BCD…`, `CD`, `Currenc…`, spaces / `_` / `.` folded), and —
 * for the compound forms — a WHOLE token of the cell (`NSE-CDS` → `CDS`). It is
 * for venue and segment cells only, never for a symbol: `CDSL` starts with `CDS`.
 */
export function isCurrencyVenueCell(raw: string | null | undefined): boolean {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!s) return false;
  const flat = s.replace(/[\s_.]/g, "");
  if (flat.startsWith("CDS") || flat.startsWith("BCD") || flat === "CD" || flat.startsWith("CURRENC")) return true;
  return s.split(/[^A-Z0-9]+/).some((t) => t === "CDS" || t === "BCD" || t === "CD" || t.startsWith("CURRENC"));
}

/** PURE. The parsers' name for `isCurrencyVenueCell` — the same function. */
export function statesCurrency(raw: string | null | undefined): boolean {
  return isCurrencyVenueCell(raw);
}

/**
 * PURE. A contract whose classified underlying is a currency pair: the stored
 * `symbol`, an EXACT member of `lib/domain/currency-pairs.ts` — never a
 * tradingsymbol prefix (`USDINRBEES` is an ETF and stays importable).
 */
export function isCurrencyContract(tradingsymbol: string): boolean {
  return isCurrencyPair(classify({ tradingsymbol }).symbol);
}

/**
 * PURE. Would this hand-typed trade be a currency derivative? By the contract
 * the form builds (the Equity tab's free-text symbol, or the F&O tab's
 * `FUT USDINR 28 Oct 2026` / `OPT USDINR 28 Oct 2026 84.5 CE`), or by an
 * Exchange / Segment override that states a currency venue. The form's own
 * selects offer no such venue; a hand-built request can still send one.
 */
export function isManualCurrencyTrade(t: {
  tradingsymbol: string | null | undefined;
  segment?: string | null;
  exchange?: string | null;
}): boolean {
  const name = String(t.tradingsymbol ?? "").trim();
  return (name !== "" && isCurrencyContract(name)) || isCurrencyVenueCell(t.exchange) || isCurrencyVenueCell(t.segment);
}
