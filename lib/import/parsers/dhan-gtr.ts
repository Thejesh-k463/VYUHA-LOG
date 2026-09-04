/**
 * Dhan **Global Transaction Report** — one row per scrip per settlement bill.
 *
 * ── Why this file is worth a parser of its own ────────────────────────────
 *
 * Dhan's aggregated P&L report has no per-trade dates and no product column,
 * which is what makes a book built from it largely invisible to every
 * time-series report. The Global Transaction Report has BOTH, plus the actual
 * charges levied per row. It is by some distance the best file Dhan gives a
 * retail trader, and it turns three previously-unanswerable questions into
 * answerable ones:
 *
 *   "when did I trade this?"      → the Date column, per bill
 *   "delivery or intraday?"       → the charge signature (see product-signature)
 *   "what did it actually cost?"  → the broker's own per-row charges
 *
 * ── What it still cannot say ──────────────────────────────────────────────
 *
 * **MTF.** An MTF position attracts exactly the same STT and stamp duty as a
 * delivery position; the only thing that separates them is financing interest,
 * which is a ledger entry and appears nowhere in this file. Verified against a
 * real report: `Oth. Charges` totalled ₹0.03 across 92 rows and GST was 18% of
 * (brokerage + txn + SEBI) to within ₹0.01, leaving no unexplained rupee that
 * financing could be hiding in. So delivery rows are still offered for
 * confirmation — but only the delivery rows, not the whole file.
 *
 * **Execution times.** The Date column reads `01 Jul 2026 00:00:00` for every
 * row. That is a settlement stamp, not a fill time, so `entryTime` stays null
 * and the session analysis correctly shows its empty state rather than
 * bucketing the whole book into 00:00.
 */

import type { ParseContext, ParsedFile } from "../types";
import type { ChargeBreakdown, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import { inferProduct, corroborate, splitMixedRow, productReason } from "../product-signature";
import { pairLegs, summarisePairing, type Leg, type PairedPosition } from "../pair-legs";
import { deriveBasisFromFooter } from "@/lib/analytics/acquisition";
import { parseInstrumentName } from "@/lib/engine/classify";
import { COMMODITY_UNDERLYINGS } from "@/lib/domain/constants";

const COMMODITY_SET = new Set<string>(COMMODITY_UNDERLYINGS);

/**
 * A commodity derivative the report places on a venue other than MCX (the
 * real 2026 report has one: `OPT CRUDEOIL 09 Jun 2026 8000 PE` on NSE — NSE
 * does list crude options).
 *
 * Vyuha's rate table prices commodity segments at MCX only, and carrying
 * "NSE" through used to make the WHOLE import throw at commit
 * (`No charge_config for dhan / default / commodity_option / NSE`). The first
 * fix dropped the hint, which put the row on MCX in the user's own record — a
 * venue the broker never traded it on, contradicting the note beside it. Since
 * v3.8.0 the record keeps the stated venue and `findRates` falls back to the
 * MCX rows for a commodity segment the exchange has no config for: priced at
 * MCX, recorded on NSE. Charges here are the broker's own per-row figures
 * either way — nothing is re-estimated.
 */
function commodityOffMcx(symbol: string, exchange: string | null): boolean {
  if (!exchange || exchange === "MCX") return false;
  const parsed = parseInstrumentName(symbol);
  return parsed.kind !== "equity" && COMMODITY_SET.has(parsed.symbol);
}

const HEADER_RE = /Date\s*,\s*Scrip Name\s*,\s*Exchange\s*,\s*Bill No\./i;

/** Detection: the title line plus the distinctive header. Both, so an ordinary
 *  Dhan P&L export can never be mistaken for this. */
export function detectDhanGtr(ctx: ParseContext): number {
  const t = ctx.text;
  if (!t) return 0;
  const hasHeader = HEADER_RE.test(t);
  const hasTitle = /global\s*transction\s*report|global\s*transaction\s*report/i.test(t);
  if (hasHeader && hasTitle) return 0.98;
  if (hasHeader) return 0.7;
  return 0;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const num = (s: string | undefined): number => {
  const n = Number(String(s ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * `01 Jul 2026 00:00:00` → `2026-07-01`; so do `01-07-2026 00:00` and
 * `01/07/2026`.
 *
 * Dhan has written this column two ways: the 2026-07 exports spelt the month
 * (`dd Mon yyyy HH:MM:SS`), the 2026-09 exports write it numerically
 * (`dd-mm-yyyy HH:MM`). Reading only the first grammar made every row of a
 * real 1,436-line report invisible — the parser returned zero trades under a
 * 0.98 detection (golden-book harness, 2026-09-04). Both grammars are
 * accepted, and the numeric one is read day-FIRST because that is what the
 * report's own title line (`From 01-04-2026 to 04-09-2026`) uses; a month
 * token above 12 is refused rather than swapped, so a US-ordered file can
 * never be silently read backwards.
 *
 * The clock portion is deliberately discarded: it is 00:00 on every row of
 * every report, i.e. a settlement stamp rather than a fill time. Keeping it
 * would push the entire book into a fabricated pre-open session.
 */
export function parseGtrDate(raw: string): string | null {
  const s = String(raw).trim();
  const spelt = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})(?:\s|$)/);
  const numeric = spelt ? null : s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s|$)/);
  if (!spelt && !numeric) return null;
  const mm = spelt ? MONTHS[spelt[2].toLowerCase().slice(0, 3)] : numeric![2].padStart(2, "0");
  if (!mm || Number(mm) < 1 || Number(mm) > 12) return null;
  const dd = (spelt ?? numeric)![1].padStart(2, "0");
  const d = Number(dd);
  if (d < 1 || d > 31) return null;
  return `${(spelt ?? numeric)![3]}-${mm}-${dd}`;
}

export interface GtrRow {
  date: string;
  scrip: string;
  exchange: string;
  bill: string;
  buyQty: number;
  buyValue: number;
  sellQty: number;
  sellValue: number;
  brokerage: number;
  gst: number;
  stt: number;
  sebi: number;
  stamp: number;
  txn: number;
  other: number;
}

export interface GtrParsed {
  rows: GtrRow[];
  reported: Record<string, number>;
  /**
   * Data-shaped lines under the header (a scrip name in column 2) whose date
   * cell no grammar could read — counted and sampled so an empty result can
   * name what it refused instead of reporting "no rows" as if the file were
   * empty. Blank spacer lines and the footer are not counted.
   */
  unparsedDates: { count: number; sample: string | null };
  /**
   * The numeric date grammar both ACCEPTED some cells and REFUSED others in
   * the same file — a month token above 12 next to cells that read cleanly as
   * dd-mm-yyyy. A genuine day-first file can never contain a refused numeric
   * date, so the file is month-first (US-ordered) and every "accepted" cell
   * was read backwards. Reading 68 of 209 lines swapped and skipping the other
   * 141 puts FIFO in the wrong order and dumps the skipped lines' charges on
   * an arbitrary symbol, so the file is refused whole (audit finding 2).
   */
  ambiguousDates: boolean;
}

/** The shape the numeric grammar claims, before range validation. */
const NUMERIC_DATE_RE = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s|$)/;

/** Split the file into data rows and the footer totals. Pure string work. */
export function readGtr(text: string): GtrParsed {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => HEADER_RE.test(l));
  const rows: GtrRow[] = [];
  const reported: Record<string, number> = {};
  const unparsedDates: GtrParsed["unparsedDates"] = { count: 0, sample: null };
  let numericAccepted = 0;
  let numericRefused = 0;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Footer: "Net P&L,-40799.75,Brokerage,4090.02,Gross P&L,...,Total Charges,..."
    if (/^Net P&L\s*,/i.test(line)) {
      const f = splitCsvLine(line);
      for (let k = 0; k + 1 < f.length; k += 2) {
        const key = f[k].toLowerCase();
        const val = num(f[k + 1]);
        if (/net p&l/.test(key)) reported.netPnl = val;
        else if (/gross p&l/.test(key)) reported.grossPnl = val;
        else if (/total charges/.test(key)) reported.totalCharges = val;
        else if (/brokerage/.test(key)) reported.brokerage = val;
      }
      continue;
    }
    if (/^NOTE\s*:/i.test(line)) continue;

    const c = splitCsvLine(line);
    const cell = c[0] ?? "";
    const date = parseGtrDate(cell);
    if (!c[1]) continue;
    // Evidence that the file is month-first is a cell READABLE MONTH-FIRST
    // AND ONLY month-first: second token above 12, first token 12 or under.
    // `parseGtrDate` also refuses a day above 31 (`32-01-2026`) and a cell no
    // order can read (`13-13-2026`, `45-13-2026`); counting either as
    // ambiguity refused a whole clean dd-mm file over one corrupt cell — with
    // a warning that claimed the file was month-first. Such a cell takes the
    // ordinary skip path; its charges are covered by the fold cap below.
    const nm = NUMERIC_DATE_RE.exec(cell);
    if (nm) {
      if (date) numericAccepted++;
      else if (Number(nm[2]) > 12 && Number(nm[1]) <= 12) numericRefused++;
    }
    if (!date) {
      unparsedDates.count++;
      unparsedDates.sample ??= c[0] ?? "";
      continue;
    }

    rows.push({
      date,
      scrip: c[1],
      exchange: (c[2] || "NSE").toUpperCase(),
      bill: c[3] ?? "",
      buyQty: num(c[4]), buyValue: num(c[5]),
      sellQty: num(c[6]), sellValue: num(c[7]),
      brokerage: num(c[8]), gst: num(c[9]), stt: num(c[10]),
      sebi: num(c[11]), stamp: num(c[12]), txn: num(c[13]), other: num(c[14]),
    });
  }

  // A day-first file never refuses a numeric date; a month-first one refuses
  // every row whose day is above 12 and reads the rest swapped. Mixed verdicts
  // therefore mean the file's order is unknown, and half a book read backwards
  // is worse than no book.
  if (numericAccepted > 0 && numericRefused > 0) {
    return { rows: [], reported, unparsedDates, ambiguousDates: true };
  }

  return { rows, reported, unparsedDates, ambiguousDates: false };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function rowCharges(r: GtrRow): number {
  return r2(r.brokerage + r.gst + r.stt + r.sebi + r.stamp + r.txn + r.other);
}

/**
 * Apportion a row's charges between its buy and sell legs.
 *
 * The file states one charge figure per bill row, but the row may hold both a
 * buy and a sell. Splitting by traded value is the only defensible rule
 * available — the alternative, assigning everything to one leg, would distort
 * whichever position that leg ends up in.
 */
function apportion(r: GtrRow): { buy: number; sell: number } {
  const total = rowCharges(r);
  const denom = r.buyValue + r.sellValue;
  if (denom <= 0) return { buy: 0, sell: 0 };
  const buy = r2((total * r.buyValue) / denom);
  return { buy, sell: r2(total - buy) };
}

/** Turn a bill row into up to two dated legs. */
export function rowToLegs(r: GtrRow): Leg[] {
  const verdict = inferProduct({ buyValue: r.buyValue, sellValue: r.sellValue, stt: r.stt, stampDuty: r.stamp });
  const ok = corroborate({ buyValue: r.buyValue, sellValue: r.sellValue, stt: r.stt, stampDuty: r.stamp }, verdict);
  const note = productReason(verdict, ok);
  const { buy, sell } = apportion(r);
  const out: Leg[] = [];

  if (r.buyQty > 0) {
    out.push({
      symbol: r.scrip, side: "buy", date: r.date, qty: r.buyQty, value: r.buyValue,
      charges: buy, exchange: r.exchange, product: verdict, note,
    });
  }
  if (r.sellQty > 0) {
    out.push({
      symbol: r.scrip, side: "sell", date: r.date, qty: r.sellQty, value: r.sellValue,
      charges: sell, exchange: r.exchange, product: verdict, note,
    });
  }
  return out;
}

/**
 * Reconstruct a row's charge breakdown for a position that took a share of it.
 * Components are apportioned by the same fraction, so the parts always add
 * back to the broker's stated total.
 */
function breakdownFor(rows: GtrRow[], fraction: number): Partial<ChargeBreakdown> {
  const sum = rows.reduce(
    (a, r) => ({
      brokerage: a.brokerage + r.brokerage, gst: a.gst + r.gst, sttCtt: a.sttCtt + r.stt,
      sebi: a.sebi + r.sebi, stampDuty: a.stampDuty + r.stamp, exchangeTxn: a.exchangeTxn + r.txn,
    }),
    { brokerage: 0, gst: 0, sttCtt: 0, sebi: 0, stampDuty: 0, exchangeTxn: 0 },
  );
  const f = fraction;
  const b = {
    brokerage: r2(sum.brokerage * f), gst: r2(sum.gst * f), sttCtt: r2(sum.sttCtt * f),
    sebi: r2(sum.sebi * f), stampDuty: r2(sum.stampDuty * f), exchangeTxn: r2(sum.exchangeTxn * f),
    ipft: 0, dpCharges: 0, mtfInterest: 0, pledgeCharges: 0,
  };
  return { ...b, total: r2(b.brokerage + b.gst + b.sttCtt + b.sebi + b.stampDuty + b.exchangeTxn) };
}

const toHint = (p: PairedPosition["product"]): ProductHint =>
  p === "intraday" ? "intraday" : "delivery";

/** Record an off-MCX commodity contract for the file-level warning; returns the flag unchanged. */
function venueOffMcx(flag: boolean, p: PairedPosition, sink: string[]): boolean {
  if (flag) sink.push(`${p.symbol} (${p.exchange})`);
  return flag;
}

export function parseDhanGtr(ctx: ParseContext): ParsedFile {
  const text = ctx.text ?? ctx.buffer?.toString("utf-8") ?? "";
  const { rows, reported, unparsedDates, ambiguousDates } = readGtr(text);
  const warnings: string[] = [];

  if (rows.length === 0) {
    // A detected GTR that yields nothing is a parser gap until proven
    // otherwise, so the warning names the date cell it could not read — the
    // one fact that turns "no rows" into a bug report someone can act on.
    const why = ambiguousDates
      ? `Nothing was imported: this report's dates are ambiguous. ${unparsedDates.count} line${unparsedDates.count === 1 ? "" : "s"} carr${unparsedDates.count === 1 ? "ies" : "y"} a numeric date whose month token is above 12 (first sample: "${unparsedDates.sample}") while other lines read cleanly as dd-mm-yyyy, so the file is written month-first and every date Vyuha could read would be read backwards. Vyuha will not import half a book in the wrong order — please report this file so the grammar can be extended.`
      : unparsedDates.count > 0
        ? `No transaction rows could be read: ${unparsedDates.count} line${unparsedDates.count === 1 ? "" : "s"} under the header carr${unparsedDates.count === 1 ? "ies" : "y"} a date Vyuha does not recognise (first sample: "${unparsedDates.sample}"). Supported forms are dd Mon yyyy, dd-mm-yyyy and dd/mm/yyyy — please report this file so the grammar can be extended.`
        : "No transaction rows found under the header — the report window may be empty.";
    return { sourceId: "dhan-gtr", broker: "dhan", format: "transactions", trades: [], warnings: [why] };
  }
  if (unparsedDates.count > 0) {
    warnings.push(
      `${unparsedDates.count} line${unparsedDates.count === 1 ? "" : "s"} skipped: date not recognised (first sample: "${unparsedDates.sample}").`,
    );
  }

  // ── Mixed rows: one bill holding both an intraday and a delivery portion.
  const mixedNotes: string[] = [];
  for (const r of rows) {
    const v = inferProduct({ buyValue: r.buyValue, sellValue: r.sellValue, stt: r.stt, stampDuty: r.stamp });
    if (v !== "mixed") continue;
    const split = splitMixedRow({ buyValue: r.buyValue, sellValue: r.sellValue, stt: r.stt, stampDuty: r.stamp });
    if (split) {
      mixedNotes.push(
        `${r.scrip} on ${r.date}: ~${Math.round(split.deliveryFraction * 100)}% carried overnight, the rest squared off the same day (derived from stamp duty).`,
      );
    }
  }

  const legs = rows.flatMap(rowToLegs);
  const paired = pairLegs(legs);
  const check = summarisePairing(legs, paired);

  /**
   * Cost recovered from the footer for a lone unmatched holding, if any.
   *
   * Derived BEFORE the trades are built, because the suggestion has to travel
   * on the trade it belongs to — computing it later would leave the field null
   * and the recovery would exist only in a warning nobody can act on.
   */
  const orphans = paired.filter((p) => p.kind === "opening-sell");
  const matchedGross = paired
    .filter((p) => p.kind === "closed")
    .reduce((s, p) => s + (p.sellValue - p.buyValue), 0);
  const derived = deriveBasisFromFooter(reported.grossPnl, r2(matchedGross), orphans);
  const suggestedBasis =
    derived?.exact && derived.pricePerShare != null && orphans[0]
      ? { symbol: orphans[0].symbol, pricePerShare: derived.pricePerShare, cost: derived.impliedCost }
      : null;

  // Charge components, apportioned to each position by its share of the book.
  const totalCharges = rows.reduce((s, r) => s + rowCharges(r), 0);

  const offMcx: string[] = [];
  const trades: NormalizedTrade[] = paired.map((p) => {
    const charges = p.charges;
    const fraction = totalCharges > 0 ? charges / totalCharges : 0;
    const grossPnl = p.kind === "closed" ? r2(p.sellValue - p.buyValue) : 0;

    const notes: string[] = [...p.notes];
    if (p.product === "mixed") {
      notes.push("Bill mixed intraday and delivery; product derived from stamp duty.");
    }
    const venueOverridden = commodityOffMcx(p.symbol, p.exchange);
    if (venueOffMcx(venueOverridden, p, offMcx)) {
      notes.push(
        `Recorded on ${p.exchange}, the venue the report states; priced with Vyuha's MCX commodity rates, because the rate table carries commodity rows for MCX only. Charges are the broker's own figures for this row, not re-estimated.`,
      );
    }

    return {
      broker: "dhan",
      tradingsymbol: p.symbol,
      isin: null,
      buyQty: p.buyQty,
      avgBuyPrice: p.buyQty > 0 ? r2(p.buyValue / p.buyQty) : 0,
      buyValue: p.buyValue,
      sellQty: p.sellQty,
      avgSellPrice: p.sellQty > 0 ? r2(p.sellValue / p.sellQty) : 0,
      sellValue: p.sellValue,
      closingPrice: null,
      grossPnl,
      unrealisedPnl: 0,
      buyDate: p.buyDate,
      sellDate: p.sellDate,
      productHint: toHint(p.product),
      // The stated venue is kept even for a commodity contract off MCX — the
      // rate lookup falls back to the MCX rows rather than the record bending.
      exchangeHint: (p.exchange as Exchange | null) ?? null,
      sourceFile: ctx.filename,
      // Settlement stamps, not fill times — see the header note.
      entryTime: null,
      exitTime: null,
      reportedCharges: breakdownFor(rows, fraction),
      basisUnknown: p.basisUnknown,
      // A derived suggestion, never applied silently — the user confirms it.
      suggestedBasisPrice:
        p.basisUnknown && suggestedBasis?.symbol === p.symbol ? suggestedBasis.pricePerShare : null,
      productDerived: p.product !== "unknown",
      importNotes: notes.length ? notes : null,
    };
  });

  // ── Conserve the book's charges to the footer's Total Charges ────────────
  // Two paise-level gaps sit between Σ per-position charges and the footer:
  // apportioning a bill's charges across its legs rounds each share to the
  // paisa (measured +₹0.07 / −₹0.07 over the two real 2026 reports), and the
  // footer itself is stated to four decimals while the rows carry two (its
  // rounded value differs from Σ rows by ₹0.02 / −₹0.05). Neither is money;
  // both would make the journal disagree with the broker's own total by a
  // few paise, so the residual is handed to the last position and said so —
  // the way the Paytm parser's residual slice works.
  //
  // The fold is CAPPED at the rounding it exists to absorb — `summarisePairing`
  // already derives that ceiling (N positions × 1 paisa, floor ₹0.05). Above
  // the cap the difference is not rounding: the footer covers every line in the
  // file, `given` only the lines that became trades, so a skipped line would
  // otherwise dump its whole charge bill on whichever symbol happens to be last
  // and call it "rounding" (one 13-13-2026 line moved ₹238.87 onto an unrelated
  // scrip — audit finding 1). Then Vyuha says so and leaves every position's
  // charges exactly as the report states them.
  const statedTotal = reported.totalCharges != null ? r2(reported.totalCharges) : r2(totalCharges);
  const given = r2(trades.reduce((s, t) => s + (t.reportedCharges?.total ?? 0), 0));
  const residual = r2(statedTotal - given);
  const foldCap = check.valueTolerance;
  const last = trades[trades.length - 1];
  if (residual !== 0 && Math.abs(residual) > foldCap) {
    warnings.push(
      unparsedDates.count > 0
        ? `₹${Math.abs(residual).toFixed(2)} of the footer's charges belong to ${unparsedDates.count} skipped line${unparsedDates.count === 1 ? "" : "s"} — more than the ₹${foldCap.toFixed(2)} this file's rounding can explain, so it was NOT folded into any position. Every position keeps the charges the report states for it, and the book's charges total ₹${given.toLocaleString("en-IN")} against the footer's ₹${statedTotal.toLocaleString("en-IN")}.`
        : `The footer's Total Charges (₹${statedTotal.toLocaleString("en-IN")}) differ from the positions' own charges (₹${given.toLocaleString("en-IN")}) by ₹${Math.abs(residual).toFixed(2)} — more than the ₹${foldCap.toFixed(2)} rounding tolerance, so nothing was folded and each position keeps the report's own figures. Please report this file.`,
    );
  } else if (residual !== 0 && last?.reportedCharges) {
    const b = last.reportedCharges;
    type Head = "brokerage" | "gst" | "sttCtt" | "exchangeTxn" | "stampDuty" | "sebi";
    const head = (["brokerage", "gst", "sttCtt", "exchangeTxn", "stampDuty", "sebi"] as Head[])
      .reduce((best, k) => ((b[k] ?? 0) > (b[best] ?? 0) ? k : best));
    b[head] = r2((b[head] ?? 0) + residual);
    b.total = r2((b.total ?? 0) + residual);
    last.importNotes = [
      ...(last.importNotes ?? []),
      `Carries ₹${residual.toFixed(2)} of rounding so the book's charges equal the report's Total Charges (₹${statedTotal.toLocaleString("en-IN")}) to the paisa: per-bill charges are apportioned to the paisa, and the footer is stated to four decimals.`,
    ];
  }

  // ── Warnings that actually tell the user something ──────────────────────
  warnings.push(
    "Charges are taken from the broker's own per-row figures, not computed — this file states what you were actually charged.",
  );
  if (!check.conserved) {
    warnings.push(
      `Pairing conservation check FAILED (qty delta ${check.qtyDelta}, value delta ${check.valueDelta} against a ${check.valueTolerance} rounding tolerance) — please report this file.`,
    );
  }
  if (check.openingSells > 0) {
    warnings.push(
      `${check.openingSells} holding${check.openingSells === 1 ? " was" : "s were"} sold without a matching purchase in this window — acquired earlier, often an IPO allotment. Cost basis is unknown until you set it, and they are excluded from win rate and expectancy meanwhile.`,
    );

    // The rows do not state the purchase, but the FOOTER does implicitly: the
    // broker's own gross P&L includes these trades. Subtracting what we could
    // match recovers what they must have cost.
    if (derived?.exact && derived.pricePerShare != null && suggestedBasis) {
      const o = orphans[0];
      warnings.push(
        `Vyuha recovered the missing cost for ${o.symbol} from the report's own footer: ₹${derived.impliedCost.toLocaleString("en-IN")} for ${o.sellQty} shares, about ₹${derived.pricePerShare} each. The broker's gross P&L includes this trade even though the rows do not, so the difference is its cost. Confirm it on the trade before it counts toward your edge.`,
      );
    } else if (derived) {
      warnings.push(
        `Those holdings cost about ₹${derived.impliedCost.toLocaleString("en-IN")} in total, derived from the footer's gross P&L. Vyuha will not split that across ${orphans.length} different stocks — set each one's cost yourself.`,
      );
    }
  }
  if (mixedNotes.length > 0) {
    warnings.push(
      `${mixedNotes.length} bill${mixedNotes.length === 1 ? "" : "s"} mixed intraday and delivery in one row; the split was derived from stamp duty: ${mixedNotes.slice(0, 3).join(" ")}`,
    );
  }
  if (offMcx.length > 0) {
    warnings.push(
      `${offMcx.length} commodity contract${offMcx.length === 1 ? "" : "s"} the report places off MCX ${offMcx.length === 1 ? "is" : "are"} recorded on the stated exchange and priced with Vyuha's MCX commodity rates (the rate table carries commodity rows for MCX only; the broker's own charges are kept): ${offMcx.slice(0, 3).join("; ")}.`,
    );
  }
  warnings.push(
    "MTF cannot be identified from this file — an MTF position carries the same STT and stamp duty as delivery, and financing interest is a ledger entry. Confirm any delivery rows that were actually MTF.",
  );

  return {
    sourceId: "dhan-gtr",
    broker: "dhan",
    format: "transactions",
    trades,
    reported,
    // Bill lines as read, BEFORE pairing — so the UI can say
    // "92 lines → 73 trades" instead of a count that looks like loss.
    sourceRows: rows.length,
    warnings,
  };
}
