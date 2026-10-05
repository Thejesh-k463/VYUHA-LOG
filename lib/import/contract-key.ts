// THE CONTRACT KEY — the ONE pure, client-safe leaf every pairing reader keys on
// (v4.8.0 wave X1, design D1; the C6 half moved here from cross-source.ts).
//
// ── Why one leaf ────────────────────────────────────────────────────────────
//
// A stored `tradingsymbol` is whatever the SOURCE wrote: OpenAlgo, Kotak Neo,
// Nuvama, Dhan and Angel One state a derivative with its expiry DAY
// (`OPT NIFTY 22 Sep 2026 25000 CE`); Fyers, Zerodha and Upstox state the
// exchange's compact name, which carries the day for a weekly
// (`NIFTY2692225000CE`) and only the MONTH for a monthly or a future
// (`NIFTY26SEP25000CE`, `NIFTY26SEPFUT`). Equity is a bare ticker, which a FILE
// may keep a series suffix on (`SBIN-EQ`). Before X1 six pairing readers joined
// a lot and its closing execution on `tradingsymbol.trim().toUpperCase()`, so
// one contract opened by one source and sold through another never met: the
// sale landed as a second open row, and the book held the position twice
// (X1-DESIGN.md §0; the pinned harness case "RESIDUAL R4'"). The dedup HASH is
// NOT re-keyed — it is frozen identity (`lib/import/dedup.ts`); this key is
// derived at read time and stored nowhere (alternative B lost: a stored key
// column has nine writers and goes stale on the next grammar fix).
//
// ── The two keys and the level between two names ────────────────────────────
//
//   monthKey  `option|NIFTY|2026-09|25000|CE`  the C6 contract key, unchanged:
//             what a compact monthly and a dated name of one month share.
//   pairKey   `…|CE|2026-09-22` / `…|CE|M`     the month key PLUS the expiry
//             day the name states — `M` when it states only the month. Two
//             names pair EXACTLY when their pairKeys are equal.
//   equity    `equity|SBIN` for both (series suffix stripped).
//   raw       `raw|<TRIM UPPER>` for a derivative whose month or strike does
//             not parse, and for a blank — today's behaviour, never guessed.
//
// `pairLevel(a, b)` is "exact" on equal pairKeys; "month" ONLY between a
// compact monthly / future (no day) and a DATED-grammar name (`OPT …` /
// `FUT …`) of the same month key (review D3: a compact weekly against a
// compact monthly is ONE grammar and never one contract, so it is null); and
// null otherwise. Month level is never applied automatically anywhere: nothing
// bundled states the monthly expiry day, and the cost of guessing is a calendar
// spread closed against itself (owner ruling S6 — a month-level pair is ASKED).
//
// Every function here is memoised per distinct string: `planExecutionCloses`
// re-keys every open lot once per incoming row, and the cross-source index keys
// every stored row, so the parse must cost once per NAME, not once per read.

// The ONE non-type import, and still a leaf: `classify.ts` imports only
// `lib/domain/constants` (no parser, no DB) — `components/import/import-client.tsx`
// reaches this module through cross-source.ts in the client bundle.
import { parseInstrumentContract } from "@/lib/engine/classify";

const norm = (s: string) => s.trim().toUpperCase();

/**
 * An equity series suffix. The UNION of the three copies that existed before
 * X1 (`cross-source.ts` had five; `api/angelone.ts` and `api/upstox.ts` add
 * `BL` and `GS`). PROBE-K (X1 review): no bundled ticker ends in one of these,
 * while 13 real tickers end in `-B` / `-RE`, so Fyers' `-A/-B/-T` groups are
 * deliberately NOT here — a ticker is not a series.
 */
const SERIES_SUFFIX = /-(?:EQ|BE|BZ|BL|GS|SM|ST)$/;

/** Trim, upper-case and drop an equity series suffix (`SBIN-EQ` → `SBIN`). */
export function stripSeriesSuffix(t: string): string {
  return norm(t).replace(SERIES_SUFFIX, "");
}

export interface ContractKey {
  /**
   * Derivatives: `option|UNDERLYING|YYYY-MM|STRIKE|CE` / `future|UNDERLYING|YYYY-MM||`
   * — the MONTH, so a compact monthly (`CDSL26SEP1400CE`, day unstated) and a
   * dated name of the same contract (`OPT CDSL 29 Sep 2026 1400 CE`) share it.
   * Equity: `equity|TICKER`, series suffix stripped. NO segment anywhere (C6 R2):
   * a broker-side product conversion keeps its contract.
   */
  key: string;
  /** The expiry DAY the name states (ISO), or null when it states only the month. */
  day: string | null;
}

/** What one name says, computed once per distinct string. */
interface Described {
  ck: ContractKey | null;
  monthKey: string;
  pairKey: string;
  /** A derivative written in the DATED grammar (`OPT …` / `FUT …`, has spaces). */
  dated: boolean;
  /** A derivative written in the exchange's compact grammar (no spaces). */
  compact: boolean;
}

const memo = new Map<string, Described>();

function describe(tradingsymbol: string): Described {
  const hit = memo.get(tradingsymbol);
  if (hit) return hit;
  const ck = contractKeyOf(tradingsymbol);
  const trimmed = (tradingsymbol ?? "").trim();
  let d: Described;
  if (!ck) {
    const raw = `raw|${norm(tradingsymbol ?? "")}`;
    d = { ck, monthKey: raw, pairKey: raw, dated: false, compact: false };
  } else if (ck.key.startsWith("equity|")) {
    d = { ck, monthKey: ck.key, pairKey: ck.key, dated: false, compact: false };
  } else {
    // `matchCompactName` (classify.ts) admits no space, and the dated grammar
    // needs at least four tokens — the two grammars are told apart by that.
    const dated = /\s/.test(trimmed);
    d = { ck, monthKey: ck.key, pairKey: `${ck.key}|${ck.day ?? "M"}`, dated, compact: !dated };
  }
  memo.set(tradingsymbol, d);
  return d;
}

/**
 * The contract a stored or incoming `tradingsymbol` names, read through the
 * classifier's own grammar (`parseInstrumentContract`), or null when the name
 * is a derivative whose month or strike does not parse — such a row is matched
 * on its string alone, exactly as before C6.
 */
export function contractKeyOf(tradingsymbol: string): ContractKey | null {
  if (!tradingsymbol || !tradingsymbol.trim()) return null;
  const { parsed, month } = parseInstrumentContract(tradingsymbol);
  if (parsed.kind === "equity") {
    const bare = stripSeriesSuffix(tradingsymbol);
    return bare ? { key: `equity|${bare}`, day: null } : null;
  }
  if (!month) return null;
  if (parsed.kind === "option") {
    if (parsed.strike == null || !Number.isFinite(parsed.strike) || !parsed.optionType) return null;
    return { key: `option|${parsed.symbol.toUpperCase()}|${month}|${parsed.strike}|${parsed.optionType}`, day: parsed.expiry };
  }
  return { key: `future|${parsed.symbol.toUpperCase()}|${month}||`, day: parsed.expiry };
}

/**
 * Two names of one contract key are the SAME contract when their expiry days
 * are equal or either is unstated (C6 R1); two different stated days are two
 * expiries of one month (a weekly and the monthly), never the same contract.
 */
export const sameContractDay = (a: string | null, b: string | null) => a === null || b === null || a === b;

/** `sameContractDay` over two NAMES (D7/D8): the days each one states. */
export function sameContractDayOf(a: string, b: string): boolean {
  return sameContractDay(describe(a).ck?.day ?? null, describe(b).ck?.day ?? null);
}

/** The MONTH-level key (the C6 contract key), `raw|…` when the name does not parse. Memoised. */
export function monthKeyOf(tradingsymbol: string): string {
  return describe(tradingsymbol).monthKey;
}

/**
 * The EXACT pairing key: the month key plus the stated expiry day (`M` when only
 * the month is stated). Memoised. Two names with equal pairKeys are one
 * contract in every pairing reader (D2 `matchKey`, D6a the supersede key, the
 * un-close finder, the harness's statement sum).
 */
export function pairKeyOf(tradingsymbol: string): string {
  return describe(tradingsymbol).pairKey;
}

export type PairLevel = "exact" | "month";

/**
 * How two names relate (design §2, review D3):
 *   "exact" — equal pairKeys (same day, or both `M`, or equity / raw equal);
 *   "month" — equal month keys, where exactly one name states no day AND that
 *             name is a compact monthly / future AND the other is written in the
 *             DATED grammar. A compact weekly against a compact monthly is one
 *             grammar and never one contract → null.
 *   null    — anything else.
 * With `onDate` (the execution's or sale's day): a month-level pair is null when
 * that day is AFTER the dated name's own expiry — a contract cannot be traded
 * after it expired, so the dated name is some other expiry's twin.
 */
export function pairLevel(a: string, b: string, onDate?: string | null): PairLevel | null {
  const da = describe(a);
  const db = describe(b);
  if (da.pairKey === db.pairKey) return "exact";
  if (da.monthKey !== db.monthKey || !da.ck || !db.ck) return null;
  const [noDay, withDay] = da.ck.day === null ? [da, db] : [db, da];
  if (noDay.ck!.day !== null || withDay.ck!.day === null) return null;
  if (!noDay.compact || !withDay.dated) return null;
  if (onDate && onDate > withDay.ck!.day!) return null;
  return "month";
}

/**
 * D2 rider (review): an ISIN's first seven characters name the ISSUER and survive
 * a face-value split (which changes the rest). Two stated ISINs of DIFFERENT
 * issuers refuse the pair even on an equal key — `MAL` is one ticker on two
 * boards (AGENTS.md), and a file that states no exchange defaults to NSE.
 */
export function sameIssuer(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").trim().toUpperCase();
  const y = (b ?? "").trim().toUpperCase();
  if (x.length < 7 || y.length < 7) return true; // nothing stated on one side: no veto
  return x.slice(0, 7) === y.slice(0, 7);
}
