/**
 * Paytm Money **Tradebook** (XLSX) — per execution, WITH per-trade charges.
 *
 * ── Provenance (docs/BROKER_FORMATS.md, 2026-08-12) ─────────────────────────
 *
 * Layout VERIFIED against a real export: four metadata rows (`UCC`, `Name`,
 * `PAN Number`, `Period`), the header on row 5, then one row per execution
 * with a full charge breakdown — Brokerage, ETT, GST, STT, SEBI, Stamp Duty.
 * That makes it the richest tradebook of the brokers examined: Zerodha's has
 * granularity but no charges; Dhan's GTR has charges but only bill-level
 * granularity.
 *
 * AGENTS.md forbids inventing a parser for an unpublished format — that rule
 * existed because Paytm documents these columns nowhere. It is deliberately
 * set aside here because a REAL export now pins the layout; the deviation is
 * recorded in docs/DECISIONS.md (2026-08-12).
 *
 * Fingerprints (in-content, both verified): the `UCC` metadata label above
 * the table, and the `Script` (sic) + `ETT` header pair — Paytm's own
 * vocabulary, used by no other broker examined.
 *
 * ── What a real 414-execution export taught us (2026-08-20) ─────────────────
 *
 * The first version of this parser aggregated the WHOLE file per Script and
 * reported `sellValue − buyValue` as P&L. On a real book that produced
 * ₹2.17 Cr of P&L that never happened: nine scrips were sold without a buy in
 * the window (an aggregate-only reading calls that a 100% gain) and eighteen
 * more were unbalanced. It is now paired FIFO, exactly like the Groww order
 * history and the Dhan GTR, and P&L exists only for a position that actually
 * closed.
 *
 * Three further facts, all verified against that export:
 *
 *   - **`Script` is a numeric SCRIP CODE**, not a ticker (`216463`). The ISIN
 *     is on every row, so the ticker is RESOLVED from it at import time
 *     (lib/import/isin-symbol.ts) rather than guessed here.
 *   - **`Product Type` is the SEGMENT, not the product.** It reads `EQ` on
 *     every single row. Delivery vs intraday is therefore derived from the
 *     charge signature (lib/import/product-signature.ts) — and only the
 *     column saying something *else* (MTF, intraday, CNC) overrides it.
 *   - **STT and stamp duty are booked once per SCRIP-DAY**, on one execution
 *     row of that day, not spread across the fills. Four buys of one scrip on
 *     one day carry STT `0 / 0 / 0 / 1960.08`, where 1960.08 is 0.1% of that
 *     day's whole buy value. So the product signature only exists at
 *     scrip-day granularity, which is exactly how it is read below.
 *
 * `Trade Time` is empty exactly on the rows whose `Trade Number` is `0` (all
 * 414 of that export; 1,856 of 7,544 in a 2026 one) and carries a clock on the
 * rest — so execution times are null where the file has none, the honest
 * answer, and the reason the session analytics show their empty state instead
 * of a fabricated 00:00.
 *
 * ── What a 7,544-execution export taught us (2026-09-04) ────────────────────
 *
 *   - **`Script` switches label mid-window.** The same security is a ticker
 *     (`HVAX`) until June and a numeric BSE code from July; 35 of 281 ISINs
 *     were seen under BOTH. Keyed on `Script`, each such security became two
 *     books — the ticker's buys "open" forever, the code's sells "opening
 *     sells" with no cost. Fills are therefore paired on ISIN (`Script` only
 *     when a row has no ISIN — none did), and the displayed symbol is the
 *     first non-numeric label the file uses for that ISIN.
 *   - **A same-day round trip is not always intraday.** 49 of 83 were genuine
 *     CNC delivery by Paytm's own charges (stamp 0.015% on the buy, STT 0.1%
 *     of buy PLUS sell); 34 were intraday, and a scrip-day whose stamp duty
 *     sits between the two rates is part-and-part — those are split by
 *     `splitMixedRow` into an intraday pair and a delivery remainder.
 */

import * as XLSX from "xlsx";
import Papa from "papaparse";
import type { ChargeBreakdown, Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import { relabelledNote } from "@/lib/domain/import-shape";
import type { ParseContext, ParsedFile } from "../types";
import { extractTime } from "../time-parse";
import { corroborate, inferProduct, productReason, splitMixedRow } from "../product-signature";
import { pairLegs, summarisePairing, type Leg, type PairedPosition } from "../pair-legs";

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[\s_.]/g, "");

const toNum = (v: unknown): number => {
  const x = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

function toMatrix(ctx: ParseContext): string[][] {
  if (ctx.text != null) {
    return (Papa.parse<string[]>(ctx.text, { skipEmptyLines: true }).data ?? []).map((r) =>
      r.map((c) => String(c ?? "")),
    );
  }
  if (!ctx.buffer) return [];
  try {
    const wb = XLSX.read(ctx.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]!];
    if (!ws) return [];
    return (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" }) as unknown[][]).map(
      (r) => r.map((c) => String(c ?? "")),
    );
  } catch {
    return [];
  }
}

/** The header row: Paytm's `Script` (sic) and `ETT` together. */
function findHeader(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = rows[i].map(norm);
    if (cells.includes("script") && cells.includes("ett")) return i;
  }
  return -1;
}

function hasUccLabel(rows: string[][]): boolean {
  return rows.slice(0, 8).some((r) => norm(r[0]) === "ucc");
}

export function detectPaytmTradebook(ctx: ParseContext): number {
  const rows = toMatrix(ctx);
  const h = findHeader(rows);
  if (h < 0) return 0; // without Paytm's own header this parser cannot read it
  const named = /paytm/i.test(ctx.filename);
  const ucc = hasUccLabel(rows);
  if (!named && !ucc) return 0; // No name, no fingerprint, no claim.
  let score = 0.35; // the Script+ETT pair, counted only after qualification
  if (ucc) score += 0.4;
  if (named) score += 0.2;
  return Math.min(1, score);
}

const MONTH_NO: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function flexDate(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})/);
  if (m) {
    const mm = MONTH_NO[m[2].toLowerCase().slice(0, 3)];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

/**
 * The `Product Type` column, read ONLY for a real product word.
 *
 * On the verified export this column says `EQ` on every row — a SEGMENT, not a
 * product. Segment words therefore fall through to null ("not stated") and the
 * charge signature decides. A column that does name a product (MTF, Intraday,
 * CNC) still wins over inference, because a stated fact beats a derived one.
 */
function productHint(raw: string): ProductHint {
  const s = norm(raw);
  if (!s) return null;
  // MTF first: normalised "margintradefunding" CONTAINS "intra"
  // (marg-intra-defunding), so testing intraday first mis-tagged funded
  // positions as intraday — caught by the synthetic-row test.
  if (/mtf|margin/.test(s)) return "mtf";
  if (/^intra|intraday|mis/.test(s)) return "intraday";
  if (/del|cnc/.test(s)) return "delivery";
  return null;
}

function exchangeFrom(raw: string): Exchange | null {
  const s = norm(raw);
  if (s.startsWith("mcx")) return "MCX";
  if (s.startsWith("bse")) return "BSE";
  if (s.startsWith("nse")) return "NSE";
  return null;
}

/**
 * Pairing groups are keyed by SECURITY and stated product, so an MTF position
 * and a cash position in the same scrip never pair into one trade. NUL is
 * used because no broker symbol or product word can contain it.
 *
 * The security half is the ISIN when the row has one, else the `Script`
 * label: Paytm relabels a security mid-window (ticker → numeric BSE code), and
 * only the ISIN stays constant through that. ISIN + Exchange was measured on
 * the 7,544-row book and REJECTED (101 opening sells against 38): a holding
 * bought on NSE and sold on BSE is one position, not a purchase with no sale
 * plus a sale with no purchase — the exchange is where a fill happened, not
 * what was held.
 */
const SEP = "\u0000";
const isCode = (s: string) => /^\d+$/.test(s);
const groupKey = (security: string, hint: ProductHint) => `${security}${SEP}${hint ?? "-"}`;
const splitKey = (key: string): { security: string; hint: ProductHint } => {
  const [security, h] = key.split(SEP);
  return { security, hint: h === "-" ? null : (h as ProductHint) };
};

/** dhan-gtr's rule: a paired position that is not intraday is delivery. */
const toHint = (p: PairedPosition["product"]): ProductHint => (p === "intraday" ? "intraday" : "delivery");

/** One execution row, after it has been read and accepted. */
interface Fill {
  key: string; // security (ISIN, else Script) + stated product
  symbol: string; // the row's own Script label, as printed
  isin: string | null;
  exchange: Exchange | null;
  side: "buy" | "sell";
  date: string;
  qty: number;
  price: number;
  time: string | null;
  charges: number;
  stt: number;
  stamp: number;
}

interface Components {
  brokerage: number;
  exchangeTxn: number;
  gst: number;
  sttCtt: number;
  sebi: number;
  stampDuty: number;
}

const zeroComponents = (): Components => ({
  brokerage: 0, exchangeTxn: 0, gst: 0, sttCtt: 0, sebi: 0, stampDuty: 0,
});

/**
 * A position's slice of the file's charges.
 *
 * The file states charges per execution, but FIFO pairing moves value between
 * positions, so a position's charge total is a share of the whole rather than
 * a set of rows. Apportioning every component by the SAME fraction keeps the
 * parts adding back to the broker's own totals.
 */
function breakdownFor(total: Components, fraction: number): Partial<ChargeBreakdown> {
  const b = {
    brokerage: r2(total.brokerage * fraction),
    exchangeTxn: r2(total.exchangeTxn * fraction),
    gst: r2(total.gst * fraction),
    sttCtt: r2(total.sttCtt * fraction),
    sebi: r2(total.sebi * fraction),
    stampDuty: r2(total.stampDuty * fraction),
    ipft: 0, dpCharges: 0, mtfInterest: 0, pledgeCharges: 0,
  };
  return {
    ...b,
    total: r2(b.brokerage + b.exchangeTxn + b.gst + b.sttCtt + b.sebi + b.stampDuty),
  };
}

export function parsePaytmTradebook(ctx: ParseContext): ParsedFile {
  const rows = toMatrix(ctx);
  const h = findHeader(rows);
  if (h < 0) {
    return {
      sourceId: "paytm-tradebook", broker: "paytm", format: "tradebook", trades: [],
      warnings: ["Could not find the tradebook header row in this Paytm Money file."],
    };
  }

  const idx = rows[h].map(norm);
  const col = (name: string) => idx.indexOf(norm(name));
  const cDate = col("Date"), cScript = col("Script"), cIsin = col("ISIN"), cExch = col("Exchange");
  const cProduct = col("Product Type"), cType = col("Type"), cQty = col("Quantity"), cPrice = col("Price");
  const cBrok = col("Brokerage"), cEtt = col("ETT"), cGst = col("GST"), cStt = col("STT");
  const cSebi = col("SEBI"), cStamp = col("Stamp Duty"), cTime = col("Trade Time");

  const dataRows = rows.slice(h + 1).filter((r) => r.some((c) => c.trim() !== ""));
  const warnings: string[] = [];
  const unreadable: string[] = [];

  // ── Pass 1: read every execution row, refusing rather than coercing ───────
  const fills: Fill[] = [];
  const isinOf = new Map<string, string | null>();
  /** Every `Script` label the file used for an ISIN — two means it relabelled. */
  const labelsOf = new Map<string, Set<string>>();
  /** Security → the label shown: the first NON-numeric one seen anywhere in
   *  the file, else the first code. Commit still resolves a code via ISIN. */
  const displayOf = new Map<string, string>();
  const fileTotals = zeroComponents();

  for (const r of dataRows) {
    const symbol = (r[cScript] ?? "").trim();
    if (!symbol) continue;
    const isin = cIsin >= 0 ? (r[cIsin] ?? "").trim().toUpperCase() || null : null;
    const security = isin ?? symbol;
    const shown = displayOf.get(security);
    if (shown == null || (isCode(shown) && !isCode(symbol))) displayOf.set(security, symbol);
    if (isin) {
      const set = labelsOf.get(isin) ?? new Set<string>();
      set.add(symbol);
      labelsOf.set(isin, set);
    }

    const qty = toNum(r[cQty]);
    const price = toNum(r[cPrice]);
    const rawSide = norm(cType >= 0 ? r[cType] : "");
    const side = rawSide.startsWith("b") ? "buy" : rawSide.startsWith("s") ? "sell" : null;
    const date = flexDate(cDate >= 0 ? r[cDate] : "");
    // Refuse rather than coerce — a zero-share, priceless or undated execution
    // is not a trade, and FIFO pairing cannot place a row it cannot date.
    if (!side || qty <= 0 || price <= 0 || !date) {
      unreadable.push(symbol);
      continue;
    }

    const hint = productHint(cProduct >= 0 ? r[cProduct] : "");
    const key = groupKey(security, hint);
    if (!isinOf.has(key)) isinOf.set(key, isin);

    const c: Components = {
      brokerage: toNum(r[cBrok]),
      exchangeTxn: toNum(r[cEtt]), // ETT = exchange transaction charge
      gst: toNum(r[cGst]),
      sttCtt: toNum(r[cStt]),
      sebi: toNum(r[cSebi]),
      stampDuty: toNum(r[cStamp]),
    };
    for (const k of Object.keys(fileTotals) as (keyof Components)[]) fileTotals[k] += c[k];

    fills.push({
      key, symbol, isin,
      exchange: exchangeFrom(cExch >= 0 ? r[cExch] : ""),
      side, date, qty, price,
      time: extractTime(cTime >= 0 ? r[cTime] : null),
      charges: c.brokerage + c.exchangeTxn + c.gst + c.sttCtt + c.sebi + c.stampDuty,
      stt: c.sttCtt,
      stamp: c.stampDuty,
    });
  }

  // ── Pass 2: one signature per SCRIP-DAY, because that is where Paytm books
  //    the statutory charges — see the header note.
  interface DayAcc {
    key: string; date: string; exchange: Exchange | null;
    buyQty: number; buyValue: number; sellQty: number; sellValue: number;
    charges: number; stt: number; stamp: number;
  }
  const days = new Map<string, DayAcc>();
  for (const f of fills) {
    const dk = `${f.key}${SEP}${f.date}`;
    const a = days.get(dk) ?? {
      key: f.key, date: f.date, exchange: f.exchange,
      buyQty: 0, buyValue: 0, sellQty: 0, sellValue: 0, charges: 0, stt: 0, stamp: 0,
    };
    if (f.side === "buy") { a.buyQty += f.qty; a.buyValue += f.qty * f.price; }
    else { a.sellQty += f.qty; a.sellValue += f.qty * f.price; }
    a.charges += f.charges;
    a.stt += f.stt;
    a.stamp += f.stamp;
    if (!a.exchange && f.exchange) a.exchange = f.exchange;
    days.set(dk, a);
  }

  // ── Pass 3: legs per scrip-day-side, charges split by traded value ────────
  //
  // Usually two legs (buy, sell). A MIXED scrip-day — stamp duty between the
  // intraday and delivery rates, i.e. part of the buy squared off the same day
  // and part carried — becomes FOUR: an intraday buy+sell pair and a delivery
  // buy (+ any sell beyond the intraday quantity). The intraday legs are
  // pushed FIRST so pairLegs' same-day rule consumes them before the delivery
  // lot (the sort is stable and keeps push order within a date and side).
  //
  // Quantity rounding rule: the DELIVERY buy quantity is the day's buy
  // quantity × deliveryFraction rounded to the nearest whole share (ties up);
  // the intraday quantity is the remainder, capped at the day's sold
  // quantity so an intraday leg never exceeds what was actually sold. Values
  // follow the day's average prices; the day's charges are shared by value
  // with the last leg taking the rounding remainder, so nothing is lost.
  const legs: Leg[] = [];
  /** Per scrip-day notes (split / corroboration), keyed like `days`. */
  const dayNotes = new Map<string, string>();
  let splitDays = 0;
  let sameDayDelivery = 0;

  for (const a of days.values()) {
    const sig = { buyValue: a.buyValue, sellValue: a.sellValue, stt: a.stt, stampDuty: a.stamp };
    const verdict = inferProduct(sig);
    const dk = `${a.key}${SEP}${a.date}`;
    const twoSided = a.buyQty > 0 && a.sellQty > 0;
    const denom = a.buyValue + a.sellValue;

    /** Push legs in order, charges by value share, remainder on the last. */
    const pushLegs = (parts: { side: "buy" | "sell"; qty: number; value: number; product: Leg["product"] }[]) => {
      const live = parts.filter((x) => x.qty > 0);
      let given = 0;
      live.forEach((x, i) => {
        const last = i === live.length - 1;
        const charges = denom <= 0 ? 0 : last ? r2(a.charges - given) : r2((a.charges * x.value) / denom);
        given += charges;
        legs.push({
          symbol: a.key, side: x.side, date: a.date, qty: x.qty, value: r2(x.value),
          charges, exchange: a.exchange, product: x.product,
        });
      });
    };

    if (verdict === "mixed" && twoSided) {
      const split = splitMixedRow(sig);
      if (split) {
        const deliveryBuyQty = Math.round(a.buyQty * split.deliveryFraction);
        const iq = Math.min(a.buyQty - deliveryBuyQty, a.sellQty);
        if (iq > 0) {
          const avgBuy = a.buyValue / a.buyQty;
          const avgSell = a.sellValue / a.sellQty;
          const ibv = r2(avgBuy * iq);
          const isv = r2(avgSell * iq);
          pushLegs([
            { side: "buy", qty: iq, value: ibv, product: "intraday" },
            { side: "buy", qty: a.buyQty - iq, value: r2(a.buyValue - ibv), product: "delivery" },
            { side: "sell", qty: iq, value: isv, product: "intraday" },
            { side: "sell", qty: a.sellQty - iq, value: r2(a.sellValue - isv), product: "delivery" },
          ]);
          dayNotes.set(
            dk,
            `${a.date}: ${iq} of ${a.buyQty} bought were squared off the same day and ${a.buyQty - iq} carried — split derived from Paytm's own stamp duty (~${Math.round(split.deliveryFraction * 100)}% delivery).`,
          );
          splitDays++;
          continue;
        }
      }
      dayNotes.set(
        dk,
        `${a.date}: stamp duty sits between the intraday and delivery rates but admits no clean split — shown as delivery, please confirm.`,
      );
    } else if (verdict === "delivery" && twoSided) {
      // A same-day round trip that Paytm charged as CNC delivery. Recorded the
      // way dhan-gtr does — verdict plus whether STT corroborates it — so the
      // trade says why it is not intraday.
      const ok = corroborate(sig, verdict);
      dayNotes.set(dk, `${a.date}: bought and sold the same day but held as delivery — ${productReason(verdict, ok)}.`);
      sameDayDelivery++;
    }

    pushLegs([
      { side: "buy", qty: a.buyQty, value: a.buyValue, product: verdict },
      { side: "sell", qty: a.sellQty, value: a.sellValue, product: verdict },
    ]);
  }

  const paired = pairLegs(legs);
  const check = summarisePairing(legs, paired);

  const totalCharges = fileTotals.brokerage + fileTotals.exchangeTxn + fileTotals.gst +
    fileTotals.sttCtt + fileTotals.sebi + fileTotals.stampDuty;
  const pairedCharges = paired.reduce((s, p) => s + p.charges, 0);

  // ── Charge slices, conserved to the paisa ─────────────────────────────────
  // Each position's slice is its share of the book (see below); rounding every
  // slice to 2 dp leaves Σ slices short or over by up to N × ½ paisa per
  // component. The remainder is handed to the largest slice so the parts add
  // back EXACTLY to the broker's own totals — the reconciliation a user does
  // against Paytm's statement is to the paisa, and "₹0.16 out" reads as loss.
  const COMPONENTS = ["brokerage", "exchangeTxn", "gst", "sttCtt", "sebi", "stampDuty"] as const;
  const sliceDenom = pairedCharges > 0 ? pairedCharges : totalCharges;
  const slices = paired.map((p) => breakdownFor(fileTotals, sliceDenom > 0 ? p.charges / sliceDenom : 0));
  if (slices.length > 0 && sliceDenom > 0) {
    const big = slices.reduce((bi, b, i) => ((b.total ?? 0) > (slices[bi].total ?? 0) ? i : bi), 0);
    const target = slices[big];
    for (const k of COMPONENTS) {
      const diff = r2(r2(fileTotals[k]) - r2(slices.reduce((s, b) => s + (b[k] ?? 0), 0)));
      if (diff !== 0) target[k] = r2((target[k] ?? 0) + diff);
    }
    target.total = r2(COMPONENTS.reduce((s, k) => s + (target[k] ?? 0), 0));
  }

  const CODE_NOTE =
    "Paytm Money exports a numeric scrip code, not a ticker — Vyuha resolves the symbol from the ISIN via your Instruments list (Settings → Instruments → upload NSE's EQUITY_L.csv / SME securities list) or the bundled NSE index map; until then the code is shown.";

  const trades: NormalizedTrade[] = paired.map((p, i) => {
    const { security, hint: stated } = splitKey(p.symbol);
    // The label the file used for this security — a ticker whenever the file
    // had one anywhere, else the code (commit resolves that via the ISIN).
    const symbol = displayOf.get(security) ?? security;

    // Only this group's fills, narrowed to the position's own window — a
    // re-entered scrip gets its own ladder rather than its whole history.
    // (A split scrip-day's fills appear on both of its positions: the file
    // does not say which fill fed which half.)
    const executions = fills
      .filter(
        (f) =>
          f.key === p.symbol &&
          (p.buyDate == null || f.date >= p.buyDate) &&
          (p.sellDate == null || f.date <= p.sellDate),
      )
      .map<Execution>((f) => ({ side: f.side, qty: f.qty, price: f.price, date: f.date, time: f.time }));

    const notes: string[] = [...p.notes];
    if (stated == null) {
      notes.push(
        p.product === "mixed"
          ? "This position's days mixed intraday and delivery in a way the stamp duty could not cleanly split — shown as delivery, please confirm."
          : p.product === "unknown"
            ? "Charges too small or unusual to read the product from — shown as delivery, please confirm."
            : `Delivery vs intraday derived from the day's STT and stamp duty (${p.product}); Paytm's Product Type column states the segment only.`,
      );
    }
    // What the entry and exit days themselves said (split / same-day delivery).
    for (const d of new Set([p.buyDate, p.sellDate])) {
      const note = d ? dayNotes.get(`${p.symbol}${SEP}${d}`) : undefined;
      if (note && !notes.includes(note)) notes.push(note);
    }
    if (isCode(symbol)) notes.push(CODE_NOTE);

    return {
      broker: "paytm",
      tradingsymbol: symbol,
      isin: isinOf.get(p.symbol) ?? null,
      buyQty: p.buyQty,
      avgBuyPrice: p.buyQty > 0 ? r2(p.buyValue / p.buyQty) : 0,
      buyValue: p.buyValue,
      sellQty: p.sellQty,
      avgSellPrice: p.sellQty > 0 ? r2(p.sellValue / p.sellQty) : 0,
      sellValue: p.sellValue,
      closingPrice: null,
      // P&L only for a position that actually CLOSED. An opening sell has no
      // purchase anywhere in the file; calling its whole proceeds a gain is
      // the fabrication this parser was rewritten to stop making.
      grossPnl: p.kind === "closed" ? r2(p.sellValue - p.buyValue) : 0,
      unrealisedPnl: 0,
      buyDate: p.buyDate,
      sellDate: p.sellDate,
      entryTime: executions.find((e) => e.side === "buy")?.time ?? null,
      exitTime: [...executions].reverse().find((e) => e.side === "sell")?.time ?? null,
      productHint: stated ?? toHint(p.product),
      exchangeHint: (p.exchange as Exchange | null) ?? null,
      sourceFile: ctx.filename,
      executions: executions.length > 0 ? executions : null,
      reportedCharges: slices[i],
      basisUnknown: p.basisUnknown,
      productDerived: stated == null,
      importNotes: notes.length > 0 ? notes : null,
    };
  });

  // ── Warnings that actually tell the user something ───────────────────────
  warnings.push(
    "Charges are the broker's own per-execution figures (Brokerage, ETT, GST, STT, SEBI, Stamp Duty), apportioned to each position by its share of the book — not computed.",
  );
  warnings.push(
    "Executions are paired FIFO per scrip (by ISIN, so a security Paytm relabels from ticker to code stays one book); delivery vs intraday is derived from Paytm's own STT and stamp duty per day (the Product Type column says EQ, which is the segment, not the product).",
  );
  const relabelled = [...labelsOf.values()].filter((s) => s.size >= 2).length;
  const relabelNote = relabelledNote(relabelled);
  if (relabelNote) warnings.push(relabelNote);
  if (splitDays > 0) {
    warnings.push(
      `${splitDays} scrip-day${splitDays === 1 ? "" : "s"} mixed intraday and delivery — split into an intraday pair and a delivery remainder from Paytm's own stamp duty.`,
    );
  }
  if (sameDayDelivery > 0) {
    warnings.push(
      `${sameDayDelivery} scrip-day${sameDayDelivery === 1 ? "" : "s"} with both a buy and a sell ${sameDayDelivery === 1 ? "was" : "were"} charged as delivery (stamp 0.015%, STT on both legs) and kept as delivery, not intraday.`,
    );
  }
  if (check.openingSells > 0) {
    warnings.push(
      `${check.openingSells} holding${check.openingSells === 1 ? " was" : "s were"} sold without a matching purchase in this window — acquired earlier, often an IPO allotment. Cost basis is unknown until you set it, and they are excluded from win rate and expectancy meanwhile.`,
    );
  }
  if (!check.conserved) {
    warnings.push(
      `Pairing conservation check FAILED (qty delta ${check.qtyDelta}, value delta ${check.valueDelta} against a ${check.valueTolerance} rounding tolerance) — please report this file.`,
    );
  }
  if (unreadable.length > 0) {
    warnings.push(
      `${unreadable.length} row${unreadable.length === 1 ? "" : "s"} had no readable side, quantity, price or date and ${unreadable.length === 1 ? "was" : "were"} refused rather than guessed.`,
    );
  }

  return {
    sourceId: "paytm-tradebook",
    broker: "paytm",
    format: "tradebook",
    trades,
    // Executions as read, BEFORE pairing — so the UI can say
    // "414 lines → 57 trades" instead of a count that looks like loss.
    sourceRows: fills.length,
    warnings,
  };
}
