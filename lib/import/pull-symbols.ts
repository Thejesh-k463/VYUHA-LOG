/**
 * THE TRADINGSYMBOL A NATIVE PULL STORES (v4.7.0 wave C6, builder B1) — Fyers,
 * Kotak Neo, Nuvama. PURE: no DB, no React, no fetch.
 *
 * ── Why the string matters ──────────────────────────────────────────────────
 * The exact duplicate check (`dedupHash`) keys on the stored `tradingsymbol`,
 * and before C6 the cross-source check did too. So each pull emits the SAME
 * string the existing source for that broker already stores (design D6):
 *
 *   Fyers  → the Fyers FILE's compact form (`CDSL26SEP1400CE`,
 *            `NIFTY20O0811000CE`, `NIFTY26SEPFUT`); equity as the bare ticker
 *            (review R3 — the series is returned for the import notes).
 *   Kotak  → the OpenAlgo canonical grammar (`canonicalOpenAlgoSymbol`):
 *            `OPT CDSL 29 Sep 2026 1400 CE`, `FUT TCS 28 Jul 2026` —
 *            OpenAlgo-Kotak is the only other Kotak source (no file parser).
 *   Nuvama → exactly what `nuvamaInstrument` (the P&L-report parser) stores.
 *            NO `dedupLabel` is built here (review R12/R4): the check meets on
 *            the tradingsymbol, which is byte-equal by construction.
 *
 * Strings that still differ for one contract (a Fyers compact monthly against
 * OpenAlgo-Fyers' dated name) meet through the CONTRACT key in
 * `lib/import/cross-source.ts` (review R1/R2), re-exported below.
 *
 * ── The refusal rule ────────────────────────────────────────────────────────
 * Every builder answers null for a row it cannot name from STATED fields — an
 * expiry that does not parse, a strike that is not a number, an underlying the
 * row does not state. The caller REFUSES that row and counts it; a guessed
 * contract would be priced, taxed and paired as something the user never
 * traded (invariant 6).
 */

import { parseInstrumentContract } from "@/lib/engine/classify";
import { bundledSymbolByIsin } from "./isin-symbol";
import { nuvamaInstrument } from "./parsers/nuvama-pnl-report";
import { stripSeriesSuffix } from "./cross-source";

export { contractKeyOf, sameContractDay, stripSeriesSuffix, type ContractKey } from "./cross-source";

const MON_TITLE: Record<string, string> = {
  JAN: "Jan", FEB: "Feb", MAR: "Mar", APR: "Apr", MAY: "May", JUN: "Jun",
  JUL: "Jul", AUG: "Aug", SEP: "Sep", OCT: "Oct", NOV: "Nov", DEC: "Dec",
};
const MON_NUM: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/** A ticker-shaped underlying: letters/digits/&/-, at least one letter. A Nuvama
 *  token (`7053_NSE`) or a bare number is NOT an underlying. */
const isTickerShaped = (s: string) => /^[A-Z0-9&-]+$/.test(s) && /[A-Z]/.test(s);

/** A strike the row states as a number (`"1400"`, `"1400.00"`, `187.5`); null otherwise. */
function strikeOf(v: string | number | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}

/** dd + MMM + yyyy → `{iso, dd, mon}`, validated against the calendar (no 31 Sep). */
function dayOf(d: string, mon: string, yyyy: string): { iso: string; dd: string; mon: string } | null {
  const m = mon.toUpperCase();
  const mm = MON_NUM[m];
  if (!mm) return null;
  const dd = d.padStart(2, "0");
  const day = Number(dd), year = Number(yyyy);
  const probe = new Date(Date.UTC(year, Number(mm) - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== Number(mm) - 1 || probe.getUTCDate() !== day) return null;
  return { iso: `${yyyy}-${mm}-${dd}`, dd, mon: MON_TITLE[m]! };
}

/** Kotak's documented `expDt` forms: `28 Jul, 2026` (K-S1), `28-Jul-2026`, `28 Jul 2026`. */
function kotakExpiry(raw: string | null | undefined) {
  const m = /^(\d{1,2})(?:-([A-Za-z]{3})-|\s+([A-Za-z]{3})(?:,\s*|\s+))(\d{4})$/.exec(String(raw ?? "").trim());
  return m ? dayOf(m[1]!, (m[2] ?? m[3])!, m[4]!) : null;
}

/**
 * Nuvama's `dpExpDt` (typed "string", no sample — N-B4): the P&L report's own
 * `22Sep2026` grammar, `22-Sep-2026` / `22 Sep 2026` / `22 Sep, 2026`, the
 * report's `22-Sep-26` date form (`nuvamaDate`), or ISO `2026-09-22`. Every
 * accepted form is unambiguous; `22/09/2026` is not, and is refused.
 */
function nuvamaExpiry(raw: string | null | undefined) {
  const s = String(raw ?? "").trim();
  let m = /^(\d{1,2})[\s-]?([A-Za-z]{3})(?:,\s*|[\s-])?(\d{4})$/.exec(s);
  if (m) return dayOf(m[1]!, m[2]!, m[3]!);
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(s);
  if (m) return dayOf(m[1]!, m[2]!, `20${m[3]}`);
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const mon = Object.keys(MON_NUM).find((k) => MON_NUM[k] === m![2]);
    return mon ? dayOf(m[3]!, mon, m[1]!) : null;
  }
  return null;
}

/** The OpenAlgo / Nuvama canonical name — the grammar `parseInstrumentName` reads. */
function canonicalName(
  kind: "option" | "future",
  underlying: string,
  exp: { dd: string; mon: string; iso: string },
  strike: string | null,
  optionType: "CE" | "PE" | null,
): string {
  const yyyy = exp.iso.slice(0, 4);
  return kind === "option"
    ? `OPT ${underlying} ${exp.dd} ${exp.mon} ${yyyy} ${strike} ${optionType}`
    : `FUT ${underlying} ${exp.dd} ${exp.mon} ${yyyy}`;
}

/**
 * What a broker's own compact trading symbol says, when it reads as a
 * derivative — used to (a) derive an underlying a row does not state and (b)
 * refuse a row whose stated fields CONTRADICT its own symbol. Null when the
 * symbol is not a compact derivative (nothing to compare).
 */
function compactFacts(trdSym: string) {
  const s = trdSym.trim().toUpperCase();
  if (!s || s.includes(" ")) return null;
  const { parsed, month } = parseInstrumentContract(s);
  if (parsed.kind === "equity" || !month) return null;
  return { kind: parsed.kind, underlying: parsed.symbol.toUpperCase(), month, strike: parsed.strike == null ? null : String(parsed.strike), optionType: parsed.optionType };
}

/** Do a symbol's own compact facts agree with the stated kind/month/strike/type? */
function agrees(
  f: NonNullable<ReturnType<typeof compactFacts>>,
  kind: "option" | "future",
  expIso: string,
  strike: string | null,
  optionType: "CE" | "PE" | null,
): boolean {
  if (f.kind !== kind || f.month !== expIso.slice(0, 7)) return false;
  return kind === "future" || (f.strike === strike && f.optionType === optionType);
}

// ─────────────────────────────────────────────────────────────────────────────
// Currency / NCDEX — ONE refusal rule across the three pulls (seam D-C6-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A currency derivative (NSE CDS, BSE BCD) or an NCDEX contract is REFUSED by
 * the C6 pulls (Fyers, Kotak Neo, Nuvama) and counted; the Kite pull and the
 * Zerodha files refuse currency too since the v4.7.0 audit (their own code, not
 * this rule). No charge profile covers either (a CDS trade pays no STT, yet `USDINR26OCTFUT` classifies as an equity `future` and would
 * be charged equity-F&O STT and stamp), and Vyuha has no currency segment
 * vocabulary to name one with. Kotak's `cde_fo` was refused from the start
 * (`KOTAK_DERIVATIVE` below); Nuvama and Fyers now answer the same way, and the
 * caller says so in its notes with `unpricedRefusalNote`. MCX stays imported.
 */
export const PULL_UNPRICED_REFUSAL = "currency / NCDEX contracts are not imported by this pull";

/** The import note for `n` rows refused by the currency / NCDEX rule. */
export function unpricedRefusalNote(n: number): string {
  return `${n} currency / NCDEX fill${n === 1 ? " was" : "s were"} refused: ${PULL_UNPRICED_REFUSAL} (no charge profile covers them).`;
}

/** Kotak's currency segment — already absent from `KOTAK_DERIVATIVE`, so refused by naming. */
export function kotakUnpricedSegment(exSeg: string | null | undefined): boolean {
  return String(exSeg ?? "").trim().toLowerCase() === "cde_fo";
}

const NUVAMA_UNPRICED_EXCHANGES = new Set(["CDS", "BCD", "NCDEX"]);

/** A Nuvama row on CDS / BCD / NCDEX — by its stated `exc`, or by the exchange
 *  token closing the report grammar (`USDINR-FUT-28Oct2026-CDS`). */
export function nuvamaUnpricedRow(row: { trdSym?: string | null; exc?: string | null }): boolean {
  if (NUVAMA_UNPRICED_EXCHANGES.has(String(row.exc ?? "").trim().toUpperCase())) return true;
  const m = /-(OPT|FUT)-.*-([A-Z]+)$/i.exec(String(row.trdSym ?? "").trim());
  return m != null && NUVAMA_UNPRICED_EXCHANGES.has(m[2]!.toUpperCase());
}

/** Fyers segment ints (R10 F13): 10 CM, 11 FO, 12 CD, 20 COM. A segment-12 row,
 *  or a symbol carrying a currency / NCDEX exchange prefix, is unpriced. */
const FYERS_CURRENCY_SEGMENT = 12;
export function fyersUnpricedRow(segment: number | string | null | undefined, symbol: string | null | undefined): boolean {
  if (segment != null && segment !== "" && Number(segment) === FYERS_CURRENCY_SEGMENT) return true;
  return /^(?:CDS|BCD|NCDEX):/i.test(String(symbol ?? "").trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Fyers
// ─────────────────────────────────────────────────────────────────────────────

const FYERS_EXCHANGE_PREFIX = /^(?:NSE|BSE|MCX|NFO|BFO|CDS|BCD):/;
const EQUITY_SERIES = /-(EQ|BE|BZ|SM|ST)$/;

/**
 * A Fyers API `symbol` (`NSE:SBIN-EQ`, `NSE:CDSL26SEP1400CE`,
 * `NSE:NIFTY20O0811000CE`, `BSE:SENSEX2681377500PE`, `NSE:NIFTY26SEPFUT`) → the
 * tradingsymbol the Fyers FILE stores. The exchange prefix is stripped and the
 * name upper-cased; an equity series suffix (`-EQ -BE -BZ -SM -ST`) is stripped
 * to the bare ticker and returned as `series` (review R3: the caller records it
 * in the import notes); a derivative keeps the compact form byte for byte.
 *
 * The form is INFERRED from Fyers' order samples (§1a F-S1) — the first live
 * pull confirms it. Null for an empty value, an unknown `XXX:` prefix, or
 * anything with a character no Fyers symbol carries.
 */
export function fyersTradingsymbol(symbol: string): { tradingsymbol: string; series: string | null } | null {
  let s = String(symbol ?? "").trim().toUpperCase();
  if (FYERS_EXCHANGE_PREFIX.test(s)) s = s.replace(FYERS_EXCHANGE_PREFIX, "");
  if (!s || !/^[A-Z0-9&][A-Z0-9&_.-]*$/.test(s)) return null;
  const series = EQUITY_SERIES.exec(s);
  if (series) {
    const bare = s.slice(0, -series[0].length);
    return bare ? { tradingsymbol: bare, series: series[1]! } : null;
  }
  return { tradingsymbol: s, series: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kotak Neo
// ─────────────────────────────────────────────────────────────────────────────

const KOTAK_CASH = new Set(["nse_cm", "bse_cm"]);
/** `cde_fo` (currency) is deliberately ABSENT: `canonicalOpenAlgoSymbol` names
 *  no currency contract (Vyuha has no currency segment vocabulary), so there is
 *  no string to agree with, and a currency option named `OPT USDINR …` would be
 *  priced as a stock option. Such a row is refused. */
const KOTAK_DERIVATIVE = new Set(["nse_fo", "bse_fo", "mcx_fo"]);

export interface KotakTradeFields {
  trdSym: string;
  sym?: string | null;
  exSeg: string;
  optTp?: string | null;
  expDt?: string | null;
  stkPrc?: string | number | null;
}

/**
 * A Kotak Neo trade-book row → its tradingsymbol.
 *
 * Cash (`nse_cm`, `bse_cm`): `trdSym` with the series suffix stripped
 * (`IDEA-EQ` → `IDEA`; review R3 extended).
 *
 * F&O (`nse_fo`, `bse_fo`, `mcx_fo`): the OpenAlgo canonical name, built from
 * the STATED fields — `optTp` `CE`/`PE` → option, `XX` → future (K-S1); `expDt`
 * in a documented form; the strike from `stkPrc` (numbers only). THE
 * UNDERLYING: `sym` when it is ticker-shaped; when `sym` is absent, the leading
 * underlying of `trdSym` ONLY if `trdSym` reads as a compact contract that
 * agrees with every stated field (kind, month, strike, type) — that is the one
 * unambiguous derivation. And a stated `sym` whose `trdSym` reads as a DIFFERENT
 * contract is a contradiction, refused.
 *
 * Null (the caller refuses the row) for anything else — never a guessed contract.
 */
export function kotakTradingsymbol(row: KotakTradeFields): string | null {
  const seg = String(row.exSeg ?? "").trim().toLowerCase();
  const trdSym = String(row.trdSym ?? "").trim().toUpperCase();
  if (KOTAK_CASH.has(seg)) {
    const bare = stripSeriesSuffix(trdSym);
    return bare && /^[A-Z0-9&][A-Z0-9&.-]*$/.test(bare) ? bare : null;
  }
  if (!KOTAK_DERIVATIVE.has(seg)) return null;

  const ot = String(row.optTp ?? "").trim().toUpperCase();
  const kind = ot === "CE" || ot === "PE" ? "option" : ot === "XX" ? "future" : null;
  if (!kind) return null;
  const exp = kotakExpiry(row.expDt);
  if (!exp) return null;
  const strike = kind === "option" ? strikeOf(row.stkPrc) : null;
  if (kind === "option" && strike == null) return null;
  const optionType = kind === "option" ? (ot as "CE" | "PE") : null;

  const facts = compactFacts(trdSym);
  if (facts && !agrees(facts, kind, exp.iso, strike, optionType)) return null;
  const stated = String(row.sym ?? "").trim().toUpperCase();
  let underlying: string | null = null;
  if (stated) {
    if (!isTickerShaped(stated)) return null;
    if (facts && facts.underlying !== stated) return null;
    underlying = stated;
  } else if (facts && isTickerShaped(facts.underlying)) {
    underlying = facts.underlying;
  }
  if (!underlying) return null;
  return canonicalName(kind, underlying, exp, strike, optionType);
}

// ─────────────────────────────────────────────────────────────────────────────
// Nuvama
// ─────────────────────────────────────────────────────────────────────────────

const ISIN_SHAPE = /^IN[EF][A-Z0-9]{8}\d$/;
/** An equity ticker or instrument name: no `_` (so a `7053_NSE` token is not a name). */
const EQUITY_NAME = /^[A-Z0-9&][A-Z0-9&. -]*$/;
/** CDS / BCD / NCDEX are NOT here: `nuvamaUnpricedRow` refuses them first. */
const NUVAMA_DERIVATIVE_EXCHANGES = new Set(["NFO", "BFO", "MCX"]);

export interface NuvamaTradeFields {
  trdSym: string;
  sym?: string | null;
  exc?: string | null;
  opTyp?: string | null;
  stkPrc?: string | null;
  dpExpDt?: string | null;
}

/**
 * A Nuvama trade-book row → the tradingsymbol the Nuvama P&L-report parser
 * stores for the same instrument (every field is a string, N-B4; no real
 * trade-book sample exists — N-S1).
 *
 * DERIVATIVE when `trdSym` is the report's own instrument grammar
 * (`NIFTY-OPT-22Sep2026-PE-23550-NSE`), or `opTyp` is `CE`/`PE`, or `opTyp` is
 * `FUT`/`XX` with an expiry stated, or `exc` is a derivative exchange, or
 * `trdSym` reads as a compact contract. A derivative is named through
 * `nuvamaInstrument` itself — from `trdSym` when it is the report grammar,
 * otherwise from the report grammar rebuilt out of the stated
 * `sym/opTyp/stkPrc/dpExpDt` — so the string is byte-equal to the file's by
 * construction. The underlying is `sym` only when ticker-shaped (`sym` is a
 * TOKEN such as `7053_NSE` in Nuvama's order samples), else `trdSym`'s own
 * compact underlying when that contract agrees with every stated field.
 * Anything that does not parse → null (refused).
 *
 * EQUITY: an ISIN-shaped `trdSym` (`INE…`/`INF…`, 12 characters — N-S1)
 * resolves through the bundled chain (`bundledSymbolByIsin`, as Paytm's codes
 * and the report's equity lines do); when nothing knows it, a NAME the row
 * states in `sym` is used exactly as the report uses its instrument name
 * (v4.7.0 audit M-A2), else the ISIN is KEPT (a visible code is a question; a
 * wrong ticker merges two companies); any
 * other value is the ticker with its series suffix stripped. UNVERIFIED like the
 * report's equity rows (`FYERS_NUVAMA_EQUITY_UNVERIFIED`).
 */
export function nuvamaTradingsymbol(row: NuvamaTradeFields): string | null {
  const trdSym = String(row.trdSym ?? "").trim();
  const upper = trdSym.toUpperCase();
  if (!trdSym) return null;
  // 0. Currency / NCDEX — refused, whatever else the row states (seam D-C6-2).
  if (nuvamaUnpricedRow(row)) return null;

  // 1. The report's own instrument grammar — the file's exact string.
  if (/-(OPT|FUT)-/i.test(trdSym)) {
    const inst = nuvamaInstrument(trdSym, "");
    return inst && inst.kind !== "equity" ? inst.tradingsymbol : null;
  }

  const ot = String(row.opTyp ?? "").trim().toUpperCase();
  const expRaw = String(row.dpExpDt ?? "").trim();
  const exc = String(row.exc ?? "").trim().toUpperCase();
  const facts = compactFacts(upper);
  const derivative =
    ot === "CE" || ot === "PE" || ((ot === "FUT" || ot === "XX") && expRaw !== "") || NUVAMA_DERIVATIVE_EXCHANGES.has(exc) || facts !== null;

  if (!derivative) {
    if (ISIN_SHAPE.test(upper)) {
      // v4.7.0 audit M-A2: the FILE parser names an equity line
      // `bundledSymbolByIsin(isin) ?? <instrument name>`; the pull used to fall
      // back to the ISIN, so an ISIN the snapshot does not know keyed
      // `equity|INE…` here and `equity|<NAME>` from the file — one holding, two
      // keys. When the row states a NAME in `sym` (not a `7053_NSE` token), it
      // is named through `nuvamaInstrument` itself, byte-equal to the file by
      // construction. With no stated name the ISIN is kept (a visible code is a
      // question; a guessed ticker merges two companies).
      const name = String(row.sym ?? "").trim();
      if (EQUITY_NAME.test(name.toUpperCase()) && /[A-Z]/i.test(name)) {
        const inst = nuvamaInstrument(name, upper);
        if (inst && inst.kind === "equity") return inst.tradingsymbol;
      }
      return bundledSymbolByIsin(upper) ?? upper;
    }
    const bare = stripSeriesSuffix(upper);
    return bare && EQUITY_NAME.test(bare) ? bare : null;
  }

  // 2. Rebuilt from the stated fields, then named by the report's own grammar.
  const kind = ot === "CE" || ot === "PE" ? "option" : ot === "FUT" || ot === "XX" ? "future" : null;
  if (!kind) return null;
  const exp = nuvamaExpiry(expRaw);
  if (!exp) return null;
  const strike = kind === "option" ? strikeOf(row.stkPrc) : null;
  if (kind === "option" && strike == null) return null;
  const optionType = kind === "option" ? (ot as "CE" | "PE") : null;
  if (facts && !agrees(facts, kind, exp.iso, strike, optionType)) return null;
  const stated = String(row.sym ?? "").trim().toUpperCase();
  let underlying: string | null = null;
  if (stated && isTickerShaped(stated)) {
    if (facts && facts.underlying !== stated) return null;
    underlying = stated;
  } else if (facts && isTickerShaped(facts.underlying)) {
    underlying = facts.underlying;
  }
  if (!underlying) return null;
  const grammar =
    kind === "option"
      ? `${underlying}-OPT-${exp.dd}${exp.mon}${exp.iso.slice(0, 4)}-${optionType}-${strike}-${exc || "NSE"}`
      : `${underlying}-FUT-${exp.dd}${exp.mon}${exp.iso.slice(0, 4)}-${exc || "NSE"}`;
  const inst = nuvamaInstrument(grammar, "");
  return inst && inst.kind === kind ? inst.tradingsymbol : null;
}
