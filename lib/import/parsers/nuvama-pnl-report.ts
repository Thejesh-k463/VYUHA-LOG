/**
 * Nuvama **P&L Report** (`.xlsx`) — v4.6.0 W9, VERIFIED against one real owner
 * export (period 01-Jul-2026 → 22-Sep-2026; docs/BROKER_FORMATS.md § Nuvama).
 *
 * Five sheets, always these names: `Summary`, `Detail Realised`, `Unrealised
 * Details`, `Dividend`, `Understanding the Report`. Every sheet opens with ~24
 * preamble rows — the broker's legal name (`Nuvama Wealth and Investment
 * Limited`, `(Formerly Edelweiss Broking Limited)`), its SEBI registration, a
 * `Date :` stamp, then PERSONAL rows (`Name :`, `Tel. No. :`, `Email Id :`,
 * `Wealth Manager Name :`, `Wealth Manager Contact no :`) that are read for
 * nothing and emitted nowhere — then `Period as on : <from> to <to>`,
 * `Calculation Method : FIFO`, the header row (column A empty, found by its
 * `Isin` + `Instrument` cells), a `Total` row, the data, and `DISCLAIMER`.
 *
 * THE BOOK is `Detail Realised` + `Unrealised Details` (owner answer
 * 2026-09-25): one line per instrument × DAY × side, at the day's weighted
 * average price, with the charges Nuvama BILLED for it (Brok, GST on
 * brokerage, STT/CTT, stamp, SEBI, exchange, GST on exchange, other). Stored
 * as stated — this file is the broker's own bill. No order id, no time.
 *
 * SEQUENCE WITHIN A DAY. The two sides of one instrument-day are printed in no
 * fixed order (the real file prints Sell before Buy on the same day for a
 * long position). `CumulativeQuantity` — the running position AFTER the line —
 * is the only sequencing signal, so legs are ordered to satisfy that chain
 * (prev + qty on a buy, prev − qty on a sell). Read in print order instead,
 * pair-legs would call a same-day long round trip an intraday SHORT.
 *
 * IDENTITY follows the file's own word: `dedupLabel` is the instrument string
 * (`NIFTY-OPT-22Sep2026-PE-23550-NSE`) while the row is SHOWN as the Dhan-style
 * name every classifier surface reads (`OPT NIFTY 22 Sep 2026 23550 PE`).
 *
 * `Summary` is REFERENCE only — Nuvama's per-instrument figures, which include
 * charges in their buy/sell values — and never a source of trades. `Dividend`
 * is not imported (its layout is unverified; the only real file had no rows).
 */

import * as XLSX from "xlsx";
import { pairLegs, summarisePairing, type Leg } from "../pair-legs";
import { allocateSymbolLegs, matchAllocations, type Allocation } from "../leg-allocation";
import type { ChargeBreakdown, NormalizedTrade } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import type { ParseContext, ParsedFile, ReferenceRow } from "../types";
import { workbookOf } from "../types";
import { DEDUP_LABEL_PREFIX } from "../trade-identity";
import { bundledSymbolByIsin } from "../isin-symbol";
import { fyOfDate } from "@/lib/analytics/ais";
import { FYERS_NUVAMA_EQUITY_UNVERIFIED } from "./fyers-tradebook";

export const NUVAMA_PNL_SOURCE_ID = "nuvama-pnl-report";

export const NUVAMA_SHEETS = ["Summary", "Detail Realised", "Unrealised Details", "Dividend", "Understanding the Report"] as const;
const NUVAMA_MARKER = /Nuvama Wealth and Investment/i;

const r2 = (n: number) => Math.round(n * 100) / 100;
const toNum = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s || s === "-") return 0;
  const x = Number(s);
  return Number.isFinite(x) ? x : 0;
};
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function sheetRows(wb: XLSX.WorkBook, name: string, raw: boolean): unknown[][] | null {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw, defval: "" }) as unknown[][];
}

/**
 * Detection: the five sheet names together (the format) AND the broker's
 * legal name in a `Summary` cell (the identity — AGENTS.md: a broker-named
 * parser must SEE the name). The filename is not needed and not read.
 */
export function detectNuvamaPnlReport(ctx: ParseContext): number {
  if (ctx.text != null || !ctx.buffer) return 0;
  let wb: XLSX.WorkBook;
  try {
    wb = workbookOf(ctx, { bookSheets: true });
  } catch {
    return 0;
  }
  if (!NUVAMA_SHEETS.every((s) => wb.SheetNames.includes(s))) return 0;
  try {
    wb = workbookOf(ctx);
  } catch {
    return 0;
  }
  const summary = sheetRows(wb, "Summary", false) ?? [];
  return summary.slice(0, 40).some((r) => r.some((c) => NUVAMA_MARKER.test(String(c)))) ? 0.95 : 0;
}

/** The header row: the cells `Isin` and `Instrument`, wherever the column A gap puts them. */
function headerIndex(rows: unknown[][]): number {
  return rows.findIndex((r) => {
    const c = r.map(norm);
    return c.includes("isin") && c.includes("instrument");
  });
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** `22-Sep-26` (the verified form) or `22-Sep-2026` → ISO. Anything else → null. */
export function nuvamaDate(raw: unknown): string | null {
  const m = String(raw ?? "").trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return null;
  const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${yyyy}-${mm}-${m[1].padStart(2, "0")}`;
}

/** `01-Jul-2026 to 22-Sep-2026` → both ends. */
function periodOf(rows: unknown[][]): { from: string | null; to: string | null } {
  for (const r of rows.slice(0, 40)) {
    const i = r.findIndex((c) => /^period as on/i.test(String(c).trim()));
    if (i < 0) continue;
    const text = r.slice(i).map(String).join(" ");
    const m = text.match(/(\d{1,2}-[A-Za-z]{3}-\d{2,4})\s+to\s+(\d{1,2}-[A-Za-z]{3}-\d{2,4})/i);
    if (m) return { from: nuvamaDate(m[1]), to: nuvamaDate(m[2]) };
  }
  return { from: null, to: null };
}

export interface NuvamaInstrument {
  kind: "option" | "future" | "equity";
  /** The Dhan-style name the classifier reads, or the equity label. */
  tradingsymbol: string;
  exchange: string | null;
}

const MON_TITLE = (m: string) => m.charAt(0).toUpperCase() + m.slice(1, 3).toLowerCase();

/**
 * The instrument grammar (verified): `UNDERLYING-OPT-ddMMMyyyy-CE|PE-STRIKE-EXCH`
 * and `UNDERLYING-FUT-ddMMMyyyy-EXCH`. Returns null for an F&O-looking string
 * that does not parse — the caller refuses that row rather than guessing.
 */
export function nuvamaInstrument(instrument: string, isin: string): NuvamaInstrument | null {
  const s = instrument.trim();
  let m = s.match(/^(.+)-OPT-(\d{2})([A-Za-z]{3})(\d{4})-(CE|PE)-(\d+(?:\.\d+)?)-([A-Z]+)$/i);
  if (m) {
    return {
      kind: "option",
      tradingsymbol: `OPT ${m[1].toUpperCase()} ${m[2]} ${MON_TITLE(m[3])} ${m[4]} ${Number(m[6])} ${m[5].toUpperCase()}`,
      exchange: m[7].toUpperCase(),
    };
  }
  m = s.match(/^(.+)-FUT-(\d{2})([A-Za-z]{3})(\d{4})-([A-Z]+)$/i);
  if (m) {
    return { kind: "future", tradingsymbol: `FUT ${m[1].toUpperCase()} ${m[2]} ${MON_TITLE(m[3])} ${m[4]}`, exchange: m[5].toUpperCase() };
  }
  if (/-(OPT|FUT)-/i.test(s)) return null;
  // UNVERIFIED (owner answer 2026-09-25): an equity line would carry an ISIN.
  if (/^[A-Z]{2}[A-Z0-9]{10}$/.test(isin)) {
    return { kind: "equity", tradingsymbol: bundledSymbolByIsin(isin) ?? s.toUpperCase(), exchange: null };
  }
  return null;
}

const EXCHANGES: readonly string[] = ["NSE", "BSE", "MCX"];
const asExchange = (e: string | null | undefined): Exchange | null =>
  e && EXCHANGES.includes(e.toUpperCase()) ? (e.toUpperCase() as Exchange) : null;

interface Line {
  instrument: string;
  isin: string;
  inst: NuvamaInstrument;
  date: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  cum: number | null;
  exchange: string | null;
  heads: { brokerage: number; gst: number; sttCtt: number; stampDuty: number; sebi: number; exchangeTxn: number; other: number };
  net: number;
  /** File position, the tiebreak of last resort. */
  seq: number;
}

/** Signed effect of a line on the running position. */
const signed = (l: Line) => (l.side === "buy" ? l.qty : -l.qty);

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

/**
 * Order ONE instrument's lines so the `CumulativeQuantity` chain holds, day by
 * day, starting from the position the earlier days left. Returns the ordered
 * lines and how many days no order could satisfy (those fall back to
 * buys-first, file order within a side).
 */
export function orderByCumulative(lines: Line[]): { ordered: Line[]; unresolvedDays: number } {
  const byDay = new Map<string, Line[]>();
  for (const l of [...lines].sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq)) {
    const d = byDay.get(l.date);
    if (d) d.push(l);
    else byDay.set(l.date, [l]);
  }
  const ordered: Line[] = [];
  let pos = 0;
  let first = true;
  let unresolvedDays = 0;
  const holds = (order: Line[], start: number) => {
    let p = start;
    for (const l of order) {
      p += signed(l);
      if (l.cum == null || Math.abs(l.cum - p) > 1e-9) return false;
    }
    return true;
  };
  for (const day of byDay.values()) {
    const perms = day.length <= 6 ? permutations(day) : [];
    let start = pos;
    let pick = perms.find((o) => holds(o, start)) ?? null;
    // The instrument's FIRST day may start from a position held before the
    // report window; there the chain itself states the opening position.
    if (!pick && first) {
      pick = perms.find((o) => o[0].cum != null && holds(o, o[0].cum - signed(o[0]))) ?? null;
      if (pick) start = pick[0].cum! - signed(pick[0]);
    }
    if (!pick) {
      unresolvedDays++;
      pick = [...day].sort((a, b) => (a.side === b.side ? a.seq - b.seq : a.side === "buy" ? -1 : 1));
    }
    ordered.push(...pick);
    pos = pick.reduce((p, l) => p + signed(l), start);
    first = false;
  }
  return { ordered, unresolvedDays };
}

interface ReadResult {
  lines: Line[];
  deleted: number;
  refused: string[];
  headSumOff: number;
  totalRow: Record<string, number> | null;
  charges: number;
}

function readDetail(rows: unknown[][], seqStart: number): ReadResult {
  const out: ReadResult = { lines: [], deleted: 0, refused: [], headSumOff: 0, totalRow: null, charges: 0 };
  const h = headerIndex(rows);
  if (h < 0) return out;
  const hdr = rows[h].map(norm);
  const col = (k: string) => hdr.indexOf(k);
  const c = {
    isin: col("isin"), instrument: col("instrument"), date: col("txndate"), exch: col("txntype"), action: col("action"),
    qty: col("quantity"), price: col("price"), brok: col("brok"), gstBrok: col("staxgstonbrokerage"), stt: col("stt"),
    stamp: col("stampduty"), sebi: col("sebifees"), txn: col("txncharges"), taxTxn: col("taxontxncharges"),
    other: col("othercharges"), cum: col("cumulativequantity"), net: col("netcharges"), del: col("deleteflag"),
  };
  const at = (r: unknown[], i: number) => (i >= 0 ? r[i] : "");
  let seq = seqStart;
  for (const r of rows.slice(h + 1)) {
    const first = String(r[0] ?? "").trim();
    if (/^disclaimer/i.test(first)) break;
    const isinCell = String(at(r, c.isin)).trim();
    const instrument = String(at(r, c.instrument)).trim();
    if (isinCell.toLowerCase() === "total" && !instrument) {
      out.totalRow = {
        brokerage: toNum(at(r, c.brok)), gst: toNum(at(r, c.gstBrok)), stt: toNum(at(r, c.stt)),
        stampDuty: toNum(at(r, c.stamp)), sebi: toNum(at(r, c.sebi)), exchangeTxn: toNum(at(r, c.txn)),
        taxOnTxnCharges: toNum(at(r, c.taxTxn)), otherCharges: toNum(at(r, c.other)),
      };
      continue;
    }
    if (!instrument) continue;
    if (/^true$/i.test(String(at(r, c.del)).trim())) {
      out.deleted++;
      continue;
    }
    const inst = nuvamaInstrument(instrument, isinCell.toUpperCase());
    const date = nuvamaDate(at(r, c.date));
    const action = String(at(r, c.action)).trim().toLowerCase();
    const side = action === "buy" ? "buy" : action === "sell" ? "sell" : null;
    const qty = toNum(at(r, c.qty));
    const price = toNum(at(r, c.price));
    // Refuse, never coerce (AGENTS.md).
    if (!inst || !date || !side || qty <= 0 || price <= 0) {
      out.refused.push(instrument);
      continue;
    }
    const heads = {
      brokerage: toNum(at(r, c.brok)),
      gst: toNum(at(r, c.gstBrok)) + toNum(at(r, c.taxTxn)),
      sttCtt: toNum(at(r, c.stt)),
      stampDuty: toNum(at(r, c.stamp)),
      sebi: toNum(at(r, c.sebi)),
      exchangeTxn: toNum(at(r, c.txn)),
      other: toNum(at(r, c.other)),
    };
    const headSum = heads.brokerage + heads.gst + heads.sttCtt + heads.stampDuty + heads.sebi + heads.exchangeTxn + heads.other;
    const netCell = at(r, c.net);
    const net = String(netCell).trim() === "" ? headSum : toNum(netCell);
    if (Math.abs(headSum - net) > 0.01) out.headSumOff++;
    const cumCell = String(at(r, c.cum)).trim();
    out.lines.push({
      instrument, isin: isinCell.toUpperCase(), inst, date, side, qty, price,
      cum: cumCell === "" ? null : toNum(cumCell),
      exchange: String(at(r, c.exch)).trim().toUpperCase() || inst.exchange,
      heads, net, seq: seq++,
    });
    out.charges += net;
  }
  return out;
}

type Heads = Line["heads"];
const HEAD_KEYS = ["brokerage", "gst", "sttCtt", "stampDuty", "sebi", "exchangeTxn"] as const;

/**
 * A position's stated breakdown: the heads of the day-legs it CONSUMED. A leg
 * consumed whole contributes its exact bill; a leg split across two positions
 * contributes each head × consumed qty ÷ leg qty — the file bills per day-leg,
 * so that slice is the honest one. (Spreading the instrument's total heads by
 * NetCharges gave every position the instrument's average head MIX: billed
 * brokerage 40 / STT 43 read back as 36.9 / 46.97.)
 */
function breakdownOf(alloc: Allocation, bill: Map<Leg, { heads: Heads; net: number }>): Partial<ChargeBreakdown> {
  const sum: Record<(typeof HEAD_KEYS)[number], number> = { brokerage: 0, gst: 0, sttCtt: 0, stampDuty: 0, sebi: 0, exchangeTxn: 0 };
  let net = 0;
  let other = 0;
  for (const slice of [...alloc.buys, ...(alloc.sell ? [alloc.sell] : [])]) {
    const b = bill.get(slice.leg);
    if (!b || slice.leg.qty <= 0) continue;
    const f = slice.qty / slice.leg.qty;
    for (const k of HEAD_KEYS) sum[k] += b.heads[k] * f;
    other += b.heads.other * f;
    net += b.net * f;
  }
  const b = Object.fromEntries(HEAD_KEYS.map((k) => [k, r2(sum[k])])) as Record<(typeof HEAD_KEYS)[number], number>;
  // `other` has no head of its own; it stays inside `total` only.
  const total = r2(net);
  const residual = r2(total - r2(other) - HEAD_KEYS.reduce((s, k) => s + b[k], 0));
  if (residual !== 0) {
    const big = HEAD_KEYS.reduce((best, k) => (b[k] > b[best] ? k : best), HEAD_KEYS[0]);
    b[big] = r2(b[big] + residual);
  }
  // Every head is stated (0 where the bill has none) so commit never mixes an
  // engine figure into a broker bill (lib/import/commit.ts `{...computed, ...reported}`).
  return { ...b, ipft: 0, dpCharges: 0, mtfInterest: 0, pledgeCharges: 0, total };
}

export function parseNuvamaPnlReport(ctx: ParseContext): ParsedFile {
  const base = { sourceId: NUVAMA_PNL_SOURCE_ID, broker: "nuvama" as const, format: "pnl" };
  let wb: XLSX.WorkBook;
  try {
    wb = workbookOf(ctx);
  } catch {
    return { ...base, trades: [], warnings: ["Could not open this workbook — is it a Nuvama P&L report (.xlsx)?"] };
  }
  const detailRows = sheetRows(wb, "Detail Realised", true);
  const unrealRows = sheetRows(wb, "Unrealised Details", true);
  const summaryRows = sheetRows(wb, "Summary", true);
  if (!detailRows && !unrealRows) {
    return { ...base, trades: [], warnings: ["No 'Detail Realised' or 'Unrealised Details' sheet — is this a Nuvama P&L report?"] };
  }
  const warnings: string[] = [];

  const detail = readDetail(detailRows ?? [], 0);
  const unreal = readDetail(unrealRows ?? [], detail.lines.length + 1_000_000);
  const lines = [...detail.lines, ...unreal.lines];

  // ── Order each instrument by its CumulativeQuantity chain, then pair ─────
  const byInstrument = new Map<string, Line[]>();
  for (const l of lines) {
    const list = byInstrument.get(l.instrument);
    if (list) list.push(l);
    else byInstrument.set(l.instrument, [l]);
  }
  const legs: Leg[] = [];
  let unresolvedDays = 0;
  const instrumentOf = new Map<string, { line: Line; legs: Leg[] }>();
  /** Each day-leg's own bill — the heads a position inherits from the legs it consumed. */
  const bill = new Map<Leg, { heads: Heads; net: number }>();
  for (const list of byInstrument.values()) {
    const { ordered, unresolvedDays: u } = orderByCumulative(list);
    unresolvedDays += u;
    const own: Leg[] = [];
    for (const l of ordered) {
      const leg: Leg = {
        symbol: l.inst.tradingsymbol,
        side: l.side,
        date: l.date,
        qty: l.qty,
        value: r2(l.qty * l.price),
        charges: l.net,
        exchange: l.exchange,
        product: "unknown",
      };
      legs.push(leg);
      own.push(leg);
      bill.set(leg, { heads: l.heads, net: l.net });
    }
    instrumentOf.set(ordered[0].inst.tradingsymbol, { line: ordered[0], legs: own });
  }

  const paired = pairLegs(legs);
  // Which legs each position consumed, per instrument (lib/import/leg-allocation.ts).
  const allocsBySymbol = new Map([...instrumentOf].map(([sym, v]) => [sym, allocateSymbolLegs(v.legs)]));
  const allocOf: (Allocation | null)[] = new Array(paired.length).fill(null);
  for (const [sym, allocs] of allocsBySymbol) {
    const idx = paired.map((p, i) => (p.symbol === sym ? i : -1)).filter((i) => i >= 0);
    matchAllocations(idx.map((i) => paired[i]), allocs).forEach((a, j) => (allocOf[idx[j]] = a));
  }
  const unallocated = allocOf.filter((a) => a == null).length;
  const check = summarisePairing(legs, paired);
  let equityRows = 0;
  const trades: NormalizedTrade[] = paired.map((p, i) => {
    const info = instrumentOf.get(p.symbol)!;
    const l = info.line;
    if (l.inst.kind === "equity") equityRows++;
    return {
      broker: "nuvama",
      tradingsymbol: p.symbol,
      isin: l.inst.kind === "equity" ? l.isin : null,
      // Identity follows the FILE's word (lib/import/trade-identity.ts).
      dedupLabel: l.instrument,
      buyQty: p.buyQty,
      avgBuyPrice: p.buyQty > 0 ? r2(p.buyValue / p.buyQty) : 0,
      buyValue: p.buyValue,
      sellQty: p.sellQty,
      avgSellPrice: p.sellQty > 0 ? r2(p.sellValue / p.sellQty) : 0,
      sellValue: p.sellValue,
      closingPrice: null,
      grossPnl: p.kind === "closed" ? r2(p.sellValue - p.buyValue) : 0,
      unrealisedPnl: 0,
      buyDate: p.buyDate,
      sellDate: p.sellDate,
      // The report states a DAY and no time — null is the honest answer.
      entryTime: null,
      exitTime: null,
      productHint: null,
      exchangeHint: asExchange(p.exchange),
      sourceFile: ctx.filename,
      reportedCharges: allocOf[i]
        ? breakdownOf(allocOf[i]!, bill)
        : { brokerage: 0, gst: 0, sttCtt: 0, stampDuty: 0, sebi: 0, exchangeTxn: 0, ipft: 0, dpCharges: 0, mtfInterest: 0, pledgeCharges: 0, total: r2(p.charges) },
      basisUnknown: p.basisUnknown,
      importNotes: [...p.notes, `${DEDUP_LABEL_PREFIX}${l.instrument}`],
    };
  });

  // ── Conserve the book's charges to the lines' own NetCharges ─────────────
  const statedCharges = r2(detail.charges + unreal.charges);
  const given = r2(trades.reduce((s, t) => s + (t.reportedCharges?.total ?? 0), 0));
  const residual = r2(statedCharges - given);
  const last = trades[trades.length - 1];
  if (residual !== 0 && Math.abs(residual) <= check.valueTolerance && last?.reportedCharges) {
    const b = last.reportedCharges;
    const big = HEAD_KEYS.reduce((best, k) => ((b[k] ?? 0) > (b[best] ?? 0) ? k : best), HEAD_KEYS[0]);
    b[big] = r2((b[big] ?? 0) + residual);
    b.total = r2((b.total ?? 0) + residual);
    last.importNotes = [...(last.importNotes ?? []), `Carries ₹${residual.toFixed(2)} of rounding so the book's charges equal the report's lines to the paisa.`];
  } else if (residual !== 0) {
    warnings.push(`The positions' charges (₹${given}) differ from the report's lines (₹${statedCharges}) by ₹${residual} — more than rounding. Please report this file.`);
  }

  // ── reported: the Summary Total + the charge columns' Total rows ─────────
  const reported: Record<string, number> = {};
  const sHdrAt = summaryRows ? headerIndex(summaryRows) : -1;
  const reference: ReferenceRow[] = [];
  const { from, to } = periodOf(summaryRows ?? detailRows ?? []);
  const fy = from && to && fyOfDate(from) === fyOfDate(to) ? fyOfDate(to) : null;
  if (summaryRows && sHdrAt >= 0) {
    const hdr = summaryRows[sHdrAt].map(norm);
    const col = (k: string) => hdr.indexOf(k);
    const cIsin = col("isin"), cInst = col("instrument");
    const F: Record<string, string> = {
      soldquantity: "soldQty", buyavg: "buyAvg", buyvalue: "buyValue", sellavg: "sellAvg", sellvalue: "sellValue",
      netrealizedpnl: "netRealisedPnl", closequantityasonlastday: "closeQty", buyavgopenprice: "buyAvgOpenPrice",
      cmp: "cmp", netunrealizedpnl: "netUnrealisedPnl", totalgl: "totalGl",
    };
    for (const r of summaryRows.slice(sHdrAt + 1)) {
      if (/^disclaimer/i.test(String(r[0] ?? "").trim())) break;
      const isin = String(r[cIsin] ?? "").trim();
      const instrument = String(r[cInst] ?? "").trim();
      if (isin.toLowerCase() === "total" && !instrument) {
        for (const [h, k] of Object.entries({ buyvalue: "buyValue", sellvalue: "sellValue", netrealizedpnl: "netRealisedPnl", netunrealizedpnl: "netUnrealisedPnl", totalgl: "totalGl" })) {
          if (col(h) >= 0) reported[k] = toNum(r[col(h)]);
        }
        continue;
      }
      if (!instrument) continue;
      const inst = nuvamaInstrument(instrument, isin.toUpperCase());
      const figures: Record<string, number> = {};
      for (const [h, k] of Object.entries(F)) if (col(h) >= 0) figures[k] = toNum(r[col(h)]);
      reference.push({
        scope: "scrip",
        key: instrument,
        isin: /^[A-Z]{2}[A-Z0-9]{10}$/.test(isin) ? isin : null,
        symbol: inst?.tradingsymbol ?? instrument,
        fy,
        asOf: to,
        figures,
        note: "Nuvama P&L report, Summary (buy/sell values include Nuvama's charges; P&L is net)",
      });
    }
  }
  if (detail.totalRow) for (const [k, v] of Object.entries(detail.totalRow)) reported[`realised.${k}`] = v;
  if (unreal.totalRow) for (const [k, v] of Object.entries(unreal.totalRow)) reported[`unrealised.${k}`] = v;
  reported["realised.totalCharges"] = r2(detail.charges);
  reported["unrealised.totalCharges"] = r2(unreal.charges);
  reported.totalCharges = statedCharges;

  // ── Warnings that tell the user something ────────────────────────────────
  const read = lines.length;
  warnings.push(
    `${read} statement line${read === 1 ? "" : "s"} (one per instrument, day and side, at the day's average price) → ${trades.length} position${trades.length === 1 ? "" : "s"}. Charges are the ones Nuvama billed on each line, stored as stated.`,
  );
  warnings.push("Nuvama's report states no order ids and no times — entry and exit times stay blank rather than guessed.");
  if (unallocated > 0) {
    warnings.push(`${unallocated} position${unallocated === 1 ? "" : "s"} could not be traced to the report lines behind ${unallocated === 1 ? "it" : "them"}; ${unallocated === 1 ? "its" : "their"} billed total is kept but not split into heads — please report this file.`);
  }
  if (unresolvedDays > 0) {
    warnings.push(`${unresolvedDays} instrument-day${unresolvedDays === 1 ? "" : "s"} could not be ordered by the report's CumulativeQuantity chain; buys were taken before sells there. Check those positions.`);
  }
  if (equityRows > 0) warnings.push(`${equityRows} equity position${equityRows === 1 ? "" : "s"} read — ${FYERS_NUVAMA_EQUITY_UNVERIFIED}.`);
  const deleted = detail.deleted + unreal.deleted;
  if (deleted > 0) warnings.push(`${deleted} line${deleted === 1 ? "" : "s"} marked DeleteFlag = true ${deleted === 1 ? "was" : "were"} skipped, as the report itself withdraws ${deleted === 1 ? "it" : "them"}.`);
  const refused = [...detail.refused, ...unreal.refused];
  if (refused.length > 0) {
    warnings.push(`${refused.length} line${refused.length === 1 ? "" : "s"} could not be read (instrument, date, side, quantity or price) and ${refused.length === 1 ? "was" : "were"} refused rather than guessed: ${[...new Set(refused)].slice(0, 5).join(", ")}.`);
  }
  const off = detail.headSumOff + unreal.headSumOff;
  if (off > 0) warnings.push(`${off} line${off === 1 ? "" : "s"} state NetCharges that differ from the sum of their charge columns — the stated NetCharges is what was stored.`);
  if (check.openingSells > 0) {
    warnings.push(`${check.openingSells} sell${check.openingSells === 1 ? " had" : "s had"} no matching buy in this report — bought before its period; cost basis unknown, P&L left blank until you supply it.`);
  }
  if (!check.conserved) {
    warnings.push(`Pairing conservation check FAILED (qty delta ${check.qtyDelta}, value delta ${check.valueDelta}) — please report this file.`);
  }
  const dividend = sheetRows(wb, "Dividend", false);
  if (dividend && dividendHasRows(dividend)) warnings.push("Nuvama dividend rows are not imported (layout unverified).");
  if (reference.length > 0) {
    warnings.push(`${reference.length} Summary figures were stored as the broker's own numbers for reconciliation. Nuvama's buy and sell values there INCLUDE its charges, so its P&L is net.`);
  }

  return { ...base, trades, reported, reference, sourceRows: read, warnings };
}

/**
 * Whether the `Dividend` sheet carries data. Its layout is unverified — the
 * only real file had none — so ANY row after the `Summary Dividends` title
 * with two or more filled cells counts; the two titles and the footer notes
 * are single-cell rows.
 */
function dividendHasRows(rows: unknown[][]): boolean {
  const at = rows.findIndex((r) => r.some((c) => /^summary dividends/i.test(String(c).trim())));
  if (at < 0) return false;
  return rows.slice(at + 1).some((r) => r.filter((c) => String(c ?? "").trim() !== "").length >= 2);
}
