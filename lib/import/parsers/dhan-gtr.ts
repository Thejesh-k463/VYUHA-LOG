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
 * `01 Jul 2026 00:00:00` → `2026-07-01`.
 *
 * The clock portion is deliberately discarded: it is 00:00:00 on every row of
 * every report, i.e. a settlement stamp rather than a fill time. Keeping it
 * would push the entire book into a fabricated pre-open session.
 */
export function parseGtrDate(raw: string): string | null {
  const m = String(raw).trim().match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase().slice(0, 3)];
  if (!mm) return null;
  const dd = m[1].padStart(2, "0");
  const d = Number(dd);
  if (d < 1 || d > 31) return null;
  return `${m[3]}-${mm}-${dd}`;
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
}

/** Split the file into data rows and the footer totals. Pure string work. */
export function readGtr(text: string): GtrParsed {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => HEADER_RE.test(l));
  const rows: GtrRow[] = [];
  const reported: Record<string, number> = {};

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
    const date = parseGtrDate(c[0] ?? "");
    if (!date || !c[1]) continue;

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

  return { rows, reported };
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

export function parseDhanGtr(ctx: ParseContext): ParsedFile {
  const text = ctx.text ?? ctx.buffer?.toString("utf-8") ?? "";
  const { rows, reported } = readGtr(text);
  const warnings: string[] = [];

  if (rows.length === 0) {
    return { sourceId: "dhan-gtr", broker: "dhan", format: "transactions", trades: [], warnings: ["No transaction rows found."] };
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

  const trades: NormalizedTrade[] = paired.map((p) => {
    const charges = p.charges;
    const fraction = totalCharges > 0 ? charges / totalCharges : 0;
    const grossPnl = p.kind === "closed" ? r2(p.sellValue - p.buyValue) : 0;

    const notes: string[] = [...p.notes];
    if (p.product === "mixed") {
      notes.push("Bill mixed intraday and delivery; product derived from stamp duty.");
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

  // ── Warnings that actually tell the user something ──────────────────────
  warnings.push(
    "Charges are taken from the broker's own per-row figures, not computed — this file states what you were actually charged.",
  );
  if (check.qtyDelta !== 0 || check.valueDelta !== 0) {
    warnings.push(
      `Pairing conservation check FAILED (qty delta ${check.qtyDelta}, value delta ${check.valueDelta}) — please report this file.`,
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
  warnings.push(
    "MTF cannot be identified from this file — an MTF position carries the same STT and stamp duty as delivery, and financing interest is a ledger entry. Confirm any delivery rows that were actually MTF.",
  );

  return {
    sourceId: "dhan-gtr",
    broker: "dhan",
    format: "transactions",
    trades,
    reported,
    warnings,
  };
}
